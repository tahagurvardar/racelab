/// F1 Telemetry Lab lap comparison (v2.2 M5): the current lap against the
/// reference lap at the same point of the circuit, for speed, throttle,
/// brake and steering.
///
/// The comparison runs only where M4 allows it: on Distance sync, between
/// two different laps that `comparisonReadiness` qualifies. Both laps are
/// read on one shared distance grid over the stretch both recorded, at the
/// coarser of their two bucket widths. At each grid position a lap's value
/// is its last recorded reading at or before that distance (`valueAt`):
/// nothing is interpolated, carried across a telemetry gap or filled in
/// where either lap has no reading. A channel compared over too little of
/// that stretch reports why instead of figures.
///
/// No time delta is computed here; that is M6. Plain TypeScript with no
/// React import, tested under Node.
import {
  valueAt,
  type SessionTrace,
  type TraceAxisId,
  type TraceChannelId,
} from "./telemetry-lab.ts";
import { UNAVAILABLE } from "./telemetry/formatting.ts";

export type CompareChannel = Extract<
  TraceChannelId,
  "speed" | "throttle" | "brake" | "steering"
>;

export const COMPARE_CHANNELS: CompareChannel[] = [
  "speed",
  "throttle",
  "brake",
  "steering",
];

/// Share of the shared grid a channel must be read on in both laps before
/// its figures are reported.
export const MIN_COMPARED_SHARE = 0.95;
/// The finest grid step, metres, whatever the bucket widths.
export const MIN_GRID_STEP_M = 1;

export interface ChannelComparison {
  channel: CompareChannel;
  /// Current minus reference at each grid position; null where either lap
  /// has no reading there.
  differences: (number | null)[];
  /// Grid positions read in both laps, and their share of the grid.
  compared: number;
  share: number;
  /// Null when the channel was compared over too little of the grid.
  summary: {
    /// Mean of current minus reference over the compared positions.
    meanDifference: number;
    /// The largest difference either way, and where it is.
    largest: { x: number; difference: number };
  } | null;
  /// Why `summary` is null.
  reason: string | null;
}

export type LapComparison =
  | {
      available: true;
      /// The shared distance stretch, metres.
      x0: number;
      x1: number;
      step: number;
      positions: number[];
      channels: Record<CompareChannel, ChannelComparison>;
    }
  | { available: false; reason: string };

export interface ComparisonInput {
  axis: TraceAxisId;
  current: SessionTrace | null;
  reference: SessionTrace | null;
  /// M4's gate (`comparisonReadiness`) for the same two laps and traces.
  readiness: { ready: boolean; reasons: string[] };
}

function compareChannel(
  id: CompareChannel,
  current: SessionTrace,
  reference: SessionTrace,
  positions: number[],
): ChannelComparison {
  const differences: (number | null)[] = [];
  let compared = 0;
  let sum = 0;
  let largest: { x: number; difference: number } | null = null;
  for (const x of positions) {
    const a = valueAt(current, id, x);
    const b = valueAt(reference, id, x);
    if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) {
      differences.push(null);
      continue;
    }
    const difference = a - b;
    differences.push(difference);
    compared += 1;
    sum += difference;
    if (
      largest == null ||
      Math.abs(difference) > Math.abs(largest.difference)
    ) {
      largest = { x, difference };
    }
  }
  const share = positions.length === 0 ? 0 : compared / positions.length;
  const enough = largest != null && share >= MIN_COMPARED_SHARE;
  return {
    channel: id,
    differences,
    compared,
    share,
    summary: enough
      ? { meanDifference: sum / compared, largest: largest! }
      : null,
    reason: enough
      ? null
      : `Both laps carry this channel over ${Math.round(share * 100)}% of the shared distance (at least ${Math.round(MIN_COMPARED_SHARE * 100)}% is needed).`,
  };
}

/// The two laps compared on distance, or why they are not.
export function compareLaps({
  axis,
  current,
  reference,
  readiness,
}: ComparisonInput): LapComparison {
  const none = (reason: string): LapComparison => ({
    available: false,
    reason,
  });
  if (axis !== "distance") {
    return none(
      "Laps are compared on Distance sync. Time sync overlays each lap on its own clock.",
    );
  }
  if (!readiness.ready) {
    return none(readiness.reasons[0] ?? "These laps cannot be compared.");
  }
  if (current == null || reference == null) {
    return none("Both laps' samples are needed.");
  }
  // A trace still loading after an axis change is the other axis's.
  if (
    current.axis.kind !== "lap_distance" ||
    reference.axis.kind !== "lap_distance"
  ) {
    return none("Both laps' distance samples are still loading.");
  }
  const x0 = Math.max(current.axis.start, reference.axis.start);
  const x1 = Math.min(current.axis.end, reference.axis.end);
  if (!(x1 > x0)) return none("The two laps share no recorded distance.");
  const step = Math.max(
    MIN_GRID_STEP_M,
    current.axis.bucket_width,
    reference.axis.bucket_width,
  );
  const positions: number[] = [];
  // Integer multiples of the step, so no rounding drift builds up.
  for (let index = 0; x0 + index * step <= x1; index += 1) {
    positions.push(x0 + index * step);
  }
  const channels = Object.fromEntries(
    COMPARE_CHANNELS.map((id) => [
      id,
      compareChannel(id, current, reference, positions),
    ]),
  ) as Record<CompareChannel, ChannelComparison>;
  return { available: true, x0, x1, step, positions, channels };
}

/// Current minus reference at one distance, read exactly as the grid is.
/// Null outside the shared stretch, or where either lap has no reading.
export function differenceAt(
  comparison: LapComparison,
  current: SessionTrace | null,
  reference: SessionTrace | null,
  id: CompareChannel,
  x: number | null,
): number | null {
  if (!comparison.available || x == null) return null;
  if (x < comparison.x0 || x > comparison.x1) return null;
  const a = valueAt(current, id, x);
  const b = valueAt(reference, id, x);
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) {
    return null;
  }
  return a - b;
}

export function isCompareChannel(id: TraceChannelId): id is CompareChannel {
  return (COMPARE_CHANNELS as TraceChannelId[]).includes(id);
}

const MINUS = "−";

/// A signed difference in the channel's display unit: km/h for speed,
/// percentage points for the pedals, points of steering lock (positive is
/// further right) for steering.
export function formatDifference(
  id: CompareChannel,
  difference: number | null,
): string {
  if (difference == null || !Number.isFinite(difference)) return UNAVAILABLE;
  const scaled = id === "speed" ? difference : difference * 100;
  const rounded = Math.round(scaled);
  if (rounded === 0) return "0";
  return `${rounded > 0 ? "+" : MINUS}${Math.abs(rounded)}`;
}

export const DIFFERENCE_UNITS: Record<CompareChannel, string> = {
  speed: "km/h",
  throttle: "pts",
  brake: "pts",
  steering: "pts",
};
