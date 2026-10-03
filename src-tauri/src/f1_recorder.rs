//! F1 25 session recording, V2.0 Phase D. See
//! docs/V2.0-PHASE-D-F1-RECORDING.md.
//!
//! A reader thread wakes every `sample_interval_ms` (100 ms), copies the F1
//! aggregator's held packets and new events under one short lock
//! (`F1EvidenceService::recording_view`), and does everything else — decoding,
//! session identity, lap authority, sampling and disk — on its own thread. The
//! UDP receive thread never waits for it: it only ever fills fixed slots and
//! a fixed event ring. Nothing here buffers native-rate packet history; the
//! only growing state is bounded by the format (≤ 255 laps, ≤ 64 tyre fitted
//! changes, ≤ `max_events` events, all on disk).
//!
//! **Identity.** A recording belongs to one F1 `sessionUID` and one
//! `playerCarIndex`. RaceLab's own session id is generated separately and is
//! never derived from either. A zero UID, an invalid player index or a
//! packet from another UID never contributes to a recording.
//!
//! **Start**, conservatively, when every condition holds for
//! `start_confirm_ms` without interruption:
//! - F1 25 support is enabled in this build;
//! - the UID is non-zero and the player index is a valid car index;
//! - a Session packet for this UID is held and at most `context_max_age_ms`
//!   old, its session type is not the specification's 0 "unknown", and
//!   `m_isSpectating` is 0 (any non-zero value is treated as spectating);
//! - the player's Car Telemetry or Lap Data is at most `player_fresh_ms` old;
//! - the UID was not already ended by the game ("SEND" or Final
//!   Classification), and was not refused because FH6 held the recording slot.
//!
//! **End.** `session_uid_changed` and `player_car_changed` end a recording at
//! once. "SEND" and Final Classification start an `end_settle_ms` window, so
//! the "final bulk update of all the session histories" the specification
//! describes after the classification can still be read. Silence longer
//! than `silence_ms` is a grace state; silence reaching `grace_ms` ends the
//! recording as `telemetry_lost`. RaceLab closing ends it as
//! `racelab_shutdown`, which is `interrupted`, never a normal finish. These
//! timings are F1-specific defaults that have not been checked against the
//! game: MANUAL ACCEPTANCE PENDING.
//!
//! **Laps.** Session History is the authority for completed laps. Lap Data
//! contributes a provisional record only for a lap History has not
//! described, and never replaces a History record.
use crate::{
    adapters::f1_25::{
        car_damage::{self, CarDamage},
        car_status::{self, CarStatus},
        car_telemetry::{self, CarTelemetry},
        codes::LapValidity,
        codes::Sector,
        event::{self, DETAILS_SIZE},
        final_classification,
        lap_data::{self, LapData},
        lap_positions,
        motion_ex::{self, MotionEx},
        participants,
        session::{self, SessionPacket},
        session_history::{self, SessionHistoryPacket},
        time_trial::{self, TimeTrialSet},
        tyre_sets::{self, TyreSetsPacket},
        PacketHeader, PacketKind, Wheels, MAX_CARS,
    },
    f1_evidence::F1EvidenceService,
    f1_live::{HeldEvent, HeldPacket, RecordingView},
    f1_session::{
        self, completion, ClassificationV1, EventLogWriter, F1ProtocolV1, F1SampleV1,
        F1SessionFileV1, FamilyCoverageV1, FamilyStampV1, FittedChangeV1, ForecastV1,
        LapPositionV1, LapRecordV1, LapSampleV1, LapSource, LapsFileV1, MotionSampleV1,
        ParticipantContextV1, ResultFileV1, SampleStreamEnd, SampleStreamHeader,
        SampleStreamWriter, SessionContextV1, StatusSampleV1, StintV1, StoredEventV1,
        TelemetrySampleV1, TimeTrialSetV1, TimeTrialV1, TyreSetV1, TyreSetsSnapshotV1, TyresFileV1,
        WheelsV1, F1_SCHEMA_VERSION, MAX_FITTED_CHANGES, RESULT_FILE_NAME, SAMPLE_SCHEMA_VERSION,
        SAMPLE_STREAM_VERSION,
    },
    recording_owner::{RecordingGame, RecordingOwner},
    session_format::SessionStatus,
    session_recorder::SessionCompletionHook,
    session_retention::SessionProtection,
};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    fs, io,
    path::{Path, PathBuf},
    sync::{
        mpsc::{self, RecvTimeoutError},
        Arc, Mutex, MutexGuard, OnceLock,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

/// F1-specific timing. Deliberately not FH6's: F1 sends many families at
/// different rates, keeps sending in garages and menus of a session, and
/// announces its own session boundaries.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct F1RecorderConfig {
    pub sample_interval_ms: u64,
    pub start_confirm_ms: u64,
    pub player_fresh_ms: u64,
    pub context_max_age_ms: u64,
    pub silence_ms: u64,
    pub grace_ms: u64,
    pub end_settle_ms: u64,
    pub checkpoint_interval_ms: u64,
    pub max_events: u64,
    /// Events held for a session that has not started recording yet.
    pub max_pending_events: usize,
}

