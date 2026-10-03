//! F1 25 Phase D: session identity, recording lifecycle, lap authority,
//! events, ownership, persistence, recovery and privacy.
//!
//! The recorder core is driven exactly as its thread drives it — an
//! aggregator fed with datagrams, then `tick` with that aggregator's view —
//! but with synthetic packets and a synthetic clock, so every timing rule is
//! exercised without a game or a wait. Files are real.
mod f1_synthetic;
mod scratch;

use f1_synthetic::*;
use racelab_lib::{
    adapters::f1_25::event::EventDetails,
    f1_evidence::F1Evidence,
    f1_recorder::{waiting, F1RecorderConfig, F1RecorderCore, RecorderPhase, Tick},
    f1_session::{
        self, completion, LapSource, ResultFileV1, SessionGame, TyresFileV1, EVENTS_FILE_NAME,
        LAPS_FILE_NAME, RESULT_FILE_NAME, SAMPLES_FILE_NAME, SESSION_FILE_NAME, TYRES_FILE_NAME,
    },
    recording_owner::{RecordingGame, RecordingOwner},
    session_format::{RecoveryOutcome, SessionStatus},
    session_recorder::SessionRecorder,
    session_store,
    telemetry::TelemetryFrame,
    telemetry_hub::{SessionRecorderHook, TelemetryHub},
};
use scratch::Scratch;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};

const A: u64 = 0x1111_2222_3333_4444;
const B: u64 = 0x5555_6666_7777_8888;
const PLAYER: u8 = 2;

/// An aggregator, a recorder core and a clock.
struct Rig {
    evidence: F1Evidence,
    core: F1RecorderCore,
    base: Instant,
    now: u64,
    wall: u64,
    frame: u32,
    root: Scratch,
}

impl Rig {
    fn new(name: &str) -> Self {
        Self::with(name, F1RecorderConfig::default(), None)
    }

    fn with(name: &str, config: F1RecorderConfig, owner: Option<Arc<RecordingOwner>>) -> Self {
        let root = Scratch::new(name);
        let mut core = F1RecorderCore::new(root.to_path_buf(), true, config).unwrap();
        if let Some(owner) = owner {
            core = core.with_owner(owner);
        }
        let base = Instant::now();
        Self {
            evidence: F1Evidence::new(base),
            core,
            base,
            now: 0,
            wall: 1_900_000_000_000,
            frame: 0,
            root,
        }
    }

    fn head(&mut self, uid: u64, player: u8) -> Head {
        self.frame += 1;
        Head::new(0, uid, self.frame, player)
    }

    fn feed(&mut self, bytes: &[u8]) {
        let at = self.base + Duration::from_millis(self.now);
        self.evidence.observe(bytes, at, self.wall + self.now);
    }

    fn tick(&mut self) {
        let at = self.base + Duration::from_millis(self.now);
        let (age, view) = self.evidence.recording_view(at, self.core.event_cursor());
        self.core.tick(Tick {
            now_ms: self.now,
            wall_ms: self.wall + self.now,
            last_accepted_age_ms: age,
            view,
        });
    }

    /// One 100 ms step of a driving player: session context, the four
    /// player families, then a reader tick.
    fn drive(&mut self, uid: u64, player: u8, lap: LapSpec) {
        self.drive_with(uid, player, lap, SessionSpec::default());
    }

    fn drive_with(&mut self, uid: u64, player: u8, lap: LapSpec, session: SessionSpec) {
        let h = self.head(uid, player);
        self.feed(&f1_synthetic::session(h, session));
        self.feed(&car_telemetry(h, 250, 1.0, 0.0));
        self.feed(&car_status(h, 50.0));
        self.feed(&lap_data(h, lap));
        self.feed(&motion_ex(h));
        self.tick();
        self.now += 100;
    }

    fn drive_for(&mut self, uid: u64, player: u8, ms: u64) {
        for _ in 0..ms / 100 {
            self.drive(uid, player, LapSpec::default());
        }
    }

    /// Time passes with no packet at all.
    fn silent_for(&mut self, ms: u64) {
        for _ in 0..ms / 100 {
            self.tick();
            self.now += 100;
        }
    }

    fn send_event(&mut self, uid: u64, code: &[u8; 4], details: &[u8]) {
        let h = self.head(uid, PLAYER);
        self.feed(&event(h, code, details));
    }

    fn session_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = fs::read_dir(&*self.root)
            .unwrap()
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        ids.sort();
        ids
    }

    fn only_session(&self) -> PathBuf {
        let ids = self.session_ids();
        assert_eq!(ids.len(), 1, "expected exactly one session, found {ids:?}");
        self.root.join(&ids[0])
    }
}

fn session_file(directory: &Path) -> f1_session::F1SessionFileV1 {
    f1_session::read_session(directory).unwrap()
}

// ------------------------------------------------------------ identity

#[test]
fn a_valid_session_starts_only_after_the_confirmation_window() {
    let mut rig = Rig::new("f1-start");
    rig.drive_for(A, PLAYER, 900);
    assert_eq!(rig.core.status().phase, RecorderPhase::Candidate);
    assert_eq!(rig.core.status().waiting_reason, Some(waiting::CONFIRMING));
    assert!(
        rig.session_ids().is_empty(),
        "nothing is written while confirming"
    );
    rig.drive_for(A, PLAYER, 300);
    let status = rig.core.status();
    assert!(status.recording);
    assert_eq!(status.phase, RecorderPhase::Recording);
    assert_eq!(status.session_uid.as_deref(), Some(A.to_string().as_str()));
    assert_eq!(status.track_label, Some("Silverstone"));
    assert_eq!(status.session_type_label, Some("Race"));
    let directory = rig.only_session();
    let file = session_file(&directory);
    let envelope = &file.racelab_session;
    assert_eq!(envelope.game, SessionGame::F1_25);
    assert_eq!(envelope.status, SessionStatus::Recording);
    // Two identities, never derived from each other.
    let identity = envelope.game_session_identity.as_ref().unwrap();
    assert_eq!(identity.kind, "f1_session_uid");
    assert_eq!(identity.value, A.to_string());
    assert!(envelope.session_id.starts_with("f1-"));
    assert!(!envelope.session_id.contains(&A.to_string()));
    assert_eq!(file.f1_25.player_car_index, PLAYER);
    let protocol = file.f1_25.protocol.as_ref().unwrap();
    assert_eq!((protocol.packet_format, protocol.game_year), (2025, 25));
    for name in [
        SESSION_FILE_NAME,
        SAMPLES_FILE_NAME,
        EVENTS_FILE_NAME,
        LAPS_FILE_NAME,
        TYRES_FILE_NAME,
    ] {
        assert!(directory.join(name).exists(), "{name}");
    }
}

