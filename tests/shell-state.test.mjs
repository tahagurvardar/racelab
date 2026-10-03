import test from "node:test";
import assert from "node:assert/strict";
import { resolveProductState } from "../src/telemetry/product-state.ts";
import { shellAlert, shellStatus } from "../src/telemetry/shell-view-model.ts";
import { buildStatus } from "../src/telemetry/telemetry-view-model.ts";
import {
  INITIAL_LIVE,
  INITIAL_RECORDER,
  INITIAL_SETUP,
  createStore,
  liveFailed,
  liveReceived,
  recorderFailed,
  recorderReceived,
  setupReceived,
} from "../src/state/stores.ts";
import { initialTelemetryState } from "../src/telemetry-state.ts";
import {
  INITIAL_NAVIGATION,
  LIVE_TABS,
  SECTIONS,
  navigationReducer,
  shortcutAction,
} from "../src/views/navigation.ts";

// ------------------------------------------------------------- fixtures

function frame(active = true) {
  return {
    active,
    game: "fh6",
    vehicle_id: "3421",
    game_timestamp_ms: 1000,
    engine: {},
    acceleration: null,
    velocity: null,
    angular_velocity: null,
    orientation: null,
    position: null,
    speed_mps: 40,
    controls: {},
    gear: null,
    vehicle: {},
    wheels: {},
    race: {},
  };
}

function snapshot(overrides = {}) {
  return {
    revision: 1,
    connection: "SESSION_ACTIVE",
    health: "GOOD",
    protocol: "fh6",
    protocol_confidence: 1,
    valid_packets: 10,
    invalid_packets: 0,
    valid_active_fh6: 10,
    valid_inactive_fh6: 0,
    invalid_fh6: 0,
    unknown_protocol: 0,
    input_packet_hz: 60,
    valid_frame_hz: 60,
    last_packet_age_ms: 5,
    last_valid_frame_age_ms: 5,
    receive_errors: 0,
    stale: false,
    frame: frame(),
    issues: [],
    transport_error: null,
    session: null,
    hub: {},
    grace_period_ms: 10000,
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    snapshot: snapshot(),
    serviceError: null,
    listenerRunning: true,
    recorderStatus: "recording",
    recorderError: null,
    setup: { first_run: false, listen_host: "127.0.0.1", listen_port: 20440 },
    ...overrides,
  };
}

function recorder(overrides = {}) {
  return {
    revision: 1,
    status: "recording",
    recording: true,
    recorder_dropped_frames: 0,
    completed_sessions: 0,
    last_error: null,
    ...overrides,
  };
}

const kind = (overrides) => resolveProductState(input(overrides)).kind;

// ------------------------------------------------------- product state

test("an active, fresh frame is live", () => {
  const state = resolveProductState(input());
  assert.equal(state.kind, "live");
  assert.equal(state.tone, "good");
});

test("a stale snapshot is never live, even with a frame attached", () => {
  assert.notEqual(kind({ snapshot: snapshot({ stale: true }) }), "live");
});

test("connection states map to the product states without new meaning", () => {
  const idle = { frame: frame(false) };
  assert.equal(
    kind({ snapshot: snapshot({ ...idle, connection: "CONNECTED_IDLE" }) }),
    "connected_idle",
  );
  assert.equal(
    kind({ snapshot: snapshot({ ...idle, connection: "SESSION_ACTIVE" }) }),
    "connected_idle",
  );
  assert.equal(
    kind({ snapshot: snapshot({ ...idle, connection: "DEGRADED" }) }),
    "degraded",
  );
  assert.equal(
    kind({ snapshot: snapshot({ frame: null, connection: "PROBING" }) }),
    "detecting",
  );
  for (const connection of ["STARTING", "LISTENING", "DISCONNECTED"]) {
    assert.equal(
      kind({ snapshot: snapshot({ frame: null, connection }) }),
      "waiting",
      connection,
    );
  }
});

