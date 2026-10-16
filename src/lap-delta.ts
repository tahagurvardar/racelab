/// F1 Telemetry Lab delta time (v2.2 M6): how far the current lap is behind
/// (positive) or ahead of (negative) the reference lap at the same point of
/// the circuit, in milliseconds of elapsed lap time.
///
/// Each lap's elapsed time at a distance comes only from its own recorded
/// Lap Data: the pairs of lap time and lap distance a single reading carried
/// (`timeline`). Between two adjacent readings no more than `CONTINUITY_MS`
/// apart on the lap clock, the time at an intermediate distance is linear
/// between them — the car passed that point between those two readings.
/// Across a longer step, a telemetry gap, before a lap's first reading or
/// after its last, there is no time and so no delta. Speed is never
/// integrated into time.
///
/// The delta runs only where M5's comparison runs: on Distance sync between
/// two laps M4's `comparisonReadiness` qualifies. Plain TypeScript with no
/// React import, tested under Node.
import { CONTINUITY_MS } from "./lap-quality.ts";
import type { ComparisonInput } from "./lap-comparison.ts";
import { MIN_GRID_STEP_M } from "./lap-comparison.ts";
import { channelOf, type SessionTrace } from "./telemetry-lab.ts";
import { UNAVAILABLE } from "./telemetry/formatting.ts";

/// Share of the shared distance the delta must be measured over before it
/// is shown at all.
export const MIN_DELTA_SHARE = 0.95;

interface Pair {
  /// Lap distance, metres.
  x: number;
  /// Lap time, milliseconds.
  t: number;
}

/// A lap's recorded (distance, time) pairs in distance order, or why they
/// cannot place the lap in time.
export type LapTimeline =
  | { available: true; pairs: Pair[]; gaps: { start: number; end: number }[] }
  | { available: false; reason: string };

/// The lap's recorded pairs: from each bucket whose last lap time and last
/// lap distance are one reading (the same number of readings of each). The
/// lap must never run backwards and its time must rise with its distance.
export function timeline(trace: SessionTrace): LapTimeline {
  const none = (reason: string): LapTimeline => ({ available: false, reason });
  if (trace.axis.kind !== "lap_distance") {
    return none("The lap is not read on distance.");
  }
  if (trace.axis.reversals > 0) {
    return none("The lap runs backwards (a flashback or reversing).");
  }
  const time = channelOf(trace, "lap_time");
  const distance = channelOf(trace, "lap_distance");
  if (time == null || distance == null) {
    return none("The trace carries no recorded lap time and distance.");
  }
  const pairs: Pair[] = [];
  for (let index = 0; index < trace.axis.bucket_count; index += 1) {
    const t = time.last[index];
    const x = distance.last[index];
    if (
      t == null ||
      x == null ||
      !Number.isFinite(t) ||
      !Number.isFinite(x) ||
      time.samples[index] === 0 ||
      time.samples[index] !== distance.samples[index]
    ) {
      continue;
    }
    pairs.push({ x, t });
  }
  if (pairs.length < 2) return none("Too few recorded lap time readings.");
  for (let index = 1; index < pairs.length; index += 1) {
    if (
      !(
        pairs[index].t > pairs[index - 1].t &&
        pairs[index].x >= pairs[index - 1].x
      )
    ) {
      return none("The lap's recorded time does not rise with its distance.");
    }
  }
  return { available: true, pairs, gaps: trace.gaps.stored };
}

/// The lap's elapsed time when it reached distance `x`, or null where its
/// readings cannot say.
export function timeAt(line: LapTimeline, x: number): number | null {
  if (!line.available || !Number.isFinite(x)) return null;
  const { pairs } = line;
  if (x < pairs[0].x || x > pairs[pairs.length - 1].x) return null;
  // The first pair at or beyond x.
  let low = 0;
  let high = pairs.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (pairs[middle].x < x) low = middle + 1;
    else high = middle;
  }
  const b = pairs[low];
  // Reached exactly at a reading: when the car first got there.
  if (b.x === x) return b.t;
  const a = pairs[low - 1];
  if (b.t - a.t > CONTINUITY_MS) return null;
  if (line.gaps.some((gap) => gap.end > a.x && gap.start < b.x)) return null;
  return a.t + ((x - a.x) / (b.x - a.x)) * (b.t - a.t);
}

export type LapDelta =
  | {
      available: true;
      x0: number;
      x1: number;
      step: number;
      positions: number[];
      /// Current minus reference elapsed time, ms; null where either lap's
      /// readings cannot place it.
      deltas: (number | null)[];
      /// Share of the grid measured.
      share: number;
      /// The last measured delta, and where.
      final: { x: number; ms: number };
      /// The largest delta either way, and where.
      largest: { x: number; ms: number };
      current: LapTimeline & { available: true };
      reference: LapTimeline & { available: true };
    }
  | { available: false; reason: string };

