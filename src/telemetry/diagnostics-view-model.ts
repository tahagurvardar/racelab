/// The only module permitted to read `frame.sourceSpecific`.
///
/// Everything here is engineering data: adapter-owned values whose units,
/// wheel order or enum meanings are not established, plus transport counters.
/// Nothing in this file may be imported by a product dashboard view. Values are
/// presented as the numbers the adapter decoded, with no unit asserted and no
/// meaning inferred for an opaque code.
import type { TelemetryFrame } from "./frame.ts";
import {
  GEAR_UNVALIDATED,
  NEVER_OBSERVED as NEVER_OBSERVED_FIELD,
  NO_CANONICAL_FIELD,
  NOT_DECODED,
  gameName,
} from "./telemetry-view-model.ts";
import type { LiveSnapshot } from "./live-snapshot.ts";
import type { StatsSnapshot } from "../telemetry-state.ts";
import {
  UNAVAILABLE,
  ageMs,
  code,
  hertz,
  integer,
  namedCode,
  number,
  text,
  type NamedCode,
} from "./formatting.ts";

export interface DiagnosticEntry {
  key: string;
  label: string;
  value: string;
  /// Only set where the value is an unvalidated adapter reading.
  caveat?: string;
  /// Set for a backend state or identifier code: `value` is its readable
  /// name, and this is the verbatim code, or null when the name already shows
  /// it (see `namedCode`).
  code?: string | null;
}

function named(key: string, label: string, raw: NamedCode): DiagnosticEntry {
  return { key, label, value: raw.name, code: raw.code };
}

/// The recorder's own state codes, spelled out. Nothing is renamed.
const RECORDER_STATES = {
  idle: "Idle",
  recording: "Recording",
  error: "Error",
} as const;

export function recorderState(
  status: string | null | undefined,
): DiagnosticEntry {
  return named("status", "Status", namedCode(status, RECORDER_STATES));
}

const UNVERIFIED_UNIT = "Raw adapter value; unit unverified.";
const NEVER_OBSERVED =
  "Raw adapter value; every captured packet holds zero, so unit and meaning are unestablished.";
const SOURCE_ORDER =
  "Exact wire value in packet-offset order. The canonical frame carries the same reading resolved to a corner.";
const OPAQUE_CODE = "Opaque code; no meaning inferred.";

function entry(
  key: string,
  label: string,
  value: string,
  caveat?: string,
): DiagnosticEntry {
  return { key, label, value, ...(caveat ? { caveat } : {}) };
}

/// The adapter envelope shape the FH6 adapter serializes. Only the fields
/// Diagnostics displays are named; everything else stays untouched.
interface Fh6Envelope {
  car_class?: number;
  car_performance_index?: number;
  car_ordinal?: number;
  drivetrain_type?: number;
  num_cylinders?: number;
  gear?: number;
  power?: number;
  torque?: number;
  boost?: number;
  fuel?: number;
  tire_temperatures?: number[];
  normalized_suspension_travel?: number[];
  tire_slip_ratio?: number[];
  wheel_rotation_rad_s?: number[];
  tire_slip_angle?: number[];
  tire_combined_slip?: number[];
  suspension_travel_metres?: number[];
  distance_traveled?: number;
  best_lap?: number;
  last_lap?: number;
  current_lap?: number;
  current_race_time?: number;
  lap_number?: number;
  race_position?: number;
  is_race_on?: number;
  timestamp_ms?: number;
}

function envelope(frame: TelemetryFrame | null): Fh6Envelope | null {
  const source = frame?.sourceSpecific;
  if (!source || typeof source !== "object") return null;
  const fh6 = (source as { fh6?: unknown }).fh6;
  return fh6 && typeof fh6 === "object" ? (fh6 as Fh6Envelope) : null;
}

/// Adapter values with unverified units. Presented as raw numbers so no
/// dashboard reader can mistake them for validated measurements.
export function fh6Vehicle(frame: TelemetryFrame | null): DiagnosticEntry[] {
  const fh6 = envelope(frame);
  return [
    entry("ordinal", "Car ordinal", code(fh6?.car_ordinal), OPAQUE_CODE),
    entry("class", "Car class code", code(fh6?.car_class), OPAQUE_CODE),
    entry(
      "pi",
      "Performance index",
      code(fh6?.car_performance_index),
      OPAQUE_CODE,
    ),
    entry(
      "drivetrain",
      "Drivetrain code",
      code(fh6?.drivetrain_type),
      OPAQUE_CODE,
    ),
    entry("cylinders", "Cylinders", code(fh6?.num_cylinders), OPAQUE_CODE),
    entry("race-on", "isRaceOn", code(fh6?.is_race_on)),
    entry("clock", "Game clock", integer(fh6?.timestamp_ms)),
  ];
}

