/// Presentation boundary between `get_live_telemetry` and the dashboard views.
///
/// Every product view consumes the models built here and nothing else. Two
/// rules are enforced in this module rather than in components:
///
/// 1. Canonical only. Nothing here reads `frame.sourceSpecific`. Adapter data
///    is reachable exclusively through `diagnostics-view-model.ts`.
/// 2. Unavailable is not zero. A field the backend reports as null, or any
///    field with no canonical representation yet, renders as `UNAVAILABLE` and
///    carries a note explaining why.
import type { TelemetryFrame, Vector3 } from "./frame.ts";
import type { LiveSnapshot } from "./live-snapshot.ts";
import {
  UNAVAILABLE,
  degrees,
  elapsed,
  gForce,
  integer,
  lapTime,
  number,
  percent,
  rangeFraction,
  speedKmh,
  text,
} from "./formatting.ts";

/// Why a value cannot be shown. These are product statements about the RaceLab
/// canonical model, not claims about what any game transmits.
export const NO_CANONICAL_FIELD =
  "Not in canonical telemetry. The FH6 value exists but its units are unverified, so it stays in Diagnostics.";
export const NOT_DECODED =
  "Not in canonical telemetry. The FH6 adapter does not decode this field.";
export const GEAR_UNVALIDATED =
  "FH6 gear semantics are not established. The raw code is in Diagnostics and is never shown as a gear.";

export interface Metric {
  key: string;
  label: string;
  /// Already formatted. `UNAVAILABLE` whenever `available` is false.
  value: string;
  unit: string | null;
  available: boolean;
  note?: string;
}

/// A bar is drawn only when `fraction` is a number. A `signed` value keeps its
/// sign in `value` while the bar shows magnitude.
export interface BarMetric extends Metric {
  fraction: number | null;
  signed: boolean;
}

export const WHEEL_CORNERS = ["FL", "FR", "RL", "RR"] as const;
export type WheelCorner = (typeof WHEEL_CORNERS)[number];

export const CORNER_LABELS: Record<WheelCorner, string> = {
  FL: "Front left",
  FR: "Front right",
  RL: "Rear left",
  RR: "Rear right",
};

/// A per-wheel value set keyed by corner. Building rows from this shape is the
/// only way corners reach the UI, so a corner cannot be silently reordered.
export type CornerSet<T> = Record<WheelCorner, T>;

export interface CornerRow<T> {
  corner: WheelCorner;
  label: string;
  values: T;
}

/// Always emits FL, FR, RL, RR in that order.
export function cornerRows<T>(values: CornerSet<T>): CornerRow<T>[] {
  return WHEEL_CORNERS.map((corner) => ({
    corner,
    label: CORNER_LABELS[corner],
    values: values[corner],
  }));
}

function metric(
  key: string,
  label: string,
  value: string,
  unit: string | null = null,
  note?: string,
): Metric {
  const available = value !== UNAVAILABLE;
  return { key, label, value, unit, available, ...(note ? { note } : {}) };
}

/// A field with no canonical representation. Always unavailable, always
/// explained; it can never become a zero.
function absent(key: string, label: string, note: string): Metric {
  return { key, label, value: UNAVAILABLE, unit: null, available: false, note };
}

function bar(
  key: string,
  label: string,
  normalized: number | null | undefined,
  { signed = false }: { signed?: boolean } = {},
): BarMetric {
  const value = percent(normalized, 0);
  const available = value !== UNAVAILABLE;
  return {
    key,
    label,
    value,
    unit: "%",
    available,
    signed,
    fraction: available
      ? Math.min(100, Math.abs(normalized as number) * 100)
      : null,
  };
}

// ---------------------------------------------------------------------------
// Live frame resolution
// ---------------------------------------------------------------------------

export type TelemetryAvailability =
  | "live"
  | "waiting"
  | "idle"
  | "grace"
  | "stale"
  | "stopped";

