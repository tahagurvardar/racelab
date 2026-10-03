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
import type { TelemetryFrame, Vector3, Wheel, Wheels } from "./frame.ts";
import type { LiveSnapshot } from "./live-snapshot.ts";
import {
  UNAVAILABLE,
  code,
  degrees,
  elapsed,
  gForce,
  integer,
  kilowatts,
  lapTime,
  millimetres,
  number,
  percent,
  rangeFraction,
  revolutionsPerMinute,
  speedKmh,
  text,
} from "./formatting.ts";

/// Why a value cannot be shown, in words a driver can read. These are
/// statements about what RaceLab has established, not claims about what the
/// game transmits; the raw values themselves stay in Diagnostics.
export const NO_CANONICAL_FIELD =
  "Not shown. Forza Horizon 6 sends this value, but its unit has not been verified. The raw value is in Diagnostics.";
export const NOT_DECODED =
  "Not shown. RaceLab does not read this value from Forza Horizon 6.";
/// The FH6 bytes exist and are preserved, but every captured packet held zero,
/// so nothing about the value has been established.
export const NEVER_OBSERVED =
  "Not shown. Forza Horizon 6 has sent zero here in every recording so far, so what it means is unknown.";
export const GEAR_UNVALIDATED =
  "Not shown. What Forza Horizon 6's gear value means has not been confirmed. The raw value is in Diagnostics.";

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

/// The one place a canonical corner maps to a field of `Wheels`. The backend
/// already resolved wheel identity from the source protocol; this is a name
/// lookup, never a reordering.
const CORNER_FIELDS: Record<WheelCorner, keyof Wheels> = {
  FL: "front_left",
  FR: "front_right",
  RL: "rear_left",
  RR: "rear_right",
};

export function wheelOf(
  wheels: Wheels | undefined,
  corner: WheelCorner,
): Wheel | undefined {
  return wheels?.[CORNER_FIELDS[corner]];
}

/// The inverse of `CORNER_FIELDS`, derived from it rather than written out a
/// second time. Derived session analysis names its corners with the canonical
/// snake_case codes the backend serializes (`front_left`, …); this turns one
/// into the corner the rest of the frontend already speaks, so no second module
/// ever has to repeat the mapping. An unrecognised code returns null instead of
/// guessing a corner.
const CANONICAL_CORNERS = new Map<string, WheelCorner>(
  WHEEL_CORNERS.map((corner) => [CORNER_FIELDS[corner], corner]),
);

export function cornerOf(
  canonical: string | null | undefined,
): WheelCorner | null {
  return canonical == null ? null : (CANONICAL_CORNERS.get(canonical) ?? null);
}

/// The corner's display label, or `UNAVAILABLE` for an event that belongs to no
/// particular corner. Never invents a corner for an unknown code.
export function cornerLabelOf(canonical: string | null | undefined): string {
  const corner = cornerOf(canonical);
  return corner == null ? UNAVAILABLE : CORNER_LABELS[corner];
}

/// A per-corner value set keyed by the *canonical* field names, which is how
/// derived analysis serializes one. Declared in terms of `Wheels` rather than
/// by spelling the four names again, so there is still exactly one place in the
/// frontend that knows them.
export type CanonicalCornerSet<T> = Record<keyof Wheels, T>;

