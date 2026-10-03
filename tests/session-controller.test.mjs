// The Sessions data controller: request identity, out-of-order replies, the
// bounded 2 s analysis refresh, and cleanup. Every reply is released by hand,
// in the order each test chooses, and timers advance only when told to.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ANALYSIS_REFRESH_MS,
  RECENT_LIMIT,
  createSessionsController,
  foreignAnalysis,
  resetSessionsMemory,
} from "../src/session-controller.ts";
import {
  analysisState,
  flush,
  manifest,
  manualTimers,
  scriptedBackend,
  storage,
} from "./support/sessions.mjs";

const LIST = {
  sessions: [
    manifest("s-a", { started_at_unix_ms: 3_000 }),
    manifest("s-b", { started_at_unix_ms: 2_000 }),
    manifest("s-c", { started_at_unix_ms: 1_000 }),
  ],
  unreadable: 0,
  directory: "sessions",
  limit: 20,
};

function setup() {
  resetSessionsMemory();
  const script = scriptedBackend();
  const clock = manualTimers();
  const controller = createSessionsController(script.backend, clock.timers);
  return { script, clock, controller, state: () => controller.store.get() };
}

/// Opens the workspace: one listing, auto-selecting the newest session.
async function opened() {
  const env = setup();
  void env.controller.refreshList();
  await env.script.reply("listRecent", RECENT_LIMIT, LIST);
  await env.script.reply("storageStatus", null, storage());
  return env;
}

// ------------------------------------------------------ list and selection

test("opening lists the 20 newest and selects the newest session", async () => {
  const { script, state } = await opened();
  assert.equal(script.calls[0].name, "listRecent");
  assert.equal(script.calls[0].id, 20, "the V1.0 list limit is kept");
  assert.equal(state().selected.id, "s-a");
  // The listed manifest is shown at once; a fresh read is in flight.
  assert.equal(state().selected.manifest.session_id, "s-a");
  assert.equal(state().selected.manifestLoading, true);
  assert.deepEqual(
    script.open().map((item) => `${item.name}:${item.id}`),
    ["session:s-a", "analysis:s-a"],
  );
});

test("selecting the session already shown does nothing", async () => {
  const { script, controller } = await opened();
  const before = script.calls.length;
  controller.select("s-a");
  assert.equal(script.calls.length, before);
});

test("an empty listing is loaded, not loading, and selects nothing", async () => {
  const { script, controller, state } = setup();
  void controller.refreshList();
  assert.equal(state().list.loaded, false);
  await script.reply("listRecent", 20, { ...LIST, sessions: [] });
  await script.reply("storageStatus", null, storage());
  assert.equal(state().list.loaded, true);
  assert.equal(state().selected, null);
});

test("a failed storage read never blocks the listing", async () => {
  const { script, controller, state } = setup();
  void controller.refreshList();
  await script.reply("listRecent", 20, LIST);
  await script.fail("storageStatus", null, "busy");
  assert.equal(state().list.recent.sessions.length, 3);
  assert.equal(state().list.storage, null);
  assert.equal(state().list.error, null);
});

test("a late listing reply never replaces a newer one", async () => {
  const { script, controller, state } = setup();
  void controller.refreshList(); // #1
  void controller.refreshList(); // #2
  const [list1, list2] = script.open("listRecent");
  const [storage1, storage2] = script.open("storageStatus");
  // #2 answers first with the newer listing…
  const newer = { ...LIST, sessions: LIST.sessions.slice(0, 1) };
  list2.resolve(newer);
  storage2.resolve(storage());
  await flush();
  // …then #1 arrives late with the older one.
  list1.resolve(LIST);
  storage1.resolve(storage());
  await flush();
  assert.equal(state().list.recent.sessions.length, 1);
});

// ------------------------------------------------- out-of-order protection