export interface LiveFrameState {
  /// Null whenever telemetry must not be presented as current, so a stale
  /// reading can never survive on screen.
  frame: TelemetryFrame | null;
  availability: TelemetryAvailability;
  /// A complete sentence for the empty state; state is never colour alone.
  reason: string;
}

/// The backend already withholds `frame` when telemetry is stale. This adds the
/// listener-stopped case and classifies why values are unavailable, so each
/// view can say so instead of showing an old number.
export function resolveLiveFrame(
  snapshot: LiveSnapshot | null,
  listenerRunning: boolean,
): LiveFrameState {
  if (!listenerRunning) {
    return {
      frame: null,
      availability: "stopped",
      reason:
        "The UDP listener is stopped. Start it from Diagnostics to receive telemetry.",
    };
  }
  if (!snapshot) {
    return {
      frame: null,
      availability: "waiting",
      reason: "Connecting to the RaceLab backend…",
    };
  }
  const frame = snapshot.stale ? null : snapshot.frame;
  if (frame && frame.active) {
    return { frame, availability: "live", reason: "" };
  }
  switch (snapshot.connection) {
    case "GRACE":
      return {
        frame: null,
        availability: "grace",
        reason:
          "Telemetry paused. The session is held open until driving resumes.",
      };
    case "SESSION_ACTIVE":
    case "CONNECTED_IDLE":
      return {
        frame: null,
        availability: "idle",
        reason:
          "Connected, but the game is not sending active driving telemetry. Values stay unavailable instead of showing the last reading.",
      };
    case "DEGRADED":
      return {
        frame: null,
        availability: "stale",
        reason:
          "Telemetry is degraded. Recent packets failed validation, so no reading is presented as current.",
      };
    case "ERROR":
      return {
        frame: null,
        availability: "stopped",
        reason: text(snapshot.transport_error),
      };
    default:
      return {
        frame: null,
        availability: "waiting",
        reason:
          "Waiting for a supported game. RaceLab listens automatically and connects on its own.",
      };
  }
}

// ---------------------------------------------------------------------------
// Global status
// ---------------------------------------------------------------------------

export type StatusTone = "neutral" | "good" | "warn" | "bad";

export interface StatusItem {
  key: string;
  label: string;
  value: string;
  tone: StatusTone;
  /// Redundant with `tone` on purpose: state is never communicated by colour
  /// alone. Rendered as a glyph beside the text.
  glyph: string;
}

const GLYPHS: Record<StatusTone, string> = {
  neutral: "○",
  good: "●",
  warn: "◐",
  bad: "✕",
};

function status(
  key: string,
  label: string,
  value: string,
  tone: StatusTone,
): StatusItem {
  return { key, label, value, tone, glyph: GLYPHS[tone] };
}

export function gameLabel(snapshot: LiveSnapshot | null): string {
  return snapshot?.protocol === "fh6" ? "Forza Horizon 6" : "No game detected";
}

export function connectionPresentation(snapshot: LiveSnapshot | null): {
  value: string;
  tone: StatusTone;
} {
  switch (snapshot?.connection) {
    case "STARTING":
      return { value: "Starting", tone: "neutral" };
    case "LISTENING":
      return { value: "Waiting for game", tone: "neutral" };
    case "PROBING":
      return { value: "Detecting game", tone: "warn" };
    case "CONNECTED_IDLE":
    case "SESSION_ACTIVE":
      return { value: "Connected", tone: "good" };
    case "GRACE":
      return { value: "Telemetry paused", tone: "warn" };
    case "DEGRADED":
      return { value: "Degraded", tone: "warn" };
    case "DISCONNECTED":
      return { value: "Waiting for game", tone: "neutral" };
    case "ERROR":
      return { value: "Connection error", tone: "bad" };
    default:
      return { value: "Connecting", tone: "neutral" };
  }
}

