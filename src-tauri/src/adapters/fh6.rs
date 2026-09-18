//! User-supplied FH6 324-byte Car Dash contract, little endian. Unknown bytes
//! remain opaque. No changes to transport and no inference from packet size alone.
use crate::telemetry::{Controls, Engine, Gear, TelemetryFrame, Vector3};
use serde::Serialize;

pub const PACKET_SIZE: usize = 324;
/// A deliberately explicit validation policy, not a protocol constant.
pub const SPEED_TOLERANCE_MPS: f64 = 0.001;
pub const RPM_ABSOLUTE_LIMIT: f32 = 30_000.0;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Issue {
    pub field: String,
    pub offset: usize,
    pub reason: String,
}
impl Issue {
    pub fn new(field: &str, offset: usize, reason: impl Into<String>) -> Self {
        Self {
            field: field.into(),
            offset,
            reason: reason.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Fh6Raw {
    pub is_race_on: i32,
    pub timestamp_ms: u32,
    pub car_ordinal: i32,
    pub car_class: i32,
    pub car_performance_index: i32,
    pub drivetrain_type: i32,
    pub num_cylinders: i32,
    /// Not interpreted in V0.4. Vec has fixed length 144 after decoding.
    pub unimplemented_68_211: Vec<u8>,
    pub horizon_unknown_232_243: [u8; 12],
    pub power: f32,
    pub torque: f32,
    /// Ordered by offsets 268,272,276,280. Wheel identities/units not asserted.
    pub tire_temperatures: [f32; 4],
    pub boost: f32,
    pub fuel: f32,
    pub distance_traveled: f32,
    pub best_lap: f32,
    pub last_lap: f32,
    pub current_lap: f32,
    pub current_race_time: f32,
    pub lap_number: u16,
    pub race_position: u8,
    pub throttle: u8,
    pub brake: u8,
    pub clutch: u8,
    pub handbrake: u8,
    pub gear: u8,
    pub steering: i8,
    pub unknown_321_323: [u8; 3],
}

#[derive(Debug, Clone, Serialize)]
pub struct DecodedFrame {
    pub frame: TelemetryFrame,
    pub fh6: Fh6Raw,
}

// Public table also drives independent fixture verification. Only explicitly
// requested float fields are decoded; do not interpret floats in unknown regions.
pub const FLOAT_FIELDS: &[(&str, usize)] = &[
    ("engine_max_rpm", 8),
    ("engine_idle_rpm", 12),
    ("current_engine_rpm", 16),
    ("acceleration_x", 20),
    ("acceleration_y", 24),
    ("acceleration_z", 28),
    ("velocity_x", 32),
    ("velocity_y", 36),
    ("velocity_z", 40),
    ("angular_velocity_x", 44),
    ("angular_velocity_y", 48),
    ("angular_velocity_z", 52),
    ("yaw", 56),
    ("pitch", 60),
    ("roll", 64),
    ("position_x", 244),
    ("position_y", 248),
    ("position_z", 252),
    ("speed", 256),
    ("power", 260),
    ("torque", 264),
    ("tire_temperature_0", 268),
    ("tire_temperature_1", 272),
    ("tire_temperature_2", 276),
    ("tire_temperature_3", 280),
    ("boost", 284),
    ("fuel", 288),
    ("distance_traveled", 292),
    ("best_lap", 296),
    ("last_lap", 300),
    ("current_lap", 304),
    ("current_race_time", 308),
];

pub fn decode(bytes: &[u8]) -> Result<DecodedFrame, Vec<Issue>> {
    let p: &[u8; PACKET_SIZE] = bytes.try_into().map_err(|_| {
        vec![Issue::new(
            "packet_size",
            0,
            format!("Expected 324 bytes, received {}", bytes.len()),
        )]
    })?;
    let f = |o| f32::from_le_bytes(p[o..o + 4].try_into().expect("constant checked offset"));
    let i = |o| i32::from_le_bytes(p[o..o + 4].try_into().expect("constant checked offset"));
    let u = |o| u32::from_le_bytes(p[o..o + 4].try_into().expect("constant checked offset"));
    let v = |o| Vector3 {
        x: f(o),
        y: f(o + 4),
        z: f(o + 8),
    };
    let mut issues = Vec::new();
    for &(name, offset) in FLOAT_FIELDS {
        if !f(offset).is_finite() {
            issues.push(Issue::new(
                name,
                offset,
                format!("Non-finite f32 bits 0x{:08x}", u(offset)),
            ));
        }
    }
    if !matches!(i(0), 0 | 1) {
        issues.push(Issue::new(
            "is_race_on",
            0,
            format!("Expected 0 or 1, received {}", i(0)),
        ));
    }
    if p[320] as i8 == -128 {
        issues.push(Issue::new("steering", 320, "-128 is outside -127..127"));
    }
    if !issues.is_empty() {
        return Err(issues);
    }
    let raw = Fh6Raw {
        is_race_on: i(0),
        timestamp_ms: u(4),
        car_ordinal: i(212),
        car_class: i(216),
        car_performance_index: i(220),
        drivetrain_type: i(224),
        num_cylinders: i(228),
        unimplemented_68_211: p[68..212].to_vec(),
        horizon_unknown_232_243: p[232..244].try_into().unwrap(),
        power: f(260),
        torque: f(264),
        tire_temperatures: [f(268), f(272), f(276), f(280)],
        boost: f(284),
        fuel: f(288),
        distance_traveled: f(292),
        best_lap: f(296),
        last_lap: f(300),
        current_lap: f(304),
        current_race_time: f(308),
        lap_number: u16::from_le_bytes(p[312..314].try_into().unwrap()),
        race_position: p[314],
        throttle: p[315],
        brake: p[316],
        clutch: p[317],
        handbrake: p[318],
        gear: p[319],
        steering: p[320] as i8,
        unknown_321_323: p[321..324].try_into().unwrap(),
    };
    let frame = if raw.is_race_on == 0 {
        // Time remains available for ordering; every dynamic canonical value is zero/unknown.
        TelemetryFrame {
            game_timestamp_ms: u64::from(raw.timestamp_ms),
            ..TelemetryFrame::default()
        }
    } else {
        TelemetryFrame {
            active: true,
            game_timestamp_ms: u64::from(raw.timestamp_ms),
            engine: Engine {
                rpm: f(16),
                idle_rpm: f(12),
                max_rpm: f(8),
            },
            acceleration: v(20),
            velocity: v(32),
            angular_velocity: v(44),
            orientation: v(56),
            position: v(244),
            speed_mps: f(256),
            controls: Controls {
                throttle: f32::from(p[315]) / 255.0,
                brake: f32::from(p[316]) / 255.0,
                clutch: f32::from(p[317]) / 255.0,
                handbrake: f32::from(p[318]) / 255.0,
                steering: f32::from(p[320] as i8) / 127.0,
            },
            gear: Gear::Unmapped(u16::from(p[319])),
        }
    };
    Ok(DecodedFrame { frame, fh6: raw })
}

pub fn physical_issues(frame: &TelemetryFrame) -> Vec<Issue> {
    let mut issues = Vec::new();
    if !frame.active {
        return issues;
    }
    let error = (f64::from(frame.speed_mps) - frame.velocity.magnitude()).abs();
    if frame.speed_mps < 0.0 || error > SPEED_TOLERANCE_MPS {
        issues.push(Issue::new(
            "speed",
            256,
            format!("Speed/velocity discrepancy {error:.9} m/s (tolerance {SPEED_TOLERANCE_MPS})"),
        ));
    }
    let e = frame.engine;
    if e.max_rpm <= 0.0 || e.max_rpm > RPM_ABSOLUTE_LIMIT {
        issues.push(Issue::new(
            "engine_max_rpm",
            8,
            "Expected 0 < max RPM <= 30000",
        ));
    }
    if e.idle_rpm < 0.0 || e.idle_rpm > e.max_rpm {
        issues.push(Issue::new(
            "engine_idle_rpm",
            12,
            "Idle RPM outside 0..max RPM",
        ));
    }
    if e.rpm < 0.0 || e.rpm > (e.max_rpm * 1.1).min(RPM_ABSOLUTE_LIMIT) {
        issues.push(Issue::new(
            "current_engine_rpm",
            16,
            "RPM outside 0..min(max RPM * 1.1, 30000)",
        ));
    }
    issues
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TimestampEvent {
    Initial,
    Ordered,
    Wrap,
    InactiveReset,
    ExplicitReset,
    Regression,
}

#[derive(Default)]
pub struct TimestampValidator {
    previous: Option<(u32, bool)>,
}
impl TimestampValidator {
    /// An explicit reset must come from a caller's documented session boundary.
    /// Do not infer one from car changes, packet loss or arbitrary backward jumps.
    pub fn observe(
        &mut self,
        timestamp: u32,
        active: bool,
        explicit_reset: bool,
    ) -> TimestampEvent {
        let event = match self.previous {
            None => TimestampEvent::Initial,
            Some(_) if explicit_reset => TimestampEvent::ExplicitReset,
            Some((previous, _)) if timestamp >= previous => TimestampEvent::Ordered,
            Some((previous, _)) if previous >= u32::MAX - 60_000 && timestamp <= 60_000 => {
                TimestampEvent::Wrap
            }
            Some((_, was_active)) if was_active != active => TimestampEvent::InactiveReset,
            Some(_) => TimestampEvent::Regression,
        };
        // A bad jump never resets the baseline, so subsequent bad packets cannot
        // silently turn into an apparently valid new epoch.
        if event != TimestampEvent::Regression {
            self.previous = Some((timestamp, active));
        }
        event
    }
}