test("grace states the remaining hold from the backend's own countdown", () => {
  const state = resolveProductState(
    input({
      snapshot: snapshot({
        frame: null,
        connection: "GRACE",
        session: { state: "GRACE", grace_remaining_ms: 8000 },
      }),
    }),
  );
  assert.equal(state.kind, "paused");
  assert.equal(state.tone, "warn");
  assert.match(state.title, /8 s/);
});

test("amber is used only for real caution states", () => {
  const warnKinds = new Set();
  const cases = [
    input(),
    input({ snapshot: snapshot({ frame: null, connection: "PROBING" }) }),
    input({ snapshot: snapshot({ frame: null, connection: "LISTENING" }) }),
    input({ snapshot: snapshot({ frame: null, connection: "GRACE" }) }),
    input({ snapshot: snapshot({ frame: null, connection: "DEGRADED" }) }),
    input({ snapshot: null, listenerRunning: null }),
    input({ setup: { first_run: true } }),
  ];
  for (const value of cases) {
    const state = resolveProductState(value);
    if (state.tone === "warn") warnKinds.add(state.kind);
  }
  assert.deepEqual([...warnKinds].sort(), ["degraded", "paused"]);
});

test("priority: service, then transport, then recorder, then the game", () => {
  assert.equal(
    kind({
      serviceError: "ipc down",
      snapshot: snapshot({ transport_error: "port in use" }),
      recorderStatus: "error",
    }),
    "service_unreachable",
  );
  assert.equal(
    kind({
      snapshot: snapshot({ transport_error: "port in use" }),
      recorderStatus: "error",
    }),
    "not_listening",
  );
  assert.equal(kind({ listenerRunning: false }), "not_listening");
  assert.equal(kind({ recorderStatus: "error" }), "recording_failed");
  assert.equal(
    resolveProductState(
      input({ recorderStatus: "error", recorderError: "disk full" }),
    ).detail,
    "disk full",
  );
});

test("first run outranks waiting but never hides a failure", () => {
  const setup = { first_run: true, listen_host: "127.0.0.1", listen_port: 1 };
  assert.equal(
    kind({
      setup,
      snapshot: snapshot({ frame: null, connection: "LISTENING" }),
    }),
    "first_run",
  );
  assert.equal(kind({ setup, listenerRunning: false }), "not_listening");
});

test("before the backend has answered, the state is starting, not stopped", () => {
  assert.equal(kind({ snapshot: null }), "starting");
  assert.equal(kind({ listenerRunning: null }), "starting");
});

// --------------------------------------------------------- shell model

function shellInput(overrides = {}) {
  return {
    live: { snapshot: snapshot(), error: null },
    recorder: { recorder: recorder(), error: null },
    transport: {
      ...initialTelemetryState,
      stats: { running: true },
      connected: true,
    },
    setup: { ...INITIAL_SETUP },
    ...overrides,
  };
}

test("the top bar keeps all four V1.0 status readings, unchanged", () => {
  const value = shellInput();
  const model = shellStatus(value);
  const legacy = buildStatus(
    value.live.snapshot,
    true,
    null,
    value.recorder.recorder,
  );
  assert.deepEqual(model.items, legacy.items);
  assert.equal(model.vehicleId, legacy.vehicleId);
  assert.equal(model.sessionDuration, legacy.sessionDuration);
  assert.equal(model.game, legacy.game);
  assert.equal(model.recording.active, true);
  assert.equal(model.recording.value, "Recording");
});

