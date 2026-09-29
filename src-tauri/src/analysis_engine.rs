//! Streaming derived-analysis engine.
//!
//! One pass, O(n) in the number of frames, with **bounded memory**. The
//! accumulator never retains a `TelemetryFrame` and never keeps frame history:
//! what it holds is one previous sample, one state machine per detector, one
//! open turn segment, the capped output lists, and a single short rolling
//! window of `(time, speed, throttle)` triples.
//!
//! That window is the only history in the engine. It is trimmed to twice the
//! longest configured window (`acceleration_window_ms`, `throttle_lift_window_ms`
//! — 250 ms each by default, so 500 ms retained) and hard-capped at
//! `RING_CAPACITY` samples, which is 256. At the ~72 Hz FH6 sends, 500 ms is
//! about 36 samples; the cap only exists so that an implausibly fast source
//! cannot grow it. Peak retained state is therefore a few kilobytes plus the
//! capped event lists, whatever the length of the session.
//!
//! All timing comes from `RecordedFrame::monotonic_ms`, the capture monotonic
//! clock. No wall clock, no game timestamp, no assumed frame rate, and never a
//! frame count used as a duration.
use crate::{
    analysis::{
        AnalysisConfigV1, AnalysisCoverageV1, AnalysisDataQualityV1, CornerValuesV1,
        DrivingEventV1, DrivingSummaryV1, EventCountV1, EventKind, SessionAnalysisV1,
        SlipEpisodeV1, SlipFamily, TurnSegmentV1, ANALYSIS_SCHEMA_VERSION, EVENT_KINDS,
        SLIP_FAMILIES,
    },
    session_format::{FrameStreamReader, RecordedFrame, FRAME_FILE_NAME},
    telemetry::{TelemetryFrame, WheelPosition, Wheels, WHEEL_POSITIONS},
};
use std::{
    collections::VecDeque,
    fs::File,
    io::{self, BufReader},
    path::Path,
    time::{Instant, SystemTime, UNIX_EPOCH},
};

/// Hard cap on the rolling window, independent of the configured durations.
const RING_CAPACITY: usize = 256;

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

fn kind_index(kind: EventKind) -> usize {
    EVENT_KINDS
        .iter()
        .position(|candidate| *candidate == kind)
        .unwrap_or(0)
}

/// Wrap an angular difference into `(-π, π]`.
///
/// Without this a yaw crossing from `+π` to `-π` would read as a 2π turn in
/// one frame. The correction assumes only that the car cannot rotate more than
/// half a revolution between two consecutive samples, which at any plausible
/// frame interval it cannot.
pub fn wrap_angle(delta: f64) -> f64 {
    let wrapped =
        (delta + std::f64::consts::PI).rem_euclid(std::f64::consts::TAU) - std::f64::consts::PI;
    // `rem_euclid` maps exactly -π to -π; normalise the boundary to +π so the
    // function is the documented half-open interval.
    if wrapped <= -std::f64::consts::PI {
        wrapped + std::f64::consts::TAU
    } else {
        wrapped
    }
}

fn max_option(current: Option<f32>, value: Option<f32>) -> Option<f32> {
    match (current, value) {
        (Some(current), Some(value)) => Some(current.max(value)),
        (current, None) => current,
        (None, value) => value,
    }
}

fn min_option(current: Option<f32>, value: Option<f32>) -> Option<f32> {
    match (current, value) {
        (Some(current), Some(value)) => Some(current.min(value)),
        (current, None) => current,
        (None, value) => value,
    }
}

/// One frame reduced to the channels analysis uses. `wheels` is `Copy` and
/// fixed size, so holding the previous one costs nothing and grows with
/// nothing.
#[derive(Debug, Clone, Copy)]
struct Sample {
    /// Session-relative monotonic milliseconds.
    t_ms: u64,
    active: bool,
    speed_mps: Option<f32>,
    rpm: Option<f32>,
    throttle: Option<f32>,
    brake: Option<f32>,
    yaw_rad: Option<f32>,
    wheels: Wheels,
}

impl Sample {
    fn of(frame: &TelemetryFrame, t_ms: u64) -> Self {
        Self {
            t_ms,
            active: frame.active,
            speed_mps: frame.speed_mps,
            rpm: frame.engine.rpm,
            throttle: frame.controls.throttle,
            brake: frame.controls.brake,
            yaw_rad: frame.orientation.map(|orientation| orientation.x),
            wheels: frame.wheels,
        }
    }
}

/// An interval that is currently above its enter threshold.
#[derive(Debug, Clone)]
struct OpenEvent {
    start_ms: u64,
    end_ms: u64,
    entry_speed: Option<f32>,
    exit_speed: Option<f32>,
    min_speed: Option<f32>,
    max_speed: Option<f32>,
    max_rpm: Option<f32>,
    /// The ordering key for "most extreme sample so far"; never reported.
    rank: f32,
    peak: f32,
    signed_peak: f32,
    peak_combined_slip: Option<f32>,
}

/// One threshold detector. Hysteresis lives here: a caller passes `engaged`,
/// which it computes with the enter threshold when the latch is closed and the
/// exit threshold when it is open, so a value hovering on one boundary cannot
/// produce a stream of events.
#[derive(Debug, Clone)]
struct Latch {
    kind: EventKind,
    corner: Option<WheelPosition>,
    min_ms: u64,
    /// A detector that re-engages within this long of disengaging continues the
    /// same event instead of starting a new one. Zero disables merging, which
    /// is what every detector except suspension uses.
    merge_gap_ms: u64,
    open: Option<OpenEvent>,
    /// Closed but still mergeable. Held for at most `merge_gap_ms`, so this is
    /// one extra event's worth of memory per detector and never a list.
    pending: Option<OpenEvent>,
}

impl Latch {
    fn new(kind: EventKind, corner: Option<WheelPosition>, min_ms: u64) -> Self {
        Self {
            kind,
            corner,
            min_ms,
            merge_gap_ms: 0,
            open: None,
            pending: None,
        }
    }

    fn merging(mut self, merge_gap_ms: u64) -> Self {
        self.merge_gap_ms = merge_gap_ms;
        self
    }

    fn is_open(&self) -> bool {
        self.open.is_some()
    }

    /// Turn a held excursion into an event if it is long enough to report.
    fn emit(&self, open: OpenEvent, end_ms: Option<u64>) -> Option<DrivingEventV1> {
        let end_ms = end_ms.unwrap_or(open.end_ms).max(open.start_ms);
        let duration_ms = end_ms.saturating_sub(open.start_ms);
        if duration_ms < self.min_ms {
            return None;
        }
        Some(DrivingEventV1 {
            kind: self.kind,
            corner: self.corner,
            start_ms: open.start_ms,
            end_ms,
            duration_ms,
            entry_speed_mps: open.entry_speed,
            exit_speed_mps: open.exit_speed,
            min_speed_mps: open.min_speed,
            max_speed_mps: open.max_speed,
            speed_change_mps: match (open.entry_speed, open.exit_speed) {
                (Some(entry), Some(exit)) => Some(exit - entry),
                _ => None,
            },
            max_rpm: open.max_rpm,
            peak: Some(open.peak),
            signed_peak: Some(open.signed_peak),
            peak_combined_slip: open.peak_combined_slip,
        })
    }

