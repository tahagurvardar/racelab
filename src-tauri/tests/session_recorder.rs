//! V0.6 automatic session recorder, storage format, summary and store.
use racelab_lib::{
    session_format::{
        self, FrameStreamReader, SessionStatus, FRAME_FILE_NAME, MANIFEST_FILE_NAME,
        TELEMETRY_FRAME_SCHEMA_VERSION,
    },
    session_recorder::{SessionRecorder, CHECKPOINT_INTERVAL, RECORDER_QUEUE_CAPACITY},
    session_store,
    session_summary::MAX_SAMPLE_GAP_MS,
    telemetry::{Controls, Engine, Gear, Race, TelemetryFrame, Vector3, Vehicle, Wheel, Wheels},
    telemetry_hub::{SessionRecorderHook, TelemetryHub},
};
use std::{
    fs,
    io::{self, BufReader},
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

static UNIQUE: AtomicU64 = AtomicU64::new(0);

fn scratch(name: &str) -> PathBuf {
    let unique = UNIQUE.fetch_add(1, Ordering::Relaxed);
    let root = std::env::temp_dir().join(format!(
        "racelab-v06-{}-{}-{unique}",
        std::process::id(),
        name
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    root
}

/// Real `SessionEngine` lifecycle, real recorder, real files. Only the frames
/// are synthetic.
struct Rig {
    hub: Arc<TelemetryHub>,
    recorder: Arc<SessionRecorder>,
    root: PathBuf,
}

fn rig(name: &str) -> Rig {
    rig_with(name, RECORDER_QUEUE_CAPACITY, 10_000, 60_000)
}

fn rig_with(name: &str, capacity: usize, grace_ms: u64, silence_ms: u64) -> Rig {
    rig_with_checkpoint(name, capacity, grace_ms, silence_ms, CHECKPOINT_INTERVAL)
}

/// Shortening the checkpoint cadence is the only way to exercise the real
/// elapsed-time checkpoint path inside a test's runtime. The mechanism under
/// test is the writer's own deadline, which is identical at any interval.
fn rig_with_checkpoint(
    name: &str,
    capacity: usize,
    grace_ms: u64,
    silence_ms: u64,
    checkpoint_interval: Duration,
) -> Rig {
    let root = scratch(name);
    let recorder =
        SessionRecorder::with_settings(root.clone(), capacity, checkpoint_interval).unwrap();
    let hub = Arc::new(TelemetryHub::new(8, "test".into(), grace_ms, silence_ms).unwrap());
    hub.attach_recorder(Arc::clone(&recorder) as Arc<dyn SessionRecorderHook>)
        .unwrap();
    Rig {
        hub,
        recorder,
        root,
    }
}

impl Rig {
    fn session_id(&self) -> String {
        self.hub.session().expect("a session exists").id
    }
    fn directory(&self, id: &str) -> PathBuf {
        self.root.join(id)
    }
    /// Blocks the test, never the hub: waits for the writer to finalize.
    fn await_finalized(&self, id: &str) {
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            if session_store::get_session(&self.root, id)
                .is_ok_and(|manifest| manifest.status != SessionStatus::Recording)
            {
                return;
            }
            assert!(Instant::now() < until, "writer never finalized {id}");
            thread::sleep(Duration::from_millis(5));
        }
    }
    /// Waits until the writer has actually opened `id`: the status names it and
    /// its directory and manifest exist. Necessary before reading per-session
    /// counters, which still hold the previous session's values until then.
    fn await_recording(&self, id: &str) {
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            let status = self.recorder.status();
            if status.recording
                && status.session_id.as_deref() == Some(id)
                && session_store::get_session(&self.root, id).is_ok()
            {
                return;
            }
            assert!(Instant::now() < until, "writer never opened {id}");
            thread::sleep(Duration::from_millis(5));
        }
    }
    fn await_frames(&self, at_least: u64) {
        let until = Instant::now() + Duration::from_secs(10);
        while self.recorder.status().frames_written < at_least {
            assert!(Instant::now() < until, "writer never reached {at_least}");
            thread::sleep(Duration::from_millis(5));
        }
    }
}

fn active(speed_mps: f32, rpm: f32, throttle: f32, brake: f32) -> TelemetryFrame {
    TelemetryFrame {
        active: true,
        game: Some("fh6".into()),
        vehicle_id: Some("123".into()),
        game_timestamp_ms: Some(42),
        engine: Engine {
            rpm: Some(rpm),
            idle_rpm: Some(800.0),
            max_rpm: Some(7500.0),
            power_w: Some(84_286.8),
            torque_nm: Some(140.55),
        },
        speed_mps: Some(speed_mps),
        controls: Controls {
            throttle: Some(throttle),
            brake: Some(brake),
            clutch: Some(0.0),
            handbrake: Some(0.0),
            steering: Some(-0.25),
        },
        ..TelemetryFrame::default()
    }
}

fn inactive() -> TelemetryFrame {
    TelemetryFrame {
        active: false,
        game: Some("fh6".into()),
        game_timestamp_ms: Some(43),
        ..TelemetryFrame::default()
    }
}

/// A corner whose seven channels are distinct and separated from every other
/// corner's, so any transposition shows up as a mismatched number.
fn corner(base: f32) -> Wheel {
    Wheel {
        temperature_c: Some(base + 0.5),
        slip_ratio: Some(base + 1.25),
        slip_angle: Some(base + 2.125),
        combined_slip: Some(base + 3.0625),
        rotation_rad_s: Some(base + 4.5),
        normalized_suspension_travel: Some(base / 100.0),
        suspension_travel_m: Some(base / 1000.0),
    }
}

/// Every canonical field populated, including a source-specific envelope with
/// nested nulls, floats, integers and arrays.
fn saturated() -> TelemetryFrame {
    TelemetryFrame {
        active: true,
        game: Some("fh6".into()),
        vehicle_id: Some("2599".into()),
        game_timestamp_ms: Some(1_234_567_890),
        engine: Engine {
            rpm: Some(6123.25),
            idle_rpm: Some(812.5),
            max_rpm: Some(7300.75),
            power_w: Some(123_456.75),
            torque_nm: Some(321.125),
        },
        acceleration: Some(Vector3 {
            x: -1.5,
            y: 0.25,
            z: 9.81,
        }),
        velocity: Some(Vector3 {
            x: 12.5,
            y: -0.125,
            z: 30.0,
        }),
        angular_velocity: Some(Vector3 {
            x: 0.001,
            y: -0.002,
            z: 0.003,
        }),
        orientation: Some(Vector3 {
            x: 1.751_25,
            y: -0.5,
            z: 0.25,
        }),
        position: Some(Vector3 {
            x: -1234.5,
            y: 67.125,
            z: 8901.25,
        }),
        speed_mps: Some(32.5),
        controls: Controls {
            throttle: Some(0.996_078_4),
            brake: Some(0.003_921_6),
            clutch: Some(0.5),
            handbrake: Some(1.0),
            steering: Some(-0.992_126),
        },
        gear: Some(Gear::Forward(4)),
        vehicle: Vehicle {
            class_code: Some(5),
            performance_index: Some(842),
            drivetrain_code: Some(1),
            cylinders: Some(12),
        },
        // Every corner and every channel gets a distinct value, so a
        // round-trip that transposed two corners or two channels would fail.
        wheels: Wheels {
            front_left: corner(10.0),
            front_right: corner(20.0),
            rear_left: corner(30.0),
            rear_right: corner(40.0),
        },
        race: Race {
            lap_number: Some(7),
            race_position: Some(3),
            race_time_seconds: Some(421.5),
        },
        source_specific: Some(serde_json::json!({
            "fh6": {
                "car_ordinal": 2599,
                "tire_temperatures": [180.5, 181.25, 179.0, 178.75],
                "distance_traveled": 1234.5_f32,
                "unimplemented_68_211": [0, 1, 2, 254, 255],
                "float_fields": { "8": 7300.75_f32, "256": 32.5_f32 },
                "absent": serde_json::Value::Null,
                "nested": { "deep": { "flag": true, "text": "menu" } }
            }
        })),
    }
}

// ---------------------------------------------------------------- automation

#[test]
fn session_active_automatically_creates_a_recorder_using_the_existing_session_id() {
    let rig = rig("auto-start");
    assert!(!rig.recorder.status().recording);
    rig.hub
        .publish(active(10.0, 3000.0, 1.0, 0.0), 0, Some(1_800_000_000_000));
    let id = rig.session_id();
    rig.await_frames(1);
    let status = rig.recorder.status();
    // No Start Recording command exists; the SessionEngine ID is reused verbatim.
    assert!(status.recording);
    assert_eq!(status.session_id.as_deref(), Some(id.as_str()));
    assert_eq!(id, "test-1");
    assert!(rig.directory(&id).join(FRAME_FILE_NAME).is_file());
    let manifest = session_store::get_session(&rig.root, &id).unwrap();
    assert_eq!(manifest.status, SessionStatus::Recording);
    assert_eq!(manifest.session_id, id);
    assert_eq!(manifest.game.as_deref(), Some("fh6"));
    assert!(manifest.summary.is_none());
}

#[test]
fn grace_keeps_the_same_writer_and_completion_finalizes_exactly_one_session() {
    let rig = rig_with("grace", RECORDER_QUEUE_CAPACITY, 500, 60_000);
    rig.hub
        .publish(active(10.0, 3000.0, 1.0, 0.0), 0, Some(1_800_000_000_000));
    let id = rig.session_id();
    let directory = rig.directory(&id);
    // ACTIVE -> GRACE -> ACTIVE -> GRACE -> COMPLETED.
    rig.hub.publish(inactive(), 100, None);
    rig.hub.tick(200);
    rig.await_frames(2);
    assert_eq!(rig.session_id(), id);
    assert!(
        rig.recorder.status().recording,
        "grace must keep the same recorder open"
    );
    assert_eq!(
        rig.recorder.status().session_id.as_deref(),
        Some(id.as_str())
    );
    rig.hub.publish(active(20.0, 4000.0, 1.0, 0.0), 300, None);
    assert_eq!(rig.session_id(), id);
    rig.hub.publish(inactive(), 400, None);
    rig.await_frames(4);
    assert_eq!(
        session_store::get_session(&rig.root, &id).unwrap().status,
        SessionStatus::Recording,
        "grace must not finalize the manifest"
    );
    rig.hub.tick(1000);
    rig.await_finalized(&id);
    let manifest = session_store::get_session(&rig.root, &id).unwrap();
    assert_eq!(manifest.status, SessionStatus::Completed);
    assert_eq!(manifest.completion_reason.as_deref(), Some("grace_expired"));
    assert_eq!(manifest.frame_count, 4);
    assert_eq!(manifest.active_frame_count, 2);
    assert_eq!(manifest.inactive_frame_count, 2);
    assert_eq!(manifest.recorder_dropped_frames, 0);
    assert!(manifest.summary.is_some());
    // Exactly one directory, one frame file, one manifest.
    assert_eq!(fs::read_dir(&rig.root).unwrap().count(), 1);
    assert_eq!(
        fs::read_dir(&directory)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name == FRAME_FILE_NAME || name == MANIFEST_FILE_NAME)
            .count(),
        2
    );
    let (_, frames) = session_format::read_all_frames(&directory.join(FRAME_FILE_NAME)).unwrap();
    assert_eq!(frames.len(), 4);
    assert_eq!(
        frames.iter().map(|f| f.monotonic_ms).collect::<Vec<_>>(),
        vec![0, 100, 300, 400]
    );
    assert!(frames.windows(2).all(|w| w[0].sequence < w[1].sequence));
}

