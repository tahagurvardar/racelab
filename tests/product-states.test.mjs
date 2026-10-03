// Stage E product states: one clear primary message per state, no duplicate
// alerts, consistent wording between the top bar and Live, first-run
// completion, and no implementation jargon on product screens.
import { responses } from "./support/dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  act,
  cleanup,
  click,
  frame,
  h,
  installBackend,
  mount,
  recorder,
  resetStores,
  settle,
  ShellHarness,
  snapshot,
  update,
} from "./support/shell.mjs";
import { FirstRunSlot } from "../src/components/shell/FirstRunSlot.tsx";
import { WorkspaceHeader } from "../src/components/shell/WorkspaceHeader.tsx";
import {
  liveStore,
  recorderStore,
  setupStore,
  transportStore,
} from "../src/state/stores.ts";
import { analysisState, manifest, storage } from "./support/sessions.mjs";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const sidebar = (label) =>
  $$(".sidebar-item").find((item) => item.textContent.includes(label));

/// Text a sighted user can see: hidden panels (the state popover) and
/// closed disclosures' bodies are excluded.
function visibleText(root = document.body) {
  const parts = [];
  const walk = (node) => {
    if (node.nodeType === 3) {
      parts.push(node.textContent);
      return;
    }
    if (node.nodeType !== 1) return;
    if (node.hidden || node.classList.contains("visually-hidden")) return;
    if (node.tagName === "DETAILS" && !node.open) {
      const summary = node.querySelector("summary");
      if (summary) walk(summary);
      return;
    }
    for (const child of node.childNodes) walk(child);
  };
  walk(root);
  return parts.join(" ");
}
const occurrences = (needle, haystack) => haystack.split(needle).length - 1;

const SETUP = {
  first_run: false,
  listen_host: "127.0.0.1",
  listen_port: 20440,
  fh6_first_detected_unix_ms: 1,
};

async function shell({
  live = snapshot(),
  rec = recorder(),
  setup = SETUP,
  liveError = null,
} = {}) {
  installBackend();
  resetStores();
  responses.set("get_session", ({ sessionId }) => manifest(sessionId));
  responses.set("get_session_analysis", ({ sessionId }) =>
    analysisState(sessionId, "not_analyzed"),
  );
  await update(liveStore, { snapshot: live, error: liveError });
  await update(recorderStore, { recorder: rec, error: null });
  await update(setupStore, { setup, sawFirstRun: false, error: null });
  return mount(h(ShellHarness));
}

test.afterEach(cleanup);

// --------------------------------------------------------- recording failed

test("a recording failure is stated once — by the global alert — on every section", async () => {
  await shell({
    rec: recorder({
      status: "error",
      recording: false,
      last_error: "Could not write frames.rlframes (os error 112)",
    }),
  });
  for (const section of ["Live", "Sessions", "Settings", "Diagnostics"]) {
    await click(sidebar(section));
    await settle();
    const seen = visibleText();
    assert.equal(
      occurrences("Recording failed", seen),
      1,
      `${section}: "Recording failed" shown ${occurrences("Recording failed", seen)}×`,
    );
    const alert = $(".shell-alert-slot .notice");
    assert.equal(alert.getAttribute("role"), "alert");
    assert.match(
      alert.querySelector(".notice-title").textContent,
      /^Recording failed$/,
    );
    assert.match(
      alert.querySelector(".notice-detail").textContent,
      /not being recorded/,
    );
    // The backend's words are kept, behind Technical details.
    assert.match(
      alert.querySelector(".notice-technical").textContent,
      /os error 112/,
    );
    // The pill keeps saying where the game is; REC says what is true.
    assert.equal($(".state-pill-title").textContent, "Live");
    assert.match($(".rec-indicator").textContent, /Not recording/);
    assert.ok($(".rec-indicator").classList.contains("tone-bad"));
  }
  assert.equal($(".recording-row"), null, "Sessions repeats nothing");
});

test("a recovered recorder raises no alert and shows REC", async () => {
  await shell({ rec: recorder({ last_error: "old failure (os error 112)" }) });
  assert.equal($(".shell-alert-slot"), null);
  assert.match($(".rec-indicator").textContent, /REC/);
  assert.ok(!/os error 112/.test(visibleText()));
});