#[test]
fn a_zero_session_uid_never_starts_a_session() {
    let mut rig = Rig::new("f1-zero-uid");
    rig.drive_for(0, PLAYER, 5_000);
    let status = rig.core.status();
    assert!(!status.recording);
    assert_eq!(status.waiting_reason, Some(waiting::INVALID_SESSION_UID));
    assert!(rig.session_ids().is_empty());
}

#[test]
fn an_invalid_player_index_never_starts_a_session() {
    let mut rig = Rig::new("f1-spectator-index");
    rig.drive_for(A, 255, 5_000);
    assert_eq!(
        rig.core.status().waiting_reason,
        Some(waiting::INVALID_PLAYER_INDEX)
    );
    assert!(rig.session_ids().is_empty());
}

#[test]
fn menus_unknown_sessions_spectating_and_stale_players_never_start_a_session() {
    // No Session packet at all: identity without context.
    let mut rig = Rig::new("f1-no-context");
    for _ in 0..50 {
        let h = rig.head(A, PLAYER);
        rig.feed(&car_telemetry(h, 100, 0.5, 0.0));
        rig.feed(&lap_data(h, LapSpec::default()));
        rig.tick();
        rig.now += 100;
    }
    assert_eq!(
        rig.core.status().waiting_reason,
        Some(waiting::NO_SESSION_CONTEXT)
    );
    assert!(rig.session_ids().is_empty());

    // The specification's session type 0, "unknown".
    let mut rig = Rig::new("f1-unknown-type");
    for _ in 0..50 {
        rig.drive_with(
            A,
            PLAYER,
            LapSpec::default(),
            SessionSpec {
                session_type: 0,
                ..SessionSpec::default()
            },
        );
    }
    assert_eq!(
        rig.core.status().waiting_reason,
        Some(waiting::SESSION_TYPE_UNKNOWN)
    );
    assert!(rig.session_ids().is_empty());

    // Spectating.
    let mut rig = Rig::new("f1-spectating");
    for _ in 0..50 {
        rig.drive_with(
            A,
            PLAYER,
            LapSpec::default(),
            SessionSpec {
                is_spectating: 1,
                ..SessionSpec::default()
            },
        );
    }
    assert_eq!(rig.core.status().waiting_reason, Some(waiting::SPECTATING));
    assert!(rig.session_ids().is_empty());

    // Session context but no fresh player family: a loading screen.
    let mut rig = Rig::new("f1-loading");
    for _ in 0..50 {
        let h = rig.head(A, PLAYER);
        rig.feed(&f1_synthetic::session(h, SessionSpec::default()));
        rig.tick();
        rig.now += 100;
    }
    assert_eq!(
        rig.core.status().waiting_reason,
        Some(waiting::PLAYER_NOT_FRESH)
    );
    assert!(rig.session_ids().is_empty());

    // An interruption of the conditions restarts the confirmation.
    let mut rig = Rig::new("f1-flicker");
    for round in 0..10 {
        rig.drive_for(A, PLAYER, 800);
        let h = rig.head(A, PLAYER);
        rig.feed(&f1_synthetic::session(
            h,
            SessionSpec {
                is_spectating: 1,
                ..SessionSpec::default()
            },
        ));
        rig.tick();
        rig.now += 100;
        assert!(rig.session_ids().is_empty(), "round {round}");
    }
}

#[test]
fn a_session_uid_change_ends_the_recording_and_never_mixes_sessions() {
    let mut rig = Rig::new("f1-uid-change");
    rig.drive_for(A, PLAYER, 1_500);
    rig.send_event(A, b"OVTK", &[PLAYER, 5]);
    rig.drive_for(A, PLAYER, 500);
    // B begins. Its first events arrive before A's recording has even seen
    // the change.
    rig.send_event(B, b"SSTA", &[]);
    rig.drive_for(B, PLAYER, 1_500);
    rig.send_event(B, b"COLL", &[PLAYER, 9]);
    rig.drive_for(B, PLAYER, 500);
    rig.core.shutdown(rig.now, rig.wall + rig.now);

    let ids = rig.session_ids();
    assert_eq!(ids.len(), 2);
    let sessions: Vec<_> = ids
        .iter()
        .map(|id| session_file(&rig.root.join(id)))
        .collect();
    let a = sessions
        .iter()
        .find(|s| s.f1_25.session_uid == A.to_string())
        .unwrap();
    let b = sessions
        .iter()
        .find(|s| s.f1_25.session_uid == B.to_string())
        .unwrap();
    assert_eq!(a.racelab_session.status, SessionStatus::Completed);
    assert_eq!(
        a.racelab_session.completion_reason.as_deref(),
        Some(completion::SESSION_UID_CHANGED)
    );
    assert_ne!(a.racelab_session.session_id, b.racelab_session.session_id);
    let events = |file: &f1_session::F1SessionFileV1| {
        f1_session::read_events(&rig.root.join(&file.racelab_session.session_id), 100)
            .unwrap()
            .events
            .into_iter()
            .map(|event| event.code)
            .collect::<Vec<_>>()
    };
    assert_eq!(events(a), vec!["OVTK"]);
    // B's SSTA arrived during A and before B's confirmation: held, not lost
    // and not given to A.
    assert_eq!(events(b), vec!["SSTA", "COLL"]);
    assert!(b.f1_25.end_signals.session_started_event);
    assert!(!a.f1_25.end_signals.session_started_event);
    // Every sample of each session came from its own session.
    for file in [a, b] {
        let (_, samples) =
            f1_session::read_all_samples(&rig.root.join(&file.racelab_session.session_id)).unwrap();
        assert!(!samples.is_empty());
        assert_eq!(samples.len() as u64, file.f1_25.integrity.sample_count);
    }
}

