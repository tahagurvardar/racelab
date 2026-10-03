//! F1 25 Phase B against reviewed REAL datagrams from the user's game (see
//! `tests/fixtures/f1_25/README.md`). Values pinned here were reviewed by
//! cross-checking packets against each other and against the drive, not
//! taken on trust from the decoder.
use racelab_lib::{
    adapters::f1_25::{
        car_status::{self, CarStatus},
        car_telemetry::{self, CarTelemetry},
        classify,
        codes::*,
        lap_data::{self, LapData},
        motion_ex::{self, MotionEx},
        offset, parse_header, Classification, PacketKind,
    },
    f1_live::F1Live,
};
use std::{path::PathBuf, time::Instant};

const SNAPSHOTS: [&str; 4] = ["stationary", "driving", "braking", "high-speed"];

fn fixture(snapshot: &str, file: &str) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/f1_25")
        .join(snapshot)
        .join(file);
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn tel(s: &str) -> Vec<u8> {
    fixture(s, "id06-car-telemetry.bin")
}
fn status(s: &str) -> Vec<u8> {
    fixture(s, "id07-car-status.bin")
}
fn lap(s: &str) -> Vec<u8> {
    fixture(s, "id02-lap-data.bin")
}
fn motion(s: &str) -> Vec<u8> {
    fixture(s, "id13-motion-ex.bin")
}

fn t(s: &str) -> CarTelemetry {
    car_telemetry::decode(&tel(s)).unwrap().1.player.unwrap()
}
fn st(s: &str) -> CarStatus {
    car_status::decode(&status(s)).unwrap().1.player.unwrap()
}
fn l(s: &str) -> LapData {
    lap_data::decode(&lap(s)).unwrap().1.player.unwrap()
}
fn m(s: &str) -> MotionEx {
    motion_ex::decode(&motion(s)).unwrap().1.player.unwrap()
}

#[track_caller]
fn close(actual: f32, expected: f32) {
    assert!(
        (actual - expected).abs() <= 1e-4 * expected.abs().max(1.0),
        "{actual} != {expected}"
    );
}

fn with_player(mut bytes: Vec<u8>, player: u8) -> Vec<u8> {
    bytes[offset::PLAYER_CAR_INDEX] = player;
    bytes
}

#[test]
fn every_real_fixture_is_an_accepted_sanitized_2025_packet() {
    let frames = [641, 1655, 1848, 3382];
    for (snapshot, frame) in SNAPSHOTS.iter().zip(frames) {
        for (bytes, kind) in [
            (lap(snapshot), PacketKind::LapData),
            (tel(snapshot), PacketKind::CarTelemetry),
            (status(snapshot), PacketKind::CarStatus),
            (motion(snapshot), PacketKind::MotionEx),
        ] {
            let Classification::Accepted { kind: k, header } = classify(&bytes) else {
                panic!("{snapshot} {kind:?} not accepted");
            };
            assert_eq!(k, kind);
            assert_eq!(header.packet_format, 2025);
            assert_eq!(header.game_year, 25);
            assert_eq!(header.packet_version, 1);
            assert_eq!(
                (header.game_major_version, header.game_minor_version),
                (1, 26)
            );
            assert_eq!(header.session_uid, u64::from_le_bytes(*b"RACELAB!"));
            assert_eq!(header.frame_identifier, frame);
            assert_eq!(header.overall_frame_identifier, frame);
            assert_eq!(header.player_car_index, 0);
            assert_eq!(header.secondary_player_car_index, 255);
        }
    }
}

// ------------------------------------------------------------ car telemetry

