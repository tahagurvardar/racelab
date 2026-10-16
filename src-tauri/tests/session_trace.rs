//! v2.1 M1: bounded, read-only session traces.
//!
//! Every recording here is synthetic and written through the real writers
//! (`FrameStreamWriter`, `SampleStreamWriter`) into real files, except the
//! schema-v1 stream, which is written byte by byte from a frozen copy of the
//! V0.6 shape exactly as `session_compatibility.rs` does. No game, listener or
//! user recording is involved.
//!
//! The allocation tests use a counting global allocator local to this test
//! binary. It counts per thread, so tests running in parallel do not disturb
//! each other's measurements.
mod scratch;

use racelab_lib::{
    f1_session::{
        self, F1SampleV1, F1SessionFileV1, FamilyStampV1, LapSampleV1, SampleStreamEnd,
        SampleStreamHeader, SampleStreamWriter, TelemetrySampleV1, WheelsV1,
    },
    session_format::{
        self, FrameStreamEnd, FrameStreamHeader, FrameStreamWriter, SessionManifestV1,
        SessionStatus, FRAME_FILE_NAME, FRAME_FORMAT_VERSION, TELEMETRY_FRAME_SCHEMA_VERSION,
    },
    session_trace::{
        session_trace, SessionTraceV2, TraceAxis, TraceChannel, TraceErrorKind, TraceRequest,
        TraceUnit, GAP_THRESHOLD_MS, MAX_BUCKETS, MAX_GAPS, MAX_RESPONSE_BYTES,
    },
    telemetry::{Controls, Engine, Gear, TelemetryFrame},
};
use scratch::Scratch;
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    collections::BTreeMap,
    fs,
    io::Write,
    path::Path,
    time::SystemTime,
};

// ------------------------------------------------------ allocation counter

struct Counting;

thread_local! {
    static CURRENT: Cell<isize> = const { Cell::new(0) };
    static PEAK: Cell<isize> = const { Cell::new(0) };
}

fn track(delta: isize) {
    let _ = CURRENT.try_with(|current| {
        let value = current.get() + delta;
        current.set(value);
        let _ = PEAK.try_with(|peak| {
            if value > peak.get() {
                peak.set(value);
            }
        });
    });
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = System.alloc(layout);
        if !pointer.is_null() {
            track(layout.size() as isize);
        }
        pointer
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pointer = System.alloc_zeroed(layout);
        if !pointer.is_null() {
            track(layout.size() as isize);
        }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        System.dealloc(pointer, layout);
        track(-(layout.size() as isize));
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let moved = System.realloc(pointer, layout, new_size);
        if !moved.is_null() {
            track(new_size as isize - layout.size() as isize);
        }
        moved
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// Peak bytes allocated on this thread while `work` ran, above what was
/// already live when it started.
fn peak_allocation<T>(work: impl FnOnce() -> T) -> (T, usize) {
    let baseline = CURRENT.with(Cell::get);
    PEAK.with(|peak| peak.set(baseline));
    let result = work();
    let peak = PEAK.with(Cell::get) - baseline;
    (result, peak.max(0) as usize)
}

// ---------------------------------------------------------------- fixtures

const STARTED: u64 = 1_800_000_000_000;
const PRIVATE_SENTINEL: &str = "PRIVATE-SENTINEL-7f3a";
const VEHICLE_SENTINEL: &str = "VEHICLE-SENTINEL-9c1d";
const F1_UID: u64 = 4_242_424_242_424_242_424;

fn all_channels() -> TraceRequest {
    TraceRequest::session(TraceChannel::ALL.to_vec(), None).unwrap()
}

fn request(buckets: u32) -> TraceRequest {
    TraceRequest::session(TraceChannel::ALL.to_vec(), Some(buckets)).unwrap()
}

type Inputs = (
    Option<f32>,
    Option<f32>,
    Option<f32>,
    Option<f32>,
    Option<f32>,
);

/// An FH6 frame carrying the five traced channels, plus private and
/// source-specific values a trace must never contain.
fn fh6_frame((speed, rpm, throttle, brake, steering): Inputs) -> TelemetryFrame {
    TelemetryFrame {
        active: true,
        game: Some("fh6".into()),
        vehicle_id: Some(VEHICLE_SENTINEL.into()),
        game_timestamp_ms: Some(1),
        engine: Engine {
            rpm,
            ..Default::default()
        },
        speed_mps: speed,
        controls: Controls {
            throttle,
            brake,
            steering,
            ..Default::default()
        },
        source_specific: Some(serde_json::json!({ "fh6": { "note": PRIVATE_SENTINEL } })),
        ..Default::default()
    }
}

fn full(speed: f32, rpm: f32, throttle: f32, brake: f32, steering: f32) -> Inputs {
    (
        Some(speed),
        Some(rpm),
        Some(throttle),
        Some(brake),
        Some(steering),
    )
}

fn fh6_manifest(id: &str, status: SessionStatus, frames: u64) -> SessionManifestV1 {
    let mut manifest = SessionManifestV1::new(id.into(), Some(STARTED));
    manifest.status = status;
    manifest.game = Some("fh6".into());
    manifest.vehicle_id = Some(VEHICLE_SENTINEL.into());
    manifest.frame_count = frames;
    manifest.recorder_dropped_frames = 3;
    manifest
}

/// A schema-2 FH6 session through the real writer. `footer: false` leaves
/// the stream as a crash would, without its end marker.
fn fh6_session(
    root: &Path,
    id: &str,
    status: SessionStatus,
    frames: &[(u64, TelemetryFrame)],
    footer: bool,
) {
    let directory = root.join(id);
    fs::create_dir_all(&directory).unwrap();
    let mut writer = FrameStreamWriter::create(
        &directory,
        &FrameStreamHeader {
            frame_format_version: FRAME_FORMAT_VERSION,
            telemetry_frame_schema_version: TELEMETRY_FRAME_SCHEMA_VERSION,
            session_id: id.into(),
            started_at_unix_ms: STARTED,
        },
    )
    .unwrap();
    for (index, (ms, frame)) in frames.iter().enumerate() {
        writer.write(index as u64 + 1, 50_000 + ms, frame).unwrap();
    }
    if footer {
        writer
            .finish(&FrameStreamEnd {
                frame_count: frames.len() as u64,
                duration_us: 0,
                recorder_dropped_frames: 3,
            })
            .unwrap();
    } else {
        writer.flush().unwrap();
    }
    session_format::write_manifest_atomically(
        &directory,
        &fh6_manifest(id, status, frames.len() as u64),
    )
    .unwrap();
}

fn fh6_simple(root: &Path, id: &str, timed: &[(u64, Inputs)]) {
    let frames: Vec<_> = timed.iter().map(|&(ms, v)| (ms, fh6_frame(v))).collect();
    fh6_session(root, id, SessionStatus::Completed, &frames, true);
}

/// A frozen copy of the V0.6 schema-1 shape, as in `session_compatibility.rs`.
/// Never edit it to follow the canonical model.
mod legacy {
    use serde::Serialize;

    #[derive(Serialize)]
    pub struct Engine {
        pub rpm: Option<f32>,
        pub idle_rpm: Option<f32>,
        pub max_rpm: Option<f32>,
    }

    #[derive(Serialize)]
    pub struct Controls {
        pub throttle: Option<f32>,
        pub brake: Option<f32>,
        pub clutch: Option<f32>,
        pub handbrake: Option<f32>,
        pub steering: Option<f32>,
    }

    #[derive(Serialize)]
    pub struct Vector3 {
        pub x: f32,
        pub y: f32,
        pub z: f32,
    }

    #[derive(Serialize)]
    pub struct TelemetryFrame {
        pub active: bool,
        pub game: Option<String>,
        pub vehicle_id: Option<String>,
        pub game_timestamp_ms: Option<u64>,
        pub engine: Engine,
        pub acceleration: Option<Vector3>,
        pub velocity: Option<Vector3>,
        pub angular_velocity: Option<Vector3>,
        pub orientation: Option<Vector3>,
        pub position: Option<Vector3>,
        pub speed_mps: Option<f32>,
        pub controls: Controls,
        pub gear: Option<()>,
        #[serde(rename = "sourceSpecific")]
        pub source_specific: Option<serde_json::Value>,
    }

    #[derive(Serialize)]
    pub struct StoredFrame {
        pub sequence: u64,
        pub monotonic_ms: u64,
        pub frame: TelemetryFrame,
    }
}

fn legacy_frame(speed: Option<f32>, throttle: Option<f32>) -> legacy::TelemetryFrame {
    legacy::TelemetryFrame {
        active: true,
        game: Some("fh6".into()),
        vehicle_id: Some(VEHICLE_SENTINEL.into()),
        game_timestamp_ms: Some(10),
        engine: legacy::Engine {
            rpm: Some(4321.5),
            idle_rpm: Some(800.0),
            max_rpm: Some(8000.0),
        },
        acceleration: None,
        velocity: None,
        angular_velocity: None,
        orientation: None,
        position: Some(legacy::Vector3 {
            x: 1.0,
            y: 2.0,
            z: 3.0,
        }),
        speed_mps: speed,
        controls: legacy::Controls {
            throttle,
            brake: Some(0.0),
            clutch: None,
            handbrake: None,
            steering: Some(-0.25),
        },
        gear: None,
        source_specific: Some(serde_json::json!({ "fh6": { "note": PRIVATE_SENTINEL } })),
    }
}

fn fh6_v1_session(root: &Path, id: &str, frames: Vec<(u64, legacy::TelemetryFrame)>) {
    let directory = root.join(id);
    fs::create_dir_all(&directory).unwrap();
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"RLFRM\r\n\0");
    bytes.extend_from_slice(&FRAME_FORMAT_VERSION.to_le_bytes());
    bytes.extend_from_slice(&1_u32.to_le_bytes());
    bytes.extend_from_slice(&(id.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&STARTED.to_le_bytes());
    bytes.extend_from_slice(id.as_bytes());
    let count = frames.len() as u64;
    for (index, (ms, frame)) in frames.into_iter().enumerate() {
        let payload = rmp_serde::to_vec_named(&legacy::StoredFrame {
            sequence: index as u64 + 1,
            monotonic_ms: ms,
            frame,
        })
        .unwrap();
        bytes.push(1);
        bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&payload);
    }
    bytes.push(2);
    bytes.extend_from_slice(&count.to_le_bytes());
    bytes.extend_from_slice(&0_u64.to_le_bytes());
    bytes.extend_from_slice(&0_u64.to_le_bytes());
    fs::File::create(directory.join(FRAME_FILE_NAME))
        .unwrap()
        .write_all(&bytes)
        .unwrap();
    let mut manifest = fh6_manifest(id, SessionStatus::Completed, count);
    manifest.telemetry_frame_schema_version = 1;
    session_format::write_manifest_atomically(&directory, &manifest).unwrap();
}