// ---------------------------------------------------- waiting / degraded

test("waiting: the top bar and Live use the same words", async () => {
  await shell({
    live: snapshot({ connection: "LISTENING", health: "LOST", frame: null }),
    rec: recorder({ status: "idle", recording: false }),
  });
  assert.equal(
    $(".state-pill-title").textContent,
    "Waiting for Forza Horizon 6",
  );
  assert.equal(
    $(".telemetry-empty-title").textContent,
    "Waiting for Forza Horizon 6",
  );
  assert.equal($$(".telemetry-empty").length, 1);
  assert.equal($(".shell-alert-slot"), null);
});

test("degraded with valid readings: one caution line, never green", async () => {
  await shell({
    live: snapshot({ connection: "DEGRADED", health: "DEGRADED" }),
  });
  assert.equal($(".state-pill-title").textContent, "Live · degraded");
  assert.ok($(".state-pill").classList.contains("tone-warn"));
  assert.equal($$(".live-caution").length, 1);
  assert.match($(".live-caution").textContent, /latest valid frame/);
  assert.equal($(".telemetry-empty"), null, "readings stay on screen");
});

test("degraded without a valid frame: the Live state says degraded, not waiting", async () => {
  await shell({
    live: snapshot({ connection: "DEGRADED", health: "DEGRADED", frame: null }),
  });
  assert.equal($(".state-pill-title").textContent, "Telemetry degraded");
  assert.equal($(".telemetry-empty-title").textContent, "Telemetry degraded");
});

test("connected but not driving says so in both places", async () => {
  await shell({
    live: snapshot({
      connection: "CONNECTED_IDLE",
      frame: { ...frame(), active: false },
    }),
  });
  assert.equal($(".state-pill-title").textContent, "Connected · not driving");
  assert.equal(
    $(".telemetry-empty-title").textContent,
    "Connected · not driving",
  );
});

test("grace: paused, with the session held", async () => {
  await shell({
    live: snapshot({
      connection: "GRACE",
      frame: null,
      session: {
        id: "s",
        started_at: 0,
        duration_ms: 10_000,
        game: "fh6",
        vehicle_id: "3421",
        state: "GRACE",
        grace_remaining_ms: 8_000,
        ended_reason: null,
      },
    }),
  });
  assert.match(
    $(".state-pill-title").textContent,
    /^Paused · session ends in 8 s$/,
  );
  assert.equal(
    $(".telemetry-empty-title").textContent,
    "Paused · session held",
  );
});

// ----------------------------------------- failures covered by the alert

test("a port that cannot be opened: the alert explains it, Live does not repeat it", async () => {
  await shell({
    live: snapshot({
      connection: "ERROR",
      health: "LOST",
      frame: null,
      transport_error: "could not bind 127.0.0.1:20440 (os error 10048)",
    }),
  });
  const alert = $(".shell-alert-slot .notice");
  assert.match(
    alert.querySelector(".notice-title").textContent,
    /cannot receive telemetry/,
  );
  assert.match(alert.querySelector(".notice-technical").textContent, /10048/);
  assert.equal($(".telemetry-empty"), null);
  assert.equal($(".state-pill-title").textContent, "Not listening");
});

test("an unreachable service: one alert, and Live does not claim to be starting", async () => {
  await shell({ live: null, liveError: "ipc channel closed" });
  assert.match($(".notice-title").textContent, /service not responding/);
  assert.equal($(".telemetry-empty"), null);
  assert.ok(!/RaceLab is starting/.test(visibleText()));
});

test("a stopped listener (no error) is explained once, without sending users to Diagnostics first", async () => {
  installBackend();
  resetStores();
  await update(transportStore, {
    ...transportStore.get(),
    stats: { revision: 3, running: false, bound_port: null },
  });
  await update(liveStore, {
    snapshot: snapshot({ connection: "LISTENING", frame: null }),
    error: null,
  });
  await update(setupStore, { setup: SETUP, sawFirstRun: false, error: null });
  await mount(h(ShellHarness));
  assert.equal($(".telemetry-empty-title").textContent, "Not listening");
  assert.match($(".telemetry-empty-reason").textContent, /Restarting RaceLab/);
  assert.ok(!/from Diagnostics/.test(visibleText()));
});