    /// Advance the detector by one interval ending at `sample`.
    ///
    /// `rank` decides *which* sample inside the event is the extreme one, and
    /// is always "larger is more extreme" — a detector whose extreme is a small
    /// value (suspension extension) or a negative one (deceleration) passes the
    /// negated quantity. `magnitude` and `signed` are what gets reported for
    /// that sample: the value without and with its sign.
    fn update(
        &mut self,
        sample: &Sample,
        engaged: bool,
        rank: f32,
        magnitude: f32,
        signed: f32,
        combined_slip: Option<f32>,
    ) -> Option<DrivingEventV1> {
        if engaged {
            // Re-engaging inside the merge window continues the held excursion
            // rather than starting a second one.
            if self.open.is_none() {
                if let Some(pending) = self.pending.take() {
                    if sample.t_ms.saturating_sub(pending.end_ms) <= self.merge_gap_ms {
                        self.open = Some(pending);
                    } else {
                        let flushed = self.emit(pending, None);
                        self.begin(sample, rank, magnitude, signed, combined_slip);
                        return flushed;
                    }
                }
            }
            match &mut self.open {
                Some(open) => {
                    open.end_ms = sample.t_ms;
                    open.exit_speed = sample.speed_mps;
                    open.min_speed = min_option(open.min_speed, sample.speed_mps);
                    open.max_speed = max_option(open.max_speed, sample.speed_mps);
                    open.max_rpm = max_option(open.max_rpm, sample.rpm);
                    if rank > open.rank {
                        open.rank = rank;
                        open.peak = magnitude;
                        open.signed_peak = signed;
                    }
                    open.peak_combined_slip = max_option(open.peak_combined_slip, combined_slip);
                }
                None => self.begin(sample, rank, magnitude, signed, combined_slip),
            }
            None
        } else {
            // Hold rather than emit: the excursion may resume inside the merge
            // window. A held excursion is flushed when that window expires, on
            // a gap, or at end of stream.
            if let Some(open) = self.open.take() {
                self.pending = Some(open);
                return None;
            }
            if let Some(pending) = &self.pending {
                if sample.t_ms.saturating_sub(pending.end_ms) > self.merge_gap_ms {
                    let pending = self.pending.take().expect("checked above");
                    return self.emit(pending, None);
                }
            }
            None
        }
    }

    fn begin(
        &mut self,
        sample: &Sample,
        rank: f32,
        magnitude: f32,
        signed: f32,
        combined_slip: Option<f32>,
    ) {
        self.open = Some(OpenEvent {
            start_ms: sample.t_ms,
            end_ms: sample.t_ms,
            entry_speed: sample.speed_mps,
            exit_speed: sample.speed_mps,
            min_speed: sample.speed_mps,
            max_speed: sample.speed_mps,
            max_rpm: sample.rpm,
            rank,
            peak: magnitude,
            signed_peak: signed,
            peak_combined_slip: combined_slip,
        });
    }

    /// Close the detector, optionally forcing the end time, and flush anything
    /// held for merging. `at` is used when a gap or an inactive frame ends an
    /// event: the event must end at the last frame that actually observed it,
    /// never at the far side of the gap.
    ///
    /// At most two events can be produced here — a held one and an open one —
    /// so the caller takes a small vector rather than a single value.
    fn close(&mut self, at: Option<u64>, out: &mut Vec<DrivingEventV1>) {
        if let Some(pending) = self.pending.take() {
            if let Some(event) = self.emit(pending, None) {
                out.push(event);
            }
        }
        if let Some(open) = self.open.take() {
            if let Some(event) = self.emit(open, at) {
                out.push(event);
            }
        }
    }
}

/// Per-interval statistics inside a turn segment. A fixed-size struct, not a
/// list: this is what lets a segment of any length cost the same memory.
#[derive(Debug, Clone, Copy, Default)]
struct TurnStats {
    yaw_change: f64,
    peak_rate: f64,
    exit_speed: Option<f32>,
    min_speed: Option<f32>,
    max_speed: Option<f32>,
    speed_weighted: f64,
    speed_seconds: f64,
    brake_ms: u64,
    throttle_ms: u64,
    full_throttle_ms: u64,
    max_brake: Option<f32>,
    max_abs_slip: CornerValuesV1,
    max_combined_slip: CornerValuesV1,
    max_compression: CornerValuesV1,
}

impl TurnStats {
    fn merge(&mut self, other: &Self) {
        self.yaw_change += other.yaw_change;
        self.peak_rate = self.peak_rate.max(other.peak_rate);
        if other.exit_speed.is_some() {
            self.exit_speed = other.exit_speed;
        }
        self.min_speed = min_option(self.min_speed, other.min_speed);
        self.max_speed = max_option(self.max_speed, other.max_speed);
        self.speed_weighted += other.speed_weighted;
        self.speed_seconds += other.speed_seconds;
        self.brake_ms += other.brake_ms;
        self.throttle_ms += other.throttle_ms;
        self.full_throttle_ms += other.full_throttle_ms;
        self.max_brake = max_option(self.max_brake, other.max_brake);
        self.max_abs_slip.merge_max(&other.max_abs_slip);
        self.max_combined_slip.merge_max(&other.max_combined_slip);
        self.max_compression.merge_max(&other.max_compression);
    }
}

/// An open turn segment.
///
/// `stats` holds everything up to and including the last *engaged* interval —
/// one whose |yaw rate| was at or above the exit threshold. `pending` holds
/// intervals since then. If the yaw rate rises back above the exit threshold
/// inside the hold window, `pending` is merged and the segment continues; if
/// the hold expires, `pending` is discarded and the segment ends at
/// `engaged_ms`. That is what keeps a segment's reported duration, speeds and
/// pedal times free of the straight-line running that follows it.
#[derive(Debug, Clone)]
struct TurnState {
    start_ms: u64,
    engaged_ms: u64,
    direction: f64,
    entry_speed: Option<f32>,
    stats: TurnStats,
    pending: TurnStats,
    below_since_ms: Option<u64>,
}

/// An open high-slip episode: the union of every corner and channel currently
/// over threshold, plus the peaks each affected corner reached. Fixed size, so
/// an episode of any length costs the same.
#[derive(Debug, Clone)]
struct OpenSlipEpisode {
    start_ms: u64,
    end_ms: u64,
    /// Time actually spent above threshold, which is what the minimum-duration
    /// rule applies to. Always at most `end_ms - start_ms`.
    engaged_ms: u64,
    entry_speed: Option<f32>,
    exit_speed: Option<f32>,
    min_speed: Option<f32>,
    max_speed: Option<f32>,
    /// Indexed by `WHEEL_POSITIONS` position; converted to named corners on
    /// close, so no index ever reaches the output.
    corners: [bool; 4],
    /// Indexed by `SLIP_FAMILIES` position.
    families: [bool; 2],
    max_abs_slip_ratio: CornerValuesV1,
    signed_peak_slip_ratio: CornerValuesV1,
    max_combined_slip: CornerValuesV1,
}

