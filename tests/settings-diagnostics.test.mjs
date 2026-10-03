// Stage E: Settings (storage limit, reopenable setup) and Diagnostics
// (tabs, raw semantics, listener) — the model, the DOM, and what each
// re-renders for.
import { calls, renders, resetRenders, responses } from "./support/dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  act,
  cleanup,
  click,
  focus,
  frame,
  h,
  installBackend,
  mount,
  onCleanup,
  press,
  resetStores,
  settle,
  ShellHarness,
  snapshot,
  update,
} from "./support/shell.mjs";
import SettingsWorkspace from "../src/workspaces/SettingsWorkspace.tsx";
import DiagnosticsWorkspace from "../src/workspaces/DiagnosticsWorkspace.tsx";
import { storageView } from "../src/settings-state.ts";
import { liveStore, setupStore, transportStore } from "../src/state/stores.ts";
import { storage } from "./support/sessions.mjs";

const GIB = 1024 ** 3;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const text = () => document.body.textContent;
const button = (label) =>
  $$("button").find((item) => item.textContent.trim() === label);
const count = (command) => calls.filter((name) => name === command).length;

const SETUP = {
  first_run: false,
  listen_host: "127.0.0.1",
  listen_port: 20440,
  fh6_first_detected_unix_ms: 1_800_000_000_000,
};

function settings(overrides = {}) {
  return {
    storage_budget_bytes: 8 * GIB,
    storage_budget_from_environment: false,
    min_storage_budget_bytes: GIB,
    max_storage_budget_bytes: 1024 * GIB,
    default_storage_budget_bytes: 8 * GIB,
    fh6_first_detected_unix_ms: 1,
    last_error: null,
    path: "settings.json",
    ...overrides,
  };
}

function install() {
  installBackend();
  resetStores();
  calls.length = 0;
  responses.set("get_settings", () => settings());
  responses.set("get_storage_status", () => storage());
  responses.set("set_storage_budget", ({ budgetBytes }) =>
    settings({ storage_budget_bytes: budgetBytes }),
  );
}

async function withSetup(setup = SETUP) {
  await update(setupStore, { setup, sawFirstRun: false, error: null });
}

function countLiveSubscribers() {
  const original = liveStore.subscribe;
  const counter = { active: 0 };
  onCleanup(() => (liveStore.subscribe = original));
  liveStore.subscribe = (listener) => {
    counter.active += 1;
    const dispose = original(listener);
    return () => {
      counter.active -= 1;
      dispose();
    };
  };
  return counter;
}

async function liveUpdates(n) {
  for (let i = 0; i < n; i += 1) {
    await update(liveStore, {
      snapshot: snapshot({ frame: frame(10 + i) }),
      error: null,
    });
  }
}

test.afterEach(cleanup);

// --------------------------------------------------------- storage model

test("storage view: usage, the enforced limit and what the setting does", () => {
  const view = storageView(settings(), storage());
  assert.equal(view.used, "3.0 GB");
  assert.equal(view.limit, "8.0 GB");
  assert.equal(view.fraction, 3 / 8);
  assert.match(view.sessions, /3 session/);
  assert.match(view.meaning, /oldest complete sessions are deleted first/);
  assert.equal(view.pendingChange, null);
  assert.deepEqual(view.warnings, []);
});

test("storage view: a saved limit that differs is stated as applying next start", () => {
  const view = storageView(
    settings({ storage_budget_bytes: 25 * GIB }),
    storage(),
  );
  assert.match(
    view.pendingChange,
    /25\.0 GB\) applies the next time RaceLab starts/,
  );
  assert.match(view.pendingChange, /current limit \(8\.0 GB\)/);
  // Keep everything vs no limit in force.
  const off = storageView(
    settings({ storage_budget_bytes: 0 }),
    storage({ retention: { enabled: false } }),
  );
  assert.equal(off.limit, "No limit");
  assert.equal(off.fraction, null);
  assert.equal(off.pendingChange, null);
});

test("storage view: every storage problem is a titled warning with the backend's words kept", () => {
  const view = storageView(
    settings({ last_error: "settings.json: access denied" }),
    storage({
      retention: {
        over_budget: true,
        failed_deletions: 2,
        last_error: "Could not delete session X: in use",
      },
    }),
  );
  assert.deepEqual(
    view.warnings.map((warning) => warning.key),
    ["over-budget", "failed-deletions", "settings-file"],
  );
  assert.match(view.warnings[0].detail, /Over the limit/);
  assert.equal(
    view.warnings[1].technical,
    "Could not delete session X: in use",
  );
  assert.ok(
    !/in use/.test(view.warnings[1].detail),
    "raw text is not the message",
  );
  assert.equal(view.warnings[2].technical, "settings.json: access denied");
  // Nothing is guessed when a read is missing.
  const empty = storageView(null, null);
  assert.equal(empty.used, null);
  assert.equal(empty.limit, null);
  assert.equal(empty.meaning, null);
});

// ------------------------------------------------------------- settings

