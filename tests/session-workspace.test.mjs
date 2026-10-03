// The Sessions workspace view model: rows, header, lifecycle, summary
// figures, the Data tab and the recorder row. Field preservation and
// semantic honesty are asserted here, against the backend shapes.
import test from "node:test";
import assert from "node:assert/strict";
import {
  analysisFacts,
  analysisFigures,
  completionReason,
  dayLabel,
  eventCapNote,
  kindCounts,
  lifecycle,
  listNotices,
  recorderRow,
  recordingFacts,
  segmentCounts,
  sessionBadges,
  sessionDays,
  sessionFigures,
  sessionHeader,
  storageUsage,
  tabCounts,
  technicalFacts,
} from "../src/session-workspace.ts";
import { eventRow, slipEpisodeRow, turnRow } from "../src/analysis-state.ts";
import { UNAVAILABLE, grouped } from "../src/telemetry/formatting.ts";
import {
  analysis,
  analysisState,
  episode,
  event,
  manifest,
  segment,
  storage,
} from "./support/sessions.mjs";

const local = (y, m, d, h = 12, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();
const NOW = local(2026, 10, 2, 15, 0);

function recorderStatus(overrides = {}) {
  return {
    revision: 1,
    status: "idle",
    recording: false,
    sessions_directory: "sessions",
    session_id: null,
    session_directory: null,
    game: null,
    vehicle_id: null,
    started_at_unix_ms: null,
    duration_ms: 0,
    frames_written: 0,
    active_frames: 0,
    inactive_frames: 0,
    queued_frames: 0,
    recorder_dropped_frames: 0,
    lifetime_dropped_frames: 0,
    queue_capacity: 4096,
    last_completed_session_id: null,
    completed_sessions: 0,
    last_error: null,
    ...overrides,
  };
}

/// Every string a view model produced, flattened, for wording checks.
function strings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(strings);
  }
  return [];
}

// ------------------------------------------------------------------ list

test("sessions group by local day, newest first, whatever the input order", () => {
  const days = sessionDays(
    [
      manifest("old", { started_at_unix_ms: local(2026, 9, 28, 9) }),
      manifest("today-1", { started_at_unix_ms: local(2026, 10, 2, 9) }),
      manifest("yesterday", { started_at_unix_ms: local(2026, 10, 1, 21) }),
      manifest("today-2", { started_at_unix_ms: local(2026, 10, 2, 14) }),
      manifest("unknown", { started_at_unix_ms: null }),
    ],
    NOW,
    null,
  );
  assert.deepEqual(
    days.map((day) => [day.label, day.rows.map((row) => row.id)]),
    [
      ["Today", ["today-2", "today-1"]],
      ["Yesterday", ["yesterday"]],
      [dayLabel(local(2026, 9, 28, 9), NOW), ["old"]],
      ["Date unknown", ["unknown"]],
    ],
  );
});

test("a row carries time, duration and vehicle, and names every fact", () => {
  const [day] = sessionDays(
    [manifest("s", { started_at_unix_ms: local(2026, 10, 2, 14, 32) })],
    NOW,
    null,
  );
  const row = day.rows[0];
  assert.equal(row.duration, "10:00");
  assert.equal(row.vehicle, "Vehicle 3421");
  assert.deepEqual(row.badges, [], "a normal completed session has no badge");
  assert.match(row.label, /Today/);
  assert.match(row.label, /duration 10:00/);
  assert.match(row.label, /Vehicle 3421/);
});

