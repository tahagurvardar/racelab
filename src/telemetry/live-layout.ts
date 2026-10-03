/// The four Live tabs as data: what each tab shows, in what order and with
/// what weight.
///
/// Every value here comes from the V1.0 builders in `telemetry-view-model.ts`
/// — the same formatting, units and "unavailable is not zero" rules, already
/// covered by their own tests. This module adds no conversion and no meaning.
/// It only regroups readings and tags each one with:
///
/// - `source`: the canonical field it presents (or `absent.*` for a field the
///   canonical model deliberately does not carry). Wheel fields name the
///   corner code (`wheels.FL.temperature_c`), never the canonical field name,
///   so the corner mapping still lives in exactly one module.
/// - `role`: `home` on the one tab that owns the field, `mirror` where a
///   primary reading is repeated on purpose (Overview shows RPM, power and
///   torque; Dynamics shows speed). Every field has exactly one home.
import { UNAVAILABLE, barPercent } from "./formatting.ts";
import {
  CORNER_LABELS,
  WHEEL_CORNERS,
  buildDynamics,
  buildEngine,
  buildInputs,
  buildOverview,
  buildRace,
  buildSuspension,
  buildTires,
  wheelOf,
  type BarMetric,
  type LiveFrameState,
  type Metric,
  type WheelCorner,
} from "./telemetry-view-model.ts";

export type ReadingRole = "home" | "mirror";

export interface Reading extends Metric {
  source: string;
  role: ReadingRole;
  /// Set only by a game whose values can age independently (F1 25's packet
  /// families): the value is real but no longer updating. Never set for FH6.
  stale?: boolean;
}

export interface BarReading extends BarMetric {
  source: string;
  role: ReadingRole;
  /// See `Reading.stale`.
  stale?: boolean;
}

function tag(
  metric: Metric,
  source: string,
  role: ReadingRole = "home",
): Reading {
  return { ...metric, source, role };
}

function tagBar(
  metric: BarMetric,
  source: string,
  role: ReadingRole = "home",
): BarReading {
  return { ...metric, source, role };
}

function reading(
  key: string,
  label: string,
  value: string,
  unit: string | null,
  source: string,
  role: ReadingRole = "home",
): Reading {
  return {
    key,
    label,
    value,
    unit,
    available: value !== UNAVAILABLE,
    source,
    role,
  };
}

function byKey<T extends Metric>(metrics: T[], key: string): T {
  const found = metrics.find((metric) => metric.key === key);
  if (!found) throw new Error(`live layout: no metric ${key}`);
  return found;
}

// ------------------------------------------------------------- Overview

export interface RpmReading extends Reading {
  /// 0..100 position between idle and maximum, or null: no bar is drawn.
  fraction: number | null;
  max: Reading;
}

export interface OverviewLayout {
  speed: Reading;
  rpm: RpmReading;
  power: Reading;
  torque: Reading;
  gear: Reading;
  /// The pedals, in the order a driver reads them.
  pedals: BarReading[];
  steering: BarReading;
  /// Clutch and handbrake: present, quieter.
  auxiliary: BarReading[];
  race: Reading[];
  identity: Reading[];
  /// Race channels FH6 transmits that are not canonical.
  unavailable: Reading[];
}

