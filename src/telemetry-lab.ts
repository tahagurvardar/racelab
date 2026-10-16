/// F1 Telemetry Lab (v2.1 M2): the view model behind the lap comparison
/// workspace. Plain TypeScript with no React import, so every rule is tested
/// under Node directly.
///
/// Everything here is drawn from two backend documents: the F1 25 session
/// detail (`get_f1_session`) and bounded channel traces of one lap
/// (`get_session_trace`). Nothing is invented: a value the trace does not
/// carry is unavailable, a line is broken across a telemetry gap or a record
/// without the value, and a panel whose data RaceLab does not record says so.
import type { F1LapRecord, F1SessionDetail } from "./f1-sessions.ts";
import { lapTime } from "./f1-sessions.ts";
import { UNAVAILABLE } from "./telemetry/formatting.ts";

// ------------------------------------------------------------ trace shapes

export type TraceChannelId =
  | "speed"
  | "rpm"
  | "throttle"
  | "brake"
  | "steering"
  | "gear"
  | "lap_time"
  | "lap_distance";

export type TraceAxisId = "time" | "distance";

export type TraceUnit =
  | "metres_per_second"
  | "kilometres_per_hour"
  | "revolutions_per_minute"
  | "ratio_0_1"
  | "ratio_-1_1"
  | "gear"
  | "milliseconds"
  | "metres";

export interface TraceChannel {
  channel: TraceChannelId;
  unit: TraceUnit;
  min: (number | null)[];
  max: (number | null)[];
  last: (number | null)[];
  samples: number[];
  missing: number[];
  total_samples: number;
  total_missing: number;
  total_non_finite: number;
}

export interface SessionTrace {
  schema_version: number;
  session_id: string;
  game: "fh6" | "f1_25";
  scope: {
    lap: number | null;
    stream_records: number;
    unattributed_records: number;
  };
  source: {
    format: string;
    container_version: number;
    payload_schema_version: number;
    recorded_by_racelab_version: string;
    nominal_sample_rate_hz: number | null;
    stream_complete: boolean;
    truncated_tail: boolean;
    declared_records: number | null;
    recorder_dropped_frames: number | null;
    f1_integrity: {
      idle_ticks: number;
      late_ticks: number;
      telemetry_gaps: number;
      out_of_order_dropped: number;
    } | null;
  };
  axis: {
    kind: "session_time" | "lap_time" | "lap_distance";
    unit: "ms" | "m";
    origin: string;
    start: number;
    end: number;
    records: number;
    bucket_width: number;
    bucket_count: number;
    max_interval_ms: number;
    reversals: number;
  };
  bucket_records: number[];
  gaps: {
    threshold_ms: number;
    total: number;
    stored: { start: number; end: number }[];
  };
  channels: TraceChannel[];
}

export interface TraceFailure {
  kind: string;
  message: string;
}

/// The trace schema this build reads. A different version is refused rather
/// than read on a guess.
export const LAB_TRACE_SCHEMA = 2;

export const LAB_CHANNELS: TraceChannelId[] = [
  "speed",
  "rpm",
  "throttle",
  "brake",
  "steering",
  "gear",
  // M3: the recorded lap time and distance, which pair the two axes for
  // playback. Never drawn as charts.
  "lap_time",
  "lap_distance",
];

/// About one bucket per 10 Hz sample of a two-minute lap: the lap is drawn
/// at its recorded resolution rather than reduced.
export const LAB_BUCKETS = 1400;

// ------------------------------------------------------------------- laps

export interface LabLap {
  number: number;
  label: string;
  time: string;
  timeMs: number;
  valid: boolean | null;
  /// Recorded from Lap Data, not yet confirmed by Session History.
  provisional: boolean;
  best: boolean;
}

export function labLaps(detail: F1SessionDetail | null): LabLap[] {
  const laps = detail?.laps;
  if (!laps) return [];
  return laps.laps.map((lap: F1LapRecord) => ({
    number: lap.lap_number,
    label: `Lap ${lap.lap_number}`,
    time: lapTime(lap.lap_time_ms),
    timeMs: lap.lap_time_ms,
    valid: lap.lap_valid,
    provisional: lap.source === "lap_data",
    best: laps.best_lap_time_lap_num === lap.lap_number,
  }));
}