fn wheels<T: Copy>(value: T) -> WheelsV1<T> {
    WheelsV1 {
        rl: value,
        rr: value,
        fl: value,
        fr: value,
    }
}

/// `(speed km/h, rpm, throttle, brake, steer)`.
type F1Inputs = (u16, u16, f32, f32, f32);

fn f1_sample(sequence: u64, ms: u64, telemetry: Option<F1Inputs>) -> F1SampleV1 {
    F1SampleV1 {
        sequence,
        monotonic_ms: ms,
        telemetry: telemetry.map(|(speed_kmh, engine_rpm, throttle, brake, steer)| {
            TelemetrySampleV1 {
                stamp: FamilyStampV1 {
                    overall_frame_identifier: sequence as u32,
                    session_time: ms as f32 / 1000.0,
                    age_ms: 12,
                },
                speed_kmh,
                throttle,
                brake,
                steer,
                clutch: 0,
                gear: 3,
                engine_rpm,
                drs: 0,
                engine_temperature_c: 90,
                brakes_temperature_c: wheels(400),
                tyres_surface_temperature_c: wheels(90),
                tyres_inner_temperature_c: wheels(95),
                tyres_pressure_psi: wheels(22.5),
                surface_type: wheels(0),
            }
        }),
        status: None,
        lap: None,
        motion: None,
        damage: None,
    }
}

fn f1_session_dir(
    root: &Path,
    id: &str,
    status: SessionStatus,
    samples: &[F1SampleV1],
    footer: bool,
) {
    let directory = root.join(id);
    fs::create_dir_all(&directory).unwrap();
    let mut file = F1SessionFileV1::new(id.into(), F1_UID, 0, STARTED);
    file.racelab_session.status = status;
    file.f1_25.integrity.late_ticks = 2;
    file.f1_25.integrity.telemetry_gaps = 1;
    f1_session::write_session(&directory, &file).unwrap();
    let mut writer = SampleStreamWriter::create(
        &directory,
        &SampleStreamHeader {
            stream_version: f1_session::SAMPLE_STREAM_VERSION,
            sample_schema_version: f1_session::SAMPLE_SCHEMA_VERSION,
            session_id: id.into(),
            started_at_unix_ms: STARTED,
        },
    )
    .unwrap();
    for sample in samples {
        writer.write(sample).unwrap();
    }
    if footer {
        writer
            .finish(SampleStreamEnd {
                sample_count: samples.len() as u64,
                duration_ms: samples.last().map_or(0, |s| s.monotonic_ms),
            })
            .unwrap();
    } else {
        writer.flush().unwrap();
    }
}

fn f1_simple(root: &Path, id: &str, timed: &[(u64, Option<F1Inputs>)]) {
    let samples: Vec<_> = timed
        .iter()
        .enumerate()
        .map(|(index, &(ms, t))| f1_sample(index as u64, ms, t))
        .collect();
    f1_session_dir(root, id, SessionStatus::Completed, &samples, true);
}

fn channel(
    trace: &SessionTraceV2,
    which: TraceChannel,
) -> &racelab_lib::session_trace::TraceChannelV2 {
    trace
        .channels
        .iter()
        .find(|c| c.channel == which)
        .expect("requested channel present")
}

/// Every file in a session directory: bytes and modification time.
fn snapshot(directory: &Path) -> BTreeMap<String, (Vec<u8>, SystemTime)> {
    fs::read_dir(directory)
        .unwrap()
        .flatten()
        .map(|entry| {
            let path = entry.path();
            (
                entry.file_name().to_string_lossy().into_owned(),
                (
                    fs::read(&path).unwrap(),
                    fs::metadata(&path).unwrap().modified().unwrap(),
                ),
            )
        })
        .collect()
}

// --------------------------------------------------------------- the tests