#[test]
fn a_new_lifecycle_session_creates_a_new_directory_and_session_id() {
    let rig = rig_with("new-session", RECORDER_QUEUE_CAPACITY, 500, 60_000);
    rig.hub
        .publish(active(10.0, 3000.0, 1.0, 0.0), 0, Some(1_800_000_000_000));
    let first = rig.session_id();
    rig.hub.publish(inactive(), 100, None);
    rig.hub.tick(2000);
    rig.await_finalized(&first);
    rig.hub.publish(
        active(15.0, 3500.0, 1.0, 0.0),
        3000,
        Some(1_800_000_003_000),
    );
    let second = rig.session_id();
    assert_ne!(first, second);
    rig.hub.finish_session(3500, "test_complete");
    rig.await_finalized(&second);
    assert!(rig.directory(&first).is_dir() && rig.directory(&second).is_dir());
    let listed = session_store::list_recent_sessions(&rig.root, None);
    assert_eq!(listed.sessions.len(), 2);
    assert!(listed
        .sessions
        .iter()
        .all(|m| m.status == SessionStatus::Completed));
}

// ------------------------------------------------------------- round-tripping

#[test]
fn a_fully_populated_frame_round_trips_losslessly() {
    let rig = rig("roundtrip");
    let original = saturated();
    rig.hub
        .publish(original.clone(), 0, Some(1_800_000_000_000));
    let id = rig.session_id();
    rig.hub.finish_session(50, "test_complete");
    rig.await_finalized(&id);
    let path = rig.directory(&id).join(FRAME_FILE_NAME);
    let (header, frames) = session_format::read_all_frames(&path).unwrap();
    assert_eq!(header.session_id, id);
    assert_eq!(
        header.telemetry_frame_schema_version,
        TELEMETRY_FRAME_SCHEMA_VERSION
    );
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].frame, original);
    assert_eq!(frames[0].monotonic_ms, 0);
    // Source-specific data survives byte-for-byte, including nested nulls.
    let stored = frames[0].frame.source_specific.as_ref().unwrap();
    assert_eq!(stored, original.source_specific.as_ref().unwrap());
    assert!(stored["fh6"]["absent"].is_null());
    assert_eq!(stored["fh6"]["tire_temperatures"][1], 181.25);
    assert_eq!(stored["fh6"]["nested"]["deep"]["text"], "menu");
}

