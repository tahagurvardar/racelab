import test from "node:test";
import assert from "node:assert/strict";
import {
  assessLap,
  comparisonReadiness,
  CONTINUITY_MS,
  EDGE_MS,
  SAMPLE_INTERVAL_MS,
} from "../src/lap-quality.ts";

// Deterministic synthetic laps; trace() retains individual readings and
// aggregatedTrace() applies the backend's integer bucket boundaries.

const TRACK = 5891;
const LAP_MS = 91_234;

/// A lap's samples: lap times, and the distance at each (linear unless
/// `distance` says otherwise).
function samples({
  from = 0,
  to = LAP_MS - 34,
  step = SAMPLE_INTERVAL_MS,
  skip = () => false,
  distance = (t) => (t / LAP_MS) * TRACK,
} = {}) {
  const out = [];
  for (let t = from; t <= to; t += step) {
    if (!skip(t)) out.push({ t, d: distance(t) });
  }
  return out;
}

function trace(points, { reversals = 0, unattributed = 0, gaps = 0 } = {}) {
  const channel = (id, values) => ({
    channel: id,
    unit: id,
    min: values,
    max: values,
    last: values,
    samples: values.map((v) => (v == null ? 0 : 1)),
    missing: values.map((v) => (v == null ? 1 : 0)),
    total_samples: values.filter((v) => v != null).length,
    total_missing: values.filter((v) => v == null).length,
    total_non_finite: 0,
  });
  const ts = points.map((p) => p.t);
  return {
    schema_version: 2,
    session_id: "f1-review-race",
    game: "f1_25",
    scope: {
      lap: 1,
      stream_records: points.length,
      unattributed_records: unattributed,
    },
    source: {
      format: "rlf1",
      container_version: 1,
      payload_schema_version: 1,
      recorded_by_racelab_version: "test",
      nominal_sample_rate_hz: 10,
      stream_complete: true,
      truncated_tail: false,
      declared_records: points.length,
      recorder_dropped_frames: null,
      f1_integrity: null,
    },
    axis: {
      kind: "lap_time",
      unit: "ms",
      origin: "lap_start",
      start: ts[0] ?? 0,
      end: ts[ts.length - 1] ?? 0,
      records: points.length,
      bucket_width: SAMPLE_INTERVAL_MS,
      bucket_count: points.length,
      max_interval_ms: Math.max(0, ...ts.slice(1).map((t, i) => t - ts[i])),
      reversals,
    },
    bucket_records: points.map(() => 1),
    gaps: {
      threshold_ms: 1000,
      total: gaps,
      stored: [],
    },
    channels: [
      channel(
        "speed",
        points.map(() => 200),
      ),
      channel(
        "lap_time",
        points.map((p) => p.t),
      ),
      channel(
        "lap_distance",
        points.map((p) => p.d),
      ),
    ],
  };
}

function aggregatedTrace(points, buckets, axis = "time") {
  const result = trace(points);
  const ticks = points.map((p) =>
    axis === "time" ? p.t : Math.round(p.d * 1000),
  );
  const low = Math.min(...ticks);
  const high = Math.max(...ticks);
  const width = Math.max(1, Math.ceil((high - low + 1) / buckets));
  const count = Math.floor((high - low) / width) + 1;
  const groups = Array.from({ length: count }, () => []);
  ticks.forEach((x, i) => groups[Math.floor((x - low) / width)].push(i));
  result.channels = result.channels.map((channel) => {
    const values = groups.map((indices) => indices.map((i) => channel.last[i]));
    return {
      ...channel,
      min: values.map((v) => (v.length ? Math.min(...v) : null)),
      max: values.map((v) => (v.length ? Math.max(...v) : null)),
      last: values.map((v) => v.at(-1) ?? null),
      samples: values.map((v) => v.length),
      missing: values.map(() => 0),
    };
  });
  const scale = axis === "time" ? 1 : 1000;
  Object.assign(result.axis, {
    kind: axis === "time" ? "lap_time" : "lap_distance",
    unit: axis === "time" ? "ms" : "m",
    origin: axis === "time" ? "lap_start" : "start_finish_line",
    start: low / scale,
    end: high / scale,
    bucket_width: width / scale,
    bucket_count: count,
  });
  result.bucket_records = groups.map((g) => g.length);
  return result;
}