test("A -> B -> C: late replies for A and B never reach C", async () => {
  const { script, controller, state } = await opened(); // A selected
  controller.select("s-b");
  controller.select("s-c");
  assert.equal(state().selected.id, "s-c");

  // C answers first.
  await script.reply("session", "s-c", manifest("s-c", { vehicle_id: "C" }));
  await script.reply("analysis", "s-c", analysisState("s-c", "not_analyzed"));
  // Then A and B, late, in reverse order.
  await script.reply("analysis", "s-b", analysisState("s-b", "available"));
  await script.reply("session", "s-b", manifest("s-b", { vehicle_id: "B" }));
  await script.reply("analysis", "s-a", analysisState("s-a", "failed"));
  await script.reply("session", "s-a", manifest("s-a", { vehicle_id: "A" }));

  const selected = state().selected;
  assert.equal(selected.id, "s-c");
  assert.equal(selected.manifest.vehicle_id, "C");
  assert.equal(selected.analysis.session_id, "s-c");
  assert.equal(selected.analysis.state, "not_analyzed");
});

test("A -> B: A's late failure does not mark B as failed", async () => {
  const { script, controller, state } = await opened();
  controller.select("s-b");
  await script.fail("analysis", "s-a", "A is unreadable");
  await script.fail("session", "s-a", "A is gone");
  assert.equal(state().selected.analysisError, null);
  assert.equal(state().selected.manifestError, null);
  assert.equal(state().selected.analysis, null, "B is still loading");
});

test("switching shows only the new session's data until its replies arrive", async () => {
  const { script, controller, state } = await opened();
  await script.reply("session", "s-a", manifest("s-a"));
  await script.reply("analysis", "s-a", analysisState("s-a", "available"));
  controller.select("s-b");
  const selected = state().selected;
  assert.equal(selected.id, "s-b");
  assert.equal(selected.manifest.session_id, "s-b", "the listed copy of B");
  assert.equal(selected.analysis, null, "never A's analysis under B");
});

test("a reply naming another session is refused, not shown", async () => {
  const { script, state } = await opened();
  await script.reply("analysis", "s-a", analysisState("s-b", "available"));
  assert.equal(state().selected.analysis, null);
  assert.match(state().selected.analysisError, /s-b/);
  await script.reply("session", "s-a", manifest("s-b"));
  assert.equal(state().selected.manifest.session_id, "s-a");
  assert.match(state().selected.manifestError, /s-b/);
});

// ----------------------------------------------------- 2 s analysis refresh

for (const pending of ["queued", "analyzing"]) {
  test(`an analysis that is ${pending} is read again every 2 s`, async () => {
    const { script, clock, state } = await opened();
    await script.reply("session", "s-a", manifest("s-a"));
    await script.reply("analysis", "s-a", analysisState("s-a", pending));
    assert.equal(state().selected.refreshing, true);
    assert.equal(clock.pending().length, 1);
    assert.equal(clock.pending()[0].ms, ANALYSIS_REFRESH_MS);
    assert.equal(ANALYSIS_REFRESH_MS, 2000);

    await clock.advance(1999);
    assert.equal(script.open("analysis").length, 0, "not before 2 s");
    await clock.advance(1);
    assert.equal(script.open("analysis").length, 1);
    // Only the selected session is read; the manifest is not polled.
    assert.equal(script.open("analysis")[0].id, "s-a");
    assert.equal(script.open("session").length, 0);
  });
}

test("queued -> analyzing -> available: each state shown, refresh stops at available", async () => {
  const { script, clock, state } = await opened();
  await script.reply("session", "s-a", manifest("s-a"));
  await script.reply("analysis", "s-a", analysisState("s-a", "queued"));
  assert.equal(state().selected.analysis.state, "queued");

  await clock.advance(2000);
  await script.reply("analysis", "s-a", analysisState("s-a", "analyzing"));
  assert.equal(state().selected.analysis.state, "analyzing");
  assert.equal(state().selected.refreshing, true);

  await clock.advance(2000);
  await script.reply("analysis", "s-a", analysisState("s-a", "available"));
  assert.equal(state().selected.analysis.state, "available");
  assert.equal(state().selected.refreshing, false);
  assert.equal(clock.pending().length, 0, "no further refresh scheduled");
  await clock.advance(10_000);
  assert.equal(script.open("analysis").length, 0);
});

for (const terminal of [
  "available",
  "failed",
  "unsupported_schema",
  "not_analyzed",
]) {
  test(`the refresh stops at ${terminal}`, async () => {
    const { script, clock, state } = await opened();
    await script.reply("analysis", "s-a", analysisState("s-a", "queued"));
    await clock.advance(2000);
    await script.reply("analysis", "s-a", analysisState("s-a", terminal));
    assert.equal(state().selected.refreshing, false);
    assert.equal(clock.pending().length, 0);
  });
}

