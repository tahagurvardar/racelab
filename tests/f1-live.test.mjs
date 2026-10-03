// V2.0 Phase C: the F1 25 Live experience. Layouts are checked against the
// four REAL captured snapshots (live-snapshots.json, which a Rust test pins
// to the decoder's own output), then freshness, then the product shell in a
// DOM: top bar, F1 tabs, keyboard, Settings, Sessions and render isolation.
import { renders, resetRenders } from "./support/dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  cleanup,
  click,
  focus,
  frame,
  h,
  installBackend,
  mount,
  press,
  resetStores,
  settle,
  ShellHarness,
  snapshot,
  update,
} from "./support/shell.mjs";
import {
  f1DynamicsLayout,
  f1LiveBanner,
  f1OverviewLayout,
  f1RaceLayout,
  f1TyresLayout,
} from "../src/telemetry/f1-live-layout.ts";
import {
  FAMILY_FRESH_MS,
  FAMILY_STALE_MS,
  familyFreshness,
} from "../src/telemetry/f1-freshness.ts";
import { number } from "../src/telemetry/formatting.ts";
import { overviewLayout } from "../src/telemetry/live-layout.ts";
import {
  INITIAL_F1_LIVE,
  f1LiveReceived,
  f1LiveStore,
  f1RecorderStore,
  liveStore,
  setupStore,
} from "../src/state/stores.ts";

test.afterEach(cleanup);

