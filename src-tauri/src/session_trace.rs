//! Bounded, read-only channel traces of recorded sessions (v2.1 M1).
//!
//! The first and only path by which recorded telemetry reaches the frontend.
//! It is deliberately narrow: a fixed allowlist of five canonical channels,
//! reduced in the backend to at most `MAX_BUCKETS` min/max buckets. A frame, a
//! sample, `sourceSpecific`, a packet byte, a vehicle identifier or a game
//! session UID is never part of a trace.
//!
//! Both games are read through their existing streaming readers
//! (`session_format::FrameStreamReader`, `f1_session::SampleStreamReader`),
//! which hold one record at a time. A trace makes two passes over the stream:
//! the first establishes the exact time span and checks the whole stream reads
//! cleanly, the second fills the buckets. Peak memory is therefore one record
//! plus `channels × buckets` accumulators plus at most `MAX_GAPS` gap entries,
//! whatever the length of the recording.
//!
//! Rules, in the same spirit as the session summary and the analysis:
//!
//! - **Null stays null.** A value the recording does not carry is counted as
//!   missing and never becomes 0. A genuine 0 is a sample like any other.
//! - **Units are the recording's own.** No unit is converted here; each
//!   channel states its unit. Presentation conversion belongs to
//!   `src/telemetry/formatting.ts`.
//! - **Gaps are reported, not bridged.** An interval between two consecutive
//!   records longer than `GAP_THRESHOLD_MS` is listed, so a chart can break its
//!   line there instead of joining across it.
//! - **Damage is not repaired.** A stream that stops part-way through its last
//!   record yields its intact prefix and says so; damage in the middle of a
//!   stream yields no trace at all.
//! - **Completed sessions only** in this milestone. A session still recording
//!   or interrupted is refused with its own error kind.
use crate::{
    f1_session::{self, SampleStreamReader, SessionGame},
    session_format::{self, FrameStreamReader, SessionStatus},
};
use serde::{Deserialize, Serialize};
use std::{
    fmt,
    fs::File,
    io::{self, BufReader},
    path::Path,
};

pub const TRACE_SCHEMA_VERSION: u32 = 1;
/// Hard upper bound on buckets per channel.
pub const MAX_BUCKETS: u32 = 2000;
pub const DEFAULT_BUCKETS: u32 = 1000;
/// Every allowlisted channel at most once.
pub const MAX_CHANNELS: usize = TraceChannel::ALL.len();
/// Gap intervals stored per trace. Further gaps are counted, not stored.
pub const MAX_GAPS: usize = 512;
/// The same threshold the session summary uses to exclude telemetry gaps
/// (`session_summary::MAX_SAMPLE_GAP_MS`).
pub const GAP_THRESHOLD_MS: u64 = 1000;
/// Upper bound on a serialized trace. Structural, not checked at runtime:
/// five channels × `MAX_BUCKETS` × (two `f32`s and two counts) plus
/// `MAX_GAPS` gaps stays well below it (`tests/session_trace.rs` measures the
/// worst case).
pub const MAX_RESPONSE_BYTES: usize = 1 << 20;

/// The channel allowlist. Anything else is rejected when the request is
/// deserialized, before a file is opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TraceChannel {
    Speed,
    Rpm,
    Throttle,
    Brake,
    Steering,
}

impl TraceChannel {
    pub const ALL: [TraceChannel; 5] = [
        TraceChannel::Speed,
        TraceChannel::Rpm,
        TraceChannel::Throttle,
        TraceChannel::Brake,
        TraceChannel::Steering,
    ];

    fn index(self) -> usize {
        self as usize
    }