/// Always FL, FR, RL, RR, with each corner's label attached. Any module that
/// needs to walk an analysis's per-corner values uses this instead of indexing
/// the object itself, which is how a corner would get transposed.
export function canonicalCornerRows<T>(
  values: CanonicalCornerSet<T>,
): CornerRow<T>[] {
  return WHEEL_CORNERS.map((corner) => ({
    corner,
    label: CORNER_LABELS[corner],
    values: values[CORNER_FIELDS[corner]],
  }));
}

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
        "RaceLab is not listening for telemetry, so nothing from the game can arrive. Restarting RaceLab starts it again.",
    };
  }
  if (!snapshot) {
    return {
      frame: null,
      availability: "waiting",
      reason: "RaceLab is starting.",
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
          "Telemetry is degraded: RaceLab recently saw invalid packets or dropped telemetry frames, so no reading is presented as current.",
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
          "RaceLab is listening and connects on its own as soon as Forza Horizon 6 or F1 25 sends telemetry.",
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

/// The product name for a protocol/game code, or null for a code RaceLab does
/// not know. Shared by the live status and the recorded-session views.
export function gameName(code: string | null | undefined): string | null {
  return code === "fh6" ? "Forza Horizon 6" : null;
}

export function gameLabel(snapshot: LiveSnapshot | null): string {
  return gameName(snapshot?.protocol) ?? "No game detected";
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

/// A recording that is failing, in the words a user needs.
///
/// This is the disk-full case above all others. The recorder already refuses to
/// pretend — it finalizes an honestly incomplete manifest and reports the write
/// error — but through V0.10 that error only ever appeared in Diagnostics, so a
/// user whose disk filled mid-session saw a normal-looking dashboard and lost
/// the recording silently. A failure to record is a product-level failure and
/// belongs in the global banner.
export function recordingPresentation(
  recording: boolean,
  recorderStatus: string | null | undefined,
): { value: string; tone: StatusTone } {
  if (recorderStatus === "error") {
    return { value: "Recording failed", tone: "bad" };
  }
  return recording
    ? { value: "Recording", tone: "good" }
    : { value: "Not recording", tone: "neutral" };
}

export function buildStatus(
  snapshot: LiveSnapshot | null,
  recording: boolean,
  transportError: string | null,
  recorder?: { status: string; last_error: string | null } | null,
): StatusModel {
  const connection = connectionPresentation(snapshot);
  const session = sessionPresentation(snapshot);
  const health = snapshot?.health ?? "LOST";
  const recordingState = recordingPresentation(recording, recorder?.status);
  // Only a recorder that is actually in its error state contributes a banner. A
  // `last_error` left over from an earlier failure must not keep alarming a
  // user whose recording has since recovered.
  const recorderBanner =
    recorder?.status === "error"
      ? (recorder.last_error ?? "RaceLab could not write this recording.")
      : null;
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
        recordingState.value,
        recordingState.tone,
      ),
    ],
    banner:
      transportError ?? snapshot?.transport_error ?? recorderBanner ?? null,
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
  configuration: Metric[];
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
      // The product name, not the protocol code; an unknown code is shown
      // as-is rather than guessed.
      metric("game", "Game", text(gameName(frame?.game) ?? frame?.game)),
    ],
    // Codes, never names. RaceLab has no class or drivetrain database, so each
    // of these renders as the integer the game sent and nothing more.
    configuration: [
      metric("class", "Class code", code(frame?.vehicle.class_code)),
      metric("pi", "Performance index", code(frame?.vehicle.performance_index)),
      metric(
        "drivetrain",
        "Drivetrain code",
        code(frame?.vehicle.drivetrain_code),
      ),
      metric("cylinders", "Cylinders", code(frame?.vehicle.cylinders)),
    ],
  };
}