/// The raw FH6 gear code. This is the only place it appears in the product, and
/// it is labelled a code, never a gear.
export function fh6GearCode(frame: TelemetryFrame | null): DiagnosticEntry {
  return entry(
    "gear-code",
    "Gear (raw code)",
    code(envelope(frame)?.gear),
    "Raw FH6 byte. Gear semantics are unestablished, so this is never shown as a gear in the dashboard.",
  );
}

export function fh6Powertrain(frame: TelemetryFrame | null): DiagnosticEntry[] {
  const fh6 = envelope(frame);
  return [
    entry("power", "Power (wire)", number(fh6?.power, 1), SOURCE_ORDER),
    entry("torque", "Torque (wire)", number(fh6?.torque, 1), SOURCE_ORDER),
    entry("boost", "Boost", number(fh6?.boost, 3), UNVERIFIED_UNIT),
    entry("fuel", "Fuel", number(fh6?.fuel, 3), UNVERIFIED_UNIT),
  ];
}

/// Every per-wheel channel in **source index order**, exactly as the adapter
/// read it off the wire. The product views read named corners instead; keeping
/// the source order here is what makes a suspected corner swap debuggable.
const WHEEL_CHANNELS: {
  key: string;
  label: string;
  field: keyof Fh6Envelope;
  digits: number;
}[] = [
  {
    key: "tire-temp",
    label: "Tire temperature (°F)",
    field: "tire_temperatures",
    digits: 1,
  },
  {
    key: "travel-normalized",
    label: "Normalized suspension travel",
    field: "normalized_suspension_travel",
    digits: 4,
  },
  {
    key: "travel-m",
    label: "Suspension travel (m)",
    field: "suspension_travel_metres",
    digits: 5,
  },
  {
    key: "slip-ratio",
    label: "Tire slip ratio",
    field: "tire_slip_ratio",
    digits: 4,
  },
  {
    key: "slip-angle",
    label: "Tire slip angle",
    field: "tire_slip_angle",
    digits: 4,
  },
  {
    key: "combined-slip",
    label: "Tire combined slip",
    field: "tire_combined_slip",
    digits: 4,
  },
  {
    key: "rotation",
    label: "Wheel rotation (rad/s)",
    field: "wheel_rotation_rad_s",
    digits: 3,
  },
];

export function fh6TireTemperatures(
  frame: TelemetryFrame | null,
): DiagnosticEntry[] {
  const fh6 = envelope(frame);
  return WHEEL_CHANNELS.flatMap((channel) => {
    const values = fh6?.[channel.field] as number[] | undefined;
    return [0, 1, 2, 3].map((index) =>
      entry(
        `${channel.key}-${index}`,
        `${channel.label} ${index}`,
        number(values?.[index], channel.digits),
        SOURCE_ORDER,
      ),
    );
  });
}

export function fh6Race(frame: TelemetryFrame | null): DiagnosticEntry[] {
  const fh6 = envelope(frame);
  return [
    entry(
      "lap-number",
      "Lap number (wire)",
      code(fh6?.lap_number),
      SOURCE_ORDER,
    ),
    entry(
      "race-position",
      "Race position (wire)",
      code(fh6?.race_position),
      SOURCE_ORDER,
    ),
    entry(
      "race-time",
      "Race time (wire)",
      number(fh6?.current_race_time, 3),
      SOURCE_ORDER,
    ),
    entry(
      "current-lap",
      "Current lap",
      number(fh6?.current_lap, 3),
      NEVER_OBSERVED,
    ),
    entry("last-lap", "Last lap", number(fh6?.last_lap, 3), NEVER_OBSERVED),
    entry("best-lap", "Best lap", number(fh6?.best_lap, 3), NEVER_OBSERVED),
    entry(
      "distance",
      "Distance travelled",
      number(fh6?.distance_traveled, 1),
      NEVER_OBSERVED,
    ),
  ];
}

/// The protocol identifier the backend classified, with the game it names
/// when it names one (the same mapping the top bar uses).
function protocolEntry(protocol: string | null | undefined): DiagnosticEntry {
  const game = gameName(protocol);
  return named(
    "protocol",
    "Protocol",
    namedCode(protocol, protocol && game ? { [protocol]: game } : {}),
  );
}

