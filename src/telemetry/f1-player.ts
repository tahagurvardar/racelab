/// F1 25 Phase B: decoded PLAYER values as Diagnostics shows them.
///
/// Engineering data only. Every value is the decoded wire value in the
/// specification's unit; nothing is converted, smoothed or interpreted, and
/// each packet family keeps its own frame and age, because the families are
/// not one frame. Codes show their specification label with the raw value
/// beside it, and an unknown code shows only its raw value.
import { UNAVAILABLE, code as plainCode, offsetClock } from "./formatting.ts";
import type { DiagnosticEntry } from "./f1-evidence.ts";
import { f1Wheel } from "./f1-wheels.ts";

export interface Code {
  raw: number;
  label: string | null;
}

export type { Wheels } from "./f1-wheels.ts";
import type { Wheels } from "./f1-wheels.ts";

export interface Fresh<P> {
  packet_id: number;
  frame_identifier: number;
  overall_frame_identifier: number;
  session_time: number | null;
  received_unix_ms: number;
  age_ms: number;
  value: P;
}

export interface CarTelemetry {
  speed_kmh: number;
  throttle: number | null;
  steer: number | null;
  brake: number | null;
  clutch: number;
  gear: Code;
  engine_rpm: number;
  drs: Code;
  rev_lights_percent: number;
  rev_lights_bit_value: number;
  brakes_temperature_c: Wheels<number>;
  tyres_surface_temperature_c: Wheels<number>;
  tyres_inner_temperature_c: Wheels<number>;
  engine_temperature_c: number;
  tyres_pressure_psi: Wheels<number | null>;
  surface_type: Wheels<Code>;
}

export interface CarTelemetryPacket {
  player: CarTelemetry | null;
  mfd_panel_index: Code;
  mfd_panel_index_secondary_player: Code;
  suggested_gear: Code;
}

export interface CarStatus {
  traction_control: Code;
  anti_lock_brakes: Code;
  fuel_mix: Code;
  front_brake_bias_percent: number;
  pit_limiter_status: Code;
  fuel_in_tank: number | null;
  fuel_capacity: number | null;
  fuel_remaining_laps: number | null;
  max_rpm: number;
  idle_rpm: number;
  max_gears: number;
  drs_allowed: Code;
  drs_activation_distance_m: number;
  actual_tyre_compound: Code;
  visual_tyre_compound: Code;
  tyres_age_laps: number;
  vehicle_fia_flags: Code;
  engine_power_ice_w: number | null;
  engine_power_mguk_w: number | null;
  ers_store_energy_j: number | null;
  ers_deploy_mode: Code;
  ers_harvested_this_lap_mguk: number | null;
  ers_harvested_this_lap_mguh: number | null;
  ers_deployed_this_lap: number | null;
  network_paused: number;
}

export interface SplitTime {
  ms_part: number;
  minutes_part: number;
  total_ms: number;
}

export interface LapData {
  last_lap_time_ms: number;
  current_lap_time_ms: number;
  sector1_time: SplitTime;
  sector2_time: SplitTime;
  delta_to_car_in_front: SplitTime;
  delta_to_race_leader: SplitTime;
  lap_distance_m: number | null;
  total_distance_m: number | null;
  safety_car_delta_s: number | null;
  car_position: number;
  current_lap_num: number;
  pit_status: Code;
  num_pit_stops: number;
  sector: Code;
  current_lap_invalid: Code;
  penalties_s: number;
  total_warnings: number;
  corner_cutting_warnings: number;
  num_unserved_drive_through_pens: number;
  num_unserved_stop_go_pens: number;
  grid_position: number;
  driver_status: Code;
  result_status: Code;
  pit_lane_timer_active: Code;
  pit_lane_time_in_lane_ms: number;
  pit_stop_timer_ms: number;
  pit_stop_should_serve_pen: number;
  speed_trap_fastest_speed_kmh: number | null;
  speed_trap_fastest_lap: number;
}

export interface LapDataPacket {
  player: LapData | null;
  time_trial_pb_car_idx: number;
  time_trial_rival_car_idx: number;
}

export interface Vector {
  x: number | null;
  y: number | null;
  z: number | null;
}

export interface MotionEx {
  suspension_position: Wheels<number | null>;
  suspension_velocity: Wheels<number | null>;
  suspension_acceleration: Wheels<number | null>;
  wheel_speed: Wheels<number | null>;
  wheel_slip_ratio: Wheels<number | null>;
  wheel_slip_angle: Wheels<number | null>;
  wheel_lat_force: Wheels<number | null>;
  wheel_long_force: Wheels<number | null>;
  height_of_cog_above_ground: number | null;
  local_velocity_mps: Vector;
  angular_velocity_rad_s: Vector;
  angular_acceleration_rad_s2: Vector;
  front_wheels_angle_rad: number | null;
  wheel_vert_force: Wheels<number | null>;
  front_aero_height: number | null;
  rear_aero_height: number | null;
  front_roll_angle: number | null;
  rear_roll_angle: number | null;
  chassis_yaw_rad: number | null;
  chassis_pitch_rad: number | null;
  wheel_camber_rad: Wheels<number | null>;
  wheel_camber_gain_rad: Wheels<number | null>;
}