/// The whole slip pipeline's state: eight engagement timers, one open episode.
#[derive(Debug, Clone, Default)]
struct SlipTracker {
    /// When each corner's current slip-ratio engagement began, if engaged.
    /// Doubles as the hysteresis state, exactly as a latch's `open` did.
    ratio_since: [Option<u64>; 4],
    combined_since: [Option<u64>; 4],
    open: Option<OpenSlipEpisode>,
    /// Last sample at which anything was over threshold. Drives the merge gap.
    last_engaged_ms: Option<u64>,
    /// The previous sample's time, so an engagement's length is measured to the
    /// last sample that was actually engaged rather than to the one that ended
    /// it. Keeps the detector counts identical to what the per-corner latches
    /// reported before coalescing, so the two are directly comparable.
    previous_ms: Option<u64>,
    /// Whether anything was over threshold at the previous sample. Engaged time
    /// accrues only across an interval that was engaged at *both* ends, so a
    /// channel flickering over the threshold every other frame accumulates no
    /// engaged time and cannot become an episode.
    previous_engaged: bool,
    ratio_detector_events: u64,
    combined_detector_events: u64,
}

impl SlipTracker {
    /// Update one corner/channel engagement. Returns the start time of an
    /// engagement that just ended, so the caller can count it if it lasted long
    /// enough to be a detector event.
    fn engagement(
        &mut self,
        index: usize,
        family: SlipFamily,
        engaged: bool,
        now: u64,
    ) -> Option<u64> {
        let slot = match family {
            SlipFamily::SlipRatio => &mut self.ratio_since[index],
            SlipFamily::CombinedSlip => &mut self.combined_since[index],
        };
        match (engaged, *slot) {
            (true, None) => {
                *slot = Some(now);
                None
            }
            (true, Some(_)) => None,
            (false, Some(started)) => {
                *slot = None;
                Some(started)
            }
            (false, None) => None,
        }
    }

    /// How long an engagement that just ended actually lasted: from its first
    /// engaged sample to its last, not to the sample that ended it.
    fn engaged_span(&self, started: u64) -> u64 {
        self.previous_ms.unwrap_or(started).saturating_sub(started)
    }
}

/// One entry of the rolling window.
#[derive(Debug, Clone, Copy)]
struct RingSample {
    t_ms: u64,
    speed_mps: Option<f32>,
    throttle: Option<f32>,
}

/// Single-pass, bounded-memory analysis state.
pub struct AnalysisAccumulator {
    config: AnalysisConfigV1,
    session_id: String,
    telemetry_frame_schema_version: u32,
    /// Wall time spent analyzing, so a slow analysis and a long queue wait can
    /// never be confused for one another.
    started: Instant,

    first_monotonic_ms: Option<u64>,
    last_monotonic_ms: u64,
    previous: Option<Sample>,

    frames_read: u64,
    active_frames: u64,
    inactive_frames: u64,
    zero_interval_frames: u64,
    speed_discontinuities: u64,
    analyzed_ms: u64,
    excluded_gap_count: u64,
    excluded_gap_ms: u64,
    inactive_interval_count: u64,
    inactive_interval_ms: u64,

    speed_available: bool,
    controls_available: bool,
    engine_available: bool,
    orientation_available: bool,
    wheel_telemetry_available: bool,
    suspension_available: bool,

    full_throttle_ms: u64,
    braking_ms: u64,
    hard_braking_ms: u64,
    max_speed_mps: Option<f32>,
    max_acceleration_mps2: Option<f32>,
    max_deceleration_mps2: Option<f32>,

    latch_full_throttle: Latch,
    latch_braking: Latch,
    latch_hard_braking: Latch,
    latch_acceleration: Latch,
    latch_deceleration: Latch,
    /// Per-corner detectors. Each array position carries its own
    /// `WheelPosition` inside the latch, so the emitted corner never comes from
    /// an array index.
    latch_compression: [Latch; 4],
    latch_extension: [Latch; 4],
    /// Slip is coalesced into episodes rather than latched per corner. This is
    /// the whole slip pipeline: eight small engagement timers and at most one
    /// open episode.
    slip: SlipTracker,
    slip_episodes: Vec<SlipEpisodeV1>,
    slip_episodes_detected: u64,
    slip_episode_ms: u64,

    ring: VecDeque<RingSample>,
    last_lift_ms: Option<u64>,

    turn: Option<TurnState>,
    turn_segments: Vec<TurnSegmentV1>,
    turn_segments_detected: u64,

    events: Vec<DrivingEventV1>,
    kind_detected: [u64; EVENT_KINDS.len()],
    kind_emitted: [u64; EVENT_KINDS.len()],
    events_truncated: u64,
}

impl AnalysisAccumulator {
    pub fn new(
        session_id: String,
        telemetry_frame_schema_version: u32,
        config: AnalysisConfigV1,
    ) -> Self {
        let corner_latches = |kind: EventKind, min_ms: u64| {
            let mut index = 0;
            [(); 4].map(|()| {
                let position = WHEEL_POSITIONS[index];
                index += 1;
                Latch::new(kind, Some(position), min_ms)
            })
        };
        Self {
            session_id,
            telemetry_frame_schema_version,
            started: Instant::now(),
            first_monotonic_ms: None,
            last_monotonic_ms: 0,
            previous: None,
            frames_read: 0,
            active_frames: 0,
            inactive_frames: 0,
            zero_interval_frames: 0,
            speed_discontinuities: 0,
            analyzed_ms: 0,
            excluded_gap_count: 0,
            excluded_gap_ms: 0,
            inactive_interval_count: 0,
            inactive_interval_ms: 0,
            speed_available: false,
            controls_available: false,
            engine_available: false,
            orientation_available: false,
            wheel_telemetry_available: false,
            suspension_available: false,
            full_throttle_ms: 0,
            braking_ms: 0,
            hard_braking_ms: 0,
            max_speed_mps: None,
            max_acceleration_mps2: None,
            max_deceleration_mps2: None,
            latch_full_throttle: Latch::new(EventKind::FullThrottle, None, config.min_event_ms),
            latch_braking: Latch::new(EventKind::Braking, None, config.min_event_ms),
            latch_hard_braking: Latch::new(EventKind::HardBraking, None, config.min_event_ms),
            latch_acceleration: Latch::new(
                EventKind::StrongAcceleration,
                None,
                config.min_event_ms,
            ),
            latch_deceleration: Latch::new(
                EventKind::StrongDeceleration,
                None,
                config.min_event_ms,
            ),
            latch_compression: corner_latches(
                EventKind::HighSuspensionCompression,
                config.suspension_min_ms,
            )
            .map(|latch| latch.merging(config.suspension_merge_gap_ms)),
            latch_extension: corner_latches(
                EventKind::HighSuspensionExtension,
                config.suspension_min_ms,
            )
            .map(|latch| latch.merging(config.suspension_merge_gap_ms)),
            slip: SlipTracker::default(),
            slip_episodes: Vec::new(),
            slip_episodes_detected: 0,
            slip_episode_ms: 0,
            ring: VecDeque::with_capacity(RING_CAPACITY),
            last_lift_ms: None,
            turn: None,
            turn_segments: Vec::new(),
            turn_segments_detected: 0,
            events: Vec::new(),
            kind_detected: [0; EVENT_KINDS.len()],
            kind_emitted: [0; EVENT_KINDS.len()],
            events_truncated: 0,
            config,
        }
    }

