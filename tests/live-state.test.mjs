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
    gear: { kind: "unmapped", value: 11 },
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
