/// The F1 25 Live tabs as data: what each tab shows, in what order, from
/// which packet family, and whether that family is current.
///
/// Rules, all inherited from the decoders and kept here:
///
/// - Values are the decoded F1 25 values in the specification's units. A
///   unit is printed only where the specification states one. The only
///   conversions are exact presentation arithmetic, each named where it is
///   made: 0..1 inputs as percent, ERS store joules as megajoules (÷ 10⁶),
///   millisecond times as m:ss.mmm or seconds.
/// - Every reading belongs to exactly one packet family and takes that
///   family's freshness (`f1-freshness.ts`): fresh, stale (shown, marked
///   "not updating"), or unavailable (not shown). Families are never joined
///   into one frame.
/// - Codes are shown by the specification's meaning. An unknown code is shown
///   as unknown, never as the nearest known value. Raw codes stay in
///   Diagnostics.
/// - Nothing is derived: no lap prediction, no deltas the game did not send,
///   no tyre or handling verdicts, no slip interpreted as wheelspin or
///   lockup.
/// - Wheels reach the tabs only through `f1-wheels.ts`.
import type { AbsentItem } from "../components/live/NotAvailable";
import {
  FAMILY_FRESH_MS,
  familyFreshness,
  type FamilyFreshness,
} from "./f1-freshness.ts";
import type {
  CarStatus,
  CarTelemetry,
  CarTelemetryPacket,
  Code,
  F1LiveSnapshot,
  Fresh,
  LapData,
  LapDataPacket,
  MotionEx,
  Vector,
} from "./f1-player.ts";
import {
  F1_CORNERS,
  F1_CORNER_LABELS,
  f1Wheel,
  type F1Corner,
  type Wheels,
} from "./f1-wheels.ts";
import {
  UNAVAILABLE,
  barPercent,
  number,
  offsetClock,
  percent,
} from "./formatting.ts";
import type { GameActivity } from "./games.ts";
import type { BarReading, Reading } from "./live-layout.ts";

// ---------------------------------------------------------------- families

export type F1FamilyKey = "telemetry" | "status" | "lap" | "motion";

export const F1_FAMILY_NAMES: Record<F1FamilyKey, string> = {
  telemetry: "Car telemetry",
  status: "Car status",
  lap: "Lap data",
  motion: "Motion",
};

/// One family as the tabs use it: its freshness, and the player's values
/// only while they may be shown.
export interface Family<P> {
  key: F1FamilyKey;
  freshness: FamilyFreshness;
  ageMs: number | null;
  /// Null when the family is unavailable, never received, or carries no
  /// player (invalid player index).
  player: P | null;
}

/// The family's state in words, so it never rests on colour alone.
export interface FamilyStatus {
  key: F1FamilyKey;
  name: string;
  freshness: FamilyFreshness;
  text: string;
}

function family<P>(
  key: F1FamilyKey,
  fresh: Fresh<{ player: P | null }> | null,
): Family<P> {
  const freshness = familyFreshness(fresh?.age_ms);
  return {
    key,
    freshness,
    ageMs: fresh?.age_ms ?? null,
    player:
      fresh == null || freshness === "unavailable"
        ? null
        : (fresh.value.player ?? null),
  };
}

export interface F1Families {
  telemetry: Family<CarTelemetry>;
  status: Family<CarStatus>;
  lap: Family<LapData>;
  motion: Family<MotionEx>;
  /// Packet-level fields, under the same freshness as their family.
  telemetryPacket: CarTelemetryPacket | null;
  lapPacket: LapDataPacket | null;
}

export function f1Families(live: F1LiveSnapshot | null): F1Families {
  const telemetry = family<CarTelemetry>(
    "telemetry",
    live?.car_telemetry ?? null,
  );
  const lap = family<LapData>("lap", live?.lap_data ?? null);
  return {
    telemetry,
    status: family<CarStatus>("status", live?.car_status ?? null),
    lap,
    motion: family<MotionEx>("motion", live?.motion_ex ?? null),
    telemetryPacket:
      telemetry.freshness === "unavailable"
        ? null
        : (live?.car_telemetry?.value ?? null),
    lapPacket:
      lap.freshness === "unavailable" ? null : (live?.lap_data?.value ?? null),
  };
}