test("row badges state interruption, recovery, finalization and drops — nothing else", () => {
  const interrupted = sessionBadges(
    manifest("i", {
      status: "interrupted",
      summary: null,
      recovery: {
        outcome: "truncated",
        scanned_at_unix_ms: 1,
        readable_frame_count: 14_220,
        readable_active_frame_count: 14_000,
        readable_duration_us: 237_000_000,
        frame_stream_complete: false,
        unreadable_tail_bytes: 4096,
        detail: null,
        recovered_by_racelab_version: "1.1.0",
      },
    }),
    null,
  );
  assert.equal(interrupted[0].tone, "warn");
  assert.equal(
    interrupted[0].label,
    `Interrupted · ${grouped(14_220)} frames recovered`,
  );

  const live = sessionBadges(manifest("r", { status: "recording" }), "r");
  assert.deepEqual(
    live.map((badge) => [badge.label, badge.tone]),
    [["Recording", "rec"]],
  );
  const stale = sessionBadges(manifest("r", { status: "recording" }), "other");
  assert.equal(stale[0].label, "Not finalized");

  const dropped = sessionBadges(
    manifest("d", { recorder_dropped_frames: 37 }),
    null,
  );
  assert.deepEqual(
    dropped.map((badge) => badge.label),
    ["37 dropped"],
  );
  assert.equal(dropped.at(-1).tone, "bad");
});

test("the list header shows storage use, not the storage setting", () => {
  assert.deepEqual(storageUsage(storage()), {
    text: "3.0 GB of 8.0 GB",
    fraction: 3 / 8,
  });
  assert.equal(
    storageUsage(storage({ retention: { enabled: false } })).fraction,
    null,
  );
  assert.equal(storageUsage(null), null);
});

test("list notices: over budget, recovery progress and unreadable folders", () => {
  const notices = listNotices(
    { sessions: [], unreadable: 2, directory: "s", limit: 20 },
    storage({
      retention: { over_budget: true },
      recovery: { pending: 1, scanned: 3, recovered_frames: 900 },
    }),
  );
  const keys = notices.map((notice) => notice.key);
  assert.deepEqual(keys, ["retention", "recovery", "recovered", "unreadable"]);
  assert.equal(notices[0].tone, "warn");
  assert.match(notices[0].text, /Over the limit/);
  assert.match(notices[3].text, /2 session folder/);
  assert.deepEqual(listNotices(null, storage()), [], "quiet when all is well");
});

// ---------------------------------------------------- recorder truth model

test("a stale recorder error is not shown once the recorder has recovered", () => {
  for (const status of ["recording", "idle"]) {
    const row = recorderRow({
      recorder: recorderStatus({
        status,
        recording: status === "recording",
        last_error: "Could not write frames.rlframes (os error 112)",
      }),
      error: null,
    });
    for (const text of strings(row)) {
      assert.ok(
        !/os error 112|Could not write/.test(text),
        `${status}: ${text}`,
      );
    }
    if (row) assert.notEqual(row.tone, "bad");
  }
});

test("a recorder in error leaves no Sessions row: the global alert says it once", () => {
  const row = recorderRow({
    recorder: recorderStatus({
      status: "error",
      last_error: "Could not write frames.rlframes",
    }),
    error: null,
  });
  assert.equal(row, null);
});

test("recording shows a ticking duration and current-session drops", () => {
  const row = recorderRow({
    recorder: recorderStatus({
      status: "recording",
      recording: true,
      session_id: "now",
      vehicle_id: "3421",
      duration_ms: 125_000,
      recorder_dropped_frames: 3,
    }),
    error: null,
  });
  assert.equal(row.title, "Recording now");
  assert.equal(row.duration, "2:05");
  assert.equal(row.drops, 3);
  assert.equal(recorderRow({ recorder: recorderStatus(), error: null }), null);
});

test("a failure to read the recorder says so instead of guessing", () => {
  const row = recorderRow({ recorder: null, error: "IPC closed" });
  assert.equal(row.title, "Recorder status unavailable");
  assert.equal(row.detail, "IPC closed");
});

// --------------------------------------------------------------- header

test("the header shows the manifest's facts without schema or version jargon", () => {
  const header = sessionHeader(manifest("s"), NOW, null);
  assert.deepEqual(
    header.facts.map((item) => [item.label, item.value]),
    [
      ["Duration", "10:00"],
      ["Vehicle", "3421"],
      ["Game", "Forza Horizon 6"],
      ["Frames", grouped(36_000)],
      ["Recorder drops", "0"],
    ],
  );
  assert.equal(header.status.label, "Completed");
  assert.deepEqual(header.alerts, []);
  for (const text of strings(header)) {
    assert.ok(!/schema|version|v\d/i.test(text), text);
  }
});