test("a terminal state on first read never starts a refresh", async () => {
  const { script, clock } = await opened();
  await script.reply("analysis", "s-a", analysisState("s-a", "available"));
  assert.equal(clock.pending().length, 0);
});

test("refresh reads never overlap: the next is scheduled only after a reply", async () => {
  const { script, clock } = await opened();
  await script.reply("analysis", "s-a", analysisState("s-a", "queued"));
  await clock.advance(2000);
  assert.equal(script.open("analysis").length, 1);
  // The backend is slow: much more than 2 s pass with the read in flight.
  await clock.advance(10_000);
  assert.equal(script.open("analysis").length, 1, "still exactly one");
  assert.equal(clock.pending().length, 0, "nothing scheduled meanwhile");
  await script.reply("analysis", "s-a", analysisState("s-a", "queued"));
  assert.equal(clock.pending().length, 1);
});

test("changing the selection stops the previous session's refresh", async () => {
  const { script, clock, controller } = await opened();
  await script.reply("analysis", "s-a", analysisState("s-a", "analyzing"));
  assert.equal(clock.pending().length, 1);
  controller.select("s-b");
  assert.equal(clock.pending().length, 0, "A's timer is cleared");
  await clock.advance(10_000);
  assert.ok(
    !script.open("analysis").some((item) => item.id === "s-a"),
    "A is never read again",
  );
});

test("a refresh reply that arrives after switching is dropped and schedules nothing", async () => {
  const { script, clock, controller, state } = await opened();
  await script.reply("analysis", "s-a", analysisState("s-a", "queued"));
  await clock.advance(2000); // A's refresh read is now in flight
  controller.select("s-b");
  await script.reply("analysis", "s-a", analysisState("s-a", "queued"));
  assert.equal(state().selected.id, "s-b");
  assert.equal(state().selected.analysis, null);
  assert.equal(clock.pending().length, 0, "no timer for a hidden session");
});

test("dispose stops the refresh and drops every reply still in flight", async () => {
  const { script, clock, controller, state } = await opened();
  await script.reply("analysis", "s-a", analysisState("s-a", "queued"));
  controller.dispose();
  assert.equal(clock.pending().length, 0);
  const before = state();
  await script.reply("session", "s-a", manifest("s-a", { vehicle_id: "late" }));
  await clock.advance(10_000);
  assert.equal(state(), before, "nothing changes after dispose");
  assert.equal(script.open("analysis").length, 0);
});

test("a failed refresh read stops the refresh and shows the failure", async () => {
  const { script, clock, state } = await opened();
  await script.reply("analysis", "s-a", analysisState("s-a", "queued"));
  await clock.advance(2000);
  await script.fail("analysis", "s-a", "IPC closed");
  assert.match(state().selected.analysisError, /IPC closed/);
  assert.equal(state().selected.refreshing, false);
  assert.equal(clock.pending().length, 0);
});

// ------------------------------------------------------------- re-run

test("re-run asks the backend, then follows the queued job with the refresh", async () => {
  const { script, clock, controller, state } = await opened();
  await script.reply("analysis", "s-a", analysisState("s-a", "failed"));
  void controller.reanalyze();
  assert.equal(state().selected.reanalyzing, true);
  await script.reply("reanalyze", "s-a", { running: true });
  assert.equal(state().selected.reanalyzing, false);
  await script.reply("analysis", "s-a", analysisState("s-a", "queued"));
  assert.equal(state().selected.analysis.state, "queued");
  assert.equal(clock.pending().length, 1);
});

test("a refused re-run keeps the analysis and shows why", async () => {
  const { script, controller, state } = await opened();
  await script.reply("analysis", "s-a", analysisState("s-a", "failed"));
  void controller.reanalyze();
  await script.fail("reanalyze", "s-a", "already queued");
  assert.equal(state().selected.analysis.state, "failed");
  assert.match(state().selected.reanalyzeError, /already queued/);
});

test("a re-run reply for a session no longer selected is ignored", async () => {
  const { script, controller, state } = await opened();
  await script.reply("analysis", "s-a", analysisState("s-a", "failed"));
  void controller.reanalyze();
  controller.select("s-b");
  await script.reply("reanalyze", "s-a", { running: true });
  assert.equal(state().selected.id, "s-b");
  assert.equal(script.open("analysis").filter((i) => i.id === "s-a").length, 0);
});

