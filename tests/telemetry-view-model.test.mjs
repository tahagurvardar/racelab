import test from "node:test";
import assert from "node:assert/strict";
import { UNAVAILABLE } from "../src/telemetry/formatting.ts";
import { newerLive } from "../src/telemetry/live-snapshot.ts";
import {
  CORNER_LABELS,
  GEAR_UNVALIDATED,
  WHEEL_CORNERS,
  buildDynamics,
  buildEngine,
  buildInputs,
  buildOverview,
  buildRace,
  buildStatus,
  buildSuspension,
  buildTires,
  canonicalRace,
  cornerRows,
  gearMetric,
  resolveLiveFrame,
} from "../src/telemetry/telemetry-view-model.ts";

const activeFrame = {
  active: true,
  game: "fh6",
  vehicle_id: "2599",
  game_timestamp_ms: 65_000,
  engine: { rpm: 4321.5, idle_rpm: 800, max_rpm: 7600 },
  acceleration: { x: 9.80665, y: -4.903325, z: 0 },
  velocity: { x: 10, y: 0, z: 0 },
  angular_velocity: { x: 0.125, y: -0.5, z: 0 },
  orientation: { x: Math.PI, y: -Math.PI / 2, z: 0 },
  position: { x: 1234.5, y: 67.25, z: -890.5 },
  speed_mps: 58.333333,
  controls: {
    throttle: 1,
    brake: 0.5,
    clutch: 0,
    handbrake: 0,
    steering: -0.375,
  },
  // FH6 supplies no canonical gear. The raw code lives only in sourceSpecific.
  gear: null,
  sourceSpecific: { fh6: { gear: 11, power: 150000 } },
};

const inactiveFrame = {
  ...activeFrame,
  active: false,
  engine: { rpm: null, idle_rpm: null, max_rpm: null },
  acceleration: null,
  velocity: null,
  angular_velocity: null,
  orientation: null,
  position: null,
  speed_mps: null,
  controls: {
    throttle: null,
    brake: null,
    clutch: null,
    handbrake: null,
    steering: null,
  },
};

function snapshot(overrides = {}) {
  return {
    revision: 10,
    connection: "SESSION_ACTIVE",
    health: "GOOD",
    protocol: "fh6",
    protocol_confidence: 1,
    valid_packets: 100,
    invalid_packets: 0,
    valid_active_fh6: 100,
    valid_inactive_fh6: 0,
    invalid_fh6: 0,
    unknown_protocol: 0,
    input_packet_hz: 69.4,
    valid_frame_hz: 69.4,
    last_packet_age_ms: 14,
    last_valid_frame_age_ms: 14,
    receive_errors: 0,
    stale: false,
    frame: activeFrame,
    issues: [],
    transport_error: null,
    session: {
      id: "abc-1",
      started_at: 1_800_000_000_000,
      duration_ms: 65_000,
      game: "fh6",
      vehicle_id: "2599",
      state: "ACTIVE",
      grace_remaining_ms: null,
      ended_reason: null,
    },
    hub: {
      published: 100,
      recent_frames: 100,
      ring_capacity: 512,
      ring_evictions: 0,
      subscribers: 1,
      subscriber_drops: 0,
      last_drop_ms: null,
    },
    grace_period_ms: 10_000,
    ...overrides,
  };
}

const live = () => resolveLiveFrame(snapshot(), true);

// ---------------------------------------------------------------- overview

test("the overview renders canonical speed, RPM and driver inputs", () => {
  const model = buildOverview(live());
  assert.equal(model.speedKmh, "210");
  assert.equal(model.rpm, "4322");
  assert.equal(model.maxRpm, "7600");
  assert.deepEqual(
    model.inputs.map((input) => [input.label, input.value]),
    [
      ["Throttle", "100"],
      ["Brake", "50"],
      ["Steering", "-38"],
    ],
  );
  assert.deepEqual(
    model.identity.map((item) => item.value),
    ["2599", "fh6"],
  );
});

test("negative steering keeps its sign while its bar shows magnitude", () => {
  const steering = buildOverview(live()).inputs.find(
    (input) => input.key === "steering",
  );
  assert.equal(steering.value, "-38");
  assert.equal(steering.signed, true);
  assert.equal(steering.fraction, 37.5);
  assert.equal(steering.available, true);
});