#[test]
fn null_canonical_fields_remain_null_and_zero_remains_zero() {
    let rig = rig("nullability");
    let mut zeroed = active(0.0, 0.0, 0.0, 0.0);
    zeroed.gear = Some(Gear::Neutral);
    rig.hub.publish(inactive(), 0, Some(1_800_000_000_000));
    // An inactive first frame cannot start a session; start one, then store both.
    rig.hub.publish(zeroed.clone(), 10, Some(1_800_000_000_010));
    let id = rig.session_id();
    rig.hub.publish(inactive(), 20, None);
    rig.hub.finish_session(30, "test_complete");
    rig.await_finalized(&id);
    let (_, frames) =
        session_format::read_all_frames(&rig.directory(&id).join(FRAME_FILE_NAME)).unwrap();
    assert_eq!(frames.len(), 2);
    let restored_zero = &frames[0].frame;
    assert_eq!(restored_zero.speed_mps, Some(0.0));
    assert_eq!(restored_zero.engine.rpm, Some(0.0));
    assert_eq!(restored_zero.controls.throttle, Some(0.0));
    assert_eq!(restored_zero.gear, Some(Gear::Neutral));
    let restored_null = &frames[1].frame;
    assert!(!restored_null.active);
    assert_eq!(restored_null.speed_mps, None);
    assert_eq!(restored_null.engine.rpm, None);
    assert_eq!(restored_null.controls.throttle, None);
    assert_eq!(restored_null.velocity, None);
    assert_eq!(restored_null.gear, None);
    assert_eq!(restored_null.vehicle_id, None);
    assert_eq!(restored_null.source_specific, None);
    assert_eq!(restored_null, &inactive());
}

#[test]
fn every_canonical_gear_variant_round_trips() {
    let mut buffer = Vec::new();
    let variants = [
        Gear::Unknown,
        Gear::Reverse,
        Gear::Neutral,
        Gear::Forward(6),
        Gear::Unmapped(11),
    ];
    for (index, gear) in variants.iter().enumerate() {
        let mut frame = active(1.0, 1.0, 0.0, 0.0);
        frame.gear = Some(*gear);
        session_format::write_frame(&mut buffer, index as u64, index as u64, &frame).unwrap();
    }
    let mut decoded = Vec::new();
    let mut cursor = &buffer[..];
    for index in 0..variants.len() {
        let len = u32::from_le_bytes(cursor[1..5].try_into().unwrap()) as usize;
        let record: racelab_lib::session_format::RecordedFrame =
            rmp_serde::from_slice(&cursor[5..5 + len]).unwrap();
        assert_eq!(record.sequence, index as u64);
        decoded.push(record.frame.gear.unwrap());
        cursor = &cursor[5 + len..];
    }
    assert_eq!(decoded, variants);
}

// ------------------------------------------------------------------- pressure

/// A deliberately expensive per-frame encode makes the writer much slower than
/// the publisher, which is exactly the pressure the bounded queue exists for.
fn heavy() -> TelemetryFrame {
    let mut frame = active(10.0, 3000.0, 1.0, 0.0);
    frame.source_specific = Some(serde_json::json!({
        "fh6": { "unimplemented_68_211": (0..20_000).collect::<Vec<u32>>() }
    }));
    frame
}

const OVERFLOW_FRAMES: u64 = 600;

#[test]
fn a_slow_writer_overflows_the_bounded_queue_instead_of_blocking_the_hub() {
    let rig = rig_with("overflow", 1, 60_000, 60_000);
    assert_eq!(rig.recorder.status().queue_capacity, 1);
    let frame = heavy();
    let started = Instant::now();
    let mut slowest = Duration::ZERO;
    for n in 0..OVERFLOW_FRAMES {
        let at = Instant::now();
        rig.hub
            .publish(frame.clone(), n, Some(1_800_000_000_000 + n));
        slowest = slowest.max(at.elapsed());
        // Queue memory never grows past the configured capacity.
        assert!(rig.recorder.status().queued_frames <= 1);
    }
    let elapsed = started.elapsed();
    let id = rig.session_id();
    rig.hub.finish_session(OVERFLOW_FRAMES, "test_complete");
    rig.await_finalized(&id);
    let manifest = session_store::get_session(&rig.root, &id).unwrap();
    assert!(
        manifest.recorder_dropped_frames > 0,
        "forced overflow must be counted"
    );
    assert!(manifest.frame_count > 0);
    assert_eq!(
        manifest.frame_count + manifest.recorder_dropped_frames,
        OVERFLOW_FRAMES,
        "every published frame is either written or counted as dropped"
    );
    assert!(!manifest.summary.as_ref().unwrap().data_quality.complete);
    assert_eq!(
        manifest
            .summary
            .as_ref()
            .unwrap()
            .data_quality
            .recorder_dropped_frames,
        manifest.recorder_dropped_frames
    );
    // Ingestion is never charged for the writer's work.
    assert!(
        elapsed < Duration::from_secs(20) && slowest < Duration::from_secs(1),
        "publishing blocked behind the writer: {elapsed:?}, slowest {slowest:?}"
    );
    assert!(rig.recorder.status().queued_frames <= 1);
}

#[test]
fn a_paced_seventy_five_hertz_session_records_without_dropping_frames() {
    let rig = rig("paced-75hz");
    let hub = Arc::clone(&rig.hub);
    let period = Duration::from_micros(13_333); // 75 Hz
    let started = Instant::now();
    let mut published = 0u64;
    while started.elapsed() < Duration::from_secs(3) {
        let now = started.elapsed().as_millis() as u64;
        hub.publish(
            active(40.0, 5200.0, 0.98, 0.0),
            now,
            Some(1_800_000_000_000 + now),
        );
        published += 1;
        // Pace against an absolute deadline, like the 60 Hz UDP test below.
        // `sleep(period)` compounds Windows' ~15.6 ms timer granularity into
        // steadily growing drift, which understates the rate this test paces at.
        let due = started + period * published as u32;
        let now = Instant::now();
        if now < due {
            thread::sleep(due - now);
        }
    }
    let id = rig.session_id();
    let elapsed = started.elapsed().as_millis() as u64;
    rig.hub.finish_session(elapsed, "test_complete");
    rig.await_finalized(&id);
    let manifest = session_store::get_session(&rig.root, &id).unwrap();
    assert!(
        published >= 150,
        "expected a realistic frame rate: {published} frames in {}ms",
        started.elapsed().as_millis()
    );
    assert_eq!(manifest.recorder_dropped_frames, 0);
    assert_eq!(manifest.frame_count, published);
    assert_eq!(hub.stats().subscriber_drops, 0);
    assert!(manifest.summary.as_ref().unwrap().data_quality.complete);
}

// -------------------------------------------------------------------- summary

