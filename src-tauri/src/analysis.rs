//! Derived session analysis, schema version 1.
//!
//! This model is **separate from `TelemetryFrame`** and always will be. A
//! canonical frame states what a game transmitted; everything here is a
//! RaceLab-defined consequence of those frames, and mixing the two would make
//! a product threshold look like a protocol fact. Nothing in this file is ever
//! written back into a recording.
//!
//! Three categories run through the whole model and every field below belongs
//! to exactly one of them. `docs/V0.9-ANALYSIS.md` is the contract.
//!
//! - **MEASURED** — a canonical telemetry value, carried across unchanged.
//! - **DERIVED** — a mathematical consequence of canonical values and the
//!   monotonic capture clock (a duration, a difference, a time-weighted mean).
//! - **HEURISTIC** — a RaceLab threshold or segmentation rule. Heuristics are
//!   product definitions, never automotive truths, and the exact configuration
//!   that produced an analysis is stored inside it.
//!
//! Terminology is deliberately neutral. RaceLab reports "high positive slip",
//! never "wheelspin"; "turn segment", never "corner". A name that asserts a
//! vehicle-dynamics conclusion is only permitted once the telemetry
//! mathematically establishes it, and none of these do.
use crate::telemetry::WheelPosition;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::Path,
};

/// Analysis schema version. Independent of `MANIFEST_SCHEMA_VERSION`,
/// `FRAME_FORMAT_VERSION` and `TELEMETRY_FRAME_SCHEMA_VERSION`: derived
/// analysis has its own lifecycle and must never force a frame schema bump.
/// Bumped to 2 by the V0.9 hardening pass: slip is now presented as coalesced
/// episodes rather than per-corner event rows, so the document's shape changed.
/// Schema 1 was never released — it existed only in development analyses — so
/// there is nothing in the wild to stay compatible with, and a v1 file is
/// reported as `Unsupported` rather than silently reinterpreted. Re-analysis
/// regenerates it; `frames.rlframes` and `manifest.json` are untouched.
pub const ANALYSIS_SCHEMA_VERSION: u32 = 2;
pub const ANALYSIS_FILE_NAME: &str = "analysis.json";
const ANALYSIS_TEMP_FILE_NAME: &str = "analysis.json.tmp";
/// Guards reader memory on a corrupt or hostile file. A dense session's
/// analysis is a few hundred kilobytes at most, because event lists are capped.
pub const MAX_ANALYSIS_BYTES: u64 = 16 << 20;

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------

