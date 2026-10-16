import test from "node:test";
import assert from "node:assert/strict";
import {
  compareLaps,
  COMPARE_CHANNELS,
  differenceAt,
  formatDifference,
  isCompareChannel,
  MIN_COMPARED_SHARE,
} from "../src/lap-comparison.ts";
import { syntheticTrace } from "../review/lab-fixtures.ts";

// Deterministic distance traces: one reading per bucket unless a test
// removes it. `values` maps a channel to its reading at bucket centre x.

const READY = { ready: true, reasons: [] };

function distanceTrace({
  start = 0,
  width = 10,
  count = 100,
  values = {},
  holes = {},
  gaps = [],
  kind = "lap_distance",
} = {}) {
  const xs = Array.from({ length: count }, (_, i) => start + (i + 0.5) * width);
  const channel = (id) => {
    const of = values[id] ?? (() => 0);
    const hole = holes[id] ?? (() => false);
    const last = xs.map((x) => (hole(x) ? null : of(x)));
    return {
      channel: id,
      unit: id,
      min: last,
      max: last,
      last,
      samples: last.map((v) => (v == null ? 0 : 1)),
      missing: last.map(() => 0),
      total_samples: last.filter((v) => v != null).length,
      total_missing: 0,
      total_non_finite: 0,
    };
  };
  return {
    schema_version: 2,
    session_id: "test",
    game: "f1_25",
    scope: { lap: 1, stream_records: count, unattributed_records: 0 },
    source: {
      format: "rlf1",
      container_version: 1,
      payload_schema_version: 1,
      recorded_by_racelab_version: "test",
      nominal_sample_rate_hz: 10,
      stream_complete: true,
      truncated_tail: false,
      declared_records: count,
      recorder_dropped_frames: null,
      f1_integrity: null,
    },
    axis: {
      kind,
      unit: kind === "lap_distance" ? "m" : "ms",
      origin: "start_finish_line",
      start,
      end: start + count * width,
      records: count,
      bucket_width: width,
      bucket_count: count,
      max_interval_ms: 100,
      reversals: 0,
    },
    bucket_records: xs.map(() => 1),
    gaps: { threshold_ms: 1000, total: gaps.length, stored: gaps },
    channels: ["speed", "throttle", "brake", "steering"].map(channel),
  };
}

test("only Distance sync and an M4-qualified pair are compared", () => {
  const current = distanceTrace();
  const reference = distanceTrace();
  const time = compareLaps({
    axis: "time",
    current,
    reference,
    readiness: READY,
  });
  assert.equal(time.available, false);
  assert.match(time.reason, /Distance sync/);

  const blocked = compareLaps({
    axis: "distance",
    current,
    reference,
    readiness: {
      ready: false,
      reasons: ["Reference lap 3: The game marked this lap invalid."],
    },
  });
  assert.deepEqual(blocked, {
    available: false,
    reason: "Reference lap 3: The game marked this lap invalid.",
  });

  const missing = compareLaps({
    axis: "distance",
    current,
    reference: null,
    readiness: READY,
  });
  assert.equal(missing.available, false);
});

test("a trace still on the lap-time axis is never compared on distance", () => {
  const result = compareLaps({
    axis: "distance",
    current: distanceTrace(),
    reference: distanceTrace({ kind: "lap_time" }),
    readiness: READY,
  });
  assert.equal(result.available, false);
  assert.match(result.reason, /still loading/);
});

test("differences are current minus reference at the same distance", () => {
  const current = distanceTrace({
    values: { speed: (x) => 200 + x / 100, throttle: () => 1, brake: () => 0 },
  });
  const reference = distanceTrace({
    values: { speed: (x) => 190 + x / 100, throttle: () => 0.75 },
  });
  const result = compareLaps({
    axis: "distance",
    current,
    reference,
    readiness: READY,
  });
  assert.equal(result.available, true);
  assert.equal(result.x0, 0);
  assert.equal(result.x1, 1000);
  assert.equal(result.step, 10);
  assert.equal(result.positions.length, 101);
  const speed = result.channels.speed;
  assert.equal(speed.summary.meanDifference, 10);
  assert.ok(speed.differences.every((d) => d === null || d === 10));
  assert.equal(result.channels.throttle.summary.meanDifference, 0.25);
  assert.equal(result.channels.brake.summary.meanDifference, 0);
  assert.equal(result.channels.steering.summary.largest.difference, 0);
  assert.equal(differenceAt(result, current, reference, "speed", 505), 10);
  assert.deepEqual(Object.keys(result.channels), COMPARE_CHANNELS);
});

