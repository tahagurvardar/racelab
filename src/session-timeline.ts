/// The session timeline: when the analysis's own episodes happened.
///
/// Built only from intervals the analysis already persisted — driving events,
/// turn segments and slip episodes, each with `start_ms`/`end_ms` relative to
/// the first recorded frame. No frame is read, no event is inferred, and no
/// lap boundary is drawn, because none is recorded.
///
/// Bounded by construction: the session is divided into `TIMELINE_BINS`
/// equal bins and each lane draws at most one mark per run of bins at the
/// same density, so a lane costs at most `TIMELINE_BINS` marks however many
/// episodes it holds (the analysis caps them at a few hundred anyway). Counts
/// are never dropped: every stored interval is counted in the lane total and
/// in the text slices, and anything the analysis counted but did not store is
/// stated beside it.
import {
  EVENT_LABELS,
  type EventKind,
  type SessionAnalysis,
} from "./analysis-state.ts";
import { elapsed, integer, offsetClock } from "./telemetry/formatting.ts";

export const TIMELINE_BINS = 240;
/// Equal time slices in the text equivalent of the timeline.
export const TIMELINE_SLICES = 6;

export type LaneKey =
  | "throttle"
  | "braking"
  | "speed"
  | "suspension"
  | "turns"
  | "slip";

/// Channel identity for the two pedals (the approved D4 convention), neutral
/// for everything else. Never a good/bad colour.
export type LaneTone = "throttle" | "brake" | "neutral";

interface Interval {
  start: number;
  end: number;
  /// What the interval is, for the hover text and the per-kind counts.
  kind: string;
}

export interface TimelineMark {
  key: string;
  /// Bin range [from, to), in 0..TIMELINE_BINS.
  from: number;
  to: number;
  /// 1..4: how many stored intervals overlap at the busiest bin of the run.
  level: 1 | 2 | 3 | 4;
  /// "2 events · Braking 1, Hard braking 1 · 1:24 – 1:30".
  title: string;
}

export interface TimelineLane {
  key: LaneKey;
  label: string;
  tone: LaneTone;
  /// Stored intervals drawn in this lane.
  stored: number;
  /// Every interval the analysis counted for this lane, including any not
  /// stored because of its output cap.
  total: number;
  /// Why the lane is empty because its channel was not recorded, else null.
  unavailable: string | null;
  marks: TimelineMark[];
  /// Stored intervals starting in each text slice; sums to `stored`.
  slices: number[];
}

export interface TimelineTick {
  key: string;
  /// 0..1 along the axis.
  fraction: number;
  label: string;
}

export interface TimelineModel {
  durationMs: number;
  bins: number;
  lanes: TimelineLane[];
  ticks: TimelineTick[];
  /// Text labels for the slices, "0:00 – 3:00".
  sliceLabels: string[];
  /// Plain statements of anything the drawing cannot show.
  notes: string[];
}

const LANE_KINDS: Partial<Record<LaneKey, EventKind[]>> = {
  throttle: ["full_throttle", "rapid_throttle_lift"],
  braking: ["braking", "hard_braking"],
  speed: ["strong_acceleration", "strong_deceleration"],
  suspension: ["high_suspension_compression", "high_suspension_extension"],
};

const LANE_LABELS: Record<LaneKey, string> = {
  throttle: "Throttle",
  braking: "Braking",
  speed: "Speed change",
  suspension: "Suspension",
  turns: "Turn segments",
  slip: "Slip episodes",
};

const LANE_TONES: Record<LaneKey, LaneTone> = {
  throttle: "throttle",
  braking: "brake",
  speed: "neutral",
  suspension: "neutral",
  turns: "neutral",
  slip: "neutral",
};

const NOUNS: Record<LaneKey, [string, string]> = {
  throttle: ["event", "events"],
  braking: ["event", "events"],
  speed: ["event", "events"],
  suspension: ["event", "events"],
  turns: ["turn segment", "turn segments"],
  slip: ["slip episode", "slip episodes"],
};

/// The axis length: the recorded span, or the latest stored end if an
/// interval reaches past it. Never zero.
export function timelineDuration(analysis: SessionAnalysis): number {
  const recorded = Math.round(analysis.coverage.recorded_seconds * 1000);
  const span =
    analysis.coverage.last_monotonic_ms - analysis.coverage.first_monotonic_ms;
  let end = Math.max(recorded, span, 0);
  for (const item of [
    ...analysis.events,
    ...analysis.turn_segments,
    ...analysis.slip_episodes,
  ]) {
    if (Number.isFinite(item.end_ms)) end = Math.max(end, item.end_ms);
  }
  return Math.max(1, end);
}

