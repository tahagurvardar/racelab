//! F1 25 Phase D stress: long sessions, many events, many sessions and
//! repeated crashes stay bounded. Synthetic packets and clock; real files.
//! Sizes are chosen to finish in seconds, not to exhaust a machine.
mod f1_synthetic;
mod scratch;

use f1_synthetic::*;
use racelab_lib::{
    f1_evidence::F1Evidence,
    f1_recorder::{F1RecorderConfig, F1RecorderCore, Tick},
    f1_session::{self, completion},
    session_format::{RecoveryOutcome, SessionStatus},
    session_store,
};
use scratch::Scratch;
use std::{
    fs,
    time::{Duration, Instant},
};

const PLAYER: u8 = 0;

struct Clock {
    evidence: F1Evidence,
    core: F1RecorderCore,
    base: Instant,
    now: u64,
    frame: u32,
}

impl Clock {
    fn new(root: &Scratch, config: F1RecorderConfig) -> Self {
        let base = Instant::now();
        Self {
            evidence: F1Evidence::new(base),
            core: F1RecorderCore::new(root.to_path_buf(), true, config).unwrap(),
            base,
            now: 0,
            frame: 0,
        }
    }

    fn feed(&mut self, bytes: &[u8]) {
        let at = self.base + Duration::from_millis(self.now);
        self.evidence
            .observe(bytes, at, 2_000_000_000_000 + self.now);
    }

    fn step(&mut self, uid: u64, lap: LapSpec, extra: impl FnOnce(&mut Self, Head)) {
        self.frame += 1;
        let h = Head::new(0, uid, self.frame, PLAYER);
        if self.frame.is_multiple_of(5) || self.frame < 3 {
            self.feed(&f1_synthetic::session(h, SessionSpec::default()));
        }
        self.feed(&car_telemetry(h, 280, 1.0, 0.0));
        self.feed(&car_status(h, 60.0));
        self.feed(&lap_data(h, lap));
        self.feed(&motion_ex(h));
        if self.frame.is_multiple_of(10) {
            self.feed(&car_damage(h, |car| car));
        }
        extra(self, h);
        let at = self.base + Duration::from_millis(self.now);
        let (age, view) = self.evidence.recording_view(at, self.core.event_cursor());
        self.core.tick(Tick {
            now_ms: self.now,
            wall_ms: 2_000_000_000_000 + self.now,
            last_accepted_age_ms: age,
            view,
        });
        self.now += 100;
    }
}

fn directory_bytes(path: &std::path::Path) -> u64 {
    fs::read_dir(path)
        .unwrap()
        .flatten()
        .map(|entry| entry.metadata().unwrap().len())
        .sum()
}

/// Two hours of driving at the 10 Hz sample cadence: 72 000 reader ticks,
/// 80-second laps with Session History after each, tyre sets and damage
/// throughout. Every bounded structure stays bounded and the files stay
/// readable end to end.
#[test]
fn a_two_hour_session_stays_bounded_and_readable() {
    let root = Scratch::new("f1-stress-hours");
    // Checkpoints fsync three files. At real time that is every 5 s; in a
    // test running thousands of times faster it would dominate, so this
    // test checkpoints every simulated minute instead.
    let config = F1RecorderConfig {
        checkpoint_interval_ms: 60_000,
        ..F1RecorderConfig::default()
    };
    let mut clock = Clock::new(&root, config);
    let started = Instant::now();
    let ticks: u32 = 2 * 60 * 60 * 10;
    let lap_ticks = 800;
    let mut history: Vec<HistoryLap> = Vec::new();
    for tick in 0..ticks {
        let lap_num = (tick / lap_ticks + 1).min(255) as u8;
        let spec = LapSpec {
            lap_num,
            last_lap_ms: if lap_num > 1 {
                80_000 + u32::from(lap_num)
            } else {
                0
            },
            sector: ((tick % lap_ticks) / (lap_ticks / 3)).min(2) as u8,
            ..LapSpec::default()
        };
        let lap_completed = tick > 0 && tick % lap_ticks == 0;
        if lap_completed && history.len() < 100 {
            history.push(history_lap(80_000 + history.len() as u32 + 1, 0x0f));
        }
        let snapshot = history.clone();
        clock.step(0xABCD, spec, |clock, h| {
            if tick % 20 == 0 {
                let mut laps = snapshot.clone();
                laps.push(history_lap(0, 0));
                clock.feed(&session_history(
                    h,
                    PLAYER,
                    &laps,
                    &[(255, 16, 16)],
                    (1, 1, 1, 1),
                ));
                clock.feed(&tyre_sets(h, PLAYER, (tick / 9000 % 20) as u8));
            }
            if tick % 50 == 0 {
                clock.feed(&event(h, b"OVTK", &[1, 2]));
            }
        });
    }
    clock
        .core
        .shutdown(clock.now, 2_000_000_000_000 + clock.now);
    let elapsed = started.elapsed();

    let ids: Vec<_> = fs::read_dir(&*root).unwrap().flatten().collect();
    assert_eq!(ids.len(), 1);
    let directory = ids[0].path();
    let file = f1_session::read_session(&directory).unwrap();
    let integrity = &file.f1_25.integrity;
    // One sample per tick after the 1 s confirmation, never more.
    assert!(integrity.sample_count <= u64::from(ticks));
    assert!(integrity.sample_count >= u64::from(ticks) - 20);
    assert_eq!(integrity.events_missed, 0);
    // Including the first, which arrived during the confirmation window and
    // was held for the session rather than dropped.
    assert_eq!(integrity.events_stored, u64::from(ticks / 50));
    // ≤ 255 laps by construction; here 89 completed laps.
    assert!(integrity.lap_count <= 255);
    assert!(integrity.lap_count >= 89);
    let tyres: f1_session::TyresFileV1 =
        f1_session::read_json(&directory, f1_session::TYRES_FILE_NAME).unwrap();
    assert!(tyres.fitted_changes.len() <= f1_session::MAX_FITTED_CHANGES);
    let (_, samples) = f1_session::read_all_samples(&directory).unwrap();
    assert_eq!(samples.len() as u64, integrity.sample_count);
    let damage = samples.iter().filter(|s| s.damage.is_some()).count();
    assert!(
        damage as u64 <= u64::from(ticks / 10),
        "damage at most once a second"
    );
    let bytes = directory_bytes(&directory);
    let per_hour = bytes / 2;
    eprintln!(
        "two-hour F1 session: {} samples, {} laps, {} events, {:.1} MB ({:.1} MB/hour), simulated in {:.1?}",
        integrity.sample_count,
        integrity.lap_count,
        integrity.events_stored,
        bytes as f64 / 1e6,
        per_hour as f64 / 1e6,
        elapsed
    );
    // Typed 10 Hz samples are a small fraction of FH6's ~3 MB/s.
    assert!(per_hour < 200_000_000, "{per_hour} bytes per hour");
    let detail = session_store::get_f1_session(&root, &file.racelab_session.session_id).unwrap();
    assert!(detail.events.len() <= f1_session::MAX_DETAIL_EVENTS);
}