test("a measured zero stays a zero and never becomes unavailable", () => {
  const model = buildInputs(live());
  const clutch = model.bars.find((bar) => bar.key === "clutch");
  assert.equal(clutch.value, "0");
  assert.equal(clutch.available, true);
  assert.equal(clutch.fraction, 0);
});

// ------------------------------------------------------------------- gear

test("the raw FH6 gear code is never presented as a validated gear", () => {
  const gear = buildOverview(live()).gear;
  assert.equal(gear.value, UNAVAILABLE);
  assert.equal(gear.available, false);
  assert.equal(gear.note, GEAR_UNVALIDATED);
  // The code is present in the frame and is still not used.
  assert.equal(activeFrame.sourceSpecific.fh6.gear, 11);
  assert.ok(!JSON.stringify(gear).includes("11"));
});

test("a canonical gear is shown when an adapter actually supplies one", () => {
  assert.equal(gearMetric({ gear: { kind: "reverse" } }).value, "R");
  assert.equal(gearMetric({ gear: { kind: "neutral" } }).value, "N");
  assert.equal(gearMetric({ gear: { kind: "forward", value: 4 } }).value, "4");
  // `unmapped` is an unverified adapter code, not a gear.
  assert.equal(
    gearMetric({ gear: { kind: "unmapped", value: 11 } }).value,
    UNAVAILABLE,
  );
  assert.equal(gearMetric({ gear: { kind: "unknown" } }).value, UNAVAILABLE);
  assert.equal(gearMetric(null).value, UNAVAILABLE);
});

// ----------------------------------------------------------------- engine

test("engine values come from canonical engine telemetry", () => {
  const model = buildEngine(live());
  assert.deepEqual(
    model.range.map((item) => [item.label, item.value, item.unit]),
    [
      ["Current RPM", "4322", "rpm"],
      ["Idle RPM", "800", "rpm"],
      ["Max RPM", "7600", "rpm"],
    ],
  );
  assert.equal(model.rpmFraction.toFixed(2), "51.79");
});

test("engine output and fluids are unavailable, explained and never zero", () => {
  const model = buildEngine(live());
  assert.deepEqual(
    model.output.map((item) => item.label),
    ["Power", "Torque", "Boost", "Fuel"],
  );
  for (const item of model.output) {
    assert.equal(item.value, UNAVAILABLE);
    assert.equal(item.available, false);
    assert.ok(item.note.length > 0);
  }
});

// --------------------------------------------------------------- dynamics

test("dynamics presents SI values and a g conversion without renaming axes", () => {
  const model = buildDynamics(live());
  assert.equal(model.speedKmh, "210.0");
  assert.equal(model.speedMps, "58.33");
  assert.deepEqual(
    model.acceleration.map((item) => [item.label, item.value]),
    [
      ["X", "9.81"],
      ["Y", "-4.90"],
      ["Z", "0.00"],
    ],
  );
  assert.deepEqual(
    model.accelerationG.map((item) => [item.label, item.value]),
    [
      ["Accel X", "1.00"],
      ["Accel Y", "-0.50"],
      ["Accel Z", "0.00"],
    ],
  );
  // No axis may be called lateral or longitudinal: the orientation of the
  // vehicle axes is not established.
  const labels = JSON.stringify(model);
  assert.ok(!/lateral|longitudinal/i.test(labels));
  assert.deepEqual(
    model.orientation.map((item) => [item.label, item.value]),
    [
      ["Yaw", "180.0"],
      ["Pitch", "-90.0"],
      ["Roll", "0.0"],
    ],
  );
  assert.deepEqual(
    model.position.map((item) => item.value),
    ["1234.5", "67.3", "-890.5"],
  );
});

// ------------------------------------------------------- corner ordering