    /// Detected events are always counted. They are stored until this kind
    /// reaches `max_events`, after which further ones are counted as truncated
    /// rather than silently forgotten. The cap is per kind so one noisy channel
    /// cannot crowd every other event out of the file.
    fn push_event(&mut self, event: DrivingEventV1) {
        let index = kind_index(event.kind);
        self.kind_detected[index] += 1;
        if self.kind_emitted[index] as usize >= self.config.max_events {
            self.events_truncated += 1;
            return;
        }
        self.kind_emitted[index] += 1;
        self.events.push(event);
    }

    /// End every open detector and the open turn segment and slip episode at
    /// `at`. Called for a telemetry gap, for an inactive frame and at end of
    /// stream, so nothing ever reports that the car kept doing something
    /// through time that was never measured.
    fn close_all(&mut self, at: u64) {
        let mut produced = Vec::new();
        self.latch_full_throttle.close(Some(at), &mut produced);
        self.latch_braking.close(Some(at), &mut produced);
        self.latch_hard_braking.close(Some(at), &mut produced);
        self.latch_acceleration.close(Some(at), &mut produced);
        self.latch_deceleration.close(Some(at), &mut produced);
        for latch in self
            .latch_compression
            .iter_mut()
            .chain(self.latch_extension.iter_mut())
        {
            latch.close(Some(at), &mut produced);
        }
        for event in produced {
            self.push_event(event);
        }
        self.close_slip_episode();
        self.close_turn();
        self.ring.clear();
    }

    fn observe_sample(&mut self, sample: &Sample) {
        if !sample.active {
            return;
        }
        if sample.speed_mps.is_some() {
            self.speed_available = true;
            self.max_speed_mps = max_option(self.max_speed_mps, sample.speed_mps);
        }
        if sample.throttle.is_some() || sample.brake.is_some() {
            self.controls_available = true;
        }
        if sample.rpm.is_some() {
            self.engine_available = true;
        }
        if sample.yaw_rad.is_some() {
            self.orientation_available = true;
        }
        for position in WHEEL_POSITIONS {
            let wheel = sample.wheels.get(position);
            if wheel.slip_ratio.is_some() || wheel.combined_slip.is_some() {
                self.wheel_telemetry_available = true;
            }
            if wheel.normalized_suspension_travel.is_some() {
                self.suspension_available = true;
            }
        }
    }

    /// One record. Constant work, constant memory.
    pub fn observe(&mut self, record: &RecordedFrame) {
        self.frames_read += 1;
        let first = *self.first_monotonic_ms.get_or_insert(record.monotonic_ms);
        self.last_monotonic_ms = record.monotonic_ms;
        let sample = Sample::of(&record.frame, record.monotonic_ms.saturating_sub(first));
        if sample.active {
            self.active_frames += 1;
        } else {
            self.inactive_frames += 1;
        }
        self.observe_sample(&sample);

        let Some(previous) = self.previous else {
            self.previous = Some(sample);
            self.resume(&sample);
            return;
        };
        let interval_ms = sample.t_ms.saturating_sub(previous.t_ms);

        if interval_ms == 0 {
            // A duplicate timestamp advances no time. It is counted, its values
            // replace the previous sample, and it contributes to nothing that
            // is weighted by time — including a derivative, whose denominator
            // would be zero.
            self.zero_interval_frames += 1;
            self.previous = Some(sample);
            return;
        }
        if interval_ms > self.config.max_gap_ms {
            self.excluded_gap_count += 1;
            self.excluded_gap_ms += interval_ms;
            self.close_all(previous.t_ms);
            self.previous = Some(sample);
            self.resume(&sample);
            return;
        }
        if !previous.active || !sample.active {
            self.inactive_interval_count += 1;
            self.inactive_interval_ms += interval_ms;
            self.close_all(previous.t_ms);
            self.previous = Some(sample);
            self.resume(&sample);
            return;
        }

        self.analyzed_ms += interval_ms;
        self.accumulate_interval(&previous, &sample, interval_ms);
        self.push_ring(&sample);
        self.update_controls(&sample);
        self.update_acceleration(&sample);
        self.update_throttle_lift(&sample);
        self.update_wheels(&sample);
        self.update_turn(&previous, &sample, interval_ms);
        self.previous = Some(sample);
    }

    /// Start measuring again at `sample`: the first frame of the stream, or the
    /// first frame after a gap or an inactive stretch.
    ///
    /// The per-sample detectors run here so that an event which is already
    /// under way at this frame is reported from *this* frame rather than from
    /// the next one. The detectors that need two samples — acceleration, the
    /// throttle-lift window and turn segmentation — cannot run yet, and the
    /// cleared rolling window is what stops them reaching across the gap.
    fn resume(&mut self, sample: &Sample) {
        if !sample.active {
            return;
        }
        self.push_ring(sample);
        self.update_controls(sample);
        self.update_wheels(sample);
    }

    /// Left-hand time weighting, the same rule `SummaryAccumulator` uses: the
    /// interval between two frames is attributed to the earlier sample's
    /// values, which is the only interpretation available without inventing
    /// interpolation between telemetry samples.
    fn accumulate_interval(&mut self, previous: &Sample, _sample: &Sample, interval_ms: u64) {
        if previous
            .throttle
            .is_some_and(|throttle| throttle >= self.config.full_throttle_enter)
        {
            self.full_throttle_ms += interval_ms;
        }
        if let Some(brake) = previous.brake {
            if brake > self.config.braking_enter {
                self.braking_ms += interval_ms;
            }
            if brake >= self.config.hard_braking_enter {
                self.hard_braking_ms += interval_ms;
            }
        }
    }

    fn push_ring(&mut self, sample: &Sample) {
        let retain_ms = self
            .config
            .acceleration_window_ms
            .max(self.config.throttle_lift_window_ms)
            .saturating_mul(2);
        self.ring.push_back(RingSample {
            t_ms: sample.t_ms,
            speed_mps: sample.speed_mps,
            throttle: sample.throttle,
        });
        while self
            .ring
            .front()
            .is_some_and(|front| sample.t_ms.saturating_sub(front.t_ms) > retain_ms)
        {
            self.ring.pop_front();
        }
        while self.ring.len() > RING_CAPACITY {
            self.ring.pop_front();
        }
    }

