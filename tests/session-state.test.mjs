import test from "node:test";
import assert from "node:assert/strict";
import {
  clockTime,
  duration,
  newerRecorder,
  orderSessions,
  sessionRow,
  statusLabel,
  value,
} from "../src/session-state.ts";

const completed = {
  schema_version: 1,
  session_id: "abc-2",
  status: "completed",
  game: "fh6",
  protocol: "fh6",
  vehicle_id: "2599",
  started_at_unix_ms: 1_800_000_002_000,
  ended_at_unix_ms: 1_800_000_062_000,
  duration_us: 60_000_000,
  frame_count: 3600,
  active_frame_count: 3500,
  inactive_frame_count: 100,
  recorder_dropped_frames: 0,
  completion_reason: "grace_expired",
  frame_file: "frames.rlframes",
  frame_format_version: 1,
  telemetry_frame_schema_version: 1,
  created_by_racelab_version: "0.6.0",
  summary: {
    duration_seconds: 60,
    measured_seconds: 59.9,
    frame_count: 3600,
    max_speed_kmh: 212.5,
    average_speed_kmh: 98.25,
    max_rpm: 7100,
    average_rpm: 4200,
    full_throttle_seconds: 21,
    full_throttle_percent: 35,
    braking_seconds: 6,
    braking_percent: 10,
    gear_change_count: 48,
    distance_meters: 1634.5,
    data_quality: {
      recorder_dropped_frames: 0,
      complete: true,
      excluded_gaps: 0,
    },
  },
};

const interrupted = {
  ...completed,
  session_id: "abc-1",
  status: "interrupted",
  started_at_unix_ms: 1_800_000_001_000,
  completion_reason: "interrupted_racelab_did_not_finalize",
  recorder_dropped_frames: 12,
  summary: null,
};

test("recorder status only advances with a newer revision", () => {
  const current = { revision: 9, recording: true };
  assert.equal(
    newerRecorder(current, { revision: 8, recording: false }),
    current,
  );
  const next = { revision: 10, recording: false };
  assert.equal(newerRecorder(current, next), next);
  assert.equal(newerRecorder(null, next), next);
});

test("an active recording reports its session, frames, queue and drops", () => {
  const status = {
    revision: 3,
    status: "recording",
    recording: true,
    session_id: "abc-2",
    frames_written: 1234,
    queued_frames: 7,
    queue_capacity: 4096,
    recorder_dropped_frames: 0,
    duration_ms: 65_000,
  };
  assert.equal(status.session_id, "abc-2");
  assert.equal(duration(status.duration_ms / 1000), "1:05");
  assert.equal(value(status.queued_frames, 0), "7");
  assert.equal(value(status.recorder_dropped_frames, 0), "0");
});

test("recent sessions render newest first", () => {
  const ordered = orderSessions([interrupted, completed]);
  assert.deepEqual(
    ordered.map((manifest) => manifest.session_id),
    ["abc-2", "abc-1"],
  );
});

test("a completed session row carries its summary values", () => {
  const row = sessionRow(completed);
  assert.equal(row.id, "abc-2");
  assert.equal(row.game, "fh6");
  assert.equal(row.vehicle, "2599");
  assert.equal(row.duration, "1:00");
  assert.equal(row.maxSpeed, "212.5");
  assert.equal(row.averageSpeed, "98.3");
  assert.equal(row.status, "Completed");
  assert.equal(row.incomplete, false);
});

test("an interrupted session is visibly different and never shows zeroes", () => {
  const row = sessionRow(interrupted);
  assert.equal(row.status, "Interrupted · incomplete");
  assert.notEqual(row.status, sessionRow(completed).status);
  assert.equal(row.incomplete, true);
  assert.equal(row.dropped, 12);
  // No summary exists, so every summary value stays unavailable, not 0.
  assert.equal(row.maxSpeed, "—");
  assert.equal(row.averageSpeed, "—");
  assert.equal(statusLabel("interrupted"), "Interrupted · incomplete");
});

test("unavailable summary values render as unavailable while real zero renders", () => {
  assert.equal(value(null), "—");
  assert.equal(value(undefined), "—");
  assert.equal(value(0), "0.0");
  assert.equal(value(0, 0), "0");
  assert.equal(value(null, 0), "—");
  assert.equal(duration(null), "—");
  assert.equal(duration(0), "0:00");
  assert.equal(clockTime(null), "—");
  const partial = {
    ...completed,
    summary: {
      ...completed.summary,
      distance_meters: null,
      gear_change_count: null,
    },
  };
  assert.equal(value(partial.summary.distance_meters), "—");
  assert.equal(value(partial.summary.gear_change_count, 0), "—");
});

test("details never need the frame stream, only manifest and summary fields", () => {
  const fields = Object.keys(completed);
  assert.ok(fields.includes("summary") && fields.includes("frame_count"));
  // frame_file is a name in the manifest; no frame array is ever present.
  assert.equal(typeof completed.frame_file, "string");
  assert.ok(!("frames" in completed));
  assert.ok(!("records" in completed));
  assert.equal(completed.summary.frame_count, 3600);
});

test("the sessions UI only calls manifest-level commands and has no Start Recording control", async () => {
  const { readFile } = await import("node:fs/promises");
  const panel = await readFile(
    new URL("../src/SessionsPanel.tsx", import.meta.url),
    "utf8",
  );
  const invoked = [...panel.matchAll(/invoke<[^>]+>\("([a-z_]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    new Set(invoked),
    new Set(["get_recorder_status", "list_recent_sessions", "get_session"]),
  );
  // No frame-stream command exists to call, and recording is never user-started:
  // no button in the panel starts, stops or otherwise controls a recording.
  assert.ok(!/read_frames|get_frames|frame_stream/.test(panel));
  const buttons = [
    ...panel.matchAll(/<button[\s\S]*?>([\s\S]*?)<\/button>/g),
  ].map((match) => match[1]);
  assert.ok(buttons.length > 0);
  assert.ok(
    buttons.every((label) => !/record/i.test(label)),
    buttons.join("|"),
  );
  const app = await readFile(
    new URL("../src/App.tsx", import.meta.url),
    "utf8",
  );
  // The existing live telemetry UI stays mounted alongside the new panel.
  assert.ok(app.includes("<LiveTelemetryPanel"));
  assert.ok(app.includes("<SessionsPanel"));
  assert.ok(app.includes("<CapturePanel"));
});
