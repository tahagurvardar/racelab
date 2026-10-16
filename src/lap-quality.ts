/// F1 Telemetry Lab lap analysis (v2.1 M4): what a lap's record and its
/// recorded samples establish, measured, never estimated.
///
/// Two sources, kept apart:
///
/// - **Timing** comes from the session's lap records. Session History is
///   authoritative for completed laps, sectors and validity; a Lap Data
///   record is provisional and says so. A time the game did not send is
///   unavailable, never zero.
/// - **Coverage** comes from the lap's trace: the recorded Lap Data
///   readings (lap time, lap distance) of the samples attributed to the lap.
///   Every figure is computed from those samples at RaceLab's 10 Hz F1
///   sampling rate; nothing is interpolated into a measurement.
///
/// A lap can be *replayed* when its samples allow it (M3). It is *eligible
/// for reliable distance-aligned analysis* only when, on top of that, its
/// timing is authoritative and valid and its samples cover the whole lap
/// without breaks. M5 (lap comparison) and M6 (delta time) read that
/// eligibility; this module computes no comparison and no delta.
///
/// Plain TypeScript with no React import, tested under Node.
import type { F1LapRecord } from "./f1-sessions.ts";
import { channelOf, playbackMap, type SessionTrace } from "./telemetry-lab.ts";

/// RaceLab samples F1 25 at 10 Hz (`f1_session::SAMPLE_RATE_HZ`).
export const SAMPLE_INTERVAL_MS = 100;
/// Consecutive samples further apart than three sample intervals are a
/// break in the lap's coverage.
export const CONTINUITY_MS = 3 * SAMPLE_INTERVAL_MS;
/// A lap's start (end) is captured when its first (last) sample is within
/// three sample intervals of lap time 0 (of the recorded lap time).
export const EDGE_MS = 3 * SAMPLE_INTERVAL_MS;
/// Shares of the lap that reliable distance-aligned analysis requires.
export const MIN_TIME_COVERAGE = 0.95;
export const MIN_DISTANCE_COVERAGE = 0.95;
export const MIN_DENSITY = 0.9;
/// History's sectors sum to its lap time to the millisecond; a sum further
/// off than this is reported, not corrected.
export const SECTOR_SUM_TOLERANCE_MS = 2;

export type LapSource = "session_history" | "lap_data" | "unrecorded";

export interface LapIssue {
  code:
    | "no_record"
    | "provisional"
    | "invalid"
    | "validity_unknown"
    | "no_lap_time"
    | "no_samples"
    | "sparse"
    | "breaks"
    | "coverage_unknown"
    | "start_missing"
    | "end_missing"
    | "runs_past_lap_time"
    | "low_distance_coverage"
    | "distance_missing"
    | "reversals"
    | "unattributed"
    | "telemetry_gaps"
    | "sector_sum";
  /// `blocking` keeps a lap out of reliable distance-aligned analysis;
  /// `note` is reported and does not.
  severity: "blocking" | "note";
  text: string;
}

export interface LapTiming {
  source: LapSource;
  /// The lap time the record states, or null when the game sent none.
  lapTimeMs: number | null;
  /// History's sectors. A provisional record has at most S1 and S2.
  sectorsMs: [number | null, number | null, number | null];
  sectorsValid: [boolean | null, boolean | null, boolean | null];
  valid: boolean | null;
}

export interface LapCoverage {
  /// Samples attributed to the lap (records carrying its Lap Data).
  samples: number;
  /// Samples a 10 Hz recording of the stated lap time would hold.
  expectedSamples: number | null;
  /// `samples / expectedSamples`.
  density: number | null;
  /// First and last recorded lap time.
  firstMs: number | null;
  lastMs: number | null;
  /// Largest recording-clock interval between consecutive trace records,
  /// measured by the backend before bucketing (not a lap-clock interval).
  maxIntervalMs: number | null;
  /// Share of the lap clock spanned by steps of at most `CONTINUITY_MS`,
  /// counting the stretches before the first and after the last sample
  /// when they are within `EDGE_MS`.
  /// Null when bucketing or missing readings prevents proving this share.
  timeCoverage: number | null;
  /// Share of the circuit between the first and last recorded distance.
  distanceCoverage: number | null;
  /// Largest step between consecutive recorded distances, metres.
  maxDistanceStepM: number | null;
  /// Lap-time readings with no lap-distance reading beside them. Distance
  /// alignment needs both at every sample; the first and last distance
  /// alone say nothing about the stretch in between.
  missingDistance: number;
  startCaptured: boolean | null;
  endCaptured: boolean | null;
  reversals: number;
  unattributed: number;
  telemetryGaps: number;
}