#[test]
fn an_fh6_schema_two_session_traces_every_channel_in_its_recorded_unit() {
    let root = Scratch::new("trace-fh6-v2");
    let timed: Vec<_> = (0..10)
        .map(|i| {
            let f = i as f32;
            (
                i * 100,
                full(10.0 + f, 3000.0 + f, 0.1 * f, 0.0, -0.5 + 0.1 * f),
            )
        })
        .collect();
    fh6_simple(&root, "fh6-v2", &timed);

    let trace = session_trace(&root, "fh6-v2", &request(10)).unwrap();
    assert_eq!(trace.schema_version, 2);
    // The M1 request: the whole session on session time.
    assert_eq!(trace.scope.lap, None);
    assert_eq!(trace.scope.stream_records, 10);
    assert_eq!(trace.scope.unattributed_records, 0);
    assert_eq!(trace.axis.unit, "ms");
    assert_eq!(trace.axis.start, 0.0);
    assert_eq!(trace.axis.reversals, 0);
    assert_eq!(trace.session_id, "fh6-v2");
    assert_eq!(
        serde_json::to_value(trace.game).unwrap(),
        serde_json::json!("fh6")
    );
    assert_eq!(trace.source.format, "rlframes");
    assert_eq!(trace.source.payload_schema_version, 2);
    assert!(trace.source.stream_complete);
    assert!(!trace.source.truncated_tail);
    assert_eq!(trace.source.declared_records, Some(10));
    assert_eq!(trace.source.recorder_dropped_frames, Some(3));
    assert_eq!(trace.source.nominal_sample_rate_hz, None);
    assert!(trace.source.f1_integrity.is_none());

    assert_eq!(trace.axis.origin, "first_record");
    assert_eq!(trace.axis.end, 900.0);
    assert_eq!(trace.axis.records, 10);
    assert_eq!(trace.axis.bucket_width, 91.0);
    assert_eq!(trace.axis.bucket_count, 10);
    assert_eq!(trace.axis.max_interval_ms, 100);
    assert_eq!(trace.bucket_records, vec![1; 10]);
    assert_eq!(trace.gaps.total, 0);

    let speed = channel(&trace, TraceChannel::Speed);
    assert_eq!(speed.unit, TraceUnit::MetresPerSecond);
    assert_eq!(speed.min[0], Some(10.0));
    assert_eq!(speed.max[9], Some(19.0));
    assert_eq!(speed.total_samples, 10);
    assert_eq!(speed.total_missing, 0);
    assert_eq!(
        channel(&trace, TraceChannel::Rpm).unit,
        TraceUnit::RevolutionsPerMinute
    );
    assert_eq!(
        channel(&trace, TraceChannel::Throttle).unit,
        TraceUnit::Ratio0To1
    );
    assert_eq!(
        channel(&trace, TraceChannel::Steering).unit,
        TraceUnit::RatioMinus1To1
    );
    assert_eq!(channel(&trace, TraceChannel::Steering).min[0], Some(-0.5));
    // Channels come back in the requested order, and only those requested.
    let partial = session_trace(
        &root,
        "fh6-v2",
        &TraceRequest::session(vec![TraceChannel::Brake, TraceChannel::Speed], Some(10)).unwrap(),
    )
    .unwrap();
    let order: Vec<_> = partial.channels.iter().map(|c| c.channel).collect();
    assert_eq!(order, vec![TraceChannel::Brake, TraceChannel::Speed]);
}

#[test]
fn an_fh6_schema_one_session_traces_its_v1_values_without_migration() {
    let root = Scratch::new("trace-fh6-v1");
    fh6_v1_session(
        &root,
        "fh6-v1",
        vec![
            (1_000, legacy_frame(Some(12.5), Some(0.75))),
            (1_016, legacy_frame(None, None)),
        ],
    );
    let before = snapshot(&root.join("fh6-v1"));

    let trace = session_trace(&root, "fh6-v1", &request(2)).unwrap();
    assert_eq!(trace.source.payload_schema_version, 1);
    assert!(trace.source.stream_complete);
    assert_eq!(trace.axis.records, 2);
    assert_eq!(trace.axis.end, 16.0);
    let speed = channel(&trace, TraceChannel::Speed);
    assert_eq!(speed.min, vec![Some(12.5), None]);
    assert_eq!(speed.missing, vec![0, 1]);
    assert_eq!(
        channel(&trace, TraceChannel::Rpm).max,
        vec![Some(4321.5); 2]
    );
    assert_eq!(channel(&trace, TraceChannel::Brake).min, vec![Some(0.0); 2]);
    // Read, never rewritten.
    assert_eq!(snapshot(&root.join("fh6-v1")), before);
}

#[test]
fn an_f1_session_traces_car_telemetry_in_its_own_units() {
    let root = Scratch::new("trace-f1");
    f1_simple(
        &root,
        "f1-basic",
        &[
            (100, Some((170, 11_000, 1.0, 0.0, 0.25))),
            (200, None),
            (300, Some((59, 7_500, 0.0, 0.82, -0.75))),
            (400, Some((0, 0, 0.0, 0.0, 0.0))),
        ],
    );

    let trace = session_trace(&root, "f1-basic", &request(4)).unwrap();
    assert_eq!(
        serde_json::to_value(trace.game).unwrap(),
        serde_json::json!("f1_25")
    );
    assert_eq!(trace.source.format, "rlf1");
    assert_eq!(trace.source.payload_schema_version, 1);
    assert_eq!(trace.source.nominal_sample_rate_hz, Some(10));
    assert_eq!(trace.source.recorder_dropped_frames, None);
    let integrity = trace.source.f1_integrity.unwrap();
    assert_eq!((integrity.late_ticks, integrity.telemetry_gaps), (2, 1));
    assert!(trace.source.stream_complete);
    assert_eq!(trace.axis.end, 300.0);
    assert_eq!(trace.axis.records, 4);
    assert_eq!(trace.axis.bucket_count, 4);

    let speed = channel(&trace, TraceChannel::Speed);
    assert_eq!(speed.unit, TraceUnit::KilometresPerHour);
    // The sample without Car Telemetry is missing, never zero; the genuine
    // stationary sample is zero, never missing.
    assert_eq!(speed.min, vec![Some(170.0), None, Some(59.0), Some(0.0)]);
    assert_eq!(speed.samples, vec![1, 0, 1, 1]);
    assert_eq!(speed.missing, vec![0, 1, 0, 0]);
    assert_eq!(
        channel(&trace, TraceChannel::Rpm).max,
        vec![Some(11_000.0), None, Some(7_500.0), Some(0.0)]
    );
    assert_eq!(channel(&trace, TraceChannel::Brake).max[2], Some(0.82));
    assert_eq!(channel(&trace, TraceChannel::Steering).min[2], Some(-0.75));
}

#[test]
fn identical_recordings_produce_byte_identical_traces() {
    let root = Scratch::new("trace-deterministic");
    let timed: Vec<_> = (0..500_u64)
        .map(|i| {
            let f = (i as f32 * 0.37).sin();
            (
                i * 17 + i % 5,
                full(30.0 + f, 5000.0 + 900.0 * f, f.abs(), 0.0, f),
            )
        })
        .collect();
    fh6_simple(&root, "a", &timed);
    fh6_simple(&root, "b", &timed);
    let samples: Vec<_> = (0..300_u64)
        .map(|i| (i * 100, Some(((i % 300) as u16, 9000, 0.5, 0.0, 0.0))))
        .collect();
    f1_simple(&root, "c", &samples);

    let first = serde_json::to_vec(&session_trace(&root, "a", &all_channels()).unwrap()).unwrap();
    let again = serde_json::to_vec(&session_trace(&root, "a", &all_channels()).unwrap()).unwrap();
    let mut copy = session_trace(&root, "b", &all_channels()).unwrap();
    copy.session_id = "a".into();
    assert_eq!(first, again);
    assert_eq!(first, serde_json::to_vec(&copy).unwrap());
    let f1 = serde_json::to_vec(&session_trace(&root, "c", &all_channels()).unwrap()).unwrap();
    let f1_again =
        serde_json::to_vec(&session_trace(&root, "c", &all_channels()).unwrap()).unwrap();
    assert_eq!(f1, f1_again);
}