test("Settings shows usage, a labelled limit choice, and saves a new limit", async () => {
  install();
  await withSetup();
  await mount(h(SettingsWorkspace));
  const meter = $('[role="meter"]');
  assert.equal(meter.getAttribute("aria-valuenow"), "38");
  assert.equal(meter.getAttribute("aria-valuetext"), "3.0 GB of 8.0 GB");
  const group = $(".segmented");
  assert.equal(group.getAttribute("role"), "group");
  assert.equal(
    document.getElementById(group.getAttribute("aria-labelledby")).textContent,
    "Storage limit",
  );
  const pressed = () =>
    $$(".segment")
      .filter((item) => item.getAttribute("aria-pressed") === "true")
      .map((item) => item.textContent);
  assert.deepEqual(pressed(), ["8 GB"]);
  assert.match(text(), /oldest complete sessions are deleted first/);
  assert.match(text(), /A new limit applies the next time RaceLab starts/);

  await click(button("25 GB"));
  assert.equal(count("set_storage_budget"), 1);
  assert.deepEqual(pressed(), ["25 GB"]);
  assert.equal($(".settings-saved").getAttribute("role"), "status");
  assert.match($(".settings-saved").textContent, /Saved/);
  assert.match(text(), /applies the next time RaceLab starts/);
});

test("Settings: loading, read failure and save failure are deliberate states", async () => {
  install();
  let release;
  responses.set("get_settings", () => new Promise((r) => (release = r)));
  await withSetup();
  await mount(h(SettingsWorkspace));
  assert.match($(".settings-loading").textContent, /Reading storage settings/);
  await act(async () => release(settings()));
  await settle();
  assert.ok($(".segmented"));

  responses.set("set_storage_budget", () => {
    throw new Error("disk is read-only (os error 30)");
  });
  await click(button("2 GB"));
  const notice = $(".notice.tone-bad");
  assert.equal(notice.getAttribute("role"), "alert");
  assert.match(
    notice.querySelector(".notice-title").textContent,
    /could not be saved/,
  );
  assert.match(
    notice.querySelector(".notice-technical").textContent,
    /os error 30/,
  );
  assert.ok(
    !/os error 30/.test(notice.querySelector(".notice-title").textContent),
  );
  await cleanup();

  install();
  responses.set("get_settings", () => {
    throw new Error("ipc closed");
  });
  await withSetup();
  await mount(h(SettingsWorkspace));
  assert.match($(".notice-title").textContent, /could not be read/);
  assert.match($(".notice-technical").textContent, /ipc closed/);
});