function record(overrides = {}) {
  return {
    lap_number: 1,
    source: "session_history",
    lap_time_ms: LAP_MS,
    sector1_ms: 30_000,
    sector2_ms: 31_000,
    sector3_ms: 30_234,
    valid_bit_flags: 15,
    lap_valid: true,
    sector1_valid: true,
    sector2_valid: true,
    sector3_valid: true,
    position_at_end: 2,
    position_at_start: 3,
    recorded_at_monotonic_ms: 91_000,
    ...overrides,
  };
}

const codes = (quality) => quality.issues.map((issue) => issue.code);

test("aggregation at 1400 versus 100 buckets does not invent sampling breaks", () => {
  for (const axis of ["time", "distance"]) {
    const fine = assessLap(
      1,
      record(),
      aggregatedTrace(samples(), 1400, axis),
      TRACK,
    );
    const coarse = assessLap(
      2,
      record(),
      aggregatedTrace(samples(), 100, axis),
      TRACK,
    );
    assert.equal(fine.coverage.timeCoverage, 1);
    assert.equal(fine.distanceAnalysis.eligible, true);
    assert.equal(coarse.coverage.maxIntervalMs, 100);
    assert.ok(!codes(coarse).includes("breaks"));
    assert.equal(coarse.coverage.timeCoverage, null);
    assert.equal(coarse.coverage.maxDistanceStepM, null);
    assert.ok(codes(coarse).includes("coverage_unknown"));
    assert.equal(coarse.distanceAnalysis.eligible, false);
    assert.equal(comparisonReadiness(fine, coarse).ready, false);
    assert.equal(coarse.coverage.samples, 913);
    assert.equal(coarse.coverage.density, 1);
    assert.equal(coarse.coverage.startCaptured, true);
    assert.equal(coarse.coverage.endCaptured, true);
  }
});

/// Linear lap distance, except a slow stretch from 40 s to 42 s that
/// advances `slowM` metres per sample: a hairpin on the distance axis.
function hairpin(slowM) {
  const fast = (TRACK - 20 * slowM) / ((LAP_MS - 2000) / SAMPLE_INTERVAL_MS);
  return (t) => {
    const steps = t / SAMPLE_INTERVAL_MS;
    if (t <= 40_000) return steps * fast;
    if (t <= 42_000) return 400 * fast + (steps - 400) * slowM;
    return (steps - 20) * fast + 20 * slowM;
  };
}

test("two readings in one distance bucket are both retained, more are not", () => {
  const most = (input) =>
    Math.max(...input.channels.find((c) => c.channel === "lap_time").samples);
  // A 2000-bucket distance axis on this circuit is about 2.95 m wide.
  const two = aggregatedTrace(
    samples({ distance: hairpin(1.6) }),
    2000,
    "distance",
  );
  assert.equal(most(two), 2);
  const kept = assessLap(1, record(), two, TRACK);
  assert.equal(kept.coverage.timeCoverage, 1);
  assert.ok(!codes(kept).includes("coverage_unknown"));
  assert.equal(kept.distanceAnalysis.eligible, true);

  const three = aggregatedTrace(
    samples({ distance: hairpin(0.9) }),
    2000,
    "distance",
  );
  assert.ok(most(three) >= 3);
  const lost = assessLap(1, record(), three, TRACK);
  assert.equal(lost.coverage.timeCoverage, null);
  assert.ok(codes(lost).includes("coverage_unknown"));
  assert.equal(lost.distanceAnalysis.eligible, false);

  // Two readings are only proven when the lap never runs backwards.
  two.axis.reversals = 1;
  assert.equal(assessLap(1, record(), two, TRACK).coverage.timeCoverage, null);
});

