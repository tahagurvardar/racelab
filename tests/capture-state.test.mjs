import test from "node:test";
import assert from "node:assert/strict";
import { newerCapture } from "../src/capture-state.ts";

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
