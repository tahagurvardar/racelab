//! V0.8 persistence compatibility.
//!
//! The V1 side of every test here is written by the `legacy` module below: a
//! hand-frozen copy of the exact schema-v1 serialized shape. It never refers to
//! the current canonical model, so these tests cannot pass by accident when V2
//! changes. Serializing today's `TelemetryFrame` and relabelling the version
//! number would not be a compatibility test at all, and is deliberately not
//! what happens here.
use racelab_lib::{
    session_format::{
        self, FrameStreamEnd, FrameStreamHeader, FrameStreamWriter, RecordedFrame,
        SessionManifestV1, SessionStatus, FRAME_FILE_NAME, FRAME_FORMAT_VERSION,
        SUPPORTED_TELEMETRY_FRAME_SCHEMA_VERSIONS, TELEMETRY_FRAME_SCHEMA_VERSION,
    },
    session_store,
    telemetry::{Controls, Engine, Gear, Race, TelemetryFrame, Vector3, Vehicle, Wheel, Wheels},
};
use std::{fs, io::Write, path::Path};

// ---------------------------------------------------------------- frozen V1

/// The exact shape RaceLab V0.6 and V0.7 wrote. Frozen: never edit these to
/// follow the canonical model.
mod legacy {
    use serde::Serialize;