test("missing lap-distance readings block analysis, not replay", () => {
  // Every lap-time reading is there; 20 s of lap distance is not (201
  // readings, about 1.3 km), while the first and last distances still
  // span the whole circuit.
  const points = samples().map((point) =>
    point.t >= 40_000 && point.t <= 60_000 ? { ...point, d: null } : point,
  );
  assert.equal(points.filter((point) => point.d == null).length, 201);
  const quality = assessLap(1, record(), trace(points), TRACK);
  assert.equal(quality.coverage.timeCoverage, 1);
  assert.ok(quality.coverage.distanceCoverage > 0.99);
  assert.equal(quality.coverage.missingDistance, 201);
  assert.ok(codes(quality).includes("distance_missing"));
  assert.equal(
    quality.issues.find((issue) => issue.code === "distance_missing").severity,
    "blocking",
  );
  assert.equal(quality.distanceAnalysis.eligible, false);
  // Replay is M3's own decision, not this one.
  assert.equal(quality.replay.time, true);

  // The same gap in a bucketed trace is still counted.
  const bucketed = aggregatedTrace(samples(), 100);
  const distance = bucketed.channels.find((c) => c.channel === "lap_distance");
  distance.samples = distance.samples.map((count, index) =>
    index >= 40 && index < 60 ? 0 : count,
  );
  const coarse = assessLap(1, record(), bucketed, TRACK);
  assert.ok(coarse.coverage.missingDistance > 0);
  assert.ok(codes(coarse).includes("distance_missing"));
});

test("a provisional record never carries an S3", () => {
  const quality = assessLap(
    1,
    record({ source: "lap_data", sector3_ms: 30_234, sector3_valid: true }),
    null,
    TRACK,
  );
  assert.deepEqual(quality.timing.sectorsMs, [30_000, 31_000, null]);
  assert.deepEqual(quality.timing.sectorsValid, [true, true, null]);
});

test("aggregated traces retain real recording gaps including sub-second gaps", () => {
  for (const gap of [600, 6000]) {
    const points = samples({ skip: (t) => t > 40_000 && t < 40_000 + gap });
    const quality = assessLap(1, record(), aggregatedTrace(points, 100), TRACK);
    assert.equal(quality.coverage.maxIntervalMs, gap);
    assert.equal(quality.coverage.timeCoverage, null);
    assert.ok(codes(quality).includes("breaks"));
    assert.equal(quality.distanceAnalysis.eligible, false);
  }
});

test("a regular recording clock does not prove aggregated lap-clock continuity", () => {
  const input = aggregatedTrace(samples(), 100);
  // A game-clock jump can occur while recorder samples remain 100 ms apart.
  const time = input.channels.find((c) => c.channel === "lap_time");
  for (const field of ["min", "max", "last"]) {
    time[field] = time[field].map((t) => (t < 45_000 ? t : t + 1000));
  }
  const quality = assessLap(1, record(), input, TRACK);
  assert.equal(quality.coverage.maxIntervalMs, 100);
  assert.equal(quality.coverage.timeCoverage, null);
  assert.ok(codes(quality).includes("coverage_unknown"));
  assert.equal(quality.distanceAnalysis.eligible, false);
});

test("aggregation preserves sparse, endpoint, reversal and timing findings", () => {
  const input = aggregatedTrace(
    samples({ from: 2000, to: 89_000, step: 200 }),
    100,
  );
  input.axis.reversals = 1;
  const quality = assessLap(
    1,
    record({ source: "lap_data", lap_valid: false }),
    input,
    TRACK,
  );
  for (const code of [
    "sparse",
    "start_missing",
    "end_missing",
    "reversals",
    "provisional",
    "invalid",
  ]) {
    assert.ok(codes(quality).includes(code), code);
  }
  assert.equal(quality.distanceAnalysis.eligible, false);
});

test("a complete, valid History lap is eligible for distance-aligned analysis", () => {
  const quality = assessLap(1, record(), trace(samples()), TRACK);
  assert.deepEqual(quality.issues, []);
  assert.equal(quality.distanceAnalysis.eligible, true);
  assert.deepEqual(quality.replay, { time: true, distance: true });
  assert.equal(quality.timing.source, "session_history");
  assert.deepEqual(quality.timing.sectorsMs, [30_000, 31_000, 30_234]);
  const c = quality.coverage;
  assert.equal(c.samples, 913);
  assert.equal(c.expectedSamples, 913);
  assert.equal(c.density, 1);
  assert.equal(c.timeCoverage, 1);
  assert.equal(c.maxIntervalMs, 100);
  assert.equal(c.startCaptured, true);
  assert.equal(c.endCaptured, true);
  assert.ok(c.distanceCoverage > 0.99);
});

