use racelab_lib::{
    adapters::fh6::{self, TimestampEvent, TimestampValidator},
    capture_format::{self, CaptureEnd, CaptureHeader, CaptureReader, RawPacket},
    fh6_validation::validate_capture,
    live_telemetry::LiveTelemetrySink,
    packet::{CapturedPacket, PacketSink},
    telemetry::TelemetryFrame,
    telemetry::{Wheel, WheelPosition},
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
                // Real-capture tire temperatures: the canonical corner value
                // is exactly the Fahrenheit wire reading converted once, and
                // the result lands in a plausible tire operating band. The
                // fixtures zero bytes 68..255, so the other per-wheel channels
                // are covered by the synthetic offset tests instead.
                for (index, position) in fh6::WHEEL_ORDER.into_iter().enumerate() {
                    let celsius = f.wheels.get(position).temperature_c.unwrap();
                    close(
                        celsius,
                        f64::from(fh6::tire_temperature_celsius(raw.tire_temperatures[index])),
                    );
                    assert!(
                        (0.0..250.0).contains(&celsius),
                        "implausible tire temperature {celsius} C"
                    );
                }
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
    assert_eq!(&r.wheel_block_68_211, p.get(68..212).unwrap());
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

// ------------------------------------------------------------ V0.8 wheels

/// Source wheel-block index -> canonical corner. Every per-wheel block in the
/// packet is four consecutive f32; this fixes which one is which corner.
const SOURCE_INDEX_TO_CORNER: [(usize, WheelPosition); 4] = [
    (0, WheelPosition::FrontLeft),
    (1, WheelPosition::FrontRight),
    (2, WheelPosition::RearLeft),
    (3, WheelPosition::RearRight),
];

/// A packet whose every decoded f32 slot holds `offset as f32 + 0.25`, so each
/// canonical value can only be right if it was read from exactly one offset.
fn offset_sentinel_packet() -> Vec<u8> {
    let mut p = vec![0; 324];
    p[0..4].copy_from_slice(&1_i32.to_le_bytes());
    for &(_, offset) in fh6::FLOAT_FIELDS {
        put_f(&mut p, offset, offset as f32 + 0.25);
    }
    // A vehicle must be present for the configuration codes to be reported.
    p[212..216].copy_from_slice(&2599_i32.to_le_bytes());
    p
}

#[test]
fn wheel_order_maps_each_source_index_to_exactly_one_corner() {
    // The adapter's declared mapping is the only mapping, and it is this one.
    assert_eq!(
        fh6::WHEEL_ORDER,
        [
            WheelPosition::FrontLeft,
            WheelPosition::FrontRight,
            WheelPosition::RearLeft,
            WheelPosition::RearRight
        ]
    );
    for (index, corner) in SOURCE_INDEX_TO_CORNER {
        assert_eq!(fh6::WHEEL_ORDER[index], corner);
    }
    // Four distinct corners: no index may share a corner with another.
    let mut seen = fh6::WHEEL_ORDER.to_vec();
    seen.sort_by_key(|position| format!("{position:?}"));
    seen.dedup();
    assert_eq!(seen.len(), 4);
}

#[test]
fn every_promoted_wheel_channel_is_read_from_its_own_offset_for_its_own_corner() {
    let decoded = fh6::decode(&offset_sentinel_packet()).unwrap();
    // Distinct values in all four positions of every block, so a transposed
    // corner or a transposed channel changes the number under test.
    for (index, corner) in SOURCE_INDEX_TO_CORNER {
        let wheel: &Wheel = decoded.frame.wheels.get(corner);
        let expect = |base: usize| f64::from(base as u32 + 4 * index as u32) + 0.25;
        close(
            wheel.normalized_suspension_travel.unwrap(),
            expect(fh6::NORMALIZED_SUSPENSION_TRAVEL_BASE),
        );
        close(wheel.slip_ratio.unwrap(), expect(fh6::SLIP_RATIO_BASE));
        close(
            wheel.rotation_rad_s.unwrap(),
            expect(fh6::WHEEL_ROTATION_BASE),
        );
        close(wheel.slip_angle.unwrap(), expect(fh6::SLIP_ANGLE_BASE));
        close(
            wheel.combined_slip.unwrap(),
            expect(fh6::COMBINED_SLIP_BASE),
        );
        close(
            wheel.suspension_travel_m.unwrap(),
            expect(fh6::SUSPENSION_TRAVEL_METRES_BASE),
        );
        close(
            wheel.temperature_c.unwrap(),
            (expect(fh6::TIRE_TEMPERATURE_BASE) - 32.0) * 5.0 / 9.0,
        );
    }
    // Spelled out once more as literal offsets, so a change to a base constant
    // cannot quietly move a channel and still pass the loop above.
    let front_left = decoded.frame.wheels.front_left;
    close(front_left.normalized_suspension_travel.unwrap(), 68.25);
    close(front_left.slip_ratio.unwrap(), 84.25);
    close(front_left.rotation_rad_s.unwrap(), 100.25);
    close(front_left.slip_angle.unwrap(), 164.25);
    close(front_left.combined_slip.unwrap(), 180.25);
    close(front_left.suspension_travel_m.unwrap(), 196.25);
    let rear_right = decoded.frame.wheels.rear_right;
    close(rear_right.normalized_suspension_travel.unwrap(), 80.25);
    close(rear_right.slip_ratio.unwrap(), 96.25);
    close(rear_right.rotation_rad_s.unwrap(), 112.25);
    close(rear_right.slip_angle.unwrap(), 176.25);
    close(rear_right.combined_slip.unwrap(), 192.25);
    close(rear_right.suspension_travel_m.unwrap(), 208.25);
}

#[test]
fn tire_temperature_is_converted_from_fahrenheit_once_in_the_adapter() {
    // Exact reference points first: the conversion itself, not a field read.
    assert_eq!(fh6::tire_temperature_celsius(32.0), 0.0);
    assert_eq!(fh6::tire_temperature_celsius(212.0), 100.0);
    assert_eq!(fh6::tire_temperature_celsius(-40.0), -40.0);
    close(fh6::tire_temperature_celsius(98.6), 37.0);

    let mut p = offset_sentinel_packet();
    // Four clearly distinct Fahrenheit readings, one per corner.
    for (index, fahrenheit) in [32.0_f32, 212.0, 100.4, -40.0].into_iter().enumerate() {
        put_f(&mut p, fh6::TIRE_TEMPERATURE_BASE + 4 * index, fahrenheit);
    }
    let wheels = fh6::decode(&p).unwrap().frame.wheels;
    close(wheels.front_left.temperature_c.unwrap(), 0.0);
    close(wheels.front_right.temperature_c.unwrap(), 100.0);
    close(wheels.rear_left.temperature_c.unwrap(), 38.0);
    close(wheels.rear_right.temperature_c.unwrap(), -40.0);
    // The wire value stays Fahrenheit in the adapter envelope and in Fh6Raw,
    // so Diagnostics reports what was received rather than a conversion.
    let decoded = fh6::decode(&p).unwrap();
    assert_eq!(decoded.fh6.tire_temperatures, [32.0, 212.0, 100.4, -40.0]);
    assert_eq!(
        decoded.frame.source_specific.as_ref().unwrap()["fh6"]["tire_temperatures"][1],
        212.0
    );
}

#[test]
fn promoted_engine_vehicle_and_race_fields_read_their_own_offsets_and_types() {
    let mut p = offset_sentinel_packet();
    // Distinct vehicle codes, each a different value and a different width of
    // meaning, so a swapped pair is visible.
    for (offset, value) in [(216, -2_i32), (220, 842), (224, 1), (228, 12)] {
        p[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    // Distinct race values. Lap number is u16 little endian, race position u8.
    p[312..314].copy_from_slice(&513_u16.to_le_bytes());
    p[314] = 201;
    put_f(&mut p, 308, 421.5);
    let frame = fh6::decode(&p).unwrap().frame;

    close(frame.engine.power_w.unwrap(), 260.25);
    close(frame.engine.torque_nm.unwrap(), 264.25);
    assert_eq!(frame.vehicle.class_code, Some(-2));
    assert_eq!(frame.vehicle.performance_index, Some(842));
    assert_eq!(frame.vehicle.drivetrain_code, Some(1));
    assert_eq!(frame.vehicle.cylinders, Some(12));
    assert_eq!(frame.vehicle_id.as_deref(), Some("2599"));
    assert_eq!(frame.race.lap_number, Some(513));
    assert_eq!(frame.race.race_position, Some(201));
    close(frame.race.race_time_seconds.unwrap(), 421.5);

    // Endianness: the same bytes in the other order must not decode the same.
    let mut swapped = p.clone();
    swapped[312..314].copy_from_slice(&[2, 1]);
    assert_eq!(
        fh6::decode(&swapped).unwrap().frame.race.lap_number,
        Some(258)
    );
}

#[test]
fn deferred_fields_never_become_canonical_values() {
    let mut p = offset_sentinel_packet();
    put_f(&mut p, 284, 24.99); // boost
    put_f(&mut p, 288, 1.0); // fuel
    put_f(&mut p, 292, 1234.5); // distance travelled
    put_f(&mut p, 296, 61.5); // best lap
    put_f(&mut p, 300, 62.5); // last lap
    put_f(&mut p, 304, 63.5); // current lap
    let decoded = fh6::decode(&p).unwrap();
    // They are preserved for Diagnostics...
    assert_eq!(decoded.fh6.boost, 24.99);
    assert_eq!(decoded.fh6.fuel, 1.0);
    assert_eq!(decoded.fh6.distance_traveled, 1234.5);
    assert_eq!(decoded.fh6.best_lap, 61.5);
    // ...and the canonical frame carries no field that could hold them. The
    // canonical race group has exactly three fields and none is a lap time.
    let canonical = serde_json::to_value(&decoded.frame).unwrap();
    let race = canonical["race"].as_object().unwrap();
    let mut keys: Vec<&String> = race.keys().collect();
    keys.sort();
    assert_eq!(keys, ["lap_number", "race_position", "race_time_seconds"]);
    let engine = canonical["engine"].as_object().unwrap();
    assert!(!engine.contains_key("boost"));
    assert!(!engine.contains_key("fuel"));
    // Bytes 116..=163 stay undecoded: they are in no FLOAT_FIELDS entry.
    for offset in fh6::UNDECODED_WHEEL_BYTES.step_by(4) {
        assert!(
            !fh6::FLOAT_FIELDS.iter().any(|&(_, o)| o == offset),
            "offset {offset} must stay undecoded"
        );
    }
    // But the raw bytes are still preserved in full.
    assert_eq!(decoded.fh6.wheel_block_68_211.len(), 144);
}

#[test]
fn inactive_packets_leave_every_v2_group_unavailable() {
    let mut p = offset_sentinel_packet();
    p[0..4].fill(0);
    let frame = fh6::decode(&p).unwrap().frame;
    assert_eq!(frame.wheels, Default::default());
    assert_eq!(frame.race, Default::default());
    assert_eq!(frame.engine.power_w, None);
    assert_eq!(frame.engine.torque_nm, None);
    // A menu packet carries no vehicle, so its configuration codes are
    // unavailable rather than a class 0 car with 0 cylinders.
    p[212..216].fill(0);
    let frame = fh6::decode(&p).unwrap().frame;
    assert_eq!(frame.vehicle, Default::default());
    assert_eq!(frame.vehicle_id, None);
}

#[test]
fn non_finite_values_in_the_wheel_block_are_rejected_with_their_offset() {
    for base in [
        fh6::NORMALIZED_SUSPENSION_TRAVEL_BASE,
        fh6::SLIP_RATIO_BASE,
        fh6::WHEEL_ROTATION_BASE,
        fh6::SLIP_ANGLE_BASE,
        fh6::COMBINED_SLIP_BASE,
        fh6::SUSPENSION_TRAVEL_METRES_BASE,
        fh6::TIRE_TEMPERATURE_BASE,
    ] {
        for index in 0..4 {
            let offset = base + 4 * index;
            let mut p = offset_sentinel_packet();
            put_f(&mut p, offset, f32::NAN);
            let errors = fh6::decode(&p).unwrap_err();
            assert!(
                errors.iter().any(|issue| issue.offset == offset),
                "offset {offset} was not reported"
            );
        }
    }
}

#[test]
fn promoted_field_semantics_are_reported_rather_than_clamped() {
    let normalized = fh6::NORMALIZED_SUSPENSION_TRAVEL_BASE;
    for (offset, value) in [
        (normalized, -0.000_1_f32),
        (normalized + 4, 1.000_1),
        (normalized + 8, 2.0),
        (normalized + 12, -1.0),
        (fh6::COMBINED_SLIP_BASE, -0.5),
        (308, -1.0),
    ] {
        let mut p = offset_sentinel_packet();
        // Keep the rest of the packet physically consistent so only the field
        // under test can produce an issue.
        put_f(&mut p, 256, 0.0);
        for axis in [32, 36, 40] {
            put_f(&mut p, axis, 0.0);
        }
        put_f(&mut p, 8, 7500.0);
        put_f(&mut p, 12, 800.0);
        put_f(&mut p, 16, 3000.0);
        for i in 0..4 {
            put_f(&mut p, normalized + 4 * i, 0.5);
            put_f(&mut p, fh6::COMBINED_SLIP_BASE + 4 * i, 0.0);
        }
        put_f(&mut p, 308, 0.0);
        put_f(&mut p, offset, value);
        let decoded = fh6::decode(&p).unwrap();
        let issues = fh6::physical_issues(&decoded.frame);
        assert!(
            issues.iter().any(|issue| issue.offset == offset),
            "offset {offset} value {value} produced {issues:?}"
        );
        // Nothing is clamped: the canonical value still reports what arrived.
        let json = serde_json::to_value(&decoded.frame).unwrap();
        assert!(json.is_object());
    }
}

#[test]
fn valid_promoted_boundary_values_raise_no_issue() {
    let mut p = active_packet();
    for i in 0..4 {
        // Exactly the declared domain endpoints, which must stay valid.
        put_f(&mut p, fh6::NORMALIZED_SUSPENSION_TRAVEL_BASE + 4 * i, 0.0);
        put_f(&mut p, fh6::COMBINED_SLIP_BASE + 4 * i, 0.0);
    }
    assert!(fh6::physical_issues(&fh6::decode(&p).unwrap().frame).is_empty());
    for i in 0..4 {
        put_f(&mut p, fh6::NORMALIZED_SUSPENSION_TRAVEL_BASE + 4 * i, 1.0);
    }
    assert!(fh6::physical_issues(&fh6::decode(&p).unwrap().frame).is_empty());
}