test("Settings reopens the setup steps; only then does anything follow live telemetry", async () => {
  install();
  const subscribers = countLiveSubscribers();
  await withSetup();
  await mount(h(SettingsWorkspace));
  const toggle = button("Show setup steps");
  const region = document.getElementById(toggle.getAttribute("aria-controls"));
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(region.hidden, true);
  assert.equal(subscribers.active, 0, "closed: no live subscriber");

  await click(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(region.hidden, false);
  const steps = region.querySelectorAll("ol > li");
  assert.equal(steps.length, 6);
  assert.deepEqual(
    [...region.querySelectorAll(".setup-value")].map(
      (item) => item.textContent,
    ),
    ["127.0.0.1", "20440"],
  );
  assert.equal($(".setup-detection").getAttribute("role"), "status");
  assert.equal(subscribers.active, 1, "open: the detection line alone");

  await click(button("Hide setup steps"));
  assert.equal(subscribers.active, 0);
});

test("Settings during first run points to the guide instead of repeating it", async () => {
  install();
  await withSetup({
    ...SETUP,
    first_run: true,
    fh6_first_detected_unix_ms: null,
  });
  await mount(h(SettingsWorkspace));
  assert.match(text(), /Not set up yet/);
  assert.equal(button("Show setup steps"), undefined);
  assert.equal($$(".setup-steps").length, 0);
});

test("Settings and an open detection line ignore 20 Hz live updates", async () => {
  install();
  await withSetup();
  await mount(h(SettingsWorkspace));
  await click(button("Show setup steps"));
  await liveUpdates(1);
  resetRenders();
  await liveUpdates(20);
  assert.equal(renders.SettingsWorkspace ?? 0, 0);
  assert.equal(renders.StorageBudget ?? 0, 0);
  assert.equal(renders.GameSetup ?? 0, 0);
  // The detection sentence did not change, so it did not re-render.
  assert.equal(renders.DetectionLine ?? 0, 0);
});

// ----------------------------------------------------------- diagnostics

function adapterFrame() {
  return {
    ...frame(30),
    sourceSpecific: {
      fh6: {
        gear: 11,
        boost: 0,
        fuel: 0.5,
        tire_temperatures: [101, 102, 103, 104],
        tire_slip_ratio: [0.1, 0.2, 0.3, 0.4],
        best_lap: 0,
        car_class: 5,
      },
    },
  };
}

test("Diagnostics: four tabs in the tab pattern, remembered while away", async () => {
  install();
  await mount(h(DiagnosticsWorkspace));
  assert.deepEqual(
    $$("[role=tab]").map((tab) => tab.textContent),
    ["Connection", "Pipeline", "Adapter", "Capture"],
  );
  assert.match($(".diag-badge").textContent, /Engineering data/);
  await focus($("#diagnostics-tab-connection"));
  await press("ArrowRight");
  assert.equal(
    $("[role=tab][aria-selected=true]").id,
    "diagnostics-tab-pipeline",
  );
  assert.equal(
    $("[role=tabpanel]").getAttribute("aria-labelledby"),
    "diagnostics-tab-pipeline",
  );
  await cleanup();
  install();
  await mount(h(DiagnosticsWorkspace));
  assert.equal(
    $("[role=tab][aria-selected=true]").id,
    "diagnostics-tab-pipeline",
  );
});

test("Diagnostics keeps raw semantics: gear as a code, wheels in packet order, absent fields unexplained by guesses", async () => {
  install();
  await update(liveStore, {
    snapshot: snapshot({ frame: adapterFrame() }),
    error: null,
  });
  await mount(h(DiagnosticsWorkspace));
  await click($("#diagnostics-tab-adapter"));
  const gear = $('[data-entry="gear-code"]');
  assert.equal(gear.querySelector("th").textContent, "Gear (raw code)");
  assert.equal(gear.querySelector(".diag-value").textContent, "11");
  assert.match(
    gear.closest(".diag-group").textContent,
    /never shown as a gear/,
  );

  // Packet index order 0..3, never corners.
  const matrix = $(".diag-matrix");
  assert.deepEqual(
    [...matrix.querySelectorAll("thead th")].map((th) => th.textContent),
    ["Channel", "Index 0", "Index 1", "Index 2", "Index 3"],
  );
  const temps = [...matrix.querySelectorAll("tbody tr")].find(
    (row) => row.querySelector("th").textContent === "Tire temperature (°F)",
  );
  assert.deepEqual(
    [...temps.querySelectorAll("td")].map((td) => td.textContent),
    ["101.0", "102.0", "103.0", "104.0"],
  );
  assert.ok(!/Front left|Rear right|\bFL\b|\bRR\b/.test(matrix.textContent));

  // Unestablished values stay raw, with their caveats.
  assert.match(
    $('[data-entry="best-lap"]').textContent,
    /unit and meaning are unestablished/,
  );
  assert.match($('[data-entry="class"]').textContent, /Opaque code/);
  // Fields kept out of Live, each with the product's own reason.
  const deferred = [...$$(".diag-group")].find((group) =>
    /Not shown in Live/.test(group.textContent),
  );
  assert.match(deferred.textContent, /gear value means has not been confirmed/);
  assert.ok(!/raw value is in Diagnostics/.test(deferred.textContent));
  assert.ok(!/Not shown\. /.test(deferred.textContent));
  // No raw frame dump anywhere.
  assert.ok(!/sourceSpecific|"fh6"/.test(text()));
});

test("Diagnostics: the listener port starts at the bound port, and failures are titled", async () => {
  install();
  await update(transportStore, {
    ...transportStore.get(),
    stats: { revision: 2, running: false, bound_port: 20441, last_error: null },
  });
  responses.set("start_udp_listener", () => {
    throw new Error("could not bind 127.0.0.1:20441 (os error 10048)");
  });
  await mount(h(DiagnosticsWorkspace));
  await click($("#diagnostics-tab-connection"));
  assert.equal($('input[type="number"]').value, "20441");
  assert.match($(".diag-status").textContent, /Stopped/);
  await click(button("Start listener"));
  const notice = $(".notice.tone-bad");
  assert.match(
    notice.querySelector(".notice-title").textContent,
    /Listener problem/,
  );
  assert.match(notice.querySelector(".notice-technical").textContent, /10048/);
});

test("Diagnostics: only the open tab follows live telemetry", async () => {
  install();
  await liveUpdates(1);
  await mount(h(DiagnosticsWorkspace));
  await click($("#diagnostics-tab-capture"));
  resetRenders();
  await liveUpdates(20);
  assert.equal(renders.DiagnosticsWorkspace ?? 0, 0);
  assert.equal(renders.CaptureTab ?? 0, 0, "Capture reads no live telemetry");
  assert.equal(renders.CapturePanel ?? 0, 0);

  // Positive control: the Connection tab shows live counters.
  await click($("#diagnostics-tab-connection"));
  resetRenders();
  await liveUpdates(5);
  assert.equal(renders.ConnectionTab, 5);
  assert.equal(renders.DiagnosticsWorkspace ?? 0, 0);
});

// ------------------------------------------------------------ navigation

test("Live, Sessions and Settings stay the only product sections; Diagnostics sits apart", async () => {
  install();
  await mount(h(ShellHarness));
  const groups = $$(".sidebar-list").map((list) =>
    [...list.querySelectorAll(".sidebar-item")].map((item) =>
      item.textContent.trim(),
    ),
  );
  assert.deepEqual(groups, [["Live", "Sessions", "Settings"], ["Diagnostics"]]);
});
