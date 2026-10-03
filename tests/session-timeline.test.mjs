// The session timeline model: built only from persisted intervals, bounded
// for long sessions, and never dropping a count.
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_TICKS,
  TIMELINE_BINS,
  densityNote,
  TIMELINE_SLICES,
  sessionTimeline,
  timelineDuration,
  timelineTicks,
} from "../src/session-timeline.ts";
import { elapsed } from "../src/telemetry/formatting.ts";
import { analysis, episode, event, segment } from "./support/sessions.mjs";

const lane = (model, key) => model.lanes.find((item) => item.key === key);

test("lanes come from events, turn segments and slip episodes only", () => {
  const model = sessionTimeline(analysis());
  assert.deepEqual(
    model.lanes.map((item) => item.key),
    ["throttle", "braking", "speed", "suspension", "turns", "slip"],
  );
  assert.equal(lane(model, "braking").stored, 1, "hard braking");
  assert.equal(lane(model, "throttle").stored, 1, "full throttle");
  assert.equal(lane(model, "suspension").stored, 1);
  assert.equal(lane(model, "turns").stored, 2);
  assert.equal(lane(model, "slip").stored, 1);
  assert.equal(lane(model, "speed").stored, 0);
  assert.deepEqual(lane(model, "speed").marks, [], "nothing is invented");
  // Only the two pedals carry a channel colour; the rest are neutral.
  assert.deepEqual(
    model.lanes.map((item) => item.tone),
    ["throttle", "brake", "neutral", "neutral", "neutral", "neutral"],
  );
});

test("a mark sits where its interval is, on the recorded session axis", () => {
  // 120 s recorded; a turn segment from 60.0 s to 62.8 s.
  const doc = analysis({
    events: [],
    slip_episodes: [],
    turn_segments: [segment(1, 60_000, 62_800)],
  });
  const model = sessionTimeline(doc, 120);
  assert.equal(model.durationMs, 120_000);
  const [mark] = lane(model, "turns").marks;
  assert.equal(mark.from, 60, "60 s of 120 s, at one bin per second");
  assert.equal(mark.to, 63);
  assert.match(mark.title, /^1 turn segment · 1:00\.000 – 1:03\.000$/);
});

test("the axis covers an interval that ends past the recorded span", () => {
  const doc = analysis({ events: [event("braking", 100_000, 150_000)] });
  assert.equal(timelineDuration(doc), 150_000);
});

test("overlapping intervals raise the density level instead of drawing twice", () => {
  const doc = analysis({
    events: [
      event("braking", 10_000, 20_000),
      event("hard_braking", 12_000, 14_000),
    ],
    slip_episodes: [],
    turn_segments: [],
  });
  const marks = lane(sessionTimeline(doc, 120), "braking").marks;
  assert.deepEqual(
    marks.map((mark) => [mark.from, mark.to, mark.level]),
    [
      [10, 12, 1],
      [12, 15, 2],
      [15, 21, 1],
    ],
  );
  assert.match(marks[1].title, /Braking 1, Hard braking 1/);
});

test("hundreds of intervals stay bounded: at most one mark per bin per lane", () => {
  const events = Array.from({ length: 400 }, (_, i) =>
    event(i % 2 ? "braking" : "full_throttle", i * 2_700, i * 2_700 + 900),
  );
  const turns = Array.from({ length: 200 }, (_, i) =>
    segment(i + 1, i * 5_400, i * 5_400 + 2_000),
  );
  const slips = Array.from({ length: 200 }, (_, i) =>
    episode(i + 1, i * 5_400 + 100, i * 5_400 + 700),
  );
  const doc = analysis({
    events,
    turn_segments: turns,
    slip_episodes: slips,
    coverage: {
      ...analysis().coverage,
      recorded_seconds: 1_080,
      last_monotonic_ms: 1_080_500,
    },
  });
  const started = performance.now();
  const model = sessionTimeline(doc);
  const elapsedMs = performance.now() - started;
  for (const item of model.lanes) {
    assert.ok(
      item.marks.length <= TIMELINE_BINS,
      `${item.key}: ${item.marks.length}`,
    );
    for (const mark of item.marks) {
      assert.ok(
        mark.from >= 0 && mark.to <= TIMELINE_BINS && mark.to > mark.from,
      );
    }
  }
  // Every stored interval is counted, in the lane and in the text slices.
  assert.equal(lane(model, "braking").stored, 200);
  assert.equal(lane(model, "throttle").stored, 200);
  assert.equal(lane(model, "turns").stored, 200);
  assert.equal(lane(model, "slip").stored, 200);
  for (const item of model.lanes) {
    assert.equal(
      item.slices.reduce((sum, count) => sum + count, 0),
      item.stored,
      item.key,
    );
    assert.equal(item.slices.length, TIMELINE_SLICES);
  }
  assert.ok(elapsedMs < 100, `built in ${elapsedMs.toFixed(1)} ms`);
});

