import test from "node:test";
import assert from "node:assert/strict";
import {
  deltaAt,
  deltaPath,
  deltaRange,
  formatDelta,
  lapDelta,
  MIN_DELTA_SHARE,
  timeAt,
  timeline,
} from "../src/lap-delta.ts";
import { syntheticTrace } from "../review/lab-fixtures.ts";

// Deterministic distance traces: one Lap Data reading per bucket, at the
// bucket centre, reached at `time(x)` milliseconds into the lap.

const READY = { ready: true, reasons: [] };

function lapTrace({
  width = 10,
  count = 100,
  time = (x) => (x / 50) * 1000, // 50 m/s: 200 ms per 10 m
  holes = () => false,
  gaps = [],
  reversals = 0,
  kind = "lap_distance",
} = {}) {
  const xs = Array.from({ length: count }, (_, i) => (i + 0.5) * width);
  const channel = (id, of) => {
    const last = xs.map((x) => (holes(x) ? null : of(x)));
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
      unit: "m",
      origin: "start_finish_line",
      start: 0,
      end: count * width,
      records: count,
      bucket_width: width,
      bucket_count: count,
      max_interval_ms: 100,
      reversals,
    },
    bucket_records: xs.map((x) => (holes(x) ? 0 : 1)),
    gaps: { threshold_ms: 1000, total: gaps.length, stored: gaps },
    channels: [
      channel("speed", () => 180),
      channel("lap_time", time),
      channel("lap_distance", (x) => x),
    ],
  };
}

const run = (current, reference, readiness = READY, axis = "distance") =>
  lapDelta({ axis, current, reference, readiness });

const near = (actual, expected, what) =>
  assert.ok(
    actual != null && Math.abs(actual - expected) < 1e-6,
    `${what}: ${actual} vs ${expected}`,
  );

test("equal laps have zero delta everywhere", () => {
  const delta = run(lapTrace(), lapTrace());
  assert.equal(delta.available, true);
  assert.ok(delta.deltas.every((ms) => ms === 0));
  assert.deepEqual(delta.final, { x: 995, ms: 0 });
  assert.equal(formatDelta(deltaAt(delta, 500)), "0.000");
});

test("known constant speeds give the exact delta at every distance", () => {
  // Current at 40 m/s, reference at 50 m/s: 5 ms slower per metre.
  const current = lapTrace({ time: (x) => (x / 40) * 1000 });
  const reference = lapTrace({ time: (x) => (x / 50) * 1000 });
  const delta = run(current, reference);
  assert.equal(delta.available, true);
  for (const x of [5, 123, 500, 777.7, 995]) {
    near(deltaAt(delta, x), x * 5, `at ${x}`);
  }
  // Positive means the current lap is slower.
  near(delta.final.ms, 4975, "final");
  assert.equal(delta.largest.x, 995);
  assert.equal(formatDelta(delta.final.ms), "+4.975");
  // Swapped, faster is negative.
  const swapped = run(reference, current);
  near(swapped.final.ms, -4975, "swapped");
  assert.equal(formatDelta(swapped.final.ms), "−4.975");
});

test("time lost in one corner stays lost for the rest of the lap", () => {
  // The current lap loses 300 ms between 400 m and 500 m.
  const base = (x) => (x / 50) * 1000;
  const current = lapTrace({
    time: (x) => base(x) + (x <= 400 ? 0 : x >= 500 ? 300 : (x - 400) * 3),
  });
  const delta = run(current, lapTrace());
  near(deltaAt(delta, 300), 0, "before");
  near(deltaAt(delta, 455), 165, "inside");
  near(deltaAt(delta, 900), 300, "after");
});

test("time is read only from recorded readings, never outside them", () => {
  const line = timeline(lapTrace());
  assert.equal(line.available, true);
  assert.equal(timeAt(line, 0), null); // before the first reading
  assert.equal(timeAt(line, 1000), null); // after the last
  assert.equal(timeAt(line, 5), 100); // exactly at a reading
  assert.equal(timeAt(line, 10), 200); // between two adjacent readings
});

