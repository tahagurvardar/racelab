import test from "node:test";
import assert from "node:assert/strict";
import { newerLive, liveMetrics } from "../src/live-state.ts";

const snapshot = {
  revision: 10,
  stale: false,
  frame: {
    active: true,
    speed_mps: 10,
    engine: { rpm: 4321.5 },
    gear: null,
    sourceSpecific: { fh6: { gear: 11 } },
    controls: { throttle: 1, brake: 0.5, steering: -1 },
  },
};
test("live units and raw gear codes are presented without invented semantics", () => {
  assert.deepEqual(liveMetrics(snapshot, true), {
    speed: "36.0",
    rpm: "4322",
    gear: "11",
    throttle: "100.0",
    brake: "50.0",
    steering: "-100.0",
  });
});
test("unavailable values stay absent while real zero remains visible", () => {
  const inactive = {
    ...snapshot,
    frame: {
      ...snapshot.frame,
      active: false,
      speed_mps: null,
      engine: { rpm: null },
      controls: { throttle: null, brake: null, steering: null },
    },
  };
  assert.ok(
    Object.values(liveMetrics(inactive, true)).every((value) => value === "—"),
  );
  const zero = {
    ...snapshot,
    frame: {
      ...snapshot.frame,
      speed_mps: 0,
      engine: { rpm: 0 },
      controls: { throttle: 0, brake: 0, steering: 0 },
    },
  };
  assert.equal(liveMetrics(zero, true).speed, "0.0");
  assert.equal(liveMetrics(zero, true).throttle, "0.0");
});
test("stale or stopped live telemetry is not displayed as current", () => {
  for (const values of [
    liveMetrics(snapshot, false),
    liveMetrics({ ...snapshot, stale: true }, true),
    liveMetrics(null, true),
  ])
    assert.ok(Object.values(values).every((value) => value === "—"));
});
test("late active snapshots cannot overwrite reset or inactive telemetry", () => {
  const stopped = { revision: 11, frame: null };
  assert.equal(newerLive(stopped, snapshot), stopped);
  assert.equal(newerLive(null, snapshot), snapshot);
});