    /// The unit the recording itself stores. FH6 stores canonical speed in
    /// m/s; F1 25 stores the game's own integer km/h.
    fn unit(self, game: SessionGame) -> TraceUnit {
        match (self, game) {
            (TraceChannel::Speed, SessionGame::Fh6) => TraceUnit::MetresPerSecond,
            (TraceChannel::Speed, SessionGame::F1_25) => TraceUnit::KilometresPerHour,
            (TraceChannel::Rpm, _) => TraceUnit::RevolutionsPerMinute,
            (TraceChannel::Throttle | TraceChannel::Brake, _) => TraceUnit::Ratio0To1,
            (TraceChannel::Steering, _) => TraceUnit::RatioMinus1To1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TraceUnit {
    MetresPerSecond,
    KilometresPerHour,
    RevolutionsPerMinute,
    /// Normalized pedal position, 0..=1 as recorded.
    #[serde(rename = "ratio_0_1")]
    Ratio0To1,
    /// Normalized steering, -1..=1 as recorded.
    #[serde(rename = "ratio_-1_1")]
    RatioMinus1To1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TraceErrorKind {
    /// Not a RaceLab session identifier. No path was built from it.
    UnsafeSessionId,
    /// The request itself is outside the allowlist or the bounds.
    InvalidRequest,
    /// No session directory, or no recording in it.
    NotFound,
    /// The session is still being recorded.
    SessionRecording,
    /// The session was interrupted. Partial traces are a later milestone.
    SessionInterrupted,
    /// Metadata or stream this build cannot read (missing, unsupported
    /// version, or an unreadable header).
    Unreadable,
    /// The stream is damaged before its end. No partial trace is produced.
    Damaged,
    /// The stream changed between the two passes.
    ChangedDuringRead,
}

/// A typed refusal. `kind` is stable for the frontend; `message` is for
/// people.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TraceError {
    pub kind: TraceErrorKind,
    pub message: String,
}

impl TraceError {
    fn new(kind: TraceErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

impl fmt::Display for TraceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TraceError {}

/// Which recording a trace was read from, and how much of it is trustworthy.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TraceSourceV1 {
    /// `rlframes` (FH6) or `rlf1` (F1 25).
    pub format: &'static str,
    pub container_version: u32,
    /// FH6 telemetry frame schema, or F1 sample schema.
    pub payload_schema_version: u32,
    pub recorded_by_racelab_version: String,
    /// `None` for FH6, whose rate is paced by the game; 10 for F1 25.
    pub nominal_sample_rate_hz: Option<u32>,
    /// The stream carried its end marker.
    pub stream_complete: bool,
    /// The stream stopped part-way through its final record; the trace is
    /// its intact prefix.
    pub truncated_tail: bool,
    /// The record count the end marker declares, when present.
    pub declared_records: Option<u64>,
    /// FH6: frames the recorder queue dropped for this session.
    pub recorder_dropped_frames: Option<u64>,
    /// F1 25: the recorder's own integrity counts.
    pub f1_integrity: Option<F1TraceIntegrityV1>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct F1TraceIntegrityV1 {
    pub idle_ticks: u64,
    pub late_ticks: u64,
    pub telemetry_gaps: u64,
    pub out_of_order_dropped: u64,
}

/// The trace's time axis. Times are milliseconds from the first readable
/// record, on the recording's monotonic clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TraceTimeV1 {
    /// Always `first_record`.
    pub origin: &'static str,
    pub unit: &'static str,
    /// Time of the last readable record. 0 for an empty or single-record
    /// stream.
    pub span_ms: u64,
    pub records: u64,
    /// Bucket `i` covers `[i * bucket_width_ms, (i + 1) * bucket_width_ms)`.
    pub bucket_width_ms: u64,
    pub bucket_count: u32,
    /// Longest interval between consecutive records.
    pub max_interval_ms: u64,
}

/// One interval with no record for longer than `GAP_THRESHOLD_MS`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TraceGapV1 {
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TraceGapsV1 {
    pub threshold_ms: u64,
    pub total: u64,
    /// The first `MAX_GAPS` gaps, in time order.
    pub stored: Vec<TraceGapV1>,
}

/// One channel, bucket-aligned. Every array has `bucket_count` entries.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TraceChannelV1 {
    pub channel: TraceChannel,
    pub unit: TraceUnit,
    /// `null` where the bucket holds no sample of this channel.
    pub min: Vec<Option<f32>>,
    pub max: Vec<Option<f32>>,
    /// Records in the bucket that carried a finite value.
    pub samples: Vec<u32>,
    /// Records in the bucket that did not: the value was unavailable, or for
    /// F1 25 the sample carried no new Car Telemetry packet, or the value was
    /// not finite.
    pub missing: Vec<u32>,
    pub total_samples: u64,
    pub total_missing: u64,
    /// Of `total_missing`, values that were present but NaN or infinite.
    pub total_non_finite: u64,
}

/// `get_session_trace`'s response.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SessionTraceV1 {
    pub schema_version: u32,
    pub session_id: String,
    pub game: SessionGame,
    pub source: TraceSourceV1,
    pub time: TraceTimeV1,
    /// Records per bucket, whatever they carried.
    pub bucket_records: Vec<u32>,
    pub gaps: TraceGapsV1,
    pub channels: Vec<TraceChannelV1>,
}

/// A validated request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraceRequest {
    pub channels: Vec<TraceChannel>,
    pub buckets: u32,
}

impl TraceRequest {
    pub fn new(channels: Vec<TraceChannel>, buckets: Option<u32>) -> Result<Self, TraceError> {
        let invalid = |message: &str| TraceError::new(TraceErrorKind::InvalidRequest, message);
        if channels.is_empty() {
            return Err(invalid("At least one channel is required."));
        }
        if channels.len() > MAX_CHANNELS {
            return Err(invalid("Too many channels requested."));
        }
        for (index, channel) in channels.iter().enumerate() {
            if channels[..index].contains(channel) {
                return Err(invalid("A channel was requested more than once."));
            }
        }
        let buckets = buckets.unwrap_or(DEFAULT_BUCKETS);
        if !(1..=MAX_BUCKETS).contains(&buckets) {
            return Err(invalid("Bucket count is outside 1..=2000."));
        }
        Ok(Self { channels, buckets })
    }
}

// ---------------------------------------------------------------- sources

/// One record reduced to what a trace may see: its time and the five
/// allowlisted values, indexed by `TraceChannel::index`.
type Values = [Option<f32>; 5];

trait TraceSource {
    fn next_record(&mut self) -> io::Result<Option<(u64, Values)>>;
    fn stream_complete(&self) -> bool;
    fn truncated_tail(&self) -> bool;
    fn declared_records(&self) -> Option<u64>;
}

struct Fh6Source(FrameStreamReader<BufReader<File>>);

impl TraceSource for Fh6Source {
    fn next_record(&mut self) -> io::Result<Option<(u64, Values)>> {
        // Monotonic order is enforced by the reader itself.
        Ok(self.0.next_frame_lossy()?.map(|record| {
            let frame = &record.frame;
            (
                record.monotonic_ms,
                [
                    frame.speed_mps,
                    frame.engine.rpm,
                    frame.controls.throttle,
                    frame.controls.brake,
                    frame.controls.steering,
                ],
            )
        }))
    }