/// Every threshold RaceLab applies, in one place, with no magic number left in
/// an engine module. **All of these are HEURISTIC.** The configuration is
/// serialized into each `analysis.json`, so an analysis always states the rules
/// that produced it and a later threshold change can never be mistaken for a
/// change in the recorded telemetry.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct AnalysisConfigV1 {
    /// Inter-frame intervals longer than this are telemetry gaps, not driving.
    /// They are excluded from every duration and they close open events rather
    /// than letting an event pretend the car kept doing something across the
    /// gap. Matches `session_summary::MAX_SAMPLE_GAP_MS`, so a session summary
    /// and its analysis exclude exactly the same intervals.
    pub max_gap_ms: u64,
    /// An event shorter than this is discarded as frame noise.
    pub min_event_ms: u64,
    /// Normalized throttle. Enter matches the V0.6 summary definition of full
    /// throttle so the two never disagree; exit is lower, which is hysteresis.
    pub full_throttle_enter: f32,
    pub full_throttle_exit: f32,
    /// Normalized brake. Enter matches the V0.6 summary braking definition.
    pub braking_enter: f32,
    pub braking_exit: f32,
    /// Normalized brake. A RaceLab definition of "hard", not a motorsport one.
    pub hard_braking_enter: f32,
    pub hard_braking_exit: f32,
    /// A throttle fall from `from` to `to` inside this window is one lift.
    pub throttle_lift_window_ms: u64,
    pub throttle_lift_from: f32,
    pub throttle_lift_to: f32,
    /// Silences repeated reports of one pedal movement.
    pub throttle_lift_cooldown_ms: u64,
    /// Longitudinal acceleration is differenced over at least this span, so a
    /// single noisy speed sample cannot produce a large value.
    pub acceleration_window_ms: u64,
    /// A |d(speed)/dt| beyond this is treated as a **discontinuity in the
    /// recorded speed**, not as vehicle acceleration: a collision, a respawn, a
    /// rewind or fast travel all move the car's speed without the car having
    /// accelerated. RaceLab does not claim to know which of those happened, so
    /// the sample is excluded from acceleration events and from the summary
    /// extremes, and counted in `speed_discontinuities`. Nothing is clamped and
    /// nothing is repaired: the recorded telemetry is untouched.
    ///
    /// 50 m/s² is about 5.1 g. No road or race car sustains that under its own
    /// tyres, so a larger value is evidence of a discontinuity rather than of
    /// an exceptional driver.
    pub max_plausible_acceleration_mps2: f32,
    pub strong_acceleration_enter_mps2: f32,
    pub strong_acceleration_exit_mps2: f32,
    /// Negative values: these are compared as signed accelerations.
    pub strong_deceleration_enter_mps2: f32,
    pub strong_deceleration_exit_mps2: f32,
    /// Absolute slip ratio. The sign is preserved in the event but is never
    /// interpreted as wheelspin or lock.
    pub slip_ratio_enter: f32,
    pub slip_ratio_exit: f32,
    pub combined_slip_enter: f32,
    pub combined_slip_exit: f32,
    /// Minimum *engaged* time inside a slip episode, and the minimum duration a
    /// single per-corner detector engagement must reach to be counted in
    /// `data_quality`. An episode whose above-threshold time never reaches this
    /// is frame noise.
    pub slip_min_ms: u64,
    /// Slip that resumes within this long of the previous above-threshold
    /// sample belongs to the same episode. Above it, the car had a clearly
    /// distinct period of normal grip and a new episode begins.
    ///
    /// This is the whole anti-duplication rule: one maneuver that lights up two
    /// slip channels on three corners is one episode, not six rows.
    pub slip_merge_gap_ms: u64,
    /// Normalized suspension travel, where 1 is full compression (V0.8).
    pub suspension_compression_enter: f32,
    pub suspension_compression_exit: f32,
    /// Normalized suspension travel, where 0 is full extension (V0.8).
    pub suspension_extension_enter: f32,
    pub suspension_extension_exit: f32,
    /// A suspension excursion shorter than this is a transient wheel movement,
    /// not something worth telling a driver about. Raised from 80 ms by the
    /// V0.9 hardening pass; see docs/V0.9-VALIDATION.md for the real-session
    /// evidence.
    pub suspension_min_ms: u64,
    /// A corner that re-crosses its threshold within this long of leaving it is
    /// still the same excursion. Without it, washboard surface produces one
    /// event per bump on the same wheel.
    pub suspension_merge_gap_ms: u64,
    /// Turn candidates below this speed are ignored: yaw rate at walking pace
    /// is not a turn a driver would recognise.
    pub turn_min_speed_mps: f32,
    pub turn_yaw_rate_enter_rad_s: f64,
    pub turn_yaw_rate_exit_rad_s: f64,
    /// Yaw rate must stay under the exit threshold for this long before a
    /// segment closes; the segment still ends at the last engaged sample.
    pub turn_exit_hold_ms: u64,
    pub turn_min_duration_ms: u64,
    /// A segment must additionally change the car's heading by at least this
    /// much, net of direction. Yaw rate alone cannot distinguish a gentle curve
    /// from a second of steering correction that ends where it started: both
    /// cross the rate threshold, but only one turns the car.
    ///
    /// **Not a physical corner threshold.** It is a RaceLab rule about what is
    /// worth calling a segment. 0.20 rad is about 11.5°.
    pub turn_min_abs_yaw_change_rad: f64,
    /// Output caps. Analysis stays a readable document rather than a log dump,
    /// and a pathological recording cannot produce an unbounded file.
    pub max_events: usize,
    pub max_slip_episodes: usize,
    pub max_turn_segments: usize,
}