#[test]
fn a_missing_value_is_null_and_a_genuine_zero_is_a_sample() {
    let root = Scratch::new("trace-null-zero");
    fh6_simple(
        &root,
        "nz",
        &[
            (0, (Some(0.0), Some(0.0), Some(0.0), Some(0.0), Some(0.0))),
            (100, (None, None, None, None, None)),
            (200, (Some(0.0), None, Some(f32::NAN), None, Some(-0.0))),
        ],
    );
    let trace = session_trace(&root, "nz", &request(3)).unwrap();
    let speed = channel(&trace, TraceChannel::Speed);
    assert_eq!(speed.min, vec![Some(0.0), None, Some(0.0)]);
    assert_eq!(speed.samples, vec![1, 0, 1]);
    assert_eq!(speed.missing, vec![0, 1, 0]);
    let rpm = channel(&trace, TraceChannel::Rpm);
    assert_eq!(rpm.min, vec![Some(0.0), None, None]);
    assert_eq!((rpm.total_samples, rpm.total_missing), (1, 2));
    // A non-finite value is not a sample and is not silently turned into a
    // number either: it is missing, and counted as non-finite.
    let throttle = channel(&trace, TraceChannel::Throttle);
    assert_eq!(throttle.min, vec![Some(0.0), None, None]);
    assert_eq!(throttle.total_non_finite, 1);
    assert_eq!(throttle.total_missing, 2);
    // Serialized, an unavailable bucket is JSON null and a zero is 0.
    let json = serde_json::to_value(speed).unwrap();
    assert_eq!(json["min"], serde_json::json!([0.0, null, 0.0]));
}

#[test]
fn irregular_monotonic_timestamps_land_in_their_own_buckets() {
    let root = Scratch::new("trace-irregular");
    let times = [0_u64, 7, 9, 40, 41, 250, 250, 251, 900];
    let timed: Vec<_> = times
        .iter()
        .map(|&ms| (ms, full(ms as f32, 1.0, 0.5, 0.0, 0.0)))
        .collect();
    fh6_simple(&root, "irr", &timed);
    let trace = session_trace(&root, "irr", &request(4)).unwrap();
    // 901 ms into 4 buckets: width 226.
    assert_eq!(trace.axis.bucket_width, 226.0);
    assert_eq!(trace.axis.bucket_count, 4);
    assert_eq!(trace.bucket_records, vec![5, 3, 0, 1]);
    assert_eq!(trace.axis.max_interval_ms, 649);
    assert_eq!(trace.gaps.total, 0);
    let speed = channel(&trace, TraceChannel::Speed);
    assert_eq!(speed.min, vec![Some(0.0), Some(250.0), None, Some(900.0)]);
    assert_eq!(speed.max, vec![Some(41.0), Some(251.0), None, Some(900.0)]);
}

#[test]
fn intervals_longer_than_the_threshold_are_reported_as_gaps() {
    let root = Scratch::new("trace-gaps");
    let times = [0_u64, 100, 100 + GAP_THRESHOLD_MS, 2100, 2200, 5000];
    let timed: Vec<_> = times
        .iter()
        .map(|&ms| (ms, full(1.0, 1.0, 1.0, 0.0, 0.0)))
        .collect();
    fh6_simple(&root, "gaps", &timed);
    let trace = session_trace(&root, "gaps", &request(50)).unwrap();
    // Exactly the threshold is not a gap; longer is.
    assert_eq!(trace.gaps.threshold_ms, GAP_THRESHOLD_MS);
    assert_eq!(trace.gaps.total, 1);
    assert_eq!(trace.gaps.stored.len(), 1);
    assert_eq!(
        (trace.gaps.stored[0].start, trace.gaps.stored[0].end),
        (2200.0, 5000.0)
    );
    // The buckets inside the gap hold nothing and say so.
    let bucket = |ms: u64| (ms as f64 / trace.axis.bucket_width) as usize;
    assert_eq!(trace.bucket_records[bucket(3500)], 0);
    assert_eq!(channel(&trace, TraceChannel::Speed).min[bucket(3500)], None);
    assert_eq!(
        channel(&trace, TraceChannel::Speed).missing[bucket(3500)],
        0
    );

    // F1 too, on its own clock.
    f1_simple(
        &root,
        "f1-gaps",
        &[
            (0, Some((100, 1, 0.0, 0.0, 0.0))),
            (100, Some((100, 1, 0.0, 0.0, 0.0))),
            (4100, Some((100, 1, 0.0, 0.0, 0.0))),
        ],
    );
    let f1 = session_trace(&root, "f1-gaps", &request(10)).unwrap();
    assert_eq!(f1.gaps.total, 1);
    assert_eq!(
        (f1.gaps.stored[0].start, f1.gaps.stored[0].end),
        (100.0, 4100.0)
    );
}

#[test]
fn gap_metadata_is_capped_and_the_rest_is_counted() {
    let root = Scratch::new("trace-gap-cap");
    let count = MAX_GAPS + 88;
    let timed: Vec<_> = (0..=count as u64)
        .map(|i| (i * (GAP_THRESHOLD_MS + 1), full(1.0, 1.0, 0.0, 0.0, 0.0)))
        .collect();
    fh6_simple(&root, "cap", &timed);
    let trace = session_trace(&root, "cap", &all_channels()).unwrap();
    assert_eq!(trace.gaps.total, count as u64);
    assert_eq!(trace.gaps.stored.len(), MAX_GAPS);
    assert_eq!(trace.gaps.stored[0].start, 0.0);
}

#[test]
fn a_single_frame_spike_survives_downsampling_in_its_own_bucket() {
    let root = Scratch::new("trace-spike");
    let timed: Vec<_> = (0..10_000_u64)
        .map(|i| {
            let rpm = match i {
                4_321 => 9_876.5,
                7_777 => 123.25,
                _ => 5_000.0,
            };
            let brake = if i == 9_001 { 1.0 } else { 0.0 };
            (i * 16, full(40.0, rpm, 1.0, brake, 0.0))
        })
        .collect();
    fh6_simple(&root, "spike", &timed);
    let trace = session_trace(&root, "spike", &request(100)).unwrap();
    let width = trace.axis.bucket_width;
    let rpm = channel(&trace, TraceChannel::Rpm);
    let at = |i: u64| ((i * 16) as f64 / width) as usize;
    assert_eq!(rpm.max[at(4_321)], Some(9_876.5));
    assert_eq!(rpm.min[at(7_777)], Some(123.25));
    let others_max = rpm
        .max
        .iter()
        .enumerate()
        .filter(|&(b, _)| b != at(4_321))
        .filter_map(|(_, v)| *v)
        .fold(f32::MIN, f32::max);
    assert_eq!(others_max, 5_000.0);
    assert_eq!(
        channel(&trace, TraceChannel::Brake).max[at(9_001)],
        Some(1.0)
    );
    assert_eq!(
        trace
            .bucket_records
            .iter()
            .map(|&n| u64::from(n))
            .sum::<u64>(),
        10_000
    );
}

