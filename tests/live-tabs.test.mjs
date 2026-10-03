// Stage C: the four Live tabs, asserted on the rendered DOM.
//
// Every reading carries `data-source` (the canonical field) and `data-role`
// (`home` on the one tab that owns it, `mirror` where a primary value is
// repeated on purpose). These tests read those attributes from what actually
// renders, so a field that is in the model but not on screen still fails.
import { renders, resetRenders } from "./support/dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  act,
  cleanup,
  click,
  frame,
  h,
  installBackend,
  mount,
  resetStores,
  ShellHarness,
  snapshot,
  update,
} from "./support/shell.mjs";
import { TopBar } from "../src/components/shell/TopBar.tsx";
import { liveStore } from "../src/state/stores.ts";

installBackend();
test.afterEach(cleanup);

const CORNERS = ["FL", "FR", "RL", "RR"];
const WHEEL_CHANNELS = [
  "temperature_c",
  "slip_ratio",
  "slip_angle",
  "combined_slip",
  "rotation_rad_s",
  "normalized_suspension_travel",
  "suspension_travel_m",
];
const axes = (field) => ["x", "y", "z"].map((axis) => `${field}.${axis}`);

/// Where every pre-Stage-C live field lives now. This is the contract: each
/// field has exactly one home tab, and nothing else is a home anywhere.
const HOME = {
  overview: [
    "speed_mps",
    "gear",
    // V1.0 Inputs
    "controls.throttle",
    "controls.brake",
    "controls.steering",
    "controls.clutch",
    "controls.handbrake",
    // V1.0 Race
    "race.race_time_seconds",
    "race.lap_number",
    "race.race_position",
    "game_timestamp_ms",
    "absent.current_lap",
    "absent.last_lap",
    "absent.best_lap",
    "absent.distance",
    // V1.0 Overview identity
    "vehicle_id",
    "game",
  ],
  powertrain: [
    "engine.rpm",
    "engine.idle_rpm",
    "engine.max_rpm",
    "engine.power_w",
    "engine.torque_nm",
    "vehicle.class_code",
    "vehicle.performance_index",
    "vehicle.drivetrain_code",
    "vehicle.cylinders",
    "absent.boost",
    "absent.fuel",
  ],
  chassis: [
    // V1.0 Tires and Suspension, every channel at every corner
    ...CORNERS.flatMap((corner) =>
      WHEEL_CHANNELS.map((channel) => `wheels.${corner}.${channel}`),
    ),
    "absent.rumble_strip",
    "absent.puddle_depth",
    "absent.surface_rumble",
  ],
  dynamics: [
    ...axes("velocity"),
    ...axes("acceleration"),
    ...axes("angular_velocity"),
    ...axes("orientation"),
    ...axes("position"),
  ],
};

/// Deliberate repeats of a primary reading, and nothing more.
const MIRRORS = {
  overview: [
    "engine.rpm",
    "engine.max_rpm",
    "engine.power_w",
    "engine.torque_nm",
  ],
  powertrain: [],
  chassis: [],
  dynamics: ["speed_mps"],
};

const TABS = [
  ["overview", "Overview"],
  ["powertrain", "Powertrain"],
  ["chassis", "Chassis"],
  ["dynamics", "Dynamics"],
];

/// A frame whose four wheels are all different, so a transposed corner would
/// show the wrong number.
function distinctFrame() {
  const wheel = (n) => ({
    temperature_c: 70 + n,
    slip_ratio: n / 100,
    slip_angle: n / 1000,
    combined_slip: n / 10,
    rotation_rad_s: 80 + n,
    normalized_suspension_travel: n / 10,
    suspension_travel_m: n / 100,
  });
  return {
    ...frame(30),
    wheels: {
      front_left: wheel(1),
      front_right: wheel(2),
      rear_left: wheel(3),
      rear_right: wheel(4),
    },
  };
}

const panel = () => document.querySelector('[role="tabpanel"]');
const tabButton = (label) =>
  [...document.querySelectorAll('[role="tab"]')].find(
    (element) => element.textContent === label,
  );

function sources(root, role) {
  return [...root.querySelectorAll(`[data-source][data-role="${role}"]`)].map(
    (element) => element.dataset.source,
  );
}

async function openTab(label) {
  await click(tabButton(label));
}

async function mountLive(liveFrame = distinctFrame()) {
  resetStores();
  await update(liveStore, {
    snapshot: snapshot({ frame: liveFrame }),
    error: null,
  });
  return mount(h(ShellHarness));
}

// ------------------------------------------------------------ coverage