    #[derive(Serialize)]
    pub struct Vector3 {
        pub x: f32,
        pub y: f32,
        pub z: f32,
    }

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
    #[serde(tag = "kind", content = "value", rename_all = "snake_case")]
    pub enum Gear {
        #[allow(dead_code)]
        Unknown,
        #[allow(dead_code)]
        Reverse,
        #[allow(dead_code)]
        Neutral,
        Forward(u16),
        #[allow(dead_code)]
        Unmapped(u16),
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
        pub gear: Option<Gear>,
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

/// A V1 frame with every canonical field populated and clearly distinct.
fn legacy_frame(active: bool) -> legacy::TelemetryFrame {
    legacy::TelemetryFrame {
        active,
        game: Some("fh6".into()),
        vehicle_id: Some("2599".into()),
        game_timestamp_ms: Some(1_234_567_890),
        engine: legacy::Engine {
            rpm: Some(6123.25),
            idle_rpm: Some(812.5),
            max_rpm: Some(7300.75),
        },
        acceleration: Some(legacy::Vector3 {
            x: -1.5,
            y: 0.25,
            z: 9.75,
        }),
        velocity: Some(legacy::Vector3 {
            x: 12.5,
            y: -0.125,
            z: 30.0,
        }),
        angular_velocity: Some(legacy::Vector3 {
            x: 0.001,
            y: -0.002,
            z: 0.003,
        }),
        orientation: Some(legacy::Vector3 {
            x: 1.75,
            y: -0.5,
            z: 0.25,
        }),
        position: Some(legacy::Vector3 {
            x: -1234.5,
            y: 67.125,
            z: 8901.25,
        }),
        speed_mps: Some(32.5),
        controls: legacy::Controls {
            throttle: Some(0.25),
            brake: Some(0.5),
            clutch: Some(0.75),
            handbrake: Some(1.0),
            steering: Some(-0.875),
        },
        gear: Some(legacy::Gear::Forward(4)),
        source_specific: Some(serde_json::json!({
            "fh6": {
                "car_ordinal": 2599,
                // A V1 recording's envelope held values a V2 field now has a
                // name for. They must not be mined to invent canonical data.
                "power": 84_286.8_f32,
                "torque": 140.55_f32,
                "tire_temperatures": [180.5, 181.25, 179.0, 178.75],
                "lap_number": 7,
                "current_race_time": 421.5_f32,
            }
        })),
    }
}

/// A V1 frame whose optional canonical values are all null, so "null stays
/// null" is tested as well as "value stays value".
fn legacy_null_frame() -> legacy::TelemetryFrame {
    legacy::TelemetryFrame {
        active: false,
        game: Some("fh6".into()),
        vehicle_id: None,
        game_timestamp_ms: Some(99),
        engine: legacy::Engine {
            rpm: None,
            idle_rpm: None,
            max_rpm: None,
        },
        acceleration: None,
        velocity: None,
        angular_velocity: None,
        orientation: None,
        position: None,
        speed_mps: None,
        controls: legacy::Controls {
            throttle: None,
            brake: None,
            clutch: None,
            handbrake: None,
            steering: None,
        },
        gear: None,
        source_specific: None,
    }
}

/// Writes a complete schema-v1 RLFRAMES file byte for byte, using the frozen
/// record shape and the container framing V0.6 produced.
fn write_legacy_stream(path: &Path, session_id: &str, frames: Vec<legacy::TelemetryFrame>) {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"RLFRM\r\n\0");
    bytes.extend_from_slice(&FRAME_FORMAT_VERSION.to_le_bytes());
    bytes.extend_from_slice(&1_u32.to_le_bytes()); // telemetry frame schema v1
    bytes.extend_from_slice(&(session_id.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&1_800_000_000_000_u64.to_le_bytes());
    bytes.extend_from_slice(session_id.as_bytes());
    let count = frames.len() as u64;
    for (index, frame) in frames.into_iter().enumerate() {
        let payload = rmp_serde::to_vec_named(&legacy::StoredFrame {
            sequence: index as u64 + 1,
            monotonic_ms: index as u64 * 16,
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
    fs::File::create(path).unwrap().write_all(&bytes).unwrap();
}

fn legacy_manifest(session_id: &str, schema_version: u32) -> SessionManifestV1 {
    let mut manifest = SessionManifestV1::new(session_id.into(), Some(1_800_000_000_000));
    manifest.status = SessionStatus::Completed;
    manifest.game = Some("fh6".into());
    manifest.protocol = Some("fh6".into());
    manifest.vehicle_id = Some("2599".into());
    manifest.frame_count = 2;
    manifest.active_frame_count = 1;
    manifest.inactive_frame_count = 1;
    manifest.duration_us = 16_000;
    manifest.completion_reason = Some("telemetry_idle".into());
    manifest.telemetry_frame_schema_version = schema_version;
    manifest
}

fn temp_root(name: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("racelab-compat-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    root
}

/// A V2 frame with every canonical field populated and every value distinct.
fn v2_frame() -> TelemetryFrame {
    let corner = |base: f32| Wheel {
        temperature_c: Some(base + 0.5),
        slip_ratio: Some(base + 1.25),
        slip_angle: Some(base + 2.125),
        combined_slip: Some(base + 3.0625),
        rotation_rad_s: Some(base + 4.5),
        normalized_suspension_travel: Some(base / 100.0),
        suspension_travel_m: Some(base / 1000.0),
    };
    TelemetryFrame {
        active: true,
        game: Some("fh6".into()),
        vehicle_id: Some("3134".into()),
        game_timestamp_ms: Some(7562),
        engine: Engine {
            rpm: Some(5725.96),
            idle_rpm: Some(800.0),
            max_rpm: Some(8000.0),
            power_w: Some(84_286.8),
            torque_nm: Some(140.551_36),
        },
        acceleration: Some(Vector3 {
            x: -3.066_602,
            y: 0.332_958,
            z: 1.829_03,
        }),
        velocity: Some(Vector3 {
            x: 1.984_652,
            y: -0.083_741,
            z: 31.580_147,
        }),
        angular_velocity: Some(Vector3 {
            x: -0.018_505,
            y: -0.251_277,
            z: -0.002_375,
        }),
        orientation: Some(Vector3 {
            x: 1.844_594,
            y: -0.020_098,
            z: -0.004_943,
        }),
        position: Some(Vector3 {
            x: -1234.5,
            y: 67.125,
            z: 8901.25,
        }),
        speed_mps: Some(31.642_557),
        controls: Controls {
            throttle: Some(0.25),
            brake: Some(0.5),
            clutch: Some(0.75),
            handbrake: Some(1.0),
            steering: Some(-0.875),
        },
        gear: Some(Gear::Forward(4)),
        vehicle: Vehicle {
            class_code: Some(2),
            performance_index: Some(600),
            drivetrain_code: Some(2),
            cylinders: Some(4),
        },
        wheels: Wheels {
            front_left: corner(10.0),
            front_right: corner(20.0),
            rear_left: corner(30.0),
            rear_right: corner(40.0),
        },
        race: Race {
            lap_number: Some(3),
            race_position: Some(7),
            race_time_seconds: Some(421.5),
        },
        source_specific: Some(serde_json::json!({ "fh6": { "gear": 11 } })),
    }
}

fn write_v2_stream(directory: &Path, session_id: &str, frames: &[TelemetryFrame]) {
    let mut writer = FrameStreamWriter::create(
        directory,
        &FrameStreamHeader {
            frame_format_version: FRAME_FORMAT_VERSION,
            telemetry_frame_schema_version: TELEMETRY_FRAME_SCHEMA_VERSION,
            session_id: session_id.into(),
            started_at_unix_ms: 1_800_000_000_000,
        },
    )
    .unwrap();
    for (index, frame) in frames.iter().enumerate() {
        writer
            .write(index as u64 + 1, index as u64 * 16, frame)
            .unwrap();
    }
    writer
        .finish(&FrameStreamEnd {
            frame_count: frames.len() as u64,
            duration_us: 16_000,
            recorder_dropped_frames: 0,
        })
        .unwrap();
}

// ---------------------------------------------------------------- the tests

#[test]
fn this_build_writes_schema_two_and_reads_one_and_two() {
    assert_eq!(TELEMETRY_FRAME_SCHEMA_VERSION, 2);
    assert_eq!(SUPPORTED_TELEMETRY_FRAME_SCHEMA_VERSIONS, &[1, 2]);
    // The container framing did not change, so its version must not move.
    assert_eq!(FRAME_FORMAT_VERSION, 1);
    assert!(session_format::supports_telemetry_frame_schema(1));
    assert!(session_format::supports_telemetry_frame_schema(2));
    assert!(!session_format::supports_telemetry_frame_schema(3));
    assert!(!session_format::supports_telemetry_frame_schema(0));
}

#[test]
fn a_schema_v1_recording_decodes_and_preserves_every_v1_canonical_value() {
    let root = temp_root("v1-read");
    let path = root.join(FRAME_FILE_NAME);
    write_legacy_stream(
        &path,
        "legacy-1",
        vec![legacy_frame(true), legacy_null_frame()],
    );
    let before = fs::read(&path).unwrap();

    let (header, frames) = session_format::read_all_frames(&path).unwrap();
    assert_eq!(header.telemetry_frame_schema_version, 1);
    assert_eq!(header.session_id, "legacy-1");
    assert_eq!(frames.len(), 2);

    let first = &frames[0];
    assert_eq!(first.sequence, 1);
    assert_eq!(first.monotonic_ms, 0);
    let frame = &first.frame;
    assert!(frame.active);
    assert_eq!(frame.game.as_deref(), Some("fh6"));
    assert_eq!(frame.vehicle_id.as_deref(), Some("2599"));
    assert_eq!(frame.game_timestamp_ms, Some(1_234_567_890));
    assert_eq!(frame.engine.rpm, Some(6123.25));
    assert_eq!(frame.engine.idle_rpm, Some(812.5));
    assert_eq!(frame.engine.max_rpm, Some(7300.75));
    assert_eq!(
        frame.acceleration,
        Some(Vector3 {
            x: -1.5,
            y: 0.25,
            z: 9.75
        })
    );
    assert_eq!(
        frame.velocity,
        Some(Vector3 {
            x: 12.5,
            y: -0.125,
            z: 30.0
        })
    );
    assert_eq!(
        frame.angular_velocity,
        Some(Vector3 {
            x: 0.001,
            y: -0.002,
            z: 0.003
        })
    );
    assert_eq!(
        frame.orientation,
        Some(Vector3 {
            x: 1.75,
            y: -0.5,
            z: 0.25
        })
    );
    assert_eq!(
        frame.position,
        Some(Vector3 {
            x: -1234.5,
            y: 67.125,
            z: 8901.25
        })
    );
    assert_eq!(frame.speed_mps, Some(32.5));
    assert_eq!(
        frame.controls,
        Controls {
            throttle: Some(0.25),
            brake: Some(0.5),
            clutch: Some(0.75),
            handbrake: Some(1.0),
            steering: Some(-0.875),
        }
    );
    assert_eq!(frame.gear, Some(Gear::Forward(4)));
    // The adapter envelope survives verbatim.
    assert_eq!(
        frame.source_specific.as_ref().unwrap()["fh6"]["car_ordinal"],
        2599
    );

    // Reading must never rewrite the recording.
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[test]
fn v2_only_fields_are_null_after_reading_a_v1_recording() {
    let root = temp_root("v1-nulls");
    let path = root.join(FRAME_FILE_NAME);
    write_legacy_stream(&path, "legacy-2", vec![legacy_frame(true)]);
    let frame = session_format::read_all_frames(&path).unwrap().1[0]
        .frame
        .clone();

    assert_eq!(frame.vehicle, Vehicle::default());
    assert_eq!(frame.wheels, Wheels::default());
    assert_eq!(frame.race, Race::default());
    assert_eq!(frame.engine.power_w, None);
    assert_eq!(frame.engine.torque_nm, None);
    // The V1 envelope held `power`, `torque`, `lap_number`, `current_race_time`
    // and four tire temperatures. None of them may be mined into a canonical
    // field: the conversion is faithful, not reconstructive.
    assert!(frame.source_specific.as_ref().unwrap()["fh6"]["power"].is_number());
    for corner in [
        frame.wheels.front_left,
        frame.wheels.front_right,
        frame.wheels.rear_left,
        frame.wheels.rear_right,
    ] {
        assert_eq!(corner, Wheel::default());
        assert_eq!(corner.temperature_c, None);
    }
}

#[test]
fn null_v1_canonical_values_stay_null_rather_than_becoming_zero() {
    let root = temp_root("v1-null-frame");
    let path = root.join(FRAME_FILE_NAME);
    write_legacy_stream(&path, "legacy-3", vec![legacy_null_frame()]);
    let frame = session_format::read_all_frames(&path).unwrap().1[0]
        .frame
        .clone();
    assert!(!frame.active);
    assert_eq!(frame.vehicle_id, None);
    assert_eq!(frame.speed_mps, None);
    assert_eq!(frame.engine, Engine::default());
    assert_eq!(frame.acceleration, None);
    assert_eq!(frame.velocity, None);
    assert_eq!(frame.angular_velocity, None);
    assert_eq!(frame.orientation, None);
    assert_eq!(frame.position, None);
    assert_eq!(frame.controls, Controls::default());
    assert_eq!(frame.gear, None);
    assert_eq!(frame.source_specific, None);
    // And no zero appears anywhere a value was unavailable.
    let json = serde_json::to_value(&frame).unwrap();
    assert!(json["speed_mps"].is_null());
    assert!(json["engine"]["rpm"].is_null());
    assert!(json["engine"]["power_w"].is_null());
    assert!(json["wheels"]["front_left"]["temperature_c"].is_null());
    assert!(json["race"]["lap_number"].is_null());
}

#[test]
fn a_v2_frame_round_trips_through_the_frame_stream_exactly() {
    let root = temp_root("v2-roundtrip");
    let original = v2_frame();
    // An inactive frame: every optional canonical value unavailable.
    let null_frame = TelemetryFrame {
        game: Some("fh6".into()),
        game_timestamp_ms: Some(7578),
        ..TelemetryFrame::default()
    };
    write_v2_stream(&root, "v2-1", &[original.clone(), null_frame.clone()]);

    let (header, frames) = session_format::read_all_frames(&root.join(FRAME_FILE_NAME)).unwrap();
    assert_eq!(header.telemetry_frame_schema_version, 2);
    assert_eq!(frames.len(), 2);
    assert_eq!(
        frames[0],
        RecordedFrame {
            sequence: 1,
            monotonic_ms: 0,
            frame: original.clone(),
        }
    );
    // Null V2 fields stay null across the round trip.
    assert_eq!(frames[1].frame, null_frame);
    assert_eq!(frames[1].frame.wheels, Wheels::default());
    assert_eq!(frames[1].frame.race, Race::default());
}

#[test]
fn v2_wheel_values_round_trip_corner_by_corner() {
    let root = temp_root("v2-wheels");
    let original = v2_frame();
    write_v2_stream(&root, "v2-2", std::slice::from_ref(&original));
    let wheels = session_format::read_all_frames(&root.join(FRAME_FILE_NAME))
        .unwrap()
        .1[0]
        .frame
        .wheels;
    assert_eq!(wheels, original.wheels);
    // Named explicitly, so a transposition inside the round trip is caught by
    // a mismatched number rather than by a whole-struct comparison alone.
    assert_eq!(wheels.front_left.temperature_c, Some(10.5));
    assert_eq!(wheels.front_right.temperature_c, Some(20.5));
    assert_eq!(wheels.rear_left.temperature_c, Some(30.5));
    assert_eq!(wheels.rear_right.temperature_c, Some(40.5));
    assert_eq!(wheels.front_left.slip_ratio, Some(11.25));
    assert_eq!(wheels.rear_right.slip_ratio, Some(41.25));
    assert_eq!(wheels.front_left.normalized_suspension_travel, Some(0.1));
    assert_eq!(wheels.rear_right.suspension_travel_m, Some(0.04));
}

#[test]
fn v2_engine_and_race_values_round_trip() {
    let root = temp_root("v2-engine-race");
    let original = v2_frame();
    write_v2_stream(&root, "v2-3", std::slice::from_ref(&original));
    let frame = session_format::read_all_frames(&root.join(FRAME_FILE_NAME))
        .unwrap()
        .1[0]
        .frame
        .clone();
    assert_eq!(frame.engine, original.engine);
    assert_eq!(frame.engine.power_w, Some(84_286.8));
    assert_eq!(frame.engine.torque_nm, Some(140.551_36));
    assert_eq!(frame.race, original.race);
    assert_eq!(frame.race.lap_number, Some(3));
    assert_eq!(frame.race.race_position, Some(7));
    assert_eq!(frame.race.race_time_seconds, Some(421.5));
    assert_eq!(frame.vehicle, original.vehicle);
    assert_eq!(frame.vehicle.performance_index, Some(600));
}

#[test]
fn a_v1_manifest_and_a_v2_manifest_are_both_listed_and_readable() {
    let root = temp_root("manifests");
    for (id, schema) in [("legacy-session", 1_u32), ("current-session", 2)] {
        let directory = root.join(id);
        fs::create_dir_all(&directory).unwrap();
        session_format::write_manifest_atomically(&directory, &legacy_manifest(id, schema))
            .unwrap();
    }
    let recent = session_store::list_recent_sessions(&root, None);
    assert_eq!(recent.unreadable, 0);
    assert_eq!(recent.sessions.len(), 2);
    let mut versions: Vec<u32> = recent
        .sessions
        .iter()
        .map(|manifest| manifest.telemetry_frame_schema_version)
        .collect();
    versions.sort();
    assert_eq!(versions, [1, 2]);
    // Session Details works for both, and neither manifest is modified.
    for (id, schema) in [("legacy-session", 1_u32), ("current-session", 2)] {
        let manifest = session_store::get_session(&root, id).unwrap();
        assert_eq!(manifest.telemetry_frame_schema_version, schema);
        assert_eq!(manifest.status, SessionStatus::Completed);
        assert_eq!(manifest.frame_count, 2);
        assert_eq!(manifest.vehicle_id.as_deref(), Some("2599"));
        // The manifest's own JSON shape did not change, so its schema stays 1.
        assert_eq!(manifest.schema_version, 1);
    }
}

#[test]
fn an_unsupported_telemetry_schema_version_fails_clearly_and_is_never_guessed() {
    let root = temp_root("unsupported");

    // In a manifest: the session is skipped rather than listed with fields
    // this build cannot interpret.
    let directory = root.join("future-session");
    fs::create_dir_all(&directory).unwrap();
    session_format::write_manifest_atomically(&directory, &legacy_manifest("future-session", 3))
        .unwrap();
    let error = session_store::get_session(&root, "future-session").unwrap_err();
    assert!(
        error.contains("Unsupported telemetry frame schema version 3"),
        "{error}"
    );
    assert_eq!(
        session_store::list_recent_sessions(&root, None).unreadable,
        1
    );

    // In a frame stream header: rejected before any record is decoded.
    let path = directory.join("future.rlframes");
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"RLFRM\r\n\0");
    bytes.extend_from_slice(&FRAME_FORMAT_VERSION.to_le_bytes());
    bytes.extend_from_slice(&3_u32.to_le_bytes());
    bytes.extend_from_slice(&5_u32.to_le_bytes());
    bytes.extend_from_slice(&0_u64.to_le_bytes());
    bytes.extend_from_slice(b"abcde");
    fs::File::create(&path).unwrap().write_all(&bytes).unwrap();
    let error = session_format::read_all_frames(&path).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("Unsupported telemetry frame schema version 3"),
        "{error}"
    );
}

#[test]
fn an_unsupported_container_framing_version_still_fails() {
    // The framing is independent of the canonical schema; widening one must not
    // have widened the other.
    let root = temp_root("framing");
    let path = root.join("bad-framing.rlframes");
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"RLFRM\r\n\0");
    bytes.extend_from_slice(&2_u32.to_le_bytes());
    bytes.extend_from_slice(&TELEMETRY_FRAME_SCHEMA_VERSION.to_le_bytes());
    bytes.extend_from_slice(&5_u32.to_le_bytes());
    bytes.extend_from_slice(&0_u64.to_le_bytes());
    bytes.extend_from_slice(b"abcde");
    fs::File::create(&path).unwrap().write_all(&bytes).unwrap();
    let error = session_format::read_all_frames(&path).unwrap_err();
    assert!(error
        .to_string()
        .contains("Unsupported frame stream version 2"));
}

#[test]
fn an_old_recording_directory_keeps_working_end_to_end() {
    // A complete V0.6/V0.7 session on disk: manifest plus schema-v1 frames.
    let root = temp_root("old-session");
    let directory = root.join("legacy-session");
    fs::create_dir_all(&directory).unwrap();
    write_legacy_stream(
        &directory.join(FRAME_FILE_NAME),
        "legacy-session",
        vec![legacy_frame(true), legacy_null_frame()],
    );
    session_format::write_manifest_atomically(&directory, &legacy_manifest("legacy-session", 1))
        .unwrap();
    let frames_before = fs::read(directory.join(FRAME_FILE_NAME)).unwrap();
    let manifest_before = fs::read(directory.join("manifest.json")).unwrap();

    // Listing and details are manifest-only and must still work.
    let recent = session_store::list_recent_sessions(&root, None);
    assert_eq!(recent.sessions.len(), 1);
    assert_eq!(recent.unreadable, 0);
    let manifest = session_store::get_session(&root, "legacy-session").unwrap();
    assert_eq!(manifest.frame_count, 2);

    // The frames still decode into the current canonical model.
    let (header, frames) =
        session_format::read_all_frames(&directory.join(FRAME_FILE_NAME)).unwrap();
    assert_eq!(header.telemetry_frame_schema_version, 1);
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[0].frame.speed_mps, Some(32.5));

    // Nothing on disk was rewritten or migrated.
    assert_eq!(
        fs::read(directory.join(FRAME_FILE_NAME)).unwrap(),
        frames_before
    );
    assert_eq!(
        fs::read(directory.join("manifest.json")).unwrap(),
        manifest_before
    );
}
