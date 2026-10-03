// V2.0 Phase B: decoded F1 25 player values in Diagnostics — the view model
// and the F1 25 tab. Values are shown as decoded; codes keep their raw value.
import { calls, responses } from "./support/dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { cleanup, click, h, mount, settle, update } from "./support/shell.mjs";
import DiagnosticsWorkspace from "../src/workspaces/DiagnosticsWorkspace.tsx";
import {
  codeText,
  drivingSection,
  lapSection,
  motionSection,
  playerAvailability,
  playerSections,
  statusSection,
  temperaturesSection,
  value,
} from "../src/telemetry/f1-player.ts";
import { INITIAL_F1, f1Received, f1Store } from "../src/state/stores.ts";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const c = (raw, label) => ({ raw, label });
const w = (rl, rr, fl, fr) => ({
  rear_left: rl,
  rear_right: rr,
  front_left: fl,
  front_right: fr,
});
const fresh = (packet_id, value, age_ms = 40) => ({
  packet_id,
  frame_identifier: 1200,
  overall_frame_identifier: 1210,
  session_time: 60.5,
  received_unix_ms: 1,
  age_ms,
  value,
});

const TELEMETRY = {
  speed_kmh: 287,
  throttle: 1,
  steer: -0.125,
  brake: 0,
  clutch: 0,
  gear: c(7, "7"),
  engine_rpm: 11850,
  drs: c(1, "on"),
  rev_lights_percent: 97,
  rev_lights_bit_value: 0x7fff,
  brakes_temperature_c: w(401, 402, 503, 504),
  tyres_surface_temperature_c: w(91, 92, 93, 94),
  tyres_inner_temperature_c: w(101, 102, 103, 104),
  engine_temperature_c: 112,
  tyres_pressure_psi: w(21.5, 21.6, 23.1, 23.2),
  surface_type: w(
    c(0, "tarmac"),
    c(0, "tarmac"),
    c(1, "rumble strip"),
    c(99, null),
  ),
};

const STATUS = {
  traction_control: c(0, "off"),
  anti_lock_brakes: c(0, "off"),
  fuel_mix: c(1, "standard"),
  front_brake_bias_percent: 56,
  pit_limiter_status: c(0, "off"),
  fuel_in_tank: 7.5,
  fuel_capacity: 110,
  fuel_remaining_laps: 3.25,
  max_rpm: 13000,
  idle_rpm: 4000,
  max_gears: 8,
  drs_allowed: c(1, "allowed"),
  drs_activation_distance_m: 0,
  actual_tyre_compound: c(18, "C3"),
  visual_tyre_compound: c(17, "medium"),
  tyres_age_laps: 2,
  vehicle_fia_flags: c(5, null),
  engine_power_ice_w: 560000,
  engine_power_mguk_w: 120000,
  ers_store_energy_j: 3000000,
  ers_deploy_mode: c(2, "hotlap"),
  ers_harvested_this_lap_mguk: 150000,
  ers_harvested_this_lap_mguh: 0,
  ers_deployed_this_lap: 400000,
  network_paused: 0,
};

const split = (total_ms) => ({
  ms_part: total_ms % 60000,
  minutes_part: Math.floor(total_ms / 60000),
  total_ms,
});

const LAP = {
  last_lap_time_ms: 92345,
  current_lap_time_ms: 31002,
  sector1_time: split(28456),
  sector2_time: split(65250),
  delta_to_car_in_front: split(0),
  delta_to_race_leader: split(0),
  lap_distance_m: -12.5,
  total_distance_m: 4120.25,
  safety_car_delta_s: 0,
  car_position: 1,
  current_lap_num: 3,
  pit_status: c(0, "none"),
  num_pit_stops: 0,
  sector: c(1, "sector 2"),
  current_lap_invalid: c(1, "invalid"),
  penalties_s: 5,
  total_warnings: 2,
  corner_cutting_warnings: 1,
  num_unserved_drive_through_pens: 0,
  num_unserved_stop_go_pens: 0,
  grid_position: 1,
  driver_status: c(1, "flying lap"),
  result_status: c(2, "active"),
  pit_lane_timer_active: c(0, "inactive"),
  pit_lane_time_in_lane_ms: 0,
  pit_stop_timer_ms: 0,
  pit_stop_should_serve_pen: 0,
  speed_trap_fastest_speed_kmh: 312.4,
  speed_trap_fastest_lap: 2,
};