#[test]
fn a_player_index_change_ends_the_recording() {
    let mut rig = Rig::new("f1-player-change");
    rig.drive_for(A, PLAYER, 1_500);
    rig.drive_for(A, PLAYER + 1, 200);
    let ids = rig.session_ids();
    assert_eq!(ids.len(), 1);
    let file = session_file(&rig.root.join(&ids[0]));
    assert_eq!(
        file.racelab_session.completion_reason.as_deref(),
        Some(completion::PLAYER_CAR_CHANGED)
    );
    assert_eq!(file.f1_25.player_car_index, PLAYER);
}

// ----------------------------------------------------------------- end

#[test]
fn session_ended_finishes_after_the_settle_window_and_is_not_reopened() {
    let mut rig = Rig::new("f1-send");
    rig.drive_for(A, PLAYER, 1_500);
    rig.send_event(A, b"SEND", &[]);
    rig.drive_for(A, PLAYER, 1_000);
    assert_eq!(rig.core.status().phase, RecorderPhase::Ending);
    assert_eq!(
        rig.core.status().ending_reason,
        Some(completion::SESSION_ENDED_EVENT)
    );
    rig.drive_for(A, PLAYER, 4_500);
    let status = rig.core.status();
    assert!(!status.recording);
    assert_eq!(
        status.last_completion_reason.as_deref(),
        Some(completion::SESSION_ENDED_EVENT)
    );
    // The game keeps sending the same session (a results screen): it is not
    // recorded a second time.
    rig.drive_for(A, PLAYER, 5_000);
    assert_eq!(
        rig.core.status().waiting_reason,
        Some(waiting::SESSION_ALREADY_ENDED)
    );
    let file = session_file(&rig.only_session());
    assert_eq!(file.racelab_session.status, SessionStatus::Completed);
    assert!(file.f1_25.end_signals.session_ended_event);
    assert!(file.racelab_session.ended_at_unix_ms.is_some());
}

#[test]
fn final_classification_is_persisted_and_the_bulk_history_after_it_is_kept() {
    let mut rig = Rig::new("f1-final");
    rig.drive_for(A, PLAYER, 1_500);
    let rows: [ClassificationSpec; 22] = std::array::from_fn(|car| classification_for(car as u8));
    let h = rig.head(A, PLAYER);
    rig.feed(&final_classification(h, 20, &rows));
    rig.drive_for(A, PLAYER, 500);
    // "A final bulk update of all the session histories" follows.
    let h = rig.head(A, PLAYER);
    rig.feed(&session_history(
        h,
        PLAYER,
        &[
            history_lap(90_100, 0x0f),
            history_lap(90_400, 0x0f),
            history_lap(91_000, 0x0f),
        ],
        &[(2, 16, 16), (255, 17, 17)],
        (1, 1, 1, 2),
    ));
    rig.drive_for(A, PLAYER, 5_000);
    assert!(!rig.core.status().recording);
    let directory = rig.only_session();
    let file = session_file(&directory);
    assert_eq!(
        file.racelab_session.completion_reason.as_deref(),
        Some(completion::FINAL_CLASSIFICATION)
    );
    assert!(file.f1_25.end_signals.final_classification);
    let result: ResultFileV1 = f1_session::read_json(&directory, RESULT_FILE_NAME).unwrap();
    assert_eq!(result.num_cars, 20);
    assert_eq!(result.player.position, PLAYER + 1);
    assert_eq!(result.player.grid_position, 22 - PLAYER);
    assert_eq!(result.player.result_status, 3);
    assert_eq!(result.player.stints.len(), 2);
    let laps: f1_session::LapsFileV1 = f1_session::read_json(&directory, LAPS_FILE_NAME).unwrap();
    // The last entry carries a lap time, so the final lap is complete.
    assert_eq!(laps.laps.len(), 3);
    assert!(laps
        .laps
        .iter()
        .all(|lap| lap.source == LapSource::SessionHistory));
}

#[test]
fn telemetry_loss_holds_a_grace_window_then_ends_as_telemetry_lost() {
    let mut rig = Rig::new("f1-grace");
    rig.drive_for(A, PLAYER, 1_500);
    // A short silence is a gap, not an end.
    rig.silent_for(5_000);
    assert_eq!(rig.core.status().phase, RecorderPhase::Grace);
    rig.drive_for(A, PLAYER, 500);
    assert_eq!(rig.core.status().phase, RecorderPhase::Recording);
    rig.silent_for(59_000);
    assert!(rig.core.status().recording, "still within the grace period");
    rig.silent_for(2_000);
    let status = rig.core.status();
    assert!(!status.recording);
    assert_eq!(
        status.last_completion_reason.as_deref(),
        Some(completion::TELEMETRY_LOST)
    );
    let file = session_file(&rig.only_session());
    assert_eq!(file.racelab_session.status, SessionStatus::Completed);
    assert_eq!(file.f1_25.integrity.telemetry_gaps, 1);
    assert!(file.f1_25.integrity.idle_ticks > 500);
}

#[test]
fn shutdown_is_interrupted_never_a_normal_finish_and_closes_every_file() {
    let mut rig = Rig::new("f1-shutdown");
    rig.drive_for(A, PLAYER, 3_000);
    rig.core.shutdown(rig.now, rig.wall + rig.now);
    let directory = rig.only_session();
    let file = session_file(&directory);
    assert_eq!(file.racelab_session.status, SessionStatus::Interrupted);
    assert_eq!(
        file.racelab_session.completion_reason.as_deref(),
        Some(completion::RACELAB_SHUTDOWN)
    );
    let (header, samples) = f1_session::read_all_samples(&directory).unwrap();
    assert_eq!(header.session_id, file.racelab_session.session_id);
    assert_eq!(samples.len() as u64, file.f1_25.integrity.sample_count);
    // A clean footer: the strict reader accepted every record and the end.
    assert!(f1_session::scan_session(&directory).sample_stream_complete);
}

// ---------------------------------------------------------------- laps

fn lap(lap_num: u8, sector: u8, last_lap_ms: u32, invalid: u8, position: u8) -> LapSpec {
    LapSpec {
        last_lap_ms,
        current_lap_ms: 20_000,
        s1_ms: 29_500,
        s2_ms: 30_500,
        lap_distance: 4_000.0,
        position,
        lap_num,
        sector,
        invalid,
    }
}