export function familyStatus(family: Family<unknown>): FamilyStatus {
  const name = F1_FAMILY_NAMES[family.key];
  let text: string;
  if (family.freshness === "unavailable") {
    text = family.ageMs == null ? "Not received" : "No current data";
  } else if (family.player == null) {
    text = "No player car";
  } else if (family.freshness === "stale") {
    text = `Not updating · ${number((family.ageMs ?? 0) / 1000, 1)} s`;
  } else {
    text = "Updating";
  }
  return { key: family.key, name, freshness: family.freshness, text };
}

// ---------------------------------------------------------------- readings

function read<P>(
  fam: Family<P>,
  key: string,
  label: string,
  unit: string | null,
  format: (player: P) => string,
  role: Reading["role"] = "home",
): Reading {
  const value = fam.player == null ? UNAVAILABLE : format(fam.player);
  const available = value !== UNAVAILABLE;
  return {
    key,
    label,
    value,
    unit,
    available,
    source: `f1.${fam.key}.${key}`,
    role,
    ...(available && fam.freshness === "stale" ? { stale: true } : {}),
  };
}

function bar<P>(
  fam: Family<P>,
  key: string,
  label: string,
  pick: (player: P) => number | null,
  {
    signed = false,
    scale = 1,
  }: {
    signed?: boolean;
    /// 1 for a 0..1 input shown as percent, 0.01 for one already 0..100.
    scale?: number;
  } = {},
): BarReading {
  const raw = fam.player == null ? null : pick(fam.player);
  const normalized = raw == null ? null : raw * scale;
  const value = percent(normalized, 0);
  const available = value !== UNAVAILABLE;
  return {
    key,
    label,
    value,
    unit: "%",
    available,
    signed,
    fraction: available ? barPercent(normalized) : null,
    source: `f1.${fam.key}.${key}`,
    role: "home",
    ...(available && fam.freshness === "stale" ? { stale: true } : {}),
  };
}

const int = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) ? UNAVAILABLE : String(value);

/// The specification's meaning with an initial capital, or "Unknown" for a
/// value it does not name. The raw code is in Diagnostics.
export function codeName(code: Code | null | undefined): string {
  if (code == null) return UNAVAILABLE;
  if (code.label == null) return "Unknown";
  return code.label.charAt(0).toUpperCase() + code.label.slice(1);
}

/// F1 25's gear is defined: R, N, 1–8. Any other code is unavailable, with a
/// note; it is never shown as a gear.
export function f1Gear(code: Code | null | undefined): string {
  return code?.label ?? UNAVAILABLE;
}

/// Exact: the game reports joules; 1 MJ = 1 000 000 J.
export function megajoules(joules: number | null | undefined): string {
  return joules == null ? UNAVAILABLE : number(joules / 1_000_000, 2);
}

/// Exact: milliseconds as seconds.
function seconds(ms: number | null | undefined, digits = 1): string {
  return ms == null ? UNAVAILABLE : number(ms / 1000, digits);
}

// ---------------------------------------------------------------- Overview

export interface F1RpmReading extends Reading {
  /// 0..100 between the car's idle and maximum RPM (Car Status), or null:
  /// no bar is drawn.
  fraction: number | null;
  idle: Reading;
  max: Reading;
}

export interface F1OverviewLayout {
  speed: Reading;
  gear: Reading;
  rpm: F1RpmReading;
  pedals: BarReading[];
  steering: BarReading;
  clutch: BarReading;
  drs: Reading[];
  ers: Reading[];
  car: Reading[];
  context: Reading[];
  families: FamilyStatus[];
  notes: AbsentItem[];
}

