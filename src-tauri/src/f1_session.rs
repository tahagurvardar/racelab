//! F1 25 session storage, V2.0 Phase D. See docs/V2.0-PHASE-D-F1-RECORDING.md.
//!
//! An F1 25 session is a directory under the same sessions root as FH6, so
//! one storage budget, one listing and one retention policy cover both games.
//! It never contains an FH6 `manifest.json` and FH6 code never reads it as
//! one: the two games share the multi-game envelope below and nothing else.
//!
//! ```text
//! sessions/<racelab session id>/
//!   session.json   envelope + F1 metadata, integrity counts, recovery (atomic)
//!   samples.rlf1   10 Hz latest-value samples, length-prefixed MessagePack
//!   events.jsonl   one decoded-on-read event per line, append-only
//!   laps.json      lap records, best-lap references, lap positions (atomic)
//!   tyres.json     tyre stints and tyre sets (atomic)
//!   result.json    the player's final classification, when one arrived (atomic)
//! ```
//!
//! Rules:
//! - **Raw values on disk.** Every coded field is stored as its wire number;
//!   specification labels are attached when a session is read, never written.
//!   Events are stored as their four code bytes and twelve detail bytes and
//!   decoded on read by the same decoder the live path uses.
//! - **No raw datagram dumps.** Samples are typed subsets at a documented
//!   cadence; context families are typed and bounded.
//! - **Two identities.** `racelab_session.session_id` is RaceLab's own
//!   directory name. `game_session_identity` is F1's `sessionUID`, as sent.
//!   Neither is ever derived from the other.
//! - **Privacy.** No participant name or network id is ever written; the
//!   only participant facts kept are the player's team, race number, "my
//!   team" flag and AI flag, and the active car count.
use crate::{
    adapters::f1_25::{
        car_damage::CarDamage,
        codes::{
            ActualTyreCompound, Formula, GameMode, NetworkGame, ResultReason, ResultStatus,
            RuleSet, SafetyCarStatus, SessionType, TeamId, TrackId, VisualTyreCompound, Weather,
        },
        event::{self, EventDetails},
        PacketKind,
    },
    session_format::{self, invalid, RecoveryOutcome, SessionManifestV1, SessionStatus},
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufRead, BufReader, BufWriter, Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub const SESSION_FILE_NAME: &str = "session.json";
pub const SAMPLES_FILE_NAME: &str = "samples.rlf1";
pub const EVENTS_FILE_NAME: &str = "events.jsonl";
pub const LAPS_FILE_NAME: &str = "laps.json";
pub const TYRES_FILE_NAME: &str = "tyres.json";
pub const RESULT_FILE_NAME: &str = "result.json";

/// The multi-game envelope's own version.
pub const ENVELOPE_VERSION: u32 = 1;
/// `session.json`'s F1 half, and every F1 side file.
pub const F1_SCHEMA_VERSION: u32 = 1;
/// Sample stream container framing.
pub const SAMPLE_STREAM_VERSION: u32 = 1;
/// `F1SampleV1`.
pub const SAMPLE_SCHEMA_VERSION: u32 = 1;
/// The documented sample cadence: one latest-value sample per 100 ms.
pub const SAMPLE_RATE_HZ: u32 = 10;
/// Damage is folded into one sample per second, not ten.
pub const DAMAGE_SAMPLE_INTERVAL_MS: u64 = 1000;
pub const MAX_FORECAST_SAMPLES: usize = 8;
/// Bounds the sample reader on a corrupt length.
pub const MAX_SAMPLE_RECORD_BYTES: usize = 64 * 1024;
/// Events returned to the UI for one session. The file may hold more; the
/// view says how many it left out.
pub const MAX_DETAIL_EVENTS: usize = 2000;
/// Bounds one startup sweep's directory work, matching `session_store`.
pub const MAX_SCANNED_DIRECTORIES: usize = 2000;

const SAMPLE_MAGIC: &[u8; 8] = b"RLF1SMP\0";
const RECORD_TAG: u8 = 1;
const END_TAG: u8 = 2;

pub fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

// ------------------------------------------------------------- envelope

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionGame {
    Fh6,
    F1_25,
}

/// The game's own name for its session, kept apart from RaceLab's id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GameSessionIdentity {
    /// `f1_session_uid` for F1 25. FH6 has no protocol session identity.
    pub kind: String,
    /// Decimal string: a uint64 does not survive a JavaScript number.
    pub value: String,
}

/// What every RaceLab session is, whichever game recorded it. FH6 sessions
/// are described by one on read (`from_fh6`); their V1 manifests are never
/// rewritten to carry it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RaceLabSessionEnvelope {
    pub envelope_version: u32,
    pub session_id: String,
    pub game: SessionGame,
    pub status: SessionStatus,
    pub started_at_unix_ms: Option<u64>,
    pub ended_at_unix_ms: Option<u64>,
    pub completion_reason: Option<String>,
    pub game_session_identity: Option<GameSessionIdentity>,
    pub created_by_racelab_version: String,
}

impl RaceLabSessionEnvelope {
    pub fn from_fh6(manifest: &SessionManifestV1) -> Self {
        Self {
            envelope_version: ENVELOPE_VERSION,
            session_id: manifest.session_id.clone(),
            game: SessionGame::Fh6,
            status: manifest.status,
            started_at_unix_ms: manifest.started_at_unix_ms,
            ended_at_unix_ms: manifest.ended_at_unix_ms,
            completion_reason: manifest.completion_reason.clone(),
            game_session_identity: None,
            created_by_racelab_version: manifest.created_by_racelab_version.clone(),
        }
    }
}

/// Reads whichever session a directory holds, as an envelope. FH6 first,
/// exactly as V1.1 reads it; then F1 25.
pub fn read_envelope(directory: &Path) -> Option<RaceLabSessionEnvelope> {
    if let Ok(manifest) = session_format::read_manifest(directory) {
        return Some(RaceLabSessionEnvelope::from_fh6(&manifest));
    }
    read_session(directory)
        .ok()
        .map(|file| file.racelab_session)
}