    fn stream_complete(&self) -> bool {
        self.0.end.is_some()
    }

    fn truncated_tail(&self) -> bool {
        self.0.truncated_tail
    }

    fn declared_records(&self) -> Option<u64> {
        self.0.end.map(|end| end.frame_count)
    }
}

struct F1Source {
    reader: SampleStreamReader<BufReader<File>>,
    last_monotonic_ms: u64,
}

impl TraceSource for F1Source {
    fn next_record(&mut self) -> io::Result<Option<(u64, Values)>> {
        let Some(sample) = self.reader.next_sample_lossy()? else {
            return Ok(None);
        };
        // The F1 reader does not check ordering; a trace must.
        if sample.monotonic_ms < self.last_monotonic_ms {
            return Err(session_format::invalid("Decreasing monotonic sample time"));
        }
        self.last_monotonic_ms = sample.monotonic_ms;
        // Only Car Telemetry carries these channels. A sample without it had
        // no new Car Telemetry packet, so every channel is missing there.
        let values = match sample.telemetry {
            Some(t) => [
                Some(f32::from(t.speed_kmh)),
                Some(f32::from(t.engine_rpm)),
                Some(t.throttle),
                Some(t.brake),
                Some(t.steer),
            ],
            None => [None; 5],
        };
        Ok(Some((sample.monotonic_ms, values)))
    }