test("a missing stretch is never bridged, and too much withholds the delta", () => {
  // 40 m without Lap Data: a 1000 ms step, over the 300 ms limit.
  const short = run(lapTrace({ holes: (x) => x > 400 && x < 440 }), lapTrace());
  assert.equal(short.available, true);
  assert.equal(deltaAt(short, 420), null);
  assert.ok(short.deltas.some((ms) => ms == null));
  assert.ok(short.share >= MIN_DELTA_SHARE);
  // The pen lifts across it.
  const path = deltaPath(
    short,
    { x0: 0, x1: 1000 },
    { width: 1000, height: 100 },
  );
  assert.equal(path.match(/M/g).length, 2);

  const long = run(lapTrace({ holes: (x) => x > 300 && x < 400 }), lapTrace());
  assert.equal(long.available, false);
  assert.match(long.reason, /over 9\d% of the shared distance/);
});

test("a stored telemetry gap is never interpolated across", () => {
  // Readings 200 ms apart, yet a gap is recorded between 505 m and 515 m.
  const current = lapTrace({ gaps: [{ start: 505, end: 515 }] });
  const delta = run(current, lapTrace());
  assert.equal(deltaAt(delta, 510), null);
  assert.equal(deltaAt(delta, 505), 0);
  assert.equal(deltaAt(delta, 520), 0);
});

test("unsupported records and failed quality give a reason, never a number", () => {
  const ok = lapTrace();
  const time = run(ok, ok, READY, "time");
  assert.equal(time.available, false);
  assert.match(time.reason, /Distance sync/);
  assert.equal(deltaAt(time, 100), null);
  assert.equal(deltaPath(time, { x0: 0, x1: 1 }, { width: 1, height: 1 }), "");

  const reason =
    "Current lap 2: Provisional: from Lap Data; Session History never confirmed this lap.";
  assert.deepEqual(run(ok, lapTrace(), { ready: false, reasons: [reason] }), {
    available: false,
    reason,
  });

  const reversed = run(lapTrace({ reversals: 1 }), ok);
  assert.equal(reversed.available, false);
  assert.match(reversed.reason, /^Current lap: The lap runs backwards/);

  // Lap time falling while distance rises (a lap-clock reset).
  const backwards = run(ok, lapTrace({ time: (x) => (x > 500 ? x : x * 20) }));
  assert.equal(backwards.available, false);
  assert.match(backwards.reason, /^Reference lap: .*does not rise/);

  const stale = run(ok, lapTrace({ kind: "lap_time" }));
  assert.equal(stale.available, false);
  assert.match(stale.reason, /still loading/);
});

test("the delta of two synthetic laps ends at their recorded lap-time gap", () => {
  const channels = ["speed", "lap_time", "lap_distance"];
  const make = (lap) =>
    syntheticTrace("s", lap, "distance", channels, 1400, 5891);
  const first = run(make(2), make(1));
  assert.deepEqual(first, run(make(2), make(1)));
  assert.equal(first.available, true);
  // Lap 2 is 1:41.162 and lap 1 1:40.781 in the review fixtures: about
  // +0.38 s by the end, within a 10 Hz reading of each lap.
  assert.ok(Math.abs(first.final.ms - 381) <= 200, `${first.final.ms}`);
});

test("signed seconds and a symmetric scale", () => {
  assert.equal(formatDelta(381.4), "+0.381");
  assert.equal(formatDelta(-1204.6), "−1.205");
  assert.equal(formatDelta(0.4), "0.000");
  assert.equal(formatDelta(null), "—");
  assert.equal(deltaRange({ available: false, reason: "" }), 500);
  const big = run(lapTrace({ time: (x) => (x / 40) * 1000 }), lapTrace());
  assert.equal(deltaRange(big), 5000);
});