/// Deliberately uneven sample spacing: a naive mean of the samples would be
/// 30 km/h-equivalent, the time-weighted answer is not.
#[test]
fn summary_statistics_are_time_weighted_over_monotonic_frame_timing() {
    let rig = rig("summary");
    let samples: [(u64, f32, f32, f32, f32); 3] = [
        (0, 10.0, 2000.0, 1.0, 0.0),
        (100, 50.0, 6000.0, 0.94, 0.06),
        (900, 50.0, 6000.0, 0.0, 1.0),
    ];
    for (index, (t, speed, rpm, throttle, brake)) in samples.iter().enumerate() {
        let mut frame = active(*speed, *rpm, *throttle, *brake);
        frame.gear = Some(Gear::Forward(index as u16 + 1));
        rig.hub.publish(frame, *t, Some(1_800_000_000_000 + t));
    }
    let id = rig.session_id();
    rig.hub.finish_session(900, "test_complete");
    rig.await_finalized(&id);
    let summary = session_store::get_session(&rig.root, &id)
        .unwrap()
        .summary
        .unwrap();
    assert_eq!(summary.frame_count, 3);
    assert!((summary.duration_seconds - 0.9).abs() < 1e-9);
    assert!((summary.measured_seconds - 0.9).abs() < 1e-9);
    // max over samples, average weighted by the interval each sample covers.
    assert!((summary.max_speed_kmh.unwrap() - 180.0).abs() < 1e-6);
    let expected_mps = (10.0 * 0.1 + 50.0 * 0.8) / 0.9;
    assert!((summary.average_speed_kmh.unwrap() - expected_mps * 3.6).abs() < 1e-6);
    assert!((summary.max_rpm.unwrap() - 6000.0).abs() < 1e-6);
    let expected_rpm = (2000.0 * 0.1 + 6000.0 * 0.8) / 0.9;
    assert!((summary.average_rpm.unwrap() - expected_rpm).abs() < 1e-6);
    // Full throttle: only the first sample's 100 ms is >= 0.95.
    assert!((summary.full_throttle_seconds - 0.1).abs() < 1e-9);
    assert!((summary.full_throttle_percent.unwrap() - 100.0 / 9.0).abs() < 1e-6);
    // Braking: only the second sample's 800 ms is > 0.05.
    assert!((summary.braking_seconds - 0.8).abs() < 1e-9);
    assert!((summary.braking_percent.unwrap() - 800.0 / 9.0).abs() < 1e-6);
    assert_eq!(summary.gear_change_count, Some(2));
    let expected_distance = 10.0 * 0.1 + 50.0 * 0.8;
    assert!((summary.distance_meters.unwrap() - expected_distance).abs() < 1e-6);
    assert!(summary.data_quality.complete);
    assert_eq!(summary.data_quality.excluded_gaps, 0);
}

#[test]
fn unavailable_summary_channels_stay_null_and_long_gaps_are_excluded() {
    let rig = rig("summary-null");
    let mut bare = TelemetryFrame {
        active: true,
        game: Some("fh6".into()),
        ..TelemetryFrame::default()
    };
    rig.hub.publish(bare.clone(), 0, Some(1_800_000_000_000));
    let id = rig.session_id();
    bare.game_timestamp_ms = Some(1);
    rig.hub.publish(bare.clone(), 50, None);
    // A gap beyond the sampling limit is a telemetry hole, not measured time.
    rig.hub
        .publish(bare, 50 + MAX_SAMPLE_GAP_MS + 500, Some(1_800_000_001_550));
    let end = 50 + MAX_SAMPLE_GAP_MS + 500;
    rig.hub.finish_session(end, "test_complete");
    rig.await_finalized(&id);
    let summary = session_store::get_session(&rig.root, &id)
        .unwrap()
        .summary
        .unwrap();
    assert_eq!(summary.max_speed_kmh, None);
    assert_eq!(summary.average_speed_kmh, None);
    assert_eq!(summary.max_rpm, None);
    assert_eq!(summary.average_rpm, None);
    assert_eq!(summary.full_throttle_percent, None);
    assert_eq!(summary.braking_percent, None);
    assert_eq!(summary.gear_change_count, None);
    assert_eq!(summary.distance_meters, None);
    assert_eq!(summary.full_throttle_seconds, 0.0);
    assert_eq!(summary.data_quality.excluded_gaps, 1);
    assert!((summary.measured_seconds - 0.05).abs() < 1e-9);
    assert!((summary.duration_seconds - end as f64 / 1000.0).abs() < 1e-9);
}

// ---------------------------------------------------------- crash safety/store

/// The writer checkpoints on its own elapsed-time deadline. A timeout-only
/// checkpoint (the pre-hardening behaviour) could never fire here: frames
/// arrive far faster than the interval, so every receive returns `Ok` and an
/// idle-receive timer would be reset forever.
#[test]
fn the_recording_manifest_is_checkpointed_while_frames_arrive_continuously() {
    let interval = Duration::from_millis(120);
    let rig = rig_with_checkpoint(
        "checkpoint-live",
        RECORDER_QUEUE_CAPACITY,
        60_000,
        60_000,
        interval,
    );
    rig.hub
        .publish(active(40.0, 5000.0, 1.0, 0.0), 0, Some(1_800_000_000_000));
    let id = rig.session_id();
    rig.await_recording(&id);

    // Publish continuously so the queue is never idle for a whole interval,
    // sampling the on-disk manifest as it goes.
    let mut observations: Vec<(u64, u64)> = Vec::new();
    let started = Instant::now();
    let mut monotonic = 0u64;
    while started.elapsed() < interval * 5 && observations.len() < 3 {
        monotonic += 5;
        rig.hub.publish(
            active(40.0, 5000.0, 1.0, 0.0),
            monotonic,
            Some(1_800_000_000_000 + monotonic),
        );
        thread::sleep(Duration::from_millis(5));
        let manifest = session_store::get_session(&rig.root, &id).unwrap();
        // Still recording: a checkpoint must never finalize or add a summary.
        assert_eq!(manifest.status, SessionStatus::Recording);
        assert!(manifest.summary.is_none(), "a checkpoint is not a summary");
        let sample = (manifest.frame_count, manifest.duration_us);
        if manifest.frame_count > 0 && observations.last() != Some(&sample) {
            observations.push(sample);
        }
    }
    assert!(
        observations.len() >= 2,
        "the manifest was never refreshed during continuous traffic: {observations:?}"
    );
    // Successive checkpoints advance: counts and duration are current, not stale.
    assert!(observations[1].0 > observations[0].0, "{observations:?}");
    assert!(observations[1].1 > observations[0].1, "{observations:?}");
    // A checkpoint never claims more frames than the frame file actually holds.
    //
    // The stream is still being appended to here, and `read_all_frames` is a
    // strict reader: catching the writer mid-record is an `UnexpectedEof`,
    // which is the right answer for a finished file and a race for a live one.
    // Retrying is what makes this deterministic — a torn tail is transient
    // because the writer always completes the record it started — and it keeps
    // the assertion below exactly as strict as it was.
    let frames = rig.directory(&id).join(FRAME_FILE_NAME);
    let mut on_disk = None;
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        match session_format::read_all_frames(&frames) {
            Ok((_, read)) => {
                on_disk = Some(read);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
                thread::sleep(Duration::from_millis(5));
            }
            Err(error) => panic!("the frame stream could not be read: {error}"),
        }
    }
    let on_disk = on_disk.expect("the frame stream never settled into whole records");
    assert!(on_disk.len() as u64 >= observations[1].0);

    // Finalization is unchanged by checkpointing.
    rig.hub.finish_session(monotonic, "test_complete");
    rig.await_finalized(&id);
    let final_manifest = session_store::get_session(&rig.root, &id).unwrap();
    assert_eq!(final_manifest.status, SessionStatus::Completed);
    assert!(final_manifest.summary.is_some());
    assert!(final_manifest.frame_count > observations[1].0);
    assert_eq!(final_manifest.duration_us, monotonic * 1000);
    assert_eq!(final_manifest.recorder_dropped_frames, 0);
}

