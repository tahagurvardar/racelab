//! Game-independent values. No packet offsets or game-specific vehicle identifiers.
//!
//! This is `TelemetryFrame` **schema version 2**. See
//! `docs/V0.8-TELEMETRY-SCHEMA.md` for the canonical unit rules, the wheel
//! order and the null/unavailable policy. Two conventions hold throughout:
//!
//! 1. Every *leaf* measurement is `Option<T>`. `None` means unavailable and is
//!    never the same as a measured zero.
//! 2. Container structs (`Engine`, `Controls`, `Vehicle`, `Wheels`, `Race`) are
//!    always structurally present; an unavailable group is the container with
//!    every leaf `None`. This matches the V1 shape of `Engine`/`Controls`.
//!
//! A field only exists here once its meaning *and* its unit are supported by
//! evidence. Candidates that are not are absent from this file entirely rather
//! than present and permanently null.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Vector3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Vector3 {
    pub fn magnitude(self) -> f64 {
        f64::from(self.x)
            .hypot(f64::from(self.y))
            .hypot(f64::from(self.z))
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Engine {
    pub rpm: Option<f32>,
    pub idle_rpm: Option<f32>,
    pub max_rpm: Option<f32>,
    /// Watts. Established by `power == torque * angular velocity` holding
    /// across real FH6 captures; see docs/FH6-PROTOCOL.md.
    pub power_w: Option<f32>,
    /// Newton-metres, same evidence as `power_w`.
    pub torque_nm: Option<f32>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Controls {
    /// Pedals/handbrake: 0..=1. Steering: -1..=1.
    pub throttle: Option<f32>,
    pub brake: Option<f32>,
    pub clutch: Option<f32>,
    pub handbrake: Option<f32>,
    pub steering: Option<f32>,
}

/// Vehicle configuration codes. These are **codes**, not names: RaceLab has no
/// class, drivetrain or model database and never invents an enum label for one.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Vehicle {
    pub class_code: Option<i32>,
    pub performance_index: Option<i32>,
    pub drivetrain_code: Option<i32>,
    pub cylinders: Option<i32>,
}

/// Canonical corner identity. Ordering here is presentation order only; the
/// mapping from a source protocol's wheel index to a corner belongs to that
/// adapter and exists in exactly one place per adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WheelPosition {
    FrontLeft,
    FrontRight,
    RearLeft,
    RearRight,
}

pub const WHEEL_POSITIONS: [WheelPosition; 4] = [
    WheelPosition::FrontLeft,
    WheelPosition::FrontRight,
    WheelPosition::RearLeft,
    WheelPosition::RearRight,
];

/// One corner. Field names carry a unit suffix only where the unit is
/// established; `slip_ratio`, `slip_angle` and `combined_slip` are
/// dimensionless source quantities whose normalization domain is not, so they
/// deliberately have no SI name.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Wheel {
    /// Degrees Celsius.
    pub temperature_c: Option<f32>,
    /// Dimensionless longitudinal slip term.
    pub slip_ratio: Option<f32>,
    /// Dimensionless lateral slip term. Not an angle in radians: the source
    /// range rules that out and the normalization is not established.
    pub slip_angle: Option<f32>,
    /// Dimensionless. Equals `hypot(slip_ratio, slip_angle)` in every FH6
    /// packet measured so far.
    pub combined_slip: Option<f32>,
    /// Radians per second. Signed; forward rotation is positive.
    pub rotation_rad_s: Option<f32>,
    /// 0..=1, where 0 is full extension (droop) and 1 is full compression.
    pub normalized_suspension_travel: Option<f32>,
    /// Metres of suspension travel about the source's own zero.
    pub suspension_travel_m: Option<f32>,
}

/// Four named corners. Named fields rather than an array: a corner cannot be
/// transposed by an index slip in serialization, storage or presentation.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Wheels {
    pub front_left: Wheel,
    pub front_right: Wheel,
    pub rear_left: Wheel,
    pub rear_right: Wheel,
}

impl Wheels {
    pub fn get(&self, position: WheelPosition) -> &Wheel {
        match position {
            WheelPosition::FrontLeft => &self.front_left,
            WheelPosition::FrontRight => &self.front_right,
            WheelPosition::RearLeft => &self.rear_left,
            WheelPosition::RearRight => &self.rear_right,
        }
    }

    pub fn set(&mut self, position: WheelPosition, wheel: Wheel) {
        *match position {
            WheelPosition::FrontLeft => &mut self.front_left,
            WheelPosition::FrontRight => &mut self.front_right,
            WheelPosition::RearLeft => &mut self.rear_left,
            WheelPosition::RearRight => &mut self.rear_right,
        } = wheel;
    }
}

/// Canonical race state. Lap timing (`best`/`last`/`current`) and the game's
/// own distance counter are deliberately absent: no capture has ever carried a
/// non-zero value for them, so neither their unit nor their semantics is
/// established. See docs/V0.8-VALIDATION.md.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Race {
    pub lap_number: Option<u32>,
    pub race_position: Option<u32>,
    /// Seconds. The source clock advances 1:1 with the game timestamp.
    pub race_time_seconds: Option<f32>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum Gear {
    #[default]
    Unknown,
    Reverse,
    Neutral,
    Forward(u16),
    /// Preserve an adapter code until its semantic mapping is independently verified.
    Unmapped(u16),
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TelemetryFrame {
    pub active: bool,
    pub game: Option<String>,
    pub vehicle_id: Option<String>,
    pub game_timestamp_ms: Option<u64>,
    pub engine: Engine,
    /// m/s², in source axes; absent when inactive/unavailable.
    pub acceleration: Option<Vector3>,
    /// m/s, in source axes.
    pub velocity: Option<Vector3>,
    /// radians per second, in source axes.
    pub angular_velocity: Option<Vector3>,
    /// Radians: x=yaw, y=pitch, z=roll; no undocumented axis transform.
    pub orientation: Option<Vector3>,
    /// Metres, in the source coordinate system.
    pub position: Option<Vector3>,
    pub speed_mps: Option<f32>,
    pub controls: Controls,
    pub gear: Option<Gear>,
    /// Schema v2. Configuration codes only; never a class or drivetrain name.
    pub vehicle: Vehicle,
    /// Schema v2. Corner identity is fixed by the adapter's single mapping.
    pub wheels: Wheels,
    /// Schema v2.
    pub race: Race,
    /// Adapter-owned JSON envelope (e.g. {"fh6": ...}); never canonical units.
    /// Current adapters construct a fixed-size schema, not arbitrary user JSON.
    /// Retained in full even where a canonical field now exists, because
    /// Diagnostics reports the value the adapter actually read off the wire.
    #[serde(rename = "sourceSpecific")]
    pub source_specific: Option<serde_json::Value>,
}
