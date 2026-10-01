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
  NO_RACE_DATA,
  canonicalRace,
  cornerRows,
  gearMetric,
  resolveLiveFrame,
  wheelOf,
} from "../src/telemetry/telemetry-view-model.ts";

/// Distinct per-channel, per-corner values. Every number differs from every
/// other, so a transposed corner or channel cannot pass a test by coincidence.
function corner(base) {
  return {
    temperature_c: base + 0.5,
    slip_ratio: base + 1.25,
    slip_angle: base + 2.125,
    combined_slip: base + 3.0625,
    rotation_rad_s: base + 4.5,
    normalized_suspension_travel: base / 100,
    suspension_travel_m: base / 1000,
  };
}

const activeFrame = {
  active: true,
  game: "fh6",
  vehicle_id: "2599",
  game_timestamp_ms: 65_000,
  engine: {
    rpm: 4321.5,
    idle_rpm: 800,
    max_rpm: 7600,
    power_w: 150_000,
    torque_nm: 331.5,
  },
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
  vehicle: {
    class_code: 2,
    performance_index: 600,
    drivetrain_code: 1,
    cylinders: 4,
  },
  wheels: {
    front_left: corner(10),
    front_right: corner(20),
    rear_left: corner(30),
    rear_right: corner(40),
  },
  race: { lap_number: 3, race_position: 7, race_time_seconds: 125.25 },
  sourceSpecific: {
    fh6: {
      gear: 11,
      power: 150000,
      // Deliberately different from every canonical value above: a product
      // view that fell back to the adapter would show these numbers.
      tire_temperatures: [900.5, 901.5, 902.5, 903.5],
      current_lap: 88.5,
      distance_traveled: 4242.5,
      boost: 24.99,
      fuel: 1,
    },
  },
};

const emptyCorner = {
  temperature_c: null,
  slip_ratio: null,
  slip_angle: null,
  combined_slip: null,
  rotation_rad_s: null,
  normalized_suspension_travel: null,
  suspension_travel_m: null,
};