#[test]
fn session_history_is_the_lap_authority_and_lap_data_never_overwrites_it() {
    let mut rig = Rig::new("f1-laps");
    rig.drive_for(A, PLAYER, 1_500);
    // Lap 1 in sector 3, invalid, P4; then the counter advances.
    rig.drive(A, PLAYER, lap(1, 2, 0, 1, 4));
    rig.drive(A, PLAYER, lap(2, 0, 95_555, 0, 3));
    let directory = rig.only_session();
    rig.drive_for(A, PLAYER, 5_000);
    let laps: f1_session::LapsFileV1 = f1_session::read_json(&directory, LAPS_FILE_NAME).unwrap();
    let first = &laps.laps[0];
    assert_eq!(first.lap_number, 1);
    assert_eq!(first.source, LapSource::LapData);
    assert_eq!(first.lap_time_ms, 95_555);
    assert_eq!(first.sector1_ms, Some(29_500));
    assert_eq!(first.sector2_ms, Some(30_500));
    assert_eq!(first.sector3_ms, None, "never derived from the lap time");
    assert_eq!(first.lap_valid, Some(false));
    assert_eq!(first.position_at_end, Some(4));

    // Session History describes lap 1 and lap 2. It replaces the provisional
    // record and keeps Lap Data's end position.
    let h = rig.head(A, PLAYER);
    rig.feed(&session_history(
        h,
        PLAYER,
        &[
            history_lap(95_500, 0x0d),
            history_lap(94_000, 0x0f),
            history_lap(0, 0x01),
        ],
        &[(255, 18, 18)],
        (2, 1, 2, 2),
    ));
    rig.drive(A, PLAYER, lap(2, 2, 0, 0, 3));
    // History now holds lap 2. A Lap Data rollover that reports a different
    // time for it, and current-lap readings for lap 3, must not change it.
    rig.drive(A, PLAYER, lap(3, 0, 11_111, 0, 3));
    rig.drive(A, PLAYER, lap(3, 2, 0, 0, 2));
    rig.drive(A, PLAYER, lap(4, 0, 12_345, 0, 2));
    rig.drive_for(A, PLAYER, 5_000);
    let laps: f1_session::LapsFileV1 = f1_session::read_json(&directory, LAPS_FILE_NAME).unwrap();
    let by_number = |n: u16| laps.laps.iter().find(|lap| lap.lap_number == n).unwrap();
    let one = by_number(1);
    assert_eq!(one.source, LapSource::SessionHistory);
    assert_eq!(one.lap_time_ms, 95_500);
    assert_eq!(one.valid_bit_flags, Some(0x0d));
    assert_eq!(one.lap_valid, Some(true));
    assert_eq!(one.sector1_valid, Some(false));
    assert_eq!(one.sector3_ms, Some(95_500 - 61_300));
    assert_eq!(one.position_at_end, Some(4));
    let two = by_number(2);
    assert_eq!(two.source, LapSource::SessionHistory);
    assert_eq!(
        two.lap_time_ms, 94_000,
        "Lap Data's 11 111 ms never replaces it"
    );
    assert_eq!(
        two.position_at_end,
        Some(3),
        "Lap Data may only add its end position"
    );
    // Lap 3 was completed only by Lap Data, so it is provisional.
    let three = by_number(3);
    assert_eq!(three.source, LapSource::LapData);
    assert_eq!(three.lap_time_ms, 12_345);
    // Lap 4 is in progress: no record at all.
    assert!(laps.laps.iter().all(|lap| lap.lap_number != 4));
    assert_eq!(laps.best_lap_time_lap_num, Some(2));
    assert_eq!(laps.history_num_laps, Some(3));
    let tyres: TyresFileV1 = f1_session::read_json(&directory, TYRES_FILE_NAME).unwrap();
    assert_eq!(tyres.stints.len(), 1);
    assert_eq!(tyres.stints[0].end_lap, 255);
}

#[test]
fn lap_positions_attach_start_positions_and_other_cars_history_is_ignored() {
    let mut rig = Rig::new("f1-positions");
    rig.drive_for(A, PLAYER, 1_500);
    let h = rig.head(A, PLAYER);
    // Session History for another car: never the player's laps.
    rig.feed(&session_history(
        h,
        PLAYER + 1,
        &[history_lap(80_000, 0x0f)],
        &[],
        (1, 1, 1, 1),
    ));
    let h = rig.head(A, PLAYER);
    rig.feed(&lap_positions(h, 2, 0, |row, car| (car + row) as u8 + 1));
    rig.drive_for(A, PLAYER, 200);
    let h = rig.head(A, PLAYER);
    rig.feed(&session_history(
        h,
        PLAYER,
        &[history_lap(90_000, 0x0f), history_lap(0, 0)],
        &[],
        (1, 1, 1, 1),
    ));
    rig.drive_for(A, PLAYER, 5_200);
    let laps: f1_session::LapsFileV1 =
        f1_session::read_json(&rig.only_session(), LAPS_FILE_NAME).unwrap();
    assert_eq!(laps.laps.len(), 1);
    assert_eq!(laps.laps[0].lap_time_ms, 90_000);
    assert_eq!(laps.laps[0].position_at_start, Some(PLAYER + 1));
    assert_eq!(laps.lap_positions.len(), 2);
    assert_eq!(laps.lap_positions[1].position, PLAYER + 2);
}

// --------------------------------------------------------------- events

