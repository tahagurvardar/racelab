import test from "node:test";
import assert from "node:assert/strict";
import { f1Detail } from "../review/f1-session-fixtures.ts";
import {
  defaultLaps,
  formatChannel,
  gearText,
  labLaps,
  labSession,
  seriesPath,
  sharedXDomain,
  steeringText,
  traceNotes,
  valueAt,
  xTicks,
  yDomain,
} from "../src/telemetry-lab.ts";
import { createLabController } from "../src/lab-controller.ts";

// A hand-built schema-2 lap trace: one bucket per entry of `speeds`, every
// bucket 10 m wide from `start`. `null` is a record without the value; an
// `undefined` entry is a bucket with no record at all.
function trace(speeds, { start = 0, gaps = [], reversals = 0, lap = 1 } = {}) {
  const count = speeds.length;
  const records = speeds.map((v) => (v === undefined ? 0 : 1));
  const channel = (id, scale = 1) => ({
    channel: id,
    unit: "kilometres_per_hour",
    min: speeds.map((v) => (v == null ? null : v * scale)),
    max: speeds.map((v) => (v == null ? null : v * scale)),
    last: speeds.map((v) => (v == null ? null : v * scale)),
    samples: speeds.map((v) => (v == null ? 0 : 1)),
    missing: speeds.map((v) => (v === null ? 1 : 0)),
    total_samples: speeds.filter((v) => v != null).length,
    total_missing: speeds.filter((v) => v === null).length,
    total_non_finite: 0,
  });
  return {
    schema_version: 2,
    session_id: "f1-review-race",
    game: "f1_25",
    scope: { lap, stream_records: count, unattributed_records: 0 },
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
      kind: "lap_distance",
      unit: "m",
      origin: "start_finish_line",
      start,
      end: start + (count - 1) * 10,
      records: records.reduce((a, b) => a + b, 0),
      bucket_width: 10,
      bucket_count: count,
      max_interval_ms: 100,
      reversals,
    },
    bucket_records: records,
    gaps: { threshold_ms: 1000, total: gaps.length, stored: gaps },
    channels: [channel("speed"), channel("gear", 0.01)],
  };
}

const PLOT = { width: 100, height: 100 };
const DOMAIN = { x0: 0, x1: 100, y0: 0, y1: 200 };

// ----------------------------------------------------------------- laps

test("laps come from the session's own lap records, flags included", () => {
  const laps = labLaps(f1Detail());
  assert.deepEqual(
    laps.map((lap) => [lap.label, lap.time, lap.best, lap.provisional]),
    [
      ["Lap 1", "1:31.234", true, false],
      ["Lap 2", "1:32.456", false, true],
    ],
  );
  assert.deepEqual(labLaps(null), []);
});

test("the latest lap is compared against the fastest other valid lap", () => {
  const lap = (number, timeMs, valid = true) => ({
    number,
    label: `Lap ${number}`,
    time: "",
    timeMs,
    valid,
    provisional: false,
    best: false,
  });
  assert.deepEqual(defaultLaps([]), { current: null, reference: null });
  assert.deepEqual(defaultLaps([lap(1, 90_000)]), {
    current: 1,
    reference: null,
  });
  // An invalid lap is never the default reference, even when fastest; a lap
  // the game sent no time for is not a candidate either.
  assert.deepEqual(
    defaultLaps([
      lap(1, 88_000, false),
      lap(2, 91_000),
      lap(3, 0),
      lap(4, 92_000),
    ]),
    { current: 4, reference: 2 },
  );
});

test("session facts are the recorded ones, and names are never invented", () => {
  const info = labSession(f1Detail());
  assert.equal(info.sessionType, "Race");
  assert.equal(info.trackLengthM, 5891);
  assert.equal(info.sector2StartM, 1700);
  assert.equal(info.raceNumber, "#44");
  // Participant names are never stored: the driver is described, not named.
  assert.equal(info.driver, "Player");
  assert.equal(info.sessionTime, "3:02");
  const empty = f1Detail();
  empty.session.f1_25.context_latest = null;
  empty.session.f1_25.context_at_start = null;
  empty.session.f1_25.participant = null;
  empty.labels.track = null;
  const unknown = labSession(empty);
  assert.equal(unknown.track, "—");
  assert.equal(unknown.trackTemperature, "—");
  assert.equal(unknown.raceNumber, "—");
  assert.equal(unknown.trackLengthM, null);
});

// ------------------------------------------------------------- readings