/// Transport and protocol engineering counters.
export function protocolDiagnostics(
  snapshot: LiveSnapshot | null,
): DiagnosticEntry[] {
  return [
    protocolEntry(snapshot?.protocol),
    entry(
      "confidence",
      "Protocol confidence",
      snapshot == null
        ? UNAVAILABLE
        : `${(snapshot.protocol_confidence * 100).toFixed(0)}%`,
    ),
    entry("input-hz", "Packet rate", hertz(snapshot?.input_packet_hz)),
    entry("frame-hz", "Valid frame rate", hertz(snapshot?.valid_frame_hz)),
    entry("packet-age", "Last packet age", ageMs(snapshot?.last_packet_age_ms)),
    entry(
      "frame-age",
      "Last valid frame age",
      ageMs(snapshot?.last_valid_frame_age_ms),
    ),
    entry(
      "receive-errors",
      "Receive errors",
      integer(snapshot?.receive_errors),
    ),
    entry("active", "FH6 active", integer(snapshot?.valid_active_fh6)),
    entry(
      "inactive",
      "FH6 inactive (menus/loading)",
      integer(snapshot?.valid_inactive_fh6),
    ),
    entry("invalid", "Invalid FH6", integer(snapshot?.invalid_fh6)),
    entry("unknown", "Unknown protocol", integer(snapshot?.unknown_protocol)),
  ];
}

export function hubDiagnostics(
  snapshot: LiveSnapshot | null,
): DiagnosticEntry[] {
  const hub = snapshot?.hub;
  return [
    entry("published", "Frames published", integer(hub?.published)),
    entry(
      "recent",
      "Recent-frame ring",
      hub == null
        ? UNAVAILABLE
        : `${integer(hub.recent_frames)} / ${integer(hub.ring_capacity)}`,
    ),
    entry("evictions", "Ring evictions", integer(hub?.ring_evictions)),
    entry("subscribers", "Subscribers", integer(hub?.subscribers)),
    entry("drops", "Subscriber drops", integer(hub?.subscriber_drops)),
    entry("grace", "Grace period", ageMs(snapshot?.grace_period_ms)),
  ];
}

export function transportDiagnostics(
  stats: StatsSnapshot | null,
): DiagnosticEntry[] {
  return [
    entry("bound-port", "Bound port", code(stats?.bound_port)),
    entry("source", "Last source", text(stats?.last_source)),
    entry(
      "packet-size",
      "Last packet size",
      stats?.last_packet_size == null
        ? UNAVAILABLE
        : `${stats.last_packet_size} B`,
    ),
    entry("packets", "Packets", integer(stats?.total_packets)),
    entry("pps", "Packets / sec", number(stats?.packets_per_second, 1)),
    entry("bytes", "Total bytes", integer(stats?.total_bytes)),
    entry("errors", "Receive errors", integer(stats?.receive_errors)),
    entry(
      "rcvbuf",
      "SO_RCVBUF readback",
      integer(stats?.receive_buffer_bytes),
      "Winsock readback, not proof of queue capacity.",
    ),
  ];
}

/// Fields RaceLab does not present as live readings, each with the same
/// reason the product gives where the value would appear. Nothing here is
/// decoded or reinterpreted; it is the list of what is deliberately absent.
export function deferredFields(): DiagnosticEntry[] {
  // The product's sentence, minus what this table already says: the value
  // column reads "Not shown", and the pointer to Diagnostics is redundant here.
  const here = (reason: string) =>
    reason
      .replace(/^Not shown\. /, "")
      .replace(/ The raw value is in Diagnostics\.$/, "");
  return [
    entry("gear", "Gear", "Not shown", here(GEAR_UNVALIDATED)),
    entry("boost", "Boost", "Not shown", here(NO_CANONICAL_FIELD)),
    entry("fuel", "Fuel", "Not shown", here(NO_CANONICAL_FIELD)),
    entry(
      "current-lap",
      "Current lap time",
      "Not shown",
      here(NEVER_OBSERVED_FIELD),
    ),
    entry("last-lap", "Last lap time", "Not shown", here(NEVER_OBSERVED_FIELD)),
    entry("best-lap", "Best lap time", "Not shown", here(NEVER_OBSERVED_FIELD)),
    entry(
      "distance",
      "Distance travelled",
      "Not shown",
      here(NEVER_OBSERVED_FIELD),
    ),
    entry("rumble", "Rumble strip", "Not shown", here(NEVER_OBSERVED_FIELD)),
    entry("puddle", "Puddle depth", "Not shown", here(NEVER_OBSERVED_FIELD)),
    entry("surface-rumble", "Surface rumble", "Not shown", here(NOT_DECODED)),
  ];
}
