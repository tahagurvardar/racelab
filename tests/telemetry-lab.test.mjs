import test from "node:test";
import assert from "node:assert/strict";
import { f1Detail } from "../review/f1-session-fixtures.ts";
import {
  defaultLaps,
  formatChannel,
  gearText,
  labLaps,
  labSession,
  lapClock,
  PLAYBACK_RATES,
  playbackMap,
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
      ["Lap 1", "1:40.781", true, false],
      ["Lap 2", "1:41.162", false, true],
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
  assert.equal(info.sessionTime, "3:24");
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

// ------------------------------------------------------------- M3 replay

/// A lap on the distance axis: one bucket per point, 10 m wide, each with a
/// recorded lap time and distance. `t(i)` gives each point's lap time.
function replayTrace({
  points = 101,
  width = 10,
  t = (i) => i * 100,
  reversals = 0,
  axis = "distance",
} = {}) {
  const indices = [...Array(points).keys()];
  const xs = indices.map((i) => i * width);
  const ts = indices.map(t);
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
  const onTime = axis === "time";
  return {
    ...trace(indices.map(() => 200)),
    axis: {
      kind: onTime ? "lap_time" : "lap_distance",
      unit: onTime ? "ms" : "m",
      origin: onTime ? "lap_start" : "start_finish_line",
      start: onTime ? ts[0] : 0,
      end: onTime ? ts[ts.length - 1] : xs[xs.length - 1],
      records: points,
      bucket_width: onTime ? ts[1] - ts[0] : width,
      bucket_count: points,
      max_interval_ms: 100,
      reversals,
    },
    bucket_records: indices.map(() => 1),
    channels: [
      channel(
        "speed",
        indices.map(() => 200),
      ),
      channel("lap_time", ts),
      channel("lap_distance", xs),
    ],
  };
}

test("on Time sync the replay runs on the lap clock itself", () => {
  const map = playbackMap(replayTrace({ axis: "time" }), "time");
  assert.equal(map.available, true);
  assert.deepEqual([map.startMs, map.endMs], [0, 10_000]);
  assert.equal(map.toX(2500), 2500);
  assert.equal(map.toX(99_999), 10_000);
  assert.equal(map.toTime(-5), 0);
});

test("on Distance sync the replay maps recorded lap time to distance", () => {
  const map = playbackMap(replayTrace(), "distance");
  assert.equal(map.available, true);
  assert.deepEqual([map.startMs, map.endMs], [0, 10_000]);
  // Recorded pairs, and linear between them.
  assert.equal(map.toX(2000), 200);
  assert.equal(map.toX(2050), 205);
  assert.equal(map.toTime(205), 2050);
  // Clamped at the lap's ends, never extrapolated.
  assert.equal(map.toX(-1), 0);
  assert.equal(map.toX(20_000), 1000);
});

test("a lap that cannot map distance to time is not replayed on distance", () => {
  assert.equal(playbackMap(null, "distance").available, false);
  const flashback = playbackMap(replayTrace({ reversals: 1 }), "distance");
  assert.equal(flashback.available, false);
  assert.match(flashback.reason, /runs backwards/);
  // Time that stops rising with distance is not interpolated through.
  const stuck = playbackMap(
    replayTrace({ t: (i) => (i < 50 ? i * 100 : 4900) }),
    "distance",
  );
  assert.equal(stuck.available, false);
  assert.match(stuck.reason, /does not rise/);
  // Too few recorded pairs.
  const sparse = replayTrace({ points: 3 });
  sparse.channels[1].last = [0, null, null];
  sparse.channels[1].samples = [1, 0, 0];
  assert.equal(playbackMap(sparse, "distance").available, false);
  // A bucket whose time and distance come from different readings is
  // skipped, not paired.
  const mismatched = replayTrace({ points: 5 });
  mismatched.channels[1].samples = [1, 2, 1, 1, 1];
  mismatched.channels[1].last = [0, 999_999, 200, 300, 400];
  const map = playbackMap(mismatched, "distance");
  assert.equal(map.available, true);
  assert.equal(map.toTime(15), 150);
});

/// A hand-driven frame source: frames run only when the test advances time.
function fakeClock() {
  let now = 1000;
  let handle = 0;
  const frames = new Map();
  return {
    now: () => now,
    frame(callback) {
      handle += 1;
      frames.set(handle, callback);
      return handle;
    },
    cancel(id) {
      frames.delete(id);
    },
    advance(ms) {
      now += ms;
      const due = [...frames.values()];
      frames.clear();
      for (const callback of due) callback();
    },
    pending: () => frames.size,
  };
}

async function replayLab(options = {}) {
  const clock = fakeClock();
  const lab = createLabController(
    "f1-review-race",
    {
      f1Session: async () => f1Detail(),
      trace: async (sessionId, lap, axis) =>
        replayTrace({ ...options, axis, t: options.t }),
    },
    clock,
  );
  lab.start();
  await flush();
  await flush();
  return { lab, clock, state: () => lab.store.get() };
}

test("play moves the shared cursor along the lap at the chosen rate", async () => {
  const { lab, clock, state } = await replayLab();
  assert.equal(state().cursor, 0);
  lab.play();
  assert.equal(state().playback.playing, true);
  clock.advance(2000);
  assert.equal(state().cursor, 200);
  clock.advance(1000);
  assert.equal(state().cursor, 300);
  // Rate changes keep the time already played at its old rate.
  lab.setRate(4);
  clock.advance(500);
  assert.equal(state().cursor, 500);
  lab.setRate(0.5);
  clock.advance(1000);
  assert.equal(state().cursor, 550);
  // Frames that arrive late do not make the replay drift.
  clock.advance(17);
  clock.advance(33);
  assert.equal(state().cursor, 552.5);
});

test("pause stops the replay where it is and holds no frame", async () => {
  const { lab, clock, state } = await replayLab();
  lab.play();
  clock.advance(1000);
  lab.pause();
  assert.equal(state().playback.playing, false);
  assert.equal(clock.pending(), 0);
  clock.advance(5000);
  assert.equal(state().cursor, 100);
  // Play resumes from the cursor.
  lab.togglePlay();
  clock.advance(1000);
  assert.equal(state().cursor, 200);
});

test("seeking while playing continues the replay from the new place", async () => {
  const { lab, clock, state } = await replayLab();
  lab.play();
  clock.advance(1000);
  lab.setCursor(700);
  clock.advance(1000);
  assert.equal(state().cursor, 800);
  lab.seekTime(2000);
  assert.equal(state().cursor, 200);
  clock.advance(500);
  assert.equal(state().cursor, 250);
  // Seeks clamp to the lap.
  lab.seekTime(-50);
  assert.equal(state().cursor, 0);
  assert.equal(state().playback.playing, true);
});

test("the replay stops at the end of the lap and plays again from the start", async () => {
  const { lab, clock, state } = await replayLab();
  lab.setRate(4);
  lab.play();
  clock.advance(2000);
  clock.advance(1000);
  assert.equal(state().cursor, 1000);
  assert.equal(state().playback.playing, false);
  assert.equal(state().playback.ended, true);
  assert.equal(clock.pending(), 0);
  lab.play();
  assert.equal(state().cursor, 0);
  assert.equal(state().playback.ended, false);
  clock.advance(250);
  assert.equal(state().cursor, 100);
});

test("changing lap or axis pauses; closing the Lab cancels its frame", async () => {
  const { lab, clock, state } = await replayLab();
  lab.play();
  clock.advance(500);
  lab.setLap("reference", null);
  assert.equal(state().playback.playing, false);
  assert.equal(clock.pending(), 0);
  lab.play();
  lab.setAxis("time");
  assert.equal(state().playback.playing, false);
  assert.equal(clock.pending(), 0);
  await flush();
  lab.play();
  assert.equal(clock.pending(), 1);
  lab.dispose();
  assert.equal(clock.pending(), 0);
  const before = state().cursor;
  clock.advance(1000);
  assert.equal(state().cursor, before);
});

test("a lap that cannot be replayed is never played", async () => {
  const { lab, clock, state } = await replayLab({ reversals: 1 });
  assert.equal(lab.playback().available, false);
  lab.play();
  assert.equal(state().playback.playing, false);
  assert.equal(clock.pending(), 0);
  // Without a clock there is nothing to drive a replay either.
  const quiet = createLabController("f1-review-race", {
    f1Session: async () => f1Detail(),
    trace: async () => replayTrace(),
  });
  quiet.start();
  await flush();
  await flush();
  quiet.play();
  assert.equal(quiet.store.get().playback.playing, false);
});

test("the rate steps through 0.5×, 1×, 2× and 4× and stops at either end", async () => {
  const { lab, state } = await replayLab();
  assert.equal(state().playback.rate, 1);
  lab.stepRate(1);
  lab.stepRate(1);
  lab.stepRate(1);
  assert.equal(state().playback.rate, 4);
  for (const _ of [1, 2, 3, 4, 5]) lab.stepRate(-1);
  assert.equal(state().playback.rate, 0.5);
  assert.deepEqual([...PLAYBACK_RATES], [0.5, 1, 2, 4]);
});

test("lap clock text reads like a lap time", () => {
  assert.equal(lapClock(92_456), "1:32.456");
  assert.equal(lapClock(0), "0:00.000");
  assert.equal(lapClock(-1), "—");
  assert.equal(lapClock(null), "—");
});
