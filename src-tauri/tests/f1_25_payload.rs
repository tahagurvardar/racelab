//! F1 25 Phase B: typed payload decoding and latest-value aggregation.
//!
//! Synthetic fixtures are written field by field in specification order by
//! writers in this file. The writers know nothing of the decoder's offsets,
//! so a decoder that skips, reorders or mistypes a field fails here. Every
//! datagram is checked against the Phase A classifier before decoding.
use racelab_lib::{
    adapters::f1_25::{
        car_status::{self, CarStatus},
        car_telemetry::{self, CarTelemetry},
        classify,
        codes::*,
        lap_data, motion_ex, player_index, Classification, DecodeError, PacketKind, Rejection,
        Wheels, MAX_CARS,
    },
    f1_evidence::F1Evidence,
    f1_live::F1Live,
};
use std::time::{Duration, Instant};

// ------------------------------------------------------------------ writer

struct W(Vec<u8>);
impl W {
    fn u8(&mut self, v: u8) -> &mut Self {
        self.0.push(v);
        self
    }
    fn i8(&mut self, v: i8) -> &mut Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn u16(&mut self, v: u16) -> &mut Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn u32(&mut self, v: u32) -> &mut Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn f32(&mut self, v: f32) -> &mut Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
}

#[derive(Clone, Copy)]
struct Head {
    id: u8,
    uid: u64,
    frame: u32,
    overall: u32,
    player: u8,
}

fn head(id: u8, player: u8) -> Head {
    Head {
        id,
        uid: 0xDEAD_BEEF_0000_0001,
        frame: 100,
        overall: 100,
        player,
    }
}

fn header(h: Head) -> W {
    let mut w = W(Vec::new());
    w.u16(2025)
        .u8(25)
        .u8(1)
        .u8(5)
        .u8(1)
        .u8(h.id)
        .0
        .extend_from_slice(&h.uid.to_le_bytes());
    w.f32(12.0).u32(h.frame).u32(h.overall).u8(h.player).u8(255);
    assert_eq!(w.0.len(), 29);
    w
}

fn accepted(bytes: &[u8], kind: PacketKind) {
    match classify(bytes) {
        Classification::Accepted { kind: k, .. } => assert_eq!(k, kind),
        other => panic!("fixture not accepted: {other:?}"),
    }
}

// ---------------------------------------------------------- car telemetry

/// One `CarTelemetryData` in spec order. `seed` makes every car distinct.
#[derive(Clone, Copy)]
struct Tel {
    speed: u16,
    throttle: f32,
    steer: f32,
    brake: f32,
    clutch: u8,
    gear: i8,
    rpm: u16,
    drs: u8,
    rev_pct: u8,
    rev_bits: u16,
    brakes: [u16; 4],
    surface: [u8; 4],
    inner: [u8; 4],
    engine: u16,
    pressure: [f32; 4],
    surface_type: [u8; 4],
}

fn tel(seed: u16) -> Tel {
    Tel {
        speed: 100 + seed,
        throttle: 0.5,
        steer: -0.25,
        brake: 0.0,
        clutch: 0,
        gear: 4,
        rpm: 9000 + seed,
        drs: 0,
        rev_pct: 40,
        rev_bits: 0x00FF,
        brakes: [400, 410, 520, 530],
        surface: [90, 91, 95, 96],
        inner: [100, 101, 105, 106],
        engine: 110,
        pressure: [21.5, 21.6, 23.1, 23.2],
        surface_type: [0, 0, 1, 7],
    }
}

fn write_tel(w: &mut W, t: &Tel) {
    w.u16(t.speed)
        .f32(t.throttle)
        .f32(t.steer)
        .f32(t.brake)
        .u8(t.clutch)
        .i8(t.gear)
        .u16(t.rpm)
        .u8(t.drs)
        .u8(t.rev_pct)
        .u16(t.rev_bits);
    t.brakes.iter().for_each(|&v| {
        w.u16(v);
    });
    t.surface.iter().for_each(|&v| {
        w.u8(v);
    });
    t.inner.iter().for_each(|&v| {
        w.u8(v);
    });
    w.u16(t.engine);
    t.pressure.iter().for_each(|&v| {
        w.f32(v);
    });
    t.surface_type.iter().for_each(|&v| {
        w.u8(v);
    });
}

fn telemetry_packet(h: Head, player_car: Tel, mfd: u8, suggested: i8) -> Vec<u8> {
    let mut w = header(h);
    for i in 0..MAX_CARS {
        let car = if i == usize::from(h.player) {
            player_car
        } else {
            tel(i as u16)
        };
        write_tel(&mut w, &car);
    }
    w.u8(mfd).u8(255).i8(suggested);
    assert_eq!(w.0.len(), 1352);
    accepted(&w.0, PacketKind::CarTelemetry);
    w.0
}