test("tire corners are always FL, FR, RL, RR and never swapped", () => {
  const model = buildTires();
  assert.deepEqual(
    model.rows.map((row) => row.corner),
    ["FL", "FR", "RL", "RR"],
  );
  assert.deepEqual(
    model.rows.map((row) => row.label),
    ["Front left", "Front right", "Rear left", "Rear right"],
  );
  // Each corner owns its own metric keys, so two corners cannot share a cell.
  for (const row of model.rows) {
    for (const item of row.values) {
      assert.ok(item.key.startsWith(`${row.corner}-`));
      assert.equal(item.value, UNAVAILABLE);
    }
  }
});

test("suspension corners are always FL, FR, RL, RR and never swapped", () => {
  const model = buildSuspension();
  assert.deepEqual(
    model.rows.map((row) => row.corner),
    ["FL", "FR", "RL", "RR"],
  );
  assert.deepEqual(
    model.rows.map((row) => row.values.map((item) => item.label)),
    Array.from({ length: 4 }, () => ["Normalized travel", "Travel"]),
  );
});

test("a corner set maps every value to its own corner in a fixed order", () => {
  const rows = cornerRows({ FL: 1, FR: 2, RL: 3, RR: 4 });
  assert.deepEqual(
    rows.map((row) => [row.corner, row.values]),
    [
      ["FL", 1],
      ["FR", 2],
      ["RL", 3],
      ["RR", 4],
    ],
  );
  // The declared order is front row first, then rear row, left before right.
  assert.deepEqual([...WHEEL_CORNERS], ["FL", "FR", "RL", "RR"]);
  assert.equal(CORNER_LABELS.RL, "Rear left");
  assert.equal(CORNER_LABELS.FR, "Front right");
});

test("per-wheel channels are unavailable and say so, rather than reading zero", () => {
  for (const model of [buildTires(), buildSuspension()]) {
    assert.equal(model.available, false);
    assert.ok(model.reason.length > 0);
    assert.ok(model.rows.every((row) => row.values.length > 0));
  }
});

// ------------------------------------------------------------------- race

test("race values have no canonical source and are never fabricated", () => {
  const model = buildRace(live());
  assert.equal(model.available, false);
  assert.deepEqual(canonicalRace(activeFrame), {
    lapNumber: null,
    position: null,
    currentLapSeconds: null,
    lastLapSeconds: null,
    bestLapSeconds: null,
    raceTimeSeconds: null,
    distanceMeters: null,
  });
  for (const item of [...model.timing, ...model.standing]) {
    if (item.key === "game-clock") continue;
    assert.equal(item.value, UNAVAILABLE);
    assert.ok(item.note.length > 0);
  }
  // The canonical game clock is real and is still shown.
  const clock = model.standing.find((item) => item.key === "game-clock");
  assert.equal(clock.value, "1:05");
  assert.equal(clock.note, undefined);
});

// ------------------------------------------------------ stale and absent

test("inactive telemetry clears every live value instead of holding the last one", () => {
  const state = resolveLiveFrame(
    snapshot({ frame: inactiveFrame, connection: "GRACE" }),
    true,
  );
  assert.equal(state.frame, null);
  const overview = buildOverview(state);
  assert.equal(overview.speedKmh, UNAVAILABLE);
  assert.equal(overview.rpm, UNAVAILABLE);
  assert.equal(overview.rpmFraction, null);
  assert.ok(overview.inputs.every((input) => input.value === UNAVAILABLE));
  assert.ok(overview.inputs.every((input) => input.fraction === null));
  assert.ok(
    buildDynamics(state).acceleration.every(
      (item) => item.value === UNAVAILABLE,
    ),
  );
  assert.ok(buildInputs(state).bars.every((bar) => bar.value === UNAVAILABLE));
});

test("a stale snapshot never resurrects the previous reading", () => {
  const state = resolveLiveFrame(snapshot({ stale: true }), true);
  assert.equal(state.frame, null);
  assert.equal(buildOverview(state).speedKmh, UNAVAILABLE);
});

test("grace tells the user telemetry is paused and the session is preserved", () => {
  const state = resolveLiveFrame(
    snapshot({ connection: "GRACE", frame: null, stale: true }),
    true,
  );
  assert.equal(state.availability, "grace");
  assert.match(state.reason, /paused/i);
  assert.match(state.reason, /session/i);
  assert.equal(state.frame, null);
});