test("provisional, invalid and unknown-validity laps replay but are not eligible", () => {
  const provisional = assessLap(
    2,
    record({
      source: "lap_data",
      sector3_ms: null,
      lap_valid: null,
      sector1_valid: null,
      sector2_valid: null,
      sector3_valid: null,
      valid_bit_flags: null,
    }),
    trace(samples()),
    TRACK,
  );
  assert.deepEqual(codes(provisional), ["provisional", "validity_unknown"]);
  assert.equal(provisional.replay.distance, true);
  assert.equal(provisional.distanceAnalysis.eligible, false);
  // A provisional record never carries S3; it stays unavailable.
  assert.equal(provisional.timing.sectorsMs[2], null);

  const invalid = assessLap(
    1,
    record({ lap_valid: false }),
    trace(samples()),
    TRACK,
  );
  assert.deepEqual(codes(invalid), ["invalid"]);
  assert.equal(invalid.distanceAnalysis.eligible, false);
});

test("a lap time the game did not send is unavailable, never zero", () => {
  const quality = assessLap(
    1,
    record({ lap_time_ms: 0 }),
    trace(samples()),
    TRACK,
  );
  assert.equal(quality.timing.lapTimeMs, null);
  assert.equal(quality.coverage.expectedSamples, null);
  assert.equal(quality.coverage.density, null);
  assert.equal(quality.coverage.endCaptured, null);
  assert.ok(codes(quality).includes("no_lap_time"));
  // Zero sectors are unsent sectors too.
  const zeroSector = assessLap(
    1,
    record({ sector2_ms: 0 }),
    trace(samples()),
    TRACK,
  );
  assert.equal(zeroSector.timing.sectorsMs[1], null);
});

test("sparse Lap Data is measured against a 10 Hz recording of the lap", () => {
  // Every other sample missing: 200 ms steps are still unbroken coverage.
  const quality = assessLap(
    1,
    record(),
    trace(samples({ skip: (t) => t % 200 === 100 })),
    TRACK,
  );
  assert.ok(codes(quality).includes("sparse"));
  assert.ok(quality.coverage.density < 0.51 && quality.coverage.density > 0.49);
  assert.equal(quality.coverage.timeCoverage, 1);
  assert.equal(quality.distanceAnalysis.eligible, false);
});

test("breaks longer than three sample intervals reduce coverage", () => {
  // A 6 s hole mid-lap.
  const quality = assessLap(
    1,
    record(),
    trace(samples({ skip: (t) => t > 40_000 && t < 46_000 })),
    TRACK,
  );
  const c = quality.coverage;
  assert.equal(c.maxIntervalMs, 6000);
  assert.ok(c.timeCoverage < 0.95 && c.timeCoverage > 0.92);
  assert.ok(codes(quality).includes("breaks"));
  // Exactly CONTINUITY_MS is still continuous.
  const edge = assessLap(
    1,
    record(),
    trace(samples({ step: CONTINUITY_MS })),
    TRACK,
  );
  assert.equal(edge.coverage.timeCoverage, 1);
});