impl Default for AnalysisConfigV1 {
    fn default() -> Self {
        Self {
            max_gap_ms: crate::session_summary::MAX_SAMPLE_GAP_MS,
            min_event_ms: 80,
            full_throttle_enter: crate::session_summary::FULL_THROTTLE_THRESHOLD,
            full_throttle_exit: 0.90,
            braking_enter: crate::session_summary::BRAKING_THRESHOLD,
            braking_exit: 0.02,
            hard_braking_enter: 0.80,
            hard_braking_exit: 0.70,
            throttle_lift_window_ms: 250,
            throttle_lift_from: 0.80,
            throttle_lift_to: 0.20,
            throttle_lift_cooldown_ms: 500,
            acceleration_window_ms: 250,
            max_plausible_acceleration_mps2: 50.0,
            strong_acceleration_enter_mps2: 4.0,
            strong_acceleration_exit_mps2: 3.0,
            strong_deceleration_enter_mps2: -6.0,
            strong_deceleration_exit_mps2: -4.5,
            slip_ratio_enter: 1.0,
            slip_ratio_exit: 0.7,
            combined_slip_enter: 1.0,
            combined_slip_exit: 0.7,
            slip_min_ms: 120,
            slip_merge_gap_ms: 400,
            suspension_compression_enter: 0.95,
            suspension_compression_exit: 0.90,
            suspension_extension_enter: 0.05,
            suspension_extension_exit: 0.10,
            suspension_min_ms: 250,
            suspension_merge_gap_ms: 150,
            turn_min_speed_mps: 5.0,
            turn_yaw_rate_enter_rad_s: 0.20,
            turn_yaw_rate_exit_rad_s: 0.10,
            turn_exit_hold_ms: 250,
            turn_min_duration_ms: 600,
            turn_min_abs_yaw_change_rad: 0.20,
            max_events: 400,
            max_slip_episodes: 200,
            max_turn_segments: 200,
        }
    }
}

// --------------------------------------------------------------------------
// Events
// --------------------------------------------------------------------------

/// What a `DrivingEventV1` reports. Every name states the channel and the
/// direction and stops there; none of them names a vehicle-dynamics state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    FullThrottle,
    Braking,
    HardBraking,
    RapidThrottleLift,
    StrongAcceleration,
    StrongDeceleration,
    HighSuspensionCompression,
    HighSuspensionExtension,
}

/// Declaration order, used for stable per-kind counting and presentation.
///
/// Slip is deliberately **not** here. One slide lights up two slip channels on
/// several corners at once, so per-corner slip rows are near-duplicates of each
/// other; slip is presented as a coalesced `SlipEpisodeV1` instead, and the
/// per-corner detector counts survive as data quality.
pub const EVENT_KINDS: [EventKind; 8] = [
    EventKind::FullThrottle,
    EventKind::Braking,
    EventKind::HardBraking,
    EventKind::RapidThrottleLift,
    EventKind::StrongAcceleration,
    EventKind::StrongDeceleration,
    EventKind::HighSuspensionCompression,
    EventKind::HighSuspensionExtension,
];

impl EventKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::FullThrottle => "full_throttle",
            Self::Braking => "braking",
            Self::HardBraking => "hard_braking",
            Self::RapidThrottleLift => "rapid_throttle_lift",
            Self::StrongAcceleration => "strong_acceleration",
            Self::StrongDeceleration => "strong_deceleration",
            Self::HighSuspensionCompression => "high_suspension_compression",
            Self::HighSuspensionExtension => "high_suspension_extension",
        }
    }
}