const ws = (base) => w(base, base + 1, base + 2, base + 3);
const MOTION = {
  suspension_position: ws(1),
  suspension_velocity: ws(5),
  suspension_acceleration: ws(9),
  wheel_speed: w(80.25, 80.5, 81.0, 81.25),
  wheel_slip_ratio: w(0.01, 0.02, -0.03, 0.04),
  wheel_slip_angle: ws(21),
  wheel_lat_force: ws(25),
  wheel_long_force: ws(29),
  height_of_cog_above_ground: 0.25,
  local_velocity_mps: { x: 0.5, y: -0.25, z: 79.75 },
  angular_velocity_rad_s: { x: 0, y: 0.125, z: 0 },
  angular_acceleration_rad_s2: { x: 0, y: 0, z: 0 },
  front_wheels_angle_rad: -0.0625,
  wheel_vert_force: ws(44),
  front_aero_height: 0,
  rear_aero_height: 0,
  front_roll_angle: 0,
  rear_roll_angle: 0,
  chassis_yaw_rad: 0,
  chassis_pitch_rad: 0,
  wheel_camber_rad: ws(54),
  wheel_camber_gain_rad: ws(58),
};

function live(overrides = {}) {
  return {
    session_uid: "9007199254740993",
    player_car_index: 19,
    player_available: true,
    session_resets: 0,
    player_resets: 0,
    out_of_order_dropped: 3,
    car_telemetry: fresh(6, {
      player: TELEMETRY,
      mfd_panel_index: c(255, "closed"),
      mfd_panel_index_secondary_player: c(255, "closed"),
      suggested_gear: c(0, "none"),
    }),
    car_status: fresh(7, { player: STATUS }, 120),
    lap_data: fresh(2, {
      player: LAP,
      time_trial_pb_car_idx: 255,
      time_trial_rival_car_idx: 255,
    }),
    motion_ex: fresh(13, { player: MOTION }),
    ...overrides,
  };
}

const entries = (section) =>
  Object.fromEntries(section.entries.map((item) => [item.key, item.value]));

test("codes show their label and raw value; unknown codes show only raw", () => {
  assert.equal(codeText(c(18, "C3")), "C3 (18)");
  assert.equal(codeText(c(-1, "R")), "R (-1)");
  assert.equal(codeText(c(99, null)), "Unknown (99)");
  assert.equal(codeText(null), "—");
  // Non-finite floats arrive as null and are unavailable, never 0.
  assert.equal(value(null), "—");
  assert.equal(value(0), "0.000");
});

test("driving shows the decoded inputs without conversion", () => {
  const driving = entries(drivingSection(live()));
  assert.equal(driving.speed, "287");
  assert.equal(driving.throttle, "1.000");
  assert.equal(driving.brake, "0.000");
  assert.equal(driving.steer, "-0.125");
  assert.equal(driving.gear, "7 (7)");
  assert.equal(driving.rpm, "11850");
  assert.equal(driving.drs, "on (1)");
  assert.equal(driving.rev_bits, "0x7FFF");
  assert.equal(driving.mfd, "closed (255)");
  assert.match(
    drivingSection(live()).source,
    /Car Telemetry \(6\) · frame 1200 · 40 ms old/,
  );
});

test("wheel rows are named corners, never wire positions", () => {
  const temps = temperaturesSection(live());
  const brakes = temps.wheels.find((row) => row.key === "brakes").values;
  // Wire order is RL, RR, FL, FR; display is FL, FR, RL, RR by name.
  assert.deepEqual(brakes, { fl: "503", fr: "504", rl: "401", rr: "402" });
  const surface = temps.wheels.find((row) => row.key === "surface").values;
  assert.equal(surface.fl, "rumble strip (1)");
  assert.equal(surface.fr, "Unknown (99)");
  assert.equal(
    temps.wheels.find((row) => row.key === "pressure").values.rl,
    "21.50",
  );
  const slip = motionSection(live()).wheels.find((r) => r.key === "slip_ratio");
  assert.equal(slip.values.fl, "-0.030");
});

test("status, lap and motion sections", () => {
  const status = entries(statusSection(live()));
  assert.equal(status.fuel, "7.50");
  assert.equal(status.bias, "56");
  assert.equal(status.actual_tyre, "C3 (18)");
  assert.equal(status.visual_tyre, "medium (17)");
  assert.equal(status.fia_flag, "Unknown (5)");
  assert.equal(status.ers_mode, "hotlap (2)");
  assert.match(statusSection(live()).source, /120 ms old/);
  const lap = entries(lapSection(live()));
  assert.equal(lap.current_time, "0:31.002");
  assert.equal(lap.last_time, "1:32.345");
  assert.equal(lap.s1, "0:28.456");
  assert.equal(lap.s2, "1:05.250");
  assert.equal(lap.lap_invalid, "invalid (1)");
  // A negative lap distance is shown as sent.
  assert.equal(lap.lap_distance, "-12.5");
  assert.equal(lap.penalties, "5");
  const motion = entries(motionSection(live()));
  assert.equal(motion.local_velocity, "0.500, -0.250, 79.750");
  assert.equal(motion.front_wheels_angle, "-0.063");
});