export interface F1LiveSnapshot {
  session_uid: string | null;
  player_car_index: number | null;
  player_available: boolean;
  session_resets: number;
  player_resets: number;
  out_of_order_dropped: number;
  car_telemetry: Fresh<CarTelemetryPacket> | null;
  car_status: Fresh<{ player: CarStatus | null }> | null;
  lap_data: Fresh<LapDataPacket> | null;
  motion_ex: Fresh<{ player: MotionEx | null }> | null;
}

/// `get_f1_live`: what the product Live view polls.
export interface F1LiveStatus {
  enabled: boolean;
  configured_port: number;
  listening: boolean;
  bound_port: number | null;
  listener_error: string | null;
  /// Age of the latest accepted datagram of any F1 25 packet type.
  last_accepted_age_ms: number | null;
  live: F1LiveSnapshot;
}

export interface CapturedPacket {
  packet_id: number;
  name: string;
  file: string;
  size: number;
  frame_identifier: number;
  overall_frame_identifier: number;
  session_time: number;
  player_car_index: number;
  age_ms: number;
}

export interface CaptureManifest {
  label: string;
  captured_unix_ms: number;
  racelab_version: string;
  directory: string;
  packets: CapturedPacket[];
}

export interface CaptureStatus {
  directory: string;
  snapshots_taken: number;
  max_snapshots: number;
  last: CaptureManifest | null;
  last_error: string | null;
}

// ---------------------------------------------------------------- format

/// A float exactly as decoded, to a fixed number of places. Non-finite
/// values (serialized as null) are unavailable, never 0.
export function value(raw: number | null | undefined, digits = 3): string {
  return raw == null || !Number.isFinite(raw)
    ? UNAVAILABLE
    : raw.toFixed(digits);
}

/// "label (raw)", or "Unknown (raw)" when the specification names no
/// meaning for the value. The raw value is always shown.
export function codeText(raw: Code | null | undefined): string {
  if (raw == null) return UNAVAILABLE;
  return raw.label == null
    ? `Unknown (${raw.raw})`
    : `${raw.label} (${raw.raw})`;
}

/// Milliseconds -> m:ss.mmm, exact integer arithmetic.
export function msTime(ms: number | null | undefined): string {
  return offsetClock(ms);
}

export function freshness(fresh: Fresh<unknown> | null): string {
  if (fresh == null) return "not received";
  return `frame ${fresh.frame_identifier} · ${fresh.age_ms} ms old`;
}

// ------------------------------------------------------------- sections

export interface WheelRow {
  key: string;
  label: string;
  /// Displayed front-left, front-right, rear-left, rear-right; named, so the
  /// wire order (RL, RR, FL, FR) is never re-applied by position.
  values: { fl: string; fr: string; rl: string; rr: string };
}

export interface Section {
  key: string;
  title: string;
  /// Which packet(s) the values come from and how old they are.
  source: string;
  /// Null when the family has not arrived or the player index is invalid.
  entries: DiagnosticEntry[] | null;
  wheels: WheelRow[];
}

function wheelRow<T>(
  key: string,
  label: string,
  wheels: Wheels<T>,
  show: (v: T) => string,
): WheelRow {
  return {
    key,
    label,
    values: {
      fl: show(f1Wheel(wheels, "FL")),
      fr: show(f1Wheel(wheels, "FR")),
      rl: show(f1Wheel(wheels, "RL")),
      rr: show(f1Wheel(wheels, "RR")),
    },
  };
}

const e = (key: string, label: string, v: string): DiagnosticEntry => ({
  key,
  label,
  value: v,
});
const int = (v: number) => plainCode(v);

export function drivingSection(live: F1LiveSnapshot): Section {
  const fresh = live.car_telemetry;
  const t = fresh?.value.player ?? null;
  return {
    key: "driving",
    title: "Driving",
    source: `Car Telemetry (6) · ${freshness(fresh)}`,
    entries:
      t == null || fresh == null
        ? null
        : [
            e("speed", "Speed (km/h)", int(t.speed_kmh)),
            e("throttle", "Throttle (0–1)", value(t.throttle)),
            e("brake", "Brake (0–1)", value(t.brake)),
            e("steer", "Steer (−1 left … 1 right)", value(t.steer)),
            e("clutch", "Clutch (0–100)", int(t.clutch)),
            e("gear", "Gear", codeText(t.gear)),
            e(
              "suggested_gear",
              "Suggested gear",
              codeText(fresh.value.suggested_gear),
            ),
            e("rpm", "Engine RPM", int(t.engine_rpm)),
            e("drs", "DRS", codeText(t.drs)),
            e("rev_lights", "Rev lights (%)", int(t.rev_lights_percent)),
            e(
              "rev_bits",
              "Rev lights bits",
              `0x${t.rev_lights_bit_value.toString(16).toUpperCase().padStart(4, "0")}`,
            ),
            e("mfd", "MFD panel", codeText(fresh.value.mfd_panel_index)),
          ],
    wheels: [],
  };
}