    fn update_controls(&mut self, sample: &Sample) {
        let config = self.config;
        let throttle = sample.throttle;
        let full_throttle_engaged = throttle.is_some_and(|value| {
            if self.latch_full_throttle.is_open() {
                value >= config.full_throttle_exit
            } else {
                value >= config.full_throttle_enter
            }
        });
        if let Some(event) = self.latch_full_throttle.update(
            sample,
            full_throttle_engaged,
            throttle.unwrap_or_default(),
            throttle.unwrap_or_default(),
            throttle.unwrap_or_default(),
            None,
        ) {
            self.push_event(event);
        }

        let brake = sample.brake;
        let braking_engaged = brake.is_some_and(|value| {
            if self.latch_braking.is_open() {
                value > config.braking_exit
            } else {
                value > config.braking_enter
            }
        });
        if let Some(event) = self.latch_braking.update(
            sample,
            braking_engaged,
            brake.unwrap_or_default(),
            brake.unwrap_or_default(),
            brake.unwrap_or_default(),
            None,
        ) {
            self.push_event(event);
        }

        let hard_engaged = brake.is_some_and(|value| {
            if self.latch_hard_braking.is_open() {
                value >= config.hard_braking_exit
            } else {
                value >= config.hard_braking_enter
            }
        });
        if let Some(event) = self.latch_hard_braking.update(
            sample,
            hard_engaged,
            brake.unwrap_or_default(),
            brake.unwrap_or_default(),
            brake.unwrap_or_default(),
            None,
        ) {
            self.push_event(event);
        }
    }

    /// End both acceleration detectors, flushing anything they held.
    fn close_acceleration(&mut self, at: Option<u64>) {
        let mut produced = Vec::new();
        self.latch_acceleration.close(at, &mut produced);
        self.latch_deceleration.close(at, &mut produced);
        for event in produced {
            self.push_event(event);
        }
    }

    /// Scalar longitudinal acceleration from canonical speed and monotonic
    /// time. The source acceleration vector is deliberately **not** used: its
    /// vehicle-axis orientation is not established, so calling one of its
    /// components "longitudinal" would be an unproven claim. `d(speed)/dt` is
    /// a derivative of two proven quantities and asserts nothing else.
    ///
    /// The difference is taken over at least `acceleration_window_ms`, so one
    /// noisy speed sample cannot produce a large value.
    fn update_acceleration(&mut self, sample: &Sample) {
        let config = self.config;
        let Some(speed) = sample.speed_mps else {
            self.close_acceleration(None);
            return;
        };
        let reference = self
            .ring
            .iter()
            .rev()
            .find(|entry| {
                entry.speed_mps.is_some()
                    && sample.t_ms.saturating_sub(entry.t_ms) >= config.acceleration_window_ms
            })
            .copied();
        let Some(reference) = reference else { return };
        let span_ms = sample.t_ms.saturating_sub(reference.t_ms);
        if span_ms == 0 {
            return;
        }
        let acceleration =
            (speed - reference.speed_mps.unwrap_or_default()) / (span_ms as f32 / 1000.0);
        // A speed change no vehicle could produce is a discontinuity in what
        // was recorded, not a measurement of how the car accelerated. It is
        // counted and excluded; the recorded speed itself is never altered, and
        // RaceLab does not guess which discontinuity it was.
        if acceleration.abs() > config.max_plausible_acceleration_mps2 {
            self.speed_discontinuities += 1;
            self.close_acceleration(None);
            return;
        }
        if acceleration >= 0.0 {
            self.max_acceleration_mps2 = max_option(self.max_acceleration_mps2, Some(acceleration));
        } else {
            self.max_deceleration_mps2 = min_option(self.max_deceleration_mps2, Some(acceleration));
        }

        let accelerating = if self.latch_acceleration.is_open() {
            acceleration >= config.strong_acceleration_exit_mps2
        } else {
            acceleration >= config.strong_acceleration_enter_mps2
        };
        if let Some(event) = self.latch_acceleration.update(
            sample,
            accelerating,
            acceleration,
            acceleration.abs(),
            acceleration,
            None,
        ) {
            self.push_event(event);
        }

        let decelerating = if self.latch_deceleration.is_open() {
            acceleration <= config.strong_deceleration_exit_mps2
        } else {
            acceleration <= config.strong_deceleration_enter_mps2
        };
        if let Some(event) = self.latch_deceleration.update(
            sample,
            decelerating,
            -acceleration,
            acceleration.abs(),
            acceleration,
            None,
        ) {
            self.push_event(event);
        }
    }

    /// A throttle fall of at least `from → to` inside the lift window. Reported
    /// as one instantaneous event, from the sample that held the high value to
    /// the sample that holds the low one, with a cooldown so a single pedal
    /// movement is never reported twice.
    fn update_throttle_lift(&mut self, sample: &Sample) {
        let config = self.config;
        let Some(throttle) = sample.throttle else {
            return;
        };
        if throttle > config.throttle_lift_to {
            return;
        }
        if self
            .last_lift_ms
            .is_some_and(|last| sample.t_ms.saturating_sub(last) < config.throttle_lift_cooldown_ms)
        {
            return;
        }
        let mut best: Option<RingSample> = None;
        for entry in self.ring.iter().rev() {
            if sample.t_ms.saturating_sub(entry.t_ms) > config.throttle_lift_window_ms {
                break;
            }
            let Some(value) = entry.throttle else {
                continue;
            };
            if value >= config.throttle_lift_from
                && best.is_none_or(|current| value > current.throttle.unwrap_or_default())
            {
                best = Some(*entry);
            }
        }
        let Some(high) = best else { return };
        if high.t_ms >= sample.t_ms {
            return;
        }
        let from = high.throttle.unwrap_or_default();
        self.last_lift_ms = Some(sample.t_ms);
        let event = DrivingEventV1 {
            kind: EventKind::RapidThrottleLift,
            corner: None,
            start_ms: high.t_ms,
            end_ms: sample.t_ms,
            duration_ms: sample.t_ms.saturating_sub(high.t_ms),
            entry_speed_mps: high.speed_mps,
            exit_speed_mps: sample.speed_mps,
            min_speed_mps: min_option(high.speed_mps, sample.speed_mps),
            max_speed_mps: max_option(high.speed_mps, sample.speed_mps),
            speed_change_mps: match (high.speed_mps, sample.speed_mps) {
                (Some(entry), Some(exit)) => Some(exit - entry),
                _ => None,
            },
            max_rpm: sample.rpm,
            // The magnitude of the fall, which is what the event is about.
            peak: Some(from - throttle),
            signed_peak: Some(throttle - from),
            peak_combined_slip: None,
        };
        self.push_event(event);
    }

