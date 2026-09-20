/// The only module permitted to read `frame.sourceSpecific`.
///
/// Everything here is engineering data: adapter-owned values whose units,
/// wheel order or enum meanings are not established, plus transport counters.
/// Nothing in this file may be imported by a product dashboard view. Values are
/// presented as the numbers the adapter decoded, with no unit asserted and no
/// meaning inferred for an opaque code.
import type { TelemetryFrame } from "./frame.ts";
import type { LiveSnapshot } from "./live-snapshot.ts";
import type { StatsSnapshot } from "../telemetry-state.ts";
import {
  UNAVAILABLE,
  ageMs,
  code,
  hertz,
  integer,
  number,
  text,
} from "./formatting.ts";

export interface DiagnosticEntry {
  key: string;
  label: string;
  value: string;
  /// Only set where the value is an unvalidated adapter reading.
  caveat?: string;
}

const UNVERIFIED_UNIT = "Raw adapter value; unit unverified.";
const UNVERIFIED_ORDER = "Raw adapter value; wheel order and unit unverified.";
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
    entry("power", "Power", number(fh6?.power, 1), UNVERIFIED_UNIT),
    entry("torque", "Torque", number(fh6?.torque, 1), UNVERIFIED_UNIT),
    entry("boost", "Boost", number(fh6?.boost, 3), UNVERIFIED_UNIT),
    entry("fuel", "Fuel", number(fh6?.fuel, 3), UNVERIFIED_UNIT),
  ];
}

/// Four values ordered exactly by the packet offsets the adapter read. They are
/// deliberately not labelled FL/FR/RL/RR: the wheel order is unverified.
export function fh6TireTemperatures(
  frame: TelemetryFrame | null,
): DiagnosticEntry[] {
  const temperatures = envelope(frame)?.tire_temperatures;
  return [0, 1, 2, 3].map((index) =>
    entry(
      `tire-${index}`,
      `Tire temperature ${index}`,
      number(temperatures?.[index], 1),
      UNVERIFIED_ORDER,
    ),
  );
}

export function fh6Race(frame: TelemetryFrame | null): DiagnosticEntry[] {
  const fh6 = envelope(frame);
  return [
    entry("lap-number", "Lap number", code(fh6?.lap_number), UNVERIFIED_UNIT),
    entry(
      "race-position",
      "Race position",
      code(fh6?.race_position),
      UNVERIFIED_UNIT,
    ),
    entry(
      "current-lap",
      "Current lap",
      number(fh6?.current_lap, 3),
      UNVERIFIED_UNIT,
    ),
    entry("last-lap", "Last lap", number(fh6?.last_lap, 3), UNVERIFIED_UNIT),
    entry("best-lap", "Best lap", number(fh6?.best_lap, 3), UNVERIFIED_UNIT),
    entry(
      "race-time",
      "Race time",
      number(fh6?.current_race_time, 3),
      UNVERIFIED_UNIT,
    ),
    entry(
      "distance",
      "Distance travelled",
      number(fh6?.distance_traveled, 1),
      UNVERIFIED_UNIT,
    ),
  ];
}

/// Transport and protocol engineering counters.
export function protocolDiagnostics(
  snapshot: LiveSnapshot | null,
): DiagnosticEntry[] {
  return [
    entry("protocol", "Protocol", text(snapshot?.protocol)),
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
        : `${hub.recent_frames.toLocaleString()} / ${hub.ring_capacity.toLocaleString()}`,
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