test("every pre-Stage-C live field has exactly one home tab", async () => {
  await mountLive();
  const homeTab = new Map();
  for (const [id, label] of TABS) {
    await openTab(label);
    const homes = new Set(sources(panel(), "home"));
    assert.deepEqual([...homes].sort(), [...HOME[id]].sort(), `${label} homes`);
    assert.deepEqual(
      [...new Set(sources(panel(), "mirror"))].sort(),
      [...MIRRORS[id]].sort(),
      `${label} mirrors`,
    );
    for (const source of homes) {
      assert.ok(!homeTab.has(source), `${source} is a home on two tabs`);
      homeTab.set(source, id);
    }
  }
  // Every mirror points at a field that does have a home elsewhere.
  for (const [id, mirrors] of Object.entries(MIRRORS)) {
    for (const source of mirrors) {
      assert.ok(homeTab.has(source), `${source} mirrored without a home`);
      assert.notEqual(homeTab.get(source), id);
    }
  }
});

test("Overview carries the old Inputs and Race fields, each exactly once", async () => {
  await mountLive();
  const homes = sources(panel(), "home");
  for (const source of [
    "controls.throttle",
    "controls.brake",
    "controls.steering",
    "controls.clutch",
    "controls.handbrake",
    "race.race_time_seconds",
    "race.lap_number",
    "race.race_position",
    "game_timestamp_ms",
  ]) {
    assert.equal(
      homes.filter((item) => item === source).length,
      1,
      `${source} must appear once on Overview (no duplicated Inputs content)`,
    );
  }
  // Gear is secondary: not the hero, never the largest reading.
  const gear = panel().querySelector('[data-source="gear"]');
  assert.ok(!gear.classList.contains("readout-hero"));
  assert.ok(
    gear.closest(".drive-secondary"),
    "gear sits with the secondary readings",
  );
  assert.ok(panel().querySelector('[data-source="speed_mps"].readout-hero'));
});

test("Chassis carries every old Tires and Suspension channel", async () => {
  await mountLive();
  await openTab("Chassis");
  const homes = new Set(sources(panel(), "home"));
  for (const corner of CORNERS) {
    for (const channel of WHEEL_CHANNELS) {
      assert.ok(
        homes.has(`wheels.${corner}.${channel}`),
        `${corner} ${channel}`,
      );
    }
  }
});

// ---------------------------------------------------------- wheel order

test("corners render FL, FR, RL, RR, and each shows its own wheel", async () => {
  await mountLive();
  await openTab("Chassis");
  const corners = [...panel().querySelectorAll("[data-corner]")];
  assert.deepEqual(
    corners.map((element) => element.dataset.corner),
    CORNERS,
  );
  // Distinct per-wheel values: FL=1, FR=2, RL=3, RR=4.
  CORNERS.forEach((corner, index) => {
    const n = index + 1;
    const value = (channel) =>
      corners[index].querySelector(
        `[data-source="wheels.${corner}.${channel}"] .readout-value`,
      ).textContent;
    assert.equal(value("temperature_c"), (70 + n).toFixed(1), corner);
    assert.equal(value("slip_ratio"), (n / 100).toFixed(3), corner);
    assert.equal(
      value("normalized_suspension_travel"),
      (n / 10).toFixed(3),
      corner,
    );
    assert.equal(value("suspension_travel_m"), (n * 10).toFixed(1), corner);
    // Every source inside a corner belongs to that corner.
    for (const source of sources(corners[index], "home")) {
      assert.ok(
        source.startsWith(`wheels.${corner}.`),
        `${source} in ${corner}`,
      );
    }
  });
  // Each corner is named in its accessible label.
  assert.deepEqual(
    corners.map((element) => element.getAttribute("aria-label")),
    [
      "Front left (FL)",
      "Front right (FR)",
      "Rear left (RL)",
      "Rear right (RR)",
    ],
  );
});

// -------------------------------------------------------------- honesty

test("with no live frame every reading is unavailable, never zero", async () => {
  resetStores();
  await update(liveStore, {
    snapshot: snapshot({ frame: null, connection: "LISTENING" }),
    error: null,
  });
  await mount(h(ShellHarness));
  for (const [, label] of TABS) {
    await openTab(label);
    const readings = [...panel().querySelectorAll("[data-source]")];
    assert.ok(readings.length > 0);
    for (const element of readings) {
      assert.equal(element.dataset.available, "false", element.dataset.source);
      if (element.dataset.source.startsWith("absent.")) continue;
      assert.match(element.textContent, /—/, element.dataset.source);
      assert.doesNotMatch(
        element.textContent.replace(/unavailable/g, ""),
        /\d/,
        `${element.dataset.source} shows a number with no frame`,
      );
    }
    // No bar is drawn for an unavailable input or range.
    assert.equal(
      panel().querySelectorAll(
        ".control-bar-fill, .rpm-bar-fill, .travel-bar-fill",
      ).length,
      0,
    );
  }
});