#[test]
fn an_empty_recording_yields_an_empty_trace_not_an_error() {
    let root = Scratch::new("trace-empty");
    fh6_session(&root, "fh6-empty", SessionStatus::Completed, &[], true);
    f1_session_dir(&root, "f1-empty", SessionStatus::Completed, &[], true);
    for id in ["fh6-empty", "f1-empty"] {
        let trace = session_trace(&root, id, &all_channels()).unwrap();
        assert_eq!(trace.axis.records, 0, "{id}");
        assert_eq!(trace.axis.end, 0.0, "{id}");
        assert_eq!(trace.axis.bucket_count, 0, "{id}");
        assert!(trace.bucket_records.is_empty(), "{id}");
        assert!(trace.source.stream_complete, "{id}");
        for c in &trace.channels {
            assert!(c.min.is_empty() && c.max.is_empty(), "{id}");
            assert_eq!((c.total_samples, c.total_missing), (0, 0), "{id}");
        }
    }
}

#[test]
fn a_single_record_has_one_bucket() {
    let root = Scratch::new("trace-single");
    fh6_simple(&root, "one", &[(0, full(5.0, 6.0, 0.0, 0.0, 0.0))]);
    let trace = session_trace(&root, "one", &all_channels()).unwrap();
    assert_eq!(trace.axis.end, 0.0);
    assert_eq!(trace.axis.bucket_width, 1.0);
    assert_eq!(trace.axis.bucket_count, 1);
    assert_eq!(channel(&trace, TraceChannel::Speed).min, vec![Some(5.0)]);
}

#[test]
fn a_truncated_tail_yields_the_intact_prefix_and_says_so() {
    let root = Scratch::new("trace-truncated");
    let timed: Vec<_> = (0..20_u64)
        .map(|i| (i * 50, fh6_frame(full(i as f32, 1.0, 0.0, 0.0, 0.0))))
        .collect();
    fh6_session(&root, "fh6-cut", SessionStatus::Completed, &timed, false);
    let path = root.join("fh6-cut").join(FRAME_FILE_NAME);
    let bytes = fs::read(&path).unwrap();
    fs::write(&path, &bytes[..bytes.len() - 7]).unwrap();

    let trace = session_trace(&root, "fh6-cut", &all_channels()).unwrap();
    assert!(trace.source.truncated_tail);
    assert!(!trace.source.stream_complete);
    assert_eq!(trace.source.declared_records, None);
    assert_eq!(trace.axis.records, 19);
    assert_eq!(trace.axis.end, (18 * 50) as f64);

    let samples: Vec<_> = (0..20_u64)
        .map(|i| f1_sample(i, i * 100, Some((100, 1, 0.0, 0.0, 0.0))))
        .collect();
    f1_session_dir(&root, "f1-cut", SessionStatus::Completed, &samples, false);
    let path = root.join("f1-cut").join(f1_session::SAMPLES_FILE_NAME);
    let bytes = fs::read(&path).unwrap();
    fs::write(&path, &bytes[..bytes.len() - 5]).unwrap();
    let trace = session_trace(&root, "f1-cut", &all_channels()).unwrap();
    assert!(trace.source.truncated_tail);
    assert!(!trace.source.stream_complete);
    assert_eq!(trace.axis.records, 19);
}

#[test]
fn damage_in_the_middle_of_a_stream_yields_no_trace() {
    let root = Scratch::new("trace-damaged");
    // FH6: a fully framed record whose payload no decoder accepts, between two
    // valid records.
    fh6_simple(
        &root,
        "fh6-bad",
        &[
            (0, full(1.0, 1.0, 0.0, 0.0, 0.0)),
            (10, full(1.0, 1.0, 0.0, 0.0, 0.0)),
        ],
    );
    let mut bytes = Vec::new();
    session_format::write_stream_header(
        &mut bytes,
        &FrameStreamHeader {
            frame_format_version: FRAME_FORMAT_VERSION,
            telemetry_frame_schema_version: TELEMETRY_FRAME_SCHEMA_VERSION,
            session_id: "fh6-bad".into(),
            started_at_unix_ms: STARTED,
        },
    )
    .unwrap();
    session_format::write_frame(&mut bytes, 1, 0, &fh6_frame(full(1.0, 1.0, 0.0, 0.0, 0.0)))
        .unwrap();
    bytes.push(1);
    bytes.extend_from_slice(&8_u32.to_le_bytes());
    bytes.extend_from_slice(&[0xC1; 8]);
    session_format::write_frame(&mut bytes, 2, 10, &fh6_frame(full(1.0, 1.0, 0.0, 0.0, 0.0)))
        .unwrap();
    fs::write(root.join("fh6-bad").join(FRAME_FILE_NAME), bytes).unwrap();
    let error = session_trace(&root, "fh6-bad", &all_channels()).unwrap_err();
    assert_eq!(error.kind, TraceErrorKind::Damaged);

    // F1: an unknown record tag mid-stream.
    f1_simple(&root, "f1-bad", &[(0, Some((1, 1, 0.0, 0.0, 0.0)))]);
    let path = root.join("f1-bad").join(f1_session::SAMPLES_FILE_NAME);
    let mut bytes = fs::read(&path).unwrap();
    let footer = bytes.split_off(bytes.len() - 17);
    bytes.push(9);
    bytes.extend_from_slice(&footer);
    fs::write(&path, bytes).unwrap();
    let error = session_trace(&root, "f1-bad", &all_channels()).unwrap_err();
    assert_eq!(error.kind, TraceErrorKind::Damaged);

    // F1: time running backwards is damage, not a gap.
    f1_simple(
        &root,
        "f1-backwards",
        &[
            (500, Some((1, 1, 0.0, 0.0, 0.0))),
            (400, Some((1, 1, 0.0, 0.0, 0.0))),
        ],
    );
    let error = session_trace(&root, "f1-backwards", &all_channels()).unwrap_err();
    assert_eq!(error.kind, TraceErrorKind::Damaged);

    // A stream whose header names another session is not this session's.
    fh6_simple(&root, "fh6-other", &[(0, full(1.0, 1.0, 0.0, 0.0, 0.0))]);
    fs::copy(
        root.join("fh6-bad").join(FRAME_FILE_NAME),
        root.join("fh6-other").join(FRAME_FILE_NAME),
    )
    .unwrap();
    let error = session_trace(&root, "fh6-other", &all_channels()).unwrap_err();
    assert_eq!(error.kind, TraceErrorKind::Unreadable);

    // Garbage instead of a header.
    fh6_simple(&root, "fh6-garbage", &[(0, full(1.0, 1.0, 0.0, 0.0, 0.0))]);
    fs::write(
        root.join("fh6-garbage").join(FRAME_FILE_NAME),
        b"not a stream",
    )
    .unwrap();
    let error = session_trace(&root, "fh6-garbage", &all_channels()).unwrap_err();
    assert_eq!(error.kind, TraceErrorKind::Unreadable);
}

#[test]
fn unsafe_and_unknown_session_ids_are_refused_before_any_path_is_used() {
    let root = Scratch::new("trace-ids");
    // A real session one level up that a traversal would reach.
    let outside = Scratch::new("trace-ids-outside");
    fh6_simple(&outside, "victim", &[(0, full(1.0, 1.0, 0.0, 0.0, 0.0))]);
    let long = "a".repeat(129);
    for id in [
        "",
        "..",
        "../victim",
        "a/b",
        "a\\b",
        "C:\\Windows",
        "sess ion",
        "sessión",
        long.as_str(),
    ] {
        let error = session_trace(&root, id, &all_channels()).unwrap_err();
        assert_eq!(error.kind, TraceErrorKind::UnsafeSessionId, "{id:?}");
    }
    let error = session_trace(&root, "does-not-exist", &all_channels()).unwrap_err();
    assert_eq!(error.kind, TraceErrorKind::NotFound);
    fs::create_dir_all(root.join("no-recording")).unwrap();
    let error = session_trace(&root, "no-recording", &all_channels()).unwrap_err();
    assert_eq!(error.kind, TraceErrorKind::NotFound);
}