// --------------------------------------------- recording completes

test("a completed recording re-reads the list and the selected session", async () => {
  const { script, controller, state } = await opened();
  await script.reply("session", "s-a", manifest("s-a"));
  await script.reply("analysis", "s-a", analysisState("s-a", "not_analyzed"));
  void controller.refreshList();
  await script.reply("listRecent", 20, LIST);
  await script.reply("storageStatus", null, storage());
  // Same selection, refreshed in place.
  assert.equal(state().selected.id, "s-a");
  assert.deepEqual(
    script.open().map((item) => `${item.name}:${item.id}`),
    ["session:s-a", "analysis:s-a"],
  );
  await script.reply("analysis", "s-a", analysisState("s-a", "queued"));
  assert.equal(state().selected.analysis.state, "queued");
});

test("while the refresh runs, a list refresh does not add a second analysis read", async () => {
  const { script, clock, controller } = await opened();
  await script.reply("analysis", "s-a", analysisState("s-a", "queued"));
  void controller.refreshList();
  await script.reply("listRecent", 20, LIST);
  await script.reply("storageStatus", null, storage());
  assert.equal(script.open("analysis").length, 0);
  assert.equal(clock.pending().length, 1);
});

// ------------------------------------------------------------ memory

test("returning to Sessions reopens the same session on the same tab", async () => {
  const first = await opened();
  first.controller.select("s-c");
  first.controller.setTab("slip");
  first.controller.dispose();

  // A new controller, as when the workspace mounts again — not reset.
  const script = scriptedBackend();
  const controller = createSessionsController(
    script.backend,
    manualTimers().timers,
  );
  assert.equal(controller.store.get().tab, "slip");
  void controller.refreshList();
  await script.reply("listRecent", 20, LIST);
  await script.reply("storageStatus", null, storage());
  assert.equal(controller.store.get().selected.id, "s-c");
});

// ------------------------------------- review fixes: identity, lane, loading

test("an analysis whose embedded document names another session is refused", async () => {
  const { script, state } = await opened();
  const reply = analysisState("s-a", "available");
  reply.analysis.session_id = "s-b"; // state says A, document says B
  await script.reply("analysis", "s-a", reply);
  assert.equal(state().selected.analysis, null, "B's document never shown");
  assert.match(state().selected.analysisError, /belongs to session s-b/);
  assert.equal(state().selected.analysisLoading, false);
  assert.equal(foreignAnalysis(reply, "s-a"), state().selected.analysisError);
  assert.equal(foreignAnalysis(analysisState("s-a", "available"), "s-a"), null);
  assert.equal(foreignAnalysis(analysisState("s-a", "queued"), "s-a"), null);
});

test("a failed first read settles loading, so nothing stays busy", async () => {
  const { script, state } = await opened();
  assert.equal(state().selected.analysisLoading, true);
  await script.fail("analysis", "s-a", "IPC closed");
  assert.equal(state().selected.analysisLoading, false);
  assert.equal(state().selected.analysis, null);
  assert.match(state().selected.analysisError, /IPC closed/);
});

/// Invariants checked after every step of an interleaving.
function invariant(script, clock, where) {
  assert.ok(
    script.open("analysis").length <= 1,
    `${where}: ${script.open("analysis").length} analysis reads in flight`,
  );
  assert.ok(
    clock.pending().length <= 1,
    `${where}: ${clock.pending().length} refresh timers`,
  );
  assert.ok(
    !(script.open("analysis").length === 1 && clock.pending().length === 1),
    `${where}: a timer is pending while a read is in flight`,
  );
}