    fn stream_complete(&self) -> bool {
        self.reader.end.is_some()
    }

    fn truncated_tail(&self) -> bool {
        self.reader.truncated_tail
    }

    fn declared_records(&self) -> Option<u64> {
        self.reader.end.map(|end| end.sample_count)
    }
}

fn open_fh6(directory: &Path, session_id: &str) -> io::Result<Fh6Source> {
    let file = File::open(directory.join(session_format::FRAME_FILE_NAME))?;
    let reader = FrameStreamReader::new(BufReader::new(file))?;
    if reader.header.session_id != session_id {
        return Err(session_format::invalid(
            "Frame stream belongs to another session",
        ));
    }
    Ok(Fh6Source(reader))
}

fn open_f1(directory: &Path, session_id: &str) -> io::Result<F1Source> {
    let file = File::open(directory.join(f1_session::SAMPLES_FILE_NAME))?;
    let reader = SampleStreamReader::new(BufReader::new(file))?;
    if reader.header.session_id != session_id {
        return Err(session_format::invalid(
            "Sample stream belongs to another session",
        ));
    }
    Ok(F1Source {
        reader,
        last_monotonic_ms: 0,
    })
}

// ------------------------------------------------------------- reduction

struct ChannelAccumulator {
    min: Vec<Option<f32>>,
    max: Vec<Option<f32>>,
    samples: Vec<u32>,
    missing: Vec<u32>,
    total_non_finite: u64,
}

impl ChannelAccumulator {
    fn new(buckets: usize) -> Self {
        Self {
            min: vec![None; buckets],
            max: vec![None; buckets],
            samples: vec![0; buckets],
            missing: vec![0; buckets],
            total_non_finite: 0,
        }
    }

    fn observe(&mut self, bucket: usize, value: Option<f32>) {
        match value {
            Some(value) if value.is_finite() => {
                self.min[bucket] = Some(self.min[bucket].map_or(value, |m| m.min(value)));
                self.max[bucket] = Some(self.max[bucket].map_or(value, |m| m.max(value)));
                self.samples[bucket] = self.samples[bucket].saturating_add(1);
            }
            Some(_) => {
                self.total_non_finite += 1;
                self.missing[bucket] = self.missing[bucket].saturating_add(1);
            }
            None => self.missing[bucket] = self.missing[bucket].saturating_add(1),
        }
    }