test("interrupted and dropped sessions carry the existing recovery and loss sentences", () => {
  const header = sessionHeader(
    manifest("s", {
      status: "interrupted",
      summary: null,
      recorder_dropped_frames: 12,
      recovery: null,
    }),
    NOW,
    null,
  );
  assert.equal(header.status.label, "Interrupted");
  assert.deepEqual(
    header.alerts.map((alert) => alert.key),
    ["recovery", "drops"],
  );
  assert.match(header.alerts[0].detail, /has not been checked/);
  assert.match(header.alerts[1].detail, /12 frames were dropped/);
});

// ------------------------------------------------------------- lifecycle

test("every analysis state has its own pill, tone and sentence", () => {
  const views = {
    loading: lifecycle(null, null),
    error: lifecycle(null, "IPC closed"),
    queued: lifecycle(analysisState("s", "queued"), null),
    analyzing: lifecycle(analysisState("s", "analyzing"), null),
    available: lifecycle(analysisState("s", "available"), null),
    not_analyzed: lifecycle(analysisState("s", "not_analyzed"), null),
    failed: lifecycle(analysisState("s", "failed"), null),
    unsupported: lifecycle(
      analysisState("s", "unsupported_schema", { analysis_schema_version: 3 }),
      null,
    ),
  };
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(views).map(([key, view]) => [
        key,
        [view.short, view.tone],
      ]),
    ),
    {
      loading: ["Loading", "neutral"],
      error: ["Unavailable", "bad"],
      queued: ["Queued", "neutral"],
      analyzing: ["Analyzing", "neutral"],
      available: ["Available", "good"],
      not_analyzed: ["Not analyzed", "neutral"],
      failed: ["Failed", "bad"],
      unsupported: ["Unsupported", "warn"],
    },
  );
  const details = new Set(Object.values(views).map((view) => view.detail));
  assert.equal(
    details.size,
    Object.keys(views).length,
    "no two states read alike",
  );
  // The UI refreshes now; it no longer tells the user to reopen the session.
  assert.ok(!/reopen/i.test(views.analyzing.detail));
  assert.ok(!/schema v/i.test(views.available.detail));
});

// -------------------------------------------------------------- summary

test("summary figures come from the manifest, with unavailable kept unavailable", () => {
  const figures = sessionFigures(manifest("s"));
  const by = Object.fromEntries(figures.map((item) => [item.key, item]));
  assert.equal(by.distance.value, "21.40 km");
  assert.equal(by["max-speed"].value, "241.3 km/h");
  assert.equal(by.throttle.value, "220.0 s · 36.7%");
  assert.equal(by["gear-changes"].value, UNAVAILABLE);
  assert.equal(by["gear-changes"].available, false);
  // No summary at all (interrupted): every figure unavailable, none zero.
  for (const item of sessionFigures(manifest("s", { summary: null }))) {
    assert.equal(item.value, UNAVAILABLE, item.label);
  }
});

test("analysis figures surface the values V1.0 computed but never showed", () => {
  const by = Object.fromEntries(
    analysisFigures(analysis()).map((item) => [item.key, item.value]),
  );
  assert.equal(by.analyzed, "1:58 of 2:00");
  assert.equal(by["max-accel"], "+7.5\u00a0m/s² · +0.76\u00a0g");
  // Deceleration keeps its stored, negative sign.
  assert.equal(by["max-decel"], "−9.3\u00a0m/s² · −0.94\u00a0g");
  assert.equal(by["hard-braking"], "3.5 s");
  assert.equal(by["slip-time"], "0.6 s");
});