/// One detected interval. Times are **session-relative monotonic milliseconds**
/// measured from the first record in the frame stream: the raw monotonic clock
/// is a process-uptime value with no meaning to a reader, and wall-clock time
/// is never used anywhere in RaceLab's timing.
///
/// Speeds stay in canonical m/s and accelerations in m/s². Presentation units
/// (km/h) are produced by `src/telemetry/formatting.ts`, exactly as they are
/// for live telemetry, so an analysis file holds canonical values only.
///
/// A field that does not apply to a kind is `null`, never zero.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DrivingEventV1 {
    pub kind: EventKind,
    /// Present only for a per-corner event. The corner is the canonical one the
    /// adapter resolved; analysis never reorders wheels.
    pub corner: Option<WheelPosition>,
    pub start_ms: u64,
    pub end_ms: u64,
    pub duration_ms: u64,
    /// MEASURED at the event boundaries, DERIVED over its interior.
    pub entry_speed_mps: Option<f32>,
    pub exit_speed_mps: Option<f32>,
    pub min_speed_mps: Option<f32>,
    pub max_speed_mps: Option<f32>,
    /// `exit_speed_mps - entry_speed_mps`; negative for a speed reduction.
    pub speed_change_mps: Option<f32>,
    pub max_rpm: Option<f32>,
    /// Peak magnitude of the channel that defines this kind: brake or throttle
    /// input, |slip ratio|, combined slip, normalized travel, or |m/s²|.
    pub peak: Option<f32>,
    /// The same peak with its sign, where the sign carries information that
    /// RaceLab does **not** interpret (slip direction, acceleration sign).
    pub signed_peak: Option<f32>,
    /// Peak combined slip during a slip-ratio event, for context only.
    pub peak_combined_slip: Option<f32>,
}

// --------------------------------------------------------------------------
// Slip episodes
// --------------------------------------------------------------------------

/// Which slip channel an episode crossed a threshold on. Both are dimensionless
/// canonical source quantities; neither name asserts a vehicle-dynamics state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SlipFamily {
    /// `|slip_ratio|` crossed its threshold. The sign is preserved in the
    /// per-corner peaks and is **not** interpreted: RaceLab does not claim that
    /// one sign is wheelspin and the other is wheel lock.
    SlipRatio,
    /// `combined_slip` crossed its threshold.
    CombinedSlip,
}

pub const SLIP_FAMILIES: [SlipFamily; 2] = [SlipFamily::SlipRatio, SlipFamily::CombinedSlip];

impl SlipFamily {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SlipRatio => "slip_ratio",
            Self::CombinedSlip => "combined_slip",
        }
    }
}

/// One coherent high-slip episode.
///
/// A single maneuver puts several corners over threshold on both slip channels
/// at overlapping but not identical times. Reporting each corner and channel
/// separately produced dozens of near-duplicate rows describing one slide, so
/// the analyzer coalesces them: an episode spans from the first above-threshold
/// sample to the last, merging across quiet stretches shorter than
/// `slip_merge_gap_ms` and breaking where the car clearly regained normal grip.
///
/// **No measured peak is lost.** Every affected corner keeps its own maximum
/// absolute slip ratio, the signed value at that maximum, and its maximum
/// combined slip. Large slip values are never clamped or suppressed for being
/// large; coalescing changes how many rows describe an episode, never what the
/// episode measured.
///
/// The neutral term is deliberate. This is a *high slip episode* — never
/// wheelspin, wheel lock, traction loss, a slide or a mistake.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SlipEpisodeV1 {
    /// 1-based, in time order.
    pub index: u32,
    pub start_ms: u64,
    pub end_ms: u64,
    pub duration_ms: u64,
    /// Time actually spent above threshold inside the episode. Always at most
    /// the duration, and the quantity the minimum-duration rule applies to: an
    /// episode is real because of how long the car was slipping, not because of
    /// how far apart its first and last slip were.
    pub engaged_seconds: f64,
    /// Corners that crossed a threshold, in `WHEEL_POSITIONS` order.
    pub corners: Vec<WheelPosition>,
    /// Which slip channels were involved, in `SLIP_FAMILIES` order.
    pub families: Vec<SlipFamily>,
    pub entry_speed_mps: Option<f32>,
    pub min_speed_mps: Option<f32>,
    pub max_speed_mps: Option<f32>,
    pub exit_speed_mps: Option<f32>,
    /// Per affected corner. A corner that never crossed a threshold is `None`,
    /// never 0.
    pub max_abs_slip_ratio: CornerValuesV1,
    /// The signed slip ratio at each corner's peak magnitude. Reported because
    /// it was measured; not interpreted.
    pub signed_peak_slip_ratio: CornerValuesV1,
    pub max_combined_slip: CornerValuesV1,
    /// Largest value across the affected corners, for a one-line summary.
    pub peak_abs_slip_ratio: Option<f32>,
    pub peak_combined_slip: Option<f32>,
}