test("the largest difference is located on the circuit, either sign", () => {
  const current = distanceTrace({
    values: { brake: (x) => (x > 400 && x < 420 ? 0.2 : 0) },
  });
  const reference = distanceTrace({
    values: { brake: (x) => (x > 400 && x < 420 ? 0.9 : 0) },
  });
  const result = compareLaps({
    axis: "distance",
    current,
    reference,
    readiness: READY,
  });
  const largest = result.channels.brake.summary.largest;
  assert.ok(Math.abs(largest.difference - -0.7) < 1e-9);
  assert.ok(largest.x >= 400 && largest.x <= 420);
});

test("only the stretch both laps recorded is compared", () => {
  const current = distanceTrace({ start: 0, count: 100 });
  const reference = distanceTrace({ start: 50, count: 100, width: 10 });
  const result = compareLaps({
    axis: "distance",
    current,
    reference,
    readiness: READY,
  });
  assert.equal(result.x0, 50);
  assert.equal(result.x1, 1000);
  assert.equal(differenceAt(result, current, reference, "speed", 20), null);
  assert.equal(differenceAt(result, current, reference, "speed", 1040), null);
});

test("the grid follows the coarser lap and is never finer than a metre", () => {
  const coarse = compareLaps({
    axis: "distance",
    current: distanceTrace({ width: 4, count: 250 }),
    reference: distanceTrace({ width: 5, count: 200 }),
    readiness: READY,
  });
  assert.equal(coarse.step, 5);
  const fine = compareLaps({
    axis: "distance",
    current: distanceTrace({ width: 0.2, count: 500 }),
    reference: distanceTrace({ width: 0.2, count: 500 }),
    readiness: READY,
  });
  assert.equal(fine.step, 1);
});

test("a missing reading is never filled in, and too few withhold figures", () => {
  // The reference carries no steering over the first 20% of the lap.
  const current = distanceTrace({ values: { steering: () => 0.1 } });
  const reference = distanceTrace({
    values: { steering: () => 0.05 },
    holes: { steering: (x) => x < 200 },
  });
  const result = compareLaps({
    axis: "distance",
    current,
    reference,
    readiness: READY,
  });
  const steering = result.channels.steering;
  assert.equal(steering.summary, null);
  assert.ok(steering.share < MIN_COMPARED_SHARE);
  assert.match(steering.reason, /80% of the shared distance/);
  assert.equal(steering.differences[5], null);
  assert.equal(differenceAt(result, current, reference, "steering", 105), null);
  // The other channels are unaffected.
  assert.notEqual(result.channels.speed.summary, null);
});

test("a telemetry gap is not bridged by an earlier reading", () => {
  const current = distanceTrace({
    values: { speed: () => 200 },
    holes: { speed: (x) => x > 300 && x < 320 },
    gaps: [{ start: 300, end: 320 }],
  });
  const reference = distanceTrace({ values: { speed: () => 180 } });
  const result = compareLaps({
    axis: "distance",
    current,
    reference,
    readiness: READY,
  });
  assert.equal(differenceAt(result, current, reference, "speed", 312), null);
  assert.equal(result.channels.speed.differences[31], null);
});

test("two synthetic laps compare deterministically", () => {
  const channels = ["speed", "throttle", "brake", "steering"];
  const run = () =>
    compareLaps({
      axis: "distance",
      current: syntheticTrace("s", 2, "distance", channels, 1400, 5891),
      reference: syntheticTrace("s", 1, "distance", channels, 1400, 5891),
      readiness: READY,
    });
  const first = run();
  const second = run();
  assert.equal(first.available, true);
  assert.deepEqual(first, second);
  for (const id of COMPARE_CHANNELS) {
    assert.ok(first.channels[id].share >= MIN_COMPARED_SHARE, id);
    assert.notEqual(first.channels[id].summary, null, id);
  }
  // Laps of different pace differ somewhere on speed.
  assert.notEqual(first.channels.speed.summary.largest.difference, 0);
});

test("differences read in the channel's display unit with a sign", () => {
  assert.equal(formatDifference("speed", 12.4), "+12");
  assert.equal(formatDifference("speed", -3.6), "−4");
  assert.equal(formatDifference("throttle", 0.25), "+25");
  assert.equal(formatDifference("brake", -0.004), "0");
  assert.equal(formatDifference("steering", -0.12), "−12");
  assert.equal(formatDifference("speed", null), "—");
  assert.equal(formatDifference("speed", Number.NaN), "—");
  assert.equal(isCompareChannel("rpm"), false);
  assert.equal(isCompareChannel("brake"), true);
});