export function overviewLayout(state: LiveFrameState): OverviewLayout {
  const overview = buildOverview(state);
  const engine = buildEngine(state);
  const inputs = buildInputs(state);
  const race = buildRace(state);
  const bar = (key: string) => byKey(inputs.bars, key);
  return {
    speed: reading("speed", "Speed", overview.speedKmh, "km/h", "speed_mps"),
    rpm: {
      ...reading(
        "rpm",
        "Engine speed",
        overview.rpm,
        "rpm",
        "engine.rpm",
        "mirror",
      ),
      fraction: overview.rpmFraction,
      max: reading(
        "max-rpm",
        "Max",
        overview.maxRpm,
        "rpm",
        "engine.max_rpm",
        "mirror",
      ),
    },
    power: tag(byKey(engine.output, "power"), "engine.power_w", "mirror"),
    torque: tag(byKey(engine.output, "torque"), "engine.torque_nm", "mirror"),
    gear: tag(overview.gear, "gear"),
    pedals: [
      tagBar(bar("throttle"), "controls.throttle"),
      tagBar(bar("brake"), "controls.brake"),
    ],
    steering: tagBar(bar("steering"), "controls.steering"),
    auxiliary: [
      tagBar(bar("clutch"), "controls.clutch"),
      tagBar(bar("handbrake"), "controls.handbrake"),
    ],
    // The exact race time stands for both V1.0 race-time readings: they are
    // the same canonical seconds in two formats, and the exact one is the
    // complete statement of it.
    race: [
      tag(
        { ...byKey(race.timing, "race-time-precise"), label: "Race time" },
        "race.race_time_seconds",
      ),
      tag(byKey(race.standing, "lap"), "race.lap_number"),
      tag(byKey(race.standing, "position"), "race.race_position"),
      tag(byKey(race.timing, "game-clock"), "game_timestamp_ms"),
    ],
    identity: [
      tag(byKey(overview.identity, "vehicle"), "vehicle_id"),
      tag(byKey(overview.identity, "game"), "game"),
    ],
    unavailable: [
      tag(byKey(race.unavailable, "current-lap"), "absent.current_lap"),
      tag(byKey(race.unavailable, "last-lap"), "absent.last_lap"),
      tag(byKey(race.unavailable, "best-lap"), "absent.best_lap"),
      tag(byKey(race.unavailable, "distance"), "absent.distance"),
    ],
  };
}

// ----------------------------------------------------------- Powertrain

export interface PowertrainLayout {
  rpm: Reading;
  /// 0..100 position between idle and maximum, or null: no bar is drawn.
  rpmFraction: number | null;
  idle: Reading;
  max: Reading;
  power: Reading;
  /// The same canonical watts, unconverted.
  powerWatts: Reading;
  torque: Reading;
  /// Vehicle configuration codes: static, so below the live readings.
  configuration: Reading[];
  unavailable: Reading[];
}

export function powertrainLayout(state: LiveFrameState): PowertrainLayout {
  const engine = buildEngine(state);
  const overview = buildOverview(state);
  const config = (key: string) => byKey(overview.configuration, key);
  return {
    rpm: tag(
      { ...byKey(engine.range, "rpm"), label: "Engine speed" },
      "engine.rpm",
    ),
    rpmFraction: engine.rpmFraction,
    idle: tag(
      { ...byKey(engine.range, "idle"), label: "Idle" },
      "engine.idle_rpm",
    ),
    max: tag({ ...byKey(engine.range, "max"), label: "Max" }, "engine.max_rpm"),
    power: tag(byKey(engine.output, "power"), "engine.power_w"),
    powerWatts: tag(byKey(engine.output, "power-w"), "engine.power_w"),
    torque: tag(byKey(engine.output, "torque"), "engine.torque_nm"),
    configuration: [
      tag(config("class"), "vehicle.class_code"),
      tag(config("pi"), "vehicle.performance_index"),
      tag(config("drivetrain"), "vehicle.drivetrain_code"),
      tag(config("cylinders"), "vehicle.cylinders"),
    ],
    unavailable: [
      tag(byKey(engine.unavailable, "boost"), "absent.boost"),
      tag(byKey(engine.unavailable, "fuel"), "absent.fuel"),
    ],
  };
}

// -------------------------------------------------------------- Chassis

export interface CornerLayout {
  corner: WheelCorner;
  label: string;
  temperature: Reading;
  slipRatio: Reading;
  slipAngle: Reading;
  combinedSlip: Reading;
  rotation: Reading;
  /// The same rotation in rev/min.
  rotationRpm: Reading;
  travelNormalized: Reading;
  travel: Reading;
  /// Normalized travel as a 0..100 bar position (0 full extension, 100 full
  /// compression), or null when unavailable. The printed value is never
  /// clamped; only the bar is.
  travelFraction: number | null;
}

export interface ChassisLayout {
  /// Always FL, FR, RL, RR.
  corners: CornerLayout[];
  unavailable: Reading[];
}

