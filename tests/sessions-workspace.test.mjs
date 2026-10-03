// The Sessions workspace in a DOM: master/detail selection, keyboard and
// focus, out-of-order replies, the analysis refresh and its cleanup, the
// tables, the timeline's text equivalent, and the recorder truth model.
import { calls, renders, resetRenders, responses } from "./support/dom.mjs";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import {
  act,
  cleanup,
  click,
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
import SessionsWorkspace from "../src/workspaces/SessionsWorkspace.tsx";
import { reveal } from "../src/views/sessions/SessionList.tsx";
import { resetSessionsMemory } from "../src/session-controller.ts";
import { recorderStore } from "../src/state/stores.ts";
import {
  analysis,
  analysisState,
  episode,
  event,
  manifest,
  storage,
} from "./support/sessions.mjs";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const options = () => $$("[role=option]");
const selected = () => $("[role=option][aria-selected=true]");
const detail = () => $(".sessions-detail");
const text = () => document.body.textContent;
const count = (command) => calls.filter((name) => name === command).length;

const IDS = ["s-a", "s-b", "s-c"];
const MANIFESTS = IDS.map((id, index) =>
  manifest(id, {
    started_at_unix_ms: 1_800_000_000_000 - index * 3_600_000,
    vehicle_id: `V${index}`,
  }),
);

/// Per-session analysis replies, replaceable by a test.
let analysisReply;

function install({ sessions = MANIFESTS } = {}) {
  resetSessionsMemory();
  installBackend();
  resetStores();
  calls.length = 0;
  responses.set("list_recent_sessions", () => ({
    sessions,
    unreadable: 0,
    directory: "sessions",
    limit: 20,
  }));
  responses.set("get_storage_status", () => storage());
  responses.set("get_session", ({ sessionId }) =>
    sessions.find((item) => item.session_id === sessionId),
  );
  analysisReply = ({ sessionId }) => analysisState(sessionId, "available");
  responses.set("get_session_analysis", (args) => analysisReply(args));
}

test.afterEach(async () => {
  mock.timers.reset();
  await cleanup();
});

async function workspace() {
  return mount(h(SessionsWorkspace, { onOpenSettings: () => {} }));
}

// ------------------------------------------------------- master / detail

test("the list and the selected session sit side by side, newest selected", async () => {
  install();
  await workspace();
  const listbox = $("[role=listbox]");
  assert.ok(listbox, "sessions are a listbox");
  assert.equal(listbox.getAttribute("aria-label"), "Recorded sessions");
  assert.equal(options().length, 3);
  assert.equal(selected().dataset.session, "s-a");
  assert.equal(detail().dataset.session, "s-a");
  // Detail is a sibling of the list, never rendered below its rows.
  assert.ok(!listbox.contains(detail()));
  assert.equal($(".sessions-layout").children.length, 2);
  // Exactly one row is a tab stop: the selected one.
  assert.deepEqual(
    options().map((option) => option.tabIndex),
    [0, -1, -1],
  );
});

test("clicking a row selects it and keeps everything else in place", async () => {
  install();
  await workspace();
  await click(options()[2]);
  await settle();
  assert.equal(selected().dataset.session, "s-c");
  assert.equal(options()[2].getAttribute("aria-selected"), "true");
  assert.equal(options()[0].getAttribute("aria-selected"), "false");
  assert.equal(detail().dataset.session, "s-c");
  assert.match($("#session-title").textContent, /·/);
  assert.match(detail().textContent, /V2/, "C's vehicle in C's header");
});

test("arrow keys move the selection and the focus together", async () => {
  install();
  await workspace();
  await act(async () => options()[0].focus());
  await press("ArrowDown");
  await settle();
  assert.equal(selected().dataset.session, "s-b");
  assert.equal(document.activeElement, options()[1]);
  await press("End");
  await settle();
  assert.equal(document.activeElement.dataset.session, "s-c");
  await press("Home");
  await settle();
  assert.equal(document.activeElement.dataset.session, "s-a");
  await press("ArrowUp");
  assert.equal(selected().dataset.session, "s-a", "stays at the first row");
});

test("each row's accessible name states its facts; the day is a labelled group", async () => {
  install();
  await workspace();
  const label = options()[0].getAttribute("aria-label");
  assert.match(label, /duration 10:00/);
  assert.match(label, /Vehicle V0/);
  const group = options()[0].closest("[role=group]");
  assert.ok(document.getElementById(group.getAttribute("aria-labelledby")));
});

// ------------------------------------------------- out-of-order replies

test("A -> B -> C with replies arriving C, B, A: only C is shown", async () => {
  install();
  const held = new Map();
  analysisReply = ({ sessionId }) =>
    new Promise((resolve) => held.set(sessionId, resolve));
  await workspace();
  // A is selected and its reply is held.
  await click(options()[1]);
  await click(options()[2]);
  assert.equal(detail().dataset.session, "s-c");
  await act(async () => {
    held.get("s-c")(analysisState("s-c", "not_analyzed"));
  });
  await settle();
  await act(async () => {
    held.get("s-b")(analysisState("s-b", "failed"));
    held.get("s-a")(analysisState("s-a", "available"));
  });
  await settle();
  assert.equal(detail().dataset.session, "s-c");
  assert.match($(".lifecycle-pill").textContent, /Analysis: Not analyzed$/);
  assert.ok(!$(".timeline"), "A's analysis is never drawn under C");
});

// ------------------------------------------------- lifecycle and refresh

test("a queued analysis is re-read every 2 s until available, and is announced", async () => {
  install();
  let state = "queued";
  analysisReply = ({ sessionId }) => analysisState(sessionId, state);
  mock.timers.enable({ apis: ["setTimeout"] });
  await workspace();
  await flushMicrotasks();
  const pill = $(".lifecycle-pill");
  assert.equal(pill.getAttribute("role"), "status");
  assert.match(pill.textContent, /Analysis: Queued$/);
  assert.match(text(), /checks this session again every 2 s/);

  const before = count("get_session_analysis");
  await tick(1999);
  assert.equal(count("get_session_analysis"), before);
  state = "analyzing";
  await tick(1);
  assert.equal(count("get_session_analysis"), before + 1);
  assert.match($(".lifecycle-pill").textContent, /Analysis: Analyzing$/);

  state = "available";
  await tick(2000);
  assert.match($(".lifecycle-pill").textContent, /Analysis: Available$/);
  assert.ok($(".timeline"), "the analysis appears without reopening");
  const settled = count("get_session_analysis");
  await tick(20_000);
  assert.equal(count("get_session_analysis"), settled, "refresh stopped");
});

test("leaving Sessions stops the refresh: no read after unmount", async () => {
  install();
  analysisReply = ({ sessionId }) => analysisState(sessionId, "analyzing");
  mock.timers.enable({ apis: ["setTimeout"] });
  const view = await workspace();
  await flushMicrotasks();
  const before = count("get_session_analysis");
  await view.unmount();
  await tick(20_000);
  assert.equal(count("get_session_analysis"), before);
});

test("choosing another session stops the previous one's refresh", async () => {
  install();
  analysisReply = ({ sessionId }) =>
    analysisState(sessionId, sessionId === "s-a" ? "queued" : "available");
  mock.timers.enable({ apis: ["setTimeout"] });
  await workspace();
  await flushMicrotasks();
  await act(async () => options()[1].click());
  await flushMicrotasks();
  const before = count("get_session_analysis");
  await tick(20_000);
  assert.equal(count("get_session_analysis"), before);
});

test("every analysis state has a deliberate panel; re-run only where offered", async () => {
  install();
  for (const [state, title, rerun] of [
    ["not_analyzed", "Not analyzed", false],
    ["failed", "Analysis failed", true],
    ["unsupported_schema", "Unsupported analysis version", true],
  ]) {
    analysisReply = ({ sessionId }) => analysisState(sessionId, state);
    const view = await workspace();
    const panel = $(".analysis-state");
    assert.ok(panel, state);
    assert.match(panel.textContent, new RegExp(title));
    assert.equal(
      $$("button").some((button) => /Re-run analysis/.test(button.textContent)),
      rerun,
      state,
    );
    await view.unmount();
  }
});

// ------------------------------------------------------------- tabs

test("detail tabs follow the tabs pattern and carry analysis counts", async () => {
  install();
  await workspace();
  const tabs = $$("[role=tab]");
  assert.deepEqual(
    tabs.map((tab) => tab.firstChild.textContent),
    ["Summary", "Events", "Turns", "Slip", "Data"],
  );
  assert.equal($("[role=tab][aria-selected=true]").id, "session-tab-summary");
  const panel = $("[role=tabpanel]");
  assert.equal(panel.getAttribute("aria-labelledby"), "session-tab-summary");
  assert.equal(tabs[1].textContent, "Events 3");
  await act(async () => tabs[0].focus());
  await press("ArrowRight");
  assert.equal($("[role=tab][aria-selected=true]").id, "session-tab-events");
  assert.equal(panel.getAttribute("aria-labelledby"), "session-tab-events");
});

test("the tab stays when switching sessions", async () => {
  install();
  await workspace();
  await click($("#session-tab-slip"));
  await click(options()[1]);
  await settle();
  assert.equal($("[role=tab][aria-selected=true]").id, "session-tab-slip");
  assert.equal(detail().dataset.session, "s-b");
});

// ------------------------------------------------------------ tables

test("Events lists start, end, duration, speeds and peak, and filters by kind", async () => {
  install();
  await workspace();
  await click($("#session-tab-events"));
  const rows = $$(".session-events tbody[data-kind] > tr:first-child");
  assert.equal(rows.length, 3);
  const cells = [...rows[0].children].map((cell) => cell.textContent);
  // toggle, event, corner, start, end, duration, speed, peak
  assert.deepEqual(cells.slice(1), [
    "Hard braking",
    "—",
    "1:24.520",
    "1:26.100",
    "1.58 s",
    "144 → 86 km/h",
    "Max brake 100%",
  ]);
  const chip = $$(".chip").find((item) =>
    /Full throttle/.test(item.textContent),
  );
  await click(chip);
  assert.equal(chip.getAttribute("aria-pressed"), "true");
  assert.deepEqual(
    $$(".session-events tbody[data-kind]").map((body) => body.dataset.kind),
    ["full_throttle"],
  );
});

test("a long analysis renders 100 rows at a time and states the rest", async () => {
  install();
  const events = Array.from({ length: 400 }, (_, i) =>
    event("braking", i * 1_000, i * 1_000 + 500),
  );
  analysisReply = ({ sessionId }) =>
    analysisState(sessionId, "available", {
      document: {
        events,
        driving_summary: { events_by_kind: [{ kind: "braking", count: 537 }] },
        data_quality: { events_truncated: 137 },
      },
    });
  await workspace();
  const started = performance.now();
  await click($("#session-tab-events"));
  const firstPaint = performance.now() - started;
  assert.equal($$(".session-events tbody[data-kind]").length, 100);
  assert.match($(".show-more").textContent, /Showing 100 of 400 events/);
  assert.match(
    text(),
    /up to 400 events per event kind.*Braking: 537 counted, 400 listed/,
  );
  await click($(".show-more button"));
  assert.equal($$(".session-events tbody[data-kind]").length, 200);
  // The Summary count includes the events the cap did not store.
  await click($("#session-tab-summary"));
  assert.equal($('[data-kind="braking"] dd').textContent, "537");
  assert.ok(
    firstPaint < 1500,
    `Events tab first paint ${firstPaint.toFixed(0)} ms`,
  );
});

test("Slip expands to all four corners in FL, FR, RL, RR order", async () => {
  install();
  analysisReply = ({ sessionId }) =>
    analysisState(sessionId, "available", {
      document: { slip_episodes: [episode(1, 92_100, 92_720)] },
    });
  await workspace();
  await click($("#session-tab-slip"));
  const toggle = $(".row-toggle");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  await click(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.ok(document.getElementById(toggle.getAttribute("aria-controls")));
  const rows = $$(".corner-table tbody tr").map((row) =>
    [...row.children].map((cell) => cell.textContent),
  );
  assert.deepEqual(rows, [
    ["FL", "No", "—", "—", "—"],
    ["FR", "Yes", "1.11", "-1.11", "1.22"],
    ["RL", "Yes", "3.33", "3.33", "3.44"],
    ["RR", "No", "—", "—", "—"],
  ]);
  for (const banned of [
    /wheelspin/i,
    /lock-?up/i,
    /traction loss/i,
    /excessive/i,
  ]) {
    assert.ok(!banned.test($(".session-slip").textContent), String(banned));
  }
});

// ---------------------------------------------------------- timeline

test("the timeline is not visual-only: counts and a table carry the same facts", async () => {
  install();
  await workspace();
  const svg = $(".timeline svg");
  assert.equal(svg.getAttribute("aria-hidden"), "true");
  const labels = $$(".timeline-lane-label").map((item) => item.textContent);
  assert.ok(labels.includes("Braking1"), labels.join("|"));
  assert.ok(labels.includes("Turn segments2"));
  const table = $(".timeline-table table");
  assert.ok(table.querySelector("caption"));
  const turns = [...table.querySelectorAll("tbody tr")].find(
    (row) => row.querySelector("th").textContent === "Turn segments",
  );
  const cells = [...turns.querySelectorAll("td")].map(
    (cell) => cell.textContent,
  );
  assert.equal(cells.at(-1), "2", "total");
  assert.equal(
    cells.slice(0, -1).reduce((sum, value) => sum + Number(value), 0),
    2,
    "every interval appears in exactly one slice",
  );
});

// ------------------------------------------- recorder and storage

test("a recovered recorder's old error never appears in Sessions", async () => {
  install();
  await update(recorderStore, {
    recorder: recorder({
      status: "recording",
      recording: true,
      last_error: "Could not write frames.rlframes (os error 112)",
    }),
    error: null,
  });
  await mount(h(ShellHarness));
  await click(
    $$(".sidebar-item").find((item) => /Sessions/.test(item.textContent)),
  );
  await settle();
  assert.ok(!/os error 112/.test(text()), "stale error hidden");
  assert.match($(".recording-row").textContent, /Recording now/);
  // The same rule the global status uses: an actual failure is shown.
  await update(recorderStore, {
    recorder: recorder({
      status: "error",
      recording: false,
      last_error: "Could not write frames.rlframes (os error 112)",
    }),
    error: null,
  });
  // An actual failure is stated once — by the global alert, with the
  // backend's words — and not repeated in Sessions.
  assert.equal($(".recording-row"), null);
  assert.match($(".shell-alert-slot").textContent, /Recording failed/);
  assert.match($(".shell-alert-slot").textContent, /os error 112/);
});

test("the storage limit is a setting in Settings, not in Sessions", async () => {
  install();
  await mount(h(ShellHarness));
  await click(
    $$(".sidebar-item").find((item) => /Sessions/.test(item.textContent)),
  );
  await settle();
  assert.equal(count("get_settings"), 0, "Sessions never reads the setting");
  assert.ok(!$(".storage-settings"));
  assert.ok(
    !$$("[aria-pressed]").some((b) => /Keep everything/.test(b.textContent)),
  );
  assert.match($(".storage-usage").textContent, /3\.0 GB of 8\.0 GB/);
  // Its link goes to the one place the limit can change.
  await click(
    $$("button").find((item) => item.textContent === "Storage limit"),
  );
  await settle();
  assert.equal($(".sidebar-item.is-active").textContent, "Settings");
  assert.ok($(".storage-settings"));
});

test("no sessions yet is its own screen", async () => {
  install({ sessions: [] });
  await workspace();
  assert.match(text(), /No sessions yet/);
  assert.ok(!$("[role=listbox]"));
  assert.equal(count("get_session"), 0);
});

test("an interrupted session states its recovery in the header", async () => {
  const interrupted = manifest("s-i", {
    status: "interrupted",
    summary: null,
    recovery: {
      outcome: "truncated",
      scanned_at_unix_ms: 1,
      readable_frame_count: 900,
      readable_active_frame_count: 850,
      readable_duration_us: 15_000_000,
      frame_stream_complete: false,
      unreadable_tail_bytes: 2048,
      detail: null,
      recovered_by_racelab_version: "1.1.0",
    },
  });
  install({ sessions: [interrupted] });
  await workspace();
  assert.match($(".session-header .badge").textContent, /Interrupted/);
  assert.match(
    $(".inline-alert.tone-warn").textContent,
    /900 frames were recovered/,
  );
  assert.match(selected().textContent, /Interrupted · 900 frames recovered/);
});

// ------------------------------------------------- render isolation

test("a refresh reply re-renders the detail, never the list", async () => {
  install();
  analysisReply = ({ sessionId }) => analysisState(sessionId, "queued");
  mock.timers.enable({ apis: ["setTimeout"] });
  await workspace();
  await flushMicrotasks();
  resetRenders();
  await tick(2000);
  await tick(2000);
  assert.ok(renders.SessionDetail >= 1);
  assert.equal(renders.SessionList ?? 0, 0);
  assert.equal(renders.SessionsWorkspace ?? 0, 0);
});

// ------------------------------------------------------- review fixes

test("integrity facts are read out with their values, never as 'unavailable'", async () => {
  install();
  analysisReply = ({ sessionId }) =>
    analysisState(sessionId, "available", {
      document: {
        data_quality: {
          frame_stream_complete: false,
          speed_discontinuities: 3,
        },
      },
    });
  await workspace();
  await click($("#session-tab-data"));
  for (const [key, value] of [
    ["stream", "Incomplete (no footer)"],
    ["discontinuities", "3"],
  ]) {
    const fact = $(`[data-fact="${key}"]`);
    assert.ok(fact.classList.contains("is-attention"), key);
    assert.ok(!fact.classList.contains("is-unavailable"), key);
    const dd = fact.querySelector("dd");
    assert.equal(dd.textContent, value, "the value, and only the value");
    assert.equal(dd.querySelector("[aria-hidden]"), null, "nothing hidden");
  }
});

test("a failed analysis read clears aria-busy", async () => {
  install();
  analysisReply = () => {
    throw new Error("IPC closed");
  };
  await workspace();
  assert.equal(detail().getAttribute("aria-busy"), "false");
  assert.match($(".lifecycle-pill").textContent, /Unavailable$/);
});

test("aria-busy is true only while the first reads are outstanding", async () => {
  install();
  let release;
  analysisReply = ({ sessionId }) =>
    new Promise((resolve) => {
      release = () => resolve(analysisState(sessionId, "not_analyzed"));
    });
  await workspace();
  assert.equal(detail().getAttribute("aria-busy"), "true");
  await act(async () => release());
  await settle();
  assert.equal(detail().getAttribute("aria-busy"), "false");
});

test("the cap note and threshold copy say only what the analysis establishes", async () => {
  install();
  analysisReply = ({ sessionId }) =>
    analysisState(sessionId, "available", {
      document: {
        events: [event("braking", 0, 100)],
        driving_summary: { events_by_kind: [{ kind: "braking", count: 9 }] },
        data_quality: { events_truncated: 8 },
        slip_episodes: [episode(1, 92_100, 92_720)],
      },
    });
  await workspace();
  assert.match(text(), /up to 400 events per event kind/);
  assert.ok(!/across all kinds|in total/.test(text()));
  await click($("#session-tab-events"));
  assert.match(
    $(".inline-alert").textContent,
    /One kind passed that limit — Braking: 9 counted, 1 listed/,
  );
  assert.ok(!/lists every threshold/.test(text()));
  assert.match(text(), /described under Definitions in the Data tab/);
  await click($("#session-tab-slip"));
  assert.ok(!/stayed above/.test(text()));
  await click($(".row-toggle"));
  assert.ok(
    $$(".corner-table th").some((th) => th.textContent === "Crossed threshold"),
  );
  assert.ok(
    !$$(".corner-table th").some((th) => /Over threshold/.test(th.textContent)),
  );
});

test("no stored events reads as no event meeting its definition", async () => {
  install();
  analysisReply = ({ sessionId }) =>
    analysisState(sessionId, "available", { document: { events: [] } });
  await workspace();
  await click($("#session-tab-events"));
  assert.match(text(), /met its RaceLab definition/);
  assert.ok(!/crossed a RaceLab threshold in this session/.test(text()));
});

test("reveal scrolls a container by exactly the cut-off distance, else not at all", () => {
  const container = document.createElement("div");
  const element = document.createElement("div");
  const rect = (top, bottom) => () => ({ top, bottom });
  container.getBoundingClientRect = rect(100, 300);
  for (const [top, bottom, expected] of [
    [150, 200, 0], // fully visible: untouched
    [80, 130, -20], // cut off at the top
    [280, 330, 30], // cut off at the bottom
    [120, 520, 20], // taller than the box: its top is kept in view
  ]) {
    container.scrollTop = 0;
    let scrolled = 0;
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      get: () => scrolled,
      set: (value) => {
        scrolled = value;
      },
    });
    element.getBoundingClientRect = rect(top, bottom);
    reveal(container, element);
    assert.equal(scrolled, expected, `${top}-${bottom}`);
  }
});

