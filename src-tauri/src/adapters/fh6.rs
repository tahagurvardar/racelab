//! User-supplied FH6 324-byte Car Dash contract, little endian. Unknown bytes
//! remain opaque. No changes to transport and no inference from packet size alone.
//!
//! This module is the only place in RaceLab that knows an FH6 byte offset, an
//! FH6 unit or the FH6 wheel order. Everything downstream consumes
//! `telemetry::TelemetryFrame`.
use crate::telemetry::{
    Controls, Engine, Race, TelemetryFrame, Vector3, Vehicle, Wheel, WheelPosition, Wheels,
};
use serde::Serialize;

pub const PACKET_SIZE: usize = 324;
/// A deliberately explicit validation policy, not a protocol constant.
pub const SPEED_TOLERANCE_MPS: f64 = 0.001;
pub const RPM_ABSOLUTE_LIMIT: f32 = 30_000.0;

// --------------------------------------------------------------------------
// Wheel order
// --------------------------------------------------------------------------

/// **The** FH6 wheel mapping. Source wheel-block index `i` (every per-wheel
/// block is four consecutive f32 at `base + 4 * i`) maps to `WHEEL_ORDER[i]`.
/// Nothing else in RaceLab may reorder wheels; the frontend reads named
/// corners, never an index.
///
/// Evidence (docs/V0.8-VALIDATION.md), from 14,237 real FH6 active packets:
/// - `{0,1}` and `{2,3}` are separate axles: distinct effective rolling radii
///   (0.3247 m vs 0.3232 m) and distinct suspension travel ranges (58.9 mm vs
///   51.9 mm, from exact affine fits with r = 1.000000).
/// - `{2,3}` compress under forward acceleration and `{0,1}` under
///   deceleration, so `{0,1}` is the front axle. Forward is established from
///   the known throttle/brake inputs; "compression" is established from
///   free-fall frames where all four travels collapse toward 0.
/// - `{0,2}` are one side and `{1,3}` the other: lateral load transfer splits
///   them at correlation +0.50/+0.49 against -0.53/-0.52.
/// - Which side is *left* is a parity choice and is provably not derivable
///   from kinematics. That single bit comes from the documented Forza Data Out
///   per-wheel field order (FrontLeft, FrontRight, RearLeft, RearRight), whose
///   every other prediction the captures independently confirm. It is
///   confirmed in-game by the V0.8 manual acceptance procedure.
pub const WHEEL_ORDER: [WheelPosition; 4] = [
    WheelPosition::FrontLeft,
    WheelPosition::FrontRight,
    WheelPosition::RearLeft,
    WheelPosition::RearRight,
];

/// Base offset of each promoted per-wheel f32 block. Values are at
/// `base + 4 * source_index`.
pub const NORMALIZED_SUSPENSION_TRAVEL_BASE: usize = 68;
pub const SLIP_RATIO_BASE: usize = 84;
pub const WHEEL_ROTATION_BASE: usize = 100;
pub const SLIP_ANGLE_BASE: usize = 164;
pub const COMBINED_SLIP_BASE: usize = 180;
pub const SUSPENSION_TRAVEL_METRES_BASE: usize = 196;
pub const TIRE_TEMPERATURE_BASE: usize = 268;

/// Bytes 116..=163 inside the wheel block stay undecoded: every one of the
/// 18,165 captured packets holds zeros there, so neither their type nor their
/// meaning has any supporting evidence. They remain raw in `wheel_block_68_211`.
pub const UNDECODED_WHEEL_BYTES: std::ops::Range<usize> = 116..164;