    /// Per-corner slip and suspension detectors.
    ///
    /// Suspension keeps its per-corner latches, because a corner's suspension
    /// excursion genuinely is its own event. Slip does not: one maneuver puts
    /// several corners over threshold on both slip channels at overlapping
    /// times, so slip feeds the episode tracker instead.
    ///
    /// The corner comes from `WHEEL_POSITIONS` and the value from `Wheels::get`
    /// on that same position, so a corner cannot be transposed here.
    fn update_wheels(&mut self, sample: &Sample) {
        let config = self.config;
        self.update_slip(sample);
        let mut produced = Vec::new();
        for (index, position) in WHEEL_POSITIONS.into_iter().enumerate() {
            let travel = sample.wheels.get(position).normalized_suspension_travel;
            let compressed = travel.is_some_and(|value| {
                if self.latch_compression[index].is_open() {
                    value >= config.suspension_compression_exit
                } else {
                    value >= config.suspension_compression_enter
                }
            });
            if let Some(event) = self.latch_compression[index].update(
                sample,
                compressed,
                travel.unwrap_or_default(),
                travel.unwrap_or_default(),
                travel.unwrap_or_default(),
                None,
            ) {
                produced.push(event);
            }

            let extended = travel.is_some_and(|value| {
                if self.latch_extension[index].is_open() {
                    value <= config.suspension_extension_exit
                } else {
                    value <= config.suspension_extension_enter
                }
            });
            if let Some(event) = self.latch_extension[index].update(
                sample,
                extended,
                -travel.unwrap_or_default(),
                travel.unwrap_or_default(),
                travel.unwrap_or_default(),
                None,
            ) {
                produced.push(event);
            }
        }
        for event in produced {
            self.push_event(event);
        }
    }

    /// Advance the slip episode tracker by one sample.
    ///
    /// Per corner and per slip channel this evaluates the same enter/exit
    /// hysteresis the per-corner detectors used before the V0.9 hardening pass,
    /// and counts an engagement lasting at least `slip_min_ms` as a raw
    /// detector event — those counts survive as data quality. What it
    /// *presents*, though, is the union: while any corner on any channel is
    /// over threshold the episode is open, and it stays open across quiet
    /// stretches shorter than `slip_merge_gap_ms`, so one slide is one row.
    fn update_slip(&mut self, sample: &Sample) {
        let config = self.config;
        let mut any_engaged = false;
        let mut engaged_corner = [false; 4];
        let mut engaged_family = [false; 2];
        for (index, position) in WHEEL_POSITIONS.into_iter().enumerate() {
            let wheel = *sample.wheels.get(position);

            let ratio_engaged = wheel.slip_ratio.is_some_and(|value| {
                let magnitude = value.abs();
                if self.slip.ratio_since[index].is_some() {
                    magnitude >= config.slip_ratio_exit
                } else {
                    magnitude >= config.slip_ratio_enter
                }
            });
            if let Some(started) =
                self.slip
                    .engagement(index, SlipFamily::SlipRatio, ratio_engaged, sample.t_ms)
            {
                if self.slip.engaged_span(started) >= config.slip_min_ms {
                    self.slip.ratio_detector_events += 1;
                }
            }

            let combined_engaged = wheel.combined_slip.is_some_and(|value| {
                if self.slip.combined_since[index].is_some() {
                    value >= config.combined_slip_exit
                } else {
                    value >= config.combined_slip_enter
                }
            });
            if let Some(started) = self.slip.engagement(
                index,
                SlipFamily::CombinedSlip,
                combined_engaged,
                sample.t_ms,
            ) {
                if self.slip.engaged_span(started) >= config.slip_min_ms {
                    self.slip.combined_detector_events += 1;
                }
            }

            if ratio_engaged || combined_engaged {
                any_engaged = true;
                engaged_corner[index] = true;
            }
            engaged_family[0] |= ratio_engaged;
            engaged_family[1] |= combined_engaged;
        }

        if !any_engaged {
            // Normal grip. The episode survives a short quiet stretch — that is
            // the merge rule — and closes once grip is clearly back.
            if self
                .slip
                .last_engaged_ms
                .is_some_and(|last| sample.t_ms.saturating_sub(last) > config.slip_merge_gap_ms)
            {
                self.close_slip_episode();
            }
            self.slip.previous_ms = Some(sample.t_ms);
            self.slip.previous_engaged = false;
            return;
        }

        let interval = self
            .slip
            .last_engaged_ms
            .map(|last| sample.t_ms.saturating_sub(last))
            .unwrap_or_default();
        let episode = self.slip.open.get_or_insert_with(|| OpenSlipEpisode {
            start_ms: sample.t_ms,
            end_ms: sample.t_ms,
            engaged_ms: 0,
            entry_speed: sample.speed_mps,
            exit_speed: sample.speed_mps,
            min_speed: sample.speed_mps,
            max_speed: sample.speed_mps,
            corners: [false; 4],
            families: [false; 2],
            max_abs_slip_ratio: CornerValuesV1::default(),
            signed_peak_slip_ratio: CornerValuesV1::default(),
            max_combined_slip: CornerValuesV1::default(),
        });
        // Engaged at both ends, using the same left-hand attribution as every
        // other duration here. A merge gap is never counted as time spent
        // slipping, and neither is a single-frame flicker.
        if self.slip.previous_engaged && interval > 0 && interval <= config.slip_merge_gap_ms {
            episode.engaged_ms += interval;
        }
        episode.end_ms = sample.t_ms;
        episode.exit_speed = sample.speed_mps;
        episode.min_speed = min_option(episode.min_speed, sample.speed_mps);
        episode.max_speed = max_option(episode.max_speed, sample.speed_mps);
        episode.families[0] |= engaged_family[0];
        episode.families[1] |= engaged_family[1];
        for (index, position) in WHEEL_POSITIONS.into_iter().enumerate() {
            if !engaged_corner[index] {
                continue;
            }
            episode.corners[index] = true;
            let wheel = *sample.wheels.get(position);
            if let Some(ratio) = wheel.slip_ratio {
                let magnitude = ratio.abs();
                if episode
                    .max_abs_slip_ratio
                    .get(position)
                    .is_none_or(|current| magnitude > current)
                {
                    episode.max_abs_slip_ratio.set(position, Some(magnitude));
                    episode.signed_peak_slip_ratio.set(position, Some(ratio));
                }
            }
            episode
                .max_combined_slip
                .observe_max(position, wheel.combined_slip);
        }
        self.slip.last_engaged_ms = Some(sample.t_ms);
        self.slip.previous_ms = Some(sample.t_ms);
        self.slip.previous_engaged = true;
    }