test("the cursor reading is the last sample at or before it, never across a gap", () => {
  const lap = trace([100, 110, undefined, 130, null, 150], {
    gaps: [{ start: 40, end: 50 }],
  });
  assert.equal(valueAt(lap, "speed", 0), 100);
  assert.equal(valueAt(lap, "speed", 14), 110);
  // A bucket with no record holds the previous reading.
  assert.equal(valueAt(lap, "speed", 24), 110);
  assert.equal(valueAt(lap, "speed", 30), 130);
  // A record without the value is unavailable, never the previous value.
  assert.equal(valueAt(lap, "speed", 44), null);
  // Outside the lap, and a channel the trace does not carry.
  assert.equal(valueAt(lap, "speed", -5), null);
  assert.equal(valueAt(lap, "speed", 51), null);
  assert.equal(valueAt(lap, "throttle", 10), null);
  assert.equal(valueAt(null, "speed", 10), null);
  // Across a telemetry gap the earlier reading is not carried over.
  const gapped = trace([100, undefined, undefined, 130], {
    gaps: [{ start: 0, end: 30 }],
  });
  assert.equal(valueAt(gapped, "speed", 20), null);
});

test("a zero reading is a reading", () => {
  const lap = trace([0, 0]);
  assert.equal(valueAt(lap, "speed", 5), 0);
  assert.equal(formatChannel("speed", 0), "0");
});

// ------------------------------------------------------------- plotting

test("a series lifts its pen at a gap and at a record without the value", () => {
  const lap = trace([100, 100, null, 100, 100, undefined, 100]);
  const path = seriesPath(lap, "speed", { ...DOMAIN, x1: 60 }, PLOT);
  // Two moves: the start, and the restart after the missing record. The
  // bucket with no record at all is joined over: neighbouring samples.
  assert.equal(path.match(/M/g).length, 2);
  const gapped = trace([100, 100, 100, 100], {
    gaps: [{ start: 10, end: 20 }],
  });
  assert.equal(
    seriesPath(gapped, "speed", { ...DOMAIN, x1: 30 }, PLOT).match(/M/g).length,
    2,
  );
  assert.equal(seriesPath(null, "speed", DOMAIN, PLOT), "");
});

test("a single-bucket spike keeps both ends of its range", () => {
  const lap = trace([100, 100, 100]);
  lap.channels[0].min[1] = 20;
  lap.channels[0].max[1] = 180;
  const path = seriesPath(lap, "speed", { ...DOMAIN, x1: 20 }, PLOT);
  const ys = [...path.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) =>
    Number(m[1]),
  );
  assert.equal(Math.min(...ys), 10); // 180 km/h on a 0..200 scale
  assert.equal(Math.max(...ys), 90); // 20 km/h
});

test("the shared axis spans the circuit and both laps", () => {
  const current = trace([1, 2, 3], { start: 0 });
  const reference = trace([1, 2, 3, 4, 5], { start: -20 });
  assert.deepEqual(sharedXDomain([current, reference], "distance", 5891), {
    x0: -20,
    x1: 5891,
  });
  assert.deepEqual(sharedXDomain([null, null], "distance", null), {
    x0: 0,
    x1: 1000,
  });
});

test("value ranges follow the laps for speed and RPM, and are fixed for inputs", () => {
  assert.deepEqual(yDomain([trace([10, 287])], "speed"), { y0: 0, y1: 300 });
  assert.deepEqual(yDomain([null], "speed"), { y0: 0, y1: 100 });
  assert.deepEqual(yDomain([], "throttle"), { y0: 0, y1: 1 });
  assert.deepEqual(yDomain([], "steering"), { y0: -1, y1: 1 });
});

test("distance ticks read like the reference: 0m, 2.00km, 4.00km", () => {
  assert.deepEqual(
    xTicks({ x0: 0, x1: 5891 }, "distance").map((tick) => tick.label),
    ["0m", "2.00km", "4.00km"],
  );
  assert.deepEqual(
    xTicks({ x0: 0, x1: 92_456 }, "time").map((tick) => tick.label),
    ["0:00", "0:30", "1:00", "1:30"],
  );
});

test("steering is a share of lock, never degrees; gear codes read as gears", () => {
  assert.equal(steeringText(0.234), "Right 23%");
  assert.equal(steeringText(-0.1), "Left 10%");
  assert.equal(steeringText(0.001), "Centre");
  assert.equal(steeringText(null), "—");
  assert.ok(!/°/.test(steeringText(0.5)));
  assert.deepEqual([-1, 0, 7].map(gearText), ["R", "N", "7"]);
  assert.equal(gearText(null), "—");
});