test("the global alert appears exactly when the V1.0 banner did, with its text", () => {
  const cases = [
    shellInput(),
    shellInput({ live: { snapshot: null, error: "ipc down" } }),
    shellInput({
      live: {
        snapshot: snapshot({ transport_error: "port in use" }),
        error: null,
      },
    }),
    shellInput({
      recorder: {
        recorder: recorder({ status: "error", last_error: "disk full" }),
        error: null,
      },
    }),
    // A stale recorder error after recovery must not alarm.
    shellInput({
      recorder: {
        recorder: recorder({ last_error: "old failure" }),
        error: null,
      },
    }),
  ];
  for (const value of cases) {
    const rec = value.recorder.recorder;
    const legacy = buildStatus(
      value.live.snapshot,
      rec?.recording ?? false,
      value.live.error ?? value.transport.connectionError,
      rec,
    ).banner;
    const alert = shellAlert(value);
    assert.equal(alert?.detail ?? null, legacy);
  }
  assert.equal(
    shellAlert(
      shellInput({
        recorder: {
          recorder: recorder({ status: "error", last_error: "disk full" }),
          error: null,
        },
      }),
    ).title,
    "Recording failed",
  );
});

test("current-session recorder drops reach the top bar", () => {
  const model = shellStatus(
    shellInput({
      recorder: {
        recorder: recorder({ recorder_dropped_frames: 12 }),
        error: null,
      },
    }),
  );
  assert.equal(model.droppedFrames, 12);
});

// --------------------------------------------------------------- stores

test("a store notifies only when its value actually changes", () => {
  const store = createStore({ n: 1 });
  let calls = 0;
  const dispose = store.subscribe(() => (calls += 1));
  const same = store.get();
  store.set(same);
  store.update((value) => value);
  assert.equal(calls, 0);
  store.set({ n: 2 });
  assert.equal(calls, 1);
  dispose();
  store.set({ n: 3 });
  assert.equal(calls, 1);
});

test("live updates keep revision order and never resurrect a failed reading", () => {
  const first = liveReceived(INITIAL_LIVE, snapshot({ revision: 5 }));
  assert.equal(first.snapshot.revision, 5);
  // A late, older reply changes nothing — same object, so nothing renders.
  assert.equal(liveReceived(first, snapshot({ revision: 4 })), first);
  const failed = liveFailed(first, new Error("ipc"));
  assert.equal(failed.snapshot, null);
  assert.match(failed.error, /ipc/);
  // The same failure again is not a change.
  assert.equal(liveFailed(failed, new Error("ipc")), failed);
});

test("recorder failures keep the last good status, as V1.0 did", () => {
  const good = recorderReceived(INITIAL_RECORDER, recorder({ revision: 3 }));
  const failed = recorderFailed(good, "ipc");
  assert.equal(failed.recorder, good.recorder);
  assert.equal(failed.error, "ipc");
  assert.equal(recorderReceived(failed, recorder({ revision: 3 })).error, null);
});

test("the first-run latch survives setup completing", () => {
  const setup = {
    listen_host: "127.0.0.1",
    listen_port: 20440,
    fh6_first_detected_unix_ms: null,
  };
  const first = setupReceived(INITIAL_SETUP, { ...setup, first_run: true });
  assert.equal(first.sawFirstRun, true);
  const done = setupReceived(first, {
    ...setup,
    first_run: false,
    fh6_first_detected_unix_ms: 1,
  });
  assert.equal(done.sawFirstRun, true);
  assert.equal(done.setup.first_run, false);
  // An identical reading is not a change.
  assert.equal(setupReceived(done, { ...done.setup }), done);
  // A configured installation never latches.
  assert.equal(
    setupReceived(INITIAL_SETUP, { ...setup, first_run: false }).sawFirstRun,
    false,
  );
});

// ----------------------------------------------------------- navigation

