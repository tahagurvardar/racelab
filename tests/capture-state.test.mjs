import test from "node:test";
import assert from "node:assert/strict";
import { CAPTURE_STATES, newerCapture } from "../src/capture-state.ts";
import { namedCode } from "../src/telemetry/formatting.ts";

test("late recording snapshots cannot overwrite saved capture or a new session", () => {
  const saved = { revision: 20, status: "complete", label: "one" };
  assert.equal(
    newerCapture(saved, { revision: 19, status: "recording" }),
    saved,
  );
  const restarted = { revision: 21, status: "recording", label: "two" };
  assert.equal(newerCapture(saved, restarted), restarted);
  assert.equal(newerCapture(restarted, saved), restarted);
  assert.equal(newerCapture(null, saved), saved);
});

test("every capture state has a name, and the writer's own code stays visible", () => {
  assert.deepEqual(Object.keys(CAPTURE_STATES).sort(), [
    "complete",
    "error",
    "idle",
    "recording",
    "stopping",
  ]);
  // The capture writer's "recording" is not session recording.
  assert.deepEqual(namedCode("recording", CAPTURE_STATES), {
    name: "Capturing",
    code: "recording",
  });
  assert.deepEqual(namedCode("complete", CAPTURE_STATES), {
    name: "Saved",
    code: "complete",
  });
  assert.deepEqual(namedCode("idle", CAPTURE_STATES), {
    name: "Idle",
    code: null,
  });
});