fn decode_tel(bytes: &[u8]) -> CarTelemetry {
    car_telemetry::decode(bytes).unwrap().1.player.unwrap()
}

#[test]
fn car_telemetry_fields_and_units() {
    let mut t = tel(0);
    t.speed = 287;
    t.throttle = 1.0;
    t.brake = 0.0;
    t.clutch = 0;
    t.rpm = 11_850;
    t.drs = 1;
    t.rev_pct = 97;
    t.rev_bits = 0x7FFF;
    t.engine = 112;
    let bytes = telemetry_packet(head(6, 0), t, 255, 7);
    let (_, packet) = car_telemetry::decode(&bytes).unwrap();
    let car = packet.player.unwrap();
    assert_eq!(car.speed_kmh, 287);
    assert_eq!(car.throttle, 1.0);
    assert_eq!(car.brake, 0.0);
    assert_eq!(car.engine_rpm, 11_850);
    assert_eq!(car.drs, Drs::On);
    assert_eq!(car.rev_lights_percent, 97);
    assert_eq!(car.rev_lights_bit_value, 0x7FFF);
    assert_eq!(car.engine_temperature_c, 112);
    assert_eq!(packet.mfd_panel_index, MfdPanel::Closed);
    assert_eq!(packet.mfd_panel_index_secondary_player, MfdPanel::Closed);
    assert_eq!(packet.suggested_gear, SuggestedGear::Seventh);
}

#[test]
fn car_telemetry_input_ranges_and_signed_steering() {
    for (throttle, brake, steer) in [(0.0, 1.0, -1.0), (1.0, 0.0, 1.0), (0.37, 0.62, 0.0)] {
        let mut t = tel(0);
        t.throttle = throttle;
        t.brake = brake;
        t.steer = steer;
        let car = decode_tel(&telemetry_packet(head(6, 0), t, 255, 0));
        assert_eq!(
            (car.throttle, car.brake, car.steer),
            (throttle, brake, steer)
        );
    }
    // Full lock left is negative, full lock right positive, exactly as sent.
    let mut left = tel(0);
    left.steer = -0.8;
    assert!(decode_tel(&telemetry_packet(head(6, 0), left, 255, 0)).steer < 0.0);
}

#[test]
fn car_telemetry_gears_reverse_neutral_forward_and_unknown() {
    for (raw, gear) in [
        (-1, Gear::Reverse),
        (0, Gear::Neutral),
        (1, Gear::First),
        (8, Gear::Eighth),
        (9, Gear::Unknown(9)),
        (-2, Gear::Unknown(-2)),
    ] {
        let mut t = tel(0);
        t.gear = raw;
        let car = decode_tel(&telemetry_packet(head(6, 0), t, 255, 0));
        assert_eq!(car.gear, gear);
        assert_eq!(car.gear.raw(), raw);
    }
    assert_eq!(Gear::Reverse.label(), Some("R"));
    assert_eq!(Gear::Unknown(9).label(), None);
}

#[test]
fn car_telemetry_wheel_arrays_follow_the_f1_order() {
    let mut t = tel(0);
    // Wire order RL, RR, FL, FR.
    t.brakes = [301, 302, 303, 304];
    t.surface = [81, 82, 83, 84];
    t.inner = [91, 92, 93, 94];
    t.pressure = [20.25, 20.5, 22.75, 23.0];
    t.surface_type = [0, 4, 7, 99];
    let car = decode_tel(&telemetry_packet(head(6, 0), t, 255, 0));
    assert_eq!(
        car.brakes_temperature_c,
        Wheels {
            rear_left: 301,
            rear_right: 302,
            front_left: 303,
            front_right: 304
        }
    );
    assert_eq!(car.tyres_surface_temperature_c.rear_left, 81);
    assert_eq!(car.tyres_surface_temperature_c.front_right, 84);
    assert_eq!(car.tyres_inner_temperature_c.rear_right, 92);
    assert_eq!(car.tyres_inner_temperature_c.front_left, 93);
    assert_eq!(car.tyres_pressure_psi.rear_left, 20.25);
    assert_eq!(car.tyres_pressure_psi.front_right, 23.0);
    assert_eq!(car.surface_type.rear_left, SurfaceType::Tarmac);
    assert_eq!(car.surface_type.rear_right, SurfaceType::Gravel);
    assert_eq!(car.surface_type.front_left, SurfaceType::Grass);
    assert_eq!(car.surface_type.front_right, SurfaceType::Unknown(99));
}

#[test]
fn mfd_and_suggested_gear_codes() {
    let bytes = telemetry_packet(head(6, 0), tel(0), 4, 0);
    let (_, p) = car_telemetry::decode(&bytes).unwrap();
    assert_eq!(p.mfd_panel_index, MfdPanel::Temperatures);
    assert_eq!(p.suggested_gear, SuggestedGear::NoSuggestion);
    let bytes = telemetry_packet(head(6, 0), tel(0), 17, -1);
    let (_, p) = car_telemetry::decode(&bytes).unwrap();
    assert_eq!(p.mfd_panel_index, MfdPanel::Unknown(17));
    assert_eq!(p.suggested_gear, SuggestedGear::Unknown(-1));
}