export function f1OverviewLayout(
  live: F1LiveSnapshot | null,
): F1OverviewLayout {
  const f = f1Families(live);
  const t = f.telemetry;
  const s = f.status;
  const idle = read(
    s,
    "idle_rpm",
    "Idle",
    "rpm",
    (p) => int(p.idle_rpm),
    "mirror",
  );
  const max = read(s, "max_rpm", "Max", "rpm", (p) => int(p.max_rpm), "mirror");
  const rpm = read(t, "engine_rpm", "Engine speed", "rpm", (p) =>
    int(p.engine_rpm),
  );
  const fraction =
    t.player && s.player && s.player.max_rpm > s.player.idle_rpm
      ? Math.min(
          100,
          Math.max(
            0,
            ((t.player.engine_rpm - s.player.idle_rpm) /
              (s.player.max_rpm - s.player.idle_rpm)) *
              100,
          ),
        )
      : null;
  const gear = read(t, "gear", "Gear", null, (p) => f1Gear(p.gear));
  const notes: AbsentItem[] = [];
  if (t.player && t.player.gear.label == null) {
    notes.push({
      key: "gear",
      label: "Gear",
      note: "Not shown. F1 25 sent a gear code its specification does not define.",
    });
  }
  return {
    speed: read(t, "speed_kmh", "Speed", "km/h", (p) => int(p.speed_kmh)),
    gear,
    rpm: { ...rpm, fraction, idle, max },
    pedals: [
      bar(t, "throttle", "Throttle", (p) => p.throttle),
      bar(t, "brake", "Brake", (p) => p.brake),
    ],
    steering: bar(t, "steer", "Steering", (p) => p.steer, { signed: true }),
    clutch: bar(t, "clutch", "Clutch", (p) => p.clutch, { scale: 0.01 }),
    drs: [
      read(t, "drs", "DRS", null, (p) => codeName(p.drs)),
      read(s, "drs_allowed", "DRS allowed", null, (p) =>
        codeName(p.drs_allowed),
      ),
      read(s, "drs_activation_distance_m", "DRS available in", null, (p) =>
        // The specification's own meaning: "0 = DRS not available".
        p.drs_activation_distance_m === 0
          ? "Not available"
          : `${p.drs_activation_distance_m} m`,
      ),
    ],
    ers: [
      read(s, "ers_store_energy_j", "ERS store", "MJ", (p) =>
        megajoules(p.ers_store_energy_j),
      ),
      read(s, "ers_deploy_mode", "ERS mode", null, (p) =>
        codeName(p.ers_deploy_mode),
      ),
    ],
    car: [
      read(s, "fuel_in_tank", "Fuel in tank", null, (p) =>
        number(p.fuel_in_tank, 2),
      ),
      read(s, "fuel_remaining_laps", "Fuel remaining", "laps", (p) =>
        number(p.fuel_remaining_laps, 2),
      ),
      read(s, "front_brake_bias_percent", "Brake bias (front)", "%", (p) =>
        int(p.front_brake_bias_percent),
      ),
    ],
    context: [
      read(
        f.lap,
        "current_lap_num",
        "Lap",
        null,
        (p) => int(p.current_lap_num),
        "mirror",
      ),
      read(
        f.lap,
        "car_position",
        "Position",
        null,
        (p) => int(p.car_position),
        "mirror",
      ),
      read(
        f.lap,
        "sector",
        "Sector",
        null,
        (p) => codeName(p.sector),
        "mirror",
      ),
      read(
        f.lap,
        "current_lap_time_ms",
        "Lap time",
        null,
        (p) => offsetClock(p.current_lap_time_ms),
        "mirror",
      ),
      read(
        f.lap,
        "last_lap_time_ms",
        "Last lap",
        null,
        (p) => offsetClock(p.last_lap_time_ms),
        "mirror",
      ),
    ],
    families: [familyStatus(t), familyStatus(s), familyStatus(f.lap)],
    notes,
  };
}

// -------------------------------------------------------------------- Race

export interface F1Group {
  key: string;
  title: string;
  family: FamilyStatus;
  readings: Reading[];
}

export interface F1RaceLayout {
  groups: F1Group[];
}