test("a single missing channel is unavailable while its neighbours stay live", async () => {
  const value = distinctFrame();
  value.wheels.rear_left.temperature_c = null;
  value.engine.power_w = null;
  value.controls.brake = null;
  await mountLive(value);
  const at = (source) => panel().querySelector(`[data-source="${source}"]`);
  assert.equal(at("controls.brake").dataset.available, "false");
  assert.equal(at("controls.brake").querySelector(".control-bar-fill"), null);
  assert.equal(at("controls.throttle").dataset.available, "true");
  assert.equal(at("engine.power_w").dataset.available, "false");
  assert.doesNotMatch(at("engine.power_w").textContent, /kW|0\.0/);
  await openTab("Chassis");
  assert.equal(at("wheels.RL.temperature_c").dataset.available, "false");
  assert.match(at("wheels.RL.temperature_c").textContent, /—/);
  assert.doesNotMatch(at("wheels.RL.temperature_c").textContent, /°C/);
  assert.equal(at("wheels.RR.temperature_c").dataset.available, "true");
});

const INTERPRETATION =
  /\b(hot|cold|warm(ing)?|cool(ing)?|optimal|ideal|overheat\w*|too high|too low|wheel ?spin|lock-?up|locked|understeer|oversteer|bottom(ed|ing)? out|redline|red line|shift now|danger|critical|grip)\b/i;

test("no tab attaches an interpretation the telemetry does not establish", async () => {
  await mountLive();
  for (const [, label] of TABS) {
    await openTab(label);
    // Text node by text node: `textContent` would run adjacent elements
    // together ("optimalTemperature") and hide a word from \b.
    const walker = document.createTreeWalker(
      panel(),
      window.NodeFilter.SHOW_TEXT,
    );
    const parts = [];
    while (walker.nextNode()) parts.push(walker.currentNode.textContent);
    const words = parts.join(" ").replace(
      // The one sentence that says no shift point is marked.
      /marks no shift point/g,
      "",
    );
    assert.doesNotMatch(words, INTERPRETATION, label);
    // No state class that encodes a judgement (is-hot, overheat, …), matched
    // on whole hyphen-separated words so `live-overview` is not a hit.
    for (const element of panel().querySelectorAll("[class]")) {
      for (const name of String(element.className).split(/\s+/)) {
        assert.doesNotMatch(
          name,
          /(^|-)(hot|cold|optimal|ideal|danger|critical|warn|warning|overheat|lockup|wheelspin)(-|$)/i,
          `${label}: ${name}`,
        );
      }
    }
  }
});