test("waiting, idle, degraded and stopped states each explain themselves", () => {
  const cases = [
    [
      snapshot({ connection: "LISTENING", frame: null, stale: true }),
      true,
      "waiting",
    ],
    [
      snapshot({ connection: "DISCONNECTED", frame: null, stale: true }),
      true,
      "waiting",
    ],
    [
      snapshot({ connection: "PROBING", frame: null, stale: true }),
      true,
      "waiting",
    ],
    [
      snapshot({ connection: "CONNECTED_IDLE", frame: null, stale: true }),
      true,
      "idle",
    ],
    [
      snapshot({ connection: "DEGRADED", frame: null, stale: true }),
      true,
      "stale",
    ],
    [snapshot(), false, "stopped"],
    [null, true, "waiting"],
  ];
  for (const [input, running, availability] of cases) {
    const state = resolveLiveFrame(input, running);
    assert.equal(state.availability, availability);
    assert.equal(state.frame, null);
    assert.ok(state.reason.length > 0, `${availability} needs a reason`);
  }
});

test("a listener that is not running always outranks a fresh-looking snapshot", () => {
  const state = resolveLiveFrame(snapshot(), false);
  assert.equal(state.availability, "stopped");
  assert.equal(buildOverview(state).speedKmh, UNAVAILABLE);
});

// ----------------------------------------------------------------- status

test("global status reports game, connection, session and recording in words", () => {
  const model = buildStatus(snapshot(), true, null);
  assert.equal(model.game, "Forza Horizon 6");
  assert.equal(model.vehicleId, "2599");
  assert.equal(model.sessionDuration, "1:05");
  assert.deepEqual(
    model.items.map((item) => [item.key, item.value]),
    [
      ["connection", "Connected"],
      ["health", "Good"],
      ["session", "Session active"],
      ["recording", "Recording"],
    ],
  );
  // Every state carries a glyph as well as a colour tone: state is never
  // communicated by colour alone.
  assert.ok(model.items.every((item) => item.glyph.length > 0));
  assert.ok(model.items.every((item) => item.tone.length > 0));
});

test("a disconnected app says it is waiting for a game and is not recording", () => {
  const model = buildStatus(
    snapshot({
      connection: "DISCONNECTED",
      protocol: null,
      health: "LOST",
      session: null,
      frame: null,
      stale: true,
    }),
    false,
    null,
  );
  assert.equal(model.game, "No game detected");
  assert.equal(model.vehicleId, UNAVAILABLE);
  assert.equal(model.sessionDuration, UNAVAILABLE);
  assert.deepEqual(
    model.items.map((item) => item.value),
    ["Waiting for game", "No signal", "No session", "Not recording"],
  );
});

test("grace is visible in the status bar with the time remaining", () => {
  const model = buildStatus(
    snapshot({
      connection: "GRACE",
      health: "DEGRADED",
      session: {
        id: "abc-1",
        started_at: 1_800_000_000_000,
        duration_ms: 65_000,
        game: "fh6",
        vehicle_id: "2599",
        state: "GRACE",
        grace_remaining_ms: 7400,
        ended_reason: null,
      },
    }),
    true,
    null,
  );
  assert.equal(model.items[0].value, "Telemetry paused");
  assert.equal(model.items[2].value, "Session grace · 7 s left");
  assert.equal(model.items[2].tone, "warn");
});

test("a transport error reaches the global banner", () => {
  assert.equal(
    buildStatus(snapshot({ transport_error: "bind failed" }), false, null)
      .banner,
    "bind failed",
  );
  assert.equal(
    buildStatus(snapshot(), false, "IPC unavailable").banner,
    "IPC unavailable",
  );
  assert.equal(buildStatus(snapshot(), false, null).banner, null);
});

// ------------------------------------------------------- snapshot ordering

test("late snapshots cannot overwrite newer live telemetry state", () => {
  const stopped = { revision: 11, frame: null };
  assert.equal(newerLive(stopped, snapshot()), stopped);
  const current = snapshot();
  assert.equal(newerLive(null, current), current);
  const newer = snapshot({ revision: 12 });
  assert.equal(newerLive(current, newer), newer);
});