export function f1RaceLayout(live: F1LiveSnapshot | null): F1RaceLayout {
  const f = f1Families(live);
  const l = f.lap;
  const s = f.status;
  const lapStatus = familyStatus(l);
  return {
    groups: [
      {
        key: "lap",
        title: "Lap",
        family: lapStatus,
        readings: [
          read(l, "current_lap_num", "Current lap", null, (p) =>
            int(p.current_lap_num),
          ),
          read(l, "current_lap_time_ms", "Current lap time", null, (p) =>
            offsetClock(p.current_lap_time_ms),
          ),
          read(l, "last_lap_time_ms", "Last lap time", null, (p) =>
            offsetClock(p.last_lap_time_ms),
          ),
          read(l, "sector", "Current sector", null, (p) => codeName(p.sector)),
          read(l, "sector1_time", "Sector 1", null, (p) =>
            offsetClock(p.sector1_time.total_ms),
          ),
          read(l, "sector2_time", "Sector 2", null, (p) =>
            offsetClock(p.sector2_time.total_ms),
          ),
          read(l, "current_lap_invalid", "Current lap", null, (p) =>
            codeName(p.current_lap_invalid),
          ),
          read(l, "lap_distance_m", "Lap distance", "m", (p) =>
            number(p.lap_distance_m, 1),
          ),
          read(l, "safety_car_delta_s", "Safety car delta", "s", (p) =>
            number(p.safety_car_delta_s, 3),
          ),
        ],
      },
      {
        key: "standing",
        title: "Standing",
        family: lapStatus,
        readings: [
          read(l, "car_position", "Position", null, (p) => int(p.car_position)),
          read(l, "grid_position", "Grid position", null, (p) =>
            int(p.grid_position),
          ),
          read(l, "driver_status", "Driver status", null, (p) =>
            codeName(p.driver_status),
          ),
          read(l, "result_status", "Result status", null, (p) =>
            codeName(p.result_status),
          ),
        ],
      },
      {
        key: "pit",
        title: "Pit",
        family: lapStatus,
        readings: [
          read(l, "pit_status", "Pit status", null, (p) =>
            codeName(p.pit_status),
          ),
          read(l, "num_pit_stops", "Pit stops", null, (p) =>
            int(p.num_pit_stops),
          ),
          read(l, "pit_lane_timer_active", "Pit lane timer", null, (p) =>
            codeName(p.pit_lane_timer_active),
          ),
          read(l, "pit_lane_time_in_lane_ms", "Time in pit lane", "s", (p) =>
            seconds(p.pit_lane_time_in_lane_ms, 3),
          ),
          read(l, "pit_stop_timer_ms", "Pit stop time", "s", (p) =>
            seconds(p.pit_stop_timer_ms, 3),
          ),
        ],
      },
      {
        key: "penalties",
        title: "Penalties and warnings",
        family: lapStatus,
        readings: [
          read(l, "penalties_s", "Time penalties", "s", (p) =>
            int(p.penalties_s),
          ),
          read(l, "total_warnings", "Warnings", null, (p) =>
            int(p.total_warnings),
          ),
          read(
            l,
            "corner_cutting_warnings",
            "Corner-cutting warnings",
            null,
            (p) => int(p.corner_cutting_warnings),
          ),
          read(
            l,
            "num_unserved_drive_through_pens",
            "Unserved drive-throughs",
            null,
            (p) => int(p.num_unserved_drive_through_pens),
          ),
          read(l, "num_unserved_stop_go_pens", "Unserved stop-gos", null, (p) =>
            int(p.num_unserved_stop_go_pens),
          ),
        ],
      },
      {
        key: "energy",
        title: "Energy this lap",
        family: familyStatus(s),
        readings: [
          read(s, "ers_harvested_this_lap_mguk", "Harvested MGU-K", null, (p) =>
            number(p.ers_harvested_this_lap_mguk, 0),
          ),
          read(s, "ers_harvested_this_lap_mguh", "Harvested MGU-H", null, (p) =>
            number(p.ers_harvested_this_lap_mguh, 0),
          ),
          read(s, "ers_deployed_this_lap", "Deployed", null, (p) =>
            number(p.ers_deployed_this_lap, 0),
          ),
        ],
      },
      {
        key: "speed-trap",
        title: "Speed trap",
        family: lapStatus,
        readings: [
          read(
            l,
            "speed_trap_fastest_speed_kmh",
            "Fastest speed",
            "km/h",
            (p) => number(p.speed_trap_fastest_speed_kmh, 1),
          ),
          read(l, "speed_trap_fastest_lap", "On lap", null, (p) =>
            // The specification's own meaning: "255 = not set".
            p.speed_trap_fastest_lap === 255
              ? "Not set"
              : int(p.speed_trap_fastest_lap),
          ),
        ],
      },
    ],
  };
}

// ------------------------------------------------------------------- Tyres

export interface F1CornerLayout {
  corner: F1Corner;
  label: string;
  surface: Reading;
  inner: Reading;
  pressure: Reading;
  brake: Reading;
  surfaceType: Reading;
  wheelSpeed: Reading;
  slipRatio: Reading;
  slipAngle: Reading;
  suspension: Reading;
  vertForce: Reading;
}