    /// Finish the open episode. Emitted only when the time actually spent above
    /// threshold reaches `slip_min_ms`: an episode is real because of how long
    /// the car was slipping, not because its first and last slip were far apart.
    fn close_slip_episode(&mut self) {
        self.slip.last_engaged_ms = None;
        self.slip.previous_ms = None;
        self.slip.previous_engaged = false;
        self.slip.ratio_since = [None; 4];
        self.slip.combined_since = [None; 4];
        let Some(episode) = self.slip.open.take() else {
            return;
        };
        if episode.engaged_ms < self.config.slip_min_ms {
            return;
        }
        self.slip_episodes_detected += 1;
        self.slip_episode_ms += episode.engaged_ms;
        if self.slip_episodes.len() >= self.config.max_slip_episodes {
            return;
        }
        let corners: Vec<WheelPosition> = WHEEL_POSITIONS
            .into_iter()
            .enumerate()
            .filter(|(index, _)| episode.corners[*index])
            .map(|(_, position)| position)
            .collect();
        let families: Vec<SlipFamily> = SLIP_FAMILIES
            .into_iter()
            .enumerate()
            .filter(|(index, _)| episode.families[*index])
            .map(|(_, family)| family)
            .collect();
        let peak_of = |values: &CornerValuesV1| {
            WHEEL_POSITIONS
                .into_iter()
                .filter_map(|position| values.get(position))
                .fold(None, |best: Option<f32>, value| {
                    Some(best.map_or(value, |current| current.max(value)))
                })
        };
        self.slip_episodes.push(SlipEpisodeV1 {
            index: self.slip_episodes.len() as u32 + 1,
            start_ms: episode.start_ms,
            end_ms: episode.end_ms,
            duration_ms: episode.end_ms.saturating_sub(episode.start_ms),
            engaged_seconds: episode.engaged_ms as f64 / 1000.0,
            corners,
            families,
            entry_speed_mps: episode.entry_speed,
            min_speed_mps: episode.min_speed,
            max_speed_mps: episode.max_speed,
            exit_speed_mps: episode.exit_speed,
            peak_abs_slip_ratio: peak_of(&episode.max_abs_slip_ratio),
            peak_combined_slip: peak_of(&episode.max_combined_slip),
            max_abs_slip_ratio: episode.max_abs_slip_ratio,
            signed_peak_slip_ratio: episode.signed_peak_slip_ratio,
            max_combined_slip: episode.max_combined_slip,
        });
    }

    /// Statistics for one interval inside a turn segment, attributed to the
    /// earlier sample exactly as elsewhere.
    fn turn_interval_stats(
        &self,
        previous: &Sample,
        sample: &Sample,
        interval_ms: u64,
        yaw_delta: f64,
        rate: f64,
    ) -> TurnStats {
        let seconds = interval_ms as f64 / 1000.0;
        let mut stats = TurnStats {
            yaw_change: yaw_delta,
            peak_rate: rate.abs(),
            exit_speed: sample.speed_mps,
            min_speed: min_option(previous.speed_mps, sample.speed_mps),
            max_speed: max_option(previous.speed_mps, sample.speed_mps),
            ..TurnStats::default()
        };
        if let Some(speed) = previous.speed_mps {
            stats.speed_weighted = f64::from(speed) * seconds;
            stats.speed_seconds = seconds;
        }
        if let Some(brake) = previous.brake {
            stats.max_brake = Some(brake);
            if brake > self.config.braking_enter {
                stats.brake_ms = interval_ms;
            }
        }
        if let Some(throttle) = previous.throttle {
            if throttle > 0.0 {
                stats.throttle_ms = interval_ms;
            }
            if throttle >= self.config.full_throttle_enter {
                stats.full_throttle_ms = interval_ms;
            }
        }
        for position in WHEEL_POSITIONS {
            let wheel = previous.wheels.get(position);
            stats
                .max_abs_slip
                .observe_max(position, wheel.slip_ratio.map(f32::abs));
            stats
                .max_combined_slip
                .observe_max(position, wheel.combined_slip);
            stats
                .max_compression
                .observe_max(position, wheel.normalized_suspension_travel);
        }
        stats
    }

    /// Conservative yaw-rate segmentation.
    ///
    /// Yaw rate is the wrap-corrected difference of canonical yaw over the
    /// monotonic interval. A segment opens when the rate exceeds the enter
    /// threshold while the car is above the minimum speed, and closes when the
    /// rate has stayed under the exit threshold for the hold window, when the
    /// rate reverses direction past the enter threshold, or when a gap, an
    /// inactive frame or the end of the stream intervenes.
    fn update_turn(&mut self, previous: &Sample, sample: &Sample, interval_ms: u64) {
        let config = self.config;
        let (Some(yaw), Some(previous_yaw)) = (sample.yaw_rad, previous.yaw_rad) else {
            self.close_turn();
            return;
        };
        let yaw_delta = wrap_angle(f64::from(yaw) - f64::from(previous_yaw));
        let rate = yaw_delta / (interval_ms as f64 / 1000.0);
        let fast_enough = sample
            .speed_mps
            .is_some_and(|speed| speed >= config.turn_min_speed_mps);
        let stats = self.turn_interval_stats(previous, sample, interval_ms, yaw_delta, rate);

        let engaged = fast_enough && rate.abs() >= config.turn_yaw_rate_exit_rad_s;
        let strong = fast_enough && rate.abs() >= config.turn_yaw_rate_enter_rad_s;

        if let Some(turn) = &mut self.turn {
            let reversed = strong && rate.signum() != turn.direction;
            if reversed {
                self.close_turn();
                self.open_turn(previous, sample, rate, &stats);
                return;
            }
            if engaged {
                let mut merged = turn.pending;
                merged.merge(&stats);
                turn.stats.merge(&merged);
                turn.pending = TurnStats::default();
                turn.engaged_ms = sample.t_ms;
                turn.below_since_ms = None;
            } else {
                turn.pending.merge(&stats);
                let since = *turn.below_since_ms.get_or_insert(sample.t_ms);
                if sample.t_ms.saturating_sub(since) >= config.turn_exit_hold_ms {
                    self.close_turn();
                }
            }
            return;
        }
        if strong {
            self.open_turn(previous, sample, rate, &stats);
        }
    }

    fn open_turn(&mut self, previous: &Sample, sample: &Sample, rate: f64, stats: &TurnStats) {
        let mut opened = TurnState {
            start_ms: previous.t_ms,
            engaged_ms: sample.t_ms,
            direction: rate.signum(),
            entry_speed: previous.speed_mps,
            stats: TurnStats::default(),
            pending: TurnStats::default(),
            below_since_ms: None,
        };
        opened.stats.merge(stats);
        self.turn = Some(opened);
    }

    /// Close the open segment at its last engaged sample, discarding the
    /// pending tail. A segment shorter than the minimum duration is dropped: a
    /// brief flick of the wheel is not a turn.
    fn close_turn(&mut self) {
        let Some(turn) = self.turn.take() else { return };
        let duration_ms = turn.engaged_ms.saturating_sub(turn.start_ms);
        if duration_ms < self.config.turn_min_duration_ms {
            return;
        }
        // Yaw *rate* alone cannot tell a gentle curve from a second of steering
        // correction that ends where it started: both cross the rate threshold,
        // but only one turns the car. Requiring a minimum net heading change
        // rejects the second without touching wraparound handling, direction
        // splitting, gap behaviour or the speed gate.
        if turn.stats.yaw_change.abs() < self.config.turn_min_abs_yaw_change_rad {
            return;
        }
        self.turn_segments_detected += 1;
        if self.turn_segments.len() >= self.config.max_turn_segments {
            return;
        }
        let seconds = duration_ms as f64 / 1000.0;
        let stats = turn.stats;
        self.turn_segments.push(TurnSegmentV1 {
            index: self.turn_segments.len() as u32 + 1,
            start_ms: turn.start_ms,
            end_ms: turn.engaged_ms,
            duration_ms,
            signed_yaw_change_rad: stats.yaw_change,
            mean_yaw_rate_rad_s: if seconds > 0.0 {
                stats.yaw_change / seconds
            } else {
                0.0
            },
            peak_yaw_rate_rad_s: stats.peak_rate,
            entry_speed_mps: turn.entry_speed,
            min_speed_mps: stats.min_speed,
            exit_speed_mps: stats.exit_speed,
            max_speed_mps: stats.max_speed,
            average_speed_mps: (stats.speed_seconds > 0.0)
                .then(|| (stats.speed_weighted / stats.speed_seconds) as f32),
            brake_seconds: stats.brake_ms as f64 / 1000.0,
            throttle_seconds: stats.throttle_ms as f64 / 1000.0,
            full_throttle_seconds: stats.full_throttle_ms as f64 / 1000.0,
            max_brake: stats.max_brake,
            max_abs_slip_ratio: stats.max_abs_slip,
            max_combined_slip: stats.max_combined_slip,
            max_suspension_compression: stats.max_compression,
        });
    }