/// Tyre and suspension channels per corner. Corners are looked up by code and
/// emitted in `WHEEL_CORNERS` order; nothing here can reorder them.
export function chassisLayout(state: LiveFrameState): ChassisLayout {
  const tires = buildTires(state);
  const suspension = buildSuspension(state);
  const corners = WHEEL_CORNERS.map((corner): CornerLayout => {
    const tire = tires.rows.find((row) => row.corner === corner)!.values;
    const travel = suspension.rows.find((row) => row.corner === corner)!.values;
    const at = (metrics: Metric[], key: string, field: string) =>
      tag(byKey(metrics, `${corner}-${key}`), `wheels.${corner}.${field}`);
    const normalized = wheelOf(
      state.frame?.wheels,
      corner,
    )?.normalized_suspension_travel;
    const travelNormalized = at(
      travel,
      "normalized",
      "normalized_suspension_travel",
    );
    return {
      corner,
      label: CORNER_LABELS[corner],
      temperature: at(tire, "temperature", "temperature_c"),
      slipRatio: at(tire, "slip-ratio", "slip_ratio"),
      slipAngle: at(tire, "slip-angle", "slip_angle"),
      combinedSlip: at(tire, "combined-slip", "combined_slip"),
      rotation: at(tire, "rotation", "rotation_rad_s"),
      rotationRpm: at(tire, "rotation-rpm", "rotation_rad_s"),
      travelNormalized,
      travel: at(travel, "meters", "suspension_travel_m"),
      travelFraction:
        travelNormalized.available && normalized != null
          ? Math.min(100, Math.max(0, barPercent(Math.max(0, normalized))))
          : null,
    };
  });
  return {
    corners,
    unavailable: [
      tag(byKey(tires.unavailable, "rumble-strip"), "absent.rumble_strip"),
      tag(byKey(tires.unavailable, "puddle"), "absent.puddle_depth"),
      tag(byKey(tires.unavailable, "surface-rumble"), "absent.surface_rumble"),
    ],
  };
}

// ------------------------------------------------------------- Dynamics

export interface AxisRow {
  key: string;
  label: string;
  unit: string;
  /// X, Y, Z in source order. Never renamed lateral or longitudinal.
  values: [Reading, Reading, Reading];
}

export interface DynamicsLayout {
  speed: Reading;
  speedMps: Reading;
  /// Axis-oriented quantities in the source axes, exactly as received.
  axes: AxisRow[];
  /// Yaw, pitch, roll — the documented meaning of the orientation vector.
  attitude: [Reading, Reading, Reading];
}

export function dynamicsLayout(state: LiveFrameState): DynamicsLayout {
  const model = buildDynamics(state);
  const row = (
    key: string,
    label: string,
    unit: string,
    metrics: Metric[],
    field: string,
  ): AxisRow => ({
    key,
    label,
    unit,
    values: ["x", "y", "z"].map((axis, index) =>
      tag(metrics[index], `${field}.${axis}`),
    ) as [Reading, Reading, Reading],
  });
  return {
    speed: reading(
      "speed",
      "Speed",
      model.speedKmh,
      "km/h",
      "speed_mps",
      "mirror",
    ),
    speedMps: reading(
      "speed-mps",
      "Speed",
      model.speedMps,
      "m/s",
      "speed_mps",
      "mirror",
    ),
    axes: [
      row("velocity", "Velocity", "m/s", model.velocity, "velocity"),
      row(
        "acceleration",
        "Acceleration",
        "m/s²",
        model.acceleration,
        "acceleration",
      ),
      row(
        "acceleration-g",
        "Acceleration",
        "g",
        model.accelerationG,
        "acceleration",
      ),
      row(
        "angular",
        "Angular velocity",
        "rad/s",
        model.angularVelocity,
        "angular_velocity",
      ),
      row("position", "Position", "m", model.position, "position"),
    ],
    attitude: [
      tag(byKey(model.orientation, "yaw"), "orientation.x"),
      tag(byKey(model.orientation, "pitch"), "orientation.y"),
      tag(byKey(model.orientation, "roll"), "orientation.z"),
    ],
  };
}