/// Replaces the former hand-written-manifest test: the `recording` manifest
/// this reclassifies is produced by the real writer's real checkpoint, so the
/// preserved counts are genuinely checkpointed ones.
#[test]
fn an_interrupted_session_keeps_its_real_checkpointed_counts_and_never_completes() {
    let interval = Duration::from_millis(120);
    let rig = rig_with_checkpoint(
        "interrupted",
        RECORDER_QUEUE_CAPACITY,
        60_000,
        60_000,
        interval,
    );
    rig.hub
        .publish(active(30.0, 4000.0, 1.0, 0.0), 0, Some(1_700_000_000_000));
    let id = rig.session_id();
    rig.await_recording(&id);
    let mut monotonic = 0u64;
    let started = Instant::now();
    let checkpointed = loop {
        monotonic += 5;
        rig.hub.publish(
            active(30.0, 4000.0, 1.0, 0.0),
            monotonic,
            Some(1_700_000_000_000 + monotonic),
        );
        thread::sleep(Duration::from_millis(5));
        let manifest = session_store::get_session(&rig.root, &id).unwrap();
        if manifest.status == SessionStatus::Recording && manifest.frame_count > 0 {
            break manifest;
        }
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "no checkpoint was ever written"
        );
    };
    assert!(checkpointed.frame_count > 0 && checkpointed.duration_us > 0);

    // Simulate a process that died without finalizing: the checkpointed
    // directory is exactly what such a crash leaves behind on disk.
    let crashed = scratch("interrupted-crashed");
    let target = crashed.join(&id);
    fs::create_dir_all(&target).unwrap();
    for file in [FRAME_FILE_NAME, MANIFEST_FILE_NAME] {
        fs::copy(rig.directory(&id).join(file), target.join(file)).unwrap();
    }
    assert_eq!(
        session_store::get_session(&crashed, &id).unwrap().status,
        SessionStatus::Recording,
        "the copied crash state must still say recording"
    );

    let recorder = SessionRecorder::new(crashed.clone()).unwrap();
    let reloaded = session_store::get_session(&crashed, &id).unwrap();
    assert_eq!(reloaded.status, SessionStatus::Interrupted);
    assert_ne!(reloaded.status, SessionStatus::Completed);
    assert!(reloaded.summary.is_none(), "incomplete data has no summary");
    assert_eq!(
        reloaded.completion_reason.as_deref(),
        Some("interrupted_racelab_did_not_finalize")
    );
    // The whole point: real checkpointed counts survive reclassification.
    assert_eq!(reloaded.frame_count, checkpointed.frame_count);
    assert_eq!(reloaded.duration_us, checkpointed.duration_us);
    assert!(reloaded.frame_count > 0);
    // The frames the checkpoint claimed are really readable from the copy.
    let (_, frames) = session_format::read_all_frames(&target.join(FRAME_FILE_NAME)).unwrap();
    assert!(frames.len() as u64 >= reloaded.frame_count);
    // A second startup is idempotent.
    drop(recorder);
    let _second = SessionRecorder::new(crashed.clone()).unwrap();
    assert_eq!(session_store::get_session(&crashed, &id).unwrap(), reloaded);

    rig.hub.finish_session(monotonic, "test_complete");
    rig.await_finalized(&id);
}

/// Issue 2: the live status must report elapsed session time while recording,
/// derived from the monotonic frame span the writer already owns.
#[test]
fn active_recorder_status_reports_live_increasing_duration() {
    let rig = rig("live-duration");
    rig.hub
        .publish(active(20.0, 3000.0, 1.0, 0.0), 0, Some(1_800_000_000_000));
    let id = rig.session_id();
    rig.await_frames(1);
    assert!(rig.recorder.status().recording);
    assert_eq!(
        rig.recorder.status().duration_ms,
        0,
        "a single frame spans no time yet"
    );

    let mut previous = 0;
    for monotonic in [250u64, 500, 1200, 2400] {
        rig.hub.publish(
            active(20.0, 3000.0, 1.0, 0.0),
            monotonic,
            Some(1_800_000_000_000 + monotonic),
        );
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            let status = rig.recorder.status();
            if status.duration_ms >= monotonic {
                assert!(status.recording, "duration must be live, not post-hoc");
                assert!(
                    status.duration_ms >= previous,
                    "duration went backwards: {} -> {}",
                    previous,
                    status.duration_ms
                );
                previous = status.duration_ms;
                break;
            }
            assert!(
                Instant::now() < until,
                "active duration stuck at {} for monotonic {monotonic}",
                status.duration_ms
            );
            thread::sleep(Duration::from_millis(5));
        }
    }
    assert!(previous >= 2400, "duration never advanced: {previous}");

    // Completed behaviour is unchanged: the authoritative SessionEngine
    // duration still wins at finalization.
    rig.hub.finish_session(3000, "test_complete");
    rig.await_finalized(&id);
    let manifest = session_store::get_session(&rig.root, &id).unwrap();
    assert_eq!(manifest.duration_us, 3_000_000);
    assert_eq!(rig.recorder.status().duration_ms, 3000);
    assert!(!rig.recorder.status().recording);
}