impl Default for F1RecorderConfig {
    fn default() -> Self {
        Self {
            sample_interval_ms: 100,
            start_confirm_ms: 1000,
            player_fresh_ms: 1000,
            context_max_age_ms: 5000,
            silence_ms: 3000,
            grace_ms: 60_000,
            end_settle_ms: 5000,
            checkpoint_interval_ms: 5000,
            max_events: 20_000,
            max_pending_events: 64,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RecorderPhase {
    /// F1 25 support is off in this build.
    Disabled,
    /// Nothing recordable.
    Idle,
    /// Conditions hold; confirming for `start_confirm_ms`.
    Candidate,
    Recording,
    /// Recording, and silent for longer than `silence_ms`.
    Grace,
    /// Recording, inside the settle window after the game ended the session.
    Ending,
}

/// Why nothing is being recorded right now. Stable identifiers.
pub mod waiting {
    pub const NO_PACKETS: &str = "no_f1_packets";
    pub const INVALID_SESSION_UID: &str = "invalid_session_uid";
    pub const INVALID_PLAYER_INDEX: &str = "invalid_player_index";
    pub const NO_SESSION_CONTEXT: &str = "no_session_context";
    pub const SESSION_TYPE_UNKNOWN: &str = "session_type_unknown";
    pub const SPECTATING: &str = "spectating";
    pub const PLAYER_NOT_FRESH: &str = "player_telemetry_not_fresh";
    pub const SESSION_ALREADY_ENDED: &str = "session_already_ended";
    pub const CONFIRMING: &str = "confirming";
    pub const ANOTHER_GAME_RECORDING: &str = "another_game_recording";
    pub const COULD_NOT_OPEN: &str = "could_not_open_recording";
}

#[derive(Debug, Clone, Serialize)]
pub struct F1RecorderStatus {
    pub revision: u64,
    pub enabled: bool,
    pub phase: RecorderPhase,
    pub recording: bool,
    pub sessions_directory: String,
    pub session_id: Option<String>,
    /// Decimal string.
    pub session_uid: Option<String>,
    pub started_at_unix_ms: Option<u64>,
    pub duration_ms: u64,
    pub samples_written: u64,
    pub events_stored: u64,
    pub laps: u64,
    pub waiting_reason: Option<&'static str>,
    pub grace_remaining_ms: Option<u64>,
    pub ending_reason: Option<&'static str>,
    /// Specification names for the recording's session, when known.
    pub track_label: Option<&'static str>,
    pub session_type_label: Option<&'static str>,
    pub completed_sessions: u64,
    pub last_completed_session_id: Option<String>,
    pub last_completion_reason: Option<String>,
    pub sessions_refused_by_owner: u64,
    pub recording_owner: Option<RecordingGame>,
    pub last_error: Option<String>,
    pub config: F1RecorderConfig,
}

impl F1RecorderStatus {
    fn new(root: &Path, enabled: bool, config: F1RecorderConfig) -> Self {
        Self {
            revision: 0,
            enabled,
            phase: if enabled {
                RecorderPhase::Idle
            } else {
                RecorderPhase::Disabled
            },
            recording: false,
            sessions_directory: root.to_string_lossy().into_owned(),
            session_id: None,
            session_uid: None,
            started_at_unix_ms: None,
            duration_ms: 0,
            samples_written: 0,
            events_stored: 0,
            laps: 0,
            waiting_reason: None,
            grace_remaining_ms: None,
            ending_reason: None,
            track_label: None,
            session_type_label: None,
            completed_sessions: 0,
            last_completed_session_id: None,
            last_completion_reason: None,
            sessions_refused_by_owner: 0,
            recording_owner: None,
            last_error: None,
            config,
        }
    }
}

// ------------------------------------------------------------- decoding

fn decoded<T>(
    packet: &HeldPacket,
    decode: impl Fn(&[u8]) -> Result<(PacketHeader, T), crate::adapters::f1_25::DecodeError>,
) -> Option<T> {
    decode(&packet.bytes).ok().map(|(_, value)| value)
}

fn wheels<T: Copy, U>(w: Wheels<T>, map: impl Fn(T) -> U) -> WheelsV1<U> {
    WheelsV1 {
        rl: map(w.rear_left),
        rr: map(w.rear_right),
        fl: map(w.front_left),
        fr: map(w.front_right),
    }
}

fn stamp(packet: &HeldPacket) -> FamilyStampV1 {
    FamilyStampV1 {
        overall_frame_identifier: packet.header.overall_frame_identifier,
        session_time: packet.header.session_time,
        age_ms: packet.age_ms.min(u64::from(u32::MAX)) as u32,
    }
}

fn telemetry_sample(packet: &HeldPacket, t: &CarTelemetry) -> TelemetrySampleV1 {
    TelemetrySampleV1 {
        stamp: stamp(packet),
        speed_kmh: t.speed_kmh,
        throttle: t.throttle,
        brake: t.brake,
        steer: t.steer,
        clutch: t.clutch,
        gear: t.gear.raw(),
        engine_rpm: t.engine_rpm,
        drs: t.drs.raw(),
        engine_temperature_c: t.engine_temperature_c,
        brakes_temperature_c: wheels(t.brakes_temperature_c, |v| v),
        tyres_surface_temperature_c: wheels(t.tyres_surface_temperature_c, |v| v),
        tyres_inner_temperature_c: wheels(t.tyres_inner_temperature_c, |v| v),
        tyres_pressure_psi: wheels(t.tyres_pressure_psi, |v| v),
        surface_type: wheels(t.surface_type, |v| v.raw()),
    }
}

fn status_sample(packet: &HeldPacket, s: &CarStatus) -> StatusSampleV1 {
    StatusSampleV1 {
        stamp: stamp(packet),
        fuel_mix: s.fuel_mix.raw(),
        front_brake_bias_percent: s.front_brake_bias_percent,
        pit_limiter_status: s.pit_limiter_status.raw(),
        fuel_in_tank: s.fuel_in_tank,
        fuel_remaining_laps: s.fuel_remaining_laps,
        drs_allowed: s.drs_allowed.raw(),
        drs_activation_distance_m: s.drs_activation_distance_m,
        actual_tyre_compound: s.actual_tyre_compound.raw(),
        visual_tyre_compound: s.visual_tyre_compound.raw(),
        tyres_age_laps: s.tyres_age_laps,
        vehicle_fia_flags: s.vehicle_fia_flags.raw(),
        ers_store_energy_j: s.ers_store_energy_j,
        ers_deploy_mode: s.ers_deploy_mode.raw(),
        ers_harvested_this_lap_mguk: s.ers_harvested_this_lap_mguk,
        ers_harvested_this_lap_mguh: s.ers_harvested_this_lap_mguh,
        ers_deployed_this_lap: s.ers_deployed_this_lap,
    }
}

fn lap_sample(packet: &HeldPacket, l: &LapData) -> LapSampleV1 {
    LapSampleV1 {
        stamp: stamp(packet),
        current_lap_num: l.current_lap_num,
        current_lap_time_ms: l.current_lap_time_ms,
        last_lap_time_ms: l.last_lap_time_ms,
        sector1_ms: l.sector1_time.total_ms,
        sector2_ms: l.sector2_time.total_ms,
        lap_distance_m: l.lap_distance_m,
        total_distance_m: l.total_distance_m,
        car_position: l.car_position,
        sector: l.sector.raw(),
        current_lap_invalid: l.current_lap_invalid.raw(),
        pit_status: l.pit_status.raw(),
        num_pit_stops: l.num_pit_stops,
        penalties_s: l.penalties_s,
        driver_status: l.driver_status.raw(),
        result_status: l.result_status.raw(),
        safety_car_delta_s: l.safety_car_delta_s,
    }
}

fn motion_sample(packet: &HeldPacket, m: &MotionEx) -> MotionSampleV1 {
    let v = m.local_velocity_mps;
    let a = m.angular_velocity_rad_s;
    MotionSampleV1 {
        stamp: stamp(packet),
        local_velocity_mps: [v.x, v.y, v.z],
        angular_velocity_rad_s: [a.x, a.y, a.z],
        front_wheels_angle_rad: m.front_wheels_angle_rad,
        wheel_slip_ratio: wheels(m.wheel_slip_ratio, |v| v),
        wheel_slip_angle: wheels(m.wheel_slip_angle, |v| v),
        chassis_yaw_rad: m.chassis_yaw_rad,
        chassis_pitch_rad: m.chassis_pitch_rad,
    }
}

fn session_context(packet: &HeldPacket, s: &SessionPacket) -> SessionContextV1 {
    SessionContextV1 {
        received_unix_ms: packet.received_unix_ms,
        session_time: packet.header.session_time,
        weather: s.weather.raw(),
        track_temperature_c: s.track_temperature_c,
        air_temperature_c: s.air_temperature_c,
        total_laps: s.total_laps,
        track_length_m: s.track_length_m,
        session_type: s.session_type.raw(),
        track_id: s.track_id.raw(),
        formula: s.formula.raw(),
        session_time_left_s: s.session_time_left_s,
        session_duration_s: s.session_duration_s,
        pit_speed_limit_kmh: s.pit_speed_limit_kmh,
        game_paused: s.game_paused,
        is_spectating: s.is_spectating,
        safety_car_status: s.safety_car_status.raw(),
        network_game: s.network_game.raw(),
        ai_difficulty: s.ai_difficulty,
        game_mode: s.game_mode.raw(),
        rule_set: s.rule_set.raw(),
        num_safety_car_periods: s.num_safety_car_periods,
        num_virtual_safety_car_periods: s.num_virtual_safety_car_periods,
        num_red_flag_periods: s.num_red_flag_periods,
        sector2_lap_distance_start_m: s.sector2_lap_distance_start_m,
        sector3_lap_distance_start_m: s.sector3_lap_distance_start_m,
        num_weather_forecast_samples: s.num_weather_forecast_samples,
        forecast: s
            .weather_forecast_samples
            .iter()
            .take(f1_session::MAX_FORECAST_SAMPLES)
            .map(|f| ForecastV1 {
                session_type: f.session_type.raw(),
                time_offset_min: f.time_offset_min,
                weather: f.weather.raw(),
                track_temperature_c: f.track_temperature_c,
                air_temperature_c: f.air_temperature_c,
                rain_percentage: f.rain_percentage,
            })
            .collect(),
    }
}

fn time_trial_set(s: &TimeTrialSet) -> TimeTrialSetV1 {
    TimeTrialSetV1 {
        car_idx: s.car_idx,
        team_id: s.team_id.raw(),
        lap_time_ms: s.lap_time_ms,
        sector1_time_ms: s.sector1_time_ms,
        sector2_time_ms: s.sector2_time_ms,
        sector3_time_ms: s.sector3_time_ms,
        traction_control: s.traction_control,
        gearbox_assist: s.gearbox_assist,
        anti_lock_brakes: s.anti_lock_brakes,
        equal_car_performance: s.equal_car_performance,
        custom_setup: s.custom_setup,
        valid: s.valid,
    }
}

// ---------------------------------------------------------------- laps

/// Lap records by lap number, with Session History as the authority.
#[derive(Debug, Default)]
pub struct LapBook {
    laps: BTreeMap<u16, LapRecordV1>,
    positions: BTreeMap<u16, u8>,
    refs: LapsFileV1,
}

impl LapBook {
    /// Every completed lap in the packet replaces whatever was held for its
    /// number, including a provisional Lap Data record. An entry is
    /// complete when a later entry exists ("including current partial lap")
    /// or when it carries a lap time.
    pub fn apply_history(&mut self, packet: &SessionHistoryPacket, now_ms: u64) {
        self.refs.history_num_laps = Some(packet.num_laps);
        self.refs.best_lap_time_lap_num = Some(packet.best_lap_time_lap_num);
        self.refs.best_sector1_lap_num = Some(packet.best_sector1_lap_num);
        self.refs.best_sector2_lap_num = Some(packet.best_sector2_lap_num);
        self.refs.best_sector3_lap_num = Some(packet.best_sector3_lap_num);
        let count = packet.laps.len();
        for (index, lap) in packet.laps.iter().enumerate() {
            let complete = index + 1 < count || lap.lap_time_ms > 0;
            if !complete {
                continue;
            }
            let number = index as u16 + 1;
            let position_at_end = self.laps.get(&number).and_then(|held| held.position_at_end);
            let record = LapRecordV1 {
                lap_number: number,
                source: LapSource::SessionHistory,
                lap_time_ms: lap.lap_time_ms,
                sector1_ms: Some(lap.sector1.total_ms),
                sector2_ms: Some(lap.sector2.total_ms),
                sector3_ms: Some(lap.sector3.total_ms),
                valid_bit_flags: Some(lap.lap_valid_bit_flags),
                lap_valid: Some(lap.lap_valid),
                sector1_valid: Some(lap.sector1_valid),
                sector2_valid: Some(lap.sector2_valid),
                sector3_valid: Some(lap.sector3_valid),
                position_at_end,
                position_at_start: self.positions.get(&(number - 1)).copied(),
                recorded_at_monotonic_ms: self
                    .laps
                    .get(&number)
                    .filter(|held| held.source == LapSource::SessionHistory && held.same_facts(lap))
                    .map(|held| held.recorded_at_monotonic_ms)
                    .unwrap_or(now_ms),
            };
            self.laps.insert(number, record);
        }
    }

    /// Lap Data saw its lap counter advance from `previous` to `current`.
    /// Records `previous.current_lap_num` provisionally unless Session
    /// History already holds it; Session History will replace it.
    pub fn apply_lap_data_rollover(&mut self, previous: &LapData, current: &LapData, now_ms: u64) {
        let number = u16::from(previous.current_lap_num);
        if number == 0 || current.current_lap_num <= previous.current_lap_num {
            return;
        }
        if let Some(held) = self.laps.get_mut(&number) {
            // History's facts stand; Lap Data only adds where it saw the end.
            held.position_at_end.get_or_insert(previous.car_position);
            return;
        }
        let in_sector3 = previous.sector == Sector::Sector3;
        let reached_sector2 = in_sector3 || previous.sector == Sector::Sector2;
        self.laps.insert(
            number,
            LapRecordV1 {
                lap_number: number,
                source: LapSource::LapData,
                lap_time_ms: current.last_lap_time_ms,
                sector1_ms: reached_sector2.then_some(previous.sector1_time.total_ms),
                sector2_ms: in_sector3.then_some(previous.sector2_time.total_ms),
                sector3_ms: None,
                valid_bit_flags: None,
                lap_valid: match previous.current_lap_invalid {
                    LapValidity::Valid => Some(true),
                    LapValidity::Invalid => Some(false),
                    LapValidity::Unknown(_) => None,
                },
                sector1_valid: None,
                sector2_valid: None,
                sector3_valid: None,
                position_at_end: Some(previous.car_position),
                position_at_start: self.positions.get(&(number - 1)).copied(),
                recorded_at_monotonic_ms: now_ms,
            },
        );
    }

    pub fn apply_positions(&mut self, positions: &[lap_positions::LapPosition]) {
        for position in positions {
            self.positions.insert(position.lap_index, position.position);
            if let Some(lap) = self.laps.get_mut(&(position.lap_index + 1)) {
                lap.position_at_start = Some(position.position);
            }
        }
    }

    pub fn len(&self) -> usize {
        self.laps.len()
    }

    pub fn is_empty(&self) -> bool {
        self.laps.is_empty()
    }

    pub fn get(&self, lap_number: u16) -> Option<&LapRecordV1> {
        self.laps.get(&lap_number)
    }

    pub fn to_file(&self) -> LapsFileV1 {
        LapsFileV1 {
            schema_version: F1_SCHEMA_VERSION,
            laps: self.laps.values().cloned().collect(),
            lap_positions: self
                .positions
                .iter()
                .map(|(&lap_index, &position)| LapPositionV1 {
                    lap_index,
                    position,
                })
                .collect(),
            ..self.refs.clone()
        }
    }
}

impl LapRecordV1 {
    fn same_facts(&self, lap: &session_history::LapHistory) -> bool {
        self.lap_time_ms == lap.lap_time_ms
            && self.sector1_ms == Some(lap.sector1.total_ms)
            && self.sector2_ms == Some(lap.sector2.total_ms)
            && self.sector3_ms == Some(lap.sector3.total_ms)
            && self.valid_bit_flags == Some(lap.lap_valid_bit_flags)
    }
}

// ------------------------------------------------------- active session

struct Active {
    id: String,
    uid: u64,
    player: u8,
    directory: PathBuf,
    started_ms: u64,
    file: F1SessionFileV1,
    laps: LapBook,
    tyres: TyresFileV1,
    result: Option<ResultFileV1>,
    samples: Option<SampleStreamWriter>,
    events: Option<EventLogWriter>,
    /// The newest overall frame absorbed per (packet id, page).
    absorbed: HashMap<(u8, u8), u32>,
    /// The newest overall frame written to a sample, per packet id.
    sampled: HashMap<u8, u32>,
    last_damage_sample_ms: Option<u64>,
    sample_sequence: u64,
    previous_lap: Option<LapData>,
    in_grace: bool,
    ending: Option<(&'static str, u64)>,
    last_checkpoint_ms: u64,
    out_of_order_base: u64,
    write_error: Option<String>,
}

impl Active {
    fn elapsed(&self, now_ms: u64) -> u64 {
        now_ms.saturating_sub(self.started_ms)
    }

    fn fail(&mut self, error: io::Error) {
        self.write_error
            .get_or_insert_with(|| format!("F1 25 recording write failed: {error}"));
    }

    fn cover(&mut self, packet: &HeldPacket) {
        let id = packet.kind.id();
        let families = &mut self.file.f1_25.families;
        match families.iter_mut().find(|family| family.packet_id == id) {
            Some(family) => {
                family.observed_updates += 1;
                family.last_received_unix_ms = packet.received_unix_ms;
            }
            None => {
                families.push(FamilyCoverageV1 {
                    packet_id: id,
                    observed_updates: 1,
                    first_received_unix_ms: packet.received_unix_ms,
                    last_received_unix_ms: packet.received_unix_ms,
                });
                families.sort_by_key(|family| family.packet_id);
            }
        }
    }

    /// True the first time each (family, page, frame) is seen.
    fn is_new(&mut self, packet: &HeldPacket) -> bool {
        let page = if packet.kind == PacketKind::LapPositions {
            packet.bytes[lap_positions::POSITIONS_OFFSET - 1] / lap_positions::MAX_LAPS as u8
        } else {
            0
        };
        let frame = packet.header.overall_frame_identifier;
        let key = (packet.kind.id(), page);
        if self.absorbed.get(&key).is_some_and(|&held| held >= frame) {
            return false;
        }
        self.absorbed.insert(key, frame);
        self.cover(packet);
        true
    }

    fn store_event(&mut self, event: &HeldEvent, now_ms: u64, max_events: u64) {
        let Ok(code) =
            <[u8; 4]>::try_from(&event.bytes[event::DETAILS_OFFSET - 4..event::DETAILS_OFFSET])
        else {
            return;
        };
        let Ok(details) = <[u8; DETAILS_SIZE]>::try_from(&event.bytes[event::DETAILS_OFFSET..])
        else {
            return;
        };
        let signals = &mut self.file.f1_25.end_signals;
        match &code {
            b"BUTN" => {
                self.file.f1_25.integrity.button_events_ignored += 1;
                return;
            }
            b"SSTA" => signals.session_started_event = true,
            b"SEND" => {
                signals.session_ended_event = true;
                self.ending
                    .get_or_insert((completion::SESSION_ENDED_EVENT, now_ms));
            }
            b"CHQF" => signals.chequered_flag_event = true,
            _ => {}
        }
        let integrity = &mut self.file.f1_25.integrity;
        if integrity.events_stored >= max_events {
            integrity.events_over_cap += 1;
            return;
        }
        let stored = StoredEventV1 {
            sequence: integrity.events_stored,
            monotonic_ms: now_ms
                .saturating_sub(event.age_ms)
                .saturating_sub(self.started_ms),
            session_time: event.header.session_time,
            overall_frame_identifier: event.header.overall_frame_identifier,
            code: event::code_text(code),
            code_bytes: code,
            details_hex: f1_session::hex(&details),
        };
        let written = match self.events.as_mut() {
            Some(log) => log.write(&stored),
            None => Ok(()),
        };
        match written {
            Ok(()) => self.file.f1_25.integrity.events_stored += 1,
            Err(error) => self.fail(error),
        }
    }

    fn absorb(&mut self, view: &RecordingView, now_ms: u64) {
        for packet in &view.packets {
            if packet.header.session_uid != self.uid
                || packet.header.player_car_index != self.player
            {
                continue;
            }
            if !self.is_new(packet) {
                continue;
            }
            if self.file.f1_25.protocol.is_none() {
                self.file.f1_25.protocol = Some(F1ProtocolV1 {
                    packet_format: packet.header.packet_format,
                    game_year: packet.header.game_year,
                    game_major_version: packet.header.game_major_version,
                    game_minor_version: packet.header.game_minor_version,
                });
            }
            match packet.kind {
                PacketKind::Session => {
                    if let Some(s) = decoded(packet, session::decode) {
                        let context = session_context(packet, &s);
                        self.file
                            .f1_25
                            .context_at_start
                            .get_or_insert_with(|| context.clone());
                        self.file.f1_25.context_latest = Some(context);
                    }
                }
                PacketKind::Participants => {
                    if let Some(p) = decoded(packet, participants::decode) {
                        // The player's team facts only. Names and network
                        // ids are dropped here and never stored.
                        self.file.f1_25.participant = p.player.map(|player| ParticipantContextV1 {
                            num_active_cars: p.num_active_cars,
                            ai_controlled: player.ai_controlled,
                            team_id: player.team_id.raw(),
                            my_team: player.my_team,
                            race_number: player.race_number,
                        });
                    }
                }
                PacketKind::CarDamage => {
                    if let Some(damage) = decoded(packet, car_damage::decode).and_then(|d| d.player)
                    {
                        self.file.f1_25.damage_latest = Some(damage);
                    }
                }
                PacketKind::SessionHistory => {
                    if let Some(history) = decoded(packet, session_history::decode) {
                        if history.car_idx == self.player {
                            self.laps.apply_history(&history, self.elapsed(now_ms));
                            self.tyres.stints = history
                                .tyre_stints
                                .iter()
                                .map(|s| StintV1 {
                                    end_lap: s.end_lap,
                                    actual_compound: s.actual_compound.raw(),
                                    visual_compound: s.visual_compound.raw(),
                                })
                                .collect();
                        }
                    }
                }
                PacketKind::TyreSets => {
                    if let Some(sets) = decoded(packet, tyre_sets::decode) {
                        if sets.car_idx == self.player {
                            self.absorb_tyre_sets(packet, &sets, now_ms);
                        }
                    }
                }
                PacketKind::TimeTrial => {
                    if let Some(tt) = decoded(packet, time_trial::decode) {
                        self.file.f1_25.time_trial = Some(TimeTrialV1 {
                            received_unix_ms: packet.received_unix_ms,
                            player_session_best: time_trial_set(&tt.player_session_best),
                            personal_best: time_trial_set(&tt.personal_best),
                            rival: time_trial_set(&tt.rival),
                        });
                    }
                }
                PacketKind::LapPositions => {
                    if let Some(positions) = decoded(packet, lap_positions::decode) {
                        self.laps.apply_positions(&positions.player);
                    }
                }
                PacketKind::FinalClassification => {
                    if let Some(fc) = decoded(packet, final_classification::decode) {
                        self.file.f1_25.end_signals.final_classification = true;
                        if let Some(player) = fc.player {
                            self.result = Some(ResultFileV1 {
                                schema_version: F1_SCHEMA_VERSION,
                                received_unix_ms: packet.received_unix_ms,
                                num_cars: fc.num_cars,
                                player: ClassificationV1 {
                                    position: player.position,
                                    num_laps: player.num_laps,
                                    grid_position: player.grid_position,
                                    points: player.points,
                                    num_pit_stops: player.num_pit_stops,
                                    result_status: player.result_status.raw(),
                                    result_reason: player.result_reason.raw(),
                                    best_lap_time_ms: player.best_lap_time_ms,
                                    total_race_time_s: player.total_race_time_s,
                                    penalties_time_s: player.penalties_time_s,
                                    num_penalties: player.num_penalties,
                                    num_tyre_stints: player.num_tyre_stints,
                                    stints: player
                                        .tyre_stints
                                        .iter()
                                        .map(|s| StintV1 {
                                            end_lap: s.end_lap,
                                            actual_compound: s.actual_compound.raw(),
                                            visual_compound: s.visual_compound.raw(),
                                        })
                                        .collect(),
                                },
                            });
                        }
                        self.ending
                            .get_or_insert((completion::FINAL_CLASSIFICATION, now_ms));
                    }
                }
                PacketKind::LapData => {
                    if let Some(lap) = decoded(packet, lap_data::decode).and_then(|l| l.player) {
                        if let Some(previous) = self.previous_lap {
                            if lap.current_lap_num > previous.current_lap_num {
                                self.laps.apply_lap_data_rollover(
                                    &previous,
                                    &lap,
                                    self.elapsed(now_ms),
                                );
                            }
                        }
                        self.previous_lap = Some(lap);
                    }
                }
                _ => {}
            }
        }
        self.file.f1_25.integrity.lap_count = self.laps.len() as u64;
    }

    fn absorb_tyre_sets(&mut self, packet: &HeldPacket, sets: &TyreSetsPacket, now_ms: u64) {
        let previous = self.tyres.tyre_sets.as_ref().map(|s| s.fitted_idx);
        let snapshot = TyreSetsSnapshotV1 {
            received_unix_ms: packet.received_unix_ms,
            fitted_idx: sets.fitted_idx,
            sets: sets
                .sets
                .iter()
                .map(|s| TyreSetV1 {
                    actual_compound: s.actual_compound.raw(),
                    visual_compound: s.visual_compound.raw(),
                    wear_percent: s.wear_percent,
                    available: s.available,
                    recommended_session: s.recommended_session.raw(),
                    life_span_laps: s.life_span_laps,
                    usable_life_laps: s.usable_life_laps,
                    lap_delta_time_ms: s.lap_delta_time_ms,
                    fitted: s.fitted,
                })
                .collect(),
        };
        if previous != Some(sets.fitted_idx) && self.tyres.fitted_changes.len() < MAX_FITTED_CHANGES
        {
            let fitted = snapshot.sets.get(usize::from(sets.fitted_idx));
            self.tyres.fitted_changes.push(FittedChangeV1 {
                monotonic_ms: self.elapsed(now_ms),
                fitted_idx: sets.fitted_idx,
                actual_compound: fitted.map(|s| s.actual_compound),
                visual_compound: fitted.map(|s| s.visual_compound),
                lap_num: self.previous_lap.map(|lap| lap.current_lap_num),
            });
        }
        self.tyres.tyre_sets = Some(snapshot);
    }

    /// One sample from whichever player families hold something newer than
    /// the last sample took. Returns false when there was nothing new.
    fn sample(&mut self, view: &RecordingView, now_ms: u64) -> bool {
        let fresh = |kind: PacketKind| -> Option<&HeldPacket> {
            let packet = view.packet(kind)?;
            if packet.header.session_uid != self.uid
                || packet.header.player_car_index != self.player
            {
                return None;
            }
            let frame = packet.header.overall_frame_identifier;
            if self
                .sampled
                .get(&kind.id())
                .is_some_and(|&held| held >= frame)
            {
                return None;
            }
            Some(packet)
        };
        let telemetry = fresh(PacketKind::CarTelemetry).and_then(|p| {
            decoded(p, car_telemetry::decode)
                .and_then(|t| t.player)
                .map(|t| (p.header.overall_frame_identifier, telemetry_sample(p, &t)))
        });
        let status = fresh(PacketKind::CarStatus).and_then(|p| {
            decoded(p, car_status::decode)
                .and_then(|s| s.player)
                .map(|s| (p.header.overall_frame_identifier, status_sample(p, &s)))
        });
        let lap = fresh(PacketKind::LapData).and_then(|p| {
            decoded(p, lap_data::decode)
                .and_then(|l| l.player)
                .map(|l| (p.header.overall_frame_identifier, lap_sample(p, &l)))
        });
        let motion = fresh(PacketKind::MotionEx).and_then(|p| {
            decoded(p, motion_ex::decode)
                .and_then(|m| m.player)
                .map(|m| (p.header.overall_frame_identifier, motion_sample(p, &m)))
        });
        let damage_due = self.last_damage_sample_ms.is_none_or(|last| {
            now_ms.saturating_sub(last) >= f1_session::DAMAGE_SAMPLE_INTERVAL_MS
        });
        let damage: Option<(u32, CarDamage)> = if damage_due {
            fresh(PacketKind::CarDamage).and_then(|p| {
                decoded(p, car_damage::decode)
                    .and_then(|d| d.player)
                    .map(|d| (p.header.overall_frame_identifier, d))
            })
        } else {
            None
        };
        if telemetry.is_none()
            && status.is_none()
            && lap.is_none()
            && motion.is_none()
            && damage.is_none()
        {
            return false;
        }
        let mut mark = |kind: PacketKind, frame: Option<u32>| {
            if let Some(frame) = frame {
                self.sampled.insert(kind.id(), frame);
            }
        };
        mark(PacketKind::CarTelemetry, telemetry.map(|(f, _)| f));
        mark(PacketKind::CarStatus, status.map(|(f, _)| f));
        mark(PacketKind::LapData, lap.map(|(f, _)| f));
        mark(PacketKind::MotionEx, motion.map(|(f, _)| f));
        mark(PacketKind::CarDamage, damage.map(|(f, _)| f));
        if damage.is_some() {
            self.last_damage_sample_ms = Some(now_ms);
        }
        let sample = F1SampleV1 {
            sequence: self.sample_sequence,
            monotonic_ms: self.elapsed(now_ms),
            telemetry: telemetry.map(|(_, s)| s),
            status: status.map(|(_, s)| s),
            lap: lap.map(|(_, s)| s),
            motion: motion.map(|(_, s)| s),
            damage: damage.map(|(_, d)| d),
        };
        let written = match self.samples.as_mut() {
            Some(stream) => stream.write(&sample),
            None => Ok(()),
        };
        match written {
            Ok(()) => {
                self.sample_sequence += 1;
                self.file.f1_25.integrity.sample_count += 1;
            }
            Err(error) => self.fail(error),
        }
        true
    }

    fn sync_counts(&mut self, now_ms: u64, view_out_of_order: u64) {
        self.file.f1_25.duration_ms = self.elapsed(now_ms);
        self.file.f1_25.integrity.out_of_order_dropped =
            view_out_of_order.saturating_sub(self.out_of_order_base);
        self.file.f1_25.integrity.lap_count = self.laps.len() as u64;
    }

    fn write_side_files(&mut self) -> io::Result<()> {
        f1_session::write_json_atomically(
            &self.directory,
            f1_session::LAPS_FILE_NAME,
            &self.laps.to_file(),
        )?;
        f1_session::write_json_atomically(
            &self.directory,
            f1_session::TYRES_FILE_NAME,
            &self.tyres,
        )?;
        if let Some(result) = &self.result {
            f1_session::write_json_atomically(&self.directory, RESULT_FILE_NAME, result)?;
        }
        Ok(())
    }

    fn checkpoint(&mut self, now_ms: u64, out_of_order: u64) {
        self.sync_counts(now_ms, out_of_order);
        let flushed = (|| -> io::Result<()> {
            if let Some(samples) = self.samples.as_mut() {
                samples.flush()?;
            }
            if let Some(events) = self.events.as_mut() {
                events.flush()?;
            }
            self.write_side_files()?;
            f1_session::write_session(&self.directory, &self.file)
        })();
        if let Err(error) = flushed {
            self.fail(error);
        }
        self.last_checkpoint_ms = now_ms;
    }
}

// --------------------------------------------------------------- core

/// What the reader thread hands the core on every tick.
pub struct Tick {
    /// Monotonic milliseconds from any fixed origin.
    pub now_ms: u64,
    pub wall_ms: u64,
    /// Age of the latest accepted F1 datagram of any type.
    pub last_accepted_age_ms: Option<u64>,
    pub view: RecordingView,
}

struct Candidate {
    key: (u64, u8),
    since_ms: u64,
    events: Vec<HeldEvent>,
}

/// Session identity, lap authority, sampling and disk for F1 25. Driven by
/// `tick`; owns no thread, so tests drive it with synthetic packets and
/// time.
pub struct F1RecorderCore {
    root: PathBuf,
    config: F1RecorderConfig,
    enabled: bool,
    owner: Option<Arc<RecordingOwner>>,
    completion_hook: Option<Arc<dyn SessionCompletionHook>>,
    cursor: u64,
    last_tick_ms: Option<u64>,
    candidate: Option<Candidate>,
    /// UIDs the game ended, or that could not be recorded: never reopened.
    closed: VecDeque<u64>,
    /// The UID refused because FH6 held the slot when it became recordable.
    refused: Option<u64>,
    active: Option<Active>,
    status: F1RecorderStatus,
}

const MAX_CLOSED_UIDS: usize = 16;

impl F1RecorderCore {
    /// Runs the synchronous half of F1 recovery first, as the FH6 recorder
    /// does: a session left `recording` by a crash is never mistaken for the
    /// one about to start.
    pub fn new(root: PathBuf, enabled: bool, config: F1RecorderConfig) -> Result<Self, String> {
        fs::create_dir_all(&root)
            .map_err(|error| format!("Could not create the sessions directory: {error}"))?;
        let mut status = F1RecorderStatus::new(&root, enabled, config);
        if let Err(error) = f1_session::classify_interrupted_sessions(&root) {
            status.last_error = Some(error);
        }
        Ok(Self {
            root,
            config,
            enabled,
            owner: None,
            completion_hook: None,
            cursor: 0,
            last_tick_ms: None,
            candidate: None,
            closed: VecDeque::new(),
            refused: None,
            active: None,
            status,
        })
    }

    pub fn with_owner(mut self, owner: Arc<RecordingOwner>) -> Self {
        self.owner = Some(owner);
        self
    }

    pub fn with_completion_hook(mut self, hook: Arc<dyn SessionCompletionHook>) -> Self {
        self.completion_hook = Some(hook);
        self
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn status(&self) -> F1RecorderStatus {
        let mut status = self.status.clone();
        status.recording_owner = self
            .owner
            .as_ref()
            .and_then(|owner| owner.owner())
            .map(|owner| owner.game);
        status
    }

    pub fn event_cursor(&self) -> u64 {
        self.cursor
    }

    pub fn recording_session_id(&self) -> Option<&str> {
        self.active.as_ref().map(|active| active.id.as_str())
    }

    pub fn tick(&mut self, tick: Tick) {
        let Tick {
            now_ms,
            wall_ms,
            last_accepted_age_ms,
            view,
        } = tick;
        let late = self
            .last_tick_ms
            .is_some_and(|last| now_ms.saturating_sub(last) > self.config.sample_interval_ms * 2);
        self.last_tick_ms = Some(now_ms);
        // A restarted listener restarts the event sequence.
        if view.next_event_sequence < self.cursor {
            self.cursor = 0;
        }
        self.cursor = view.next_event_sequence;
        if !self.enabled {
            self.publish(None, now_ms);
            return;
        }

        // 1. Events belong to the session whose UID they carry.
        if let Some(active) = self.active.as_mut() {
            if late {
                active.file.f1_25.integrity.late_ticks += 1;
            }
            active.file.f1_25.integrity.events_missed += view.events_missed;
            for event in &view.events {
                if event.header.session_uid == active.uid {
                    active.store_event(event, now_ms, self.config.max_events);
                }
            }
        }

        // 2. Identity: a different UID or player ends the recording at once.
        let identity_end = match (self.active.as_ref(), view.key) {
            (Some(active), Some((uid, _))) if uid != 0 && uid != active.uid => {
                Some(completion::SESSION_UID_CHANGED)
            }
            (Some(active), Some((uid, player))) if uid == active.uid && player != active.player => {
                Some(completion::PLAYER_CAR_CHANGED)
            }
            _ => None,
        };
        if let Some(reason) = identity_end {
            self.finalize(reason, now_ms, wall_ms, view.out_of_order_dropped);
        }

        // 3. The recording continues: silence, data, samples, end, checkpoint.
        let mut end = None;
        if let Some(active) = self.active.as_mut() {
            let silent_for = last_accepted_age_ms.unwrap_or(u64::MAX);
            if silent_for >= self.config.grace_ms {
                end = Some(completion::TELEMETRY_LOST);
            } else {
                if silent_for > self.config.silence_ms {
                    active.in_grace = true;
                } else if active.in_grace {
                    active.in_grace = false;
                    active.file.f1_25.integrity.telemetry_gaps += 1;
                }
                active.absorb(&view, now_ms);
                if !active.sample(&view, now_ms) {
                    active.file.f1_25.integrity.idle_ticks += 1;
                }
                let settled = active.ending.filter(|&(_, since)| {
                    now_ms.saturating_sub(since) >= self.config.end_settle_ms
                });
                if active.write_error.is_some() {
                    end = Some(completion::RECORDER_WRITE_ERROR);
                } else if let Some((reason, _)) = settled {
                    end = Some(reason);
                } else if now_ms.saturating_sub(active.last_checkpoint_ms)
                    >= self.config.checkpoint_interval_ms
                {
                    active.checkpoint(now_ms, view.out_of_order_dropped);
                }
            }
        }
        if let Some(reason) = end {
            self.finalize(reason, now_ms, wall_ms, view.out_of_order_dropped);
        }

        // 4. Nothing recording: may this session start?
        let mut waiting = None;
        if self.active.is_none() {
            waiting = self.consider_start(&view, now_ms, wall_ms);
        }
        self.publish(waiting, now_ms);
    }

    fn consider_start(
        &mut self,
        view: &RecordingView,
        now_ms: u64,
        wall_ms: u64,
    ) -> Option<&'static str> {
        if let Some(reason) = self.blocker(view) {
            self.candidate = None;
            return Some(reason);
        }
        let key = view.key.expect("a blocker reports a missing key");
        // Events for the would-be session are held until it starts, so
        // "SSTA" is not lost to the confirmation window.
        let limit = self.config.max_pending_events;
        let mine = view
            .events
            .iter()
            .filter(|event| event.header.session_uid == key.0)
            .cloned();
        match self.candidate.as_mut() {
            Some(candidate) if candidate.key == key => {
                let room = limit.saturating_sub(candidate.events.len());
                candidate.events.extend(mine.take(room));
            }
            _ => {
                self.candidate = Some(Candidate {
                    key,
                    since_ms: now_ms,
                    events: mine.take(limit).collect(),
                });
            }
        }
        let since = self.candidate.as_ref().map_or(now_ms, |c| c.since_ms);
        if now_ms.saturating_sub(since) < self.config.start_confirm_ms {
            return Some(waiting::CONFIRMING);
        }
        let candidate = self.candidate.take().expect("present");
        self.start(candidate, view, now_ms, wall_ms)
    }

    /// The first start condition that does not hold, or `None`.
    fn blocker(&self, view: &RecordingView) -> Option<&'static str> {
        let Some((uid, player)) = view.key else {
            return Some(waiting::NO_PACKETS);
        };
        if uid == 0 {
            return Some(waiting::INVALID_SESSION_UID);
        }
        if usize::from(player) >= MAX_CARS {
            return Some(waiting::INVALID_PLAYER_INDEX);
        }
        if self.closed.contains(&uid) {
            return Some(waiting::SESSION_ALREADY_ENDED);
        }
        if self.refused == Some(uid) {
            return Some(waiting::ANOTHER_GAME_RECORDING);
        }
        let mine = |packet: &&HeldPacket| {
            packet.header.session_uid == uid && packet.header.player_car_index == player
        };
        let Some(session) = view
            .packet(PacketKind::Session)
            .filter(mine)
            .filter(|p| p.age_ms <= self.config.context_max_age_ms)
            .and_then(|p| decoded(p, session::decode))
        else {
            return Some(waiting::NO_SESSION_CONTEXT);
        };
        if session.session_type.raw() == 0 {
            return Some(waiting::SESSION_TYPE_UNKNOWN);
        }
        if session.is_spectating != 0 {
            return Some(waiting::SPECTATING);
        }
        let fresh_player = |kind: PacketKind| {
            view.packet(kind)
                .filter(mine)
                .filter(|p| p.age_ms <= self.config.player_fresh_ms)
                .is_some_and(|p| match kind {
                    PacketKind::CarTelemetry => {
                        decoded(p, car_telemetry::decode).is_some_and(|t| t.player.is_some())
                    }
                    _ => decoded(p, lap_data::decode).is_some_and(|l| l.player.is_some()),
                })
        };
        if !fresh_player(PacketKind::CarTelemetry) && !fresh_player(PacketKind::LapData) {
            return Some(waiting::PLAYER_NOT_FRESH);
        }
        None
    }

    fn close(&mut self, uid: u64) {
        if !self.closed.contains(&uid) {
            if self.closed.len() == MAX_CLOSED_UIDS {
                self.closed.pop_front();
            }
            self.closed.push_back(uid);
        }
    }

    fn start(
        &mut self,
        candidate: Candidate,
        view: &RecordingView,
        now_ms: u64,
        wall_ms: u64,
    ) -> Option<&'static str> {
        let (uid, player) = candidate.key;
        let id = new_session_id(wall_ms);
        if let Some(owner) = &self.owner {
            if !owner.claim(RecordingGame::F1_25, &id) {
                self.refused = Some(uid);
                self.status.sessions_refused_by_owner += 1;
                return Some(waiting::ANOTHER_GAME_RECORDING);
            }
        }
        let directory = self.root.join(&id);
        let file = F1SessionFileV1::new(id.clone(), uid, player, wall_ms);
        let opened = (|| -> io::Result<(SampleStreamWriter, EventLogWriter)> {
            fs::create_dir_all(&directory)?;
            let samples = SampleStreamWriter::create(
                &directory,
                &SampleStreamHeader {
                    stream_version: SAMPLE_STREAM_VERSION,
                    sample_schema_version: SAMPLE_SCHEMA_VERSION,
                    session_id: id.clone(),
                    started_at_unix_ms: wall_ms,
                },
            )?;
            let events = EventLogWriter::create(&directory)?;
            f1_session::write_session(&directory, &file)?;
            Ok((samples, events))
        })();
        let (samples, events) = match opened {
            Ok(writers) => writers,
            Err(error) => {
                if let Some(owner) = &self.owner {
                    owner.release(RecordingGame::F1_25, &id);
                }
                self.close(uid);
                self.status.last_error =
                    Some(format!("Could not open the F1 25 recording: {error}"));
                return Some(waiting::COULD_NOT_OPEN);
            }
        };
        let mut active = Active {
            id,
            uid,
            player,
            directory,
            started_ms: now_ms,
            file,
            laps: LapBook::default(),
            tyres: TyresFileV1::default(),
            result: None,
            samples: Some(samples),
            events: Some(events),
            absorbed: HashMap::new(),
            sampled: HashMap::new(),
            last_damage_sample_ms: None,
            sample_sequence: 0,
            previous_lap: None,
            in_grace: false,
            ending: None,
            last_checkpoint_ms: now_ms,
            out_of_order_base: view.out_of_order_dropped,
            write_error: None,
        };
        for event in &candidate.events {
            active.store_event(event, now_ms, self.config.max_events);
        }
        active.absorb(view, now_ms);
        active.sample(view, now_ms);
        active.checkpoint(now_ms, view.out_of_order_dropped);
        self.status.last_error = None;
        self.active = Some(active);
        None
    }

    fn finalize(&mut self, reason: &'static str, now_ms: u64, wall_ms: u64, out_of_order: u64) {
        let Some(mut active) = self.active.take() else {
            return;
        };
        active.sync_counts(now_ms, out_of_order);
        let duration_ms = active.file.f1_25.duration_ms;
        if let Some(samples) = active.samples.take() {
            if let Err(error) = samples.finish(SampleStreamEnd {
                sample_count: active.sample_sequence,
                duration_ms,
            }) {
                active.fail(error);
            }
        }
        if let Some(events) = active.events.take() {
            if let Err(error) = events.finish() {
                active.fail(error);
            }
        }
        if let Err(error) = active.write_side_files() {
            active.fail(error);
        }
        let reason = if active.write_error.is_some() {
            completion::RECORDER_WRITE_ERROR
        } else {
            reason
        };
        let envelope = &mut active.file.racelab_session;
        envelope.status = if completion::is_normal(reason) {
            SessionStatus::Completed
        } else {
            SessionStatus::Interrupted
        };
        envelope.completion_reason = Some(reason.to_string());
        envelope.ended_at_unix_ms = Some(
            envelope
                .started_at_unix_ms
                .map(|started| started.saturating_add(duration_ms))
                .unwrap_or(wall_ms),
        );
        active.file.f1_25.integrity.write_error = active.write_error.clone();
        let written = f1_session::write_session(&active.directory, &active.file);
        if let Some(owner) = &self.owner {
            owner.release(RecordingGame::F1_25, &active.id);
        }
        if matches!(
            reason,
            completion::SESSION_ENDED_EVENT
                | completion::FINAL_CLASSIFICATION
                | completion::RECORDER_WRITE_ERROR
        ) {
            self.close(active.uid);
        }
        let completed = active.file.racelab_session.status == SessionStatus::Completed;
        self.status.last_completed_session_id = Some(active.id.clone());
        self.status.last_completion_reason = Some(reason.to_string());
        if completed {
            self.status.completed_sessions += 1;
        }
        self.status.last_error = match (written, &active.write_error) {
            (Err(error), _) => Some(format!("Could not finalize the F1 25 session: {error}")),
            (Ok(()), Some(error)) => Some(error.clone()),
            (Ok(()), None) => None,
        };
        // Durable before anyone is told. The hook only ever asks retention
        // to reconsider the budget.
        if let Some(hook) = &self.completion_hook {
            hook.session_completed(&active.id, &active.directory);
        }
    }

    /// Ends any recording as `racelab_shutdown`: interrupted, never a normal
    /// finish, with every file closed cleanly.
    pub fn shutdown(&mut self, now_ms: u64, wall_ms: u64) {
        self.finalize(completion::RACELAB_SHUTDOWN, now_ms, wall_ms, 0);
        self.publish(None, now_ms);
    }

    fn publish(&mut self, waiting_reason: Option<&'static str>, now_ms: u64) {
        let status = &mut self.status;
        status.revision += 1;
        status.enabled = self.enabled;
        status.waiting_reason = if self.enabled { waiting_reason } else { None };
        match self.active.as_ref() {
            Some(active) => {
                status.phase = if active.ending.is_some() {
                    RecorderPhase::Ending
                } else if active.in_grace {
                    RecorderPhase::Grace
                } else {
                    RecorderPhase::Recording
                };
                status.recording = true;
                status.session_id = Some(active.id.clone());
                status.session_uid = Some(active.uid.to_string());
                status.started_at_unix_ms = active.file.racelab_session.started_at_unix_ms;
                status.duration_ms = active.elapsed(now_ms);
                status.samples_written = active.file.f1_25.integrity.sample_count;
                status.events_stored = active.file.f1_25.integrity.events_stored;
                status.laps = active.laps.len() as u64;
                status.ending_reason = active.ending.map(|(reason, _)| reason);
                status.grace_remaining_ms = None;
                let context = active.file.f1_25.context_latest.as_ref();
                status.track_label = context.and_then(|c| {
                    crate::adapters::f1_25::codes::TrackId::from_raw(c.track_id).label()
                });
                status.session_type_label = context.and_then(|c| {
                    crate::adapters::f1_25::codes::SessionType::from_raw(c.session_type).label()
                });
            }
            None => {
                status.phase = if !self.enabled {
                    RecorderPhase::Disabled
                } else if self.candidate.is_some() {
                    RecorderPhase::Candidate
                } else {
                    RecorderPhase::Idle
                };
                status.recording = false;
                status.session_id = None;
                status.session_uid = None;
                status.started_at_unix_ms = None;
                status.duration_ms = 0;
                status.samples_written = 0;
                status.events_stored = 0;
                status.laps = 0;
                status.ending_reason = None;
                status.grace_remaining_ms = None;
                status.track_label = None;
                status.session_type_label = None;
            }
        }
    }

    /// Grace remaining, for the status, from the latest packet age.
    fn grace_remaining(&self, last_accepted_age_ms: Option<u64>) -> Option<u64> {
        let active = self.active.as_ref()?;
        active.in_grace.then(|| {
            self.config
                .grace_ms
                .saturating_sub(last_accepted_age_ms.unwrap_or(0))
        })
    }
}

/// `f1-<start ms>-<8 hex>`: RaceLab's own id, never the game's.
fn new_session_id(wall_ms: u64) -> String {
    let mut random = [0u8; 4];
    let _ = getrandom::fill(&mut random);
    format!(
        "f1-{wall_ms}-{}",
        random
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}

// ------------------------------------------------------------- service

/// Owns the reader thread. The core lives on that thread alone; commands
/// read only the published status.
pub struct F1RecorderService {
    root: PathBuf,
    status: Arc<Mutex<F1RecorderStatus>>,
    owner: OnceLock<Arc<RecordingOwner>>,
    stop: mpsc::SyncSender<()>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl F1RecorderService {
    pub fn start(
        source: Arc<F1EvidenceService>,
        core: F1RecorderCore,
    ) -> Result<Arc<Self>, String> {
        let root = core.root().to_path_buf();
        let interval = Duration::from_millis(core.config.sample_interval_ms.max(10));
        let owner = OnceLock::new();
        if let Some(arbiter) = &core.owner {
            let _ = owner.set(Arc::clone(arbiter));
        }
        let status = Arc::new(Mutex::new(core.status()));
        let (stop, stopped) = mpsc::sync_channel(1);
        let shared = Arc::clone(&status);
        let worker = thread::Builder::new()
            .name("f1-session-recorder".into())
            .spawn(move || {
                let mut core = core;
                let origin = Instant::now();
                let now = || origin.elapsed().as_millis() as u64;
                loop {
                    match stopped.recv_timeout(interval) {
                        Err(RecvTimeoutError::Timeout) => {}
                        Ok(()) | Err(RecvTimeoutError::Disconnected) => {
                            core.shutdown(now(), f1_session::unix_ms());
                            *lock(&shared) = core.status();
                            return;
                        }
                    }
                    let (age, view) = if core.enabled {
                        source.recording_view(core.event_cursor())
                    } else {
                        (None, RecordingView::default())
                    };
                    core.tick(Tick {
                        now_ms: now(),
                        wall_ms: f1_session::unix_ms(),
                        last_accepted_age_ms: age,
                        view,
                    });
                    let mut status = core.status();
                    status.grace_remaining_ms = core.grace_remaining(age);
                    *lock(&shared) = status;
                }
            })
            .map_err(|error| format!("Could not start the F1 25 recorder: {error}"))?;
        Ok(Arc::new(Self {
            root,
            status,
            owner,
            stop,
            worker: Mutex::new(Some(worker)),
        }))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn status(&self) -> F1RecorderStatus {
        let mut status = lock(&self.status).clone();
        status.recording_owner = self
            .owner
            .get()
            .and_then(|owner| owner.owner())
            .map(|owner| owner.game);
        status
    }

    /// Finalizes any recording as `racelab_shutdown` and joins the thread.
    pub fn shutdown(&self) {
        let _ = self.stop.try_send(());
        if let Some(worker) = lock(&self.worker).take() {
            let _ = worker.join();
        }
    }
}

impl Drop for F1RecorderService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// The F1 25 session being recorded is never deleted by retention.
impl SessionProtection for F1RecorderService {
    fn is_protected(&self, session_id: &str) -> bool {
        lock(&self.status).session_id.as_deref() == Some(session_id)
    }

    fn protection_reason(&self) -> &'static str {
        "being recorded"
    }
}