// ------------------------------------------------------------ player index

#[test]
fn player_index_selects_the_players_slot_never_slot_zero() {
    let mut mine = tel(0);
    mine.speed = 333;
    for player in [0u8, 1, 13, 21] {
        let bytes = telemetry_packet(head(6, player), mine, 255, 0);
        assert_eq!(decode_tel(&bytes).speed_kmh, 333, "player {player}");
    }
    // Slot 0 holds a different car when the player is 13.
    let bytes = telemetry_packet(head(6, 13), mine, 255, 0);
    let (header, _) = car_telemetry::decode(&bytes).unwrap();
    assert_eq!(player_index(&header), Some(13));
}

#[test]
fn invalid_player_index_makes_every_player_payload_unavailable() {
    for player in [22u8, 100, 255] {
        let tel = car_telemetry::decode(&telemetry_packet(head(6, player), tel(0), 2, 3))
            .unwrap()
            .1;
        assert!(tel.player.is_none());
        // Packet-level fields are still decoded.
        assert_eq!(tel.mfd_panel_index, MfdPanel::Damage);
        assert!(
            car_status::decode(&status_packet(head(7, player), status(0)))
                .unwrap()
                .1
                .player
                .is_none()
        );
        assert!(lap_data::decode(&lap_packet(head(2, player), lap(0)))
            .unwrap()
            .1
            .player
            .is_none());
        assert!(motion_ex::decode(&motion_packet(head(13, player)))
            .unwrap()
            .1
            .player
            .is_none());
    }
}

#[test]
fn decoders_refuse_anything_not_accepted_as_their_packet() {
    let tel_bytes = telemetry_packet(head(6, 0), tel(0), 255, 0);
    assert_eq!(
        car_status::decode(&tel_bytes).unwrap_err(),
        DecodeError::WrongPacket {
            expected: PacketKind::CarStatus,
            found: PacketKind::CarTelemetry
        }
    );
    assert!(matches!(
        car_telemetry::decode(&tel_bytes[..1351]).unwrap_err(),
        DecodeError::Rejected {
            rejection: Rejection::SizeMismatch { .. }
        }
    ));
    let mut old = tel_bytes.clone();
    old[0..2].copy_from_slice(&2024u16.to_le_bytes());
    assert!(car_telemetry::decode(&old).is_err());
    assert!(motion_ex::decode(&[0; 10]).is_err());
}

// --------------------------------------------------------------- car status

#[derive(Clone, Copy)]
struct St {
    tc: u8,
    abs: u8,
    fuel_mix: u8,
    bias: u8,
    pit_limiter: u8,
    fuel: f32,
    capacity: f32,
    laps: f32,
    max_rpm: u16,
    idle_rpm: u16,
    max_gears: u8,
    drs_allowed: u8,
    drs_distance: u16,
    actual: u8,
    visual: u8,
    age: u8,
    fia: i8,
    ice: f32,
    mguk: f32,
    store: f32,
    deploy: u8,
    harvested_k: f32,
    harvested_h: f32,
    deployed: f32,
    paused: u8,
}

fn status(seed: u8) -> St {
    St {
        tc: 0,
        abs: 0,
        fuel_mix: 1,
        bias: 56,
        pit_limiter: 0,
        fuel: 10.0 + f32::from(seed),
        capacity: 110.0,
        laps: 3.25,
        max_rpm: 13_000,
        idle_rpm: 4_000,
        max_gears: 8,
        drs_allowed: 0,
        drs_distance: 0,
        actual: 18,
        visual: 17,
        age: 2,
        fia: 0,
        ice: 560_000.0,
        mguk: 120_000.0,
        store: 3_000_000.0,
        deploy: 1,
        harvested_k: 150_000.0,
        harvested_h: 0.0,
        deployed: 400_000.0,
        paused: 0,
    }
}

fn write_status(w: &mut W, s: &St) {
    w.u8(s.tc)
        .u8(s.abs)
        .u8(s.fuel_mix)
        .u8(s.bias)
        .u8(s.pit_limiter)
        .f32(s.fuel)
        .f32(s.capacity)
        .f32(s.laps)
        .u16(s.max_rpm)
        .u16(s.idle_rpm)
        .u8(s.max_gears)
        .u8(s.drs_allowed)
        .u16(s.drs_distance)
        .u8(s.actual)
        .u8(s.visual)
        .u8(s.age)
        .i8(s.fia)
        .f32(s.ice)
        .f32(s.mguk)
        .f32(s.store)
        .u8(s.deploy)
        .f32(s.harvested_k)
        .f32(s.harvested_h)
        .f32(s.deployed)
        .u8(s.paused);
}