test("a lap whose start or end was not recorded says so", () => {
  const late = assessLap(1, record(), trace(samples({ from: 2000 })), TRACK);
  assert.equal(late.coverage.startCaptured, false);
  assert.ok(codes(late).includes("start_missing"));
  const early = assessLap(
    1,
    record(),
    trace(samples({ to: LAP_MS - 2000 })),
    TRACK,
  );
  assert.equal(early.coverage.endCaptured, false);
  assert.ok(codes(early).includes("end_missing"));
  // Exactly at the edge allowance, each end still counts as captured, and
  // its edge stretch as covered.
  const atStart = assessLap(
    1,
    record(),
    trace(samples({ from: EDGE_MS })),
    TRACK,
  );
  assert.equal(atStart.coverage.startCaptured, true);
  assert.equal(atStart.coverage.timeCoverage, 1);
  // 34 + 100k reaches LAP_MS - EDGE_MS exactly at the 10 Hz step.
  const atEnd = assessLap(
    1,
    record(),
    trace(samples({ from: 34, to: LAP_MS - EDGE_MS })),
    TRACK,
  );
  assert.equal(atEnd.coverage.lastMs, LAP_MS - EDGE_MS);
  assert.equal(atEnd.coverage.endCaptured, true);
  assert.equal(atEnd.coverage.timeCoverage, 1);
});

test("samples running past the recorded lap time are inconsistent, not trimmed", () => {
  const quality = assessLap(
    1,
    record(),
    trace(samples({ to: LAP_MS + 5000 })),
    TRACK,
  );
  assert.ok(codes(quality).includes("runs_past_lap_time"));
  assert.equal(quality.distanceAnalysis.eligible, false);
});

test("a flashback keeps a lap replayable on time only", () => {
  const quality = assessLap(
    1,
    record(),
    trace(samples(), { reversals: 1 }),
    TRACK,
  );
  assert.deepEqual(quality.replay, { time: true, distance: false });
  assert.ok(codes(quality).includes("reversals"));
  assert.equal(quality.distanceAnalysis.eligible, false);
});

test("distance that covers only part of the circuit is reported", () => {
  const quality = assessLap(
    1,
    record(),
    trace(samples({ distance: (t) => (t / LAP_MS) * 4000 })),
    TRACK,
  );
  assert.ok(quality.coverage.distanceCoverage < 0.7);
  assert.ok(codes(quality).includes("low_distance_coverage"));
  // Without a known track length coverage is unavailable, not assumed.
  const unknown = assessLap(1, record(), trace(samples()), null);
  assert.equal(unknown.coverage.distanceCoverage, null);
  assert.ok(!codes(unknown).includes("low_distance_coverage"));
});

test("notes are reported without blocking analysis", () => {
  const quality = assessLap(
    1,
    record({ sector3_ms: 30_000 }),
    trace(samples(), { unattributed: 2, gaps: 0 }),
    TRACK,
  );
  assert.deepEqual(codes(quality), ["sector_sum", "unattributed"]);
  assert.ok(quality.issues.every((issue) => issue.severity === "note"));
  assert.equal(quality.distanceAnalysis.eligible, true);
});

test("a lap with no samples or no loaded trace is never eligible", () => {
  const empty = assessLap(1, record(), trace([]), TRACK);
  assert.ok(codes(empty).includes("no_samples"));
  assert.deepEqual(empty.replay, { time: false, distance: false });
  const unloaded = assessLap(1, record(), null, TRACK);
  assert.equal(unloaded.coverage, null);
  assert.equal(unloaded.distanceAnalysis.eligible, false);
  assert.match(unloaded.distanceAnalysis.reasons[0], /not loaded/);
  const unrecorded = assessLap(7, null, trace(samples()), TRACK);
  assert.equal(unrecorded.timing.source, "unrecorded");
  assert.ok(codes(unrecorded).includes("no_record"));
});

test("readiness for comparison needs two different eligible laps", () => {
  const good = (lap) =>
    assessLap(lap, record({ lap_number: lap }), trace(samples()), TRACK);
  assert.deepEqual(comparisonReadiness(good(1), good(2)), {
    ready: true,
    reasons: [],
  });
  assert.equal(comparisonReadiness(good(1), good(1)).ready, false);
  const none = comparisonReadiness(good(1), null);
  assert.deepEqual(none.reasons, ["No reference lap is selected."]);
  const provisional = assessLap(
    2,
    record({ source: "lap_data", lap_valid: null }),
    trace(samples()),
    TRACK,
  );
  const blocked = comparisonReadiness(good(1), provisional);
  assert.equal(blocked.ready, false);
  assert.match(blocked.reasons[0], /^Reference lap 2: Provisional/);
});
