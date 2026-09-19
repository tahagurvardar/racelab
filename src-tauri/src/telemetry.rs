//! Game-independent values. No packet offsets or game-specific vehicle identifiers.
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
    /// Adapter-owned JSON envelope (e.g. {"fh6": ...}); never canonical units.
    /// Current adapters construct a fixed-size schema, not arbitrary user JSON.
    #[serde(rename = "sourceSpecific")]
    pub source_specific: Option<serde_json::Value>,
}