test("navigation starts on Live › Overview and remembers the Live tab", () => {
  assert.deepEqual(INITIAL_NAVIGATION, {
    section: "live",
    liveTab: "overview",
  });
  let state = navigationReducer(INITIAL_NAVIGATION, {
    type: "liveTab",
    tab: "chassis",
  });
  state = navigationReducer(state, { type: "section", section: "sessions" });
  assert.equal(state.liveTab, "chassis");
  state = navigationReducer(state, { type: "section", section: "live" });
  assert.deepEqual(state, { section: "live", liveTab: "chassis" });
  // Choosing a tab from anywhere opens Live.
  state = navigationReducer(
    { section: "diagnostics", liveTab: "overview" },
    { type: "liveTab", tab: "dynamics" },
  );
  assert.deepEqual(state, { section: "live", liveTab: "dynamics" });
  // A no-op keeps the same object.
  assert.equal(
    navigationReducer(state, { type: "section", section: "live" }),
    state,
  );
});

const key = (overrides) => ({
  key: "1",
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  editable: false,
  ...overrides,
});

test("Ctrl+1…4 open sections; plain 1…4 switch Live tabs", () => {
  SECTIONS.forEach((section, index) => {
    assert.deepEqual(
      shortcutAction(
        key({ key: String(index + 1), ctrlKey: true }),
        INITIAL_NAVIGATION,
      ),
      { type: "section", section: section.id },
    );
  });
  LIVE_TABS.forEach((tab, index) => {
    assert.deepEqual(
      shortcutAction(key({ key: String(index + 1) }), INITIAL_NAVIGATION),
      { type: "liveTab", tab: tab.id },
    );
  });
});

test("shortcuts never steal digits from a text field or another section", () => {
  assert.equal(
    shortcutAction(key({ editable: true }), INITIAL_NAVIGATION),
    null,
  );
  assert.equal(
    shortcutAction(key({}), { section: "diagnostics", liveTab: "overview" }),
    null,
  );
  assert.equal(shortcutAction(key({ key: "5" }), INITIAL_NAVIGATION), null);
  assert.equal(shortcutAction(key({ altKey: true }), INITIAL_NAVIGATION), null);
  // Ctrl+digit still works while typing: it is never a character.
  assert.deepEqual(
    shortcutAction(
      key({ key: "2", ctrlKey: true, editable: true }),
      INITIAL_NAVIGATION,
    ),
    { type: "section", section: "sessions" },
  );
});

// ------------------------------------------- degraded precedence (B.1)

// Realistic shapes from live_telemetry.rs: a fresh frame keeps arriving while
// a recent fault (invalid packet or hub subscriber drop, < 2 s) holds
// connection and/or health at DEGRADED.
function liveFrame(overrides = {}) {
  return snapshot({ frame: frame(true), ...overrides });
}

test("1. active fresh frame with good health is Live", () => {
  const state = resolveProductState(
    input({
      snapshot: liveFrame({ connection: "SESSION_ACTIVE", health: "GOOD" }),
    }),
  );
  assert.equal(state.kind, "live");
  assert.equal(state.tone, "good");
});

test("2. active fresh frame with a degraded connection is never green Live", () => {
  const state = resolveProductState(
    input({
      snapshot: liveFrame({
        connection: "DEGRADED",
        health: "DEGRADED",
        invalid_fh6: 3,
      }),
    }),
  );
  assert.equal(state.kind, "degraded");
  assert.equal(state.tone, "warn");
  assert.equal(state.title, "Live · degraded");
  // The readings stay: the frame is still presented as current.
  assert.match(
    state.detail,
    /readings on screen come from the latest valid frame/,
  );
});

test("3. active fresh frame with degraded health alone is degraded", () => {
  const state = resolveProductState(
    input({
      snapshot: liveFrame({ connection: "SESSION_ACTIVE", health: "DEGRADED" }),
    }),
  );
  assert.equal(state.kind, "degraded");
  assert.equal(state.tone, "warn");
});