// ---------------------------------------------------------------- first run

test("first run: the guide is the one message; Live does not add a waiting box", async () => {
  await shell({
    live: snapshot({ connection: "LISTENING", health: "LOST", frame: null }),
    setup: { ...SETUP, first_run: true, fh6_first_detected_unix_ms: null },
  });
  assert.equal($$(".setup-guide").length, 1);
  assert.equal($(".telemetry-empty"), null);
  assert.equal($(".state-pill-title").textContent, "Set up Forza Horizon 6");
  const guide = $(".setup-guide");
  assert.equal(guide.querySelectorAll("ol > li").length, 6);
  assert.match(guide.textContent, /127\.0\.0\.1/);
  assert.match(guide.textContent, /20440/);
  assert.match(
    guide.textContent,
    /reopen these steps at any time from Settings/,
  );
  for (const jargon of [
    /\budp\b/i,
    /datagram/i,
    /socket/i,
    /loopback/i,
    /packet/i,
  ]) {
    assert.ok(!jargon.test(guide.textContent), String(jargon));
  }
});

test("first-run completion is calm, announced, and returns focus to the workspace", async () => {
  installBackend();
  resetStores();
  await mount(
    h("div", null, [
      h(FirstRunSlot, { key: "slot" }),
      h(
        "div",
        { key: "view", className: "workspace-view" },
        h(WorkspaceHeader, { title: "Live" }),
      ),
    ]),
  );
  await update(setupStore, {
    setup: { ...SETUP, first_run: true, fh6_first_detected_unix_ms: null },
    sawFirstRun: true,
    error: null,
  });
  assert.match($(".setup-guide h2").textContent, /Turn on Data Out/);
  await update(setupStore, {
    setup: { ...SETUP, first_run: false },
    sawFirstRun: true,
    error: null,
  });
  const done = $(".setup-guide");
  assert.equal(done.getAttribute("role"), "status");
  assert.match(done.textContent, /Setup complete/);
  assert.match(
    done.querySelector("h2").textContent,
    /^Forza Horizon 6 is connected$/,
  );
  const cont = [...done.querySelectorAll("button")].find(
    (b) => b.textContent === "Continue",
  );
  await act(async () => cont.focus());
  await click(cont);
  assert.equal($(".setup-guide"), null);
  assert.equal(document.activeElement, $(".workspace-view h1"));
});

// ------------------------------------------------------------ storage

test("a storage warning reads the same in Sessions and Settings", async () => {
  await shell();
  const over = storage({
    retention: { over_budget: true, used_bytes: 9 * 1024 ** 3 },
  });
  responses.set("get_storage_status", () => over);
  await click(sidebar("Sessions"));
  await settle();
  const sessionsNotice = $(".list-notice.tone-warn").textContent;
  await click(sidebar("Settings"));
  await settle();
  const settingsNotice = [...$$(".notice.tone-warn")].find((n) =>
    /Over the storage limit/.test(n.textContent),
  );
  assert.ok(settingsNotice);
  assert.ok(
    settingsNotice
      .querySelector(".notice-detail")
      .textContent.includes(sessionsNotice),
    "the same sentence in both places",
  );
});

// ------------------------------------------------------------ copy audit

test("product screens carry no implementation jargon", async () => {
  await shell();
  const banned =
    /\bcanonical\b|TelemetryFrame|\bschema\b|\badapter\b|\bUDP\b|\bV0\.\d|sourceSpecific|\bbackend\b/i;
  for (const tab of ["Overview", "Powertrain", "Chassis", "Dynamics"]) {
    await click($$("[role=tab]").find((item) => item.textContent === tab));
    const seen = visibleText($(".workspace"));
    const hit = seen.match(banned);
    assert.equal(hit, null, `Live ${tab}: "${hit?.[0]}"`);
  }
  for (const section of ["Sessions", "Settings"]) {
    await click(sidebar(section));
    await settle();
    const seen = visibleText($(".workspace"));
    const hit = seen.match(banned);
    assert.equal(hit, null, `${section}: "${hit?.[0]}"`);
  }
});