test("a trace states its own flaws", () => {
  assert.deepEqual(traceNotes(trace([1, 2])), []);
  const flawed = trace([1, 2], {
    reversals: 2,
    gaps: [{ start: 0, end: 10 }],
  });
  flawed.scope.unattributed_records = 1;
  flawed.source.stream_complete = false;
  const notes = traceNotes(flawed).join(" ");
  assert.match(notes, /backwards 2 times/);
  assert.match(notes, /1 telemetry gap/);
  assert.match(notes, /1 sample inside the lap carried no Lap Data/);
  assert.match(notes, /without its end marker/);
});

// ------------------------------------------------------------ controller

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function backend() {
  const pending = [];
  return {
    pending,
    f1Session: async () => f1Detail(),
    trace(sessionId, lap, axis) {
      const reply = deferred();
      pending.push({ sessionId, lap, axis, ...reply });
      return reply.promise;
    },
  };
}

test("the Lab opens on the latest lap against the best and reads both", async () => {
  const fake = backend();
  const lab = createLabController("f1-review-race", fake);
  lab.start();
  await flush();
  assert.deepEqual(
    fake.pending.map((call) => [call.lap, call.axis]),
    [
      [2, "distance"],
      [1, "distance"],
    ],
  );
  const state = lab.store.get();
  assert.equal(state.current.status, "loading");
  fake.pending[0].resolve(trace([100, 120], { lap: 2 }));
  fake.pending[1].resolve(trace([110, 130], { lap: 1 }));
  await flush();
  assert.equal(lab.store.get().current.status, "ready");
  assert.equal(lab.store.get().reference.status, "ready");
  // The cursor starts at the current lap's first reading.
  assert.equal(lab.store.get().cursor, 0);
});

test("a stale reply for a lap no longer asked for is dropped", async () => {
  const fake = backend();
  const lab = createLabController("f1-review-race", fake);
  lab.start();
  await flush();
  const [first] = fake.pending;
  lab.setLap("current", 1);
  const second = fake.pending[2];
  second.resolve(trace([200], { lap: 1 }));
  first.resolve(trace([999], { lap: 2 }));
  await flush();
  const current = lab.store.get().current;
  assert.equal(current.lap, 1);
  assert.equal(current.trace.scope.lap, 1);
});

test("an error, a wrong schema and a dispose are each handled honestly", async () => {
  const fake = backend();
  const lab = createLabController("f1-review-race", fake);
  lab.start();
  await flush();
  fake.pending[0].reject({ kind: "damaged", message: "stream damaged" });
  const old = trace([1]);
  old.schema_version = 1;
  fake.pending[1].resolve(old);
  await flush();
  const state = lab.store.get();
  assert.equal(state.current.status, "error");
  assert.equal(state.current.error, "stream damaged");
  assert.equal(state.reference.status, "error");
  assert.match(state.reference.error, /trace schema 2/);
  // Nothing lands after dispose.
  lab.setAxis("time");
  lab.dispose();
  fake.pending[2].resolve(trace([5]));
  await flush();
  assert.equal(lab.store.get().current.status, "loading");
});

test("changing the axis re-reads both laps and resets the cursor", async () => {
  const fake = backend();
  const lab = createLabController("f1-review-race", fake);
  lab.start();
  await flush();
  lab.setCursor(1234);
  lab.setAxis("time");
  assert.equal(lab.store.get().cursor, null);
  assert.deepEqual(
    fake.pending.slice(2).map((call) => [call.lap, call.axis]),
    [
      [2, "time"],
      [1, "time"],
    ],
  );
  // Choosing no reference clears it without a read.
  lab.setLap("reference", null);
  assert.equal(fake.pending.length, 4);
  assert.equal(lab.store.get().reference.status, "empty");
});

test("a session that is not completed is never traced", async () => {
  const fake = backend();
  fake.f1Session = async () => {
    const detail = f1Detail();
    detail.session.racelab_session.status = "interrupted";
    return detail;
  };
  const lab = createLabController("f1-review-race", fake);
  lab.start();
  await flush();
  assert.equal(fake.pending.length, 0);
});

test("the keyboard cursor moves in hundredths of the axis and stops at its ends", async () => {
  const fake = backend();
  const lab = createLabController("f1-review-race", fake);
  lab.start();
  await flush();
  lab.cursorTo("start");
  assert.equal(lab.store.get().cursor, 0);
  lab.stepCursor(1);
  assert.equal(lab.store.get().cursor, 58.91);
  lab.cursorTo("end");
  lab.stepCursor(10);
  assert.equal(lab.store.get().cursor, 5891);
});