#[test]
fn recording_and_interrupted_sessions_are_refused_for_both_games() {
    let root = Scratch::new("trace-status");
    let frames = [(0, fh6_frame(full(1.0, 1.0, 0.0, 0.0, 0.0)))];
    fh6_session(&root, "fh6-rec", SessionStatus::Recording, &frames, false);
    fh6_session(&root, "fh6-int", SessionStatus::Interrupted, &frames, false);
    let samples = [f1_sample(0, 0, Some((1, 1, 0.0, 0.0, 0.0)))];
    f1_session_dir(&root, "f1-rec", SessionStatus::Recording, &samples, false);
    f1_session_dir(&root, "f1-int", SessionStatus::Interrupted, &samples, true);
    for (id, kind) in [
        ("fh6-rec", TraceErrorKind::SessionRecording),
        ("fh6-int", TraceErrorKind::SessionInterrupted),
        ("f1-rec", TraceErrorKind::SessionRecording),
        ("f1-int", TraceErrorKind::SessionInterrupted),
    ] {
        let error = session_trace(&root, id, &all_channels()).unwrap_err();
        assert_eq!(error.kind, kind, "{id}");
        let json = serde_json::to_value(&error).unwrap();
        assert!(json["kind"].is_string() && json["message"].is_string());
    }
}

#[test]
fn requests_outside_the_allowlist_or_the_bounds_are_refused() {
    let invalid = |channels: Vec<TraceChannel>, buckets: Option<u32>| {
        TraceRequest::session(channels, buckets).unwrap_err().kind
    };
    assert_eq!(invalid(vec![], None), TraceErrorKind::InvalidRequest);
    assert_eq!(
        invalid(vec![TraceChannel::Rpm, TraceChannel::Rpm], None),
        TraceErrorKind::InvalidRequest
    );
    assert_eq!(
        invalid(vec![TraceChannel::Rpm], Some(0)),
        TraceErrorKind::InvalidRequest
    );
    assert_eq!(
        invalid(vec![TraceChannel::Rpm], Some(MAX_BUCKETS + 1)),
        TraceErrorKind::InvalidRequest
    );
    assert!(TraceRequest::session(vec![TraceChannel::Rpm], Some(MAX_BUCKETS)).is_ok());
    assert_eq!(
        TraceRequest::session(vec![TraceChannel::Rpm], None)
            .unwrap()
            .buckets,
        1000
    );
    // The allowlist is the type: anything else fails to deserialize.
    for name in [
        "position",
        "sourceSpecific",
        "fuel",
        "lap_distance",
        "SPEED",
    ] {
        assert!(serde_json::from_value::<TraceChannel>(serde_json::json!(name)).is_err());
    }
    for name in ["speed", "rpm", "throttle", "brake", "steering", "gear"] {
        assert!(serde_json::from_value::<TraceChannel>(serde_json::json!(name)).is_ok());
    }
}

#[test]
fn traces_never_carry_source_specific_or_private_values() {
    let root = Scratch::new("trace-privacy");
    fh6_simple(&root, "fh6-p", &[(0, full(1.0, 1.0, 0.0, 0.0, 0.0))]);
    fh6_v1_session(
        &root,
        "fh6-p1",
        vec![(0, legacy_frame(Some(1.0), Some(0.0)))],
    );
    f1_simple(&root, "f1-p", &[(0, Some((1, 1, 0.0, 0.0, 0.0)))]);
    for id in ["fh6-p", "fh6-p1", "f1-p"] {
        let json =
            serde_json::to_string(&session_trace(&root, id, &all_channels()).unwrap()).unwrap();
        for forbidden in [
            PRIVATE_SENTINEL,
            VEHICLE_SENTINEL,
            "sourceSpecific",
            "vehicle_id",
            "position",
            "session_uid",
            &F1_UID.to_string(),
        ] {
            assert!(!json.contains(forbidden), "{id} leaked {forbidden}");
        }
    }
}

#[test]
fn tracing_never_modifies_or_adds_a_file() {
    let root = Scratch::new("trace-readonly");
    let timed: Vec<_> = (0..100_u64)
        .map(|i| (i * 16, full(1.0, 2.0, 0.0, 0.0, 0.0)))
        .collect();
    fh6_simple(&root, "fh6-ro", &timed);
    let samples: Vec<_> = (0..100_u64)
        .map(|i| (i * 100, Some((1, 2, 0.0, 0.0, 0.0))))
        .collect();
    f1_simple(&root, "f1-ro", &samples);
    let before: Vec<_> = ["fh6-ro", "f1-ro"]
        .iter()
        .map(|id| snapshot(&root.join(id)))
        .collect();
    let root_entries = fs::read_dir(&*root).unwrap().count();
    for _ in 0..3 {
        session_trace(&root, "fh6-ro", &all_channels()).unwrap();
        session_trace(&root, "f1-ro", &all_channels()).unwrap();
    }
    let after: Vec<_> = ["fh6-ro", "f1-ro"]
        .iter()
        .map(|id| snapshot(&root.join(id)))
        .collect();
    assert_eq!(before, after);
    assert_eq!(fs::read_dir(&*root).unwrap().count(), root_entries);
}

#[test]
fn the_worst_case_response_stays_within_its_declared_size() {
    let root = Scratch::new("trace-size");
    // Every bucket full, every value a long decimal, every gap stored.
    let records = MAX_BUCKETS as u64 * 2;
    let timed: Vec<_> = (0..records)
        .map(|i| {
            let v = -123_456.79_f32 + i as f32 * 0.123_456_7;
            let spacing = if i % 3 == 0 { GAP_THRESHOLD_MS + 1 } else { 1 };
            (i, spacing, full(v, v, v, v, v))
        })
        .scan(0_u64, |t, (_, spacing, v)| {
            *t += spacing;
            Some((*t, v))
        })
        .collect();
    fh6_simple(&root, "worst", &timed);
    let trace = session_trace(&root, "worst", &request(MAX_BUCKETS)).unwrap();
    // Width is rounded up, so the count may fall short of the request by the
    // rounding, never exceed it.
    assert!(trace.axis.bucket_count <= MAX_BUCKETS);
    assert!(trace.axis.bucket_count >= MAX_BUCKETS - 1);
    assert_eq!(trace.gaps.stored.len(), MAX_GAPS);
    let size = serde_json::to_vec(&trace).unwrap().len();
    assert!(size <= MAX_RESPONSE_BYTES, "{size} bytes");
}

/// Writes `frames` FH6 frames at ~60 Hz.
fn long_fh6(root: &Path, id: &str, frames: u64) {
    let directory = root.join(id);
    fs::create_dir_all(&directory).unwrap();
    let mut writer = FrameStreamWriter::create(
        &directory,
        &FrameStreamHeader {
            frame_format_version: FRAME_FORMAT_VERSION,
            telemetry_frame_schema_version: TELEMETRY_FRAME_SCHEMA_VERSION,
            session_id: id.into(),
            started_at_unix_ms: STARTED,
        },
    )
    .unwrap();
    for i in 0..frames {
        let f = (i % 1000) as f32;
        let frame = fh6_frame(full(f, f * 8.0, 0.5, 0.0, 0.0));
        writer.write(i + 1, i * 16 + i % 3, &frame).unwrap();
    }
    writer
        .finish(&FrameStreamEnd {
            frame_count: frames,
            duration_us: 0,
            recorder_dropped_frames: 0,
        })
        .unwrap();
    session_format::write_manifest_atomically(
        &directory,
        &fh6_manifest(id, SessionStatus::Completed, frames),
    )
    .unwrap();
}