#[test]
fn real_car_telemetry_driving_inputs() {
    let s = t("stationary");
    assert_eq!(
        (s.speed_kmh, s.gear, s.engine_rpm, s.clutch),
        (0, Gear::Neutral, 3920, 0)
    );
    assert_eq!((s.throttle, s.brake), (0.0, 0.0));

    let d = t("driving");
    assert_eq!(
        (d.speed_kmh, d.gear, d.engine_rpm),
        (170, Gear::Fourth, 11024)
    );
    assert_eq!((d.throttle, d.brake), (1.0, 0.0));
    close(d.steer, 0.084_084_57);
    assert_eq!(d.rev_lights_percent, 51);

    let b = t("braking");
    assert_eq!(
        (b.speed_kmh, b.gear, b.engine_rpm),
        (59, Gear::Second, 5187)
    );
    assert_eq!((b.throttle, b.brake), (0.0, 1.0));
    close(b.steer, 0.759_547_5);

    let h = t("high-speed");
    assert_eq!(
        (h.speed_kmh, h.gear, h.engine_rpm),
        (292, Gear::Eighth, 10086)
    );
    assert_eq!(h.throttle, 0.0);
    close(h.brake, 0.818_415_2);

    for snapshot in SNAPSHOTS {
        let car = t(snapshot);
        assert!((0.0..=1.0).contains(&car.throttle), "{snapshot}");
        assert!((0.0..=1.0).contains(&car.brake), "{snapshot}");
        assert!((-1.0..=1.0).contains(&car.steer), "{snapshot}");
        assert_eq!(car.drs, Drs::Off, "{snapshot}: DRS was never open");
        assert_eq!(car.engine_temperature_c, 110);
        let p = car_telemetry::decode(&tel(snapshot)).unwrap().1;
        assert_eq!(p.mfd_panel_index, MfdPanel::Closed);
        assert_eq!(p.mfd_panel_index_secondary_player, MfdPanel::Closed);
        assert_eq!(p.suggested_gear, SuggestedGear::NoSuggestion);
    }
}

#[test]
fn real_car_telemetry_temperatures_pressures_and_surfaces() {
    let s = t("stationary");
    assert_eq!(s.brakes_temperature_c.front_left, 25);
    assert_eq!(s.tyres_surface_temperature_c.rear_right, 70);
    assert_eq!(s.tyres_inner_temperature_c.front_right, 70);
    close(s.tyres_pressure_psi.rear_left, 21.3);
    close(s.tyres_pressure_psi.front_left, 24.2);

    let d = t("driving");
    let b = &d.brakes_temperature_c;
    assert_eq!(
        (b.rear_left, b.rear_right, b.front_left, b.front_right),
        (728, 738, 765, 772)
    );
    let b = t("braking").brakes_temperature_c;
    assert_eq!(
        (b.rear_left, b.rear_right, b.front_left, b.front_right),
        (991, 989, 1006, 1005)
    );
    let b = t("high-speed").brakes_temperature_c;
    assert_eq!(
        (b.rear_left, b.rear_right, b.front_left, b.front_right),
        (537, 535, 572, 569)
    );
    for snapshot in ["driving", "braking", "high-speed"] {
        let car = t(snapshot);
        // Reported verbatim: surface and inner both 97 °C on all four tyres.
        for v in [
            car.tyres_surface_temperature_c,
            car.tyres_inner_temperature_c,
        ] {
            assert_eq!(
                (v.rear_left, v.rear_right, v.front_left, v.front_right),
                (97, 97, 97, 97)
            );
        }
        close(car.tyres_pressure_psi.rear_left, 21.710_573);
        close(car.tyres_pressure_psi.front_right, 24.666_475);
        // Front brakes hotter than rear, from the F1 wheel order.
        assert!(car.brakes_temperature_c.front_left > car.brakes_temperature_c.rear_left);
        assert!(car.brakes_temperature_c.front_right > car.brakes_temperature_c.rear_right);
    }
    for snapshot in SNAPSHOTS {
        let sfc = t(snapshot).surface_type;
        assert_eq!(
            [
                sfc.rear_left,
                sfc.rear_right,
                sfc.front_left,
                sfc.front_right
            ],
            [SurfaceType::Tarmac; 4]
        );
        // Front tyres run higher pressures than rears: wire slots 2..3 are front.
        let p = t(snapshot).tyres_pressure_psi;
        assert!(p.front_left > p.rear_left && p.front_right > p.rear_right);
    }
}

// --------------------------------------------------------------- car status