// ------------------------------------------------------- F1 completion

/// Why an F1 25 recording ended. Stored as these exact strings.
pub mod completion {
    /// The game's `sessionUID` changed: a different F1 session began.
    pub const SESSION_UID_CHANGED: &str = "session_uid_changed";
    /// "SEND" arrived, then the settle window elapsed.
    pub const SESSION_ENDED_EVENT: &str = "session_ended_event";
    /// Final Classification arrived, then the settle window elapsed.
    pub const FINAL_CLASSIFICATION: &str = "final_classification";
    /// No F1 packet for the whole grace period.
    pub const TELEMETRY_LOST: &str = "telemetry_lost";
    /// `playerCarIndex` changed within the session.
    pub const PLAYER_CAR_CHANGED: &str = "player_car_changed";
    /// RaceLab was closed while recording. Status: interrupted.
    pub const RACELAB_SHUTDOWN: &str = "racelab_shutdown";
    /// A file could not be written. Status: interrupted.
    pub const RECORDER_WRITE_ERROR: &str = "recorder_write_error";
    /// Found still `recording` at startup. Status: interrupted.
    pub const INTERRUPTED: &str = "interrupted_racelab_did_not_finalize";

    /// Ends that leave the session `completed`. Anything else is
    /// `interrupted`.
    pub fn is_normal(reason: &str) -> bool {
        matches!(
            reason,
            SESSION_UID_CHANGED
                | SESSION_ENDED_EVENT
                | FINAL_CLASSIFICATION
                | TELEMETRY_LOST
                | PLAYER_CAR_CHANGED
        )
    }
}

// ----------------------------------------------------- persisted context

/// The protocol this session was recorded from, from the packet headers.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct F1ProtocolV1 {
    pub packet_format: u16,
    pub game_year: u8,
    pub game_major_version: u8,
    pub game_minor_version: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ForecastV1 {
    pub session_type: u8,
    pub time_offset_min: u8,
    pub weather: u8,
    pub track_temperature_c: i8,
    pub air_temperature_c: i8,
    pub rain_percentage: u8,
}

/// A bounded, raw-valued subset of the Session packet.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionContextV1 {
    pub received_unix_ms: u64,
    pub session_time: f32,
    pub weather: u8,
    pub track_temperature_c: i8,
    pub air_temperature_c: i8,
    pub total_laps: u8,
    pub track_length_m: u16,
    pub session_type: u8,
    pub track_id: i8,
    pub formula: u8,
    pub session_time_left_s: u16,
    pub session_duration_s: u16,
    pub pit_speed_limit_kmh: u8,
    pub game_paused: u8,
    pub is_spectating: u8,
    pub safety_car_status: u8,
    pub network_game: u8,
    pub ai_difficulty: u8,
    pub game_mode: u8,
    pub rule_set: u8,
    pub num_safety_car_periods: u8,
    pub num_virtual_safety_car_periods: u8,
    pub num_red_flag_periods: u8,
    pub sector2_lap_distance_start_m: f32,
    pub sector3_lap_distance_start_m: f32,
    pub num_weather_forecast_samples: u8,
    /// The first `MAX_FORECAST_SAMPLES` forecast samples only.
    pub forecast: Vec<ForecastV1>,
}

/// The player's participant facts, and nothing about anybody else.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ParticipantContextV1 {
    pub num_active_cars: u8,
    pub ai_controlled: u8,
    pub team_id: u8,
    pub my_team: u8,
    pub race_number: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TimeTrialSetV1 {
    pub car_idx: u8,
    pub team_id: u8,
    pub lap_time_ms: u32,
    pub sector1_time_ms: u32,
    pub sector2_time_ms: u32,
    pub sector3_time_ms: u32,
    pub traction_control: u8,
    pub gearbox_assist: u8,
    pub anti_lock_brakes: u8,
    pub equal_car_performance: u8,
    pub custom_setup: u8,
    pub valid: u8,
}

/// The three Time Trial sets, never merged with each other or with the
/// player's own telemetry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TimeTrialV1 {
    pub received_unix_ms: u64,
    pub player_session_best: TimeTrialSetV1,
    pub personal_best: TimeTrialSetV1,
    pub rival: TimeTrialSetV1,
}

/// Which packet families contributed, and when. Counts are distinct packets
/// seen by the 10 Hz reader, not every datagram the game sent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FamilyCoverageV1 {
    pub packet_id: u8,
    pub observed_updates: u64,
    pub first_received_unix_ms: u64,
    pub last_received_unix_ms: u64,
}

/// End signals the game sent, as facts. The completion reason says which
/// one ended the recording; these say which ones were seen at all.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct EndSignalsV1 {
    pub session_started_event: bool,
    pub session_ended_event: bool,
    pub chequered_flag_event: bool,
    pub final_classification: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct IntegrityV1 {
    pub sample_count: u64,
    /// Reader ticks with no new player data (paused, loading, silent).
    pub idle_ticks: u64,
    /// Reader ticks that ran more than one interval late.
    pub late_ticks: u64,
    pub events_stored: u64,
    /// Events beyond the per-session cap, counted and not stored.
    pub events_over_cap: u64,
    /// Events the bounded ring overwrote before the recorder read them.
    pub events_missed: u64,
    /// "BUTN" events: controller input, not session facts. Counted only.
    pub button_events_ignored: u64,
    /// Out-of-order datagrams the aggregator dropped during this session.
    pub out_of_order_dropped: u64,
    /// Silences longer than the silence threshold that later resumed.
    pub telemetry_gaps: u64,
    pub lap_count: u64,
    pub write_error: Option<String>,
}

/// What a recovery scan found in an interrupted F1 recording. Files are
/// read, never repaired.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct F1RecoveryV1 {
    pub outcome: RecoveryOutcome,
    pub scanned_at_unix_ms: Option<u64>,
    pub readable_samples: u64,
    pub sample_stream_complete: bool,
    pub unreadable_sample_tail_bytes: u64,
    pub readable_events: u64,
    /// A final event line that was cut off part-way.
    pub event_tail_discarded: bool,
    pub laps_readable: bool,
    pub tyres_readable: bool,
    pub result_readable: Option<bool>,
    pub detail: Option<String>,
    pub recovered_by_racelab_version: String,
}