fn long_f1(root: &Path, id: &str, samples: u64) {
    let directory = root.join(id);
    fs::create_dir_all(&directory).unwrap();
    let mut file = F1SessionFileV1::new(id.into(), F1_UID, 0, STARTED);
    file.racelab_session.status = SessionStatus::Completed;
    f1_session::write_session(&directory, &file).unwrap();
    let mut writer = SampleStreamWriter::create(
        &directory,
        &SampleStreamHeader {
            stream_version: f1_session::SAMPLE_STREAM_VERSION,
            sample_schema_version: f1_session::SAMPLE_SCHEMA_VERSION,
            session_id: id.into(),
            started_at_unix_ms: STARTED,
        },
    )
    .unwrap();
    for i in 0..samples {
        let telemetry = (i % 7 != 0).then_some(((i % 330) as u16, 11_000, 1.0, 0.0, 0.1));
        writer.write(&f1_sample(i, i * 100, telemetry)).unwrap();
    }
    writer
        .finish(SampleStreamEnd {
            sample_count: samples,
            duration_ms: samples * 100,
        })
        .unwrap();
}

/// Peak memory while tracing does not grow with the recording. A long stream
/// is measured against a stream 30 times shorter at the same bucket count.
#[test]
fn peak_memory_is_bounded_independently_of_recording_length() {
    const LIMIT: usize = 4 << 20;
    let root = Scratch::new("trace-memory");
    // 60,000 frames is about 16.7 minutes of FH6 at 60 Hz.
    long_fh6(&root, "fh6-short", 2_000);
    long_fh6(&root, "fh6-long", 60_000);
    // 36,000 samples is one hour of F1 25 at 10 Hz.
    long_f1(&root, "f1-short", 1_200);
    long_f1(&root, "f1-long", 36_000);
    let max = request(MAX_BUCKETS);

    for (short, long, records) in [
        ("fh6-short", "fh6-long", 60_000),
        ("f1-short", "f1-long", 36_000),
    ] {
        let (short_trace, short_peak) =
            peak_allocation(|| session_trace(&root, short, &max).unwrap());
        let (long_trace, long_peak) = peak_allocation(|| session_trace(&root, long, &max).unwrap());
        assert_eq!(long_trace.axis.records, records);
        assert!(long_trace.axis.bucket_count <= MAX_BUCKETS);
        assert!(short_trace.axis.bucket_count <= MAX_BUCKETS);
        assert!(long_peak <= LIMIT, "{long}: {long_peak} bytes");
        assert!(
            long_peak <= short_peak + (64 << 10),
            "{long}: {long_peak} bytes vs {short}: {short_peak} bytes"
        );
        println!("{short}: peak {short_peak} B; {long}: peak {long_peak} B");
        let speed = long_trace
            .channels
            .iter()
            .find(|c| c.channel == TraceChannel::Speed)
            .unwrap();
        assert_eq!(speed.total_samples + speed.total_missing, records);
    }
}

// ------------------------------------------------------- M2.0: lap scope

/// `(lap, lap time ms, lap distance m)`.
type LapAt = (u8, u32, f32);

fn lap_reading(sequence: u64, (lap, lap_time_ms, distance): LapAt) -> LapSampleV1 {
    LapSampleV1 {
        stamp: FamilyStampV1 {
            overall_frame_identifier: sequence as u32,
            session_time: 0.0,
            age_ms: 10,
        },
        current_lap_num: lap,
        current_lap_time_ms: lap_time_ms,
        last_lap_time_ms: 0,
        sector1_ms: 0,
        sector2_ms: 0,
        lap_distance_m: distance,
        total_distance_m: distance,
        car_position: 1,
        sector: 0,
        current_lap_invalid: 0,
        pit_status: 0,
        num_pit_stops: 0,
        penalties_s: 0,
        driver_status: 1,
        result_status: 2,
        safety_car_delta_s: 0.0,
    }
}

/// `(monotonic ms, Lap Data, Car Telemetry)`; either family may be absent.
type LapRow = (u64, Option<LapAt>, Option<F1Inputs>);

fn f1_laps(root: &Path, id: &str, rows: &[LapRow]) {
    let samples: Vec<_> = rows
        .iter()
        .enumerate()
        .map(|(index, &(ms, lap, telemetry))| {
            let mut sample = f1_sample(index as u64, ms, telemetry);
            sample.lap = lap.map(|at| lap_reading(index as u64, at));
            sample
        })
        .collect();
    f1_session_dir(root, id, SessionStatus::Completed, &samples, true);
}

fn lap_request(lap: u16, axis: TraceAxis, buckets: u32) -> TraceRequest {
    TraceRequest::new(
        TraceChannel::ALL.to_vec(),
        Some(buckets),
        Some(lap),
        Some(axis),
    )
    .unwrap()
}

fn drive(speed: u16) -> Option<F1Inputs> {
    Some((speed, 10_000, 1.0, 0.0, 0.0))
}

#[test]
fn a_lap_trace_covers_only_that_lap_on_its_distance_or_time() {
    let root = Scratch::new("trace-lap");
    f1_laps(
        &root,
        "f1-lap",
        &[
            (0, Some((1, 0, -20.0)), drive(100)),
            (100, Some((1, 100, 0.0)), drive(110)),
            // No Lap Data: inside lap 1, but not attributed to it.
            (200, None, drive(115)),
            (300, Some((1, 300, 10.5)), drive(120)),
            (400, Some((2, 0, 0.0)), drive(130)),
            (500, Some((2, 100, 5.0)), drive(140)),
            (600, None, drive(150)),
        ],
    );

    let distance =
        session_trace(&root, "f1-lap", &lap_request(1, TraceAxis::Distance, 1000)).unwrap();
    assert_eq!(distance.scope.lap, Some(1));
    assert_eq!(distance.scope.stream_records, 7);
    assert_eq!(distance.scope.unattributed_records, 1);
    let axis = serde_json::to_value(distance.axis).unwrap();
    assert_eq!(axis["kind"], "lap_distance");
    assert_eq!(axis["unit"], "m");
    assert_eq!(axis["origin"], "start_finish_line");
    // Before the line the game reports a negative distance; it is kept.
    assert_eq!(distance.axis.start, -20.0);
    assert_eq!(distance.axis.end, 10.5);
    assert_eq!(distance.axis.records, 3);
    // 30.5 m in millimetres over 1000 buckets: 31 mm wide, 984 buckets.
    assert_eq!(distance.axis.bucket_width, 0.031);
    assert_eq!(distance.axis.bucket_count, 984);
    assert_eq!(distance.axis.reversals, 0);
    let speed = channel(&distance, TraceChannel::Speed);
    assert_eq!(speed.total_samples, 3);
    assert_eq!(speed.last[0], Some(100.0));
    assert_eq!(speed.last[983], Some(120.0));
    // The unattributed 115 km/h sample is nowhere in the lap.
    assert!(!speed.max.contains(&Some(115.0)));

    let time = session_trace(&root, "f1-lap", &lap_request(1, TraceAxis::Time, 1000)).unwrap();
    assert_eq!(serde_json::to_value(time.axis).unwrap()["kind"], "lap_time");
    assert_eq!(time.axis.origin, "lap_start");
    assert_eq!((time.axis.start, time.axis.end), (0.0, 300.0));
    assert_eq!(time.axis.records, 3);

    // The record after lap 2 carries no Lap Data and no lap follows it, so
    // nothing is unattributed.
    let lap2 = session_trace(&root, "f1-lap", &lap_request(2, TraceAxis::Distance, 10)).unwrap();
    assert_eq!(lap2.axis.records, 2);
    assert_eq!(lap2.scope.unattributed_records, 0);
    assert_eq!((lap2.axis.start, lap2.axis.end), (0.0, 5.0));

    // A lap that was never recorded is an empty trace, not an error.
    let none = session_trace(&root, "f1-lap", &lap_request(9, TraceAxis::Distance, 10)).unwrap();
    assert_eq!(none.axis.records, 0);
    assert_eq!(none.axis.bucket_count, 0);
}

