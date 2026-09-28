/// Canonical, game-independent telemetry as `src-tauri/src/telemetry.rs`
/// serializes it — `TelemetryFrame` **schema version 2**. Nothing here
/// describes packet offsets or an adapter layout: every product view consumes
/// this shape and nothing else.
///
/// Two conventions mirror the Rust model. Every leaf measurement is nullable
/// and `null` means unavailable, never a measured zero. Container objects are
/// always present; an unavailable group is the container with null leaves.

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface Engine {
  rpm: number | null;
  idle_rpm: number | null;
  max_rpm: number | null;
  /// Watts.
  power_w: number | null;
  /// Newton-metres.
  torque_nm: number | null;
}

/// Vehicle configuration codes. RaceLab has no class, drivetrain or model
/// database: these are rendered as codes and never as names.
export interface Vehicle {
  class_code: number | null;
  performance_index: number | null;
  drivetrain_code: number | null;
  cylinders: number | null;
}

/// One corner. A unit suffix appears only where the unit is established; the
/// slip channels are dimensionless source quantities.
export interface Wheel {
  /// Degrees Celsius. The adapter converts; React never does.
  temperature_c: number | null;
  slip_ratio: number | null;
  slip_angle: number | null;
  combined_slip: number | null;
  rotation_rad_s: number | null;
  /// 0..1: 0 is full extension, 1 is full compression.
  normalized_suspension_travel: number | null;
  suspension_travel_m: number | null;
}

/// Four named corners. The backend resolved the corner identity; the frontend
/// reads names and never an index, so no corner can be transposed here.
export interface Wheels {
  front_left: Wheel;
  front_right: Wheel;
  rear_left: Wheel;
  rear_right: Wheel;
}

/// Canonical race state. Lap timing and the game's own distance counter are
/// absent from schema v2 on purpose: no capture has carried a non-zero value
/// for them, so neither their unit nor their semantics is established.
export interface Race {
  lap_number: number | null;
  race_position: number | null;
  /// Seconds.
  race_time_seconds: number | null;
}

/// Pedals/handbrake are 0..=1, steering is -1..=1. `null` means unavailable,
/// which is never the same value as a measured 0.
export interface Controls {
  throttle: number | null;
  brake: number | null;
  clutch: number | null;
  handbrake: number | null;
  steering: number | null;
}

/// Externally tagged `telemetry::Gear`. `unmapped` deliberately preserves an
/// adapter code whose meaning is not established; it is not a gear.
export type Gear =
  | { kind: "unknown" }
  | { kind: "reverse" }
  | { kind: "neutral" }
  | { kind: "forward"; value: number }
  | { kind: "unmapped"; value: number };

export interface TelemetryFrame {
  active: boolean;
  game: string | null;
  vehicle_id: string | null;
  game_timestamp_ms: number | null;
  engine: Engine;
  /// m/s², in source axes. No axis is named lateral or longitudinal, because
  /// the vehicle-axis orientation of this vector is not established.
  acceleration: Vector3 | null;
  /// m/s, in source axes.
  velocity: Vector3 | null;
  /// radians/second, in source axes.
  angular_velocity: Vector3 | null;
  /// radians: x = yaw, y = pitch, z = roll.
  orientation: Vector3 | null;
  /// metres, in the source coordinate system.
  position: Vector3 | null;
  speed_mps: number | null;
  controls: Controls;
  gear: Gear | null;
  vehicle: Vehicle;
  wheels: Wheels;
  race: Race;
  /// Adapter-owned envelope. Diagnostics is the only consumer in the product;
  /// no dashboard view may read it. See `diagnostics-view-model.ts`.
  sourceSpecific: Record<string, unknown> | null;
}