impl F1RecoveryV1 {
    pub fn pending() -> Self {
        Self {
            outcome: RecoveryOutcome::Pending,
            scanned_at_unix_ms: None,
            readable_samples: 0,
            sample_stream_complete: false,
            unreadable_sample_tail_bytes: 0,
            readable_events: 0,
            event_tail_discarded: false,
            laps_readable: false,
            tyres_readable: false,
            result_readable: None,
            detail: None,
            recovered_by_racelab_version: env!("CARGO_PKG_VERSION").into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct F1MetadataV1 {
    pub schema_version: u32,
    pub protocol: Option<F1ProtocolV1>,
    pub session_uid: String,
    pub player_car_index: u8,
    /// Monotonic recording span.
    pub duration_ms: u64,
    pub sample_rate_hz: u32,
    pub sample_schema_version: u32,
    pub context_at_start: Option<SessionContextV1>,
    pub context_latest: Option<SessionContextV1>,
    pub participant: Option<ParticipantContextV1>,
    pub time_trial: Option<TimeTrialV1>,
    /// The latest player damage packet. Earlier values are in the samples
    /// at one per second.
    pub damage_latest: Option<CarDamage>,
    pub end_signals: EndSignalsV1,
    pub families: Vec<FamilyCoverageV1>,
    pub integrity: IntegrityV1,
    pub recovery: Option<F1RecoveryV1>,
}

/// `session.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct F1SessionFileV1 {
    pub racelab_session: RaceLabSessionEnvelope,
    pub f1_25: F1MetadataV1,
}

impl F1SessionFileV1 {
    pub fn new(
        session_id: String,
        session_uid: u64,
        player_car_index: u8,
        started_at: u64,
    ) -> Self {
        Self {
            racelab_session: RaceLabSessionEnvelope {
                envelope_version: ENVELOPE_VERSION,
                session_id,
                game: SessionGame::F1_25,
                status: SessionStatus::Recording,
                started_at_unix_ms: Some(started_at),
                ended_at_unix_ms: None,
                completion_reason: None,
                game_session_identity: Some(GameSessionIdentity {
                    kind: "f1_session_uid".into(),
                    value: session_uid.to_string(),
                }),
                created_by_racelab_version: env!("CARGO_PKG_VERSION").into(),
            },
            f1_25: F1MetadataV1 {
                schema_version: F1_SCHEMA_VERSION,
                protocol: None,
                session_uid: session_uid.to_string(),
                player_car_index,
                duration_ms: 0,
                sample_rate_hz: SAMPLE_RATE_HZ,
                sample_schema_version: SAMPLE_SCHEMA_VERSION,
                context_at_start: None,
                context_latest: None,
                participant: None,
                time_trial: None,
                damage_latest: None,
                end_signals: EndSignalsV1::default(),
                families: Vec::new(),
                integrity: IntegrityV1::default(),
                recovery: None,
            },
        }
    }
}

// ------------------------------------------------------------ laps file

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LapSource {
    /// Session History: the authority for completed laps.
    SessionHistory,
    /// Lap Data at the moment the lap counter advanced. Provisional: used
    /// only for a lap Session History never described, and replaced as soon
    /// as it does.
    LapData,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LapRecordV1 {
    /// 1-based.
    pub lap_number: u16,
    pub source: LapSource,
    /// As sent. 0 means the game sent no time.
    pub lap_time_ms: u32,
    pub sector1_ms: Option<u32>,
    pub sector2_ms: Option<u32>,
    /// Session History only; never derived from the lap time.
    pub sector3_ms: Option<u32>,
    /// Session History's raw `m_lapValidBitFlags`.
    pub valid_bit_flags: Option<u8>,
    /// From the flags for Session History; for Lap Data, the inverse of the
    /// last `m_currentLapInvalid` seen before the lap counter advanced.
    pub lap_valid: Option<bool>,
    pub sector1_valid: Option<bool>,
    pub sector2_valid: Option<bool>,
    pub sector3_valid: Option<bool>,
    /// Lap Data `m_carPosition` on the last reading before the counter
    /// advanced.
    pub position_at_end: Option<u8>,
    /// Lap Positions: position at the start of this lap (lap index
    /// `lap_number - 1`).
    pub position_at_start: Option<u8>,
    pub recorded_at_monotonic_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LapPositionV1 {
    pub lap_index: u16,
    pub position: u8,
}

/// `laps.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LapsFileV1 {
    pub schema_version: u32,
    pub laps: Vec<LapRecordV1>,
    /// Session History's references, raw lap numbers as sent.
    pub best_lap_time_lap_num: Option<u8>,
    pub best_sector1_lap_num: Option<u8>,
    pub best_sector2_lap_num: Option<u8>,
    pub best_sector3_lap_num: Option<u8>,
    /// Session History's latest `m_numLaps` ("including current partial
    /// lap").
    pub history_num_laps: Option<u8>,
    /// The player's Lap Positions column, merged across pages.
    pub lap_positions: Vec<LapPositionV1>,
}

impl Default for LapsFileV1 {
    fn default() -> Self {
        Self {
            schema_version: F1_SCHEMA_VERSION,
            laps: Vec::new(),
            best_lap_time_lap_num: None,
            best_sector1_lap_num: None,
            best_sector2_lap_num: None,
            best_sector3_lap_num: None,
            history_num_laps: None,
            lap_positions: Vec::new(),
        }
    }
}

// ----------------------------------------------------------- tyres file

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct StintV1 {
    /// 255 is "of current tyre".
    pub end_lap: u8,
    pub actual_compound: u8,
    pub visual_compound: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TyreSetV1 {
    pub actual_compound: u8,
    pub visual_compound: u8,
    pub wear_percent: u8,
    pub available: u8,
    pub recommended_session: u8,
    pub life_span_laps: u8,
    pub usable_life_laps: u8,
    pub lap_delta_time_ms: i16,
    pub fitted: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TyreSetsSnapshotV1 {
    pub received_unix_ms: u64,
    pub fitted_idx: u8,
    pub sets: Vec<TyreSetV1>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct FittedChangeV1 {
    pub monotonic_ms: u64,
    pub fitted_idx: u8,
    pub actual_compound: Option<u8>,
    pub visual_compound: Option<u8>,
    /// Lap Data `m_currentLapNum` at the time, when known.
    pub lap_num: Option<u8>,
}

pub const MAX_FITTED_CHANGES: usize = 64;

/// `tyres.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TyresFileV1 {
    pub schema_version: u32,
    /// Session History's stint list, latest.
    pub stints: Vec<StintV1>,
    pub tyre_sets: Option<TyreSetsSnapshotV1>,
    pub fitted_changes: Vec<FittedChangeV1>,
}

impl Default for TyresFileV1 {
    fn default() -> Self {
        Self {
            schema_version: F1_SCHEMA_VERSION,
            stints: Vec::new(),
            tyre_sets: None,
            fitted_changes: Vec::new(),
        }
    }
}

// ---------------------------------------------------------- result file

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClassificationV1 {
    pub position: u8,
    pub num_laps: u8,
    pub grid_position: u8,
    pub points: u8,
    pub num_pit_stops: u8,
    pub result_status: u8,
    pub result_reason: u8,
    pub best_lap_time_ms: u32,
    pub total_race_time_s: f64,
    pub penalties_time_s: u8,
    pub num_penalties: u8,
    pub num_tyre_stints: u8,
    pub stints: Vec<StintV1>,
}

/// `result.json`: the player's row only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResultFileV1 {
    pub schema_version: u32,
    pub received_unix_ms: u64,
    pub num_cars: u8,
    pub player: ClassificationV1,
}

// ------------------------------------------------------------- samples

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct FamilyStampV1 {
    pub overall_frame_identifier: u32,
    pub session_time: f32,
    /// How old the packet was when it was sampled.
    pub age_ms: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct WheelsV1<T> {
    pub rl: T,
    pub rr: T,
    pub fl: T,
    pub fr: T,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct TelemetrySampleV1 {
    pub stamp: FamilyStampV1,
    pub speed_kmh: u16,
    pub throttle: f32,
    pub brake: f32,
    pub steer: f32,
    pub clutch: u8,
    pub gear: i8,
    pub engine_rpm: u16,
    pub drs: u8,
    pub engine_temperature_c: u16,
    pub brakes_temperature_c: WheelsV1<u16>,
    pub tyres_surface_temperature_c: WheelsV1<u8>,
    pub tyres_inner_temperature_c: WheelsV1<u8>,
    pub tyres_pressure_psi: WheelsV1<f32>,
    pub surface_type: WheelsV1<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct StatusSampleV1 {
    pub stamp: FamilyStampV1,
    pub fuel_mix: u8,
    pub front_brake_bias_percent: u8,
    pub pit_limiter_status: u8,
    pub fuel_in_tank: f32,
    pub fuel_remaining_laps: f32,
    pub drs_allowed: u8,
    pub drs_activation_distance_m: u16,
    pub actual_tyre_compound: u8,
    pub visual_tyre_compound: u8,
    pub tyres_age_laps: u8,
    pub vehicle_fia_flags: i8,
    pub ers_store_energy_j: f32,
    pub ers_deploy_mode: u8,
    pub ers_harvested_this_lap_mguk: f32,
    pub ers_harvested_this_lap_mguh: f32,
    pub ers_deployed_this_lap: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LapSampleV1 {
    pub stamp: FamilyStampV1,
    pub current_lap_num: u8,
    pub current_lap_time_ms: u32,
    pub last_lap_time_ms: u32,
    pub sector1_ms: u32,
    pub sector2_ms: u32,
    pub lap_distance_m: f32,
    pub total_distance_m: f32,
    pub car_position: u8,
    pub sector: u8,
    pub current_lap_invalid: u8,
    pub pit_status: u8,
    pub num_pit_stops: u8,
    pub penalties_s: u8,
    pub driver_status: u8,
    pub result_status: u8,
    pub safety_car_delta_s: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct MotionSampleV1 {
    pub stamp: FamilyStampV1,
    pub local_velocity_mps: [f32; 3],
    pub angular_velocity_rad_s: [f32; 3],
    pub front_wheels_angle_rad: f32,
    pub wheel_slip_ratio: WheelsV1<f32>,
    pub wheel_slip_angle: WheelsV1<f32>,
    pub chassis_yaw_rad: f32,
    pub chassis_pitch_rad: f32,
}

/// One 10 Hz latest-value sample. A family appears only when it holds a
/// packet newer than the one the previous sample took from it, so a stalled
/// family is never repeated; damage appears at most once a second.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct F1SampleV1 {
    pub sequence: u64,
    /// Milliseconds since the recording started, monotonic.
    pub monotonic_ms: u64,
    pub telemetry: Option<TelemetrySampleV1>,
    pub status: Option<StatusSampleV1>,
    pub lap: Option<LapSampleV1>,
    pub motion: Option<MotionSampleV1>,
    pub damage: Option<CarDamage>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SampleStreamHeader {
    pub stream_version: u32,
    pub sample_schema_version: u32,
    pub session_id: String,
    pub started_at_unix_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SampleStreamEnd {
    pub sample_count: u64,
    pub duration_ms: u64,
}

pub struct SampleStreamWriter {
    writer: BufWriter<File>,
}

impl SampleStreamWriter {
    pub fn create(directory: &Path, header: &SampleStreamHeader) -> io::Result<Self> {
        if !session_format::is_safe_session_id(&header.session_id) {
            return Err(invalid("Unsupported session identifier"));
        }
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(directory.join(SAMPLES_FILE_NAME))?;
        let mut writer = BufWriter::new(file);
        writer.write_all(SAMPLE_MAGIC)?;
        writer.write_all(&header.stream_version.to_le_bytes())?;
        writer.write_all(&header.sample_schema_version.to_le_bytes())?;
        writer.write_all(&(header.session_id.len() as u32).to_le_bytes())?;
        writer.write_all(&header.started_at_unix_ms.to_le_bytes())?;
        writer.write_all(header.session_id.as_bytes())?;
        writer.flush()?;
        Ok(Self { writer })
    }

    pub fn write(&mut self, sample: &F1SampleV1) -> io::Result<()> {
        let payload = rmp_serde::to_vec_named(sample)
            .map_err(|error| invalid(format!("Could not encode sample: {error}")))?;
        if payload.len() > MAX_SAMPLE_RECORD_BYTES {
            return Err(invalid("Encoded sample exceeds the record limit"));
        }
        self.writer.write_all(&[RECORD_TAG])?;
        self.writer
            .write_all(&(payload.len() as u32).to_le_bytes())?;
        self.writer.write_all(&payload)
    }

    pub fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }

    pub fn finish(mut self, end: SampleStreamEnd) -> io::Result<()> {
        self.writer.write_all(&[END_TAG])?;
        self.writer.write_all(&end.sample_count.to_le_bytes())?;
        self.writer.write_all(&end.duration_ms.to_le_bytes())?;
        self.writer.flush()?;
        self.writer.get_ref().sync_all()
    }
}

fn read_array<const N: usize>(reader: &mut impl Read) -> io::Result<[u8; N]> {
    let mut bytes = [0; N];
    reader.read_exact(&mut bytes)?;
    Ok(bytes)
}

/// Streaming reader, one record of memory. Like RLFRAMES the footer is
/// optional so a crashed recording's prefix stays readable.
pub struct SampleStreamReader<R> {
    reader: R,
    pub header: SampleStreamHeader,
    pub end: Option<SampleStreamEnd>,
    pub truncated_tail: bool,
    finished: bool,
    count: u64,
}

impl<R: Read> SampleStreamReader<R> {
    pub fn new(mut reader: R) -> io::Result<Self> {
        if &read_array::<8>(&mut reader)? != SAMPLE_MAGIC {
            return Err(invalid("Unsupported sample stream magic"));
        }
        let stream_version = u32::from_le_bytes(read_array(&mut reader)?);
        if stream_version != SAMPLE_STREAM_VERSION {
            return Err(invalid(format!(
                "Unsupported sample stream version {stream_version}"
            )));
        }
        let sample_schema_version = u32::from_le_bytes(read_array(&mut reader)?);
        if sample_schema_version != SAMPLE_SCHEMA_VERSION {
            return Err(invalid(format!(
                "Unsupported sample schema version {sample_schema_version}"
            )));
        }
        let id_len = u32::from_le_bytes(read_array(&mut reader)?) as usize;
        if id_len == 0 || id_len > session_format::MAX_SESSION_ID_BYTES {
            return Err(invalid("Invalid session identifier length"));
        }
        let started_at_unix_ms = u64::from_le_bytes(read_array(&mut reader)?);
        let mut id = vec![0; id_len];
        reader.read_exact(&mut id)?;
        let session_id =
            String::from_utf8(id).map_err(|_| invalid("Invalid UTF-8 session identifier"))?;
        if !session_format::is_safe_session_id(&session_id) {
            return Err(invalid("Unsupported session identifier"));
        }
        Ok(Self {
            reader,
            header: SampleStreamHeader {
                stream_version,
                sample_schema_version,
                session_id,
                started_at_unix_ms,
            },
            end: None,
            truncated_tail: false,
            finished: false,
            count: 0,
        })
    }

    pub fn samples_read(&self) -> u64 {
        self.count
    }

    pub fn next_sample(&mut self) -> io::Result<Option<F1SampleV1>> {
        if self.finished {
            return Ok(None);
        }
        let mut tag = [0];
        if self.reader.read(&mut tag)? == 0 {
            self.finished = true;
            return Ok(None);
        }
        match tag[0] {
            RECORD_TAG => {
                let len = u32::from_le_bytes(read_array(&mut self.reader)?) as usize;
                if len > MAX_SAMPLE_RECORD_BYTES {
                    return Err(invalid("Sample record exceeds the record limit"));
                }
                let mut payload = vec![0; len];
                self.reader.read_exact(&mut payload)?;
                let sample: F1SampleV1 = rmp_serde::from_slice(&payload)
                    .map_err(|error| invalid(format!("Could not decode sample: {error}")))?;
                self.count += 1;
                Ok(Some(sample))
            }
            END_TAG => {
                let end = SampleStreamEnd {
                    sample_count: u64::from_le_bytes(read_array(&mut self.reader)?),
                    duration_ms: u64::from_le_bytes(read_array(&mut self.reader)?),
                };
                if end.sample_count != self.count {
                    return Err(invalid("Sample stream footer does not match records"));
                }
                self.finished = true;
                self.end = Some(end);
                Ok(None)
            }
            _ => Err(invalid("Unknown sample stream record type")),
        }
    }

    /// A file that stops part-way through a record ends the stream instead
    /// of failing it; anything else wrong is still an error.
    pub fn next_sample_lossy(&mut self) -> io::Result<Option<F1SampleV1>> {
        match self.next_sample() {
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {
                self.truncated_tail = true;
                self.finished = true;
                Ok(None)
            }
            other => other,
        }
    }
}

/// Every sample of a session, for tests and future offline analysis. Never
/// exposed to the UI.
pub fn read_all_samples(directory: &Path) -> io::Result<(SampleStreamHeader, Vec<F1SampleV1>)> {
    let file = File::open(directory.join(SAMPLES_FILE_NAME))?;
    let mut reader = SampleStreamReader::new(BufReader::new(file))?;
    let mut samples = Vec::new();
    while let Some(sample) = reader.next_sample()? {
        samples.push(sample);
    }
    Ok((reader.header, samples))
}

// --------------------------------------------------------------- events

/// One stored event line. The code and detail bytes are the packet's own;
/// meaning is attached on read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoredEventV1 {
    pub sequence: u64,
    pub monotonic_ms: u64,
    pub session_time: f32,
    pub overall_frame_identifier: u32,
    /// The four code bytes, as text when printable ASCII.
    pub code: String,
    pub code_bytes: [u8; 4],
    /// The 12 detail bytes, hexadecimal.
    pub details_hex: String,
}

impl StoredEventV1 {
    pub fn details_bytes(&self) -> Option<[u8; event::DETAILS_SIZE]> {
        let hex = self.details_hex.as_bytes();
        if hex.len() != event::DETAILS_SIZE * 2 {
            return None;
        }
        let mut bytes = [0; event::DETAILS_SIZE];
        for (index, byte) in bytes.iter_mut().enumerate() {
            let text = std::str::from_utf8(&hex[index * 2..index * 2 + 2]).ok()?;
            *byte = u8::from_str_radix(text, 16).ok()?;
        }
        Some(bytes)
    }

    pub fn details(&self) -> Option<EventDetails> {
        Some(event::decode_details(
            self.code_bytes,
            self.details_bytes()?,
        ))
    }
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub struct EventLogWriter {
    writer: BufWriter<File>,
}

impl EventLogWriter {
    pub fn create(directory: &Path) -> io::Result<Self> {
        let file = OpenOptions::new()
            .append(true)
            .create_new(true)
            .open(directory.join(EVENTS_FILE_NAME))?;
        Ok(Self {
            writer: BufWriter::new(file),
        })
    }

    pub fn write(&mut self, event: &StoredEventV1) -> io::Result<()> {
        serde_json::to_writer(&mut self.writer, event)?;
        self.writer.write_all(b"\n")
    }

    pub fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }

    pub fn finish(mut self) -> io::Result<()> {
        self.writer.flush()?;
        self.writer.get_ref().sync_all()
    }
}

/// What reading `events.jsonl` found.
#[derive(Debug, Clone, Default)]
pub struct EventLogRead {
    pub events: Vec<StoredEventV1>,
    pub total: u64,
    /// A final line without its newline: a write cut off by a crash.
    pub tail_discarded: bool,
    /// A complete line that is not a valid event: damage. Reading stops.
    pub damaged_at_line: Option<u64>,
}

/// Reads the event log, keeping at most the first `keep` events in memory
/// and counting the rest.
pub fn read_events(directory: &Path, keep: usize) -> io::Result<EventLogRead> {
    let file = File::open(directory.join(EVENTS_FILE_NAME))?;
    let mut reader = BufReader::new(file);
    let mut read = EventLogRead::default();
    let mut line = Vec::new();
    let mut number = 0;
    loop {
        line.clear();
        let n = reader.read_until(b'\n', &mut line)?;
        if n == 0 {
            break;
        }
        number += 1;
        if line.last() != Some(&b'\n') {
            read.tail_discarded = true;
            break;
        }
        match serde_json::from_slice::<StoredEventV1>(&line[..line.len() - 1]) {
            Ok(event) => {
                read.total += 1;
                if read.events.len() < keep {
                    read.events.push(event);
                }
            }
            Err(_) => {
                read.damaged_at_line = Some(number);
                break;
            }
        }
    }
    Ok(read)
}

// ------------------------------------------------------------- json io

/// Temp file + rename, as every RaceLab manifest is written.
pub fn write_json_atomically<T: Serialize>(
    directory: &Path,
    name: &str,
    value: &T,
) -> io::Result<()> {
    let target = directory.join(name);
    let temporary = directory.join(format!("{name}.tmp"));
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temporary)?;
        serde_json::to_writer_pretty(&mut file, value)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
    }
    fs::rename(&temporary, &target)
}

pub fn read_json<T: DeserializeOwned>(directory: &Path, name: &str) -> io::Result<T> {
    let bytes = fs::read(directory.join(name))?;
    serde_json::from_slice(&bytes).map_err(|error| invalid(error.to_string()))
}

/// Reads and version-checks `session.json`. A file this build cannot
/// interpret is rejected, never guessed at.
pub fn read_session(directory: &Path) -> io::Result<F1SessionFileV1> {
    let file: F1SessionFileV1 = read_json(directory, SESSION_FILE_NAME)?;
    if file.racelab_session.envelope_version != ENVELOPE_VERSION {
        return Err(invalid(format!(
            "Unsupported session envelope version {}",
            file.racelab_session.envelope_version
        )));
    }
    if file.racelab_session.game != SessionGame::F1_25 {
        return Err(invalid("session.json does not describe an F1 25 session"));
    }
    if file.f1_25.schema_version != F1_SCHEMA_VERSION {
        return Err(invalid(format!(
            "Unsupported F1 session schema version {}",
            file.f1_25.schema_version
        )));
    }
    Ok(file)
}

pub fn write_session(directory: &Path, file: &F1SessionFileV1) -> io::Result<()> {
    write_json_atomically(directory, SESSION_FILE_NAME, file)
}

// ------------------------------------------------------------- recovery

/// Startup, synchronous, manifest-sized: an F1 session still `recording`
/// belongs to a process that never finished it. It becomes `interrupted`
/// and awaits a scan. Never a normal finish, never a fabricated result.
pub fn classify_interrupted_sessions(root: &Path) -> Result<u64, String> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(format!("Could not read the sessions directory: {error}")),
    };
    let mut reclassified = 0;
    for entry in entries.flatten().take(MAX_SCANNED_DIRECTORIES) {
        let directory = entry.path();
        if !directory.is_dir() {
            continue;
        }
        let Ok(mut file) = read_session(&directory) else {
            continue;
        };
        if file.racelab_session.status != SessionStatus::Recording {
            continue;
        }
        file.racelab_session.status = SessionStatus::Interrupted;
        file.racelab_session.completion_reason = Some(completion::INTERRUPTED.into());
        if file.racelab_session.ended_at_unix_ms.is_none() {
            file.racelab_session.ended_at_unix_ms = file
                .racelab_session
                .started_at_unix_ms
                .map(|started| started.saturating_add(file.f1_25.duration_ms));
        }
        file.f1_25.recovery = Some(F1RecoveryV1::pending());
        if write_session(&directory, &file).is_ok() {
            reclassified += 1;
        }
    }
    Ok(reclassified)
}

/// Reads every file of one interrupted session and reports what is readable.
/// Never writes.
pub fn scan_session(directory: &Path) -> F1RecoveryV1 {
    let mut record = F1RecoveryV1::pending();
    record.scanned_at_unix_ms = Some(unix_ms());
    let mut details = Vec::new();
    let path = directory.join(SAMPLES_FILE_NAME);
    let total_bytes = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    let mut damaged = false;
    let mut unreadable = false;
    match File::open(&path).and_then(|file| SampleStreamReader::new(BufReader::new(file))) {
        Err(error) => {
            unreadable = true;
            record.unreadable_sample_tail_bytes = total_bytes;
            details.push(format!("The sample stream could not be read: {error}"));
        }
        Ok(mut reader) => {
            loop {
                match reader.next_sample_lossy() {
                    Ok(Some(_)) => record.readable_samples += 1,
                    Ok(None) => break,
                    Err(error) => {
                        damaged = true;
                        details.push(format!("The sample stream is damaged: {error}"));
                        break;
                    }
                }
            }
            record.sample_stream_complete = reader.end.is_some();
            if reader.truncated_tail {
                details.push(
                    "The sample stream stops part-way through its final sample; every earlier sample is intact."
                        .into(),
                );
            }
        }
    }
    match read_events(directory, 0) {
        Ok(events) => {
            record.readable_events = events.total;
            record.event_tail_discarded = events.tail_discarded;
            if let Some(line) = events.damaged_at_line {
                damaged = true;
                details.push(format!("The event log is damaged at line {line}."));
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => details.push(format!("The event log could not be read: {error}")),
    }
    record.laps_readable = read_json::<LapsFileV1>(directory, LAPS_FILE_NAME).is_ok();
    record.tyres_readable = read_json::<TyresFileV1>(directory, TYRES_FILE_NAME).is_ok();
    record.result_readable = directory
        .join(RESULT_FILE_NAME)
        .exists()
        .then(|| read_json::<ResultFileV1>(directory, RESULT_FILE_NAME).is_ok());
    record.outcome = if unreadable {
        RecoveryOutcome::Unreadable
    } else if damaged {
        RecoveryOutcome::Damaged
    } else if record.sample_stream_complete {
        RecoveryOutcome::Complete
    } else {
        RecoveryOutcome::Truncated
    };
    if details.is_empty() && record.outcome == RecoveryOutcome::Truncated {
        details.push(
            "The recording has no end marker, so RaceLab did not finish it; every sample it holds is intact."
                .into(),
        );
    }
    record.detail = (!details.is_empty()).then(|| details.join(" "));
    record
}

/// Applies a scan. Counts can only be raised to what the files hold; the
/// status stays `interrupted`.
pub fn apply_recovery(file: &mut F1SessionFileV1, recovery: F1RecoveryV1) {
    let integrity = &mut file.f1_25.integrity;
    integrity.sample_count = integrity.sample_count.max(recovery.readable_samples);
    integrity.events_stored = integrity.events_stored.max(recovery.readable_events);
    file.f1_25.recovery = Some(recovery);
}

/// Interrupted F1 sessions whose recovery is still pending.
pub fn sessions_awaiting_scan(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut pending: Vec<(u64, PathBuf)> = entries
        .flatten()
        .take(MAX_SCANNED_DIRECTORIES)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter_map(|path| {
            let file = read_session(&path).ok()?;
            (file.racelab_session.status == SessionStatus::Interrupted
                && file
                    .f1_25
                    .recovery
                    .as_ref()
                    .is_none_or(|recovery| recovery.outcome == RecoveryOutcome::Pending))
            .then(|| (file.racelab_session.started_at_unix_ms.unwrap_or(0), path))
        })
        .collect();
    pending.sort();
    pending.into_iter().map(|(_, path)| path).collect()
}

/// Scans one pending session and records the result. Returns the outcome
/// when the record was written.
pub fn recover_session(directory: &Path) -> Result<RecoveryOutcome, String> {
    let mut file = read_session(directory).map_err(|error| error.to_string())?;
    let recovery = scan_session(directory);
    let outcome = recovery.outcome;
    apply_recovery(&mut file, recovery);
    write_session(directory, &file).map_err(|error| error.to_string())?;
    Ok(outcome)
}

// ------------------------------------------------------------ read side

/// A code's raw value with the specification's name for it, attached on
/// read for the UI. Never persisted.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Labelled<T> {
    pub raw: T,
    pub label: Option<&'static str>,
}

/// Specification names for the coded fields of one session's context.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct F1Labels {
    pub track: Option<Labelled<i8>>,
    pub session_type: Option<Labelled<u8>>,
    pub weather: Option<Labelled<u8>>,
    pub formula: Option<Labelled<u8>>,
    pub safety_car_status: Option<Labelled<u8>>,
    pub network_game: Option<Labelled<u8>>,
    pub game_mode: Option<Labelled<u8>>,
    pub rule_set: Option<Labelled<u8>>,
    pub team: Option<Labelled<u8>>,
    pub result_status: Option<Labelled<u8>>,
    pub result_reason: Option<Labelled<u8>>,
}

pub fn labels(file: &F1SessionFileV1, result: Option<&ResultFileV1>) -> F1Labels {
    let context = file
        .f1_25
        .context_latest
        .as_ref()
        .or(file.f1_25.context_at_start.as_ref());
    F1Labels {
        track: context.map(|c| Labelled {
            raw: c.track_id,
            label: TrackId::from_raw(c.track_id).label(),
        }),
        session_type: context.map(|c| Labelled {
            raw: c.session_type,
            label: SessionType::from_raw(c.session_type).label(),
        }),
        weather: context.map(|c| Labelled {
            raw: c.weather,
            label: Weather::from_raw(c.weather).label(),
        }),
        formula: context.map(|c| Labelled {
            raw: c.formula,
            label: Formula::from_raw(c.formula).label(),
        }),
        safety_car_status: context.map(|c| Labelled {
            raw: c.safety_car_status,
            label: SafetyCarStatus::from_raw(c.safety_car_status).label(),
        }),
        network_game: context.map(|c| Labelled {
            raw: c.network_game,
            label: NetworkGame::from_raw(c.network_game).label(),
        }),
        game_mode: context.map(|c| Labelled {
            raw: c.game_mode,
            label: GameMode::from_raw(c.game_mode).label(),
        }),
        rule_set: context.map(|c| Labelled {
            raw: c.rule_set,
            label: RuleSet::from_raw(c.rule_set).label(),
        }),
        team: file.f1_25.participant.as_ref().map(|p| Labelled {
            raw: p.team_id,
            label: TeamId::from_raw(p.team_id).label(),
        }),
        result_status: result.map(|r| Labelled {
            raw: r.player.result_status,
            label: ResultStatus::from_raw(r.player.result_status).label(),
        }),
        result_reason: result.map(|r| Labelled {
            raw: r.player.result_reason,
            label: ResultReason::from_raw(r.player.result_reason).label(),
        }),
    }
}

pub fn compound_labels(actual: u8, visual: u8) -> (Option<&'static str>, Option<&'static str>) {
    (
        ActualTyreCompound::from_raw(actual).label(),
        VisualTyreCompound::from_raw(visual).label(),
    )
}

/// One listed F1 session: its `session.json` and the labels for its row.
#[derive(Debug, Clone, Serialize)]
pub struct F1SessionListing {
    pub session: F1SessionFileV1,
    pub labels: F1Labels,
}

pub fn listing(file: F1SessionFileV1) -> F1SessionListing {
    let labels = labels(&file, None);
    F1SessionListing {
        session: file,
        labels,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct EventView {
    pub sequence: u64,
    pub monotonic_ms: u64,
    pub session_time: f32,
    pub code: String,
    /// Decoded on read. `None` only for a damaged detail field.
    pub details: Option<EventDetails>,
    /// The vehicle indices the event names, with whether each is the
    /// player's car in this session.
    pub vehicles: Vec<EventVehicle>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EventVehicle {
    pub index: u8,
    pub is_player: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct StintView {
    pub stint: StintV1,
    pub actual_label: Option<&'static str>,
    pub visual_label: Option<&'static str>,
}

/// Everything the F1 session detail shows. Samples are never included.
#[derive(Debug, Clone, Serialize)]
pub struct F1SessionDetail {
    pub session: F1SessionFileV1,
    pub labels: F1Labels,
    pub laps: Option<LapsFileV1>,
    pub tyres: Option<TyresFileV1>,
    pub stints: Vec<StintView>,
    pub result: Option<ResultFileV1>,
    pub events: Vec<EventView>,
    pub events_total: u64,
    /// Events in the file beyond `MAX_DETAIL_EVENTS`, not sent.
    pub events_not_shown: u64,
    /// Side files that exist but could not be read, by name.
    pub unreadable_files: Vec<String>,
}

fn optional<T: DeserializeOwned>(
    directory: &Path,
    name: &str,
    unreadable: &mut Vec<String>,
) -> Option<T> {
    match read_json(directory, name) {
        Ok(value) => Some(value),
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(_) => {
            unreadable.push(name.to_string());
            None
        }
    }
}

pub fn read_detail(directory: &Path) -> io::Result<F1SessionDetail> {
    let session = read_session(directory)?;
    let mut unreadable_files = Vec::new();
    let laps: Option<LapsFileV1> = optional(directory, LAPS_FILE_NAME, &mut unreadable_files);
    let tyres: Option<TyresFileV1> = optional(directory, TYRES_FILE_NAME, &mut unreadable_files);
    let result: Option<ResultFileV1> = optional(directory, RESULT_FILE_NAME, &mut unreadable_files);
    let player = session.f1_25.player_car_index;
    let (events, events_total) = match read_events(directory, MAX_DETAIL_EVENTS) {
        Ok(read) => {
            if read.damaged_at_line.is_some() {
                unreadable_files.push(EVENTS_FILE_NAME.to_string());
            }
            (read.events, read.total)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => (Vec::new(), 0),
        Err(_) => {
            unreadable_files.push(EVENTS_FILE_NAME.to_string());
            (Vec::new(), 0)
        }
    };
    let events: Vec<EventView> = events
        .into_iter()
        .map(|stored| {
            let details = stored.details();
            EventView {
                sequence: stored.sequence,
                monotonic_ms: stored.monotonic_ms,
                session_time: stored.session_time,
                vehicles: details
                    .map(|d| {
                        d.vehicles()
                            .into_iter()
                            .map(|index| EventVehicle {
                                index,
                                is_player: index == player,
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
                code: stored.code,
                details,
            }
        })
        .collect();
    let stints = tyres
        .as_ref()
        .map(|tyres| {
            tyres
                .stints
                .iter()
                .map(|&stint| {
                    let (actual_label, visual_label) =
                        compound_labels(stint.actual_compound, stint.visual_compound);
                    StintView {
                        stint,
                        actual_label,
                        visual_label,
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    let labels = labels(&session, result.as_ref());
    Ok(F1SessionDetail {
        events_not_shown: events_total.saturating_sub(events.len() as u64),
        session,
        labels,
        laps,
        tyres,
        stints,
        result,
        events,
        events_total,
        unreadable_files,
    })
}

/// The packet families a session's coverage names, in packet-ID order.
pub fn family_name(packet_id: u8) -> &'static str {
    PacketKind::from_id(packet_id)
        .map(PacketKind::name)
        .unwrap_or("Unknown")
}