test("intervals counted but not stored are stated, never silently dropped", () => {
  const doc = analysis({
    events: [event("braking", 1_000, 2_000)],
    driving_summary: {
      events_by_kind: [{ kind: "braking", count: 140 }],
      slip_episode_count: 5,
    },
    data_quality: { events_truncated: 139, slip_episodes_truncated: 4 },
  });
  const model = sessionTimeline(doc);
  assert.equal(lane(model, "braking").total, 140);
  assert.equal(lane(model, "braking").stored, 1);
  assert.equal(lane(model, "slip").total, 5);
  assert.equal(model.notes.length, 1);
  assert.match(model.notes[0], /braking 140 counted, 1 stored/);
  assert.match(model.notes[0], /slip episodes 5 counted, 1 stored/);
});

test("a lane whose channel was not recorded is unavailable, not empty", () => {
  const doc = analysis({
    data_quality: {
      wheel_telemetry_available: false,
      orientation_available: false,
    },
  });
  const model = sessionTimeline(doc);
  assert.equal(lane(model, "slip").unavailable, "Not recorded in this session");
  assert.equal(
    lane(model, "turns").unavailable,
    "Not recorded in this session",
  );
  assert.equal(lane(model, "braking").unavailable, null);
});

test("ticks are readable session offsets, at most nine", () => {
  for (const seconds of [20, 120, 600, 2_700, 10_800]) {
    const ticks = timelineTicks(seconds * 1000);
    assert.ok(
      ticks.length >= 2 && ticks.length <= 9,
      `${seconds}s: ${ticks.length}`,
    );
    assert.equal(ticks[0].label, "0:00");
    assert.ok(ticks.every((tick) => tick.fraction >= 0 && tick.fraction <= 1));
  }
});

test("the same analysis always yields the same timeline", () => {
  const doc = analysis();
  assert.deepEqual(sessionTimeline(doc), sessionTimeline(doc));
});

// ------------------------------------------------------- review fixes

test("ticks: origin and end always, at most nine, for any finite positive duration", () => {
  for (const durationMs of [
    1,
    999,
    20_000,
    120_000,
    1_080_000,
    3_600_000,
    100 * 3_600_000,
    1e12,
    8.64e15,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_VALUE,
  ]) {
    const ticks = timelineTicks(durationMs);
    const where = String(durationMs);
    assert.ok(
      ticks.length >= 2 && ticks.length <= MAX_TICKS,
      `${where}: ${ticks.length}`,
    );
    assert.deepEqual(
      ticks[0],
      { key: "tick-0", fraction: 0, label: "0:00" },
      where,
    );
    const end = ticks.at(-1);
    assert.equal(end.fraction, 1, `${where}: end tick`);
    assert.equal(end.label, elapsed(durationMs / 1000), `${where}: end label`);
    for (let i = 1; i < ticks.length; i += 1) {
      assert.ok(Number.isFinite(ticks[i].fraction), where);
      assert.ok(
        ticks[i].fraction > ticks[i - 1].fraction,
        `${where}: increasing`,
      );
    }
    // Interior ticks are evenly spaced and never crowd the end tick.
    const interior = ticks.slice(1, -1);
    if (interior.length > 0) {
      const step = interior[0].fraction;
      interior.forEach((tick, i) =>
        assert.ok(Math.abs(tick.fraction - step * (i + 1)) < 1e-9, where),
      );
      assert.ok(
        1 - interior.at(-1).fraction >= 0.4 * step - 1e-9,
        `${where}: end clearance`,
      );
    }
    assert.equal(new Set(ticks.map((tick) => tick.key)).size, ticks.length);
    assert.deepEqual(
      timelineTicks(durationMs),
      ticks,
      `${where}: deterministic`,
    );
  }
  // An 18-minute session reads 0:00, 5:00, 10:00, 15:00, 18:00.
  assert.deepEqual(
    timelineTicks(1_080_000).map((tick) => tick.label),
    ["0:00", "5:00", "10:00", "15:00", "18:00"],
  );
  assert.equal(MAX_TICKS, 9);
});

test("ticks: only invalid durations fall back to the origin alone", () => {
  for (const durationMs of [NaN, Infinity, -Infinity, -5, 0]) {
    assert.deepEqual(
      timelineTicks(durationMs),
      [{ key: "tick-0", fraction: 0, label: "0:00" }],
      String(durationMs),
    );
  }
});

test("a bogus interval end cannot make the axis unbounded", () => {
  const doc = analysis({ events: [event("braking", 0, 1e15)] });
  const model = sessionTimeline(doc);
  assert.ok(model.ticks.length <= MAX_TICKS);
  for (const item of model.lanes) assert.ok(item.marks.length <= TIMELINE_BINS);
});

test("the density note describes slots that intervals touch, not overlap", () => {
  const model = sessionTimeline(analysis()); // 120 s over 240 slots
  const note = densityNote(model);
  assert.match(note, /240 equal slots of 0\.5 s/);
  assert.match(note, /every slot it touches/);
  assert.match(note, /more intervals touch the same slot/);
  assert.match(note, /rather than overlap/);
  assert.ok(!/darker marks are where analyzed intervals overlap/.test(note));
  // Two intervals that never overlap but share a slot do darken it, which is
  // exactly what the note says.
  const shared = analysis({
    events: [event("braking", 1_000, 1_100), event("braking", 1_200, 1_300)],
  });
  const [mark] = sessionTimeline(shared).lanes.find(
    (lane) => lane.key === "braking",
  ).marks;
  assert.equal(mark.level, 2);
});