test("re-run while a refresh read is in flight: no overlap, no stale timer, final read after the re-run", async () => {
  const { script, clock, controller, state } = await opened();
  await script.reply("analysis", "s-a", analysisState("s-a", "queued"));
  await clock.advance(2000); // refresh read #2 in flight
  invariant(script, clock, "refresh in flight");

  void controller.reanalyze();
  invariant(script, clock, "re-run requested");
  assert.equal(clock.pending().length, 0, "no timer while re-running");

  // The old refresh read answers "queued" while the re-run is outstanding:
  // it is shown, but it must not schedule a timer.
  await script.reply("analysis", "s-a", analysisState("s-a", "queued"));
  invariant(script, clock, "old read settled");
  assert.equal(clock.pending().length, 0, "no stale timer");
  assert.equal(script.open("analysis").length, 0);
  await clock.advance(10_000);
  assert.equal(script.open("analysis").length, 0, "nothing fires meanwhile");

  await script.reply("reanalyze", "s-a", { running: true });
  invariant(script, clock, "re-run returned");
  const reads = script.calls.filter((call) => call.name === "analysis");
  const rerun = script.calls.findIndex((call) => call.name === "reanalyze");
  assert.ok(
    script.calls.indexOf(reads.at(-1)) > rerun,
    "the last read was issued after the re-run request",
  );
  await script.reply("analysis", "s-a", analysisState("s-a", "analyzing"));
  invariant(script, clock, "follow-up settled");
  assert.equal(state().selected.analysis.state, "analyzing");
  assert.equal(clock.pending().length, 1, "exactly one refresh timer");
});

test("re-run requested while the first read is still loading reads again only after it", async () => {
  const { script, clock, controller, state } = await opened();
  void controller.reanalyze();
  await script.reply("reanalyze", "s-a", { running: true });
  invariant(script, clock, "re-run returned during first read");
  assert.equal(script.open("analysis").length, 1, "still the one first read");
  await script.reply("analysis", "s-a", analysisState("s-a", "failed"));
  // The first read's reply is superseded by a follow-up, issued now.
  assert.equal(script.open("analysis").length, 1);
  assert.equal(clock.pending().length, 0);
  await script.reply("analysis", "s-a", analysisState("s-a", "queued"));
  assert.equal(state().selected.analysis.state, "queued");
  assert.equal(clock.pending().length, 1);
});

test("a list refresh during an in-flight read is folded into one follow-up read", async () => {
  const { script, clock, controller } = await opened();
  await script.reply("session", "s-a", manifest("s-a"));
  // The first analysis read is still in flight.
  void controller.refreshList();
  await script.reply("listRecent", 20, LIST);
  await script.reply("storageStatus", null, storage());
  invariant(script, clock, "list refreshed mid-read");
  await script.reply("analysis", "s-a", analysisState("s-a", "not_analyzed"));
  invariant(script, clock, "first read settled");
  assert.equal(script.open("analysis").length, 1, "one follow-up read");
  await script.reply("analysis", "s-a", analysisState("s-a", "not_analyzed"));
  assert.equal(script.open("analysis").length, 0);
  assert.equal(clock.pending().length, 0);
});

test("a refused re-run of a pending analysis resumes the single refresh", async () => {
  const { script, clock, controller, state } = await opened();
  await script.reply("analysis", "s-a", analysisState("s-a", "queued"));
  void controller.reanalyze();
  assert.equal(clock.pending().length, 0);
  await script.fail("reanalyze", "s-a", "already queued");
  invariant(script, clock, "refused");
  assert.match(state().selected.reanalyzeError, /already queued/);
  assert.equal(script.open("analysis").length, 1, "refresh resumed");
  await script.reply("analysis", "s-a", analysisState("s-a", "queued"));
  assert.equal(clock.pending().length, 1);
});

test("a scripted storm of requests never overlaps reads or stacks timers", async () => {
  const { script, clock, controller } = await opened();
  const steps = [
    () => script.reply("analysis", "s-a", analysisState("s-a", "queued")),
    () => clock.advance(2000),
    () => void controller.refreshList(),
    () => script.reply("listRecent", 20, LIST),
    () => script.reply("storageStatus", null, storage()),
    () => void controller.reanalyze(),
    () => void controller.reanalyze(), // ignored: one re-run at a time
    () => script.reply("analysis", "s-a", analysisState("s-a", "analyzing")),
    () => clock.advance(5000),
    () => script.reply("reanalyze", "s-a", { running: true }),
    () => script.reply("analysis", "s-a", analysisState("s-a", "queued")),
    () => clock.advance(2000),
    () => script.reply("analysis", "s-a", analysisState("s-a", "available")),
    () => clock.advance(20_000),
  ];
  for (const [index, step] of steps.entries()) {
    await step();
    await flush();
    invariant(script, clock, `step ${index}`);
  }
  assert.equal(
    script.calls.filter((call) => call.name === "reanalyze").length,
    1,
  );
  assert.equal(clock.pending().length, 0, "available: refresh stopped");
});