export interface F1TyresLayout {
  /// Always FL, FR, RL, RR.
  corners: F1CornerLayout[];
  tyreSet: Reading[];
  families: FamilyStatus[];
}

function wheel<P, T>(
  fam: Family<P>,
  corner: F1Corner,
  key: string,
  label: string,
  unit: string | null,
  pick: (player: P) => Wheels<T>,
  format: (value: T) => string,
): Reading {
  return {
    ...read(fam, key, label, unit, (p) => format(f1Wheel(pick(p), corner))),
    source: `f1.${fam.key}.${key}.${corner}`,
  };
}

const float = (digits: number) => (value: number | null) =>
  number(value, digits);

export function f1TyresLayout(live: F1LiveSnapshot | null): F1TyresLayout {
  const f = f1Families(live);
  const t = f.telemetry;
  const m = f.motion;
  const corners = F1_CORNERS.map(
    (corner): F1CornerLayout => ({
      corner,
      label: F1_CORNER_LABELS[corner],
      surface: wheel(
        t,
        corner,
        "tyres_surface_temperature_c",
        "Surface",
        "°C",
        (p) => p.tyres_surface_temperature_c,
        int,
      ),
      inner: wheel(
        t,
        corner,
        "tyres_inner_temperature_c",
        "Inner",
        "°C",
        (p) => p.tyres_inner_temperature_c,
        int,
      ),
      pressure: wheel(
        t,
        corner,
        "tyres_pressure_psi",
        "Pressure",
        "psi",
        (p) => p.tyres_pressure_psi,
        float(1),
      ),
      brake: wheel(
        t,
        corner,
        "brakes_temperature_c",
        "Brake",
        "°C",
        (p) => p.brakes_temperature_c,
        int,
      ),
      surfaceType: wheel(
        t,
        corner,
        "surface_type",
        "Surface type",
        null,
        (p) => p.surface_type,
        codeName,
      ),
      wheelSpeed: wheel(
        m,
        corner,
        "wheel_speed",
        "Wheel speed",
        null,
        (p) => p.wheel_speed,
        float(2),
      ),
      slipRatio: wheel(
        m,
        corner,
        "wheel_slip_ratio",
        "Slip ratio",
        null,
        (p) => p.wheel_slip_ratio,
        float(3),
      ),
      slipAngle: wheel(
        m,
        corner,
        "wheel_slip_angle",
        "Slip angle",
        null,
        (p) => p.wheel_slip_angle,
        float(3),
      ),
      suspension: wheel(
        m,
        corner,
        "suspension_position",
        "Suspension position",
        null,
        (p) => p.suspension_position,
        float(2),
      ),
      vertForce: wheel(
        m,
        corner,
        "wheel_vert_force",
        "Vertical force",
        null,
        (p) => p.wheel_vert_force,
        float(0),
      ),
    }),
  );
  const s = f.status;
  return {
    corners,
    tyreSet: [
      read(s, "actual_tyre_compound", "Actual compound", null, (p) =>
        codeName(p.actual_tyre_compound),
      ),
      read(s, "visual_tyre_compound", "Visual compound", null, (p) =>
        codeName(p.visual_tyre_compound),
      ),
      read(s, "tyres_age_laps", "Tyre age", "laps", (p) =>
        int(p.tyres_age_laps),
      ),
    ],
    families: [familyStatus(t), familyStatus(m), familyStatus(s)],
  };
}

// ---------------------------------------------------------------- Dynamics

export interface F1AxisRow {
  key: string;
  label: string;
  unit: string;
  values: Reading[];
}

export interface F1WheelRow {
  key: string;
  label: string;
  /// Empty when the specification states no unit.
  unit: string;
  /// FL, FR, RL, RR.
  values: Reading[];
}

export interface F1DynamicsLayout {
  axes: F1AxisRow[];
  scalars: Reading[];
  wheels: F1WheelRow[];
  family: FamilyStatus;
}