#[test]
fn real_car_status() {
    for snapshot in SNAPSHOTS {
        let s = st(snapshot);
        assert_eq!(s.traction_control, TractionControl::Full);
        assert_eq!(s.anti_lock_brakes, AntiLockBrakes::On);
        assert_eq!(s.front_brake_bias_percent, 58);
        assert_eq!(s.pit_limiter_status, PitLimiter::Off);
        assert_eq!((s.fuel_in_tank, s.fuel_capacity), (10.0, 110.0));
        close(s.fuel_remaining_laps, 5.409_836);
        assert_eq!((s.max_rpm, s.idle_rpm), (13_099, 4_000));
        assert_eq!(s.max_gears, 9, "reported verbatim");
        assert_eq!(s.drs_allowed, DrsAllowed::NotAllowed);
        assert_eq!(s.actual_tyre_compound, ActualTyreCompound::C3);
        assert_eq!(s.visual_tyre_compound, VisualTyreCompound::Soft);
        assert_eq!(s.vehicle_fia_flags, FiaFlag::NoFlag);
        assert_eq!(s.ers_store_energy_j, 4_000_000.0);
        assert_eq!(s.network_paused, 0);
    }
    assert_eq!(st("stationary").fuel_mix, FuelMix::Lean);
    assert_eq!(st("driving").fuel_mix, FuelMix::Standard);
    assert_eq!(
        st("stationary").ers_deploy_mode,
        ErsDeployMode::NoDeployment
    );
    assert_eq!(st("driving").ers_deploy_mode, ErsDeployMode::Hotlap);
    assert_eq!(st("driving").drs_activation_distance_m, 98);
    assert_eq!(st("high-speed").tyres_age_laps, 1);
    assert_eq!(st("braking").tyres_age_laps, 0);
    close(st("driving").engine_power_ice_w, 549_682.94);
    close(st("driving").engine_power_mguk_w, 56_170.08);
    assert_eq!(st("braking").engine_power_mguk_w, 0.0);
}

// ----------------------------------------------------------------- lap data

#[test]
fn real_lap_data_times_positions_and_statuses() {
    let s = l("stationary");
    assert_eq!((s.current_lap_time_ms, s.last_lap_time_ms), (0, 0));
    close(s.lap_distance_m, -5_272.478_5);
    assert_eq!(s.pit_status, PitStatus::Pitting);
    assert_eq!(s.current_lap_invalid, LapValidity::Valid);
    assert_eq!(s.speed_trap_fastest_lap, 255);

    let d = l("driving");
    assert_eq!(d.current_lap_time_ms, 14_699);
    close(d.lap_distance_m, 907.647_1);
    assert_eq!(d.current_lap_invalid, LapValidity::Invalid);
    close(d.speed_trap_fastest_speed_kmh, 327.447_6);
    assert_eq!(d.speed_trap_fastest_lap, 1);

    let b = l("braking");
    assert_eq!(b.current_lap_time_ms, 24_316);
    close(b.lap_distance_m, 1_514.466_6);

    let h = l("high-speed");
    assert_eq!(h.current_lap_num, 2);
    assert_eq!(h.last_lap_time_ms, 94_052);
    assert_eq!(h.current_lap_time_ms, 6_816);
    close(h.lap_distance_m, 601.098_6);
    close(h.total_distance_m, 6_009.981_4);
    assert_eq!(h.current_lap_invalid, LapValidity::Valid);
    close(h.speed_trap_fastest_speed_kmh, 329.748_47);
    assert_eq!(h.speed_trap_fastest_lap, 2);

    for snapshot in SNAPSHOTS {
        let car = l(snapshot);
        assert_eq!(car.car_position, 1);
        assert_eq!(car.sector, Sector::Sector1);
        assert_eq!(car.result_status, ResultStatus::Active);
        assert_eq!(car.pit_lane_timer_active, PitLaneTimer::Inactive);
        assert_eq!(car.sector1_time.total_ms, 0, "sector 1 not completed");
        assert_eq!(car.sector2_time.total_ms, 0);
        assert_eq!(
            (
                car.penalties_s,
                car.total_warnings,
                car.corner_cutting_warnings
            ),
            (0, 0, 0)
        );
        assert_eq!(
            (
                car.num_unserved_drive_through_pens,
                car.num_unserved_stop_go_pens
            ),
            (0, 0)
        );
        let p = lap_data::decode(&lap(snapshot)).unwrap().1;
        assert_eq!(
            (p.time_trial_pb_car_idx, p.time_trial_rival_car_idx),
            (1, 7)
        );
    }
}

/// The community-reported `m_driverStatus` / `m_gridPosition` swap. Decoded
/// in specification order, the real bytes say "in garage" while parked and
/// "flying lap" while driving; swapped, they would say "in garage" at
/// 170 km/h. Specification order holds (player car, Time Trial, game 1.26).
#[test]
fn real_lap_data_confirms_specification_order_for_driver_status() {
    assert_eq!(l("stationary").driver_status, DriverStatus::InGarage);
    for snapshot in ["driving", "braking", "high-speed"] {
        assert_eq!(l(snapshot).driver_status, DriverStatus::FlyingLap);
        assert_eq!(l(snapshot).grid_position, 0);
    }
}

// ---------------------------------------------------------------- motion ex

