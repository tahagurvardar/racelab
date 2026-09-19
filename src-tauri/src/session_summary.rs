//! Streaming session statistics. Constant memory: one previous sample, never
//! the session history. All durations come from monotonic frame timing.
use crate::telemetry::{Gear, TelemetryFrame};
use serde::{Deserialize, Serialize};

/// RaceLab V0.6 definitions. These are explicit product definitions, not
/// measurements derived from any game's own telemetry semantics.
pub const FULL_THROTTLE_THRESHOLD: f32 = 0.95;
pub const BRAKING_THRESHOLD: f32 = 0.05;
/// Intervals longer than this are telemetry gaps, not measured driving. They
/// are excluded from every time-weighted statistic and counted separately, so a
/// pause or a burst of recorder drops cannot silently inflate a duration.
pub const MAX_SAMPLE_GAP_MS: u64 = 1000;
/// Distance is only reported when speed covers effectively the whole measured
/// interval time; a partially covered session reports null instead of a guess.
pub const DISTANCE_COVERAGE: f64 = 0.99;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DataQualityV1 {
    pub recorder_dropped_frames: u64,
    /// True only when nothing was dropped and the writer reported no error.
    pub complete: bool,
    /// Inter-frame gaps excluded from time-weighted statistics.
    pub excluded_gaps: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionSummaryV1 {
    /// Authoritative `SessionEngine` duration, including grace.
    pub duration_seconds: f64,
    /// Total accepted inter-frame time. This is *not* the denominator of the
    /// percentages below: each percentage divides by the time its own channel
    /// was actually available, so a partially reported channel never distorts
    /// its own share.
    pub measured_seconds: f64,
    pub frame_count: u64,
    pub max_speed_kmh: Option<f64>,
    /// Time-weighted, never a naive mean of samples.
    pub average_speed_kmh: Option<f64>,
    pub max_rpm: Option<f64>,
    pub average_rpm: Option<f64>,
    pub full_throttle_seconds: f64,
    /// Share of the time throttle was available, not of `measured_seconds`.
    pub full_throttle_percent: Option<f64>,
    pub braking_seconds: f64,
    /// Share of the time brake was available, not of `measured_seconds`.
    pub braking_percent: Option<f64>,
    /// Null until an adapter supplies canonical gear; FH6 does not yet.
    pub gear_change_count: Option<u64>,
    /// Speed integrated over monotonic time, or null. Not a game odometer.
    pub distance_meters: Option<f64>,
    pub data_quality: DataQualityV1,
}

#[derive(Debug, Clone, Copy, Default)]
struct Channel {
    seconds: f64,
    weighted: f64,
}

impl Channel {
    fn add(&mut self, value: f64, seconds: f64) {
        self.seconds += seconds;
        self.weighted += value * seconds;
    }
    fn average(self) -> Option<f64> {
        (self.seconds > 0.0).then(|| self.weighted / self.seconds)
    }
}

#[derive(Debug, Clone, Copy)]
struct Sample {
    monotonic_ms: u64,
    speed_mps: Option<f32>,
    rpm: Option<f32>,
    throttle: Option<f32>,
    brake: Option<f32>,
}

impl Sample {
    fn of(frame: &TelemetryFrame, monotonic_ms: u64) -> Self {
        Self {
            monotonic_ms,
            speed_mps: frame.speed_mps,
            rpm: frame.engine.rpm,
            throttle: frame.controls.throttle,
            brake: frame.controls.brake,
        }
    }
}

/// Left-hand time weighting: the interval between two frames is attributed to
/// the earlier sample's values, which is the only interpretation available
/// without inventing interpolation between telemetry samples.
#[derive(Debug, Clone, Default)]
pub struct SummaryAccumulator {
    frame_count: u64,
    previous: Option<Sample>,
    previous_gear: Option<Gear>,
    gear_samples: u64,
    gear_changes: u64,
    measured_ms: u64,
    excluded_gaps: u64,
    max_speed_mps: Option<f32>,
    max_rpm: Option<f32>,
    speed: Channel,
    rpm: Channel,
    throttle: Channel,
    brake: Channel,
    full_throttle_ms: u64,
    braking_ms: u64,
    distance_meters: f64,
}

impl SummaryAccumulator {
    pub fn observe(&mut self, frame: &TelemetryFrame, monotonic_ms: u64) {
        self.frame_count += 1;
        if let Some(speed) = frame.speed_mps {
            self.max_speed_mps = Some(self.max_speed_mps.map_or(speed, |v| v.max(speed)));
        }
        if let Some(rpm) = frame.engine.rpm {
            self.max_rpm = Some(self.max_rpm.map_or(rpm, |v| v.max(rpm)));
        }
        if let Some(gear) = frame.gear {
            self.gear_samples += 1;
            if self.previous_gear.is_some_and(|previous| previous != gear) {
                self.gear_changes += 1;
            }
            self.previous_gear = Some(gear);
        }
        let sample = Sample::of(frame, monotonic_ms);
        if let Some(previous) = self.previous {
            let gap = monotonic_ms.saturating_sub(previous.monotonic_ms);
            if gap == 0 || gap > MAX_SAMPLE_GAP_MS {
                if gap > MAX_SAMPLE_GAP_MS {
                    self.excluded_gaps += 1;
                }
            } else {
                let seconds = gap as f64 / 1000.0;
                self.measured_ms += gap;
                if let Some(speed) = previous.speed_mps {
                    let speed = f64::from(speed);
                    self.speed.add(speed, seconds);
                    self.distance_meters += speed * seconds;
                }
                if let Some(rpm) = previous.rpm {
                    self.rpm.add(f64::from(rpm), seconds);
                }
                if let Some(throttle) = previous.throttle {
                    self.throttle.add(f64::from(throttle), seconds);
                    if throttle >= FULL_THROTTLE_THRESHOLD {
                        self.full_throttle_ms += gap;
                    }
                }
                if let Some(brake) = previous.brake {
                    self.brake.add(f64::from(brake), seconds);
                    if brake > BRAKING_THRESHOLD {
                        self.braking_ms += gap;
                    }
                }
            }
        }
        self.previous = Some(sample);
    }

    pub fn frame_count(&self) -> u64 {
        self.frame_count
    }

    pub fn finish(
        &self,
        duration_us: u64,
        recorder_dropped_frames: u64,
        complete: bool,
    ) -> SessionSummaryV1 {
        let measured_seconds = self.measured_ms as f64 / 1000.0;
        let full_throttle_seconds = self.full_throttle_ms as f64 / 1000.0;
        let braking_seconds = self.braking_ms as f64 / 1000.0;
        let percent = |seconds: f64, channel: Channel| {
            (channel.seconds > 0.0).then(|| seconds / channel.seconds * 100.0)
        };
        SessionSummaryV1 {
            duration_seconds: duration_us as f64 / 1_000_000.0,
            measured_seconds,
            frame_count: self.frame_count,
            max_speed_kmh: self.max_speed_mps.map(|v| f64::from(v) * 3.6),
            average_speed_kmh: self.speed.average().map(|v| v * 3.6),
            max_rpm: self.max_rpm.map(f64::from),
            average_rpm: self.rpm.average(),
            full_throttle_seconds,
            full_throttle_percent: percent(full_throttle_seconds, self.throttle),
            braking_seconds,
            braking_percent: percent(braking_seconds, self.brake),
            gear_change_count: (self.gear_samples > 0).then_some(self.gear_changes),
            distance_meters: (self.frame_count >= 2
                && self.speed.seconds >= measured_seconds * DISTANCE_COVERAGE
                && self.speed.seconds > 0.0)
                .then_some(self.distance_meters),
            data_quality: DataQualityV1 {
                recorder_dropped_frames,
                complete: complete && recorder_dropped_frames == 0,
                excluded_gaps: self.excluded_gaps,
            },
        }
    }
}
