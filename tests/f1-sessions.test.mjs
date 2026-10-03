import { calls, responses, renders, resetRenders } from "./support/dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { act } from "react";
import { f1Detail, f1Recorder } from "../review/f1-session-fixtures.ts";
import { multiGameDays, recordingOwner } from "../src/f1-sessions.ts";
import {
  createSessionsController,
  resetSessionsMemory,
  ANALYSIS_REFRESH_MS,
} from "../src/session-controller.ts";
import { shellStatus } from "../src/telemetry/shell-view-model.ts";
import { f1RecordingPresentation } from "../src/telemetry/f1-recording.ts";
import { activeGameStore } from "../src/state/active-game.ts";
import { useF1RecorderStatus } from "../src/hooks/use-f1-recorder-status.ts";
import {
  f1RecorderReceived,
  f1RecorderStore,
  liveStore,
  recorderStore,
  setupStore,
  transportStore,
} from "../src/state/stores.ts";
import {
  manifest,
  analysisState,
  storage,
  flush,
  manualTimers,
} from "./support/sessions.mjs";
import {
  cleanup,
  click,
  focus,
  h,
  installBackend,
  mount,
  press,
  recorder,
  resetStores,
  settle,
  ShellHarness,
  update,
} from "./support/shell.mjs";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const F1 = f1Detail();
const FH6 = manifest("fh6-review", { started_at_unix_ms: 1_791_030_000_001 });
const LIST = {
  sessions: [FH6],
  f1_sessions: [{ session: F1.session, labels: F1.labels }],
  unreadable: 0,
  directory: "sessions",
  limit: 20,
};
test.beforeEach(() => {
  resetStores();
  resetSessionsMemory();
  installBackend();
});
test.afterEach(cleanup);

for (const [owner, fh6, f1, label] of [
  [null, false, false, "REC"],
  ["fh6", true, false, "REC · Forza Horizon 6"],
  ["f1_25", false, true, "REC · F1 25"],
]) {
  test(`REC follows ${owner ?? "no owner"} across both active Live games`, async () => {
    assert.deepEqual(recordingOwner(fh6, f1Recorder(f1)), {
      game: owner,
      label,
    });
    await update(recorderStore, {
      recorder: recorder({
        recording: fh6,
        status: fh6 ? "recording" : "idle",
      }),
      error: null,
    });
    await update(f1RecorderStore, {
      status: f1Recorder(f1),
      available: true,
      error: null,
    });
    for (const game of ["fh6", "f1_25"]) {
      const model = shellStatus({
        live: liveStore.get(),
        recorder: recorderStore.get(),
        setup: setupStore.get(),
        transport: transportStore.get(),
        f1Recorder: f1RecorderStore.get(),
        activeGame: { game, fh6: "active", f1_25: "active" },
      });
      assert.equal(model.activeGame, game);
      assert.equal(model.recording.owner, owner);
      assert.equal(model.recording.active, owner != null);
      assert.equal(model.recording.label, label);
    }
    await mount(h(ShellHarness));
    assert.equal(
      $(".rec-indicator").textContent.trim(),
      owner == null ? "Not recording" : label,
    );
    assert.equal(
      $(".rec-indicator").classList.contains("is-recording"),
      owner != null,
    );
    assert.equal(
      $(".sidebar-indicator")?.getAttribute("aria-label") ?? null,
      owner == null ? null : "Recording",
    );
  });
}