fn status_packet(h: Head, player_car: St) -> Vec<u8> {
    let mut w = header(h);
    for i in 0..MAX_CARS {
        let car = if i == usize::from(h.player) {
            player_car
        } else {
            status(i as u8)
        };
        write_status(&mut w, &car);
    }
    assert_eq!(w.0.len(), 1239);
    accepted(&w.0, PacketKind::CarStatus);
    w.0
}

fn decode_status(bytes: &[u8]) -> CarStatus {
    car_status::decode(bytes).unwrap().1.player.unwrap()
}

#[test]
fn car_status_fuel_bias_rpm_and_drs() {
    let mut s = status(0);
    s.fuel = 7.5;
    s.capacity = 110.0;
    s.laps = -0.5;
    s.bias = 54;
    s.drs_allowed = 1;
    s.drs_distance = 0;
    s.max_rpm = 12_500;
    s.idle_rpm = 3_900;
    let car = decode_status(&status_packet(head(7, 3), s));
    assert_eq!(car.fuel_in_tank, 7.5);
    assert_eq!(car.fuel_capacity, 110.0);
    // A negative laps-remaining value is reported, not clamped.
    assert_eq!(car.fuel_remaining_laps, -0.5);
    assert_eq!(car.front_brake_bias_percent, 54);
    assert_eq!(car.drs_allowed, DrsAllowed::Allowed);
    assert_eq!(car.drs_activation_distance_m, 0);
    assert_eq!(car.max_rpm, 12_500);
    assert_eq!(car.idle_rpm, 3_900);
    assert_eq!(car.max_gears, 8);
    assert_eq!(car.traction_control, TractionControl::Off);
    assert_eq!(car.anti_lock_brakes, AntiLockBrakes::Off);
    assert_eq!(car.fuel_mix, FuelMix::Standard);
    assert_eq!(car.pit_limiter_status, PitLimiter::Off);
}

#[test]
fn car_status_tyre_compounds_and_flags() {
    for (actual, expected) in [
        (16, ActualTyreCompound::C5),
        (21, ActualTyreCompound::C0),
        (22, ActualTyreCompound::C6),
        (7, ActualTyreCompound::Inter),
        (8, ActualTyreCompound::Wet),
        (9, ActualTyreCompound::ClassicDry),
        (11, ActualTyreCompound::F2SuperSoft),
        (15, ActualTyreCompound::F2Wet),
        (0, ActualTyreCompound::Unknown(0)),
        (23, ActualTyreCompound::Unknown(23)),
    ] {
        let mut s = status(0);
        s.actual = actual;
        assert_eq!(
            decode_status(&status_packet(head(7, 0), s)).actual_tyre_compound,
            expected
        );
    }
    for (visual, expected) in [
        (16, VisualTyreCompound::Soft),
        (17, VisualTyreCompound::Medium),
        (18, VisualTyreCompound::Hard),
        (19, VisualTyreCompound::F2SuperSoft),
        (22, VisualTyreCompound::F2Hard),
        (6, VisualTyreCompound::Unknown(6)),
    ] {
        let mut s = status(0);
        s.visual = visual;
        assert_eq!(
            decode_status(&status_packet(head(7, 0), s)).visual_tyre_compound,
            expected
        );
    }
    for (fia, expected) in [
        (-1, FiaFlag::InvalidOrUnknown),
        (0, FiaFlag::NoFlag),
        (3, FiaFlag::Yellow),
        (4, FiaFlag::Unknown(4)),
    ] {
        let mut s = status(0);
        s.fia = fia;
        assert_eq!(
            decode_status(&status_packet(head(7, 0), s)).vehicle_fia_flags,
            expected
        );
    }
    let mut s = status(0);
    s.age = 14;
    assert_eq!(
        decode_status(&status_packet(head(7, 0), s)).tyres_age_laps,
        14
    );
}

#[test]
fn car_status_ers() {
    let mut s = status(0);
    s.store = 4_000_000.0;
    s.deploy = 3;
    s.ice = 575_000.5;
    s.mguk = 120_000.25;
    s.harvested_k = 1.5;
    s.harvested_h = 2.5;
    s.deployed = 3.5;
    s.paused = 1;
    let car = decode_status(&status_packet(head(7, 0), s));
    assert_eq!(car.ers_store_energy_j, 4_000_000.0);
    assert_eq!(car.ers_deploy_mode, ErsDeployMode::Overtake);
    assert_eq!(car.engine_power_ice_w, 575_000.5);
    assert_eq!(car.engine_power_mguk_w, 120_000.25);
    assert_eq!(car.ers_harvested_this_lap_mguk, 1.5);
    assert_eq!(car.ers_harvested_this_lap_mguh, 2.5);
    assert_eq!(car.ers_deployed_this_lap, 3.5);
    assert_eq!(car.network_paused, 1);
}

