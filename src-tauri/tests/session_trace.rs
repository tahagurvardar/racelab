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
        self, F1SampleV1, F1SessionFileV1, FamilyStampV1, SampleStreamEnd, SampleStreamHeader,
        SampleStreamWriter, TelemetrySampleV1, WheelsV1,
    },
    session_format::{
        self, FrameStreamEnd, FrameStreamHeader, FrameStreamWriter, SessionManifestV1,
        SessionStatus, FRAME_FILE_NAME, FRAME_FORMAT_VERSION, TELEMETRY_FRAME_SCHEMA_VERSION,
    },
    session_trace::{
        session_trace, SessionTraceV1, TraceChannel, TraceErrorKind, TraceRequest, TraceUnit,
        GAP_THRESHOLD_MS, MAX_BUCKETS, MAX_GAPS, MAX_RESPONSE_BYTES,
    },
    telemetry::{Controls, Engine, TelemetryFrame},
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
    TraceRequest::new(TraceChannel::ALL.to_vec(), None).unwrap()
}

fn request(buckets: u32) -> TraceRequest {
    TraceRequest::new(TraceChannel::ALL.to_vec(), Some(buckets)).unwrap()
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
    trace: &SessionTraceV1,
    which: TraceChannel,
) -> &racelab_lib::session_trace::TraceChannelV1 {
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
    assert_eq!(trace.schema_version, 1);
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

    assert_eq!(trace.time.origin, "first_record");
    assert_eq!(trace.time.span_ms, 900);
    assert_eq!(trace.time.records, 10);
    assert_eq!(trace.time.bucket_width_ms, 91);
    assert_eq!(trace.time.bucket_count, 10);
    assert_eq!(trace.time.max_interval_ms, 100);
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
        &TraceRequest::new(vec![TraceChannel::Brake, TraceChannel::Speed], Some(10)).unwrap(),
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
    assert_eq!(trace.time.records, 2);
    assert_eq!(trace.time.span_ms, 16);
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
    assert_eq!(trace.time.span_ms, 300);
    assert_eq!(trace.time.records, 4);
    assert_eq!(trace.time.bucket_count, 4);

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
    assert_eq!(trace.time.bucket_width_ms, 226);
    assert_eq!(trace.time.bucket_count, 4);
    assert_eq!(trace.bucket_records, vec![5, 3, 0, 1]);
    assert_eq!(trace.time.max_interval_ms, 649);
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
        (trace.gaps.stored[0].start_ms, trace.gaps.stored[0].end_ms),
        (2200, 5000)
    );
    // The buckets inside the gap hold nothing and say so.
    let bucket = |ms: u64| (ms / trace.time.bucket_width_ms) as usize;
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
        (f1.gaps.stored[0].start_ms, f1.gaps.stored[0].end_ms),
        (100, 4100)
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
    assert_eq!(trace.gaps.stored[0].start_ms, 0);
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
    let width = trace.time.bucket_width_ms;
    let rpm = channel(&trace, TraceChannel::Rpm);
    let at = |i: u64| ((i * 16) / width) as usize;
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
        assert_eq!(trace.time.records, 0, "{id}");
        assert_eq!(trace.time.span_ms, 0, "{id}");
        assert_eq!(trace.time.bucket_count, 0, "{id}");
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
    assert_eq!(trace.time.span_ms, 0);
    assert_eq!(trace.time.bucket_width_ms, 1);
    assert_eq!(trace.time.bucket_count, 1);
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
    assert_eq!(trace.time.records, 19);
    assert_eq!(trace.time.span_ms, 18 * 50);

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
    assert_eq!(trace.time.records, 19);
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
        TraceRequest::new(channels, buckets).unwrap_err().kind
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
    assert!(TraceRequest::new(vec![TraceChannel::Rpm], Some(MAX_BUCKETS)).is_ok());
    assert_eq!(
        TraceRequest::new(vec![TraceChannel::Rpm], None)
            .unwrap()
            .buckets,
        1000
    );
    // The allowlist is the type: anything else fails to deserialize.
    for name in [
        "position",
        "sourceSpecific",
        "gear",
        "lap_distance",
        "SPEED",
    ] {
        assert!(serde_json::from_value::<TraceChannel>(serde_json::json!(name)).is_err());
    }
    for name in ["speed", "rpm", "throttle", "brake", "steering"] {
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
    assert!(trace.time.bucket_count <= MAX_BUCKETS);
    assert!(trace.time.bucket_count >= MAX_BUCKETS - 1);
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
        assert_eq!(long_trace.time.records, records);
        assert!(long_trace.time.bucket_count <= MAX_BUCKETS);
        assert!(short_trace.time.bucket_count <= MAX_BUCKETS);
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