test("throttle and brake colours stay on the pedals", () => {
  const css = fs
    .readFileSync(new URL("../src/styles/live.css", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  for (const token of ["--ch-throttle", "--ch-brake"]) {
    const rules = [...css.matchAll(/([^{}]+)\{[^}]*/g)]
      .filter((match) => match[0].includes(`var(${token})`))
      .map((match) => match[1].trim());
    assert.ok(rules.length > 0, token);
    for (const selector of rules) {
      assert.match(
        selector,
        /^\.control-bar\[data-channel="(throttle|brake)"\]/,
        selector,
      );
    }
  }
  // Chassis uses neutral intensity only: no channel or status colour.
  const chassis = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((match) =>
    /corner|travel|chassis|axle/.test(match[1]),
  );
  assert.ok(chassis.length > 0);
  for (const [, selector, body] of chassis) {
    assert.doesNotMatch(
      body,
      /--ch-throttle|--ch-brake|--status-|--warn|--bad|--ok/,
      selector,
    );
  }
});

// ------------------------------------------------------------- mounting

test("only the selected Live tab is mounted and rendered", async () => {
  await mountLive();
  const visible = () =>
    ["OverviewTab", "PowertrainTab", "ChassisTab", "DynamicsTab"].filter(
      (name) => (renders[name] ?? 0) > 0,
    );
  for (const [id, label] of TABS) {
    await openTab(label);
    // Nothing from another tab is in the DOM.
    const homes = new Set(sources(document.body, "home"));
    for (const [other, list] of Object.entries(HOME)) {
      if (other === id) continue;
      for (const source of list) {
        assert.ok(!homes.has(source), `${label} contains ${other}'s ${source}`);
      }
    }
    // And live updates render the selected tab alone.
    resetRenders();
    for (let i = 0; i < 5; i += 1) {
      await update(liveStore, {
        snapshot: snapshot({ frame: distinctFrame() }),
        error: null,
      });
    }
    const name = `${label}Tab`;
    assert.deepEqual(visible(), [name]);
    assert.equal(renders[name], 5);
  }
});

// ----------------------------------------------------- status pill slot

test("the grace countdown ticks inside a fixed tabular slot", async () => {
  resetStores();
  const grace = (remaining) =>
    update(liveStore, {
      snapshot: snapshot({
        frame: null,
        connection: "GRACE",
        grace_period_ms: 10000,
        session: {
          state: "GRACE",
          grace_remaining_ms: remaining,
          duration_ms: 1000,
        },
      }),
      error: null,
    });
  await grace(10000);
  await mount(h(TopBar));
  const title = () => document.querySelector(".state-pill-title");
  const figure = () => document.querySelector(".state-pill-figure");
  assert.equal(title().textContent, "Paused · session ends in 10 s");
  assert.equal(figure().style.minWidth, "2ch");
  const lead = title().firstChild.textContent;
  for (const remaining of [9000, 4000, 0]) {
    await grace(remaining);
    // The slot keeps its width, the text around it does not change, and the
    // figure is right-aligned in tabular digits (live.css/shell.css).
    assert.equal(figure().style.minWidth, "2ch");
    assert.equal(figure().textContent, String(remaining / 1000));
    assert.equal(title().firstChild.textContent, lead);
    assert.equal(
      title().textContent,
      `Paused · session ends in ${remaining / 1000} s`,
    );
  }
  const css = fs.readFileSync(
    new URL("../src/styles/shell.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.state-pill-title \{[^}]*tabular-nums/);
  assert.match(
    css,
    /\.state-pill-figure \{[^}]*display: inline-block[^}]*text-align: right/,
  );
  await act(async () => {});
});

// ---------------------------------------------------- Stage C.1 a11y fixes

/// The text assistive technology reads, and the text painted on screen.
function spoken(element) {
  return element.textContent.replace(/\s+/g, " ").trim();
}
function painted(element) {
  const copy = element.cloneNode(true);
  for (const hidden of copy.querySelectorAll(".visually-hidden"))
    hidden.remove();
  return copy.textContent.replace(/\s+/g, " ").trim();
}

test("each Dynamics row is identified with its unit, the screen stays calm", async () => {
  await mountLive();
  await openTab("Dynamics");
  const headers = [
    ...panel().querySelectorAll(".axis-table tbody th[scope=row]"),
  ];
  const names = headers.map(spoken);
  assert.deepEqual(names, [
    "Velocity, m/s",
    "Acceleration, m/s²",
    "Acceleration, g",
    "Angular velocity, rad/s",
    "Position, m",
  ]);
  // Every row header is distinct, so cell-by-cell navigation is unambiguous.
  assert.equal(new Set(names).size, names.length);
  // Visually the two acceleration rows still read "Acceleration"; the unit
  // stays in its own column.
  assert.deepEqual(headers.map(painted).slice(1, 3), [
    "Acceleration",
    "Acceleration",
  ]);
});

test('unavailable RPM endpoints announce "unavailable" like every reading', async () => {
  resetStores();
  await update(liveStore, {
    snapshot: snapshot({ frame: null, connection: "LISTENING" }),
    error: null,
  });
  await mount(h(ShellHarness));
  for (const [label, expected] of [
    ["Overview", ["Max unavailable"]],
    ["Powertrain", ["Idle unavailable", "Max unavailable"]],
  ]) {
    await openTab(label);
    const ends = [...panel().querySelectorAll(".rpm-bar-end")];
    // What is read aloud: the label and "unavailable", never a dash.
    const read = ends.map((end) => {
      const copy = end.cloneNode(true);
      for (const hidden of copy.querySelectorAll("[aria-hidden=true]"))
        hidden.remove();
      return copy.textContent.replace(/\s+/g, " ").trim();
    });
    assert.deepEqual(read, expected, label);
    for (const end of ends) assert.equal(end.dataset.available, "false");
  }
  // With a frame there is nothing to announce as unavailable.
  await update(liveStore, {
    snapshot: snapshot({ frame: distinctFrame() }),
    error: null,
  });
  for (const end of panel().querySelectorAll(".rpm-bar-end")) {
    assert.doesNotMatch(end.textContent, /unavailable/);
  }
});