function binOf(ms: number, durationMs: number, bins: number): number {
  const position = Math.floor((ms / durationMs) * bins);
  return Math.min(bins - 1, Math.max(0, position));
}

function levelOf(count: number): 1 | 2 | 3 | 4 {
  if (count <= 1) return 1;
  if (count === 2) return 2;
  if (count <= 4) return 3;
  return 4;
}

function marks(
  lane: LaneKey,
  intervals: Interval[],
  durationMs: number,
  bins: number,
): TimelineMark[] {
  const counts = new Array<number>(bins).fill(0);
  const spans = intervals.map((interval) => {
    const from = binOf(interval.start, durationMs, bins);
    const to = Math.max(from, binOf(interval.end, durationMs, bins));
    for (let bin = from; bin <= to; bin += 1) counts[bin] += 1;
    return { ...interval, from, to };
  });
  const result: TimelineMark[] = [];
  let bin = 0;
  while (bin < bins) {
    if (counts[bin] === 0) {
      bin += 1;
      continue;
    }
    const level = levelOf(counts[bin]);
    let to = bin + 1;
    let peak = counts[bin];
    while (to < bins && counts[to] > 0 && levelOf(counts[to]) === level) {
      peak = Math.max(peak, counts[to]);
      to += 1;
    }
    const inside = spans.filter((span) => span.from < to && span.to >= bin);
    const byKind = new Map<string, number>();
    for (const span of inside) {
      byKind.set(span.kind, (byKind.get(span.kind) ?? 0) + 1);
    }
    const [one, many] = NOUNS[lane];
    const start = (bin / bins) * durationMs;
    const end = (to / bins) * durationMs;
    const kinds =
      byKind.size > 1
        ? ` · ${[...byKind].map(([kind, n]) => `${kind} ${n}`).join(", ")}`
        : "";
    result.push({
      key: `${lane}-${bin}`,
      from: bin,
      to,
      level: levelOf(peak),
      title: `${inside.length} ${inside.length === 1 ? one : many}${kinds} · ${offsetClock(
        start,
      )} – ${offsetClock(end)}`,
    });
    bin = to;
  }
  return result;
}

function slices(intervals: Interval[], durationMs: number): number[] {
  const counts = new Array<number>(TIMELINE_SLICES).fill(0);
  for (const interval of intervals) {
    const slice = Math.min(
      TIMELINE_SLICES - 1,
      Math.max(0, Math.floor((interval.start / durationMs) * TIMELINE_SLICES)),
    );
    counts[slice] += 1;
  }
  return counts;
}

/// Tick steps, smallest first. Beyond the last, whole hours are used.
const STEPS_S = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
export const MAX_TICKS = 9;
/// Regular ticks after the origin: at most MAX_TICKS minus the origin and
/// the end tick, so the total never exceeds MAX_TICKS.
const MAX_INTERIOR = MAX_TICKS - 2;
/// A regular tick closer than this many steps to the end is dropped, so its
/// label never collides with the end tick's.
const END_CLEARANCE = 0.4;

/// Ticks for an axis of `durationMs`, deterministic for every input.
///
/// Any finite positive duration — however long — gets the origin (0:00),
/// evenly spaced round-numbered ticks between, and a final tick at the
/// session duration itself, never more than MAX_TICKS in all. Only an
/// invalid duration (NaN, infinite, zero or negative) falls back to the
/// origin alone.
export function timelineTicks(durationMs: number): TimelineTick[] {
  const origin: TimelineTick = { key: "tick-0", fraction: 0, label: "0:00" };
  if (!Number.isFinite(durationMs) || durationMs <= 0) return [origin];
  const seconds = durationMs / 1000;
  const step =
    STEPS_S.find((candidate) => seconds / candidate <= MAX_INTERIOR + 1) ??
    Math.ceil(seconds / (MAX_INTERIOR + 1) / 3600) * 3600;
  const ticks: TimelineTick[] = [origin];
  for (let index = 1; index <= MAX_INTERIOR; index += 1) {
    const at = index * step;
    if (!(at < seconds - END_CLEARANCE * step)) break;
    // A fraction of the duration in seconds, never `at * 1000`, which could
    // overflow for an absurdly long synthetic duration.
    ticks.push({
      key: `tick-${index}`,
      fraction: at / seconds,
      label: elapsed(at),
    });
  }
  ticks.push({ key: "tick-end", fraction: 1, label: elapsed(seconds) });
  return ticks;
}