export interface LapQuality {
  lap: number;
  timing: LapTiming;
  coverage: LapCoverage | null;
  /// Replay on the lap clock, and on lap distance (M3's playback maps).
  replay: { time: boolean; distance: boolean };
  /// Reliable distance-aligned analysis: the gate M5 and M6 read.
  distanceAnalysis: { eligible: boolean; reasons: string[] };
  issues: LapIssue[];
}

function timingOf(record: F1LapRecord | null): LapTiming {
  if (record == null) {
    return {
      source: "unrecorded",
      lapTimeMs: null,
      sectorsMs: [null, null, null],
      sectorsValid: [null, null, null],
      valid: null,
    };
  }
  const positive = (value: number | null) =>
    value != null && Number.isFinite(value) && value > 0 ? value : null;
  // Lap Data has no S3: only Session History states one.
  const history = record.source === "session_history";
  return {
    source: record.source,
    lapTimeMs: positive(record.lap_time_ms),
    sectorsMs: [
      positive(record.sector1_ms),
      positive(record.sector2_ms),
      history ? positive(record.sector3_ms) : null,
    ],
    sectorsValid: [
      record.sector1_valid,
      record.sector2_valid,
      history ? record.sector3_valid : null,
    ],
    valid: record.lap_valid,
  };
}

interface Reading {
  t: number;
  d: number | null;
}

/// Bucket extrema in lap-time order. These retain the lap's extent, but
/// are NOT consecutive samples when a bucket combines multiple readings.
function readings(trace: SessionTrace): Reading[] {
  const time = channelOf(trace, "lap_time");
  const distance = channelOf(trace, "lap_distance");
  if (time == null) return [];
  const out: Reading[] = [];
  for (let index = 0; index < trace.axis.bucket_count; index += 1) {
    if (time.samples[index] === 0) continue;
    const low = time.min[index];
    const high = time.max[index];
    if (low == null || high == null) continue;
    // Matching counts retain distance extrema, not individual time/distance
    // pairs in a multi-sample bucket. Do not use these for sample intervals.
    const paired =
      distance != null && distance.samples[index] === time.samples[index];
    const dLow = paired ? distance.min[index] : null;
    const dHigh = paired ? distance.max[index] : null;
    out.push({ t: low, d: dLow });
    if (high !== low) out.push({ t: high, d: dHigh });
  }
  return out.sort((a, b) => a.t - b.t);
}

function coverageOf(
  trace: SessionTrace,
  timing: LapTiming,
  trackLengthM: number | null,
): LapCoverage {
  const points = readings(trace);
  const samples = trace.axis.records;
  const time = channelOf(trace, "lap_time");
  // A bucket's min and max are its readings when it holds at most two and
  // the lap never runs backwards; `points.length === samples` proves no
  // two of them collapsed into one. A distance bucket at a hairpin holds
  // two 10 Hz samples; three or more lose the ones in between.
  const individualReadings =
    time != null &&
    time.samples.every((count) => count <= 2) &&
    points.length === samples &&
    trace.axis.reversals === 0;
  const expectedSamples =
    timing.lapTimeMs == null
      ? null
      : Math.floor(timing.lapTimeMs / SAMPLE_INTERVAL_MS) + 1;
  // This is recording-clock evidence, preserved before aggregation. It
  // cannot reconstruct the game's lap clock or its covered duration.
  const maxIntervalMs = samples < 2 ? null : trace.axis.max_interval_ms;
  let continuous = 0;
  for (let index = 1; individualReadings && index < points.length; index += 1) {
    const step = points[index].t - points[index - 1].t;
    if (step <= CONTINUITY_MS) continuous += step;
  }
  const firstMs = points.length ? points[0].t : null;
  const lastMs = points.length ? points[points.length - 1].t : null;
  // At 10 Hz the first sample lands up to one interval after the line and
  // the last up to one before it. Those edge stretches are not breaks when
  // they are within EDGE_MS, the same allowance that counts an end as
  // captured.
  if (firstMs != null && firstMs > 0 && firstMs <= EDGE_MS) {
    continuous += firstMs;
  }
  if (lastMs != null && timing.lapTimeMs != null) {
    const tail = timing.lapTimeMs - lastMs;
    if (tail > 0 && tail <= EDGE_MS) continuous += tail;
  }
  const clock =
    timing.lapTimeMs ??
    (lastMs != null && firstMs != null ? lastMs - firstMs : null);
  // Per bucket, every lap-time reading needs a distance reading of its own.
  const distanceChannel = channelOf(trace, "lap_distance");
  let missingDistance = 0;
  if (time != null) {
    for (let index = 0; index < time.samples.length; index += 1) {
      const paired = distanceChannel?.samples[index] ?? 0;
      missingDistance += Math.max(0, time.samples[index] - paired);
    }
  }
  const distances = points
    .map((point) => point.d)
    .filter((d): d is number => d != null && Number.isFinite(d));
  let maxDistanceStepM: number | null = null;
  for (
    let index = 1;
    individualReadings && index < distances.length;
    index += 1
  ) {
    const step = distances[index] - distances[index - 1];
    if (step > (maxDistanceStepM ?? -Infinity)) maxDistanceStepM = step;
  }
  const spanM =
    distances.length >= 2
      ? Math.min(trackLengthM ?? Infinity, distances[distances.length - 1]) -
        Math.max(0, distances[0])
      : null;
  return {
    samples,
    expectedSamples,
    density:
      expectedSamples == null || expectedSamples === 0
        ? null
        : samples / expectedSamples,
    firstMs,
    lastMs,
    maxIntervalMs,
    timeCoverage:
      !individualReadings || clock == null || clock <= 0 || points.length < 2
        ? null
        : Math.min(1, continuous / clock),
    distanceCoverage:
      spanM == null || trackLengthM == null
        ? null
        : Math.max(0, Math.min(1, spanM / trackLengthM)),
    maxDistanceStepM,
    missingDistance,
    startCaptured: firstMs == null ? null : firstMs <= EDGE_MS,
    endCaptured:
      lastMs == null || timing.lapTimeMs == null
        ? null
        : lastMs >= timing.lapTimeMs - EDGE_MS,
    reversals: trace.axis.reversals,
    unattributed: trace.scope.unattributed_records,
    telemetryGaps: trace.gaps.total,
  };
}

