//! Game-independent values. No packet offsets or game-specific vehicle identifiers.
use serde::Serialize;

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
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

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
pub struct Engine {
    pub rpm: f32,
    pub idle_rpm: f32,
    pub max_rpm: f32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
pub struct Controls {
    /// Pedals/handbrake: 0..=1. Steering: -1..=1.
    pub throttle: f32,
    pub brake: f32,
    pub clutch: f32,
    pub handbrake: f32,
    pub steering: f32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
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

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct TelemetryFrame {
    pub active: bool,
    pub game_timestamp_ms: u64,
    pub engine: Engine,
    pub acceleration: Vector3,
    pub velocity: Vector3,
    pub angular_velocity: Vector3,
    /// x=yaw, y=pitch, z=roll; adapter-native orientation, no coordinate transform.
    pub orientation: Vector3,
    pub position: Vector3,
    pub speed_mps: f32,
    pub controls: Controls,
    pub gear: Gear,
}