test("a channel that was not recorded is unavailable, never a zero", () => {
  const doc = analysis({
    data_quality: {
      suspension_available: false,
      wheel_telemetry_available: false,
      orientation_available: false,
      speed_available: false,
    },
  });
  const kinds = Object.fromEntries(
    kindCounts(doc).map((kind) => [kind.kind, kind.text]),
  );
  assert.equal(kinds.high_suspension_compression, UNAVAILABLE);
  assert.equal(kinds.strong_acceleration, UNAVAILABLE);
  assert.equal(kinds.braking, "0", "controls were recorded: a real zero");
  assert.deepEqual(
    segmentCounts(doc).map((item) => item.text),
    [UNAVAILABLE, UNAVAILABLE],
  );
  const figures = Object.fromEntries(
    analysisFigures(doc).map((item) => [item.key, item.value]),
  );
  assert.equal(figures["max-accel"], UNAVAILABLE);
  assert.equal(figures["slip-time"], UNAVAILABLE);
  assert.deepEqual(tabCounts(doc), { events: "3" });
});

test("event counts include what the cap did not store, and say how many were stored", () => {
  const doc = analysis({
    driving_summary: {
      events_by_kind: [{ kind: "braking", count: 412 }],
    },
    events: [event("braking", 0, 100), event("braking", 200, 300)],
    data_quality: { events_truncated: 410 },
  });
  const braking = kindCounts(doc).find((kind) => kind.kind === "braking");
  assert.equal(braking.count, 412);
  assert.equal(braking.stored, 2);
  assert.equal(braking.text, "412");
});

test("no summary or count is worded as a judgement", () => {
  const banned =
    /\b(good|bad|aggressive|smooth|poor|optimal|wheelspin|lock-?up|traction loss|excessive|understeer|oversteer|apex|racing line|score|grade)\b/i;
  const doc = analysis();
  const all = strings([
    sessionFigures(manifest("s")),
    analysisFigures(doc),
    kindCounts(doc),
    segmentCounts(doc),
    recordingFacts(manifest("s")),
    analysisFacts(analysisState("s", "available")),
    doc.events.map(eventRow),
    doc.turn_segments.map(turnRow),
    doc.slip_episodes.map(slipEpisodeRow),
  ]);
  for (const text of all) assert.ok(!banned.test(text), text);
});

// ------------------------------------------------- field preservation

test("event rows keep start, end, duration, speeds and the defining peak", () => {
  const row = eventRow(
    event("hard_braking", 84_520, 86_100, {
      entry_speed_mps: 40,
      exit_speed_mps: 24,
      min_speed_mps: 23,
      max_speed_mps: 41,
      speed_change_mps: -16,
      max_rpm: 6100,
      peak: 0.92,
    }),
    0,
  );
  assert.equal(row.label, "Hard braking");
  assert.equal(row.start, "1:24.520");
  assert.equal(row.end, "1:26.100");
  assert.equal(row.duration, "1.58 s");
  assert.equal(row.speed, "144 → 86 km/h");
  assert.equal(row.detail, "Max brake 92%");
  assert.deepEqual(
    row.facts.map((item) => [item.label, item.value]),
    [
      ["Entry speed", "144 km/h"],
      ["Exit speed", "86 km/h"],
      ["Min speed", "83 km/h"],
      ["Max speed", "148 km/h"],
      ["Speed change", "-57.6 km/h"],
      ["Max RPM", "6100"],
      ["Peak combined slip", UNAVAILABLE],
    ],
  );
});

test("turn rows keep every persisted field and all four corners, in order", () => {
  const row = turnRow(segment(4, 20_000, 23_400));
  assert.equal(row.index, 4);
  assert.equal(row.start, "0:20.000");
  assert.equal(row.end, "0:23.400");
  assert.equal(row.yawChange, "90°");
  assert.equal(row.meanYawRate, "0.60 rad/s");
  assert.equal(row.peakYawRate, "0.90 rad/s");
  assert.equal(row.throttleTime, "1.75 s");
  assert.deepEqual(
    row.cornerTable.map((corner) => [
      corner.corner,
      corner.maxAbsSlipRatio,
      corner.maxCombinedSlip,
      corner.maxCompression,
    ]),
    [
      ["FL", "0.40", "0.50", "0.97"],
      ["FR", "0.40", "0.50", "0.60"],
      ["RL", "0.40", "0.50", "0.60"],
      ["RR", "1.25", "1.30", "0.60"],
    ],
  );
});