// --------------------------------------------------------------------------
// Turn segments
// --------------------------------------------------------------------------

/// A sustained yaw-rate interval. **This is not a claim about a track corner.**
/// RaceLab has no track model, no map and no lap geometry; a segment is the
/// interval during which recorded yaw rate stayed above a RaceLab threshold
/// while the car was moving above a RaceLab minimum speed.
///
/// `signed_yaw_change_rad` is stored because it is a real measurement, but the
/// mapping from its sign to the driver's left or right is a parity bit that
/// kinematics cannot supply — the same class of fact as the wheel-order parity
/// bit in V0.8 — and it has not been validated in-game. Presentation therefore
/// labels segments neutrally and never says "left" or "right".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TurnSegmentV1 {
    /// 1-based, in time order.
    pub index: u32,
    pub start_ms: u64,
    pub end_ms: u64,
    pub duration_ms: u64,
    /// DERIVED: the sum of wrap-corrected yaw deltas over the segment.
    pub signed_yaw_change_rad: f64,
    /// DERIVED: `signed_yaw_change_rad` over the segment duration.
    pub mean_yaw_rate_rad_s: f64,
    /// DERIVED: the largest |yaw rate| sample inside the segment.
    pub peak_yaw_rate_rad_s: f64,
    pub entry_speed_mps: Option<f32>,
    pub min_speed_mps: Option<f32>,
    pub exit_speed_mps: Option<f32>,
    pub max_speed_mps: Option<f32>,
    /// DERIVED: time-weighted over monotonic frame timing, never a sample mean.
    pub average_speed_mps: Option<f32>,
    pub brake_seconds: f64,
    pub throttle_seconds: f64,
    pub full_throttle_seconds: f64,
    pub max_brake: Option<f32>,
    /// Per corner. `None` where the channel was unavailable — a V1 recording
    /// leaves all four null.
    pub max_abs_slip_ratio: CornerValuesV1,
    pub max_combined_slip: CornerValuesV1,
    pub max_suspension_compression: CornerValuesV1,
}

/// Four named corners. Named fields rather than an array, for the same reason
/// `telemetry::Wheels` uses them: an index slip cannot transpose a corner.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct CornerValuesV1 {
    pub front_left: Option<f32>,
    pub front_right: Option<f32>,
    pub rear_left: Option<f32>,
    pub rear_right: Option<f32>,
}

impl CornerValuesV1 {
    pub fn get(&self, position: WheelPosition) -> Option<f32> {
        match position {
            WheelPosition::FrontLeft => self.front_left,
            WheelPosition::FrontRight => self.front_right,
            WheelPosition::RearLeft => self.rear_left,
            WheelPosition::RearRight => self.rear_right,
        }
    }

    fn slot(&mut self, position: WheelPosition) -> &mut Option<f32> {
        match position {
            WheelPosition::FrontLeft => &mut self.front_left,
            WheelPosition::FrontRight => &mut self.front_right,
            WheelPosition::RearLeft => &mut self.rear_left,
            WheelPosition::RearRight => &mut self.rear_right,
        }
    }

    pub fn set(&mut self, position: WheelPosition, value: Option<f32>) {
        *self.slot(position) = value;
    }

    /// Keeps the larger of the stored and the observed value, treating an
    /// unavailable channel as "nothing observed yet" rather than as zero.
    pub fn observe_max(&mut self, position: WheelPosition, value: Option<f32>) {
        let Some(value) = value else { return };
        let slot = self.slot(position);
        *slot = Some(slot.map_or(value, |current| current.max(value)));
    }

    pub fn merge_max(&mut self, other: &Self) {
        for position in crate::telemetry::WHEEL_POSITIONS {
            self.observe_max(position, other.get(position));
        }
    }
}

// --------------------------------------------------------------------------
// Coverage, summary and quality
// --------------------------------------------------------------------------