/// Issue 3: a drop in one session must not leave a later clean session
/// looking lossy. The lifetime total stays available as a diagnostic.
#[test]
fn recorder_drops_are_per_session_and_a_clean_session_reports_zero() {
    // Capacity 1 plus an expensive encode forces real overflow in session A.
    const PRESSURE_FRAMES: u64 = 150;
    let rig = rig_with("drop-scope", 1, 60_000, 60_000);
    let heavy_frame = heavy();
    for n in 0..PRESSURE_FRAMES {
        rig.hub
            .publish(heavy_frame.clone(), n, Some(1_800_000_000_000 + n));
    }
    let first = rig.session_id();
    let during = rig.recorder.status();
    assert!(
        during.recorder_dropped_frames > 0,
        "session A must actually drop"
    );
    assert_eq!(
        during.lifetime_dropped_frames, during.recorder_dropped_frames,
        "the first session's drops are also the lifetime total"
    );
    rig.hub.finish_session(PRESSURE_FRAMES, "test_complete");
    rig.await_finalized(&first);
    let manifest_a = session_store::get_session(&rig.root, &first).unwrap();
    let dropped_a = manifest_a.recorder_dropped_frames;
    assert!(dropped_a > 0);
    assert_eq!(
        manifest_a.frame_count + dropped_a,
        PRESSURE_FRAMES,
        "every published frame is written or counted"
    );

    // Session B: a new lifecycle session, published slowly enough to be clean.
    rig.hub.publish(
        active(10.0, 3000.0, 1.0, 0.0),
        PRESSURE_FRAMES + 100,
        Some(1_800_000_100_000),
    );
    let second = rig.session_id();
    assert_ne!(first, second);
    rig.await_recording(&second);
    rig.await_frames(1);
    let clean = rig.recorder.status();
    assert_eq!(
        clean.recorder_dropped_frames, 0,
        "a clean session must not inherit session A's drops"
    );
    assert!(clean.recording);
    assert_eq!(
        clean.lifetime_dropped_frames, dropped_a,
        "the lifetime diagnostic still remembers session A"
    );
    rig.hub
        .finish_session(PRESSURE_FRAMES + 200, "test_complete");
    rig.await_finalized(&second);
    let manifest_b = session_store::get_session(&rig.root, &second).unwrap();
    assert_eq!(manifest_b.recorder_dropped_frames, 0);
    assert!(manifest_b.summary.as_ref().unwrap().data_quality.complete);
    // Session A's own manifest is untouched by session B.
    assert_eq!(
        session_store::get_session(&rig.root, &first)
            .unwrap()
            .recorder_dropped_frames,
        dropped_a
    );
}

#[test]
fn one_corrupt_session_does_not_break_recent_sessions() {
    let rig = rig("corrupt");
    rig.hub
        .publish(active(10.0, 3000.0, 1.0, 0.0), 0, Some(1_800_000_000_000));
    let good = rig.session_id();
    rig.hub.finish_session(100, "test_complete");
    rig.await_finalized(&good);
    for (name, body) in [
        ("test-77", "{not json"),
        ("test-88", "{\"schema_version\":99}"),
    ] {
        let directory = rig.root.join(name);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join(MANIFEST_FILE_NAME), body).unwrap();
    }
    fs::create_dir_all(rig.root.join("test-99")).unwrap();
    let listed = session_store::list_recent_sessions(&rig.root, None);
    assert_eq!(listed.sessions.len(), 1);
    assert_eq!(listed.sessions[0].session_id, good);
    assert_eq!(listed.unreadable, 3);
    assert!(session_store::get_session(&rig.root, "test-77").is_err());
    assert!(session_store::get_session(&rig.root, "../escape").is_err());
}

#[test]
fn recent_sessions_are_newest_first_bounded_and_never_decode_frame_bodies() {
    let root = scratch("listing");
    for (index, started) in [
        (1u64, 1_800_000_003_000u64),
        (2, 1_800_000_001_000),
        (3, 1_800_000_002_000),
    ] {
        let id = format!("test-{index}");
        let directory = root.join(&id);
        fs::create_dir_all(&directory).unwrap();
        let mut manifest = session_format::SessionManifestV1::new(id, Some(started));
        manifest.status = SessionStatus::Completed;
        session_format::write_manifest_atomically(&directory, &manifest).unwrap();
        // Deliberately unreadable frame bodies: listing and details must not
        // touch them, and React never receives a frame array at all.
        fs::write(directory.join(FRAME_FILE_NAME), b"\0\0 not a frame stream").unwrap();
    }
    let listed = session_store::list_recent_sessions(&root, None);
    assert_eq!(
        listed
            .sessions
            .iter()
            .map(|m| m.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["test-1", "test-3", "test-2"]
    );
    assert_eq!(listed.limit, session_store::DEFAULT_RECENT_LIMIT);
    assert_eq!(
        session_store::list_recent_sessions(&root, Some(2))
            .sessions
            .len(),
        2
    );
    assert_eq!(session_store::list_recent_sessions(&root, Some(0)).limit, 1);
    assert_eq!(
        session_store::list_recent_sessions(&root, Some(10_000)).limit,
        session_store::MAX_RECENT_LIMIT
    );
    assert_eq!(
        session_store::get_session(&root, "test-2")
            .unwrap()
            .session_id,
        "test-2"
    );
    // The frame stream itself is what a decode would reject.
    assert!(session_format::read_all_frames(&root.join("test-2").join(FRAME_FILE_NAME)).is_err());
}

#[test]
fn a_truncated_frame_stream_is_readable_up_to_its_last_whole_record() {
    let rig = rig("truncated");
    for n in 0..5u64 {
        rig.hub.publish(
            active(10.0 + n as f32, 3000.0, 1.0, 0.0),
            n * 10,
            Some(1_800_000_000_000),
        );
    }
    let id = rig.session_id();
    rig.hub.finish_session(100, "test_complete");
    rig.await_finalized(&id);
    let path = rig.directory(&id).join(FRAME_FILE_NAME);
    let bytes = fs::read(&path).unwrap();
    let truncated = scratch("truncated-copy").join("frames.rlframes");
    fs::write(&truncated, &bytes[..bytes.len() / 2]).unwrap();
    let mut reader =
        FrameStreamReader::new(BufReader::new(fs::File::open(&truncated).unwrap())).unwrap();
    let mut recovered = 0;
    // Distinguish a clean end from an error instead of swallowing both.
    let outcome = loop {
        match reader.next_frame() {
            Ok(Some(_)) => recovered += 1,
            Ok(None) => break Ok(()),
            Err(error) => break Err(error),
        }
    };
    assert!(recovered > 0 && recovered < 5);
    // Cutting mid-record is a hard error, not a silent short read.
    let error = outcome.expect_err("a half record must not read as a clean end");
    assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
    // A crashed stream has no footer, and never pretends to have one.
    assert!(reader.end.is_none());
    let (_, whole) = session_format::read_all_frames(&path).unwrap();
    assert_eq!(whole.len(), 5);
}

// ------------------------------------------------- frame stream input safety

/// Builds a valid RLFRAMES v1 prefix, then lets each test append the exact
/// hostile bytes it is about. Versions are parameters so unsupported ones can
/// be written deliberately.
fn stream_prefix(frame_format_version: u32, telemetry_frame_schema_version: u32) -> Vec<u8> {
    let mut bytes = Vec::new();
    session_format::write_stream_header(
        &mut bytes,
        &session_format::FrameStreamHeader {
            frame_format_version,
            telemetry_frame_schema_version,
            session_id: "test-1".into(),
            started_at_unix_ms: 1_800_000_000_000,
        },
    )
    .unwrap();
    bytes
}

fn read_error(bytes: &[u8]) -> io::Error {
    let mut reader = match FrameStreamReader::new(bytes) {
        Ok(reader) => reader,
        Err(error) => return error,
    };
    loop {
        match reader.next_frame() {
            Ok(Some(_)) => continue,
            Ok(None) => panic!("expected a rejection, the stream read cleanly"),
            Err(error) => return error,
        }
    }
}

#[test]
fn an_unsupported_frame_format_version_is_rejected() {
    let error = read_error(&stream_prefix(2, TELEMETRY_FRAME_SCHEMA_VERSION));
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(
        error
            .to_string()
            .contains("Unsupported frame stream version"),
        "{error}"
    );
    // v1 is still accepted, so the check is a version gate, not a blanket fail.
    assert!(FrameStreamReader::new(&stream_prefix(1, TELEMETRY_FRAME_SCHEMA_VERSION)[..]).is_ok());
}

#[test]
fn an_unsupported_telemetry_frame_schema_version_is_rejected_not_best_effort_decoded() {
    let error = read_error(&stream_prefix(
        session_format::FRAME_FORMAT_VERSION,
        TELEMETRY_FRAME_SCHEMA_VERSION + 1,
    ));
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(
        error
            .to_string()
            .contains("Unsupported telemetry frame schema version"),
        "{error}"
    );
}

#[test]
fn a_manifest_advertising_unsupported_stream_versions_is_rejected() {
    let root = scratch("manifest-versions");
    // (id, frame format version, telemetry frame schema version)
    for (index, frame_format, frame_schema) in [
        (
            1u32,
            session_format::FRAME_FORMAT_VERSION + 1,
            TELEMETRY_FRAME_SCHEMA_VERSION,
        ),
        (
            2,
            session_format::FRAME_FORMAT_VERSION,
            TELEMETRY_FRAME_SCHEMA_VERSION + 6,
        ),
    ] {
        let id = format!("test-{index}");
        let directory = root.join(&id);
        fs::create_dir_all(&directory).unwrap();
        let mut manifest = session_format::SessionManifestV1::new(id.clone(), Some(1_800_000_000));
        manifest.status = SessionStatus::Completed;
        manifest.frame_format_version = frame_format;
        manifest.telemetry_frame_schema_version = frame_schema;
        session_format::write_manifest_atomically(&directory, &manifest).unwrap();
        assert!(
            session_store::get_session(&root, &id).is_err(),
            "{id} must not be readable by this build"
        );
    }
    // Neither is listed, and neither takes the listing down with it.
    let listed = session_store::list_recent_sessions(&root, None);
    assert!(listed.sessions.is_empty());
    assert_eq!(listed.unreadable, 2);
}

#[test]
fn an_oversized_record_length_prefix_is_rejected_before_allocating() {
    let mut bytes = stream_prefix(
        session_format::FRAME_FORMAT_VERSION,
        TELEMETRY_FRAME_SCHEMA_VERSION,
    );
    bytes.push(1); // record tag
    let oversized = session_format::MAX_RECORD_BYTES as u32 + 1;
    bytes.extend_from_slice(&oversized.to_le_bytes());
    // Deliberately no payload: a reader that trusted the prefix would try to
    // allocate and then block on a body that does not exist.
    let error = read_error(&bytes);
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(
        error.to_string().contains("exceeds the record limit"),
        "{error}"
    );
}

#[test]
fn a_malformed_messagepack_payload_is_rejected() {
    let mut bytes = stream_prefix(
        session_format::FRAME_FORMAT_VERSION,
        TELEMETRY_FRAME_SCHEMA_VERSION,
    );
    // 0xc1 is the one byte MessagePack never assigns.
    let payload = [0xc1u8, 0xc1, 0xc1, 0xc1];
    bytes.push(1);
    bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&payload);
    let error = read_error(&bytes);
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(
        error.to_string().contains("Could not decode frame"),
        "{error}"
    );
}