#[test]
fn events_are_stored_raw_decoded_on_read_and_buttons_are_not_stored() {
    let mut rig = Rig::new("f1-events");
    rig.drive_for(A, PLAYER, 1_500);
    rig.send_event(A, b"PENA", &penalty_details(4, 17, PLAYER, 255, 5, 3, 0));
    rig.send_event(
        A,
        b"SPTP",
        &speed_trap_details(PLAYER, 322.5, 1, 1, PLAYER, 322.5),
    );
    rig.send_event(A, b"BUTN", &1u32.to_le_bytes());
    rig.send_event(A, b"XYZW", &[9, 9, 9]);
    rig.send_event(A, b"DRSD", &[3]);
    rig.drive_for(A, PLAYER, 5_200);
    let id = rig.session_ids()[0].clone();
    let detail = session_store::get_f1_session(&rig.root, &id).unwrap();
    let codes: Vec<&str> = detail.events.iter().map(|e| e.code.as_str()).collect();
    assert_eq!(codes, vec!["PENA", "SPTP", "XYZW", "DRSD"]);
    assert_eq!(detail.session.f1_25.integrity.button_events_ignored, 1);
    assert!(matches!(
        detail.events[0].details,
        Some(EventDetails::Penalty {
            time_s: 5,
            lap_num: 3,
            ..
        })
    ));
    assert!(detail.events[0].vehicles[0].is_player);
    assert!(!detail.events[0].vehicles[1].is_player);
    assert!(matches!(
        detail.events[1].details,
        Some(EventDetails::SpeedTrap { speed_kmh, .. }) if speed_kmh == 322.5
    ));
    assert_eq!(detail.events[2].details, Some(EventDetails::Unknown));
    // The stored line keeps the packet's own bytes.
    let stored = f1_session::read_events(&rig.root.join(&id), 10).unwrap();
    assert_eq!(&stored.events[2].code_bytes, b"XYZW");
    assert_eq!(stored.events[2].details_hex, "090909000000000000000000");
    // Nothing in the event log is a label.
    let raw = fs::read_to_string(rig.root.join(&id).join(EVENTS_FILE_NAME)).unwrap();
    assert!(!raw.contains("Pit lane speeding"));
}

#[test]
fn the_event_cap_counts_what_it_does_not_store() {
    let config = F1RecorderConfig {
        max_events: 5,
        ..F1RecorderConfig::default()
    };
    let mut rig = Rig::with("f1-event-cap", config, None);
    rig.drive_for(A, PLAYER, 1_500);
    for _ in 0..12 {
        rig.send_event(A, b"OVTK", &[1, 2]);
    }
    rig.drive_for(A, PLAYER, 200);
    rig.core.shutdown(rig.now, rig.wall + rig.now);
    let file = session_file(&rig.only_session());
    assert_eq!(file.f1_25.integrity.events_stored, 5);
    assert_eq!(file.f1_25.integrity.events_over_cap, 7);
}

#[test]
fn a_wrapped_event_ring_is_reported_as_missed() {
    let mut rig = Rig::new("f1-ring");
    rig.drive_for(A, PLAYER, 1_500);
    // More events between two reads than the ring holds.
    for _ in 0..300 {
        rig.send_event(A, b"OVTK", &[1, 2]);
    }
    rig.drive_for(A, PLAYER, 100);
    rig.core.shutdown(rig.now, rig.wall + rig.now);
    let file = session_file(&rig.only_session());
    assert_eq!(file.f1_25.integrity.events_missed, 300 - 256);
    assert_eq!(file.f1_25.integrity.events_stored, 256);
}

// ------------------------------------------------------------- samples

#[test]
fn samples_are_ten_hertz_latest_values_without_repeats() {
    let mut rig = Rig::new("f1-samples");
    rig.drive_for(A, PLAYER, 2_000);
    // Only Car Status keeps arriving: telemetry, lap and motion must not be
    // repeated into later samples.
    for _ in 0..10 {
        let h = rig.head(A, PLAYER);
        rig.feed(&car_status(h, 40.0));
        rig.tick();
        rig.now += 100;
    }
    // Damage arrives every tick but is sampled once a second.
    for _ in 0..20 {
        let h = rig.head(A, PLAYER);
        rig.feed(&car_damage(h, |car| car));
        rig.feed(&car_telemetry(h, 200, 0.5, 0.2));
        rig.tick();
        rig.now += 100;
    }
    rig.core.shutdown(rig.now, rig.wall + rig.now);
    let (_, samples) = f1_session::read_all_samples(&rig.only_session()).unwrap();
    let status_only: Vec<_> = samples
        .iter()
        .filter(|s| s.status.is_some() && s.telemetry.is_none())
        .collect();
    assert_eq!(status_only.len(), 10);
    assert!(status_only
        .iter()
        .all(|s| s.lap.is_none() && s.motion.is_none()));
    let damage = samples.iter().filter(|s| s.damage.is_some()).count();
    assert_eq!(damage, 2, "20 damage packets over 2 s → 2 damage samples");
    // Strictly increasing sequence and time; one sample per tick at most.
    for pair in samples.windows(2) {
        assert_eq!(pair[1].sequence, pair[0].sequence + 1);
        assert!(pair[1].monotonic_ms > pair[0].monotonic_ms);
    }
    let telemetry = samples.iter().rev().find_map(|s| s.telemetry).unwrap();
    assert_eq!(telemetry.speed_kmh, 200);
    assert_eq!(telemetry.stamp.age_ms, 0);
}

#[test]
fn time_trial_ghosts_stay_apart_from_the_player() {
    let mut rig = Rig::new("f1-time-trial");
    rig.drive_for(A, PLAYER, 1_500);
    let h = rig.head(A, PLAYER);
    rig.feed(&time_trial(
        h,
        [
            TimeTrialSpec {
                car: PLAYER,
                team: 8,
                lap_ms: 88_000,
                sectors: [1, 2, 3],
                valid: 1,
            },
            TimeTrialSpec {
                car: 1,
                team: 8,
                lap_ms: 87_000,
                sectors: [4, 5, 6],
                valid: 1,
            },
            TimeTrialSpec {
                car: 7,
                team: 1,
                lap_ms: 86_000,
                sectors: [7, 8, 9],
                valid: 0,
            },
        ],
    ));
    rig.drive_for(A, PLAYER, 5_200);
    let file = session_file(&rig.only_session());
    let tt = file.f1_25.time_trial.unwrap();
    assert_eq!(tt.player_session_best.lap_time_ms, 88_000);
    assert_eq!(tt.personal_best.car_idx, 1);
    assert_eq!(tt.rival.car_idx, 7);
    assert_eq!(tt.rival.valid, 0);
}

// -------------------------------------------------------------- privacy