/// The latest recorded lap against the fastest other lap with a time.
/// Invalid laps are not offered as the default reference.
export function defaultLaps(laps: LabLap[]): {
  current: number | null;
  reference: number | null;
} {
  if (laps.length === 0) return { current: null, reference: null };
  const current = laps[laps.length - 1].number;
  const candidates = laps.filter(
    (lap) => lap.number !== current && lap.timeMs > 0 && lap.valid !== false,
  );
  const reference = candidates.reduce<LabLap | null>(
    (best, lap) => (best == null || lap.timeMs < best.timeMs ? lap : best),
    null,
  );
  return { current, reference: reference?.number ?? null };
}

// ---------------------------------------------------------------- session

export interface LabSessionInfo {
  sessionType: string;
  track: string;
  formula: string | null;
  team: string;
  raceNumber: string;
  driver: string;
  weather: string;
  trackTemperature: string;
  airTemperature: string;
  sessionTime: string;
  trackLengthM: number | null;
  sector2StartM: number | null;
  sector3StartM: number | null;
}

function label(
  value: { raw: number; label: string | null } | null,
  kind: string,
): string {
  if (value == null) return UNAVAILABLE;
  return value.label ?? `${kind} ${value.raw}`;
}

function clock(ms: number): string {
  const whole = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = String(whole % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

export function labSession(detail: F1SessionDetail): LabSessionInfo {
  const meta = detail.session.f1_25;
  const context = meta.context_latest ?? meta.context_at_start;
  const participant = meta.participant;
  const positive = (value: number | undefined) =>
    value != null && Number.isFinite(value) && value > 0 ? value : null;
  return {
    sessionType: label(detail.labels.session_type, "Session type"),
    track: label(detail.labels.track, "Track"),
    formula: detail.labels.formula?.label ?? null,
    team: label(detail.labels.team, "Team"),
    raceNumber:
      participant == null ? UNAVAILABLE : `#${participant.race_number}`,
    // RaceLab never stores participant names.
    driver: participant?.ai_controlled ? "AI driver" : "Player",
    weather: label(detail.labels.weather, "Weather"),
    trackTemperature:
      context == null ? UNAVAILABLE : `${context.track_temperature_c}°C`,
    airTemperature:
      context == null ? UNAVAILABLE : `${context.air_temperature_c}°C`,
    sessionTime: clock(meta.duration_ms),
    trackLengthM: positive(context?.track_length_m),
    sector2StartM: positive(context?.sector2_lap_distance_start_m),
    sector3StartM: positive(context?.sector3_lap_distance_start_m),
  };
}

// --------------------------------------------------------------- channels

export function channelOf(
  trace: SessionTrace | null,
  id: TraceChannelId,
): TraceChannel | null {
  return trace?.channels.find((channel) => channel.channel === id) ?? null;
}

function bucketX(trace: SessionTrace, index: number): number {
  const { start, end, bucket_width } = trace.axis;
  return Math.min(end, start + (index + 0.5) * bucket_width);
}

/// The bucket an axis position falls in.
function bucketOf(trace: SessionTrace, x: number): number {
  const { start, bucket_width, bucket_count } = trace.axis;
  const width = bucket_width > 0 ? bucket_width : 1;
  return Math.min(
    bucket_count - 1,
    Math.max(0, Math.floor((x - start) / width)),
  );
}

/// Whether a stored gap separates bucket `from` from the later bucket `to`.
/// A gap's ends are the records either side of it, so it lies between two
/// drawn buckets exactly when it starts in the first and ends in the second
/// (buckets between them hold no record).
function gapBetween(trace: SessionTrace, from: number, to: number): boolean {
  return trace.gaps.stored.some((gap) => {
    const first = bucketOf(trace, gap.start);
    const last = bucketOf(trace, gap.end);
    return from <= first && first < last && last <= to;
  });
}

/// Whether a stored gap starting in bucket `index` is still open at `x`.
function gapOpen(trace: SessionTrace, index: number, x: number): boolean {
  return trace.gaps.stored.some(
    (gap) => bucketOf(trace, gap.start) === index && gap.end > x,
  );
}

/// The channel's reading at axis position `x`: the last sample at or before
/// it. Unavailable outside the trace, after a record without the value, and
/// across a telemetry gap — never carried over one.
export function valueAt(
  trace: SessionTrace | null,
  id: TraceChannelId,
  x: number,
): number | null {
  const channel = channelOf(trace, id);
  if (trace == null || channel == null || trace.axis.bucket_count === 0) {
    return null;
  }
  const { start, end, bucket_width } = trace.axis;
  if (x < start || x > end) return null;
  const width = bucket_width > 0 ? bucket_width : 1;
  let index = Math.min(
    trace.axis.bucket_count - 1,
    Math.floor((x - start) / width),
  );
  for (; index >= 0; index -= 1) {
    if (trace.bucket_records[index] === 0) continue;
    if (channel.samples[index] === 0) return null;
    if (gapOpen(trace, index, x)) return null;
    return channel.last[index];
  }
  return null;
}

// --------------------------------------------------------------- plotting

export interface Domain {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface PlotSize {
  width: number;
  height: number;
}

function round(value: number): string {
  return String(Math.round(value * 10) / 10);
}

/// An SVG path through the channel's buckets. Each bucket contributes its
/// range (min and max, in drawing order) so a single-sample spike survives;
/// consecutive buckets are joined unless a telemetry gap or a record without
/// the value lies between them, where the pen lifts.
export function seriesPath(
  trace: SessionTrace | null,
  id: TraceChannelId,
  domain: Domain,
  size: PlotSize,
): string {
  const channel = channelOf(trace, id);
  if (trace == null || channel == null) return "";
  const spanX = domain.x1 - domain.x0 || 1;
  const spanY = domain.y1 - domain.y0 || 1;
  const px = (x: number) => ((x - domain.x0) / spanX) * size.width;
  const py = (y: number) => {
    const clamped = Math.min(domain.y1, Math.max(domain.y0, y));
    return size.height - ((clamped - domain.y0) / spanY) * size.height;
  };
  const parts: string[] = [];
  let pen = false;
  let previous: number | null = null;
  let previousY: number | null = null;
  for (let index = 0; index < trace.axis.bucket_count; index += 1) {
    if (trace.bucket_records[index] === 0) continue;
    const x = bucketX(trace, index);
    if (channel.samples[index] === 0 || channel.missing[index] > 0) {
      pen = false;
      if (channel.samples[index] === 0) {
        previous = index;
        continue;
      }
    }
    if (x < domain.x0 || x > domain.x1) {
      pen = false;
      previous = index;
      continue;
    }
    if (pen && previous != null && gapBetween(trace, previous, index)) {
      pen = false;
    }
    const low = channel.min[index];
    const high = channel.max[index];
    if (low == null || high == null) {
      pen = false;
      previous = index;
      continue;
    }
    const ordered: number[] =
      low === high
        ? [low]
        : previousY != null && previousY > (low + high) / 2
          ? [high, low]
          : [low, high];
    for (const value of ordered) {
      parts.push(`${pen ? "L" : "M"}${round(px(x))} ${round(py(value))}`);
      pen = true;
    }
    previous = index;
    previousY = ordered[ordered.length - 1];
  }
  return parts.join("");
}

/// One shared x domain for the current and reference laps. Lap distance
/// spans the circuit when its length is known.
export function sharedXDomain(
  traces: (SessionTrace | null)[],
  axis: TraceAxisId,
  trackLengthM: number | null,
): { x0: number; x1: number } {
  const present = traces.filter(
    (trace): trace is SessionTrace => trace != null && trace.axis.records > 0,
  );
  const starts = present.map((trace) => trace.axis.start);
  const ends = present.map((trace) => trace.axis.end);
  const x0 = Math.min(0, ...starts);
  const fallback = axis === "distance" ? (trackLengthM ?? 1000) : 60_000;
  const x1 = Math.max(
    axis === "distance" ? (trackLengthM ?? 0) : 0,
    ...ends,
    present.length === 0 ? fallback : x0 + 1,
  );
  return { x0, x1 };
}

function niceCeiling(value: number, step: number, floor: number): number {
  return Math.max(floor, Math.ceil(value / step) * step);
}

function peak(traces: (SessionTrace | null)[], id: TraceChannelId): number {
  let high = -Infinity;
  for (const trace of traces) {
    for (const value of channelOf(trace, id)?.max ?? []) {
      if (value != null && value > high) high = value;
    }
  }
  return high;
}

/// Each chart's value range. Pedals and steering keep their recorded
/// normalized ranges; speed, RPM and gear grow to the laps shown.
export function yDomain(
  traces: (SessionTrace | null)[],
  id: TraceChannelId,
): { y0: number; y1: number } {
  switch (id) {
    case "throttle":
    case "brake":
      return { y0: 0, y1: 1 };
    case "steering":
      return { y0: -1, y1: 1 };
    case "gear":
      return { y0: -1, y1: niceCeiling(peak(traces, id), 1, 8) };
    case "rpm":
      return { y0: 0, y1: niceCeiling(peak(traces, id), 1000, 1000) };
    case "speed":
      return { y0: 0, y1: niceCeiling(peak(traces, id), 50, 100) };
    case "lap_time":
    case "lap_distance":
      return { y0: 0, y1: niceCeiling(peak(traces, id), 1000, 1000) };
  }
}

export interface Tick {
  value: number;
  label: string;
}

function distanceLabel(metres: number, step: number): string {
  if (metres === 0) return "0m";
  return step < 1000 && Math.abs(metres) < 1000
    ? `${metres}m`
    : `${(metres / 1000).toFixed(2)}km`;
}

function timeLabel(ms: number): string {
  const whole = Math.round(ms / 1000);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/// Four or fewer labelled positions along the x axis.
export function xTicks(
  domain: { x0: number; x1: number },
  axis: TraceAxisId,
): Tick[] {
  const span = domain.x1 - domain.x0;
  const steps =
    axis === "distance"
      ? [100, 250, 500, 1000, 2000, 5000, 10_000]
      : [5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000];
  const step =
    steps.find((candidate) => span / candidate <= 4) ?? steps[steps.length - 1];
  const ticks: Tick[] = [];
  for (
    let value = Math.ceil(domain.x0 / step) * step;
    value <= domain.x1;
    value += step
  ) {
    ticks.push({
      value,
      label:
        axis === "distance" ? distanceLabel(value, step) : timeLabel(value),
    });
  }
  return ticks;
}

/// Horizontal grid lines for a chart: the scale's own landmarks.
export function yTicks(id: TraceChannelId, y: { y0: number; y1: number }) {
  switch (id) {
    case "throttle":
    case "brake":
      return [
        { value: 0.5, label: "50" },
        { value: 1, label: "100" },
      ];
    case "steering":
      return [
        { value: -1, label: "L" },
        { value: 0, label: "0" },
        { value: 1, label: "R" },
      ];
    case "gear":
      return [
        { value: 0, label: "N" },
        { value: 4, label: "4" },
        { value: 8, label: "8" },
      ].filter((tick) => tick.value <= y.y1);
    default: {
      const step = id === "rpm" ? (y.y1 > 8000 ? 5000 : 2000) : 100;
      const ticks: Tick[] = [];
      for (let value = step; value < y.y1; value += step) {
        ticks.push({ value, label: String(value) });
      }
      return ticks;
    }
  }
}

// ------------------------------------------------------------- formatting

export function formatChannel(
  id: TraceChannelId,
  value: number | null,
): string {
  if (value == null || !Number.isFinite(value)) return UNAVAILABLE;
  switch (id) {
    case "speed":
    case "rpm":
      return String(Math.round(value));
    case "throttle":
    case "brake":
      return `${Math.round(value * 100)}`;
    case "steering":
      return steeringText(value);
    case "gear":
      return gearText(value);
    case "lap_time":
      return lapClock(value);
    case "lap_distance":
      return `${Math.round(value)} m`;
  }
}

/// Lap milliseconds as "1:32.456". Negative never occurs on a lap clock and
/// stays unavailable rather than becoming a time.
export function lapClock(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return UNAVAILABLE;
  const whole = Math.round(ms);
  const minutes = Math.floor(whole / 60_000);
  const seconds = Math.floor((whole % 60_000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(whole % 1000).padStart(3, "0")}`;
}

export function gearText(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return UNAVAILABLE;
  if (value < 0) return "R";
  if (value === 0) return "N";
  return String(Math.round(value));
}

/// F1 25 sends steering normalized to -1..1, positive to the right (pinned
/// against the real fixtures). Its steering lock is not recorded, so this is
/// a share of full lock, never an angle in degrees.
export function steeringText(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return UNAVAILABLE;
  const share = Math.round(Math.abs(value) * 100);
  if (share === 0) return "Centre";
  return `${value > 0 ? "Right" : "Left"} ${share}%`;
}

export const CHANNEL_TITLES: Record<TraceChannelId, string> = {
  speed: "Speed",
  rpm: "RPM",
  throttle: "Throttle",
  brake: "Brake",
  steering: "Steering",
  gear: "Gear",
  lap_time: "Lap time",
  lap_distance: "Lap distance",
};

export const CHANNEL_UNITS: Record<TraceChannelId, string> = {
  speed: "km/h",
  rpm: "rpm",
  throttle: "%",
  brake: "%",
  steering: "lock",
  gear: "",
  lap_time: "ms",
  lap_distance: "m",
};

/// What a trace says about its own trustworthiness, as short notes.
export function traceNotes(trace: SessionTrace | null): string[] {
  if (trace == null) return [];
  const notes: string[] = [];
  if (trace.axis.reversals > 0) {
    notes.push(
      `The lap runs backwards ${trace.axis.reversals} time${trace.axis.reversals === 1 ? "" : "s"} (a flashback or reversing), so it does not map one-to-one onto the axis.`,
    );
  }
  if (trace.gaps.total > 0) {
    notes.push(
      `${trace.gaps.total} telemetry gap${trace.gaps.total === 1 ? "" : "s"} over ${trace.gaps.threshold_ms / 1000} s; lines break there.`,
    );
  }
  if (trace.scope.unattributed_records > 0) {
    notes.push(
      `${trace.scope.unattributed_records} sample${trace.scope.unattributed_records === 1 ? "" : "s"} inside the lap carried no Lap Data and ${trace.scope.unattributed_records === 1 ? "is" : "are"} not shown.`,
    );
  }
  if (trace.source.truncated_tail || !trace.source.stream_complete) {
    notes.push("The recording ended without its end marker.");
  }
  return notes;
}

// ---------------------------------------------------------------- playback

export const PLAYBACK_RATES = [0.5, 1, 2, 4] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

/// How a lap plays: on its own lap clock, mapped onto the chart axis.
export type PlaybackMap =
  | {
      available: true;
      /// The lap clock the playback runs over, in milliseconds.
      startMs: number;
      endMs: number;
      /// Lap time to axis position, and back. Linear between recorded pairs.
      toX(ms: number): number;
      toTime(x: number): number;
    }
  | { available: false; reason: string };

interface Pair {
  x: number;
  t: number;
}

/// Linear interpolation over pairs sorted by `key`, clamped at both ends.
function interpolate(
  pairs: Pair[],
  key: "x" | "t",
  value: number,
  other: "x" | "t",
): number {
  if (value <= pairs[0][key]) return pairs[0][other];
  const last = pairs[pairs.length - 1];
  if (value >= last[key]) return last[other];
  let low = 0;
  let high = pairs.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (pairs[middle][key] <= value) low = middle;
    else high = middle;
  }
  const a = pairs[low];
  const b = pairs[high];
  const span = b[key] - a[key];
  const fraction = span > 0 ? (value - a[key]) / span : 0;
  return a[other] + fraction * (b[other] - a[other]);
}

/// The playback map for the current lap. On Time sync the axis is the lap
/// clock itself. On Distance sync it is built from recorded pairs only:
/// each bucket whose last lap time and last lap distance come from the same
/// Lap Data reading. A lap that runs backwards, or whose time does not rise
/// with its distance, is not played on distance; nothing is estimated.
export function playbackMap(
  trace: SessionTrace | null,
  axis: TraceAxisId,
): PlaybackMap {
  const none = (reason: string): PlaybackMap => ({ available: false, reason });
  if (trace == null || trace.axis.records === 0) {
    return none("There is no current lap to play.");
  }
  if (axis === "time") {
    const { start, end } = trace.axis;
    if (!(end > start)) return none("This lap is too short to play.");
    const clamp = (value: number) => Math.min(end, Math.max(start, value));
    return {
      available: true,
      startMs: start,
      endMs: end,
      toX: clamp,
      toTime: clamp,
    };
  }
  if (trace.axis.reversals > 0) {
    return none(
      "This lap runs backwards (a flashback or reversing), so its distance does not map to one time. Time sync plays it.",
    );
  }
  const time = channelOf(trace, "lap_time");
  const distance = channelOf(trace, "lap_distance");
  if (time == null || distance == null) {
    return none("This trace carries no recorded lap time and distance.");
  }
  const pairs: Pair[] = [];
  for (let index = 0; index < trace.axis.bucket_count; index += 1) {
    const t = time.last[index];
    const x = distance.last[index];
    // Same number of readings in the bucket: both lasts are one reading.
    if (
      t == null ||
      x == null ||
      time.samples[index] === 0 ||
      time.samples[index] !== distance.samples[index]
    ) {
      continue;
    }
    pairs.push({ x, t });
  }
  if (pairs.length < 2) {
    return none("Too few recorded lap time readings to play this lap.");
  }
  for (let index = 1; index < pairs.length; index += 1) {
    if (
      !(
        pairs[index].t > pairs[index - 1].t &&
        pairs[index].x >= pairs[index - 1].x
      )
    ) {
      return none(
        "This lap's recorded time does not rise with its distance. Time sync plays it.",
      );
    }
  }
  return {
    available: true,
    startMs: pairs[0].t,
    endMs: pairs[pairs.length - 1].t,
    toX: (ms) => interpolate(pairs, "t", ms, "x"),
    toTime: (x) => interpolate(pairs, "x", x, "t"),
  };
}