const percent = (share: number) => `${Math.round(share * 100)}%`;

/// One lap: its record (null when the session recorded none for it) and
/// its trace on either axis (null while loading or unreadable).
export function assessLap(
  lap: number,
  record: F1LapRecord | null,
  trace: SessionTrace | null,
  trackLengthM: number | null,
): LapQuality {
  const timing = timingOf(record);
  const issues: LapIssue[] = [];
  const block = (code: LapIssue["code"], text: string) =>
    issues.push({ code, severity: "blocking", text });
  const note = (code: LapIssue["code"], text: string) =>
    issues.push({ code, severity: "note", text });

  if (timing.source === "unrecorded") {
    block("no_record", "The session recorded no lap record for this lap.");
  } else if (timing.source === "lap_data") {
    block(
      "provisional",
      "Provisional: from Lap Data; Session History never confirmed this lap.",
    );
  }
  if (timing.valid === false)
    block("invalid", "The game marked this lap invalid.");
  else if (timing.valid == null && timing.source !== "unrecorded") {
    block("validity_unknown", "The lap's validity is not recorded.");
  }
  if (timing.source !== "unrecorded" && timing.lapTimeMs == null) {
    block("no_lap_time", "The game sent no time for this lap.");
  }
  const [s1, s2, s3] = timing.sectorsMs;
  if (
    timing.source === "session_history" &&
    timing.lapTimeMs != null &&
    s1 != null &&
    s2 != null &&
    s3 != null &&
    Math.abs(s1 + s2 + s3 - timing.lapTimeMs) > SECTOR_SUM_TOLERANCE_MS
  ) {
    note(
      "sector_sum",
      `Sector times sum to ${s1 + s2 + s3} ms, the lap time is ${timing.lapTimeMs} ms.`,
    );
  }

  let coverage: LapCoverage | null = null;
  if (trace != null) {
    coverage = coverageOf(trace, timing, trackLengthM);
    if (coverage.samples === 0) {
      block("no_samples", "No sample of this lap carries Lap Data.");
    } else {
      if (coverage.density != null && coverage.density < MIN_DENSITY) {
        block(
          "sparse",
          `${coverage.samples} of about ${coverage.expectedSamples} samples a 10 Hz recording of this lap would hold (${percent(coverage.density)}).`,
        );
      }
      if (coverage.timeCoverage == null) {
        block(
          "coverage_unknown",
          "The trace does not retain all individual lap-time readings; lap-clock coverage cannot be established.",
        );
      }
      if ((coverage.maxIntervalMs ?? 0) > CONTINUITY_MS) {
        block(
          "breaks",
          `The longest recorded sampling interval is ${Math.round(coverage.maxIntervalMs!)} ms (limit ${CONTINUITY_MS} ms).`,
        );
      } else if (
        coverage.timeCoverage != null &&
        coverage.timeCoverage < MIN_TIME_COVERAGE
      ) {
        block(
          "breaks",
          `Samples cover ${percent(coverage.timeCoverage)} of the lap without a lap-clock break longer than ${CONTINUITY_MS} ms.`,
        );
      }
      if (coverage.startCaptured === false) {
        block(
          "start_missing",
          `The first sample is at ${Math.round(coverage.firstMs ?? 0)} ms into the lap.`,
        );
      }
      if (coverage.endCaptured === false) {
        block(
          "end_missing",
          `The last sample is ${Math.round((timing.lapTimeMs ?? 0) - (coverage.lastMs ?? 0))} ms before the lap ended.`,
        );
      }
      if (
        timing.lapTimeMs != null &&
        coverage.lastMs != null &&
        coverage.lastMs > timing.lapTimeMs + EDGE_MS
      ) {
        block(
          "runs_past_lap_time",
          `Recorded lap time reaches ${Math.round(coverage.lastMs)} ms, past the ${timing.lapTimeMs} ms the lap record states.`,
        );
      }
      if (
        coverage.distanceCoverage != null &&
        coverage.distanceCoverage < MIN_DISTANCE_COVERAGE
      ) {
        block(
          "low_distance_coverage",
          `Recorded distance spans ${percent(coverage.distanceCoverage)} of the circuit.`,
        );
      }
      if (coverage.missingDistance > 0) {
        block(
          "distance_missing",
          `${coverage.missingDistance} sample${coverage.missingDistance === 1 ? "" : "s"} of this lap carr${coverage.missingDistance === 1 ? "ies" : "y"} no lap distance, so the lap cannot be aligned on distance.`,
        );
      }
      if (coverage.reversals > 0) {
        block(
          "reversals",
          `The lap runs backwards ${coverage.reversals} time${coverage.reversals === 1 ? "" : "s"} (a flashback or reversing).`,
        );
      }
      if (coverage.unattributed > 0) {
        note(
          "unattributed",
          `${coverage.unattributed} sample${coverage.unattributed === 1 ? "" : "s"} inside the lap carried no Lap Data.`,
        );
      }
      if (coverage.telemetryGaps > 0) {
        note(
          "telemetry_gaps",
          `${coverage.telemetryGaps} telemetry gap${coverage.telemetryGaps === 1 ? "" : "s"} over one second.`,
        );
      }
    }
  }

  const time = trace != null && playbackMap(trace, "time").available;
  // M3's own distance replay map decides distance replay. A trace on either
  // axis carries the lap's recorded time and distance, so it applies to
  // whichever is loaded.
  const distanceMap = trace == null ? null : playbackMap(trace, "distance");
  const distance = distanceMap?.available === true;
  const blocking = issues.filter((issue) => issue.severity === "blocking");
  const reasons = blocking.map((issue) => issue.text);
  if (trace == null) reasons.unshift("The lap's samples are not loaded.");
  if (distanceMap != null && !distanceMap.available && !reasons.length) {
    reasons.push(distanceMap.reason);
  }
  return {
    lap,
    timing,
    coverage,
    replay: { time, distance },
    distanceAnalysis: { eligible: reasons.length === 0, reasons },
    issues,
  };
}