export interface EngineModel {
  rpm: string;
  rpmFraction: number | null;
  range: Metric[];
  /// Promoted engine output. Canonical units are W and N·m; kW is an exact
  /// presentation conversion of the same canonical watts.
  output: Metric[];
  /// Engine channels FH6 transmits that stay uncanonicalized.
  unavailable: Metric[];
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
      metric("power", "Power", kilowatts(engine?.power_w), "kW"),
      metric("power-w", "Power", number(engine?.power_w, 0), "W"),
      metric("torque", "Torque", number(engine?.torque_nm, 1), "N·m"),
    ],
    unavailable: [
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

/// Canonical per-wheel channels, in the order each corner panel renders them.
/// A channel is listed here only once its meaning is established; the FH6
/// rumble-strip, puddle-depth and surface-rumble bytes are preserved on the
/// wire but never reached this list, so they cannot appear as a zero.
const TIRE_CHANNELS = [
  {
    key: "temperature",
    label: "Temperature",
    unit: "°C",
    render: (wheel?: Wheel) => number(wheel?.temperature_c, 1),
  },
  {
    key: "slip-ratio",
    label: "Slip ratio",
    unit: null,
    render: (wheel?: Wheel) => number(wheel?.slip_ratio, 3),
  },
  {
    key: "slip-angle",
    label: "Slip angle",
    unit: null,
    render: (wheel?: Wheel) => number(wheel?.slip_angle, 3),
  },
  {
    key: "combined-slip",
    label: "Combined slip",
    unit: null,
    render: (wheel?: Wheel) => number(wheel?.combined_slip, 3),
  },
  {
    key: "rotation",
    label: "Wheel rotation",
    unit: "rad/s",
    render: (wheel?: Wheel) => number(wheel?.rotation_rad_s, 1),
  },
  {
    key: "rotation-rpm",
    label: "Wheel rotation",
    unit: "rpm",
    render: (wheel?: Wheel) => revolutionsPerMinute(wheel?.rotation_rad_s),
  },
] as const;

const SUSPENSION_CHANNELS = [
  {
    key: "normalized",
    label: "Normalized travel",
    unit: null,
    render: (wheel?: Wheel) => number(wheel?.normalized_suspension_travel, 3),
  },
  {
    key: "meters",
    label: "Travel",
    unit: "mm",
    render: (wheel?: Wheel) => millimetres(wheel?.suspension_travel_m),
  },
] as const;

type WheelChannel = {
  key: string;
  label: string;
  unit: string | null;
  render: (wheel?: Wheel) => string;
};

/// Builds a corner set by name lookup through `wheelOf`. Every corner runs the
/// same channel list in the same order, so a corner cannot acquire a different
/// set of values from its neighbours.
function cornerSet(
  frame: TelemetryFrame | null,
  channels: readonly WheelChannel[],
): CornerSet<Metric[]> {
  const build = (corner: WheelCorner) => {
    const wheel = wheelOf(frame?.wheels, corner);
    return channels.map((channel) =>
      metric(
        `${corner}-${channel.key}`,
        channel.label,
        channel.render(wheel),
        channel.unit,
      ),
    );
  };
  return { FL: build("FL"), FR: build("FR"), RL: build("RL"), RR: build("RR") };
}

export interface CornerModel {
  rows: CornerRow<Metric[]>[];
  /// True once canonical per-wheel data exists for this channel group. It does
  /// not mean a live frame is present: a corner reads `—` with no live frame.
  available: boolean;
  reason: string;
  /// Channels FH6 transmits that are deliberately not canonical.
  unavailable: Metric[];
}

export function buildTires(state: LiveFrameState): CornerModel {
  return {
    rows: cornerRows(cornerSet(state.frame, TIRE_CHANNELS)),
    available: true,
    reason: "",
    unavailable: [
      absent("rumble-strip", "Rumble strip", NEVER_OBSERVED),
      absent("puddle", "Puddle depth", NEVER_OBSERVED),
      absent("surface-rumble", "Surface rumble", NOT_DECODED),
    ],
  };
}

export function buildSuspension(state: LiveFrameState): CornerModel {
  return {
    rows: cornerRows(cornerSet(state.frame, SUSPENSION_CHANNELS)),
    available: true,
    reason: "",
    unavailable: [],
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

/// Canonical race telemetry as schema v2 carries it. Lap timing and the game's
/// own distance counter are not fields of the canonical frame: no FH6 capture
/// has ever held a non-zero value for them, so their unit and semantics are
/// unestablished and they are not reconstructed from adapter data here.
export interface CanonicalRace {
  lapNumber: number | null;
  position: number | null;
  raceTimeSeconds: number | null;
}

export const NO_RACE_DATA: CanonicalRace = {
  lapNumber: null,
  position: null,
  raceTimeSeconds: null,
};

/// Reads canonical data only; it never falls back to the adapter envelope.
export function canonicalRace(frame: TelemetryFrame | null): CanonicalRace {
  if (!frame) return NO_RACE_DATA;
  return {
    lapNumber: frame.race.lap_number,
    position: frame.race.race_position,
    raceTimeSeconds: frame.race.race_time_seconds,
  };
}

export interface RaceModel {
  timing: Metric[];
  standing: Metric[];
  /// Lap-timing channels FH6 transmits that stay uncanonicalized.
  unavailable: Metric[];
}

export function buildRace(state: LiveFrameState): RaceModel {
  const race = canonicalRace(state.frame);
  return {
    timing: [
      metric("race-time", "Race time", elapsed(race.raceTimeSeconds)),
      metric(
        "race-time-precise",
        "Race time (exact)",
        lapTime(race.raceTimeSeconds),
      ),
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
    standing: [
      metric("lap", "Lap", integer(race.lapNumber)),
      metric("position", "Position", integer(race.position)),
    ],
    unavailable: [
      absent("current-lap", "Current lap", NEVER_OBSERVED),
      absent("last-lap", "Last lap", NEVER_OBSERVED),
      absent("best-lap", "Best lap", NEVER_OBSERVED),
      absent("distance", "Distance", NEVER_OBSERVED),
    ],
  };
}
