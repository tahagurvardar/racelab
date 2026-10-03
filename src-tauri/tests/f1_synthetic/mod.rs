//! Synthetic F1 25 datagrams, written field by field in the order of the
//! official "Data Output from F1 25 Game" v3 structs.
//!
//! These writers know nothing of RaceLab's decoder offsets: each one appends
//! fields in specification order and the packet's size is asserted against
//! the specification's. A decoder that skips, reorders or mistypes a field
//! therefore fails against them. They are SYNTHETIC: never captured from a
//! game, and never to be described as such.
#![allow(dead_code)]

pub const SIZES: [(u8, usize); 16] = [
    (0, 1349),
    (1, 753),
    (2, 1285),
    (3, 45),
    (4, 1284),
    (5, 1133),
    (6, 1352),
    (7, 1239),
    (8, 1042),
    (9, 954),
    (10, 1041),
    (11, 1460),
    (12, 231),
    (13, 273),
    (14, 101),
    (15, 1131),
];

pub fn spec_size(id: u8) -> usize {
    SIZES[usize::from(id)].1
}

#[derive(Default)]
pub struct W(pub Vec<u8>);

impl W {
    pub fn u8(&mut self, v: u8) -> &mut Self {
        self.0.push(v);
        self
    }
    pub fn i8(&mut self, v: i8) -> &mut Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    pub fn u16(&mut self, v: u16) -> &mut Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    pub fn i16(&mut self, v: i16) -> &mut Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    pub fn u32(&mut self, v: u32) -> &mut Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    pub fn u64(&mut self, v: u64) -> &mut Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    pub fn f32(&mut self, v: f32) -> &mut Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    pub fn f64(&mut self, v: f64) -> &mut Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    pub fn bytes(&mut self, v: &[u8]) -> &mut Self {
        self.0.extend_from_slice(v);
        self
    }
    pub fn zeros(&mut self, n: usize) -> &mut Self {
        self.0.resize(self.0.len() + n, 0);
        self
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Head {
    pub id: u8,
    pub uid: u64,
    pub session_time: f32,
    pub frame: u32,
    pub overall: u32,
    pub player: u8,
}

impl Head {
    pub fn new(id: u8, uid: u64, frame: u32, player: u8) -> Self {
        Self {
            id,
            uid,
            session_time: frame as f32 / 20.0,
            frame,
            overall: frame,
            player,
        }
    }
}

/// `PacketHeader`, 29 bytes.
pub fn header(h: Head) -> W {
    let mut w = W::default();
    w.u16(2025)
        .u8(25)
        .u8(1)
        .u8(26)
        .u8(1)
        .u8(h.id)
        .u64(h.uid)
        .f32(h.session_time)
        .u32(h.frame)
        .u32(h.overall)
        .u8(h.player)
        .u8(255);
    assert_eq!(w.0.len(), 29);
    w
}

fn done(w: W, id: u8) -> Vec<u8> {
    assert_eq!(
        w.0.len(),
        spec_size(id),
        "packet {id} is not its specification size"
    );
    w.0
}

// ---------------------------------------------------------------- session

#[derive(Clone, Copy, Debug)]
pub struct SessionSpec {
    pub weather: u8,
    pub track_temperature: i8,
    pub air_temperature: i8,
    pub total_laps: u8,
    pub track_length: u16,
    pub session_type: u8,
    pub track_id: i8,
    pub formula: u8,
    pub time_left: u16,
    pub duration: u16,
    pub pit_speed_limit: u8,
    pub game_paused: u8,
    pub is_spectating: u8,
    pub num_marshal_zones: u8,
    pub safety_car_status: u8,
    pub network_game: u8,
    pub num_forecast: u8,
    pub game_mode: u8,
    pub rule_set: u8,
    pub num_weekend: u8,
}

impl Default for SessionSpec {
    fn default() -> Self {
        Self {
            weather: 1,
            track_temperature: 31,
            air_temperature: 24,
            total_laps: 5,
            track_length: 5412,
            session_type: 15,
            track_id: 7,
            formula: 0,
            time_left: 3540,
            duration: 3600,
            pit_speed_limit: 80,
            game_paused: 0,
            is_spectating: 0,
            num_marshal_zones: 3,
            safety_car_status: 0,
            network_game: 0,
            num_forecast: 2,
            game_mode: 4,
            rule_set: 1,
            num_weekend: 2,
        }
    }
}

/// `PacketSessionData`, 753 bytes.
pub fn session(h: Head, s: SessionSpec) -> Vec<u8> {
    let mut w = header(Head { id: 1, ..h });
    w.u8(s.weather)
        .i8(s.track_temperature)
        .i8(s.air_temperature)
        .u8(s.total_laps)
        .u16(s.track_length)
        .u8(s.session_type)
        .i8(s.track_id)
        .u8(s.formula)
        .u16(s.time_left)
        .u16(s.duration)
        .u8(s.pit_speed_limit)
        .u8(s.game_paused)
        .u8(s.is_spectating)
        .u8(11) // spectator car index
        .u8(0) // SLI Pro
        .u8(s.num_marshal_zones);
    for zone in 0..21u8 {
        w.f32(f32::from(zone) / 21.0).i8((zone % 5) as i8 - 1);
    }
    w.u8(s.safety_car_status)
        .u8(s.network_game)
        .u8(s.num_forecast);
    for sample in 0..64u8 {
        w.u8(s.session_type)
            .u8(sample.wrapping_mul(5))
            .u8(sample % 6)
            .i8(30 + sample as i8 % 3)
            .i8(2)
            .i8(20 + sample as i8 % 4)
            .i8(1)
            .u8(sample.min(100));
    }
    w.u8(1) // forecast accuracy
        .u8(95) // AI difficulty
        .u32(0xA1)
        .u32(0xB2)
        .u32(0xC3)
        .u8(18)
        .u8(22)
        .u8(9);
    // steering, braking, gearbox, pit, pit release, ERS, DRS assists
    w.u8(0).u8(1).u8(3).u8(0).u8(1).u8(0).u8(1);
    w.u8(2) // dynamic racing line
        .u8(1) // type
        .u8(s.game_mode)
        .u8(s.rule_set)
        .u32(845) // time of day
        .u8(4); // session length
                // speed/temperature units, lead then secondary
    w.u8(1).u8(0).u8(1).u8(0);
    w.u8(1).u8(2).u8(0); // SC, VSC, red flag periods
                         // equal car performance .. affects licence level MP: 24 uint8 settings
    for setting in 0..24u8 {
        w.u8(setting % 3);
    }
    w.u8(s.num_weekend);
    w.bytes(&[1, 2, 3, 5, 6, 7, 10, 11, 12, 13, 15, 0]);
    w.f32(1800.5).f32(3600.25);
    done(w, 1)
}

// ------------------------------------------------------------------ event

/// `PacketEventData`, 45 bytes: code, then the 12-byte union.
pub fn event(h: Head, code: &[u8; 4], details: &[u8]) -> Vec<u8> {
    assert!(details.len() <= 12);
    let mut w = header(Head { id: 3, ..h });
    w.bytes(code).bytes(details).zeros(12 - details.len());
    done(w, 3)
}

pub fn penalty_details(
    penalty_type: u8,
    infringement: u8,
    vehicle: u8,
    other: u8,
    time: u8,
    lap: u8,
    places: u8,
) -> Vec<u8> {
    vec![
        penalty_type,
        infringement,
        vehicle,
        other,
        time,
        lap,
        places,
    ]
}

pub fn speed_trap_details(
    vehicle: u8,
    speed: f32,
    overall: u8,
    driver: u8,
    fastest: u8,
    fastest_speed: f32,
) -> Vec<u8> {
    let mut w = W::default();
    w.u8(vehicle)
        .f32(speed)
        .u8(overall)
        .u8(driver)
        .u8(fastest)
        .f32(fastest_speed);
    assert_eq!(w.0.len(), 12);
    w.0
}

// ---------------------------------------------------------- participants

#[derive(Clone, Debug)]
pub struct ParticipantSpec {
    pub ai_controlled: u8,
    pub driver_id: u8,
    pub network_id: u8,
    pub team_id: u8,
    pub my_team: u8,
    pub race_number: u8,
    pub nationality: u8,
    pub name: String,
    pub platform: u8,
}

pub fn participant_for(car: u8) -> ParticipantSpec {
    ParticipantSpec {
        ai_controlled: u8::from(car != 0),
        driver_id: 100 + car,
        network_id: 200 + car,
        team_id: car % 10,
        my_team: 0,
        race_number: 10 + car,
        nationality: 1 + car,
        name: format!("Driver {car}"),
        platform: 1,
    }
}

/// `PacketParticipantsData`, 1284 bytes.
pub fn participants(h: Head, active: u8, cars: &[ParticipantSpec; 22]) -> Vec<u8> {
    let mut w = header(Head { id: 4, ..h });
    w.u8(active);
    for car in cars {
        let mut name = [0u8; 32];
        let bytes = car.name.as_bytes();
        name[..bytes.len().min(31)].copy_from_slice(&bytes[..bytes.len().min(31)]);
        w.u8(car.ai_controlled)
            .u8(car.driver_id)
            .u8(car.network_id)
            .u8(car.team_id)
            .u8(car.my_team)
            .u8(car.race_number)
            .u8(car.nationality)
            .bytes(&name)
            .u8(0) // your telemetry
            .u8(1) // show online names
            .u16(1234) // tech level
            .u8(car.platform)
            .u8(2); // num colours
        for colour in 0..4u8 {
            w.u8(colour).u8(colour + 10).u8(colour + 20);
        }
    }
    done(w, 4)
}

// -------------------------------------------------- final classification

#[derive(Clone, Debug)]
pub struct ClassificationSpec {
    pub position: u8,
    pub num_laps: u8,
    pub grid: u8,
    pub points: u8,
    pub pit_stops: u8,
    pub result_status: u8,
    pub result_reason: u8,
    pub best_lap_ms: u32,
    pub total_time_s: f64,
    pub penalties_s: u8,
    pub num_penalties: u8,
    pub stints: Vec<(u8, u8, u8)>,
}

pub fn classification_for(car: u8) -> ClassificationSpec {
    ClassificationSpec {
        position: car + 1,
        num_laps: 5,
        grid: 22 - car,
        points: 10_u8.saturating_sub(car),
        pit_stops: 1,
        result_status: 3,
        result_reason: 2,
        best_lap_ms: 90_000 + u32::from(car) * 100,
        total_time_s: 455.125 + f64::from(car),
        penalties_s: 0,
        num_penalties: 0,
        stints: vec![(16, 16, 3), (17, 17, 5)],
    }
}

/// `PacketFinalClassificationData`, 1042 bytes.
pub fn final_classification(h: Head, num_cars: u8, cars: &[ClassificationSpec; 22]) -> Vec<u8> {
    let mut w = header(Head { id: 8, ..h });
    w.u8(num_cars);
    for car in cars {
        w.u8(car.position)
            .u8(car.num_laps)
            .u8(car.grid)
            .u8(car.points)
            .u8(car.pit_stops)
            .u8(car.result_status)
            .u8(car.result_reason)
            .u32(car.best_lap_ms)
            .f64(car.total_time_s)
            .u8(car.penalties_s)
            .u8(car.num_penalties)
            .u8(car.stints.len() as u8);
        let mut actual = [0u8; 8];
        let mut visual = [0u8; 8];
        let mut end = [0u8; 8];
        for (index, &(a, v, e)) in car.stints.iter().enumerate().take(8) {
            actual[index] = a;
            visual[index] = v;
            end[index] = e;
        }
        w.bytes(&actual).bytes(&visual).bytes(&end);
    }
    done(w, 8)
}

// ------------------------------------------------------------ car damage

/// `PacketCarDamageData`, 1041 bytes. `seed` makes each car distinct.
pub fn car_damage(h: Head, seed_for: impl Fn(u8) -> u8) -> Vec<u8> {
    let mut w = header(Head { id: 10, ..h });
    for car in 0..22u8 {
        let s = seed_for(car);
        for wheel in 0..4u8 {
            w.f32(f32::from(s) + f32::from(wheel) / 4.0); // tyre wear, RL RR FL FR
        }
        for wheel in 0..4u8 {
            w.u8(s + wheel); // tyre damage
        }
        for wheel in 0..4u8 {
            w.u8(s + 10 + wheel); // brakes damage
        }
        for wheel in 0..4u8 {
            w.u8(s + 20 + wheel); // tyre blisters
        }
        // FL wing, FR wing, rear wing, floor, diffuser, sidepod
        for part in 0..6u8 {
            w.u8(s + 30 + part);
        }
        w.u8(0).u8(1); // DRS fault, ERS fault
        w.u8(s + 40).u8(s + 41); // gearbox, engine damage
        for part in 0..6u8 {
            w.u8(s + 50 + part); // MGU-H, ES, CE, ICE, MGU-K, TC wear
        }
        w.u8(0).u8(0); // engine blown, seized
    }
    done(w, 10)
}

// -------------------------------------------------------- session history

#[derive(Clone, Copy, Debug)]
pub struct HistoryLap {
    pub lap_ms: u32,
    pub s1: (u16, u8),
    pub s2: (u16, u8),
    pub s3: (u16, u8),
    pub flags: u8,
}

pub fn history_lap(lap_ms: u32, flags: u8) -> HistoryLap {
    HistoryLap {
        lap_ms,
        s1: (30_100, 0),
        s2: (31_200, 0),
        s3: ((lap_ms.saturating_sub(61_300) % 60_000) as u16, 0),
        flags,
    }
}

/// `PacketSessionHistoryData`, 1460 bytes.
pub fn session_history(
    h: Head,
    car: u8,
    laps: &[HistoryLap],
    stints: &[(u8, u8, u8)],
    best: (u8, u8, u8, u8),
) -> Vec<u8> {
    let mut w = header(Head { id: 11, ..h });
    w.u8(car)
        .u8(laps.len() as u8)
        .u8(stints.len() as u8)
        .u8(best.0)
        .u8(best.1)
        .u8(best.2)
        .u8(best.3);
    for index in 0..100 {
        match laps.get(index) {
            Some(lap) => {
                w.u32(lap.lap_ms)
                    .u16(lap.s1.0)
                    .u8(lap.s1.1)
                    .u16(lap.s2.0)
                    .u8(lap.s2.1)
                    .u16(lap.s3.0)
                    .u8(lap.s3.1)
                    .u8(lap.flags);
            }
            None => {
                w.zeros(14);
            }
        }
    }
    for index in 0..8 {
        let (end, actual, visual) = stints.get(index).copied().unwrap_or((0, 0, 0));
        w.u8(end).u8(actual).u8(visual);
    }
    done(w, 11)
}

// -------------------------------------------------------------- tyre sets

/// `PacketTyreSetsData`, 231 bytes.
pub fn tyre_sets(h: Head, car: u8, fitted: u8) -> Vec<u8> {
    let mut w = header(Head { id: 12, ..h });
    w.u8(car);
    for set in 0..20u8 {
        let wet = set >= 13;
        w.u8(if wet { 7 } else { 16 + set % 3 })
            .u8(if wet { 7 } else { 16 + set % 3 })
            .u8(set * 3)
            .u8(u8::from(set % 4 != 0))
            .u8(set % 19)
            .u8(20 - set)
            .u8(25)
            .i16(i16::from(set) * -100 + 300)
            .u8(u8::from(set == fitted));
    }
    w.u8(fitted);
    done(w, 12)
}

// ------------------------------------------------------------- time trial

#[derive(Clone, Copy, Debug)]
pub struct TimeTrialSpec {
    pub car: u8,
    pub team: u8,
    pub lap_ms: u32,
    pub sectors: [u32; 3],
    pub valid: u8,
}

/// `PacketTimeTrialData`, 101 bytes.
pub fn time_trial(h: Head, sets: [TimeTrialSpec; 3]) -> Vec<u8> {
    let mut w = header(Head { id: 14, ..h });
    for set in sets {
        w.u8(set.car)
            .u8(set.team)
            .u32(set.lap_ms)
            .u32(set.sectors[0])
            .u32(set.sectors[1])
            .u32(set.sectors[2])
            .u8(1)
            .u8(0)
            .u8(1)
            .u8(0)
            .u8(1)
            .u8(set.valid);
    }
    done(w, 14)
}

// ---------------------------------------------------------- lap positions

/// `PacketLapPositionsData`, 1131 bytes. `position(row, car)`.
pub fn lap_positions(
    h: Head,
    num_laps: u8,
    lap_start: u8,
    position: impl Fn(usize, usize) -> u8,
) -> Vec<u8> {
    let mut w = header(Head { id: 15, ..h });
    w.u8(num_laps).u8(lap_start);
    for row in 0..50 {
        for car in 0..22 {
            w.u8(position(row, car));
        }
    }
    done(w, 15)
}

// ---------------------------------------------- the Phase B families, terse

#[derive(Clone, Copy, Debug)]
pub struct LapSpec {
    pub last_lap_ms: u32,
    pub current_lap_ms: u32,
    pub s1_ms: u16,
    pub s2_ms: u16,
    pub lap_distance: f32,
    pub position: u8,
    pub lap_num: u8,
    pub sector: u8,
    pub invalid: u8,
}

impl Default for LapSpec {
    fn default() -> Self {
        Self {
            last_lap_ms: 0,
            current_lap_ms: 1_000,
            s1_ms: 0,
            s2_ms: 0,
            lap_distance: 10.0,
            position: 3,
            lap_num: 1,
            sector: 0,
            invalid: 0,
        }
    }
}

/// `PacketLapData`, 1285 bytes; every car gets `spec`.
pub fn lap_data(h: Head, spec: LapSpec) -> Vec<u8> {
    let mut w = header(Head { id: 2, ..h });
    for _ in 0..22 {
        w.u32(spec.last_lap_ms)
            .u32(spec.current_lap_ms)
            .u16(spec.s1_ms)
            .u8(0)
            .u16(spec.s2_ms)
            .u8(0)
            .u16(500)
            .u8(0)
            .u16(1500)
            .u8(0)
            .f32(spec.lap_distance)
            .f32(spec.lap_distance + 1000.0)
            .f32(0.0)
            .u8(spec.position)
            .u8(spec.lap_num)
            .u8(0) // pit status
            .u8(0) // pit stops
            .u8(spec.sector)
            .u8(spec.invalid)
            .u8(0) // penalties
            .u8(0)
            .u8(0)
            .u8(0)
            .u8(0)
            .u8(5) // grid
            .u8(4) // driver status: on track
            .u8(2) // result status: active
            .u8(0)
            .u16(0)
            .u16(0)
            .u8(0)
            .f32(301.5)
            .u8(255);
    }
    w.u8(255).u8(255);
    done(w, 2)
}

/// `PacketCarTelemetryData`, 1352 bytes; every car the same.
pub fn car_telemetry(h: Head, speed: u16, throttle: f32, brake: f32) -> Vec<u8> {
    let mut w = header(Head { id: 6, ..h });
    for _ in 0..22 {
        w.u16(speed)
            .f32(throttle)
            .f32(0.1)
            .f32(brake)
            .u8(0)
            .i8(6)
            .u16(10_500)
            .u8(0)
            .u8(40)
            .u16(0x00ff);
        for t in [500u16, 510, 600, 610] {
            w.u16(t);
        }
        w.bytes(&[90, 91, 92, 93]).bytes(&[95, 96, 97, 98]).u16(105);
        for p in [21.5f32, 21.6, 24.1, 24.2] {
            w.f32(p);
        }
        w.bytes(&[0, 0, 1, 0]);
    }
    w.u8(255).u8(255).i8(0);
    done(w, 6)
}

/// `PacketCarStatusData`, 1239 bytes; every car the same.
pub fn car_status(h: Head, fuel: f32) -> Vec<u8> {
    let mut w = header(Head { id: 7, ..h });
    for _ in 0..22 {
        w.u8(1)
            .u8(0)
            .u8(1)
            .u8(56)
            .u8(0)
            .f32(fuel)
            .f32(110.0)
            .f32(3.5)
            .u16(13_000)
            .u16(4_000)
            .u8(8)
            .u8(1)
            .u16(0)
            .u8(18)
            .u8(17)
            .u8(4)
            .i8(1)
            .f32(500_000.0)
            .f32(120_000.0)
            .f32(3_000_000.0)
            .u8(1)
            .f32(1.0)
            .f32(2.0)
            .f32(3.0)
            .u8(0);
    }
    done(w, 7)
}

/// `PacketMotionExData`, 273 bytes: 61 floats, all distinct.
pub fn motion_ex(h: Head) -> Vec<u8> {
    let mut w = header(Head { id: 13, ..h });
    for value in 0..61 {
        w.f32(value as f32 * 0.5);
    }
    done(w, 13)
}