#[test]
fn unknown_enum_values_keep_their_raw_value() {
    let mut s = status(0);
    s.tc = 3;
    s.abs = 2;
    s.fuel_mix = 4;
    s.pit_limiter = 9;
    s.drs_allowed = 2;
    s.deploy = 4;
    let car = decode_status(&status_packet(head(7, 0), s));
    assert_eq!(car.traction_control, TractionControl::Unknown(3));
    assert_eq!(car.anti_lock_brakes, AntiLockBrakes::Unknown(2));
    assert_eq!(car.fuel_mix, FuelMix::Unknown(4));
    assert_eq!(car.pit_limiter_status, PitLimiter::Unknown(9));
    assert_eq!(car.drs_allowed, DrsAllowed::Unknown(2));
    assert_eq!(car.ers_deploy_mode, ErsDeployMode::Unknown(4));
    let json = serde_json::to_value(car).unwrap();
    assert_eq!(json["fuel_mix"]["raw"], 4);
    assert!(json["fuel_mix"]["label"].is_null());
    assert_eq!(json["actual_tyre_compound"]["label"], "C3");
}

// ----------------------------------------------------------------- lap data

#[derive(Clone, Copy)]
struct Lp {
    last: u32,
    current: u32,
    s1: (u16, u8),
    s2: (u16, u8),
    front: (u16, u8),
    leader: (u16, u8),
    lap_distance: f32,
    total_distance: f32,
    sc_delta: f32,
    position: u8,
    lap: u8,
    pit_status: u8,
    pit_stops: u8,
    sector: u8,
    invalid: u8,
    penalties: u8,
    warnings: u8,
    cc_warnings: u8,
    dt: u8,
    sg: u8,
    grid: u8,
    driver: u8,
    result: u8,
    pit_timer: u8,
    pit_lane_ms: u16,
    pit_stop_ms: u16,
    serve: u8,
    trap: f32,
    trap_lap: u8,
}

fn lap(seed: u8) -> Lp {
    Lp {
        last: 0,
        current: 1000 + u32::from(seed),
        s1: (0, 0),
        s2: (0, 0),
        front: (0, 0),
        leader: (0, 0),
        lap_distance: 10.0,
        total_distance: 10.0,
        sc_delta: 0.0,
        position: seed + 1,
        lap: 1,
        pit_status: 0,
        pit_stops: 0,
        sector: 0,
        invalid: 0,
        penalties: 0,
        warnings: 0,
        cc_warnings: 0,
        dt: 0,
        sg: 0,
        grid: seed + 1,
        driver: 4,
        result: 2,
        pit_timer: 0,
        pit_lane_ms: 0,
        pit_stop_ms: 0,
        serve: 0,
        trap: 0.0,
        trap_lap: 255,
    }
}

fn write_lap(w: &mut W, l: &Lp) {
    w.u32(l.last)
        .u32(l.current)
        .u16(l.s1.0)
        .u8(l.s1.1)
        .u16(l.s2.0)
        .u8(l.s2.1)
        .u16(l.front.0)
        .u8(l.front.1)
        .u16(l.leader.0)
        .u8(l.leader.1)
        .f32(l.lap_distance)
        .f32(l.total_distance)
        .f32(l.sc_delta)
        .u8(l.position)
        .u8(l.lap)
        .u8(l.pit_status)
        .u8(l.pit_stops)
        .u8(l.sector)
        .u8(l.invalid)
        .u8(l.penalties)
        .u8(l.warnings)
        .u8(l.cc_warnings)
        .u8(l.dt)
        .u8(l.sg)
        .u8(l.grid)
        .u8(l.driver)
        .u8(l.result)
        .u8(l.pit_timer)
        .u16(l.pit_lane_ms)
        .u16(l.pit_stop_ms)
        .u8(l.serve)
        .f32(l.trap)
        .u8(l.trap_lap);
}

fn lap_packet(h: Head, player_car: Lp) -> Vec<u8> {
    let mut w = header(h);
    for i in 0..MAX_CARS {
        let car = if i == usize::from(h.player) {
            player_car
        } else {
            lap(i as u8)
        };
        write_lap(&mut w, &car);
    }
    w.u8(1).u8(255);
    assert_eq!(w.0.len(), 1285);
    accepted(&w.0, PacketKind::LapData);
    w.0
}

#[test]
fn lap_data_times_and_sectors() {
    let mut l = lap(0);
    l.last = 92_345;
    l.current = 31_002;
    l.s1 = (28_456, 0);
    l.s2 = (5_250, 1); // 1:05.250
    l.front = (999, 0);
    l.leader = (1_500, 2);
    let (_, p) = lap_data::decode(&lap_packet(head(2, 5), l)).unwrap();
    let car = p.player.unwrap();
    assert_eq!(car.last_lap_time_ms, 92_345);
    assert_eq!(car.current_lap_time_ms, 31_002);
    assert_eq!(car.sector1_time.ms_part, 28_456);
    assert_eq!(car.sector1_time.minutes_part, 0);
    assert_eq!(car.sector1_time.total_ms, 28_456);
    assert_eq!(car.sector2_time.total_ms, 65_250);
    assert_eq!(car.delta_to_car_in_front.total_ms, 999);
    assert_eq!(car.delta_to_race_leader.total_ms, 121_500);
    assert_eq!(p.time_trial_pb_car_idx, 1);
    assert_eq!(p.time_trial_rival_car_idx, 255);
}