#[test]
fn an_unknown_record_tag_is_rejected() {
    let mut bytes = stream_prefix(
        session_format::FRAME_FORMAT_VERSION,
        TELEMETRY_FRAME_SCHEMA_VERSION,
    );
    bytes.push(9); // neither the record (1) nor the end (2) tag
    let error = read_error(&bytes);
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(
        error
            .to_string()
            .contains("Unknown frame stream record type"),
        "{error}"
    );
}

#[test]
fn a_record_truncated_mid_payload_returns_a_clear_error() {
    let mut bytes = stream_prefix(
        session_format::FRAME_FORMAT_VERSION,
        TELEMETRY_FRAME_SCHEMA_VERSION,
    );
    let mut record = Vec::new();
    session_format::write_frame(&mut record, 0, 0, &active(10.0, 3000.0, 1.0, 0.0)).unwrap();
    // Keep the tag and the length prefix, cut the body in half.
    let keep = 5 + (record.len() - 5) / 2;
    bytes.extend_from_slice(&record[..keep]);
    let error = read_error(&bytes);
    assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
    // A header truncated before its session ID fails just as clearly.
    let header = stream_prefix(
        session_format::FRAME_FORMAT_VERSION,
        TELEMETRY_FRAME_SCHEMA_VERSION,
    );
    let short = FrameStreamReader::new(&header[..header.len() - 3]);
    assert_eq!(
        short.err().expect("a short header must fail").kind(),
        io::ErrorKind::UnexpectedEof
    );
}

#[test]
fn the_default_queue_capacity_is_bounded_and_documented() {
    assert_eq!(RECORDER_QUEUE_CAPACITY, 4096);
    let root = scratch("capacity");
    let recorder = SessionRecorder::new(root).unwrap();
    let status = recorder.status();
    assert_eq!(status.queue_capacity, RECORDER_QUEUE_CAPACITY);
    assert_eq!(status.queued_frames, 0);
    assert_eq!(status.status, "idle");
    assert!(!status.recording);
    assert!(SessionRecorder::with_capacity(scratch("zero"), 0).is_err());
}

#[test]
fn session_identifiers_can_never_escape_the_sessions_root() {
    assert!(session_format::is_safe_session_id("abc123-4"));
    for hostile in ["", "..", "../x", "a/b", "a\\b", "a:b", "a b", "a.b"] {
        assert!(!session_format::is_safe_session_id(hostile), "{hostile}");
    }
    assert!(!session_format::is_safe_session_id(&"a".repeat(200)));
}

fn assert_send_sync<T: Send + Sync>(_: &T) {}

#[test]
fn the_recorder_is_shareable_across_the_ingestion_and_lifecycle_threads() {
    let rig = rig("threading");
    assert_send_sync(&rig.recorder);
    let hub = Arc::clone(&rig.hub);
    let ticker = thread::spawn(move || {
        for n in 0..200u64 {
            hub.tick(n * 5);
        }
    });
    for n in 0..200u64 {
        rig.hub.publish(
            active(10.0, 3000.0, 1.0, 0.0),
            n * 5,
            Some(1_800_000_000_000),
        );
    }
    ticker.join().unwrap();
    let id = rig.session_id();
    rig.hub.finish_session(1000, "test_complete");
    rig.await_finalized(&id);
    assert_eq!(
        session_store::get_session(&rig.root, &id)
            .unwrap()
            .frame_count,
        200
    );
}