#[test]
fn tens_of_thousands_of_events_are_capped_counted_and_never_lost_silently() {
    let root = Scratch::new("f1-stress-events");
    let mut clock = Clock::new(&root, F1RecorderConfig::default());
    for _ in 0..20 {
        clock.step(0x1, LapSpec::default(), |_, _| {});
    }
    // 100 events per 100 ms for 30 seconds: 30 000 events.
    for _ in 0..300 {
        clock.step(0x1, LapSpec::default(), |clock, h| {
            for index in 0..100u8 {
                clock.feed(&event(
                    h,
                    b"SPTP",
                    &speed_trap_details(index % 22, 300.0, 0, 0, 0, 300.0),
                ));
            }
        });
    }
    clock
        .core
        .shutdown(clock.now, 2_000_000_000_000 + clock.now);
    let directory = fs::read_dir(&*root)
        .unwrap()
        .flatten()
        .next()
        .unwrap()
        .path();
    let file = f1_session::read_session(&directory).unwrap();
    let integrity = &file.f1_25.integrity;
    assert_eq!(integrity.events_missed, 0);
    assert_eq!(integrity.events_stored, 20_000);
    assert_eq!(integrity.events_over_cap, 10_000);
    let read = f1_session::read_events(&directory, 10).unwrap();
    assert_eq!(read.total, 20_000);
    assert_eq!(
        read.events.len(),
        10,
        "the reader keeps only what it is asked to"
    );
}

#[test]
fn hundreds_of_session_uid_changes_make_hundreds_of_separate_sessions() {
    let root = Scratch::new("f1-stress-uids");
    let mut clock = Clock::new(&root, F1RecorderConfig::default());
    let sessions = 150u64;
    for uid in 1..=sessions {
        for _ in 0..15 {
            clock.step(uid, LapSpec::default(), |_, _| {});
        }
    }
    clock
        .core
        .shutdown(clock.now, 2_000_000_000_000 + clock.now);
    let directories: Vec<_> = fs::read_dir(&*root).unwrap().flatten().collect();
    assert_eq!(directories.len() as u64, sessions);
    let mut uids = std::collections::BTreeSet::new();
    for entry in &directories {
        let file = f1_session::read_session(&entry.path()).unwrap();
        assert!(
            uids.insert(file.f1_25.session_uid.clone()),
            "one session per UID"
        );
        let last = file.f1_25.session_uid == sessions.to_string();
        assert_eq!(
            file.racelab_session.completion_reason.as_deref(),
            Some(if last {
                completion::RACELAB_SHUTDOWN
            } else {
                completion::SESSION_UID_CHANGED
            })
        );
    }
    let listing = session_store::list_recent_sessions(&root, Some(100));
    assert_eq!(listing.f1_sessions.len(), 100);
    assert_eq!(listing.unreadable, 0);
}

#[test]
fn repeated_crashes_are_each_recovered_once_and_never_completed() {
    let root = Scratch::new("f1-stress-crash");
    for round in 0..12u64 {
        let mut clock = Clock::new(&root, F1RecorderConfig::default());
        for _ in 0..40 {
            clock.step(1000 + round, LapSpec::default(), |_, _| {});
        }
        drop(clock); // no shutdown: a crash
    }
    // The last recorder's constructor classified all but its own session;
    // a restart classifies that one too.
    f1_session::classify_interrupted_sessions(&root).unwrap();
    let pending = f1_session::sessions_awaiting_scan(&root);
    assert_eq!(pending.len(), 12);
    for directory in &pending {
        let outcome = f1_session::recover_session(directory).unwrap();
        assert!(matches!(
            outcome,
            RecoveryOutcome::Truncated | RecoveryOutcome::Complete
        ));
        let file = f1_session::read_session(directory).unwrap();
        assert_eq!(file.racelab_session.status, SessionStatus::Interrupted);
        assert!(file.f1_25.recovery.unwrap().readable_samples > 0);
    }
    assert!(f1_session::sessions_awaiting_scan(&root).is_empty());
}