#[test]
fn lap_data_distances_position_and_lap_number_are_verbatim() {
    let mut l = lap(0);
    l.lap_distance = -12.5; // before the line: the spec says it can be negative
    l.total_distance = -12.5;
    l.sc_delta = 1.75;
    l.position = 7;
    l.lap = 3;
    l.grid = 9;
    l.sector = 2;
    l.trap = 312.4;
    l.trap_lap = 2;
    let car = lap_data::decode(&lap_packet(head(2, 0), l))
        .unwrap()
        .1
        .player
        .unwrap();
    assert_eq!(car.lap_distance_m, -12.5);
    assert_eq!(car.total_distance_m, -12.5);
    assert_eq!(car.safety_car_delta_s, 1.75);
    assert_eq!(car.car_position, 7);
    assert_eq!(car.current_lap_num, 3);
    assert_eq!(car.grid_position, 9);
    assert_eq!(car.sector, Sector::Sector3);
    assert_eq!(car.speed_trap_fastest_speed_kmh, 312.4);
    assert_eq!(car.speed_trap_fastest_lap, 2);
}

#[test]
fn lap_data_statuses() {
    for (pit, driver, result, timer) in [(0, 0, 0, 0), (1, 1, 2, 1), (2, 4, 7, 0), (3, 5, 8, 2)] {
        let mut l = lap(0);
        l.pit_status = pit;
        l.driver = driver;
        l.result = result;
        l.pit_timer = timer;
        l.pit_lane_ms = 12_345;
        l.pit_stop_ms = 2_400;
        l.pit_stops = 1;
        let car = lap_data::decode(&lap_packet(head(2, 0), l))
            .unwrap()
            .1
            .player
            .unwrap();
        assert_eq!(car.pit_status, PitStatus::from_raw(pit));
        assert_eq!(car.driver_status, DriverStatus::from_raw(driver));
        assert_eq!(car.result_status, ResultStatus::from_raw(result));
        assert_eq!(car.pit_lane_timer_active, PitLaneTimer::from_raw(timer));
        assert_eq!(car.pit_lane_time_in_lane_ms, 12_345);
        assert_eq!(car.pit_stop_timer_ms, 2_400);
        assert_eq!(car.num_pit_stops, 1);
    }
    assert_eq!(PitStatus::from_raw(2), PitStatus::InPitArea);
    assert_eq!(PitStatus::from_raw(3), PitStatus::Unknown(3));
    assert_eq!(DriverStatus::from_raw(1), DriverStatus::FlyingLap);
    assert_eq!(DriverStatus::from_raw(5), DriverStatus::Unknown(5));
    assert_eq!(ResultStatus::from_raw(7), ResultStatus::Retired);
    assert_eq!(ResultStatus::from_raw(8), ResultStatus::Unknown(8));
}

#[test]
fn lap_data_penalties_warnings_and_invalid_lap() {
    let mut l = lap(0);
    l.invalid = 1;
    l.penalties = 5;
    l.warnings = 3;
    l.cc_warnings = 2;
    l.dt = 1;
    l.sg = 2;
    l.serve = 1;
    let car = lap_data::decode(&lap_packet(head(2, 0), l))
        .unwrap()
        .1
        .player
        .unwrap();
    assert_eq!(car.current_lap_invalid, LapValidity::Invalid);
    assert_eq!(car.penalties_s, 5);
    assert_eq!(car.total_warnings, 3);
    assert_eq!(car.corner_cutting_warnings, 2);
    assert_eq!(car.num_unserved_drive_through_pens, 1);
    assert_eq!(car.num_unserved_stop_go_pens, 2);
    assert_eq!(car.pit_stop_should_serve_pen, 1);
    let mut valid = lap(0);
    valid.invalid = 0;
    let car = lap_data::decode(&lap_packet(head(2, 0), valid))
        .unwrap()
        .1
        .player
        .unwrap();
    assert_eq!(car.current_lap_invalid, LapValidity::Valid);
}

// ---------------------------------------------------------------- motion ex

/// Every float distinct: field `n` (0-based, spec order) holds `n + 0.5`.
fn motion_packet(h: Head) -> Vec<u8> {
    let mut w = header(h);
    for n in 0..61 {
        w.f32(n as f32 + 0.5);
    }
    assert_eq!(w.0.len(), 273);
    accepted(&w.0, PacketKind::MotionEx);
    w.0
}