test("the UI treats max_events per kind: several kinds, more stored than the cap", async () => {
  install();
  analysisReply = ({ sessionId }) =>
    analysisState(sessionId, "available", {
      document: {
        config: { ...analysis().config, max_events: 2 },
        events: [
          event("braking", 0, 100),
          event("braking", 200, 300),
          event("full_throttle", 400, 500),
          event("full_throttle", 600, 700),
          event("hard_braking", 800, 900),
        ],
        driving_summary: {
          events_by_kind: [
            { kind: "braking", count: 6 },
            { kind: "full_throttle", count: 2 },
            { kind: "hard_braking", count: 1 },
          ],
        },
        data_quality: { events_truncated: 4 },
      },
    });
  await workspace();
  // Summary counts are the detected totals, per kind.
  assert.equal($('[data-kind="braking"] dd').textContent, "6");
  assert.equal($('[data-kind="full_throttle"] dd').textContent, "2");
  const note = $(".session-summary .panel-footnote:last-child").textContent;
  assert.match(note, /up to 2 events per event kind/);
  assert.match(note, /Braking: 6 counted, 2 listed/);
  assert.ok(!/Full throttle|Hard braking|in total|all kinds/.test(note), note);
  // The Events tab lists all five stored rows, beyond max_events, by kind.
  await click($("#session-tab-events"));
  assert.equal($$(".session-events tbody[data-kind]").length, 5);
  assert.deepEqual(
    $$(".chip").map((chip) => chip.textContent),
    ["All 5", "Full throttle 2", "Braking 2", "Hard braking 1"],
  );
});

// ---------------------------------------------------------- helpers

async function flushMicrotasks() {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

async function tick(ms) {
  await act(async () => {
    mock.timers.tick(ms);
  });
  await flushMicrotasks();
}