#[test]
fn participant_names_and_network_ids_are_never_persisted() {
    let mut rig = Rig::new("f1-privacy");
    rig.drive_for(A, PLAYER, 1_500);
    let mut cars: [ParticipantSpec; 22] = std::array::from_fn(|car| participant_for(car as u8));
    for (index, car) in cars.iter_mut().enumerate() {
        car.name = format!("SecretGamer{index}");
        car.network_id = 170 + index as u8;
    }
    cars[usize::from(PLAYER)].team_id = 8;
    let h = rig.head(A, PLAYER);
    rig.feed(&participants(h, 20, &cars));
    rig.drive_for(A, PLAYER, 5_200);
    rig.core.shutdown(rig.now, rig.wall + rig.now);
    let directory = rig.only_session();
    let file = session_file(&directory);
    let participant = file.f1_25.participant.unwrap();
    assert_eq!(participant.num_active_cars, 20);
    assert_eq!(participant.team_id, 8);
    assert_eq!(participant.race_number, 10 + PLAYER);
    for entry in fs::read_dir(&directory).unwrap().flatten() {
        let bytes = fs::read(entry.path()).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(!text.contains("SecretGamer"), "{:?}", entry.path());
        assert!(!text.contains("network_id"), "{:?}", entry.path());
        assert!(!text.contains("nationality"), "{:?}", entry.path());
    }
}

// ----------------------------------------------------------- ownership

fn fh6_frame() -> TelemetryFrame {
    TelemetryFrame {
        active: true,
        game: Some("fh6".into()),
        vehicle_id: Some("123".into()),
        speed_mps: Some(30.0),
        ..TelemetryFrame::default()
    }
}

#[test]
fn f1_does_not_start_while_fh6_owns_recording_nor_part_way_after() {
    let owner = Arc::new(RecordingOwner::default());
    assert!(owner.claim(RecordingGame::Fh6, "fh6-session"));
    let mut rig = Rig::with(
        "f1-owned-by-fh6",
        F1RecorderConfig::default(),
        Some(Arc::clone(&owner)),
    );
    rig.drive_for(A, PLAYER, 3_000);
    let status = rig.core.status();
    assert!(!status.recording);
    assert_eq!(status.waiting_reason, Some(waiting::ANOTHER_GAME_RECORDING));
    assert_eq!(status.sessions_refused_by_owner, 1);
    assert_eq!(status.recording_owner, Some(RecordingGame::Fh6));
    assert!(rig.session_ids().is_empty());
    // FH6 finishes. The F1 session already under way is not picked up.
    owner.release(RecordingGame::Fh6, "fh6-session");
    rig.drive_for(A, PLAYER, 3_000);
    assert!(!rig.core.status().recording);
    // The next F1 session is recorded.
    rig.drive_for(B, PLAYER, 1_500);
    assert!(rig.core.status().recording);
    assert_eq!(owner.owner().unwrap().game, RecordingGame::F1_25);
    rig.core.shutdown(rig.now, rig.wall + rig.now);
    assert!(
        owner.owner().is_none(),
        "a finalized recording releases the slot"
    );
}

#[test]
fn fh6_does_not_start_while_f1_owns_recording() {
    let owner = Arc::new(RecordingOwner::default());
    let mut rig = Rig::with(
        "f1-owns",
        F1RecorderConfig::default(),
        Some(Arc::clone(&owner)),
    );
    rig.drive_for(A, PLAYER, 1_500);
    assert!(rig.core.status().recording);

    let fh6_root = Scratch::new("fh6-refused");
    let recorder = SessionRecorder::new(fh6_root.to_path_buf()).unwrap();
    recorder.attach_owner(Arc::clone(&owner)).unwrap();
    let hub = TelemetryHub::new(8, "test".into(), 10_000, 60_000).unwrap();
    hub.attach_recorder(Arc::clone(&recorder) as Arc<dyn SessionRecorderHook>)
        .unwrap();
    for at in 0..50 {
        hub.publish(fh6_frame(), at * 16, Some(1_900_000_000_000));
    }
    thread::sleep(Duration::from_millis(50));
    let status = recorder.status();
    assert!(!status.recording);
    assert_eq!(status.sessions_refused_by_owner, 1);
    assert_eq!(status.recording_owner, Some(RecordingGame::F1_25));
    assert_eq!(
        fs::read_dir(&*fh6_root).unwrap().count(),
        0,
        "no FH6 directory"
    );
    // FH6's live session is untouched: only its recording was refused.
    assert!(hub.session().is_some());

    // F1 finishes; FH6's session already under way is not picked up, but
    // its next session is recorded.
    rig.core.shutdown(rig.now, rig.wall + rig.now);
    for at in 50..80 {
        hub.publish(fh6_frame(), at * 16, Some(1_900_000_000_000));
    }
    hub.finish_session(80 * 16, "test_end");
    for at in 81..120 {
        hub.publish(fh6_frame(), at * 16, Some(1_900_000_100_000));
    }
    let until = Instant::now() + Duration::from_secs(5);
    while !recorder.status().recording {
        assert!(
            Instant::now() < until,
            "FH6 never recorded its next session"
        );
        thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(owner.owner().unwrap().game, RecordingGame::Fh6);
    recorder.shutdown();
}

// ---------------------------------------------------------- persistence

/// An FH6 recording made through the real V1.1 recorder.
fn record_fh6(root: &Path) -> String {
    let recorder = SessionRecorder::new(root.to_path_buf()).unwrap();
    let hub = TelemetryHub::new(8, "fh6test".into(), 10_000, 60_000).unwrap();
    hub.attach_recorder(Arc::clone(&recorder) as Arc<dyn SessionRecorderHook>)
        .unwrap();
    for at in 0..40 {
        hub.publish(fh6_frame(), at * 16, Some(1_800_000_000_000));
    }
    let id = hub.session().unwrap().id;
    hub.finish_session(40 * 16, "test_end");
    recorder.shutdown();
    id
}

/// A V1.0-era manifest written as literal text, with an empty frame stream.
fn write_v1_era_session(root: &Path) -> String {
    let id = "legacy-v10-session";
    let directory = root.join(id);
    fs::create_dir_all(&directory).unwrap();
    let manifest = r#"{
  "schema_version": 1,
  "session_id": "legacy-v10-session",
  "status": "completed",
  "game": "fh6",
  "protocol": "fh6",
  "vehicle_id": "2599",
  "started_at_unix_ms": 1700000000000,
  "ended_at_unix_ms": 1700000060000,
  "duration_us": 60000000,
  "frame_count": 0,
  "active_frame_count": 0,
  "inactive_frame_count": 0,
  "recorder_dropped_frames": 0,
  "completion_reason": "grace_expired",
  "frame_file": "frames.rlframes",
  "frame_format_version": 1,
  "telemetry_frame_schema_version": 1,
  "summary": null,
  "created_by_racelab_version": "1.0.0"
}
"#;
    fs::write(directory.join("manifest.json"), manifest).unwrap();
    let mut stream = Vec::new();
    stream.extend_from_slice(b"RLFRM\r\n\0");
    stream.extend_from_slice(&1u32.to_le_bytes());
    stream.extend_from_slice(&1u32.to_le_bytes());
    stream.extend_from_slice(&(id.len() as u32).to_le_bytes());
    stream.extend_from_slice(&1_700_000_000_000u64.to_le_bytes());
    stream.extend_from_slice(id.as_bytes());
    stream.push(2);
    stream.extend_from_slice(&[0; 24]);
    fs::write(directory.join("frames.rlframes"), stream).unwrap();
    id.to_string()
}