#[test]
fn real_motion_ex_agrees_with_car_telemetry() {
    for snapshot in SNAPSHOTS {
        let kmh = m(snapshot).local_velocity_mps.z * 3.6;
        let reported = f32::from(t(snapshot).speed_kmh);
        assert!(
            (kmh - reported).abs() < 1.0,
            "{snapshot}: {kmh} km/h from Motion Ex vs {reported}"
        );
    }
    close(m("high-speed").local_velocity_mps.z, 81.369_9);
}

#[test]
fn real_motion_ex_confirms_every_wheel_corner() {
    // Rear = wire slots 0..1: under full throttle only they drive.
    let d = m("driving");
    assert!(d.wheel_long_force.rear_left > 5000.0 && d.wheel_long_force.rear_right > 5000.0);
    assert!(d.wheel_long_force.front_left < 0.0 && d.wheel_long_force.front_right < 0.0);
    assert!(d.wheel_slip_ratio.rear_left > 0.03 && d.wheel_slip_ratio.rear_right > 0.03);
    // Left = wire slots 0 and 2: turning right (steer +) loads them.
    let b = m("braking");
    assert!(t("braking").steer > 0.0 && b.front_wheels_angle_rad > 0.0);
    assert!(b.wheel_vert_force.front_left > b.wheel_vert_force.front_right);
    assert!(b.wheel_vert_force.rear_left > b.wheel_vert_force.rear_right);
    close(b.wheel_vert_force.front_left, 3_648.375_5);
    close(b.front_wheels_angle_rad, 0.255_2);
    // Hard braking at 292 km/h: every wheel retards, downforce on all four.
    let h = m("high-speed");
    for force in [
        h.wheel_long_force.rear_left,
        h.wheel_long_force.rear_right,
        h.wheel_long_force.front_left,
        h.wheel_long_force.front_right,
    ] {
        assert!(force < -5000.0);
    }
    for force in [
        h.wheel_vert_force.rear_left,
        h.wheel_vert_force.rear_right,
        h.wheel_vert_force.front_left,
        h.wheel_vert_force.front_right,
    ] {
        assert!(force > 7000.0);
    }
    // Parked in the garage: no load, no motion (values verbatim).
    let s = m("stationary");
    assert_eq!(s.wheel_vert_force.front_left, 0.0);
    assert_eq!(s.local_velocity_mps.z, 0.0);
    close(s.height_of_cog_above_ground, 0.400_83);
}

// ------------------------------------------------------------- player index

#[test]
fn real_packets_select_the_slot_named_by_the_player_index() {
    // Slots 1 and 7 hold the Time Trial personal-best and rival cars.
    let driving = tel("driving");
    assert_eq!(t("driving").speed_kmh, 170);
    let ghost = |player| {
        car_telemetry::decode(&with_player(driving.clone(), player))
            .unwrap()
            .1
            .player
            .unwrap()
    };
    assert_eq!((ghost(1).speed_kmh, ghost(1).gear), (427, Gear::Eighth));
    assert_eq!((ghost(7).speed_kmh, ghost(7).gear), (447, Gear::Eighth));
    let lap_ghost = lap_data::decode(&with_player(lap("stationary"), 1))
        .unwrap()
        .1
        .player
        .unwrap();
    assert_eq!(lap_ghost.current_lap_num, 2);
    assert_eq!(l("stationary").current_lap_num, 1);
}

#[test]
fn real_packets_with_player_index_255_have_no_player_values() {
    for snapshot in SNAPSHOTS {
        assert!(car_telemetry::decode(&with_player(tel(snapshot), 255))
            .unwrap()
            .1
            .player
            .is_none());
        assert!(car_status::decode(&with_player(status(snapshot), 255))
            .unwrap()
            .1
            .player
            .is_none());
        assert!(lap_data::decode(&with_player(lap(snapshot), 255))
            .unwrap()
            .1
            .player
            .is_none());
        assert!(motion_ex::decode(&with_player(motion(snapshot), 255))
            .unwrap()
            .1
            .player
            .is_none());
    }
}

// -------------------------------------------------------------- aggregation

