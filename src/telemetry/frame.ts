/// Canonical, game-independent telemetry as `src-tauri/src/telemetry.rs`
/// serializes it. Nothing here describes packet offsets or an adapter layout:
/// every product view consumes this shape and nothing else.

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface Engine {
  rpm: number | null;
  idle_rpm: number | null;
  max_rpm: number | null;
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
  /// Adapter-owned envelope. Diagnostics is the only consumer in the product;
  /// no dashboard view may read it. See `diagnostics-view-model.ts`.
  sourceSpecific: Record<string, unknown> | null;
}
