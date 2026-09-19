use racelab_lib::{
    adapters::fh6::{self, TimestampEvent, TimestampValidator},
    capture_format::{self, CaptureEnd, CaptureHeader, CaptureReader, RawPacket},
    fh6_validation::validate_capture,
    live_telemetry::LiveTelemetrySink,
    packet::{CapturedPacket, PacketSink},
    telemetry::TelemetryFrame,
};
use std::{
    collections::BTreeSet,
    fs::File,
    io::{BufReader, Cursor},
    path::PathBuf,
    sync::{Arc, Mutex},
};

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fh6")
}
fn close(actual: f32, expected: f64) {
    assert!(
        (f64::from(actual) - expected).abs() <= 1e-5_f64.max(expected.abs() * 1e-7),
        "{actual} != {expected}"
    );
}
fn active_packet() -> Vec<u8> {
    let mut reader = CaptureReader::new(BufReader::new(
        File::open(fixture_dir().join("sample-01.rlcap")).unwrap(),
    ))
    .unwrap();
    while let Some(p) = reader.next_packet().unwrap() {
        if p.bytes[0] == 1 {
            return p.bytes;
        }
    }
    panic!("Fixture has no active packet")
}
fn put_f(p: &mut [u8], o: usize, v: f32) {
    p[o..o + 4].copy_from_slice(&v.to_le_bytes());
}

#[test]
fn real_minimal_fixtures_match_independent_golden_values_and_validate_physics() {
    let manifest: serde_json::Value =
        serde_json::from_reader(File::open(fixture_dir().join("manifest.json")).unwrap()).unwrap();
    let mut total = 0;
    for fixture in manifest["fixtures"].as_array().unwrap() {
        let path = fixture_dir().join(fixture["file"].as_str().unwrap());
        let report =
            validate_capture(BufReader::new(File::open(&path).unwrap()), &BTreeSet::new()).unwrap();
        assert!(report.valid, "{report:?}");
        assert_eq!(report.active_packets, 2);
        assert_eq!(report.inactive_packets, 1);
        assert!(report.speed_error_max_mps < 0.00002);
        let mut reader = CaptureReader::new(BufReader::new(File::open(path).unwrap())).unwrap();
        for expected in fixture["packets"].as_array().unwrap() {
            let packet = reader.next_packet().unwrap().unwrap();
            total += 1;
            assert_eq!(packet.source, "127.0.0.1:0".parse().unwrap());
            assert_eq!(packet.received_at_ms, 0);
            assert!(packet.bytes[68..256].iter().all(|b| *b == 0));
            assert!(packet.bytes[292..315].iter().all(|b| *b == 0));
            assert!(packet.bytes[321..324].iter().all(|b| *b == 0));
            let decoded = fh6::decode(&packet.bytes).unwrap();
            let f = &decoded.frame;
            let raw = &decoded.fh6;
            assert_eq!(f.active, expected["active"].as_bool().unwrap());
            assert_eq!(
                f.game_timestamp_ms.unwrap(),
                expected["timestamp_ms"].as_u64().unwrap()
            );
            assert_eq!(raw.throttle, expected["throttle"].as_u64().unwrap() as u8);
            assert_eq!(raw.brake, expected["brake"].as_u64().unwrap() as u8);
            assert_eq!(raw.clutch, expected["clutch"].as_u64().unwrap() as u8);
            assert_eq!(raw.handbrake, expected["handbrake"].as_u64().unwrap() as u8);
            assert_eq!(raw.gear, expected["gear"].as_u64().unwrap() as u8);
            assert_eq!(raw.steering, expected["steering"].as_i64().unwrap() as i8);
            let mut fields = vec![
                (260, raw.power),
                (264, raw.torque),
                (268, raw.tire_temperatures[0]),
                (272, raw.tire_temperatures[1]),
                (276, raw.tire_temperatures[2]),
                (280, raw.tire_temperatures[3]),
                (284, raw.boost),
                (288, raw.fuel),
                (292, raw.distance_traveled),
                (296, raw.best_lap),
                (300, raw.last_lap),
                (304, raw.current_lap),
                (308, raw.current_race_time),
            ];
            if f.active {
                fields.extend([
                    (8, f.engine.max_rpm.unwrap()),
                    (12, f.engine.idle_rpm.unwrap()),
                    (16, f.engine.rpm.unwrap()),
                    (20, f.acceleration.unwrap().x),
                    (24, f.acceleration.unwrap().y),
                    (28, f.acceleration.unwrap().z),
                    (32, f.velocity.unwrap().x),
                    (36, f.velocity.unwrap().y),
                    (40, f.velocity.unwrap().z),
                    (44, f.angular_velocity.unwrap().x),
                    (48, f.angular_velocity.unwrap().y),
                    (52, f.angular_velocity.unwrap().z),
                    (56, f.orientation.unwrap().x),
                    (60, f.orientation.unwrap().y),
                    (64, f.orientation.unwrap().z),
                    (244, f.position.unwrap().x),
                    (248, f.position.unwrap().y),
                    (252, f.position.unwrap().z),
                    (256, f.speed_mps.unwrap()),
                ]);
                close(
                    f.controls.throttle.unwrap(),
                    f64::from(raw.throttle) / 255.0,
                );
                close(f.controls.brake.unwrap(), f64::from(raw.brake) / 255.0);
                close(f.controls.clutch.unwrap(), f64::from(raw.clutch) / 255.0);
                close(
                    f.controls.handbrake.unwrap(),
                    f64::from(raw.handbrake) / 255.0,
                );
                close(
                    f.controls.steering.unwrap(),
                    f64::from(raw.steering) / 127.0,
                );
                assert_eq!(f.gear, None);
                assert_eq!(f.source_specific.as_ref().unwrap()["fh6"]["gear"], raw.gear);
            } else {
                assert_eq!(
                    *f,
                    TelemetryFrame {
                        game_timestamp_ms: f.game_timestamp_ms,
                        game: f.game.clone(),
                        vehicle_id: f.vehicle_id.clone(),
                        source_specific: f.source_specific.clone(),
                        ..Default::default()
                    }
                );
            }
            for (offset, value) in fields {
                close(value, expected["f32"][offset.to_string()].as_f64().unwrap());
            }
        }
        assert!(reader.next_packet().unwrap().is_none());
    }
    assert_eq!(total, 18);
}