/// How to read the drawing, stated as what it is: equal time slots, an
/// interval drawn across every slot it touches, and darker where more
/// intervals touch the same slots — which is not the same as overlapping.
export function densityNote(model: TimelineModel): string {
  const slot = model.durationMs / 1000 / model.bins;
  const seconds = slot < 10 ? slot.toFixed(1) : String(Math.round(slot));
  return `The session is drawn in ${model.bins} equal slots of ${seconds} s. Each interval is drawn across every slot it touches, so even a brief one is at least one slot wide. A darker mark means more intervals touch the same slot; they may follow one another within it rather than overlap. Exact times are in the Events, Turns and Slip tabs.`;
}

function unavailableNote(
  analysis: SessionAnalysis,
  lane: LaneKey,
): string | null {
  const quality = analysis.data_quality;
  const recorded =
    lane === "throttle" || lane === "braking"
      ? quality.controls_available
      : lane === "speed"
        ? quality.speed_available
        : lane === "suspension"
          ? quality.suspension_available
          : lane === "turns"
            ? quality.orientation_available
            : quality.wheel_telemetry_available;
  return recorded ? null : "Not recorded in this session";
}

export function sessionTimeline(
  analysis: SessionAnalysis,
  bins: number = TIMELINE_BINS,
): TimelineModel {
  const durationMs = timelineDuration(analysis);
  const totals = new Map(
    analysis.driving_summary.events_by_kind.map((item) => [
      item.kind,
      item.count,
    ]),
  );

  const intervalsOf = (lane: LaneKey): Interval[] => {
    const kinds = LANE_KINDS[lane];
    if (kinds) {
      return analysis.events
        .filter((event) => kinds.includes(event.kind))
        .map((event) => ({
          start: event.start_ms,
          end: event.end_ms,
          kind: EVENT_LABELS[event.kind],
        }));
    }
    const items =
      lane === "turns" ? analysis.turn_segments : analysis.slip_episodes;
    return items.map((item) => ({
      start: item.start_ms,
      end: item.end_ms,
      kind: LANE_LABELS[lane],
    }));
  };

  const totalOf = (lane: LaneKey, stored: number): number => {
    const kinds = LANE_KINDS[lane];
    if (kinds) {
      return kinds.reduce(
        (sum, kind) =>
          sum +
          (totals.get(kind) ??
            analysis.events.filter((event) => event.kind === kind).length),
        0,
      );
    }
    const summary = analysis.driving_summary;
    const counted =
      lane === "turns"
        ? summary.turn_segment_count
        : summary.slip_episode_count;
    const truncated =
      lane === "turns"
        ? analysis.data_quality.turn_segments_truncated
        : analysis.data_quality.slip_episodes_truncated;
    return Math.max(counted, stored + truncated);
  };

  const lanes = (Object.keys(LANE_LABELS) as LaneKey[]).map((key) => {
    const intervals = intervalsOf(key)
      .filter(
        (interval) =>
          Number.isFinite(interval.start) && Number.isFinite(interval.end),
      )
      .sort((a, b) => a.start - b.start || a.end - b.end);
    return {
      key,
      label: LANE_LABELS[key],
      tone: LANE_TONES[key],
      stored: intervals.length,
      total: totalOf(key, intervals.length),
      unavailable: unavailableNote(analysis, key),
      marks: marks(key, intervals, durationMs, bins),
      slices: slices(intervals, durationMs),
    };
  });

  const sliceLabels = Array.from({ length: TIMELINE_SLICES }, (_, index) => {
    const from = (index / TIMELINE_SLICES) * durationMs;
    const to = ((index + 1) / TIMELINE_SLICES) * durationMs;
    return `${elapsed(from / 1000)} – ${elapsed(to / 1000)}`;
  });

  const notes: string[] = [];
  const capped = lanes.filter((lane) => lane.total > lane.stored);
  if (capped.length > 0) {
    notes.push(
      `The analysis counted more than it stored: ${capped
        .map(
          (lane) =>
            `${lane.label.toLowerCase()} ${integer(lane.total)} counted, ${integer(lane.stored)} stored`,
        )
        .join("; ")}. Only stored intervals are drawn.`,
    );
  }

  return {
    durationMs,
    bins,
    lanes,
    ticks: timelineTicks(durationMs),
    sliceLabels,
    notes,
  };
}
