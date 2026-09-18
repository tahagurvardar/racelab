import test from "node:test";
import assert from "node:assert/strict";
import {
  initialTelemetryState,
  telemetryReducer,
} from "../src/telemetry-state.ts";

const snapshot = (revision, overrides = {}) => ({
  revision,
  session_id: 1,
  running: false,
  bound_port: null,
  receive_buffer_bytes: null,
  total_packets: 0,
  packets_per_second: 0,
  total_bytes: 0,
  last_packet_size: null,
  last_source: null,
  last_packet_timestamp_ms: null,
  last_packet_monotonic_us: null,
  preview_hex: "",
  receive_errors: 0,
  last_error: null,
  ...overrides,
});

test("a stats event recovers a failed initial invoke and clears the connection error", () => {
  let state = telemetryReducer(initialTelemetryState, {
    type: "connectionFailure",
    message: "initial invoke failed",
  });
  assert.equal(state.connected, false);
  assert.equal(state.connectionError, "initial invoke failed");
  state = telemetryReducer(state, { type: "snapshot", snapshot: snapshot(2) });
  assert.equal(state.connected, true);
  assert.equal(state.connectionError, null);
  assert.equal(state.stats.revision, 2);
});

test("late invoke failure after an event cannot restore a stale frontend error", () => {
  const state = telemetryReducer(initialTelemetryState, {
    type: "snapshot",
    snapshot: snapshot(3),
  });
  assert.deepEqual(
    telemetryReducer(state, {
      type: "connectionFailure",
      message: "late failure",
    }),
    state,
  );
});

test("stale snapshots cannot undo a restart or clear a current backend error", () => {
  const state = telemetryReducer(initialTelemetryState, {
    type: "snapshot",
    snapshot: snapshot(20, { session_id: 2, last_error: "socket failure" }),
  });
  const next = telemetryReducer(state, {
    type: "snapshot",
    snapshot: snapshot(19),
  });
  assert.equal(next.stats.session_id, 2);
  assert.equal(next.stats.last_error, "socket failure");
  assert.equal(next.connected, true);
});