/// The M5/M6 gate: two laps can be compared on distance, and later given a
/// time delta, only when both are eligible on their own and describe the
/// same circuit. Reasons name the lap they come from.
export function comparisonReadiness(
  current: LapQuality | null,
  reference: LapQuality | null,
): { ready: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (current == null) reasons.push("No current lap is selected.");
  if (reference == null) reasons.push("No reference lap is selected.");
  for (const [name, quality] of [
    ["Current lap", current],
    ["Reference lap", reference],
  ] as const) {
    if (quality == null) continue;
    for (const reason of quality.distanceAnalysis.reasons) {
      reasons.push(`${name} ${quality.lap}: ${reason}`);
    }
  }
  if (current != null && reference != null && current.lap === reference.lap) {
    reasons.push("Current and reference are the same lap.");
  }
  return { ready: reasons.length === 0, reasons };
}

// ------------------------------------------------------------ presentation

export type QualityTone = "ok" | "warn" | "bad" | "neutral";

export function sourceLabel(quality: LapQuality): string {
  switch (quality.timing.source) {
    case "session_history":
      return "History";
    case "lap_data":
      return "Provisional";
    case "unrecorded":
      return "No record";
  }
}

export function validityLabel(quality: LapQuality): {
  label: string;
  tone: QualityTone;
} {
  if (quality.timing.valid === true) return { label: "Valid", tone: "ok" };
  if (quality.timing.valid === false) return { label: "Invalid", tone: "bad" };
  return { label: "Validity unknown", tone: "warn" };
}

/// One status per lap: what it can be used for.
export function analysisStatus(quality: LapQuality): {
  label: string;
  tone: QualityTone;
} {
  if (quality.coverage == null) {
    return { label: "Samples not loaded", tone: "neutral" };
  }
  if (quality.distanceAnalysis.eligible) {
    return { label: "Analysis ready", tone: "ok" };
  }
  if (quality.replay.distance) return { label: "Replay only", tone: "warn" };
  if (quality.replay.time) return { label: "Time replay only", tone: "warn" };
  return { label: "Not replayable", tone: "bad" };
}
