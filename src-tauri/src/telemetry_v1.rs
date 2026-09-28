//! **Frozen** `TelemetryFrame` schema version 1.
//!
//! These types describe the exact serialized shape written by RaceLab V0.6 and
//! V0.7 recordings. They exist so those `.rlframes` files stay readable after
//! the canonical model moved to schema v2, and they must never be edited to
//! follow a later schema: that would silently reinterpret data already on disk.
//!
//! Reading is deliberately *faithful*, not clever. Every V1 value is carried
//! across unchanged and every field introduced by V2 becomes `None`. Nothing is
//! reconstructed from `sourceSpecific`, because an old recording's adapter
//! envelope was never validated against the V2 canonical contract.
use crate::telemetry::{Controls, Engine, Gear, TelemetryFrame, Vector3};
use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct Vector3V1 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct EngineV1 {
    pub rpm: Option<f32>,
    pub idle_rpm: Option<f32>,
    pub max_rpm: Option<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct ControlsV1 {
    pub throttle: Option<f32>,
    pub brake: Option<f32>,
    pub clutch: Option<f32>,
    pub handbrake: Option<f32>,
    pub steering: Option<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum GearV1 {
    Unknown,
    Reverse,
    Neutral,
    Forward(u16),
    Unmapped(u16),
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TelemetryFrameV1 {
    pub active: bool,
    pub game: Option<String>,
    pub vehicle_id: Option<String>,
    pub game_timestamp_ms: Option<u64>,
    pub engine: EngineV1,
    pub acceleration: Option<Vector3V1>,
    pub velocity: Option<Vector3V1>,
    pub angular_velocity: Option<Vector3V1>,
    pub orientation: Option<Vector3V1>,
    pub position: Option<Vector3V1>,
    pub speed_mps: Option<f32>,
    pub controls: ControlsV1,
    pub gear: Option<GearV1>,
    #[serde(rename = "sourceSpecific")]
    pub source_specific: Option<serde_json::Value>,
}

/// One V1 record body, matching the framing the V0.6 writer produced. The
/// RLFRAMES container framing itself is unchanged, so only the frame payload
/// needs a versioned decode target.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct StoredFrameV1 {
    pub sequence: u64,
    pub monotonic_ms: u64,
    pub frame: TelemetryFrameV1,
}

impl From<Vector3V1> for Vector3 {
    fn from(value: Vector3V1) -> Self {
        Self {
            x: value.x,
            y: value.y,
            z: value.z,
        }
    }
}

impl From<GearV1> for Gear {
    fn from(value: GearV1) -> Self {
        match value {
            GearV1::Unknown => Gear::Unknown,
            GearV1::Reverse => Gear::Reverse,
            GearV1::Neutral => Gear::Neutral,
            GearV1::Forward(gear) => Gear::Forward(gear),
            GearV1::Unmapped(code) => Gear::Unmapped(code),
        }
    }
}

impl From<TelemetryFrameV1> for TelemetryFrame {
    fn from(value: TelemetryFrameV1) -> Self {
        Self {
            active: value.active,
            game: value.game,
            vehicle_id: value.vehicle_id,
            game_timestamp_ms: value.game_timestamp_ms,
            engine: Engine {
                rpm: value.engine.rpm,
                idle_rpm: value.engine.idle_rpm,
                max_rpm: value.engine.max_rpm,
                // Introduced by schema v2. A V1 recording never measured them.
                power_w: None,
                torque_nm: None,
            },
            acceleration: value.acceleration.map(Vector3::from),
            velocity: value.velocity.map(Vector3::from),
            angular_velocity: value.angular_velocity.map(Vector3::from),
            orientation: value.orientation.map(Vector3::from),
            position: value.position.map(Vector3::from),
            speed_mps: value.speed_mps,
            controls: Controls {
                throttle: value.controls.throttle,
                brake: value.controls.brake,
                clutch: value.controls.clutch,
                handbrake: value.controls.handbrake,
                steering: value.controls.steering,
            },
            gear: value.gear.map(Gear::from),
            // Schema v2 groups. Absent from a V1 recording, so unavailable.
            vehicle: Default::default(),
            wheels: Default::default(),
            race: Default::default(),
            source_specific: value.source_specific,
        }
    }
}