#[test]
fn real_packets_out_of_order_keep_the_newest_per_family() {
    let now = Instant::now();
    let mut live = F1Live::default();
    let feed = |live: &mut F1Live, bytes: Vec<u8>| {
        let header = parse_header(&bytes).unwrap();
        let Classification::Accepted { kind, .. } = classify(&bytes) else {
            panic!()
        };
        live.observe(kind, &header, &bytes, now, 0);
    };
    // Telemetry: newest first, then three older frames.
    for s in ["high-speed", "driving", "stationary", "braking"] {
        feed(&mut live, tel(s));
    }
    // Lap data: oldest first.
    for s in SNAPSHOTS {
        feed(&mut live, lap(s));
    }
    // Status: only an old frame.
    feed(&mut live, status("stationary"));
    let snap = live.snapshot(now);
    let telemetry = snap.car_telemetry.unwrap();
    assert_eq!(telemetry.overall_frame_identifier, 3382);
    assert_eq!(telemetry.value.player.unwrap().speed_kmh, 292);
    assert_eq!(snap.lap_data.unwrap().overall_frame_identifier, 3382);
    assert_eq!(snap.car_status.unwrap().overall_frame_identifier, 641);
    assert!(snap.motion_ex.is_none());
    assert_eq!(snap.out_of_order_dropped, 3);
    assert_eq!(snap.session_uid.as_deref(), Some("2396549747549880658"));
}

// ------------------------------------------------- frontend golden snapshot

/// The four real snapshots as the product Live view receives them: each
/// snapshot's four packets fed through the aggregator and serialized exactly
/// as `get_f1_live` serializes its `live` field (ages 0, received time 0).
/// The frontend tests and the review harness read this file, so every F1
/// value they present is real decoder output, never a hand-typed number.
///
/// Regenerate after a deliberate decoder change with
/// `RACELAB_UPDATE_F1_GOLDEN=1 cargo test --test f1_25_real`.
#[test]
fn frontend_golden_matches_the_decoder() {
    let now = Instant::now();
    let mut golden = serde_json::Map::new();
    for snapshot in SNAPSHOTS {
        let mut live = F1Live::default();
        for bytes in [
            tel(snapshot),
            status(snapshot),
            lap(snapshot),
            motion(snapshot),
        ] {
            let Classification::Accepted { kind, header } = classify(&bytes) else {
                panic!()
            };
            live.observe(kind, &header, &bytes, now, 0);
        }
        golden.insert(
            snapshot.to_string(),
            serde_json::to_value(live.snapshot(now)).unwrap(),
        );
    }
    let actual = serde_json::Value::Object(golden);
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/f1_25/live-snapshots.json");
    if std::env::var("RACELAB_UPDATE_F1_GOLDEN").as_deref() == Ok("1") {
        let mut text = serde_json::to_string_pretty(&actual).unwrap();
        text.push('\n');
        std::fs::write(&path, text).unwrap();
    }
    let expected: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&path)
            .expect("live-snapshots.json missing; run with RACELAB_UPDATE_F1_GOLDEN=1"),
    )
    .unwrap();
    // Compared after the same text round trip on both sides: serde_json's
    // default float parser is not correctly rounded, so an f64 read back from
    // text can differ in its last bit from the one that was written.
    let actual: serde_json::Value =
        serde_json::from_str(&serde_json::to_string(&actual).unwrap()).unwrap();
    assert!(
        expected == actual,
        "live-snapshots.json is not the decoder's output; regenerate it deliberately"
    );
}

#[test]
fn live_status_over_udp_carries_values_but_no_identifiers() {
    use racelab_lib::{f1_evidence::F1EvidenceService, ingress::LISTEN_ADDRESS};
    let service = F1EvidenceService::new(true, 0);
    service.start().unwrap();
    let port = service.live_status().bound_port.unwrap();
    let sender = std::net::UdpSocket::bind((LISTEN_ADDRESS, 0)).unwrap();
    for bytes in [
        tel("driving"),
        status("driving"),
        lap("driving"),
        motion("driving"),
    ] {
        sender.send_to(&bytes, (LISTEN_ADDRESS, port)).unwrap();
    }
    let deadline = Instant::now() + std::time::Duration::from_secs(3);
    let status = loop {
        let status = service.live_status();
        if status.live.motion_ex.is_some() && status.live.car_telemetry.is_some() {
            break status;
        }
        assert!(Instant::now() < deadline, "timed out");
        std::thread::sleep(std::time::Duration::from_millis(5));
    };
    assert!(status.enabled && status.listening);
    assert!(status.last_accepted_age_ms.unwrap() < 3000);
    let player = status.live.car_telemetry.unwrap().value.player.unwrap();
    assert_eq!(player.speed_kmh, 170);
    let json = serde_json::to_string(&service.live_status()).unwrap();
    for absent in [
        "\"kinds\"",
        "packet_format",
        "datagrams",
        "\"capture\"",
        "rejection",
    ] {
        assert!(!json.contains(absent), "{absent} in {json}");
    }
    service.stop().unwrap();
}