#[test]
fn unsupported_sizes_and_nonfinite_fields_are_rejected_without_panics() {
    for len in [0, 1, 64, 232, 311, 323, 325, 65_535] {
        assert!(fh6::decode(&vec![0; len])
            .unwrap_err()
            .iter()
            .any(|i| i.field == "packet_size"));
    }
    for &(_, offset) in fh6::FLOAT_FIELDS {
        for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let mut p = active_packet();
            put_f(&mut p, offset, value);
            let errors = fh6::decode(&p).unwrap_err();
            assert!(errors.iter().any(|i| i.offset == offset));
            assert!(serde_json::to_string(&errors).is_ok());
        }
    }
}

#[test]
fn all_requested_offsets_signedness_and_opaque_regions_are_preserved() {
    let mut p = vec![0; 324];
    p[0..4].copy_from_slice(&1_i32.to_le_bytes());
    p[4..8].copy_from_slice(&0xFEDCBA98_u32.to_le_bytes());
    for &(name, offset) in fh6::FLOAT_FIELDS {
        let _ = name;
        put_f(&mut p, offset, offset as f32 + 0.25);
    }
    for (offset, value) in [(212, -100_i32), (216, -2), (220, 999), (224, 2), (228, 12)] {
        p[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    for (i, b) in p[68..212].iter_mut().enumerate() {
        *b = i as u8;
    }
    p[232..244].copy_from_slice(&[0, 255, 128, 127, 1, 2, 3, 4, 5, 6, 7, 8]);
    p[321..324].copy_from_slice(&[9, 255, 128]);
    p[312..314].copy_from_slice(&513_u16.to_le_bytes());
    p[314..321].copy_from_slice(&[201, 255, 128, 64, 32, 11, 129]);
    let d = fh6::decode(&p).unwrap();
    let r = &d.fh6;
    assert_eq!(r.timestamp_ms, 0xFEDCBA98);
    assert_eq!(r.car_ordinal, -100);
    assert_eq!(r.car_class, -2);
    assert_eq!(r.car_performance_index, 999);
    assert_eq!(r.drivetrain_type, 2);
    assert_eq!(r.num_cylinders, 12);
    assert_eq!(&r.unimplemented_68_211, p.get(68..212).unwrap());
    assert_eq!(r.horizon_unknown_232_243, &p[232..244]);
    assert_eq!(r.unknown_321_323, [9, 255, 128]);
    assert_eq!(r.lap_number, 513);
    assert_eq!(r.race_position, 201);
    assert_eq!(
        (
            r.throttle,
            r.brake,
            r.clutch,
            r.handbrake,
            r.gear,
            r.steering
        ),
        (255, 128, 64, 32, 11, -127)
    );
    assert_eq!(d.frame.position.unwrap().x, 244.25);
    assert_eq!(d.frame.position.unwrap().y, 248.25);
    assert_eq!(d.frame.position.unwrap().z, 252.25);
    assert_eq!(d.frame.speed_mps.unwrap(), 256.25);
    assert_eq!((r.power, r.torque), (260.25, 264.25));
    assert_eq!(r.tire_temperatures, [268.25, 272.25, 276.25, 280.25]);
    assert_eq!(
        (
            r.boost,
            r.fuel,
            r.distance_traveled,
            r.best_lap,
            r.last_lap,
            r.current_lap,
            r.current_race_time
        ),
        (284.25, 288.25, 292.25, 296.25, 300.25, 304.25, 308.25)
    );
}

#[test]
fn inactive_packets_have_null_canonical_values_but_keep_raw_extension_and_report_nonfinite() {
    let mut p = active_packet();
    p[0..4].fill(0);
    p[315] = 255;
    p[319] = 11;
    put_f(&mut p, 16, -100.0);
    let d = fh6::decode(&p).unwrap();
    assert_eq!(
        d.frame,
        TelemetryFrame {
            game_timestamp_ms: d.frame.game_timestamp_ms,
            game: d.frame.game.clone(),
            vehicle_id: d.frame.vehicle_id.clone(),
            source_specific: d.frame.source_specific.clone(),
            ..Default::default()
        }
    );
    assert_eq!(d.fh6.throttle, 255);
    assert!(fh6::physical_issues(&d.frame).is_empty());
    put_f(&mut p, 16, f32::NAN);
    assert!(fh6::decode(&p).is_err());
}

#[test]
fn controls_and_rpm_and_speed_policy_report_invalid_values_without_clamping() {
    let mut p = active_packet();
    for throttle in [0, 1, 254, 255] {
        p[315] = throttle;
        p[316] = 255 - throttle;
        let d = fh6::decode(&p).unwrap();
        close(
            d.frame.controls.throttle.unwrap(),
            f64::from(throttle) / 255.0,
        );
        close(
            d.frame.controls.brake.unwrap(),
            f64::from(255 - throttle) / 255.0,
        );
    }
    for steering in [-127_i8, 0, 127] {
        p[320] = steering as u8;
        assert_eq!(
            fh6::decode(&p).unwrap().frame.controls.steering.unwrap(),
            f32::from(steering) / 127.0
        );
    }
    p[320] = 128;
    assert!(fh6::decode(&p).unwrap_err().iter().any(|i| i.offset == 320));
    for (offset, value) in [
        (8, 0.0),
        (8, 30_001.0),
        (12, -1.0),
        (12, 40_000.0),
        (16, -1.0),
        (16, 40_000.0),
        (256, -1.0),
        (256, 500.0),
    ] {
        let mut p = active_packet();
        put_f(&mut p, offset, value);
        assert!(
            fh6::physical_issues(&fh6::decode(&p).unwrap().frame)
                .iter()
                .any(|i| i.offset == offset),
            "offset {offset}"
        );
    }
    let mut p = active_packet();
    p[0..4].copy_from_slice(&(-1_i32).to_le_bytes());
    assert!(fh6::decode(&p).is_err());
}

#[test]
fn timestamps_allow_duplicates_explicit_boundaries_and_wrap_but_not_arbitrary_resets() {
    let mut clock = TimestampValidator::default();
    assert_eq!(clock.observe(100, true, false), TimestampEvent::Initial);
    assert_eq!(clock.observe(100, true, false), TimestampEvent::Ordered);
    assert_eq!(clock.observe(90, true, false), TimestampEvent::Regression);
    assert_eq!(clock.observe(95, true, false), TimestampEvent::Regression);
    assert_eq!(
        clock.observe(0, false, false),
        TimestampEvent::InactiveReset
    );
    assert_eq!(clock.observe(10, false, false), TimestampEvent::Ordered);
    assert_eq!(clock.observe(5, false, false), TimestampEvent::Regression);
    assert_eq!(clock.observe(0, true, false), TimestampEvent::InactiveReset);
    assert_eq!(clock.observe(100, true, false), TimestampEvent::Ordered);
    assert_eq!(clock.observe(1, true, true), TimestampEvent::ExplicitReset);
    clock.observe(u32::MAX - 10, true, false);
    assert_eq!(clock.observe(5, true, false), TimestampEvent::Wrap);
}

fn capture(packets: Vec<Vec<u8>>, drops: u64) -> Vec<u8> {
    let mut bytes = Vec::new();
    capture_format::write_header(
        &mut bytes,
        &CaptureHeader {
            label: "test".into(),
            started_at_ms: 0,
        },
    )
    .unwrap();
    let count = packets.len() as u64;
    for (i, p) in packets.into_iter().enumerate() {
        capture_format::write_packet(
            &mut bytes,
            &RawPacket {
                capture_at_us: i as u64,
                listener_at_us: i as u64,
                received_at_ms: 0,
                source: "127.0.0.1:0".parse().unwrap(),
                bytes: p,
            },
        )
        .unwrap();
    }
    capture_format::write_end(
        &mut bytes,
        &CaptureEnd {
            duration_us: count,
            captured_packets: count,
            dropped_capture_frames: drops,
        },
    )
    .unwrap();
    bytes
}

#[test]
fn offline_validation_reports_failures_reset_overrides_loss_and_truncation() {
    let mut first = active_packet();
    first[4..8].copy_from_slice(&100_u32.to_le_bytes());
    let mut second = first.clone();
    second[4..8].copy_from_slice(&10_u32.to_le_bytes());
    let bytes = capture(vec![first, second], 0);
    let report = validate_capture(Cursor::new(&bytes), &BTreeSet::new()).unwrap();
    assert!(!report.valid);
    assert_eq!(report.timestamp_regressions, 1);
    let report = validate_capture(Cursor::new(&bytes), &BTreeSet::from([2])).unwrap();
    assert!(report.valid);
    assert_eq!(report.explicit_resets, 1);
    assert!(validate_capture(Cursor::new(&bytes), &BTreeSet::from([3])).is_err());
    assert!(validate_capture(Cursor::new(&bytes[..bytes.len() - 1]), &BTreeSet::new()).is_err());
    let report = validate_capture(
        Cursor::new(capture(vec![active_packet()], 1)),
        &BTreeSet::new(),
    )
    .unwrap();
    assert!(!report.valid);
    assert_eq!(report.dropped_capture_frames, 1);
    let report = validate_capture(
        Cursor::new(capture(vec![vec![0; 323]; 110], 0)),
        &BTreeSet::new(),
    )
    .unwrap();
    assert_eq!(report.decode_failures, 110);
    assert_eq!(report.issue_samples.len(), 100);
    assert_eq!(report.omitted_issue_packets, 10);
}

#[derive(Default)]
struct RawCollector(Mutex<Vec<Vec<u8>>>);
impl PacketSink for RawCollector {
    fn on_packet(&self, p: &CapturedPacket<'_>) {
        self.0.lock().unwrap().push(p.bytes.to_vec());
    }
}
#[test]
fn sink_keeps_raw_capture_independent_and_does_not_reuse_invalid_or_inactive_live_values() {
    let capture = Arc::new(RawCollector::default());
    let live = LiveTelemetrySink::new(capture.clone());
    live.begin_start_at(0);
    let p = active_packet();
    let send = |bytes: &[u8], source, now| {
        live.on_packet_at(
            &CapturedPacket {
                bytes,
                source,
                received_at_ms: 0,
                captured_at_us: 0,
            },
            now,
        )
    };
    let source = "127.0.0.1:5200".parse().unwrap();
    let active_frames: Vec<_> = (0_u32..5)
        .map(|n| {
            let mut bytes = p.clone();
            bytes[4..8].copy_from_slice(&(n * 16).to_le_bytes());
            bytes
        })
        .collect();
    for (n, bytes) in active_frames.iter().enumerate() {
        send(bytes, source, n as u64 * 16);
    }
    let first = live.snapshot_at(64);
    assert!(first.frame.unwrap().active);
    send(&[0; 323], source, 80);
    let invalid = live.snapshot_at(80);
    assert!(invalid.frame.is_none());
    assert_eq!(invalid.invalid_packets, 1);
    let mut inactive = p.clone();
    inactive[0..4].fill(0);
    inactive[4..8].copy_from_slice(&96_u32.to_le_bytes());
    send(&inactive, source, 96);
    assert_eq!(live.snapshot_at(96).frame.as_ref().unwrap().speed_mps, None);
    send(&p, "127.0.0.1:5201".parse().unwrap(), 112);
    let foreign = live.snapshot_at(112);
    assert!(!foreign.frame.unwrap().active);
    assert_eq!(foreign.unknown_protocol, 1);
    assert_eq!(foreign.invalid_fh6, 1);
    let mut expected = active_frames;
    expected.extend([vec![0; 323], inactive, p]);
    assert_eq!(*capture.0.lock().unwrap(), expected);
    live.stop_at(113);
    let reset = live.snapshot_at(113);
    assert!(reset.revision > invalid.revision);
    assert!(reset.frame.is_none());
    assert!(reset.stale);
}