fn wheels(first: usize) -> Wheels<f32> {
    let v = |i: usize| (first + i) as f32 + 0.5;
    Wheels {
        rear_left: v(0),
        rear_right: v(1),
        front_left: v(2),
        front_right: v(3),
    }
}

#[test]
fn motion_ex_every_field_in_spec_order() {
    let m = motion_ex::decode(&motion_packet(head(13, 0)))
        .unwrap()
        .1
        .player
        .unwrap();
    assert_eq!(m.suspension_position, wheels(0));
    assert_eq!(m.suspension_velocity, wheels(4));
    assert_eq!(m.suspension_acceleration, wheels(8));
    assert_eq!(m.wheel_speed, wheels(12));
    assert_eq!(m.wheel_slip_ratio, wheels(16));
    assert_eq!(m.wheel_slip_angle, wheels(20));
    assert_eq!(m.wheel_lat_force, wheels(24));
    assert_eq!(m.wheel_long_force, wheels(28));
    assert_eq!(m.height_of_cog_above_ground, 32.5);
    assert_eq!(
        (
            m.local_velocity_mps.x,
            m.local_velocity_mps.y,
            m.local_velocity_mps.z
        ),
        (33.5, 34.5, 35.5)
    );
    assert_eq!(
        (
            m.angular_velocity_rad_s.x,
            m.angular_velocity_rad_s.y,
            m.angular_velocity_rad_s.z
        ),
        (36.5, 37.5, 38.5)
    );
    assert_eq!(
        (
            m.angular_acceleration_rad_s2.x,
            m.angular_acceleration_rad_s2.y,
            m.angular_acceleration_rad_s2.z
        ),
        (39.5, 40.5, 41.5)
    );
    assert_eq!(m.front_wheels_angle_rad, 42.5);
    assert_eq!(m.wheel_vert_force, wheels(43));
    assert_eq!(m.front_aero_height, 47.5);
    assert_eq!(m.rear_aero_height, 48.5);
    assert_eq!(m.front_roll_angle, 49.5);
    assert_eq!(m.rear_roll_angle, 50.5);
    assert_eq!(m.chassis_yaw_rad, 51.5);
    assert_eq!(m.chassis_pitch_rad, 52.5);
    assert_eq!(m.wheel_camber_rad, wheels(53));
    assert_eq!(m.wheel_camber_gain_rad, wheels(57));
}

#[test]
fn motion_ex_does_not_depend_on_which_valid_player_index() {
    let a = motion_ex::decode(&motion_packet(head(13, 0))).unwrap().1;
    let b = motion_ex::decode(&motion_packet(head(13, 19))).unwrap().1;
    assert_eq!(a, b);
    assert!(a.player.is_some());
}

// -------------------------------------------------------------- aggregation

fn with(h: Head, f: impl FnOnce(&mut Head)) -> Head {
    let mut h = h;
    f(&mut h);
    h
}

fn feed(live: &mut F1Live, bytes: &[u8], now: Instant) {
    match classify(bytes) {
        Classification::Accepted { kind, header } => live.observe(kind, &header, bytes, now, 0),
        other => panic!("{other:?}"),
    }
}

#[test]
fn families_keep_their_own_freshness_and_frames() {
    let t0 = Instant::now();
    let mut live = F1Live::default();
    feed(
        &mut live,
        &telemetry_packet(with(head(6, 0), |h| h.overall = 500), tel(0), 255, 0),
        t0,
    );
    feed(
        &mut live,
        &status_packet(with(head(7, 0), |h| h.overall = 480), status(0)),
        t0 + Duration::from_millis(300),
    );
    let snap = live.snapshot(t0 + Duration::from_millis(1000));
    let tel = snap.car_telemetry.unwrap();
    let st = snap.car_status.unwrap();
    assert_eq!(tel.age_ms, 1000);
    assert_eq!(st.age_ms, 700);
    assert_eq!(tel.overall_frame_identifier, 500);
    assert_eq!(st.overall_frame_identifier, 480);
    assert_eq!(tel.packet_id, 6);
    assert!(snap.lap_data.is_none());
    assert!(snap.motion_ex.is_none());
    assert!(snap.player_available);
    assert_eq!(snap.session_uid.as_deref(), Some("16045690981097406465"));
}