for (const [phase, recording, expected, tone] of [
  ["idle", false, "Not recording F1 25", "neutral"],
  ["candidate", false, "Checking the F1 25 session", "neutral"],
  ["recording", true, "Recording F1 25", "good"],
  ["grace", true, "Recording F1 25 · paused", "good"],
  ["ending", true, "Recording F1 25 · finishing", "good"],
  ["disabled", false, "F1 25 recording is off in this build", "neutral"],
]) {
  test(`F1 ${phase} uses the same recording state in Live and the status detail`, async () => {
    const state = {
      status: { ...f1Recorder(recording), phase },
      available: true,
      error: null,
    };
    assert.deepEqual(f1RecordingPresentation(state), { value: expected, tone });
    await update(f1RecorderStore, state);
    await update(activeGameStore, {
      game: "f1_25",
      fh6: "inactive",
      f1_25: "active",
    });
    await mount(h(ShellHarness));
    assert.match(
      $(".overview-context").textContent,
      new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    const line = [...document.querySelectorAll(".context-state")].find((item) =>
      item.textContent.startsWith("Recording"),
    );
    assert.ok(line.classList.contains(`tone-${tone}`));
    const model = shellStatus({
      live: liveStore.get(),
      recorder: recorderStore.get(),
      setup: setupStore.get(),
      transport: transportStore.get(),
      f1Recorder: state,
      activeGame: activeGameStore.get(),
    });
    assert.deepEqual(
      model.items.find((item) => item.key === "recording"),
      {
        key: "recording",
        label: "Recording",
        value: expected,
        tone,
        glyph: tone === "good" ? "●" : "○",
      },
    );
  });
}

test("F1 recording write and status-read failures expose exact reasons using existing status styles", async () => {
  const state = {
    status: {
      ...f1Recorder(),
      last_error: "Access denied writing samples.rlf1",
    },
    available: true,
    error: null,
  };
  await update(f1RecorderStore, state);
  await update(activeGameStore, {
    game: "f1_25",
    fh6: "inactive",
    f1_25: "active",
  });
  await mount(h(ShellHarness));
  assert.match(
    $(".context-state.tone-bad").textContent,
    /Access denied writing samples\.rlf1/,
  );
  await update(f1RecorderStore, {
    ...state,
    error: "get_f1_recorder_status: connection closed",
  });
  assert.match(
    $(".context-state.tone-warn").textContent,
    /status unavailable: get_f1_recorder_status: connection closed/,
  );
  assert.deepEqual(
    f1RecordingPresentation({ status: null, available: false, error: null }),
    { value: "F1 25 recording unavailable", tone: "neutral" },
  );
});

test("mixed rows name each game, sort deterministically, and obey all three filters", () => {
  const rows = (filter) =>
    multiGameDays(
      [FH6],
      LIST.f1_sessions,
      1_791_030_100_000,
      null,
      null,
      filter,
    ).flatMap((day) => day.rows);
  assert.deepEqual(
    rows("all").map((row) => [row.id, row.gameName]),
    [
      ["fh6-review", "Forza Horizon 6"],
      ["f1-review-race", "F1 25"],
    ],
  );
  assert.deepEqual(
    rows("fh6").map((row) => row.id),
    ["fh6-review"],
  );
  assert.deepEqual(
    rows("f1_25").map((row) => row.id),
    ["f1-review-race"],
  );
  const tied = {
    ...FH6,
    started_at_unix_ms: F1.session.racelab_session.started_at_unix_ms,
  };
  assert.deepEqual(
    multiGameDays([tied], LIST.f1_sessions, 0, null, null).flatMap((day) =>
      day.rows.map((row) => row.id),
    ),
    ["fh6-review", "f1-review-race"],
  );
});

async function controllerEnv() {
  const pending = [];
  const readCalls = [];
  const defer = (name, id) => {
    readCalls.push([name, id]);
    return new Promise((resolve, reject) =>
      pending.push({ name, id, resolve, reject }),
    );
  };
  const clock = manualTimers();
  const controller = createSessionsController(
    {
      listRecent: async () => LIST,
      storageStatus: async () => storage(),
      session: (id) => defer("session", id),
      analysis: (id) => defer("analysis", id),
      f1Session: (id) => defer("f1", id),
      reanalyze: (id) => defer("reanalyze", id),
    },
    clock.timers,
  );
  await controller.refreshList();
  return {
    controller,
    clock,
    pending,
    readCalls,
    state: () => controller.store.get(),
    async reply(name, id, value) {
      const index = pending.findIndex(
        (item) => item.name === name && item.id === id,
      );
      assert.ok(index >= 0);
      pending.splice(index, 1)[0].resolve(value);
      await flush();
    },
  };
}

test("FH6 analysis refresh survives; selecting F1 cancels it and never opens an FH6 lane", async () => {
  const env = await controllerEnv();
  const { controller, clock, state, readCalls } = env;
  await env.reply(
    "analysis",
    "fh6-review",
    analysisState("fh6-review", "queued"),
  );
  assert.equal(clock.pending().length, 1);
  await clock.advance(ANALYSIS_REFRESH_MS);
  assert.deepEqual(readCalls.at(-1), ["analysis", "fh6-review"]);
  await env.reply(
    "analysis",
    "fh6-review",
    analysisState("fh6-review", "analyzing"),
  );
  controller.select("f1-review-race");
  assert.equal(clock.pending().length, 0);
  assert.equal(state().selected.analysis, null);
  assert.equal(state().selected.manifest, null);
  assert.equal(state().selected.analysisLoading, false);
  const before = readCalls.length;
  await controller.reanalyze();
  await clock.advance(10_000);
  assert.equal(readCalls.length, before);
  await env.reply("f1", "f1-review-race", F1);
  assert.equal(
    state().selected.f1.session.racelab_session.session_id,
    "f1-review-race",
  );
  controller.dispose();
});

test("FH6 -> F1 -> FH6 drops old manifest, analysis and F1 detail responses", async () => {
  const env = await controllerEnv();
  env.controller.select("f1-review-race");
  env.controller.select("fh6-review");
  assert.equal(env.state().selected.f1, null);
  await env.reply("session", "fh6-review", { ...FH6, vehicle_id: "old" });
  await env.reply(
    "analysis",
    "fh6-review",
    analysisState("fh6-review", "queued"),
  );
  await env.reply("f1", "f1-review-race", F1);
  assert.equal(env.state().selected.manifest.vehicle_id, FH6.vehicle_id);
  assert.equal(env.state().selected.analysis, null);
  assert.equal(env.state().selected.f1, null);
  assert.equal(env.clock.pending().length, 0);
  await env.reply("session", "fh6-review", { ...FH6, vehicle_id: "current" });
  await env.reply(
    "analysis",
    "fh6-review",
    analysisState("fh6-review", "available"),
  );
  assert.equal(env.state().selected.manifest.vehicle_id, "current");
  assert.equal(env.state().selected.analysis.state, "available");
  env.controller.dispose();
});

test("newest same-selection F1 reply wins and a foreign F1 identity is rejected", async () => {
  const env = await controllerEnv();
  env.controller.select("f1-review-race");
  await env.controller.refreshList();
  const reads = env.pending.filter((item) => item.name === "f1");
  const latest = f1Detail();
  latest.events_total = 99;
  reads[1].resolve(latest);
  await flush();
  reads[0].resolve(F1);
  await flush();
  assert.equal(env.state().selected.f1.events_total, 99);
  await env.controller.refreshList();
  env.pending.at(-1).resolve(f1Detail("foreign"));
  await flush();
  assert.match(env.state().selected.f1Error, /foreign/);
  assert.equal(env.state().selected.f1.events_total, 99);
  env.controller.dispose();
});

test("filters select newest visible deterministically and keep a visible selection", async () => {
  const { controller, state } = await controllerEnv();
  assert.equal(state().selected.id, "fh6-review");
  controller.setFilter("f1_25");
  assert.equal(state().selected.id, "f1-review-race");
  controller.setFilter("all");
  assert.equal(state().selected.id, "f1-review-race");
  controller.setFilter("fh6");
  assert.equal(state().selected.id, "fh6-review");
  controller.dispose();
});

async function sessions(detail = F1) {
  responses.set("list_recent_sessions", () => LIST);
  responses.set("get_f1_session", () => detail);
  await mount(h(ShellHarness));
  await click(
    $$(".sidebar-item").find((item) => item.textContent.includes("Sessions")),
  );
  await click($('[role=option][data-game="f1_25"]'));
}

test("F1 detail has factual Summary, Laps, Events and Data; keyboard switches tabs", async () => {
  await sessions();
  assert.deepEqual(
    $$("[role=tab]").map((tab) => tab.textContent.replace(/\d/g, "").trim()),
    ["Summary", "Laps", "Events", "Data"],
  );
  assert.match($("[role=tabpanel]").textContent, /Silverstone/);
  assert.match($("[role=tabpanel]").textContent, /Finishing position2/);
  assert.match(
    $("[role=tabpanel]").textContent,
    /Best lap \(classification\)1:31\.234/,
  );
  await focus($("#session-tab-summary"));
  await press("ArrowRight");
  assert.equal(document.activeElement.id, "session-tab-laps");
  assert.equal($$("[data-lap]").length, 2);
  assert.match($('[data-lap="1"]').textContent, /1:31\.234/);
  assert.match($('[data-lap="2"]').textContent, /Lap Data \(provisional\)/);
  await press("ArrowRight");
  assert.equal($$("[data-code]").length, 2);
  assert.match($('[data-code="FTLP"]').textContent, /Fastest lap.*you/);
  assert.match($('[data-code="FTLP"]').textContent, /you · 91\.234 s/);
  await press("End");
  assert.equal(document.activeElement.id, "session-tab-data");
  assert.match($("[role=tabpanel]").textContent, /10 Hz/);
  assert.match($("[role=tabpanel]").textContent, /2396549747549880658/);
});

test("F1 Laps and Events empty states state what is missing", async () => {
  const empty = f1Detail();
  empty.laps = null;
  empty.events = [];
  empty.events_total = 0;
  await sessions(empty);
  await click($("#session-tab-laps"));
  assert.equal(
    $(".pane-empty").textContent.trim(),
    "No completed lap was recorded in this session.",
  );
  await click($("#session-tab-events"));
  assert.equal(
    $(".pane-empty").textContent.trim(),
    "No F1 25 event was recorded in this session.",
  );
});

test("F1 recorder ticks update only the recording row, never history/detail/shell", async () => {
  await update(f1RecorderStore, {
    status: f1Recorder(true),
    available: true,
    error: null,
  });
  await sessions();
  resetRenders();
  for (let i = 1; i <= 10; i++)
    await update(f1RecorderStore, {
      status: {
        ...f1Recorder(true),
        revision: i + 1,
        duration_ms: 65_000 + i * 1000,
        samples_written: 650 + i * 10,
      },
      available: true,
      error: null,
    });
  assert.equal(renders.F1RecordingRow, 10);
  for (const name of [
    "SessionsWorkspace",
    "SessionList",
    "SessionDetail",
    "F1SessionDetail",
    "AppShell",
    "Sidebar",
    "TopBar",
  ])
    assert.equal(renders[name] ?? 0, 0, name);
  assert.match($(".recording-row").textContent, /Recording F1 25.*1:15/);
});

test("one shell-level F1 recorder poll survives navigation with no Sessions duplicate", async (t) => {
  const app = fs.readFileSync(
    new URL("../src/App.tsx", import.meta.url),
    "utf8",
  );
  assert.equal((app.match(/useF1RecorderStatus\(\)/g) ?? []).length, 1);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0;
  responses.set("get_f1_recorder_status", () => ({
    ...f1Recorder(),
    revision: ++reads,
  }));
  function OwnerHarness() {
    useF1RecorderStatus();
    return h(ShellHarness);
  }
  const view = await mount(h(OwnerHarness));
  assert.equal(reads, 1);
  await click(
    $$(".sidebar-item").find((item) => item.textContent.includes("Sessions")),
  );
  assert.equal(reads, 1);
  for (let i = 0; i < 4; i++) {
    await act(async () => t.mock.timers.tick(500));
    await settle();
  }
  assert.equal(reads, 5);
  await view.unmount();
  t.mock.timers.tick(5000);
  await settle();
  assert.equal(reads, 5);
  const state = f1RecorderStore.get();
  assert.equal(
    f1RecorderReceived(state, { ...f1Recorder(), revision: 1 }),
    state,
  );
});

test("first run names both games and needs only the game played; completed setup stays hidden", async () => {
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
  await mount(h(ShellHarness));
  assert.match(
    $(".setup-guide").textContent,
    /supports Forza Horizon 6 and F1 25/,
  );
  assert.match($(".setup-guide").textContent, /only need the game you play/);
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
  assert.equal($(".setup-guide"), null);
});

test("filtering to an empty game clears detail and returning selects newest visible", async () => {
  const controller = createSessionsController({
    listRecent: async () => ({ ...LIST, sessions: [] }),
    storageStatus: async () => storage(),
    session: async () => FH6,
    analysis: async () => analysisState("fh6-review", "available"),
    reanalyze: async () => undefined,
    f1Session: async () => F1,
  });
  await controller.refreshList();
  await flush();
  controller.setFilter("fh6");
  assert.equal(controller.store.get().selected, null);
  controller.setFilter("all");
  await flush();
  assert.equal(controller.store.get().selected.id, "f1-review-race");
  controller.dispose();
});

test("the first F1 completion refreshes history once, even when no prior completed ID exists", async () => {
  await update(f1RecorderStore, {
    status: { ...f1Recorder(true), last_completed_session_id: null },
    available: true,
    error: null,
  });
  await sessions();
  const before = calls.filter((call) => call === "list_recent_sessions").length;
  await update(f1RecorderStore, {
    status: f1Recorder(false),
    available: true,
    error: null,
  });
  await settle();
  assert.equal(
    calls.filter((call) => call === "list_recent_sessions").length,
    before + 1,
  );
  await update(f1RecorderStore, {
    status: { ...f1Recorder(false), revision: 2 },
    available: true,
    error: null,
  });
  await settle();
  assert.equal(
    calls.filter((call) => call === "list_recent_sessions").length,
    before + 1,
  );
});

test("F1 Data reports Recording only while the recorder owns that session", async () => {
  const detail = f1Detail();
  detail.session.racelab_session.status = "recording";
  await update(f1RecorderStore, {
    status: f1Recorder(true),
    available: true,
    error: null,
  });
  await sessions(detail);
  await click($("#session-tab-data"));
  const status = () =>
    [...document.querySelectorAll("[role=tabpanel] dt")].find(
      (item) => item.textContent === "Status",
    ).nextElementSibling.textContent;
  assert.equal(status(), "Recording");
  await update(f1RecorderStore, {
    status: { ...f1Recorder(true), session_id: "another-session" },
    available: true,
    error: null,
  });
  assert.equal(status(), "Not finalized");
});