    /// Close everything still open and produce the analysis.
    ///
    /// `frame_stream_complete` reports whether the stream carried its footer. A
    /// recording interrupted by a crash keeps an append-only prefix that is
    /// perfectly analysable; the analysis says so rather than refusing it.
    pub fn finish(mut self, frame_stream_complete: bool) -> SessionAnalysisV1 {
        let last = self.previous.map(|sample| sample.t_ms).unwrap_or_default();
        self.close_all(last);
        // Time order, then a stable tiebreak, so two runs over one stream
        // always produce byte-identical output.
        self.events.sort_by(|a, b| {
            a.start_ms
                .cmp(&b.start_ms)
                .then_with(|| a.end_ms.cmp(&b.end_ms))
                .then_with(|| kind_index(a.kind).cmp(&kind_index(b.kind)))
                .then_with(|| a.corner.map(corner_index).cmp(&b.corner.map(corner_index)))
        });
        for (index, segment) in self.turn_segments.iter_mut().enumerate() {
            segment.index = index as u32 + 1;
        }
        // Episodes close in time order already; renumbering keeps the index a
        // presentation ordinal rather than a detection counter.
        self.slip_episodes.sort_by_key(|episode| episode.start_ms);
        for (index, episode) in self.slip_episodes.iter_mut().enumerate() {
            episode.index = index as u32 + 1;
        }
        let first_monotonic_ms = self.first_monotonic_ms.unwrap_or_default();
        SessionAnalysisV1 {
            schema_version: ANALYSIS_SCHEMA_VERSION,
            session_id: self.session_id.clone(),
            telemetry_frame_schema_version: self.telemetry_frame_schema_version,
            analyzed_at_unix_ms: unix_ms(),
            // Filled in by the job runner, which is the only caller that knows
            // when the session was queued. An offline analysis leaves them null
            // rather than inventing a queue wait it never had.
            requested_at_unix_ms: None,
            queued_ms: None,
            analysis_duration_ms: self.started.elapsed().as_millis() as u64,
            analyzed_by_racelab_version: env!("CARGO_PKG_VERSION").into(),
            config: self.config,
            coverage: AnalysisCoverageV1 {
                first_monotonic_ms,
                last_monotonic_ms: self.last_monotonic_ms,
                recorded_seconds: self.last_monotonic_ms.saturating_sub(first_monotonic_ms) as f64
                    / 1000.0,
                analyzed_seconds: self.analyzed_ms as f64 / 1000.0,
                excluded_gap_count: self.excluded_gap_count,
                excluded_gap_seconds: self.excluded_gap_ms as f64 / 1000.0,
                inactive_interval_count: self.inactive_interval_count,
                inactive_interval_seconds: self.inactive_interval_ms as f64 / 1000.0,
            },
            driving_summary: DrivingSummaryV1 {
                event_count: self.kind_detected.iter().sum(),
                slip_episode_count: self.slip_episodes_detected,
                slip_episode_seconds: self.slip_episode_ms as f64 / 1000.0,
                turn_segment_count: self.turn_segments_detected,
                events_by_kind: EVENT_KINDS
                    .iter()
                    .enumerate()
                    .map(|(index, kind)| EventCountV1 {
                        kind: *kind,
                        count: self.kind_detected[index],
                    })
                    .collect(),
                full_throttle_seconds: self.full_throttle_ms as f64 / 1000.0,
                braking_seconds: self.braking_ms as f64 / 1000.0,
                hard_braking_seconds: self.hard_braking_ms as f64 / 1000.0,
                max_speed_mps: self.max_speed_mps,
                max_longitudinal_acceleration_mps2: self.max_acceleration_mps2,
                max_longitudinal_deceleration_mps2: self.max_deceleration_mps2,
            },
            data_quality: AnalysisDataQualityV1 {
                telemetry_frame_schema_version: self.telemetry_frame_schema_version,
                frames_read: self.frames_read,
                active_frames: self.active_frames,
                inactive_frames: self.inactive_frames,
                zero_interval_frames: self.zero_interval_frames,
                speed_discontinuities: self.speed_discontinuities,
                frame_stream_complete,
                speed_available: self.speed_available,
                controls_available: self.controls_available,
                engine_available: self.engine_available,
                orientation_available: self.orientation_available,
                wheel_telemetry_available: self.wheel_telemetry_available,
                suspension_available: self.suspension_available,
                events_truncated: self.events_truncated,
                slip_episodes_truncated: self
                    .slip_episodes_detected
                    .saturating_sub(self.slip_episodes.len() as u64),
                turn_segments_truncated: self
                    .turn_segments_detected
                    .saturating_sub(self.turn_segments.len() as u64),
                slip_ratio_detector_events: self.slip.ratio_detector_events,
                combined_slip_detector_events: self.slip.combined_detector_events,
            },
            events: self.events,
            slip_episodes: self.slip_episodes,
            turn_segments: self.turn_segments,
        }
    }
}

fn corner_index(position: WheelPosition) -> usize {
    WHEEL_POSITIONS
        .iter()
        .position(|candidate| *candidate == position)
        .unwrap_or(0)
}

/// Analyze an open frame stream. Records are consumed one at a time and
/// dropped; nothing accumulates but the bounded state above.
pub fn analyze_stream<R: io::Read>(
    mut reader: FrameStreamReader<R>,
    config: AnalysisConfigV1,
) -> io::Result<SessionAnalysisV1> {
    let mut accumulator = AnalysisAccumulator::new(
        reader.header.session_id.clone(),
        reader.header.telemetry_frame_schema_version,
        config,
    );
    while let Some(record) = reader.next_frame()? {
        accumulator.observe(&record);
    }
    Ok(accumulator.finish(reader.end.is_some()))
}

/// Analyze `<directory>/frames.rlframes`. A decode failure propagates: a
/// corrupt stream produces no analysis at all rather than a partial one that
/// would look complete.
pub fn analyze_session_directory(
    directory: &Path,
    config: AnalysisConfigV1,
) -> io::Result<SessionAnalysisV1> {
    let file = File::open(directory.join(FRAME_FILE_NAME))?;
    let reader = FrameStreamReader::new(BufReader::new(file))?;
    analyze_stream(reader, config)
}