export function temperaturesSection(live: F1LiveSnapshot): Section {
  const fresh = live.car_telemetry;
  const t = fresh?.value.player ?? null;
  return {
    key: "temperatures",
    title: "Temperatures and pressures",
    source: `Car Telemetry (6) · ${freshness(fresh)}`,
    entries:
      t == null
        ? null
        : [e("engine_temp", "Engine (°C)", int(t.engine_temperature_c))],
    wheels:
      t == null
        ? []
        : [
            wheelRow("brakes", "Brakes (°C)", t.brakes_temperature_c, int),
            wheelRow(
              "tyre_surface",
              "Tyre surface (°C)",
              t.tyres_surface_temperature_c,
              int,
            ),
            wheelRow(
              "tyre_inner",
              "Tyre inner (°C)",
              t.tyres_inner_temperature_c,
              int,
            ),
            wheelRow(
              "pressure",
              "Tyre pressure (PSI)",
              t.tyres_pressure_psi,
              (v) => value(v, 2),
            ),
            wheelRow("surface", "Surface", t.surface_type, codeText),
          ],
  };
}

export function statusSection(live: F1LiveSnapshot): Section {
  const fresh = live.car_status;
  const s = fresh?.value.player ?? null;
  return {
    key: "status",
    title: "Status",
    source: `Car Status (7) · ${freshness(fresh)}`,
    entries:
      s == null
        ? null
        : [
            e("fuel", "Fuel in tank", value(s.fuel_in_tank, 2)),
            e("fuel_capacity", "Fuel capacity", value(s.fuel_capacity, 2)),
            e(
              "fuel_laps",
              "Fuel remaining (laps)",
              value(s.fuel_remaining_laps, 2),
            ),
            e("fuel_mix", "Fuel mix", codeText(s.fuel_mix)),
            e("bias", "Front brake bias (%)", int(s.front_brake_bias_percent)),
            e("tc", "Traction control", codeText(s.traction_control)),
            e("abs", "Anti-lock brakes", codeText(s.anti_lock_brakes)),
            e("pit_limiter", "Pit limiter", codeText(s.pit_limiter_status)),
            e(
              "actual_tyre",
              "Actual compound",
              codeText(s.actual_tyre_compound),
            ),
            e(
              "visual_tyre",
              "Visual compound",
              codeText(s.visual_tyre_compound),
            ),
            e("tyre_age", "Tyre age (laps)", int(s.tyres_age_laps)),
            e("drs_allowed", "DRS allowed", codeText(s.drs_allowed)),
            e(
              "drs_distance",
              "DRS available in (m)",
              int(s.drs_activation_distance_m),
            ),
            e("fia_flag", "FIA flag", codeText(s.vehicle_fia_flags)),
            e("ers_store", "ERS store (J)", value(s.ers_store_energy_j, 0)),
            e("ers_mode", "ERS deploy mode", codeText(s.ers_deploy_mode)),
            e(
              "ers_mguk",
              "ERS harvested MGU-K (lap)",
              value(s.ers_harvested_this_lap_mguk, 0),
            ),
            e(
              "ers_mguh",
              "ERS harvested MGU-H (lap)",
              value(s.ers_harvested_this_lap_mguh, 0),
            ),
            e(
              "ers_deployed",
              "ERS deployed (lap)",
              value(s.ers_deployed_this_lap, 0),
            ),
            e("ice", "ICE power (W)", value(s.engine_power_ice_w, 0)),
            e("mguk", "MGU-K power (W)", value(s.engine_power_mguk_w, 0)),
            e("max_rpm", "Max RPM", int(s.max_rpm)),
            e("idle_rpm", "Idle RPM", int(s.idle_rpm)),
            e("max_gears", "Max gears", int(s.max_gears)),
            e("network_paused", "Network paused (raw)", int(s.network_paused)),
          ],
    wheels: [],
  };
}