const REAL = JSON.parse(
  fs.readFileSync(
    new URL(
      "../src-tauri/tests/fixtures/f1_25/live-snapshots.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

/// A real snapshot with every family's age set (default: all fresh).
function real(name, ages = {}) {
  const live = structuredClone(REAL[name]);
  for (const key of ["car_telemetry", "car_status", "lap_data", "motion_ex"]) {
    if (live[key]) live[key].age_ms = ages[key] ?? 30;
    if (ages[key] === null) live[key] = null;
  }
  return live;
}

const value = (readings, key) => {
  const found = readings.find((reading) => reading.key === key);
  assert.ok(found, `no reading ${key}`);
  return found;
};

// ---------------------------------------------------------------- Overview

test("Overview presents the real snapshots' driving values", () => {
  const driving = f1OverviewLayout(real("driving"));
  assert.equal(driving.speed.value, "170");
  assert.equal(driving.speed.unit, "km/h");
  assert.equal(driving.gear.value, "4");
  assert.equal(driving.rpm.value, "11024");
  // The bar spans the car's own idle (4000) to max (13099) RPM.
  // (11024 - 4000) / (13099 - 4000) = 77.195 %
  assert.equal(driving.rpm.fraction.toFixed(2), "77.20");
  assert.equal(driving.rpm.idle.value, "4000");
  assert.equal(driving.rpm.max.value, "13099");
  const [throttle, brake] = driving.pedals;
  assert.equal(throttle.value, "100");
  assert.equal(brake.value, "0");
  assert.equal(driving.steering.value, "8");
  assert.equal(driving.steering.signed, true);
  assert.equal(driving.clutch.value, "0");
  assert.equal(value(driving.car, "fuel_in_tank").value, "10.00");
  assert.equal(value(driving.car, "fuel_in_tank").unit, null, "no unit stated");
  assert.equal(value(driving.car, "fuel_remaining_laps").value, "5.41");
  assert.equal(value(driving.car, "front_brake_bias_percent").value, "58");
  assert.deepEqual(
    driving.drs.map((reading) => [reading.label, reading.value]),
    [
      ["DRS", "Off"],
      ["DRS allowed", "Not allowed"],
      ["DRS available in", "98 m"],
    ],
  );
  assert.deepEqual(
    driving.ers.map((reading) => [reading.value, reading.unit]),
    [
      ["4.00", "MJ"], // 4 000 000 J, exactly
      ["Hotlap", null],
    ],
  );
  assert.deepEqual(
    driving.context.map((reading) => [reading.label, reading.value]),
    [
      ["Lap", "1"],
      ["Position", "1"],
      ["Sector", "Sector 1"],
      ["Lap time", "0:14.699"],
      ["Last lap", "0:00.000"],
    ],
  );

  const braking = f1OverviewLayout(real("braking"));
  assert.equal(braking.speed.value, "59");
  assert.equal(braking.gear.value, "2");
  assert.equal(braking.pedals[1].value, "100");
  assert.equal(braking.steering.value, "76");
  // "0 = DRS not available": the specification's meaning, in words.
  assert.equal(
    value(braking.drs, "drs_activation_distance_m").value,
    "Not available",
  );

  const high = f1OverviewLayout(real("high-speed"));
  assert.equal(high.speed.value, "292");
  assert.equal(high.gear.value, "8");
  assert.equal(high.pedals[1].value, "82");
  assert.equal(value(high.context, "last_lap_time_ms").value, "1:34.052");

  const parked = f1OverviewLayout(real("stationary"));
  assert.equal(parked.speed.value, "0");
  assert.equal(parked.gear.value, "N");
  assert.equal(parked.rpm.value, "3920");
  // Below idle: the bar stays at its start, the number stays exact.
  assert.equal(parked.rpm.fraction, 0);
  assert.equal(value(parked.ers, "ers_deploy_mode").value, "None");
});

test("F1 gear is decoded; an undefined gear code is never shown as a gear", () => {
  const live = real("driving");
  live.car_telemetry.value.player.gear = { raw: -1, label: "R" };
  assert.equal(f1OverviewLayout(live).gear.value, "R");
  live.car_telemetry.value.player.gear = { raw: 9, label: null };
  const model = f1OverviewLayout(live);
  assert.equal(model.gear.available, false);
  assert.equal(model.gear.value, "—");
  assert.match(
    model.notes[0].note,
    /gear code its specification does not define/,
  );
});

test("FH6 gear stays unresolved: F1 25 semantics are not applied to FH6", () => {
  const fh6 = overviewLayout({
    frame: frame(),
    availability: "live",
    reason: "",
  });
  assert.equal(fh6.gear.available, false);
  assert.match(fh6.gear.note, /Forza Horizon 6's gear value/);
});

// -------------------------------------------------------------------- Race

test("Race presents lap context exactly as F1 25 sent it", () => {
  const find = (model, key) =>
    model.groups.flatMap((group) => group.readings).find((r) => r.key === key);
  const driving = f1RaceLayout(real("driving"));
  assert.deepEqual(
    driving.groups.map((group) => group.title),
    [
      "Lap",
      "Standing",
      "Pit",
      "Penalties and warnings",
      "Energy this lap",
      "Speed trap",
    ],
  );
  assert.equal(find(driving, "current_lap_num").value, "1");
  assert.equal(find(driving, "current_lap_time_ms").value, "0:14.699");
  assert.equal(find(driving, "current_lap_invalid").value, "Invalid");
  assert.equal(find(driving, "sector").value, "Sector 1");
  assert.equal(find(driving, "sector1_time").value, "0:00.000");
  assert.equal(find(driving, "lap_distance_m").value, "907.6");
  assert.equal(find(driving, "car_position").value, "1");
  assert.equal(find(driving, "driver_status").value, "Flying lap");
  assert.equal(find(driving, "result_status").value, "Active");
  assert.equal(find(driving, "pit_status").value, "None");
  assert.equal(find(driving, "penalties_s").value, "0");
  assert.equal(find(driving, "total_warnings").value, "0");
  assert.equal(find(driving, "corner_cutting_warnings").value, "0");
  assert.equal(find(driving, "speed_trap_fastest_speed_kmh").value, "327.4");
  const high = f1RaceLayout(real("high-speed"));
  assert.equal(find(high, "current_lap_num").value, "2");
  assert.equal(find(high, "last_lap_time_ms").value, "1:34.052");
  assert.equal(find(high, "current_lap_invalid").value, "Valid");
  const parked = f1RaceLayout(real("stationary"));
  assert.equal(find(parked, "driver_status").value, "In garage");
  assert.equal(find(parked, "pit_status").value, "Pitting");
  assert.equal(find(parked, "speed_trap_fastest_lap").value, "Not set");
  // Negative before the line, as the specification allows: never clamped.
  assert.equal(find(parked, "lap_distance_m").value, "-5272.5");
});

// ------------------------------------------------------------------- Tyres

const CORNER_FIELD = {
  FL: "front_left",
  FR: "front_right",
  RL: "rear_left",
  RR: "rear_right",
};

test("Tyres maps F1's RL, RR, FL, FR wire order to FL, FR, RL, RR, every corner its own", () => {
  for (const name of ["stationary", "driving", "braking", "high-speed"]) {
    const live = real(name);
    const model = f1TyresLayout(live);
    assert.deepEqual(
      model.corners.map((corner) => [corner.corner, corner.label]),
      [
        ["FL", "Front left"],
        ["FR", "Front right"],
        ["RL", "Rear left"],
        ["RR", "Rear right"],
      ],
    );
    const t = live.car_telemetry.value.player;
    const m = live.motion_ex.value.player;
    for (const corner of model.corners) {
      const field = CORNER_FIELD[corner.corner];
      assert.equal(corner.brake.value, String(t.brakes_temperature_c[field]));
      assert.equal(
        corner.surface.value,
        String(t.tyres_surface_temperature_c[field]),
      );
      assert.equal(
        corner.inner.value,
        String(t.tyres_inner_temperature_c[field]),
      );
      assert.equal(
        corner.pressure.value,
        number(t.tyres_pressure_psi[field], 1),
      );
      assert.equal(corner.wheelSpeed.value, number(m.wheel_speed[field], 2));
      assert.equal(
        corner.slipRatio.value,
        number(m.wheel_slip_ratio[field], 3),
      );
      assert.equal(
        corner.vertForce.value,
        number(m.wheel_vert_force[field], 0),
      );
    }
  }
  // The values reviewed against the real drive.
  const driving = f1TyresLayout(real("driving")).corners;
  assert.deepEqual(
    driving.map((corner) => [
      corner.corner,
      corner.brake.value,
      corner.pressure.value,
    ]),
    [
      ["FL", "765", "24.7"],
      ["FR", "772", "24.7"],
      ["RL", "728", "21.7"],
      ["RR", "738", "21.7"],
    ],
  );
  // Under throttle only the rears slip.
  assert.equal(driving[2].slipRatio.value, "0.033");
  assert.equal(driving[0].slipRatio.value, "-0.001");
  // Turning right under braking loads the left (outside) wheels.
  const braking = f1TyresLayout(real("braking")).corners;
  assert.equal(braking[0].vertForce.value, "3648");
  assert.equal(braking[1].vertForce.value, "1405");
  const set = f1TyresLayout(real("driving")).tyreSet;
  assert.deepEqual(
    set.map((reading) => [reading.label, reading.value]),
    [
      ["Actual compound", "C3"],
      ["Visual compound", "Soft"],
      ["Tyre age", "0"],
    ],
  );
  // No temperature band, condition or wheelspin label anywhere.
  const text = JSON.stringify(f1TyresLayout(real("braking")));
  assert.doesNotMatch(text, /lockup|wheelspin|overheat|optimal|good|cold/i);
});

// ---------------------------------------------------------------- Dynamics

test("Dynamics presents Motion Ex as measured values", () => {
  const model = f1DynamicsLayout(real("high-speed"));
  const velocity = model.axes.find((row) => row.key === "local_velocity_mps");
  assert.equal(velocity.unit, "m/s");
  assert.deepEqual(
    velocity.values.map((reading) => reading.value),
    ["0.058", "0.248", "81.370"],
  );
  assert.equal(model.axes[1].unit, "rad/s");
  assert.equal(model.axes[2].unit, "rad/s²");
  const longForce = model.wheels.find((row) => row.key === "wheel_long_force");
  assert.equal(longForce.unit, "", "no unit stated");
  assert.deepEqual(
    longForce.values.map((reading) => reading.source.split(".").pop()),
    ["FL", "FR", "RL", "RR"],
  );
  assert.equal(longForce.values[0].value, "-5892");
  for (const row of model.wheels) {
    const m = REAL["high-speed"].motion_ex.value.player;
    row.values.forEach((reading, index) => {
      const corner = ["FL", "FR", "RL", "RR"][index];
      assert.ok(reading.source.endsWith(corner));
      assert.equal(reading.available, m[row.key][CORNER_FIELD[corner]] != null);
    });
  }
  const text = JSON.stringify(model);
  assert.doesNotMatch(text, /understeer|oversteer|balance|grip/i);
});

// --------------------------------------------------------------- freshness

test("family freshness: fresh, stale, unavailable", () => {
  assert.equal(familyFreshness(30), "fresh");
  // The captured high-speed snapshot was 441 ms old: still current.
  assert.equal(familyFreshness(441), "fresh");
  assert.equal(familyFreshness(FAMILY_FRESH_MS), "fresh");
  assert.equal(familyFreshness(FAMILY_FRESH_MS + 1), "stale");
  assert.equal(familyFreshness(FAMILY_STALE_MS), "stale");
  assert.equal(familyFreshness(FAMILY_STALE_MS + 1), "unavailable");
  assert.equal(familyFreshness(10_000), "unavailable");
  assert.equal(familyFreshness(null), "unavailable");
});

test("every family fresh: nothing is marked stale", () => {
  const model = f1OverviewLayout(real("driving"));
  for (const reading of [model.speed, ...model.car, ...model.context]) {
    assert.equal(reading.stale, undefined, reading.key);
  }
  assert.deepEqual(
    model.families.map((family) => family.text),
    ["Updating", "Updating", "Updating"],
  );
});

test("telemetry stale while lap is fresh: only telemetry values are marked", () => {
  const model = f1OverviewLayout(real("driving", { car_telemetry: 1800 }));
  assert.equal(model.speed.value, "170");
  assert.equal(model.speed.stale, true);
  assert.equal(model.pedals[0].stale, true);
  assert.equal(value(model.context, "current_lap_num").stale, undefined);
  assert.equal(value(model.car, "fuel_in_tank").stale, undefined);
  assert.equal(model.families[0].text, "Not updating · 1.8 s");
  assert.equal(model.families[2].text, "Updating");
});

test("status stale while telemetry is fresh", () => {
  const model = f1OverviewLayout(real("driving", { car_status: 2500 }));
  assert.equal(model.speed.stale, undefined);
  assert.equal(value(model.car, "fuel_in_tank").stale, true);
  assert.equal(value(model.ers, "ers_store_energy_j").stale, true);
});

test("a family gone stale too long is hidden; the others keep displaying", () => {
  const live = real("driving", { motion_ex: 6000 });
  const tyres = f1TyresLayout(live);
  for (const corner of tyres.corners) {
    assert.equal(corner.wheelSpeed.available, false, corner.corner);
    assert.equal(corner.slipRatio.value, "—");
    // Telemetry-sourced values on the same corner are untouched.
    assert.equal(corner.brake.available, true);
  }
  assert.equal(tyres.families[1].text, "No current data");
  const dynamics = f1DynamicsLayout(live);
  assert.ok(
    dynamics.axes.every((row) => row.values.every((r) => !r.available)),
  );
  // Telemetry 10 s old is never on screen as if it were live.
  const old = f1OverviewLayout(real("driving", { car_telemetry: 10_000 }));
  assert.equal(old.speed.available, false);
  assert.equal(old.rpm.fraction, null);
});

test("an invalid player index produces no player values anywhere", () => {
  const live = real("driving");
  live.player_car_index = 255;
  live.player_available = false;
  live.car_telemetry.value.player = null;
  live.car_status.value.player = null;
  live.lap_data.value.player = null;
  live.motion_ex.value.player = null;
  const model = f1OverviewLayout(live);
  assert.equal(model.speed.available, false);
  assert.equal(model.families[0].text, "No player car");
  assert.ok(f1TyresLayout(live).corners.every((c) => !c.brake.available));
  assert.equal(f1LiveBanner(live, "detected", 20).availability, "no_player");
});

test("the Live banner names the state in the top bar's words", () => {
  assert.equal(f1LiveBanner(real("driving"), "active", 20), null);
  assert.equal(
    f1LiveBanner(real("driving"), "detected", 20).headline,
    "Connected · not driving",
  );
  const paused = f1LiveBanner(real("driving"), "stale", 4200);
  assert.equal(paused.headline, "Paused");
  assert.match(paused.reason, /4 s ago/);
});

// ------------------------------------------------------------------ in DOM

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const tabs = () => $$("[role=tab]").map((tab) => tab.textContent);

function f1Status(live, lastAcceptedAgeMs = 20) {
  return {
    enabled: true,
    configured_port: 20777,
    listening: true,
    bound_port: 20777,
    listener_error: null,
    last_accepted_age_ms: lastAcceptedAgeMs,
    live,
  };
}

async function f1Shell(live = real("driving")) {
  resetStores();
  installBackend();
  await update(liveStore, {
    snapshot: snapshot({
      connection: "LISTENING",
      health: "LOST",
      protocol: null,
      frame: null,
      last_valid_frame_age_ms: null,
    }),
    error: null,
  });
  await update(f1LiveStore, f1LiveReceived(INITIAL_F1_LIVE, f1Status(live)));
  return mount(h(ShellHarness));
}

test("F1 25 active: the top bar and Live follow it, with F1's own tabs", async () => {
  await f1Shell();
  await update(f1RecorderStore, {
    status: { phase: "idle", recording: false, waiting_reason: null },
    available: true,
    error: null,
  });
  assert.equal($(".state-pill-title").textContent, "Live");
  assert.equal($(".topbar-game").textContent, "F1 25");
  assert.deepEqual(
    $$(".topbar-facts dt").map((dt) => dt.textContent),
    ["Lap", "Position"],
  );
  assert.deepEqual(tabs(), ["Overview", "Race", "Tyres", "Dynamics"]);
  assert.equal($(".live-workspace").dataset.game, "f1_25");
  assert.match($(".drive-speed .readout-value").textContent, /^170$/);
  assert.match($(".f1-gear .readout-value").textContent, /^4$/);
  // Normal Live shows no identifiers, sizes or raw codes.
  const text = $(".workspace").textContent;
  for (const hidden of [
    "2396549747549880658",
    "packetFormat",
    "1352",
    "sessionUID",
    "fh6",
  ]) {
    assert.ok(!text.includes(hidden), hidden);
  }
  // No FH6 wording on an F1 screen.
  assert.doesNotMatch(text, /Forza Horizon 6/);
  assert.match(text, /Recording\s*Not recording F1 25/);
  await cleanup();
});

test("F1 tabs follow the tab pattern and the numeric shortcuts", async () => {
  await f1Shell();
  await focus($("#live-tab-overview"));
  await press("ArrowRight");
  assert.equal($("[role=tab][aria-selected=true]").textContent, "Race");
  assert.equal(document.activeElement.id, "live-tab-race");
  assert.equal(
    $("[role=tabpanel]").getAttribute("aria-labelledby"),
    "live-tab-race",
  );
  await press("End");
  assert.equal($("[role=tab][aria-selected=true]").textContent, "Dynamics");
  await press("Home");
  assert.equal($("[role=tab][aria-selected=true]").textContent, "Overview");
  await press("ArrowLeft");
  assert.equal($("[role=tab][aria-selected=true]").textContent, "Dynamics");
  // Plain 3 opens the third tab: Tyres.
  await press("3", { target: document.body });
  assert.equal($("[role=tab][aria-selected=true]").textContent, "Tyres");
  // Corners announce their full name and code.
  assert.deepEqual(
    $$("[data-corner]").map((corner) => corner.getAttribute("aria-label")),
    [
      "Front left (FL)",
      "Front right (FR)",
      "Rear left (RL)",
      "Rear right (RR)",
    ],
  );
  await cleanup();
});

test("stale values say so in words, not by colour alone", async () => {
  await f1Shell(real("driving", { car_telemetry: 1800 }));
  const speed = $(".drive-speed");
  assert.ok(speed.classList.contains("is-stale"));
  assert.match(speed.textContent, /not updating/);
  const badge = $('[data-family="telemetry"]');
  assert.equal(badge.dataset.freshness, "stale");
  assert.match(badge.textContent, /Not updating · 1\.8 s/);
  await cleanup();
});

test("F1 updates render only the F1 Live view, and only its open tab", async () => {
  await f1Shell();
  resetRenders();
  for (let i = 0; i < 20; i += 1) {
    await update(
      f1LiveStore,
      f1LiveReceived(
        INITIAL_F1_LIVE,
        f1Status(real("driving", { car_telemetry: 20 + i })),
      ),
    );
  }
  assert.equal(renders.F1LiveWorkspace, 20);
  assert.ok(renders.F1OverviewTab >= 20);
  assert.equal(renders.F1RaceTab ?? 0, 0, "hidden tabs are not mounted");
  assert.equal(renders.LiveWorkspace ?? 0, 0);
  assert.equal(renders.AppShell ?? 0, 0);
  assert.equal(renders.Sidebar ?? 0, 0);
  assert.equal(renders.Fh6LiveWorkspace ?? 0, 0);
  await cleanup();
});

test("Sessions and Settings do not render with F1 updates; history stays available", async () => {
  const view = await f1Shell();
  await click(
    $$(".sidebar-item").find((b) => b.textContent.includes("Sessions")),
  );
  await settle();
  assert.equal($(".sessions-note"), null);
  assert.equal($$("[role=option]").length, 1);
  assert.match($("[role=option]").textContent, /Forza Horizon 6/);
  assert.equal($(".sessions-detail").dataset.session, "s-1");
  resetRenders();
  for (let i = 0; i < 10; i += 1) {
    await update(
      f1LiveStore,
      f1LiveReceived(
        INITIAL_F1_LIVE,
        f1Status(real("driving", { car_telemetry: 20 + i })),
      ),
    );
  }
  for (const name of ["SessionsWorkspace", "SessionList", "SessionDetail"]) {
    assert.equal(renders[name] ?? 0, 0, name);
  }
  await click(
    $$(".sidebar-item").find((b) => b.textContent.includes("Settings")),
  );
  await settle();
  const group = $('[aria-labelledby="settings-f1-title"]');
  assert.match(group.textContent, /Receiving F1 25 telemetry/);
  const rows = [...group.querySelectorAll("dt")].map((dt) => [
    dt.textContent,
    dt.nextElementSibling.textContent,
  ]);
  assert.deepEqual(rows, [
    ["UDP Telemetry", "On"],
    ["UDP Broadcast Mode", "Off"],
    ["UDP IP Address", "127.0.0.1"],
    ["UDP Port", "20777"],
    ["UDP Send Rate", "20Hz"],
    ["UDP Format", "2025"],
  ]);
  // Every "UDP" is the game's own quoted menu label.
  for (const element of group.querySelectorAll("*")) {
    if (element.children.length === 0 && /\bUDP\b/.test(element.textContent)) {
      assert.ok(element.closest("[data-game-menu]"), element.textContent);
    }
  }
  // No development capture control in normal Settings.
  assert.doesNotMatch($(".workspace").textContent, /capture/i);
  resetRenders();
  for (let i = 0; i < 10; i += 1) {
    await update(
      f1LiveStore,
      f1LiveReceived(
        INITIAL_F1_LIVE,
        f1Status(real("driving", { car_telemetry: 20 + i })),
      ),
    );
  }
  assert.equal(renders.SettingsWorkspace ?? 0, 0);
  assert.equal(renders.F1Setup ?? 0, 0);
  await view.unmount();
  await cleanup();
});

test("the FH6 first-run guide steps aside while F1 25 is the active game", async () => {
  resetStores();
  installBackend();
  await update(setupStore, {
    setup: {
      first_run: true,
      listen_host: "127.0.0.1",
      listen_port: 20440,
      fh6_first_detected_unix_ms: null,
    },
    sawFirstRun: true,
    error: null,
  });
  await update(liveStore, {
    snapshot: snapshot({
      connection: "LISTENING",
      protocol: null,
      frame: null,
    }),
    error: null,
  });
  await mount(h(ShellHarness));
  assert.equal($$(".setup-guide").length, 1);
  assert.equal($(".state-pill-title").textContent, "Set up a supported game");
  await update(
    f1LiveStore,
    f1LiveReceived(INITIAL_F1_LIVE, f1Status(real("driving"))),
  );
  assert.equal($$(".setup-guide").length, 0);
  assert.equal($(".state-pill-title").textContent, "Live");
  await cleanup();
});

test("no game: neutral waiting names both supported games and no FH6 tabs", async () => {
  resetStores();
  installBackend();
  await update(setupStore, {
    setup: {
      first_run: false,
      listen_host: "127.0.0.1",
      listen_port: 20440,
      fh6_first_detected_unix_ms: 1,
    },
    sawFirstRun: false,
    error: null,
  });
  await update(liveStore, {
    snapshot: snapshot({
      connection: "LISTENING",
      protocol: null,
      frame: null,
    }),
    error: null,
  });
  await update(
    f1LiveStore,
    f1LiveReceived(INITIAL_F1_LIVE, f1Status(real("driving"), null)),
  );
  await mount(h(ShellHarness));
  assert.equal(
    $(".state-pill-title").textContent,
    "Waiting for a supported game",
  );
  assert.equal(
    $(".telemetry-empty-title").textContent,
    "Waiting for a supported game",
  );
  assert.equal($$("[role=tab]").length, 0);
  // No game's name or facts beside the waiting state.
  assert.equal($(".topbar-game"), null);
  assert.equal($$(".topbar-facts dt").length, 0);
  assert.deepEqual(
    $$(".waiting-game-name").map((name) => name.textContent),
    ["Forza Horizon 6", "F1 25"],
  );
  assert.match($('[data-game="f1_25"]').textContent, /port 20777/);
  assert.match($('[data-game="fh6"]').textContent, /port 20440/);
  await cleanup();
});

test("FH6 regression: FH6 active keeps its own tabs, wording and corner mapping", async () => {
  resetStores();
  installBackend();
  await update(liveStore, { snapshot: snapshot(), error: null });
  await update(
    f1LiveStore,
    f1LiveReceived(INITIAL_F1_LIVE, f1Status(real("driving"), null)),
  );
  await mount(h(ShellHarness));
  assert.deepEqual(tabs(), ["Overview", "Powertrain", "Chassis", "Dynamics"]);
  assert.equal($(".topbar-game").textContent, "Forza Horizon 6");
  assert.deepEqual(
    $$(".topbar-facts dt").map((dt) => dt.textContent),
    ["Vehicle", "Session"],
  );
  assert.equal($(".live-workspace").dataset.game, "fh6");
  // FH6's gear stays unresolved, with its own reason.
  assert.match(
    $(".workspace").textContent,
    /gear value means has not been confirmed/,
  );
  await click($("#live-tab-chassis"));
  assert.deepEqual(
    $$("[data-corner]").map((corner) => corner.dataset.corner),
    ["FL", "FR", "RL", "RR"],
  );
  // F1 25 starting does not take the screen from a driving FH6.
  await update(
    f1LiveStore,
    f1LiveReceived(INITIAL_F1_LIVE, f1Status(real("driving"))),
  );
  assert.equal($(".live-workspace").dataset.game, "fh6");
  await cleanup();
});