/// Exact FH6 tire temperature conversion. The wire value is Fahrenheit; the
/// canonical field is Celsius. This is the only temperature conversion in
/// RaceLab — React never converts.
pub fn tire_temperature_celsius(fahrenheit: f32) -> f32 {
    (fahrenheit - 32.0) * 5.0 / 9.0
}

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
    /// Exact implemented float values by byte offset, including inactive values.
    pub float_fields: std::collections::BTreeMap<usize, f32>,
    pub is_race_on: i32,
    pub timestamp_ms: u32,
    pub car_ordinal: i32,
    pub car_class: i32,
    pub car_performance_index: i32,
    pub drivetrain_type: i32,
    pub num_cylinders: i32,
    /// Bytes 68..=211 exactly as received, including the promoted per-wheel
    /// blocks. Diagnostics reports what was on the wire, so a canonical field
    /// never replaces its own source bytes.
    pub wheel_block_68_211: Vec<u8>,
    /// Per-wheel values in **source index order**, not corner order.
    pub normalized_suspension_travel: [f32; 4],
    pub tire_slip_ratio: [f32; 4],
    pub wheel_rotation_rad_s: [f32; 4],
    pub tire_slip_angle: [f32; 4],
    pub tire_combined_slip: [f32; 4],
    pub suspension_travel_metres: [f32; 4],
    pub horizon_unknown_232_243: [u8; 12],
    pub power: f32,
    pub torque: f32,
    /// Source Fahrenheit, ordered by offsets 268,272,276,280 (source index
    /// order). The canonical frame carries the Celsius conversion by corner.
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
// requested float fields are decoded; do not interpret floats in unknown
// regions. Per-wheel entries are named by **source index**: an offset-level
// error message must describe the wire, not a corner.
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
    ("normalized_suspension_travel_0", 68),
    ("normalized_suspension_travel_1", 72),
    ("normalized_suspension_travel_2", 76),
    ("normalized_suspension_travel_3", 80),
    ("tire_slip_ratio_0", 84),
    ("tire_slip_ratio_1", 88),
    ("tire_slip_ratio_2", 92),
    ("tire_slip_ratio_3", 96),
    ("wheel_rotation_0", 100),
    ("wheel_rotation_1", 104),
    ("wheel_rotation_2", 108),
    ("wheel_rotation_3", 112),
    ("tire_slip_angle_0", 164),
    ("tire_slip_angle_1", 168),
    ("tire_slip_angle_2", 172),
    ("tire_slip_angle_3", 176),
    ("tire_combined_slip_0", 180),
    ("tire_combined_slip_1", 184),
    ("tire_combined_slip_2", 188),
    ("tire_combined_slip_3", 192),
    ("suspension_travel_metres_0", 196),
    ("suspension_travel_metres_1", 200),
    ("suspension_travel_metres_2", 204),
    ("suspension_travel_metres_3", 208),
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
    let quad = |base: usize| [f(base), f(base + 4), f(base + 8), f(base + 12)];
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
        float_fields: FLOAT_FIELDS
            .iter()
            .map(|&(_, offset)| (offset, f(offset)))
            .collect(),
        is_race_on: i(0),
        timestamp_ms: u(4),
        car_ordinal: i(212),
        car_class: i(216),
        car_performance_index: i(220),
        drivetrain_type: i(224),
        num_cylinders: i(228),
        wheel_block_68_211: p[68..212].to_vec(),
        normalized_suspension_travel: quad(NORMALIZED_SUSPENSION_TRAVEL_BASE),
        tire_slip_ratio: quad(SLIP_RATIO_BASE),
        wheel_rotation_rad_s: quad(WHEEL_ROTATION_BASE),
        tire_slip_angle: quad(SLIP_ANGLE_BASE),
        tire_combined_slip: quad(COMBINED_SLIP_BASE),
        suspension_travel_metres: quad(SUSPENSION_TRAVEL_METRES_BASE),
        horizon_unknown_232_243: p[232..244].try_into().unwrap(),
        power: f(260),
        torque: f(264),
        tire_temperatures: quad(TIRE_TEMPERATURE_BASE),
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
    let mut frame = if raw.is_race_on == 0 {
        // Inactive is not a measurement of zero. Preserve the originals separately.
        TelemetryFrame {
            game_timestamp_ms: Some(u64::from(raw.timestamp_ms)),
            ..TelemetryFrame::default()
        }
    } else {
        TelemetryFrame {
            active: true,
            game_timestamp_ms: Some(u64::from(raw.timestamp_ms)),
            engine: Engine {
                rpm: Some(f(16)),
                idle_rpm: Some(f(12)),
                max_rpm: Some(f(8)),
                power_w: Some(raw.power),
                torque_nm: Some(raw.torque),
            },
            acceleration: Some(v(20)),
            velocity: Some(v(32)),
            angular_velocity: Some(v(44)),
            orientation: Some(v(56)),
            position: Some(v(244)),
            speed_mps: Some(f(256)),
            controls: Controls {
                throttle: Some(f32::from(p[315]) / 255.0),
                brake: Some(f32::from(p[316]) / 255.0),
                clutch: Some(f32::from(p[317]) / 255.0),
                handbrake: Some(f32::from(p[318]) / 255.0),
                steering: Some(f32::from(p[320] as i8) / 127.0),
            },
            // The raw code is not a canonical gear interpretation.
            gear: None,
            wheels: canonical_wheels(&raw),
            race: Race {
                lap_number: Some(u32::from(raw.lap_number)),
                race_position: Some(u32::from(raw.race_position)),
                race_time_seconds: Some(raw.current_race_time),
            },
            ..TelemetryFrame::default()
        }
    };
    frame.game = Some("fh6".into());
    // The same guard the vehicle identifier uses: a zero-filled menu packet
    // carries no vehicle, so its configuration codes stay unavailable rather
    // than being reported as a class 0 car with 0 cylinders.
    if raw.car_ordinal > 0 {
        frame.vehicle_id = Some(raw.car_ordinal.to_string());
        frame.vehicle = Vehicle {
            class_code: Some(raw.car_class),
            performance_index: Some(raw.car_performance_index),
            drivetrain_code: Some(raw.drivetrain_type),
            cylinders: Some(raw.num_cylinders),
        };
    }
    frame.source_specific = Some(serde_json::json!({ "fh6": &raw }));
    Ok(DecodedFrame { frame, fh6: raw })
}