    fn finish(self, channel: TraceChannel, game: SessionGame) -> TraceChannelV1 {
        TraceChannelV1 {
            channel,
            unit: channel.unit(game),
            total_samples: self.samples.iter().map(|&n| u64::from(n)).sum(),
            total_missing: self.missing.iter().map(|&n| u64::from(n)).sum(),
            total_non_finite: self.total_non_finite,
            min: self.min,
            max: self.max,
            samples: self.samples,
            missing: self.missing,
        }
    }
}

struct Scan {
    first_ms: u64,
    last_ms: u64,
    records: u64,
}

fn read_failed(error: io::Error) -> TraceError {
    TraceError::new(
        TraceErrorKind::Damaged,
        format!("The recording could not be read to its end: {error}"),
    )
}

fn open_failed(error: io::Error) -> TraceError {
    TraceError::new(
        TraceErrorKind::Unreadable,
        format!("The recording could not be opened: {error}"),
    )
}

struct Reduced {
    time: TraceTimeV1,
    bucket_records: Vec<u32>,
    gaps: TraceGapsV1,
    channels: Vec<TraceChannelV1>,
    stream_complete: bool,
    truncated_tail: bool,
    declared_records: Option<u64>,
}

/// Two streaming passes over the same source. Never holds more than one
/// record.
fn reduce<S: TraceSource>(
    open: impl Fn() -> io::Result<S>,
    request: &TraceRequest,
    game: SessionGame,
) -> Result<Reduced, TraceError> {
    // Pass 1: the exact span, and proof that the whole stream reads.
    let mut source = open().map_err(open_failed)?;
    let mut scan: Option<Scan> = None;
    while let Some((ms, _)) = source.next_record().map_err(read_failed)? {
        match scan.as_mut() {
            Some(scan) => {
                scan.last_ms = ms;
                scan.records += 1;
            }
            None => {
                scan = Some(Scan {
                    first_ms: ms,
                    last_ms: ms,
                    records: 1,
                })
            }
        }
    }
    drop(source);

    let (first_ms, span_ms, records) = scan
        .map(|scan| (scan.first_ms, scan.last_ms - scan.first_ms, scan.records))
        .unwrap_or((0, 0, 0));
    let (bucket_width_ms, bucket_count) = if records == 0 {
        (0, 0)
    } else {
        // `span_ms + 1` milliseconds must fit `request.buckets` buckets.
        let width = (span_ms + 1).div_ceil(u64::from(request.buckets)).max(1);
        (width, (span_ms / width + 1) as u32)
    };
    let buckets = bucket_count as usize;

    // Pass 2: fill the buckets.
    let mut source = open().map_err(open_failed)?;
    let mut bucket_records = vec![0_u32; buckets];
    let mut accumulators: Vec<ChannelAccumulator> = request
        .channels
        .iter()
        .map(|_| ChannelAccumulator::new(buckets))
        .collect();
    let mut gaps = TraceGapsV1 {
        threshold_ms: GAP_THRESHOLD_MS,
        total: 0,
        stored: Vec::new(),
    };
    let mut previous: Option<u64> = None;
    let mut max_interval_ms = 0;
    let mut seen = 0_u64;
    let changed = || {
        TraceError::new(
            TraceErrorKind::ChangedDuringRead,
            "The recording changed while it was being read.",
        )
    };
    while let Some((ms, values)) = source.next_record().map_err(read_failed)? {
        let t = ms.checked_sub(first_ms).ok_or_else(changed)?;
        if t > span_ms {
            return Err(changed());
        }
        if let Some(previous) = previous {
            let interval = t - previous;
            max_interval_ms = max_interval_ms.max(interval);
            if interval > GAP_THRESHOLD_MS {
                gaps.total += 1;
                if gaps.stored.len() < MAX_GAPS {
                    gaps.stored.push(TraceGapV1 {
                        start_ms: previous,
                        end_ms: t,
                    });
                }
            }
        }
        previous = Some(t);
        seen += 1;
        let bucket = (t / bucket_width_ms) as usize;
        bucket_records[bucket] = bucket_records[bucket].saturating_add(1);
        for (accumulator, channel) in accumulators.iter_mut().zip(&request.channels) {
            accumulator.observe(bucket, values[channel.index()]);
        }
    }
    if seen != records || previous.unwrap_or(0) != span_ms {
        return Err(changed());
    }

    Ok(Reduced {
        time: TraceTimeV1 {
            origin: "first_record",
            unit: "ms",
            span_ms,
            records,
            bucket_width_ms,
            bucket_count,
            max_interval_ms,
        },
        bucket_records,
        gaps,
        channels: accumulators
            .into_iter()
            .zip(&request.channels)
            .map(|(accumulator, &channel)| accumulator.finish(channel, game))
            .collect(),
        stream_complete: source.stream_complete(),
        truncated_tail: source.truncated_tail(),
        declared_records: source.declared_records(),
    })
}

fn require_completed(status: SessionStatus) -> Result<(), TraceError> {
    match status {
        SessionStatus::Completed => Ok(()),
        SessionStatus::Recording => Err(TraceError::new(
            TraceErrorKind::SessionRecording,
            "This session is still being recorded.",
        )),
        SessionStatus::Interrupted => Err(TraceError::new(
            TraceErrorKind::SessionInterrupted,
            "This session was interrupted. Traces are available for completed sessions only.",
        )),
    }
}

/// The trace of one completed session under `root`. `session_id` is checked
/// before any path is built from it; nothing outside `root/<session_id>` is
/// read, and nothing is written.
pub fn session_trace(
    root: &Path,
    session_id: &str,
    request: &TraceRequest,
) -> Result<SessionTraceV1, TraceError> {
    if !session_format::is_safe_session_id(session_id) {
        return Err(TraceError::new(
            TraceErrorKind::UnsafeSessionId,
            "Unknown session",
        ));
    }
    let directory = root.join(session_id);
    if !directory.is_dir() {
        return Err(TraceError::new(TraceErrorKind::NotFound, "Unknown session"));
    }
    let unreadable = |error: io::Error| {
        TraceError::new(
            TraceErrorKind::Unreadable,
            format!("Could not read session {session_id}: {error}"),
        )
    };

    // FH6 first, exactly as `f1_session::read_envelope` decides.
    if directory.join(session_format::MANIFEST_FILE_NAME).is_file() {
        let manifest = session_format::read_manifest(&directory).map_err(unreadable)?;
        require_completed(manifest.status)?;
        let game = SessionGame::Fh6;
        let reduced = reduce(|| open_fh6(&directory, session_id), request, game)?;
        return Ok(SessionTraceV1 {
            schema_version: TRACE_SCHEMA_VERSION,
            session_id: session_id.into(),
            game,
            source: TraceSourceV1 {
                format: "rlframes",
                container_version: manifest.frame_format_version,
                payload_schema_version: manifest.telemetry_frame_schema_version,
                recorded_by_racelab_version: manifest.created_by_racelab_version,
                nominal_sample_rate_hz: None,
                stream_complete: reduced.stream_complete,
                truncated_tail: reduced.truncated_tail,
                declared_records: reduced.declared_records,
                recorder_dropped_frames: Some(manifest.recorder_dropped_frames),
                f1_integrity: None,
            },
            time: reduced.time,
            bucket_records: reduced.bucket_records,
            gaps: reduced.gaps,
            channels: reduced.channels,
        });
    }

    if directory.join(f1_session::SESSION_FILE_NAME).is_file() {
        let file = f1_session::read_session(&directory).map_err(unreadable)?;
        require_completed(file.racelab_session.status)?;
        let game = SessionGame::F1_25;
        let reduced = reduce(|| open_f1(&directory, session_id), request, game)?;
        let integrity = &file.f1_25.integrity;
        return Ok(SessionTraceV1 {
            schema_version: TRACE_SCHEMA_VERSION,
            session_id: session_id.into(),
            game,
            source: TraceSourceV1 {
                format: "rlf1",
                container_version: f1_session::SAMPLE_STREAM_VERSION,
                payload_schema_version: file.f1_25.sample_schema_version,
                recorded_by_racelab_version: file.racelab_session.created_by_racelab_version,
                nominal_sample_rate_hz: Some(file.f1_25.sample_rate_hz),
                stream_complete: reduced.stream_complete,
                truncated_tail: reduced.truncated_tail,
                declared_records: reduced.declared_records,
                recorder_dropped_frames: None,
                f1_integrity: Some(F1TraceIntegrityV1 {
                    idle_ticks: integrity.idle_ticks,
                    late_ticks: integrity.late_ticks,
                    telemetry_gaps: integrity.telemetry_gaps,
                    out_of_order_dropped: integrity.out_of_order_dropped,
                }),
            },
            time: reduced.time,
            bucket_records: reduced.bucket_records,
            gaps: reduced.gaps,
            channels: reduced.channels,
        });
    }

    Err(TraceError::new(
        TraceErrorKind::NotFound,
        "This session has no recording.",
    ))
}