test("missing families and an invalid player index show no player values", () => {
  const partial = live({ car_status: null, motion_ex: null });
  assert.equal(statusSection(partial).entries, null);
  assert.match(statusSection(partial).source, /not received/);
  assert.equal(motionSection(partial).wheels.length, 0);
  assert.equal(playerAvailability(live()), null);

  const spectating = live({
    player_car_index: 255,
    player_available: false,
    car_telemetry: fresh(6, {
      player: null,
      mfd_panel_index: c(255, "closed"),
      mfd_panel_index_secondary_player: c(255, "closed"),
      suggested_gear: c(0, "none"),
    }),
    car_status: fresh(7, { player: null }),
    lap_data: null,
    motion_ex: fresh(13, { player: null }),
  });
  assert.match(playerAvailability(spectating), /playerCarIndex is 255/);
  assert.ok(playerSections(spectating).every((s) => s.entries === null));
});

function status(liveValue, capture = null) {
  return {
    enabled: true,
    configured_port: 20777,
    listening: true,
    bound_port: 20777,
    transport_datagrams: 10,
    receive_errors: 0,
    listener_error: null,
    live: liveValue,
    capture,
    evidence: {
      detected: true,
      last_accepted_age_ms: 10,
      last_accepted_unix_ms: 1,
      header: null,
      session_uid_changes: 0,
      datagrams: 10,
      accepted: 10,
      truncated: 0,
      wrong_packet_format: 0,
      wrong_game_year: 0,
      unknown_packet_id: 0,
      unsupported_version: 0,
      size_mismatch: 0,
      last_rejection: null,
      kinds: [],
    },
  };
}

test("the F1 25 tab shows decoded player values and no capture without the gate", async () => {
  f1Store.set(INITIAL_F1);
  await mount(h(DiagnosticsWorkspace));
  await update(f1Store, f1Received(INITIAL_F1, status(live())));
  await click($("#diagnostics-tab-f1"));
  assert.match(
    $("[data-entry=f1-player-key]").textContent,
    /playerCarIndex 19/,
  );
  assert.equal($$("[data-section]").length, 5);
  assert.match($("[data-section=driving]").textContent, /287/);
  assert.match(
    $("[data-entry=f1-wheels-brakes]").textContent,
    /Brakes \(°C\)503504401402/,
  );
  assert.equal($("#diag-f1-capture"), null);
  assert.doesNotMatch(document.body.textContent, /preview|hex/i);
  await cleanup();
  f1Store.set(INITIAL_F1);
});

test("the capture panel appears only with capture enabled and sends one request", async () => {
  f1Store.set(INITIAL_F1);
  const requests = [];
  responses.set("capture_f1_fixtures", (args) => {
    requests.push(args);
    return {
      label: args.label,
      captured_unix_ms: 1,
      racelab_version: "1.1.0",
      directory: "dev-f1-fixtures/1-stationary",
      packets: [],
    };
  });
  await mount(h(DiagnosticsWorkspace));
  await update(
    f1Store,
    f1Received(
      INITIAL_F1,
      status(live(), {
        directory: "dev-f1-fixtures",
        snapshots_taken: 0,
        max_snapshots: 16,
        last: null,
        last_error: null,
      }),
    ),
  );
  await click($("#diagnostics-tab-f1"));
  assert.ok($("#diag-f1-capture"));
  assert.match($("[data-entry=f1-capture-count]").textContent, /0 of 16/);
  const before = calls.filter((n) => n === "capture_f1_fixtures").length;
  const button = $$("button").find((b) => b.textContent === "Capture snapshot");
  await click(button);
  await settle();
  assert.equal(
    calls.filter((n) => n === "capture_f1_fixtures").length - before,
    1,
  );
  assert.deepEqual(requests, [{ label: "stationary", delayMs: 0 }]);
  assert.match(
    $("[data-entry=f1-capture-result]").textContent,
    /dev-f1-fixtures\/1-stationary/,
  );
  responses.delete("capture_f1_fixtures");
  await cleanup();
  f1Store.set(INITIAL_F1);
});