export function f1DynamicsLayout(
  live: F1LiveSnapshot | null,
): F1DynamicsLayout {
  const m = f1Families(live).motion;
  const axis = (
    key: string,
    label: string,
    unit: string,
    pick: (p: MotionEx) => Vector,
  ): F1AxisRow => ({
    key,
    label,
    unit,
    values: (["x", "y", "z"] as const).map((component) => ({
      ...read(
        m,
        `${key}.${component}`,
        `${label} ${component.toUpperCase()}`,
        unit,
        (p) => number(pick(p)[component], 3),
      ),
    })),
  });
  const wheelRow = (
    key: keyof MotionEx,
    label: string,
    unit: string,
    digits: number,
  ): F1WheelRow => ({
    key,
    label,
    unit,
    values: F1_CORNERS.map((corner) =>
      wheel(
        m,
        corner,
        key,
        `${label} ${corner}`,
        unit || null,
        (p) => p[key] as Wheels<number | null>,
        float(digits),
      ),
    ),
  });
  const scalar = (
    key: keyof MotionEx,
    label: string,
    unit: string | null,
    digits: number,
  ) =>
    read(m, key, label, unit, (p) => number(p[key] as number | null, digits));
  return {
    axes: [
      axis(
        "local_velocity_mps",
        "Local velocity",
        "m/s",
        (p) => p.local_velocity_mps,
      ),
      axis(
        "angular_velocity_rad_s",
        "Angular velocity",
        "rad/s",
        (p) => p.angular_velocity_rad_s,
      ),
      axis(
        "angular_acceleration_rad_s2",
        "Angular acceleration",
        "rad/s²",
        (p) => p.angular_acceleration_rad_s2,
      ),
    ],
    scalars: [
      scalar("front_wheels_angle_rad", "Front wheels angle", "rad", 4),
      scalar("height_of_cog_above_ground", "Centre of gravity height", null, 4),
      scalar("chassis_yaw_rad", "Chassis yaw", "rad", 4),
      scalar("chassis_pitch_rad", "Chassis pitch", "rad", 4),
      scalar("front_roll_angle", "Front roll angle", null, 4),
      scalar("rear_roll_angle", "Rear roll angle", null, 4),
      scalar("front_aero_height", "Front plank height", null, 4),
      scalar("rear_aero_height", "Rear plank height", null, 4),
    ],
    wheels: [
      wheelRow("suspension_position", "Suspension position", "", 2),
      wheelRow("suspension_velocity", "Suspension velocity", "", 2),
      wheelRow("suspension_acceleration", "Suspension acceleration", "", 1),
      wheelRow("wheel_speed", "Wheel speed", "", 2),
      wheelRow("wheel_slip_ratio", "Slip ratio", "", 3),
      wheelRow("wheel_slip_angle", "Slip angle", "", 3),
      wheelRow("wheel_lat_force", "Lateral force", "", 0),
      wheelRow("wheel_long_force", "Longitudinal force", "", 0),
      wheelRow("wheel_vert_force", "Vertical force", "", 0),
      wheelRow("wheel_camber_rad", "Camber", "rad", 4),
    ],
    family: familyStatus(m),
  };
}

// ---------------------------------------------------- workspace availability

export type F1LiveAvailability =
  | "live"
  | "not_driving"
  | "no_player"
  | "paused";

export interface F1LiveBanner {
  availability: F1LiveAvailability;
  headline: string;
  reason: string;
}

/// Why the F1 25 view is not showing current driving values, or null when it
/// is. The same words as the top bar for the same state.
export function f1LiveBanner(
  live: F1LiveSnapshot | null,
  activity: GameActivity,
  lastAcceptedAgeMs: number | null,
): F1LiveBanner | null {
  if (activity === "stale" || activity === "inactive") {
    return {
      availability: "paused",
      headline: "Paused",
      reason: `F1 25 stopped sending telemetry${
        lastAcceptedAgeMs == null
          ? ""
          : ` ${number(lastAcceptedAgeMs / 1000, 0)} s ago`
      }. Nothing below is presented as current.`,
    };
  }
  if (live != null && live.player_car_index != null && !live.player_available) {
    return {
      availability: "no_player",
      headline: "No player car",
      reason:
        "F1 25 is not reporting a player car — for example while spectating — so no player values are shown.",
    };
  }
  if (activity === "detected") {
    return {
      availability: "not_driving",
      headline: "Connected · not driving",
      reason: `F1 25 is connected but has not sent driving telemetry in the last ${number(
        FAMILY_FRESH_MS / 1000,
        0,
      )} s — usually a menu, a loading screen or a pause.`,
    };
  }
  return null;
}