/// The delta between the two laps over the distance both recorded, or why
/// the recordings cannot give one.
export function lapDelta({
  axis,
  current,
  reference,
  readiness,
}: ComparisonInput): LapDelta {
  const none = (reason: string): LapDelta => ({ available: false, reason });
  // What keeps the laps apart comes before how they are viewed.
  if (!readiness.ready) {
    return none(readiness.reasons[0] ?? "These laps cannot be compared.");
  }
  if (axis !== "distance") {
    return none(
      "Delta time is measured on Distance sync: both laps at the same point of the circuit.",
    );
  }
  if (current == null || reference == null) {
    return none("Both laps' samples are needed.");
  }
  if (
    current.axis.kind !== "lap_distance" ||
    reference.axis.kind !== "lap_distance"
  ) {
    return none("Both laps' distance samples are still loading.");
  }
  const a = timeline(current);
  if (!a.available) return none(`Current lap: ${a.reason}`);
  const b = timeline(reference);
  if (!b.available) return none(`Reference lap: ${b.reason}`);
  const x0 = Math.max(a.pairs[0].x, b.pairs[0].x);
  const x1 = Math.min(
    a.pairs[a.pairs.length - 1].x,
    b.pairs[b.pairs.length - 1].x,
  );
  if (!(x1 > x0)) return none("The two laps share no recorded distance.");
  const step = Math.max(
    MIN_GRID_STEP_M,
    current.axis.bucket_width,
    reference.axis.bucket_width,
  );
  const positions: number[] = [];
  for (let index = 0; x0 + index * step < x1; index += 1) {
    positions.push(x0 + index * step);
  }
  positions.push(x1);
  const deltas: (number | null)[] = [];
  let measured = 0;
  let final: { x: number; ms: number } | null = null;
  let largest: { x: number; ms: number } | null = null;
  for (const x of positions) {
    const tc = timeAt(a, x);
    const tr = timeAt(b, x);
    if (tc == null || tr == null) {
      deltas.push(null);
      continue;
    }
    const ms = tc - tr;
    deltas.push(ms);
    measured += 1;
    final = { x, ms };
    if (largest == null || Math.abs(ms) > Math.abs(largest.ms)) {
      largest = { x, ms };
    }
  }
  const share = measured / positions.length;
  if (final == null || largest == null || share < MIN_DELTA_SHARE) {
    return none(
      `The laps' recorded times place both of them over ${Math.round(share * 100)}% of the shared distance (at least ${Math.round(MIN_DELTA_SHARE * 100)}% is needed).`,
    );
  }
  return {
    available: true,
    x0,
    x1,
    step,
    positions,
    deltas,
    share,
    final,
    largest,
    current: a,
    reference: b,
  };
}

/// The delta at one distance, read exactly as the grid is.
export function deltaAt(delta: LapDelta, x: number | null): number | null {
  if (!delta.available || x == null) return null;
  if (x < delta.x0 || x > delta.x1) return null;
  const tc = timeAt(delta.current, x);
  const tr = timeAt(delta.reference, x);
  return tc == null || tr == null ? null : tc - tr;
}

const MINUS = "−";

/// Signed seconds to the millisecond: "+0.381", "−1.204", "0.000".
export function formatDelta(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return UNAVAILABLE;
  const rounded = Math.round(ms);
  if (rounded === 0) return "0.000";
  const seconds = (Math.abs(rounded) / 1000).toFixed(3);
  return `${rounded > 0 ? "+" : MINUS}${seconds}`;
}

/// The chart's symmetric range, in milliseconds: the largest delta rounded
/// up to a tenth of a second, at least half a second either way.
export function deltaRange(delta: LapDelta): number {
  if (!delta.available) return 500;
  return Math.max(500, Math.ceil(Math.abs(delta.largest.ms) / 100) * 100);
}

/// An SVG path through the measured deltas; the pen lifts wherever the
/// delta is unmeasured.
export function deltaPath(
  delta: LapDelta,
  domain: { x0: number; x1: number },
  size: { width: number; height: number },
): string {
  if (!delta.available) return "";
  const range = deltaRange(delta);
  const spanX = domain.x1 - domain.x0 || 1;
  const px = (x: number) => ((x - domain.x0) / spanX) * size.width;
  // Slower (positive) is drawn above zero.
  const py = (ms: number) =>
    size.height / 2 -
    (Math.max(-range, Math.min(range, ms)) / range) * (size.height / 2);
  const round = (value: number) => String(Math.round(value * 10) / 10);
  const parts: string[] = [];
  let pen = false;
  delta.positions.forEach((x, index) => {
    const ms = delta.deltas[index];
    if (ms == null || x < domain.x0 || x > domain.x1) {
      pen = false;
      return;
    }
    parts.push(`${pen ? "L" : "M"}${round(px(x))} ${round(py(ms))}`);
    pen = true;
  });
  return parts.join("");
}