/// Longer soak; not part of the default suite.
#[test]
#[ignore = "long-running recorder soak"]
fn a_ten_minute_synthetic_session_stays_bounded() {
    let rig = rig("soak");
    let started = Instant::now();
    let mut published = 0u64;
    while started.elapsed() < Duration::from_secs(600) {
        let now = started.elapsed().as_millis() as u64;
        rig.hub.publish(
            active(40.0, 5200.0, 1.0, 0.0),
            now,
            Some(1_800_000_000_000 + now),
        );
        published += 1;
        assert!(rig.recorder.status().queued_frames <= RECORDER_QUEUE_CAPACITY);
        thread::sleep(Duration::from_micros(13_333));
    }
    let id = rig.session_id();
    rig.hub
        .finish_session(started.elapsed().as_millis() as u64, "test_complete");
    rig.await_finalized(&id);
    let manifest = session_store::get_session(&rig.root, &id).unwrap();
    assert_eq!(manifest.recorder_dropped_frames, 0);
    assert_eq!(manifest.frame_count, published);
}

// -------------------------------------------------------- end-to-end load

fn fh6_packet(time: u32, active: bool) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fh6/sample-01.rlcap");
    let mut reader = racelab_lib::capture_format::CaptureReader::new(BufReader::new(
        fs::File::open(path).unwrap(),
    ))
    .unwrap();
    while let Some(mut packet) = reader.next_packet().unwrap() {
        if packet.bytes[0] == 1 {
            packet.bytes[0..4].copy_from_slice(&i32::from(active).to_le_bytes());
            packet.bytes[4..8].copy_from_slice(&time.to_le_bytes());
            return packet.bytes;
        }
    }
    panic!("missing active fixture")
}

/// Real socket, real ingress, real FH6 adapter, real recorder: the whole V0.6
/// path under a realistic 60 Hz normalized telemetry load.
#[test]
fn sixty_hertz_udp_telemetry_records_with_no_drops_or_receive_errors() {
    use racelab_lib::{
        appliance::Appliance, capture::RawCaptureSink, live_telemetry::ConnectionConfig,
        session_format::SessionStatus, telemetry_hub::SessionRecorderHook,
    };
    let root = scratch("udp-load");
    let recorder = SessionRecorder::new(root.clone()).unwrap();
    let captures = scratch("udp-load-captures");
    let appliance = Appliance::new(
        Arc::new(RawCaptureSink::new(captures)),
        ConnectionConfig {
            grace_ms: 1000,
            ..Default::default()
        },
        0,
    )
    .unwrap();
    appliance
        .live
        .hub
        .attach_recorder(Arc::clone(&recorder) as Arc<dyn SessionRecorderHook>)
        .unwrap();
    let stats = appliance.automatic_start().unwrap();
    let destination = ("127.0.0.1", stats.bound_port.unwrap());
    let sender = std::net::UdpSocket::bind("127.0.0.1:0").unwrap();
    let started = Instant::now();
    let mut sent = 0u32;
    // 600 packets at 60 Hz, the rate a real FH6 stream produces.
    while sent < 600 {
        let due = started + Duration::from_micros(u64::from(sent) * 16_667);
        let now = Instant::now();
        if now < due {
            thread::sleep(due - now);
        }
        sender
            .send_to(&fh6_packet(sent * 16, true), destination)
            .unwrap();
        sent += 1;
        appliance.tick();
    }
    // The four pre-lock probe packets are validated but never published as
    // canonical frames, exactly as in V0.5.1; the rest all reach the recorder.
    let expected = u64::from(sent) - 4;
    let until = Instant::now() + Duration::from_secs(5);
    while appliance.live.snapshot().hub.published < expected {
        assert!(Instant::now() < until, "hub never received every packet");
        thread::sleep(Duration::from_millis(5));
    }
    let snapshot = appliance.live.snapshot();
    assert_eq!(snapshot.hub.published, expected);
    assert_eq!(snapshot.valid_active_fh6, u64::from(sent));
    let id = snapshot.session.as_ref().unwrap().id.clone();
    assert_eq!(snapshot.protocol.as_deref(), Some("fh6"));
    assert_eq!(snapshot.receive_errors, 0, "transport receive errors");
    assert_eq!(snapshot.hub.subscriber_drops, 0, "hub subscriber drops");
    assert_eq!(snapshot.invalid_fh6, 0);
    assert_eq!(snapshot.unknown_protocol, 0);
    assert_eq!(recorder.status().recorder_dropped_frames, 0);
    appliance.stop().unwrap();
    let until = Instant::now() + Duration::from_secs(10);
    while !session_store::get_session(&root, &id)
        .is_ok_and(|m| m.status != SessionStatus::Recording)
    {
        assert!(Instant::now() < until, "recorder never finalized {id}");
        thread::sleep(Duration::from_millis(5));
    }
    let manifest = session_store::get_session(&root, &id).unwrap();
    assert_eq!(manifest.status, SessionStatus::Completed);
    assert_eq!(manifest.recorder_dropped_frames, 0);
    assert_eq!(manifest.frame_count, expected);
    assert_eq!(manifest.active_frame_count, expected);
    let summary = manifest.summary.unwrap();
    assert!(summary.data_quality.complete);
    assert_eq!(summary.frame_count, expected);
    assert!(summary.max_speed_kmh.is_some() && summary.average_speed_kmh.is_some());
    // The stored stream is exactly what was published, in order.
    let (_, frames) =
        session_format::read_all_frames(&root.join(&id).join(FRAME_FILE_NAME)).unwrap();
    assert_eq!(frames.len() as u64, expected);
    assert!(frames
        .windows(2)
        .all(|w| w[0].monotonic_ms <= w[1].monotonic_ms));
    assert!(frames
        .iter()
        .all(|f| f.frame.active && f.frame.game.as_deref() == Some("fh6")));
    recorder.shutdown();
}

#[test]
fn a_new_recording_declares_telemetry_frame_schema_two_everywhere_it_is_advertised() {
    let rig = rig("schema-v2");
    rig.hub
        .publish(active(10.0, 3000.0, 1.0, 0.0), 0, Some(1_800_000_000_000));
    let id = rig.session_id();
    rig.hub.finish_session(50, "test_complete");
    rig.await_finalized(&id);

    let manifest = session_store::get_session(&rig.root, &id).unwrap();
    assert_eq!(manifest.telemetry_frame_schema_version, 2);
    // The container framing and the manifest's own JSON shape did not change,
    // so neither of their versions may move with the canonical schema.
    assert_eq!(manifest.frame_format_version, 1);
    assert_eq!(manifest.schema_version, 1);

    let (header, frames) =
        session_format::read_all_frames(&rig.directory(&id).join(FRAME_FILE_NAME)).unwrap();
    assert_eq!(header.telemetry_frame_schema_version, 2);
    // And the promoted canonical values really are in the recording.
    assert_eq!(frames[0].frame.engine.power_w, Some(84_286.8));
    assert_eq!(frames[0].frame.engine.torque_nm, Some(140.55));
}