test("slip rows map FL/FR/RL/RR canonically and keep each corner's own peaks", () => {
  const row = slipEpisodeRow(episode(3, 92_100, 92_720));
  assert.equal(row.cornerCodes, "FR RL", "canonical order, affected only");
  assert.equal(row.corners, "Front right, Rear left");
  assert.equal(row.peakSlipRatio, "3.33");
  assert.equal(row.peakCombined, "3.44");
  assert.equal(row.engagedTime, "0.62 s");
  assert.deepEqual(
    row.cornerTable.map((corner) => [
      corner.corner,
      corner.affected,
      corner.maxAbsSlipRatio,
      corner.signedPeakSlipRatio,
      corner.maxCombinedSlip,
    ]),
    [
      ["FL", false, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE],
      ["FR", true, "1.11", "-1.11", "1.22"],
      ["RL", true, "3.33", "3.33", "3.44"],
      ["RR", false, UNAVAILABLE, UNAVAILABLE, UNAVAILABLE],
    ],
  );
  // The backend's corner order in `corners` does not reorder the table.
  const reversed = slipEpisodeRow(
    episode(3, 0, 100, { corners: ["rear_left", "front_right"] }),
  );
  assert.equal(reversed.cornerCodes, "FR RL");
});

// ------------------------------------------------------------ data tab

test("the Data tab keeps recording, recovery and technical metadata", () => {
  const recovered = manifest("s", {
    status: "interrupted",
    summary: null,
    completion_reason: "interrupted_racelab_did_not_finalize",
    recovery: {
      outcome: "damaged",
      scanned_at_unix_ms: 1,
      readable_frame_count: 900,
      readable_active_frame_count: 850,
      readable_duration_us: 15_000_000,
      frame_stream_complete: false,
      unreadable_tail_bytes: 2048,
      detail: "checksum mismatch at record 901",
      recovered_by_racelab_version: "1.1.0",
    },
  });
  const groups = recordingFacts(recovered);
  assert.deepEqual(
    groups.map((group) => group.key),
    ["recording", "recovery"],
  );
  const recovery = Object.fromEntries(
    groups[1].facts.map((item) => [item.key, item.value]),
  );
  assert.equal(recovery.outcome, "damaged");
  assert.equal(recovery.readable, "900");
  assert.equal(recovery.tail, "2.0 KB");
  assert.equal(recovery.detail, "checksum mismatch at record 901");
  assert.equal(
    groups[0].facts.find((item) => item.key === "reason").value,
    "RaceLab did not finalize the recording",
  );

  const technical = technicalFacts(recovered, analysisState("s", "available"));
  const by = Object.fromEntries(
    technical.facts.map((item) => [item.key, item.value]),
  );
  assert.equal(by.id, "s");
  assert.equal(by["created-by"], "1.0.0");
  assert.equal(by["recovered-by"], "1.1.0");
  assert.equal(by["analysis-schema"], "v2 (this build reads v2)");
  // Machine strings only; no filesystem path is exposed.
  for (const text of strings(technical)) {
    assert.ok(!/[\\/]|\.rlframes|analysis\.json/.test(text), text);
  }
});

test("analysis facts include the truncation counters and job timing", () => {
  const groups = analysisFacts(
    analysisState("s", "available", {
      queued_ms: 42_000,
      analysis_duration_ms: 1_170,
      document: {
        data_quality: {
          events_truncated: 5,
          slip_episodes_truncated: 2,
          turn_segments_truncated: 1,
        },
      },
    }),
  );
  const facts = Object.fromEntries(
    groups
      .flatMap((group) => group.facts)
      .map((item) => [item.key, item.value]),
  );
  assert.equal(facts.queued, "42 s");
  assert.equal(facts.duration, "1.2 s");
  assert.equal(facts.truncated, "5");
  assert.equal(facts["slip-truncated"], "2");
  assert.equal(facts["turns-truncated"], "1");
  assert.deepEqual(analysisFacts(null), []);
});