const inactiveFrame = {
  ...activeFrame,
  active: false,
  engine: {
    rpm: null,
    idle_rpm: null,
    max_rpm: null,
    power_w: null,
    torque_nm: null,
  },
  vehicle: {
    class_code: null,
    performance_index: null,
    drivetrain_code: null,
    cylinders: null,
  },
  wheels: {
    front_left: emptyCorner,
    front_right: emptyCorner,
    rear_left: emptyCorner,
    rear_right: emptyCorner,
  },
  race: { lap_number: null, race_position: null, race_time_seconds: null },
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

test("engine output presents canonical power and torque in their own units", () => {
  const model = buildEngine(live());
  assert.deepEqual(
    model.output.map((item) => [item.key, item.value, item.unit]),
    [
      // 150 000 W canonical, shown as kW and as the canonical watts.
      ["power", "150.0", "kW"],
      ["power-w", "150000", "W"],
      ["torque", "331.5", "N\u00b7m"],
    ],
  );
  assert.ok(model.output.every((item) => item.available));
});

test("boost and fuel stay unavailable, explained and never zero", () => {
  const model = buildEngine(live());
  assert.deepEqual(
    model.unavailable.map((item) => item.label),
    ["Boost", "Fuel"],
  );
  for (const item of model.unavailable) {
    assert.equal(item.value, UNAVAILABLE);
    assert.equal(item.available, false);
    assert.ok(item.note.length > 0);
  }
  // The adapter holds both values; neither may reach this view.
  const rendered = JSON.stringify(model);
  assert.ok(!rendered.includes("24.99"));
});

test("engine output is unavailable rather than zero with no live frame", () => {
  const model = buildEngine({ frame: null, availability: "idle", reason: "" });
  for (const item of model.output) {
    assert.equal(item.value, UNAVAILABLE);
    assert.equal(item.available, false);
  }
});

// -------------------------------------------------------- vehicle codes

test("vehicle configuration renders as codes and never as invented names", () => {
  const model = buildOverview(live());
  assert.deepEqual(
    model.configuration.map((item) => [item.key, item.label, item.value]),
    [
      ["class", "Class code", "2"],
      ["pi", "Performance index", "600"],
      ["drivetrain", "Drivetrain code", "1"],
      ["cylinders", "Cylinders", "4"],
    ],
  );
  // No class letter, drivetrain name or car name is derived from a code.
  const rendered = JSON.stringify(model.configuration);
  assert.ok(!/AWD|RWD|FWD|\bclass [A-S]\b/i.test(rendered));
  // Codes are never digit-grouped: grouping implies a magnitude an
  // identifier does not have.
  assert.ok(model.configuration.every((item) => !item.value.includes(",")));
});

test("vehicle codes read unavailable without a live frame", () => {
  const model = buildOverview({
    frame: null,
    availability: "idle",
    reason: "",
  });
  for (const item of model.configuration) {
    assert.equal(item.value, UNAVAILABLE);
    assert.equal(item.available, false);
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

test("tire corners are always FL, FR, RL, RR and carry their own values", () => {
  const model = buildTires(live());
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
      assert.ok(item.key.startsWith(row.corner + "-"));
    }
  }
});

test("each corner renders the value of that corner and no other", () => {
  const rows = buildTires(live()).rows;
  const value = (corner, key) =>
    rows
      .find((row) => row.corner === corner)
      .values.find((item) => item.key === corner + "-" + key).value;
  // corner(10) is front left, corner(20) front right, 30 rear left, 40 rear
  // right. A swapped pair would read another corner's number here.
  assert.deepEqual(
    ["FL", "FR", "RL", "RR"].map((corner) => value(corner, "temperature")),
    ["10.5", "20.5", "30.5", "40.5"],
  );
  assert.deepEqual(
    ["FL", "FR", "RL", "RR"].map((corner) => value(corner, "slip-ratio")),
    ["11.250", "21.250", "31.250", "41.250"],
  );
  assert.deepEqual(
    ["FL", "FR", "RL", "RR"].map((corner) => value(corner, "slip-angle")),
    ["12.125", "22.125", "32.125", "42.125"],
  );
  assert.deepEqual(
    ["FL", "FR", "RL", "RR"].map((corner) => value(corner, "combined-slip")),
    ["13.063", "23.063", "33.063", "43.063"],
  );
  assert.deepEqual(
    ["FL", "FR", "RL", "RR"].map((corner) => value(corner, "rotation")),
    ["14.5", "24.5", "34.5", "44.5"],
  );
  // wheelOf is the single name lookup; it must agree with the rendered rows.
  assert.equal(wheelOf(activeFrame.wheels, "RL").temperature_c, 30.5);
  assert.equal(wheelOf(activeFrame.wheels, "FR").slip_ratio, 21.25);
});

test("tire values carry their established units and no invented one", () => {
  const values = buildTires(live()).rows[0].values;
  const unit = (key) => values.find((item) => item.key === "FL-" + key).unit;
  assert.equal(unit("temperature"), "\u00b0C");
  assert.equal(unit("rotation"), "rad/s");
  assert.equal(unit("rotation-rpm"), "rpm");
  // The slip channels are dimensionless: no unit may be asserted for them.
  assert.equal(unit("slip-ratio"), null);
  assert.equal(unit("slip-angle"), null);
  assert.equal(unit("combined-slip"), null);
});

test("suspension corners are always FL, FR, RL, RR and never swapped", () => {
  const model = buildSuspension(live());
  assert.deepEqual(
    model.rows.map((row) => row.corner),
    ["FL", "FR", "RL", "RR"],
  );
  assert.deepEqual(
    model.rows.map((row) => row.values.map((item) => item.label)),
    Array.from({ length: 4 }, () => ["Normalized travel", "Travel"]),
  );
  const value = (corner, key) =>
    model.rows
      .find((row) => row.corner === corner)
      .values.find((item) => item.key === corner + "-" + key);
  assert.deepEqual(
    ["FL", "FR", "RL", "RR"].map((corner) => value(corner, "normalized").value),
    ["0.100", "0.200", "0.300", "0.400"],
  );
  // Canonical metres, presented in millimetres. 0.010 m -> 10.0 mm.
  assert.deepEqual(
    ["FL", "FR", "RL", "RR"].map((corner) => value(corner, "meters").value),
    ["10.0", "20.0", "30.0", "40.0"],
  );
  assert.equal(value("FL", "meters").unit, "mm");
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

test("per-wheel channels read unavailable with no live frame, never zero", () => {
  const absent = { frame: null, availability: "idle", reason: "no frame" };
  for (const model of [buildTires(absent), buildSuspension(absent)]) {
    for (const row of model.rows) {
      assert.ok(row.values.length > 0);
      for (const item of row.values) {
        assert.equal(item.value, UNAVAILABLE);
        assert.equal(item.available, false);
      }
    }
  }
});

test("unpromoted surface channels stay unavailable and explained", () => {
  const model = buildTires(live());
  assert.deepEqual(
    model.unavailable.map((item) => item.key),
    ["rumble-strip", "puddle", "surface-rumble"],
  );
  for (const item of model.unavailable) {
    assert.equal(item.value, UNAVAILABLE);
    assert.equal(item.available, false);
    assert.ok(item.note.length > 0);
  }
});

// ------------------------------------------------------------------- race

test("race presents canonical lap, position and elapsed seconds", () => {
  const model = buildRace(live());
  assert.deepEqual(canonicalRace(activeFrame), {
    lapNumber: 3,
    position: 7,
    raceTimeSeconds: 125.25,
  });
  const timing = Object.fromEntries(
    model.timing.map((item) => [item.key, item.value]),
  );
  assert.equal(timing["race-time"], "2:05");
  assert.equal(timing["race-time-precise"], "2:05.250");
  // The canonical game clock is a separate reading and is still shown.
  assert.equal(timing["game-clock"], "1:05");
  assert.deepEqual(
    model.standing.map((item) => [item.key, item.value]),
    [
      ["lap", "3"],
      ["position", "7"],
    ],
  );
});

test("a measured lap zero renders as zero, not as unavailable", () => {
  const frame = {
    ...activeFrame,
    race: { lap_number: 0, race_position: 0, race_time_seconds: 0 },
  };
  const model = buildRace({ frame, availability: "live", reason: "" });
  assert.deepEqual(
    model.standing.map((item) => item.value),
    ["0", "0"],
  );
  assert.ok(model.standing.every((item) => item.available));
});

test("unpromoted lap timing and distance are never fabricated", () => {
  const model = buildRace(live());
  assert.deepEqual(
    model.unavailable.map((item) => item.key),
    ["current-lap", "last-lap", "best-lap", "distance"],
  );
  for (const item of model.unavailable) {
    assert.equal(item.value, UNAVAILABLE);
    assert.ok(item.note.length > 0);
  }
  // The adapter does hold values for them; they must not leak into the view.
  const rendered = JSON.stringify(model);
  assert.ok(!rendered.includes("88.5"));
  assert.ok(!rendered.includes("4242.5"));
});

test("race reads unavailable with no live frame", () => {
  const model = buildRace({ frame: null, availability: "idle", reason: "" });
  for (const item of [...model.timing, ...model.standing]) {
    assert.equal(item.value, UNAVAILABLE);
  }
  assert.deepEqual(canonicalRace(null), NO_RACE_DATA);
});

// ------------------------------------------------------- source isolation

test("no product view model substitutes adapter data for a canonical field", () => {
  const state = live();
  const rendered = JSON.stringify([
    buildOverview(state),
    buildEngine(state),
    buildDynamics(state),
    buildTires(state),
    buildSuspension(state),
    buildInputs(state),
    buildRace(state),
  ]);
  // Every one of these numbers exists only in sourceSpecific.
  for (const leaked of ["900.5", "901.5", "902.5", "903.5", "88.5", "4242.5"]) {
    assert.ok(!rendered.includes(leaked), "leaked " + leaked);
  }
  // And the raw gear code never appears as a gear.
  assert.equal(gearMetric(activeFrame).value, UNAVAILABLE);
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

// ------------------------------------------------- recording failure (V1.0)

test("a failing recorder reaches the global banner instead of only Diagnostics", () => {
  // The disk-full case. Through V0.10 a write failure was honest in the
  // manifest and visible in Diagnostics, but the dashboard looked normal, so a
  // user lost a recording without ever being told.
  const model = buildStatus(snapshot(), false, null, {
    status: "error",
    last_error:
      "Session frame write failed: There is not enough space on the disk.",
  });
  assert.match(model.banner, /not enough space/);
  assert.deepEqual(
    model.items.find((item) => item.key === "recording"),
    {
      key: "recording",
      label: "Recording",
      value: "Recording failed",
      tone: "bad",
      glyph: "✕",
    },
  );
});

test("a stale recorder error does not keep alarming a recovered recording", () => {
  const model = buildStatus(snapshot(), true, null, {
    status: "recording",
    last_error: "an earlier failure",
  });
  assert.equal(model.banner, null);
  assert.equal(
    model.items.find((item) => item.key === "recording").value,
    "Recording",
  );
});

test("a transport error still outranks a recorder error in the banner", () => {
  const model = buildStatus(
    snapshot({ transport_error: "bind failed" }),
    false,
    null,
    { status: "error", last_error: "disk full" },
  );
  assert.equal(model.banner, "bind failed");
});

test("omitting recorder state leaves every V0.10 status reading unchanged", () => {
  assert.deepEqual(
    buildStatus(snapshot(), true, null).items,
    buildStatus(snapshot(), true, null, null).items,
  );
});