test("4. a subscriber drop is named as such, and does not hide usable readings", async () => {
  const { resolveLiveFrame } = await import(
    "../src/telemetry/telemetry-view-model.ts"
  );
  const value = liveFrame({
    connection: "DEGRADED",
    health: "DEGRADED",
    invalid_fh6: 0,
    invalid_packets: 0,
    hub: { subscriber_drops: 4, last_drop_ms: 120 },
  });
  const state = resolveProductState(input({ snapshot: value }));
  assert.equal(state.kind, "degraded");
  assert.match(state.detail, /dropped inside RaceLab/);
  assert.doesNotMatch(
    state.detail,
    /validation/,
    "not every degradation is a validation failure",
  );
  // The live views still receive the frame.
  const live = resolveLiveFrame(value, true);
  assert.equal(live.availability, "live");
  assert.ok(live.frame);
});

test("degraded causes are named only when the counters leave one possibility", async () => {
  const { degradedCause } = await import("../src/telemetry/product-state.ts");
  const base = {
    issues: [],
    invalid_fh6: 0,
    invalid_packets: 0,
    hub: { subscriber_drops: 0 },
  };
  assert.match(degradedCause({ ...base, invalid_fh6: 2 }), /failed validation/);
  assert.match(
    degradedCause({ ...base, hub: { subscriber_drops: 1 } }),
    /dropped inside RaceLab/,
  );
  assert.match(
    degradedCause({ ...base, invalid_fh6: 2, hub: { subscriber_drops: 1 } }),
    /invalid packets or dropped telemetry frames/,
  );
  assert.match(
    degradedCause({
      ...base,
      issues: [{ field: "x", offset: 0, reason: "r" }],
    }),
    /latest packets failed validation/,
  );
  // No counters at all: no cause is invented.
  assert.match(
    degradedCause(base),
    /invalid packets or dropped telemetry frames/,
  );
});

test("5. the state returns to normal Live when health recovers", () => {
  const sequence = [
    liveFrame({ connection: "SESSION_ACTIVE", health: "GOOD" }),
    liveFrame({ connection: "DEGRADED", health: "DEGRADED", invalid_fh6: 1 }),
    liveFrame({
      connection: "SESSION_ACTIVE",
      health: "DEGRADED",
      invalid_fh6: 1,
    }),
    liveFrame({ connection: "SESSION_ACTIVE", health: "GOOD", invalid_fh6: 1 }),
  ];
  assert.deepEqual(
    sequence.map(
      (value) => resolveProductState(input({ snapshot: value })).kind,
    ),
    ["live", "degraded", "degraded", "live"],
  );
});

test("the top bar follows degradation through the stores", () => {
  let live = INITIAL_LIVE;
  const kinds = [];
  for (const value of [
    liveFrame({ revision: 10, connection: "SESSION_ACTIVE", health: "GOOD" }),
    liveFrame({
      revision: 11,
      connection: "DEGRADED",
      health: "DEGRADED",
      invalid_fh6: 1,
    }),
    liveFrame({
      revision: 12,
      connection: "SESSION_ACTIVE",
      health: "GOOD",
      invalid_fh6: 1,
    }),
  ]) {
    live = liveReceived(live, value);
    const model = shellStatus(shellInput({ live }));
    kinds.push(`${model.state.kind}:${model.state.tone}`);
  }
  assert.deepEqual(kinds, ["live:good", "degraded:warn", "live:good"]);
});

test("degradation without a usable frame is still degraded, not Live", () => {
  const state = resolveProductState(
    input({
      snapshot: snapshot({
        frame: null,
        connection: "DEGRADED",
        health: "DEGRADED",
      }),
    }),
  );
  assert.equal(state.kind, "degraded");
  assert.equal(state.title, "Telemetry degraded");
  assert.match(state.detail, /No reading is presented as current/);
});

test("grace keeps precedence over a degraded health reading", () => {
  // In grace the backend reports health DEGRADED because nothing is fresh;
  // the specific state (session held, countdown) is the useful one.
  const state = resolveProductState(
    input({
      snapshot: snapshot({
        frame: null,
        connection: "GRACE",
        health: "DEGRADED",
        session: { state: "GRACE", grace_remaining_ms: 4000 },
      }),
    }),
  );
  assert.equal(state.kind, "paused");
});