test("completion reasons read as sentences; an unknown one is kept verbatim", () => {
  assert.equal(
    completionReason("vehicle_or_game_changed"),
    "Vehicle or game changed",
  );
  assert.equal(completionReason("something_new"), "something_new");
  assert.equal(completionReason(null), UNAVAILABLE);
});

// ------------------------------------------------------- review fixes

test("integrity facts stay facts: flagged values are attention, never unavailable", () => {
  const groups = analysisFacts(
    analysisState("s", "available", {
      document: {
        data_quality: {
          frame_stream_complete: false,
          speed_discontinuities: 3,
          events_truncated: 5,
          slip_episodes_truncated: 2,
          suspension_available: false,
        },
      },
    }),
  );
  const facts = Object.fromEntries(
    groups.flatMap((group) => group.facts).map((item) => [item.key, item]),
  );
  for (const [key, value] of [
    ["stream", "Incomplete (no footer)"],
    ["discontinuities", "3"],
    ["truncated", "5"],
    ["slip-truncated", "2"],
    ["suspension", "Unavailable"],
  ]) {
    assert.equal(facts[key].value, value, key);
    assert.equal(facts[key].available, true, `${key} has a value to read`);
    assert.equal(facts[key].attention, true, `${key} is flagged`);
  }
  assert.equal(facts.frames.attention, false);
  assert.equal(facts["turns-truncated"].attention, false);
});

test("the event cap is per event kind, never one global cap", () => {
  // max_events 2, applied per kind as `push_event` applies it: braking
  // passed its own limit; full throttle sits exactly at it; hard braking is
  // under it. Five rows are stored in all — more than max_events — which a
  // global cap could never produce.
  const doc = analysis({
    events: [
      event("braking", 0, 100),
      event("braking", 200, 300),
      event("full_throttle", 400, 500),
      event("full_throttle", 600, 700),
      event("hard_braking", 800, 900),
    ],
    driving_summary: {
      events_by_kind: [
        { kind: "braking", count: 7 },
        { kind: "full_throttle", count: 2 },
        { kind: "hard_braking", count: 1 },
      ],
    },
    data_quality: { events_truncated: 5 },
    config: { ...analysis().config, max_events: 2 },
  });
  const note = eventCapNote(doc);
  assert.match(note, /^RaceLab stores up to 2 events per event kind\./);
  assert.match(
    note,
    /One kind passed that limit — Braking: 7 counted, 2 listed\./,
  );
  assert.ok(
    !/Full throttle|Hard braking/.test(note),
    "only the kind over its limit",
  );
  assert.ok(!/in total|across all kinds|all kinds/i.test(note), note);

  // Two kinds over their own limits are each named with their own figures.
  const two = eventCapNote(
    analysis({
      events: [
        event("braking", 0, 100),
        event("braking", 200, 300),
        event("full_throttle", 400, 500),
        event("full_throttle", 600, 700),
      ],
      driving_summary: {
        events_by_kind: [
          { kind: "braking", count: 4 },
          { kind: "full_throttle", count: 9 },
        ],
      },
      data_quality: { events_truncated: 9 },
      config: { ...analysis().config, max_events: 2 },
    }),
  );
  assert.match(
    two,
    /2 kinds passed that limit — Full throttle: 9 counted, 2 listed; Braking: 4 counted, 2 listed\./,
  );

  // More stored rows than max_events, nothing omitted: no note at all. A
  // global reading of the cap would wrongly call this capped.
  const many = analysis({
    events: [
      event("braking", 0, 100),
      event("full_throttle", 200, 300),
      event("hard_braking", 400, 500),
    ],
    config: { ...analysis().config, max_events: 2 },
  });
  assert.equal(eventCapNote(many), null);
  assert.equal(eventCapNote(analysis()), null);
});