export function lapSection(live: F1LiveSnapshot): Section {
  const fresh = live.lap_data;
  const l = fresh?.value.player ?? null;
  return {
    key: "lap",
    title: "Lap",
    source: `Lap Data (2) · ${freshness(fresh)}`,
    entries:
      l == null
        ? null
        : [
            e("lap", "Current lap", int(l.current_lap_num)),
            e("sector", "Sector", codeText(l.sector)),
            e(
              "current_time",
              "Current lap time",
              msTime(l.current_lap_time_ms),
            ),
            e("last_time", "Last lap time", msTime(l.last_lap_time_ms)),
            e("s1", "Sector 1", msTime(l.sector1_time.total_ms)),
            e("s2", "Sector 2", msTime(l.sector2_time.total_ms)),
            e("lap_invalid", "Current lap", codeText(l.current_lap_invalid)),
            e("position", "Position", int(l.car_position)),
            e("grid", "Grid position", int(l.grid_position)),
            e("lap_distance", "Lap distance (m)", value(l.lap_distance_m, 1)),
            e(
              "total_distance",
              "Total distance (m)",
              value(l.total_distance_m, 1),
            ),
            e("sc_delta", "Safety car delta (s)", value(l.safety_car_delta_s)),
            e("driver_status", "Driver status", codeText(l.driver_status)),
            e("result_status", "Result status", codeText(l.result_status)),
            e("pit_status", "Pit status", codeText(l.pit_status)),
            e("pit_stops", "Pit stops", int(l.num_pit_stops)),
            e("pit_timer", "Pit lane timer", codeText(l.pit_lane_timer_active)),
            e("penalties", "Penalties (s)", int(l.penalties_s)),
            e("warnings", "Warnings", int(l.total_warnings)),
            e(
              "cc_warnings",
              "Corner-cutting warnings",
              int(l.corner_cutting_warnings),
            ),
            e(
              "drive_through",
              "Unserved drive-throughs",
              int(l.num_unserved_drive_through_pens),
            ),
            e("stop_go", "Unserved stop-gos", int(l.num_unserved_stop_go_pens)),
            e(
              "speed_trap",
              "Speed trap (km/h)",
              value(l.speed_trap_fastest_speed_kmh, 1),
            ),
          ],
    wheels: [],
  };
}

export function motionSection(live: F1LiveSnapshot): Section {
  const fresh = live.motion_ex;
  const m = fresh?.value.player ?? null;
  const v3 = (v: Vector) => `${value(v.x)}, ${value(v.y)}, ${value(v.z)}`;
  const f = (v: number | null) => value(v);
  return {
    key: "motion",
    title: "Motion",
    source: `Motion Ex (13) · ${freshness(fresh)}`,
    entries:
      m == null
        ? null
        : [
            e(
              "local_velocity",
              "Local velocity x, y, z (m/s)",
              v3(m.local_velocity_mps),
            ),
            e(
              "angular_velocity",
              "Angular velocity x, y, z (rad/s)",
              v3(m.angular_velocity_rad_s),
            ),
            e(
              "angular_acceleration",
              "Angular accel. x, y, z (rad/s²)",
              v3(m.angular_acceleration_rad_s2),
            ),
            e(
              "front_wheels_angle",
              "Front wheels angle (rad)",
              f(m.front_wheels_angle_rad),
            ),
            e(
              "cog_height",
              "CoG height above ground",
              f(m.height_of_cog_above_ground),
            ),
            e("chassis_yaw", "Chassis yaw (rad)", f(m.chassis_yaw_rad)),
            e("chassis_pitch", "Chassis pitch (rad)", f(m.chassis_pitch_rad)),
          ],
    wheels:
      m == null
        ? []
        : [
            wheelRow("wheel_speed", "Wheel speed", m.wheel_speed, f),
            wheelRow("slip_ratio", "Slip ratio", m.wheel_slip_ratio, f),
            wheelRow("slip_angle", "Slip angle", m.wheel_slip_angle, f),
            wheelRow(
              "susp_position",
              "Suspension position",
              m.suspension_position,
              f,
            ),
            wheelRow(
              "susp_velocity",
              "Suspension velocity",
              m.suspension_velocity,
              f,
            ),
            wheelRow("lat_force", "Lateral force", m.wheel_lat_force, (v) =>
              value(v, 1),
            ),
            wheelRow(
              "long_force",
              "Longitudinal force",
              m.wheel_long_force,
              (v) => value(v, 1),
            ),
            wheelRow("vert_force", "Vertical force", m.wheel_vert_force, (v) =>
              value(v, 1),
            ),
          ],
  };
}

export function playerSections(live: F1LiveSnapshot): Section[] {
  return [
    drivingSection(live),
    temperaturesSection(live),
    statusSection(live),
    lapSection(live),
    motionSection(live),
  ];
}

/// Why no player values are shown, when none are.
export function playerAvailability(live: F1LiveSnapshot): string | null {
  if (live.player_car_index == null) return "No F1 25 packet received yet.";
  if (!live.player_available)
    return `playerCarIndex is ${live.player_car_index}: no valid player car (e.g. spectating), so no player values are shown.`;
  return null;
}