/// Which part of the recording the analysis actually covers. Everything here
/// is DERIVED from monotonic frame timing.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct AnalysisCoverageV1 {
    /// The raw monotonic value of the first record, retained so an analysis can
    /// be traced back to the stream. Every event time is relative to it.
    pub first_monotonic_ms: u64,
    pub last_monotonic_ms: u64,
    /// Wall span of the stream, gaps included.
    pub recorded_seconds: f64,
    /// Sum of accepted inter-frame intervals: gaps and inactive intervals are
    /// not in here, so this is the time analysis actually reasoned about.
    pub analyzed_seconds: f64,
    pub excluded_gap_count: u64,
    pub excluded_gap_seconds: f64,
    /// Intervals dropped because a frame was inactive (menu, loading, paused).
    pub inactive_interval_count: u64,
    pub inactive_interval_seconds: f64,
}

/// Aggregate counters over the whole analysis. DERIVED throughout, with the
/// HEURISTIC thresholds in `config` deciding what counted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DrivingSummaryV1 {
    /// Presented driving events only. Slip episodes are counted separately, so
    /// the totals here always describe the same model the UI renders.
    pub event_count: u64,
    pub slip_episode_count: u64,
    /// Time spent above a slip threshold, summed over every detected episode.
    /// Read against `coverage.analyzed_seconds` this says how much of the drive
    /// the slip thresholds actually selected — which is the honest way to see
    /// that a session of near-continuous wheelspin is being reported as a
    /// handful of long episodes rather than as a handful of moments.
    pub slip_episode_seconds: f64,
    pub turn_segment_count: u64,
    /// Count per kind, in `EVENT_KINDS` order. Counts every detected event,
    /// including any dropped from `events` by the output cap.
    pub events_by_kind: Vec<EventCountV1>,
    pub full_throttle_seconds: f64,
    pub braking_seconds: f64,
    pub hard_braking_seconds: f64,
    pub max_speed_mps: Option<f32>,
    pub max_longitudinal_acceleration_mps2: Option<f32>,
    pub max_longitudinal_deceleration_mps2: Option<f32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EventCountV1 {
    pub kind: EventKind,
    pub count: u64,
}

/// What the analysis could and could not see. A missing channel makes the
/// events that depend on it unavailable; it never invalidates the analysis.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AnalysisDataQualityV1 {
    /// The schema the *frame stream* was written in, carried through so a
    /// reader knows why a V2-only channel is unavailable.
    pub telemetry_frame_schema_version: u32,
    pub frames_read: u64,
    pub active_frames: u64,
    pub inactive_frames: u64,
    /// Consecutive records carrying the same monotonic timestamp. They advance
    /// no time and are excluded from every time-weighted quantity.
    pub zero_interval_frames: u64,
    /// Speed changes too large to be vehicle acceleration. See
    /// `AnalysisConfigV1::max_plausible_acceleration_mps2`. Counted, reported,
    /// and excluded from acceleration events — never silently smoothed away.
    pub speed_discontinuities: u64,
    /// True when the stream carried its footer. A recording interrupted by a
    /// crash is still analyzed, and says so here.
    pub frame_stream_complete: bool,
    pub speed_available: bool,
    pub controls_available: bool,
    pub engine_available: bool,
    pub orientation_available: bool,
    pub wheel_telemetry_available: bool,
    pub suspension_available: bool,
    /// Events detected but dropped because `max_events` was reached. Never
    /// silent: the summary counts them and the UI reports them.
    pub events_truncated: u64,
    pub slip_episodes_truncated: u64,
    pub turn_segments_truncated: u64,
    /// Raw per-corner slip detector engagements that lasted at least
    /// `slip_min_ms`, before coalescing. These are **diagnostics, not driving
    /// events**: they are what the low-level detectors saw, and the count being
    /// much larger than `slip_episode_count` is the normal, expected shape of
    /// one maneuver lighting up several corners at once.
    pub slip_ratio_detector_events: u64,
    pub combined_slip_detector_events: u64,
}