export function sessionPresentation(snapshot: LiveSnapshot | null): {
  value: string;
  tone: StatusTone;
} {
  const session = snapshot?.session;
  if (!session) return { value: "No session", tone: "neutral" };
  switch (session.state) {
    case "ACTIVE":
      return { value: "Session active", tone: "good" };
    case "GRACE":
      return {
        value: `Session grace · ${number((session.grace_remaining_ms ?? 0) / 1000, 0)} s left`,
        tone: "warn",
      };
    default:
      return { value: "Session completed", tone: "neutral" };
  }
}

export interface StatusModel {
  product: string;
  game: string;
  vehicleId: string;
  sessionDuration: string;
  items: StatusItem[];
  /// Present only when something needs attention.
  banner: string | null;
}

export function buildStatus(
  snapshot: LiveSnapshot | null,
  recording: boolean,
  transportError: string | null,
): StatusModel {
  const connection = connectionPresentation(snapshot);
  const session = sessionPresentation(snapshot);
  const health = snapshot?.health ?? "LOST";
  return {
    product: "RaceLab",
    game: gameLabel(snapshot),
    vehicleId: text(
      snapshot?.session?.vehicle_id ?? snapshot?.frame?.vehicle_id,
    ),
    sessionDuration: snapshot?.session
      ? elapsed(snapshot.session.duration_ms / 1000)
      : UNAVAILABLE,
    items: [
      status("connection", "Connection", connection.value, connection.tone),
      status(
        "health",
        "Health",
        health === "GOOD"
          ? "Good"
          : health === "DEGRADED"
            ? "Degraded"
            : "No signal",
        health === "GOOD" ? "good" : health === "DEGRADED" ? "warn" : "neutral",
      ),
      status("session", "Session", session.value, session.tone),
      status(
        "recording",
        "Recording",
        recording ? "Recording" : "Not recording",
        recording ? "good" : "neutral",
      ),
    ],
    banner: transportError ?? snapshot?.transport_error ?? null,
  };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/// Canonical gear only. `unmapped` is an adapter code, not a gear, so it is
/// never rendered as one.
export function gearMetric(frame: TelemetryFrame | null): Metric {
  const gear = frame?.gear;
  switch (gear?.kind) {
    case "reverse":
      return metric("gear", "Gear", "R");
    case "neutral":
      return metric("gear", "Gear", "N");
    case "forward":
      return metric("gear", "Gear", String(gear.value));
    default:
      return absent("gear", "Gear", GEAR_UNVALIDATED);
  }
}

export interface OverviewModel {
  speedKmh: string;
  rpm: string;
  rpmFraction: number | null;
  maxRpm: string;
  gear: Metric;
  inputs: BarMetric[];
  identity: Metric[];
}

export function buildOverview(state: LiveFrameState): OverviewModel {
  const frame = state.frame;
  const engine = frame?.engine;
  return {
    speedKmh: speedKmh(frame?.speed_mps),
    rpm: number(engine?.rpm, 0),
    rpmFraction: rangeFraction(engine?.rpm, engine?.idle_rpm, engine?.max_rpm),
    maxRpm: number(engine?.max_rpm, 0),
    gear: gearMetric(frame),
    inputs: [
      bar("throttle", "Throttle", frame?.controls.throttle),
      bar("brake", "Brake", frame?.controls.brake),
      bar("steering", "Steering", frame?.controls.steering, { signed: true }),
    ],
    identity: [
      metric("vehicle", "Vehicle ID", text(frame?.vehicle_id)),
      metric("game", "Game", text(frame?.game)),
    ],
  };
}

export interface EngineModel {
  rpm: string;
  rpmFraction: number | null;
  range: Metric[];
  output: Metric[];
}

export function buildEngine(state: LiveFrameState): EngineModel {
  const engine = state.frame?.engine;
  return {
    rpm: number(engine?.rpm, 0),
    rpmFraction: rangeFraction(engine?.rpm, engine?.idle_rpm, engine?.max_rpm),
    range: [
      metric("rpm", "Current RPM", number(engine?.rpm, 0), "rpm"),
      metric("idle", "Idle RPM", number(engine?.idle_rpm, 0), "rpm"),
      metric("max", "Max RPM", number(engine?.max_rpm, 0), "rpm"),
    ],
    output: [
      absent("power", "Power", NO_CANONICAL_FIELD),
      absent("torque", "Torque", NO_CANONICAL_FIELD),
      absent("boost", "Boost", NO_CANONICAL_FIELD),
      absent("fuel", "Fuel", NO_CANONICAL_FIELD),
    ],
  };
}

/// Axis components are labelled X/Y/Z exactly as the source supplies them. The
/// vehicle-axis orientation is not established, so no component is called
/// lateral or longitudinal anywhere in the product.
function axisMetrics(
  key: string,
  vector: Vector3 | null | undefined,
  unit: string,
  digits: number,
): Metric[] {
  return (["x", "y", "z"] as const).map((axis) =>
    metric(
      `${key}-${axis}`,
      axis.toUpperCase(),
      number(vector?.[axis], digits),
      unit,
    ),
  );
}

export interface DynamicsModel {
  speedKmh: string;
  speedMps: string;
  acceleration: Metric[];
  accelerationG: Metric[];
  velocity: Metric[];
  angularVelocity: Metric[];
  orientation: Metric[];
  position: Metric[];
}

export function buildDynamics(state: LiveFrameState): DynamicsModel {
  const frame = state.frame;
  const accel = frame?.acceleration;
  const orientation = frame?.orientation;
  return {
    speedKmh: speedKmh(frame?.speed_mps, 1),
    speedMps: number(frame?.speed_mps, 2),
    acceleration: axisMetrics("accel", accel, "m/s²", 2),
    accelerationG: (["x", "y", "z"] as const).map((axis) =>
      metric(
        `accel-g-${axis}`,
        `Accel ${axis.toUpperCase()}`,
        gForce(accel?.[axis]),
        "g",
      ),
    ),
    velocity: axisMetrics("velocity", frame?.velocity, "m/s", 2),
    angularVelocity: axisMetrics(
      "angular",
      frame?.angular_velocity,
      "rad/s",
      3,
    ),
    // Canonical orientation is documented as x = yaw, y = pitch, z = roll.
    orientation: [
      metric("yaw", "Yaw", degrees(orientation?.x), "°"),
      metric("pitch", "Pitch", degrees(orientation?.y), "°"),
      metric("roll", "Roll", degrees(orientation?.z), "°"),
    ],
    position: axisMetrics("position", frame?.position, "m", 1),
  };
}

interface Channel {
  key: string;
  label: string;
  note: string;
}

const TIRE_CHANNELS: Channel[] = [
  { key: "temperature", label: "Temperature", note: NO_CANONICAL_FIELD },
  { key: "slip-ratio", label: "Slip ratio", note: NOT_DECODED },
  { key: "slip-angle", label: "Slip angle", note: NOT_DECODED },
  { key: "combined-slip", label: "Combined slip", note: NOT_DECODED },
  { key: "rotation", label: "Wheel rotation", note: NOT_DECODED },
  { key: "rumble-strip", label: "Rumble strip", note: NOT_DECODED },
  { key: "puddle", label: "Puddle depth", note: NOT_DECODED },
  { key: "surface-rumble", label: "Surface rumble", note: NOT_DECODED },
];

const SUSPENSION_CHANNELS: Channel[] = [
  { key: "normalized", label: "Normalized travel", note: NOT_DECODED },
  { key: "meters", label: "Travel", note: NOT_DECODED },
];

/// Canonical telemetry carries no per-wheel channel today. The corner layout is
/// still built from a `CornerSet`, so the FL/FR/RL/RR mapping is fixed and
/// tested now and stays correct when canonical wheel data arrives.
function emptyCornerSet(channels: Channel[]): CornerSet<Metric[]> {
  const build = (corner: WheelCorner) =>
    channels.map((channel) =>
      absent(`${corner}-${channel.key}`, channel.label, channel.note),
    );
  return { FL: build("FL"), FR: build("FR"), RL: build("RL"), RR: build("RR") };
}

export interface CornerModel {
  rows: CornerRow<Metric[]>[];
  /// False while no canonical per-wheel channel exists.
  available: boolean;
  reason: string;
}

export function buildTires(): CornerModel {
  return {
    rows: cornerRows(emptyCornerSet(TIRE_CHANNELS)),
    available: false,
    reason:
      "Canonical telemetry carries no per-wheel tire channel. FH6 transmits four tire temperatures, but their wheel order and units are unverified, so they appear only as raw adapter values in Diagnostics.",
  };
}

export function buildSuspension(): CornerModel {
  return {
    rows: cornerRows(emptyCornerSet(SUSPENSION_CHANNELS)),
    available: false,
    reason:
      "Canonical telemetry carries no suspension channel. The FH6 adapter does not decode suspension travel; those bytes stay opaque rather than guessed.",
  };
}

export interface InputsModel {
  bars: BarMetric[];
}

export function buildInputs(state: LiveFrameState): InputsModel {
  const controls = state.frame?.controls;
  return {
    bars: [
      bar("throttle", "Throttle", controls?.throttle),
      bar("brake", "Brake", controls?.brake),
      bar("clutch", "Clutch", controls?.clutch),
      bar("handbrake", "Handbrake", controls?.handbrake),
      bar("steering", "Steering", controls?.steering, { signed: true }),
    ],
  };
}

/// Canonical race telemetry. FH6 supplies none of these through the canonical
/// model yet, so each value resolves through the same formatter it will use
/// when it does: adding the field becomes a data change, not a UI change.
export interface CanonicalRace {
  lapNumber: number | null;
  position: number | null;
  currentLapSeconds: number | null;
  lastLapSeconds: number | null;
  bestLapSeconds: number | null;
  raceTimeSeconds: number | null;
  distanceMeters: number | null;
}

export const NO_RACE_DATA: CanonicalRace = {
  lapNumber: null,
  position: null,
  currentLapSeconds: null,
  lastLapSeconds: null,
  bestLapSeconds: null,
  raceTimeSeconds: null,
  distanceMeters: null,
};

/// Canonical `TelemetryFrame` has no race fields. This reads only canonical
/// data and therefore always reports none; it never falls back to the adapter.
export function canonicalRace(_frame: TelemetryFrame | null): CanonicalRace {
  return NO_RACE_DATA;
}

export interface RaceModel {
  timing: Metric[];
  standing: Metric[];
  available: boolean;
  reason: string;
}

export function buildRace(state: LiveFrameState): RaceModel {
  const race = canonicalRace(state.frame);
  const note = NO_CANONICAL_FIELD;
  const explain = (m: Metric): Metric => (m.available ? m : { ...m, note });
  return {
    timing: [
      metric("current-lap", "Current lap", lapTime(race.currentLapSeconds)),
      metric("last-lap", "Last lap", lapTime(race.lastLapSeconds)),
      metric("best-lap", "Best lap", lapTime(race.bestLapSeconds)),
      metric("race-time", "Race time", lapTime(race.raceTimeSeconds)),
    ].map(explain),
    standing: [
      ...[
        metric("lap", "Lap", integer(race.lapNumber)),
        metric("position", "Position", integer(race.position)),
        metric("distance", "Distance", number(race.distanceMeters, 0), "m"),
      ].map(explain),
      // Canonical and unrelated to race timing: unavailable here only means
      // there is no live frame, so it carries no adapter caveat.
      metric(
        "game-clock",
        "Game clock",
        state.frame?.game_timestamp_ms == null
          ? UNAVAILABLE
          : elapsed(state.frame.game_timestamp_ms / 1000),
      ),
    ],
    available: false,
    reason:
      "Canonical telemetry carries no lap or race timing. FH6 transmits lap counters and lap times, but their units and sentinel conventions are unverified, so they stay raw adapter values in Diagnostics.",
  };
}