fn snapshot(directory: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files: Vec<_> = fs::read_dir(directory)
        .unwrap()
        .flatten()
        .map(|entry| {
            (
                entry.file_name().to_string_lossy().into_owned(),
                fs::read(entry.path()).unwrap(),
            )
        })
        .collect();
    files.sort();
    files
}

#[test]
fn fh6_and_f1_sessions_share_one_listing_and_fh6_files_are_never_rewritten() {
    let root = Scratch::new("multi-game");
    let legacy = write_v1_era_session(&root);
    let fh6 = record_fh6(&root);
    let legacy_before = snapshot(&root.join(&legacy));
    let fh6_before = snapshot(&root.join(&fh6));

    // An F1 session recorded into the same root.
    let base = Instant::now();
    let mut evidence = F1Evidence::new(base);
    let mut core =
        F1RecorderCore::new(root.to_path_buf(), true, F1RecorderConfig::default()).unwrap();
    let mut frame = 0;
    for step in 0..30u64 {
        frame += 1;
        let h = Head::new(0, A, frame, PLAYER);
        let at = base + Duration::from_millis(step * 100);
        for bytes in [
            f1_synthetic::session(h, SessionSpec::default()),
            car_telemetry(h, 250, 1.0, 0.0),
            lap_data(h, LapSpec::default()),
        ] {
            evidence.observe(&bytes, at, 1_950_000_000_000 + step * 100);
        }
        let (age, view) = evidence.recording_view(at, core.event_cursor());
        core.tick(Tick {
            now_ms: step * 100,
            wall_ms: 1_950_000_000_000 + step * 100,
            last_accepted_age_ms: age,
            view,
        });
    }
    core.shutdown(3_000, 1_950_000_003_000);

    // Listing, recovery and retention all read every directory.
    let listing = session_store::list_recent_sessions(&root, None);
    assert_eq!(listing.unreadable, 0);
    assert_eq!(listing.sessions.len(), 2, "both FH6 sessions, V1 and V2");
    assert_eq!(listing.f1_sessions.len(), 1);
    let f1 = &listing.f1_sessions[0];
    assert_eq!(f1.labels.track.as_ref().unwrap().label, Some("Silverstone"));
    assert_eq!(f1.session.racelab_session.game, SessionGame::F1_25);
    // Newest first across games: F1 (1.95e12) is newest, then the V1.1 FH6
    // recording (1.8e12), then the V1.0 one.
    let mut starts: Vec<u64> = listing
        .sessions
        .iter()
        .filter_map(|m| m.started_at_unix_ms)
        .collect();
    starts.push(f1.session.racelab_session.started_at_unix_ms.unwrap());
    starts.sort_unstable_by(|a, b| b.cmp(a));
    assert_eq!(
        starts[0],
        f1.session.racelab_session.started_at_unix_ms.unwrap()
    );
    // The limit applies across games.
    let one = session_store::list_recent_sessions(&root, Some(1));
    assert_eq!(one.sessions.len() + one.f1_sessions.len(), 1);
    assert_eq!(one.f1_sessions.len(), 1);

    racelab_lib::session_recovery::classify_interrupted_sessions(&root).unwrap();
    f1_session::classify_interrupted_sessions(&root).unwrap();
    let mut status = racelab_lib::session_retention::RetentionStatus::default();
    racelab_lib::session_retention::sweep(
        &root,
        racelab_lib::session_retention::RetentionPolicy { budget_bytes: 0 },
        &[],
        &mut status,
    );
    assert_eq!(
        status.unidentifiable_sessions, 0,
        "F1 sessions are identifiable"
    );
    assert_eq!(status.retained_sessions, 3);

    // Old FH6 files: byte-identical, still readable by the FH6 reader.
    assert_eq!(snapshot(&root.join(&legacy)), legacy_before);
    assert_eq!(snapshot(&root.join(&fh6)), fh6_before);
    assert!(session_store::get_session(&root, &legacy).is_ok());
    assert!(session_store::get_session(&root, &fh6).is_ok());
    // And each game's reader refuses the other's directory.
    let f1_id = &f1.session.racelab_session.session_id;
    assert!(session_store::get_session(&root, f1_id).is_err());
    assert!(session_store::get_f1_session(&root, &fh6).is_err());
    // Reopen the F1 session.
    let detail = session_store::get_f1_session(&root, f1_id).unwrap();
    assert_eq!(
        detail.session.racelab_session.status,
        SessionStatus::Interrupted
    );
    assert!(detail.unreadable_files.is_empty());
}