/// One analyzed session. Written to `<session>/analysis.json` beside the
/// manifest and the frame stream; the manifest itself is never modified.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionAnalysisV1 {
    pub schema_version: u32,
    pub session_id: String,
    pub telemetry_frame_schema_version: u32,
    /// When the analysis *finished*, not when it was requested. The two differ
    /// whenever a job waited behind another session, which is why `queued_ms`
    /// exists: a long wall-clock gap between a session ending and its analysis
    /// appearing is a queue observation, not a slow analyzer.
    pub analyzed_at_unix_ms: u64,
    /// When the completed session was queued for analysis. `None` for an
    /// analysis produced outside the job runner, such as the offline example.
    pub requested_at_unix_ms: Option<u64>,
    /// How long this job waited in the queue before it started.
    pub queued_ms: Option<u64>,
    /// Wall time spent analyzing, excluding any queue wait.
    pub analysis_duration_ms: u64,
    pub analyzed_by_racelab_version: String,
    /// The exact heuristics this analysis was produced with.
    pub config: AnalysisConfigV1,
    pub coverage: AnalysisCoverageV1,
    pub driving_summary: DrivingSummaryV1,
    pub events: Vec<DrivingEventV1>,
    /// Coalesced high-slip episodes. This replaced per-corner slip event rows
    /// in the V0.9 hardening pass and is why the analysis schema is 2.
    pub slip_episodes: Vec<SlipEpisodeV1>,
    pub turn_segments: Vec<TurnSegmentV1>,
    pub data_quality: AnalysisDataQualityV1,
}

pub fn supports_analysis_schema(version: u32) -> bool {
    version == ANALYSIS_SCHEMA_VERSION
}

/// Why an analysis is not available. Each variant reaches the UI as its own
/// explicit state: an absent analysis must never render as "zero events".
#[derive(Debug)]
pub enum AnalysisReadError {
    /// No `analysis.json` in the session directory.
    Absent,
    /// Present but unparseable, or truncated.
    Corrupt(String),
    /// Parseable, but written by a schema this build does not understand.
    Unsupported(u32),
    /// The file exists but could not be read at all.
    Io(io::Error),
}

impl std::fmt::Display for AnalysisReadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Absent => write!(formatter, "No analysis has been produced for this session"),
            Self::Corrupt(reason) => {
                write!(formatter, "The analysis file could not be read: {reason}")
            }
            Self::Unsupported(version) => {
                write!(formatter, "Unsupported analysis schema version {version}")
            }
            Self::Io(error) => write!(formatter, "Could not open the analysis file: {error}"),
        }
    }
}

/// Temp file, sync, rename. A reader sees either no analysis or a complete one;
/// a partially written file can never masquerade as a finished analysis, and a
/// failure leaves any previous analysis untouched.
pub fn write_analysis_atomically(directory: &Path, analysis: &SessionAnalysisV1) -> io::Result<()> {
    let target = directory.join(ANALYSIS_FILE_NAME);
    let temporary = directory.join(ANALYSIS_TEMP_FILE_NAME);
    {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temporary)?;
        // Human-readable on purpose: an analysis is a document a person reads.
        serde_json::to_writer_pretty(&mut file, analysis)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
    }
    fs::rename(&temporary, &target)
}

/// The version probe. Read before the body so a *future* analysis schema
/// reports its own number instead of failing as though the file were damaged.
#[derive(Deserialize)]
struct VersionProbe {
    schema_version: u32,
}

/// Reading is isolated: every failure mode is its own value, and none of them
/// can take down a session listing or a session's details.
pub fn read_analysis(directory: &Path) -> Result<SessionAnalysisV1, AnalysisReadError> {
    let path = directory.join(ANALYSIS_FILE_NAME);
    match fs::metadata(&path) {
        Ok(metadata) if metadata.len() > MAX_ANALYSIS_BYTES => {
            return Err(AnalysisReadError::Corrupt(
                "The analysis file exceeds the size limit".into(),
            ))
        }
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(AnalysisReadError::Absent)
        }
        Err(error) => return Err(AnalysisReadError::Io(error)),
    }
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(AnalysisReadError::Absent)
        }
        Err(error) => return Err(AnalysisReadError::Io(error)),
    };
    let probe: VersionProbe = serde_json::from_slice(&bytes)
        .map_err(|error| AnalysisReadError::Corrupt(error.to_string()))?;
    if !supports_analysis_schema(probe.schema_version) {
        return Err(AnalysisReadError::Unsupported(probe.schema_version));
    }
    serde_json::from_slice(&bytes).map_err(|error| AnalysisReadError::Corrupt(error.to_string()))
}