#[test]
fn a_lap_axis_that_runs_backwards_is_reported_never_smoothed() {
    let root = Scratch::new("trace-flashback");
    f1_laps(
        &root,
        "f1-flashback",
        &[
            (0, Some((3, 0, 0.0)), drive(100)),
            (100, Some((3, 1000, 100.0)), drive(110)),
            (200, Some((3, 2000, 200.0)), drive(120)),
            // A flashback: the game rewinds the lap.
            (300, Some((3, 500, 50.0)), drive(105)),
            (400, Some((3, 1500, 150.0)), drive(115)),
        ],
    );
    for axis in [TraceAxis::Distance, TraceAxis::Time] {
        let trace = session_trace(&root, "f1-flashback", &lap_request(3, axis, 100)).unwrap();
        assert_eq!(trace.axis.reversals, 1, "{axis:?}");
        assert_eq!(trace.axis.records, 5, "{axis:?}");
    }
}

#[test]
fn a_gap_on_a_lap_axis_is_placed_at_its_lap_position() {
    let root = Scratch::new("trace-lap-gap");
    f1_laps(
        &root,
        "f1-lap-gap",
        &[
            (0, Some((1, 0, 0.0)), drive(100)),
            (100, Some((1, 100, 10.0)), drive(100)),
            (
                100 + GAP_THRESHOLD_MS + 1,
                Some((1, 1200, 12.0)),
                drive(100),
            ),
        ],
    );
    let trace = session_trace(
        &root,
        "f1-lap-gap",
        &lap_request(1, TraceAxis::Distance, 10),
    )
    .unwrap();
    assert_eq!(trace.gaps.total, 1);
    assert_eq!(
        (trace.gaps.stored[0].start, trace.gaps.stored[0].end),
        (10.0, 12.0)
    );
    assert_eq!(trace.axis.max_interval_ms, GAP_THRESHOLD_MS + 1);
}

#[test]
fn the_last_value_is_the_buckets_final_reading_in_record_order() {
    let root = Scratch::new("trace-last");
    f1_simple(
        &root,
        "f1-last",
        &[
            (0, Some((5, 1, 0.0, 0.0, 0.0))),
            (1, Some((9, 1, 0.0, 0.0, 0.0))),
            (2, Some((2, 1, 0.0, 0.0, 0.0))),
            (3, None),
        ],
    );
    let trace = session_trace(&root, "f1-last", &request(1)).unwrap();
    let speed = channel(&trace, TraceChannel::Speed);
    assert_eq!(speed.min, vec![Some(2.0)]);
    assert_eq!(speed.max, vec![Some(9.0)]);
    // The trailing sample without Car Telemetry does not erase the reading.
    assert_eq!(speed.last, vec![Some(2.0)]);
    assert_eq!(speed.missing, vec![1]);
}

#[test]
fn gear_is_the_recorded_gear_number_and_unavailable_fh6_gear_stays_null() {
    let root = Scratch::new("trace-gear");
    let mut samples: Vec<_> = (0..3_u64)
        .map(|i| f1_sample(i, i * 100, Some((100, 1, 0.0, 0.0, 0.0))))
        .collect();
    for (sample, gear) in samples.iter_mut().zip([-1_i8, 0, 7]) {
        sample.telemetry.as_mut().unwrap().gear = gear;
    }
    f1_session_dir(&root, "f1-gear", SessionStatus::Completed, &samples, true);
    let trace = session_trace(&root, "f1-gear", &request(3)).unwrap();
    let gear = channel(&trace, TraceChannel::Gear);
    assert_eq!(gear.unit, TraceUnit::Gear);
    assert_eq!(gear.last, vec![Some(-1.0), Some(0.0), Some(7.0)]);

    // FH6's adapter leaves canonical gear unavailable: missing, never 0.
    fh6_simple(&root, "fh6-gear", &[(0, full(1.0, 1.0, 0.0, 0.0, 0.0))]);
    let fh6 = session_trace(&root, "fh6-gear", &all_channels()).unwrap();
    let gear = channel(&fh6, TraceChannel::Gear);
    assert_eq!((gear.total_samples, gear.total_missing), (0, 1));
    // A canonical gear, where one exists, maps to its number.
    let mut frames = Vec::new();
    for (ms, value) in [
        (0, Gear::Reverse),
        (10, Gear::Neutral),
        (20, Gear::Forward(4)),
        (30, Gear::Unmapped(11)),
    ] {
        let mut frame = fh6_frame(full(1.0, 1.0, 0.0, 0.0, 0.0));
        frame.gear = Some(value);
        frames.push((ms, frame));
    }
    fh6_session(&root, "fh6-gears", SessionStatus::Completed, &frames, true);
    let fh6 = session_trace(&root, "fh6-gears", &request(4)).unwrap();
    assert_eq!(
        channel(&fh6, TraceChannel::Gear).last,
        vec![Some(-1.0), Some(0.0), Some(4.0), None]
    );
}

#[test]
fn lap_requests_outside_their_rules_are_refused() {
    let invalid = |lap: Option<u16>, axis: Option<TraceAxis>| {
        TraceRequest::new(vec![TraceChannel::Speed], None, lap, axis)
            .unwrap_err()
            .kind
    };
    assert_eq!(
        invalid(None, Some(TraceAxis::Distance)),
        TraceErrorKind::InvalidRequest
    );
    assert_eq!(invalid(Some(0), None), TraceErrorKind::InvalidRequest);
    for axis in ["time", "distance"] {
        assert!(serde_json::from_value::<TraceAxis>(serde_json::json!(axis)).is_ok());
    }
    assert!(serde_json::from_value::<TraceAxis>(serde_json::json!("position")).is_err());

    // FH6 records no established lap: a lap request is refused, not emptied.
    let root = Scratch::new("trace-fh6-lap");
    fh6_simple(&root, "fh6-lap", &[(0, full(1.0, 1.0, 0.0, 0.0, 0.0))]);
    let error = session_trace(&root, "fh6-lap", &lap_request(1, TraceAxis::Time, 10)).unwrap_err();
    assert_eq!(error.kind, TraceErrorKind::InvalidRequest);
}

#[test]
fn a_session_trace_is_unchanged_by_the_lap_scope_feature() {
    // The default request ignores Lap Data entirely: every record counts.
    let root = Scratch::new("trace-session-compat");
    f1_laps(
        &root,
        "f1-compat",
        &[
            (0, Some((1, 0, 0.0)), drive(100)),
            (100, None, drive(110)),
            (200, Some((2, 0, 0.0)), drive(120)),
        ],
    );
    let trace = session_trace(&root, "f1-compat", &request(3)).unwrap();
    assert_eq!(trace.axis.records, 3);
    assert_eq!(trace.scope.unattributed_records, 0);
    assert_eq!(
        channel(&trace, TraceChannel::Speed).max,
        vec![Some(100.0), Some(110.0), Some(120.0)]
    );
}