/// Source index order -> canonical corners, through `WHEEL_ORDER` alone.
fn canonical_wheels(raw: &Fh6Raw) -> Wheels {
    let mut wheels = Wheels::default();
    for (index, position) in WHEEL_ORDER.into_iter().enumerate() {
        wheels.set(
            position,
            Wheel {
                temperature_c: Some(tire_temperature_celsius(raw.tire_temperatures[index])),
                slip_ratio: Some(raw.tire_slip_ratio[index]),
                slip_angle: Some(raw.tire_slip_angle[index]),
                combined_slip: Some(raw.tire_combined_slip[index]),
                rotation_rad_s: Some(raw.wheel_rotation_rad_s[index]),
                normalized_suspension_travel: Some(raw.normalized_suspension_travel[index]),
                suspension_travel_m: Some(raw.suspension_travel_metres[index]),
            },
        );
    }
    wheels
}

pub fn physical_issues(frame: &TelemetryFrame) -> Vec<Issue> {
    let mut issues = Vec::new();
    if !frame.active {
        return issues;
    }
    let (Some(speed), Some(velocity)) = (frame.speed_mps, frame.velocity) else {
        return vec![Issue::new(
            "motion",
            256,
            "Active FH6 motion is unavailable",
        )];
    };
    let error = (f64::from(speed) - velocity.magnitude()).abs();
    if speed < 0.0 || error > SPEED_TOLERANCE_MPS {
        issues.push(Issue::new(
            "speed",
            256,
            format!("Speed/velocity discrepancy {error:.9} m/s (tolerance {SPEED_TOLERANCE_MPS})"),
        ));
    }
    issues.extend(promoted_field_issues(frame));
    let e = frame.engine;
    let (Some(max), Some(idle), Some(rpm)) = (e.max_rpm, e.idle_rpm, e.rpm) else {
        issues.push(Issue::new(
            "engine",
            8,
            "Active FH6 engine data is unavailable",
        ));
        return issues;
    };
    if max <= 0.0 || max > RPM_ABSOLUTE_LIMIT {
        issues.push(Issue::new(
            "engine_max_rpm",
            8,
            "Expected 0 < max RPM <= 30000",
        ));
    }
    if idle < 0.0 || idle > max {
        issues.push(Issue::new(
            "engine_idle_rpm",
            12,
            "Idle RPM outside 0..max RPM",
        ));
    }
    if rpm < 0.0 || rpm > (max * 1.1).min(RPM_ABSOLUTE_LIMIT) {
        issues.push(Issue::new(
            "current_engine_rpm",
            16,
            "RPM outside 0..min(max RPM * 1.1, 30000)",
        ));
    }
    issues
}

/// V0.8 semantic policies for newly promoted fields. Each rule follows from the
/// field's own definition rather than from an observed range: a *normalized*
/// travel outside 0..1 and a negative *magnitude* or elapsed time are
/// self-contradictory, whatever the vehicle. Nothing is clamped; an offending
/// packet is reported and withheld, exactly as an invalid RPM already is.
fn promoted_field_issues(frame: &TelemetryFrame) -> Vec<Issue> {
    let mut issues = Vec::new();
    for (index, position) in WHEEL_ORDER.into_iter().enumerate() {
        let wheel = frame.wheels.get(position);
        if wheel
            .normalized_suspension_travel
            .is_some_and(|value| !(0.0..=1.0).contains(&value))
        {
            issues.push(Issue::new(
                "normalized_suspension_travel",
                NORMALIZED_SUSPENSION_TRAVEL_BASE + 4 * index,
                "Normalized suspension travel outside 0..1",
            ));
        }
        if wheel.combined_slip.is_some_and(|value| value < 0.0) {
            issues.push(Issue::new(
                "tire_combined_slip",
                COMBINED_SLIP_BASE + 4 * index,
                "Combined slip is a magnitude and cannot be negative",
            ));
        }
    }
    if frame
        .race
        .race_time_seconds
        .is_some_and(|value| value < 0.0)
    {
        issues.push(Issue::new(
            "current_race_time",
            308,
            "Elapsed race time cannot be negative",
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