#[test]
fn out_of_order_packets_never_replace_newer_ones() {
    let t0 = Instant::now();
    let mut live = F1Live::default();
    let mut newer = tel(0);
    newer.speed = 250;
    let mut older = tel(0);
    older.speed = 120;
    feed(
        &mut live,
        &telemetry_packet(with(head(6, 0), |h| h.overall = 900), newer, 255, 0),
        t0,
    );
    feed(
        &mut live,
        &telemetry_packet(with(head(6, 0), |h| h.overall = 899), older, 255, 0),
        t0,
    );
    let snap = live.snapshot(t0);
    assert_eq!(
        snap.car_telemetry.unwrap().value.player.unwrap().speed_kmh,
        250
    );
    assert_eq!(snap.out_of_order_dropped, 1);
    // Another family arriving "late" is independent: it is accepted.
    feed(
        &mut live,
        &status_packet(with(head(7, 0), |h| h.overall = 10), status(0)),
        t0,
    );
    assert!(live.snapshot(t0).car_status.is_some());
    // A flashback rewinds frameIdentifier but not overallFrameIdentifier.
    let mut rewound = tel(0);
    rewound.speed = 90;
    feed(
        &mut live,
        &telemetry_packet(
            with(head(6, 0), |h| {
                h.frame = 5;
                h.overall = 901
            }),
            rewound,
            255,
            0,
        ),
        t0,
    );
    let tel_now = live.snapshot(t0).car_telemetry.unwrap();
    assert_eq!(tel_now.value.player.unwrap().speed_kmh, 90);
    assert_eq!(tel_now.frame_identifier, 5);
}

#[test]
fn a_new_session_clears_everything() {
    let t0 = Instant::now();
    let mut live = F1Live::default();
    feed(&mut live, &telemetry_packet(head(6, 0), tel(0), 255, 0), t0);
    feed(&mut live, &status_packet(head(7, 0), status(0)), t0);
    feed(&mut live, &lap_packet(head(2, 0), lap(0)), t0);
    feed(&mut live, &motion_packet(head(13, 0)), t0);
    let new_session = |h: Head| with(h, |h| h.uid = 42);
    // Any accepted packet type announces the new session, even an
    // undecoded one such as Session (ID 1, 753 bytes).
    let mut session_packet = header(new_session(head(1, 0))).0;
    session_packet.resize(753, 0);
    feed(&mut live, &session_packet, t0);
    let snap = live.snapshot(t0);
    assert_eq!(snap.session_resets, 1);
    assert_eq!(snap.session_uid.as_deref(), Some("42"));
    assert!(snap.car_telemetry.is_none());
    assert!(snap.car_status.is_none());
    assert!(snap.lap_data.is_none());
    assert!(snap.motion_ex.is_none());
    // A new session restarts frame numbering; a low frame is not "old".
    feed(
        &mut live,
        &telemetry_packet(
            with(new_session(head(6, 0)), |h| h.overall = 1),
            tel(0),
            255,
            0,
        ),
        t0,
    );
    assert!(live.snapshot(t0).car_telemetry.is_some());
}

#[test]
fn a_player_index_change_resets_player_data() {
    let t0 = Instant::now();
    let mut live = F1Live::default();
    feed(&mut live, &telemetry_packet(head(6, 0), tel(0), 255, 0), t0);
    feed(&mut live, &lap_packet(head(2, 0), lap(0)), t0);
    feed(&mut live, &status_packet(head(7, 4), status(0)), t0);
    let snap = live.snapshot(t0);
    assert_eq!(snap.player_resets, 1);
    assert_eq!(snap.session_resets, 0);
    assert_eq!(snap.player_car_index, Some(4));
    assert!(snap.car_telemetry.is_none());
    assert!(snap.lap_data.is_none());
    assert!(snap.car_status.is_some());
    // Spectating: index 255 is held, and nothing is shown as player data.
    feed(
        &mut live,
        &telemetry_packet(head(6, 255), tel(0), 255, 0),
        t0,
    );
    let spectating = live.snapshot(t0);
    assert!(!spectating.player_available);
    assert_eq!(spectating.player_resets, 2);
    assert!(spectating.car_telemetry.unwrap().value.player.is_none());
}

#[test]
fn aggregation_holds_one_packet_per_family_whatever_arrives() {
    let t0 = Instant::now();
    let mut evidence = F1Evidence::new(t0);
    let baseline = std::mem::size_of_val(&evidence);
    for i in 0..5_000u32 {
        let h = with(head(6, 0), |h| h.overall = i);
        evidence.observe(&telemetry_packet(h, tel(0), 255, 0), t0, 0);
        let h = with(head(13, 0), |h| h.overall = i);
        evidence.observe(&motion_packet(h), t0, 0);
    }
    assert_eq!(std::mem::size_of_val(&evidence), baseline);
    let raw = evidence.raw_latest(t0);
    assert_eq!(raw.len(), 2);
    let live = evidence.live(t0);
    assert_eq!(live.car_telemetry.unwrap().overall_frame_identifier, 4_999);
    // Rejected datagrams never reach the aggregate.
    let mut short = telemetry_packet(head(6, 0), tel(0), 255, 0);
    short.pop();
    let mut fresh = F1Evidence::new(t0);
    fresh.observe(&short, t0, 0);
    assert!(fresh.live(t0).car_telemetry.is_none());
    assert!(fresh.live(t0).session_uid.is_none());
}