#[test]
fn retention_deletes_f1_sessions_oldest_first_and_never_the_one_recording() {
    let root = Scratch::new("f1-retention");
    for (index, started) in [1_000u64, 2_000, 3_000].into_iter().enumerate() {
        let id = format!("f1-{started}-0000000{index}");
        let directory = root.join(&id);
        fs::create_dir_all(&directory).unwrap();
        let mut file = f1_session::F1SessionFileV1::new(id, A + index as u64, 0, started);
        file.racelab_session.status = if index == 0 {
            SessionStatus::Recording
        } else {
            SessionStatus::Completed
        };
        f1_session::write_session(&directory, &file).unwrap();
        fs::write(directory.join(SAMPLES_FILE_NAME), vec![0u8; 4096]).unwrap();
    }
    // A budget one byte under the total: exactly one session must go.
    let total: u64 = fs::read_dir(&*root)
        .unwrap()
        .flatten()
        .flat_map(|session| fs::read_dir(session.path()).unwrap().flatten())
        .map(|file| file.metadata().unwrap().len())
        .sum();
    let mut status = racelab_lib::session_retention::RetentionStatus::default();
    racelab_lib::session_retention::sweep(
        &root,
        racelab_lib::session_retention::RetentionPolicy {
            budget_bytes: total - 1,
        },
        &[],
        &mut status,
    );
    assert_eq!(status.deleted_sessions, 1);
    assert_eq!(status.protected_sessions, 1);
    assert!(
        root.join("f1-1000-00000000").exists(),
        "the recording session is kept"
    );
    assert!(
        !root.join("f1-2000-00000001").exists(),
        "the oldest finished one goes"
    );
    assert!(root.join("f1-3000-00000002").exists());
}

// ------------------------------------------------------------- recovery

#[test]
fn a_crashed_recording_is_recovered_as_interrupted_with_its_readable_data() {
    let root = Scratch::new("f1-crash");
    let directory;
    {
        let base = Instant::now();
        let mut evidence = F1Evidence::new(base);
        let mut core =
            F1RecorderCore::new(root.to_path_buf(), true, F1RecorderConfig::default()).unwrap();
        let mut frame = 0;
        for step in 0..120u64 {
            frame += 1;
            let h = Head::new(0, A, frame, PLAYER);
            let at = base + Duration::from_millis(step * 100);
            for bytes in [
                f1_synthetic::session(h, SessionSpec::default()),
                car_telemetry(h, 250, 1.0, 0.0),
                lap_data(h, LapSpec::default()),
            ] {
                evidence.observe(&bytes, at, 1_950_000_000_000);
            }
            if step == 50 {
                evidence.observe(&event(h, b"SSTA", &[]), at, 1_950_000_000_000);
            }
            let (age, view) = evidence.recording_view(at, core.event_cursor());
            core.tick(Tick {
                now_ms: step * 100,
                wall_ms: 1_950_000_000_000 + step * 100,
                last_accepted_age_ms: age,
                view,
            });
        }
        let id = core.recording_session_id().unwrap().to_string();
        directory = root.join(&id);
        // The process dies here: no shutdown, no footer. Dropping the core
        // flushes its buffers, as an OS would on a killed process' completed
        // writes; the tail is then cut part-way through a record by hand.
        std::mem::drop(core);
    }
    let checkpointed = session_file(&directory);
    assert_eq!(
        checkpointed.racelab_session.status,
        SessionStatus::Recording
    );
    let samples_path = directory.join(SAMPLES_FILE_NAME);
    let length = fs::metadata(&samples_path).unwrap().len();
    let file = fs::OpenOptions::new()
        .write(true)
        .open(&samples_path)
        .unwrap();
    file.set_len(length - 7).unwrap();
    drop(file);
    let mut events = fs::OpenOptions::new()
        .append(true)
        .open(directory.join(EVENTS_FILE_NAME))
        .unwrap();
    events.write_all(br#"{"sequence":9,"monot"#).unwrap();
    drop(events);

    // Startup: a new recorder (or the recovery service) classifies first.
    let _restarted =
        F1RecorderCore::new(root.to_path_buf(), true, F1RecorderConfig::default()).unwrap();
    let classified = session_file(&directory);
    assert_eq!(
        classified.racelab_session.status,
        SessionStatus::Interrupted
    );
    assert_eq!(
        classified.racelab_session.completion_reason.as_deref(),
        Some(completion::INTERRUPTED)
    );
    assert_eq!(
        classified.f1_25.recovery.as_ref().unwrap().outcome,
        RecoveryOutcome::Pending
    );
    assert_eq!(
        f1_session::sessions_awaiting_scan(&root),
        vec![directory.clone()]
    );

    let outcome = f1_session::recover_session(&directory).unwrap();
    assert_eq!(outcome, RecoveryOutcome::Truncated);
    let recovered = session_file(&directory);
    let recovery = recovered.f1_25.recovery.as_ref().unwrap();
    assert!(!recovery.sample_stream_complete);
    assert!(recovery.readable_samples > 0);
    assert!(recovery.readable_samples < 120);
    assert_eq!(recovery.readable_events, 1);
    assert!(recovery.event_tail_discarded);
    assert!(recovery.laps_readable && recovery.tyres_readable);
    // Never a normal finish, never a fabricated result.
    assert_eq!(recovered.racelab_session.status, SessionStatus::Interrupted);
    assert!(!directory.join(RESULT_FILE_NAME).exists());
    assert!(recovered.f1_25.integrity.sample_count >= recovery.readable_samples);
    assert!(
        f1_session::sessions_awaiting_scan(&root).is_empty(),
        "scanned once"
    );
    // The detail still opens and shows the readable event.
    let id = recovered.racelab_session.session_id.clone();
    let detail = session_store::get_f1_session(&root, &id).unwrap();
    assert_eq!(detail.events_total, 1);
    // Recovery never wrote to the sample stream.
    assert_eq!(fs::metadata(&samples_path).unwrap().len(), length - 7);
}

#[test]
fn an_unreadable_sample_stream_is_reported_not_repaired() {
    let root = Scratch::new("f1-unreadable");
    let directory = root.join("f1-1-00000000");
    fs::create_dir_all(&directory).unwrap();
    let file = f1_session::F1SessionFileV1::new("f1-1-00000000".into(), A, 0, 1);
    f1_session::write_session(&directory, &file).unwrap();
    fs::write(directory.join(SAMPLES_FILE_NAME), b"not a sample stream").unwrap();
    f1_session::classify_interrupted_sessions(&root).unwrap();
    assert_eq!(
        f1_session::recover_session(&directory).unwrap(),
        RecoveryOutcome::Unreadable
    );
    assert_eq!(
        fs::read(directory.join(SAMPLES_FILE_NAME)).unwrap(),
        b"not a sample stream"
    );
}
