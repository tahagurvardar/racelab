import test from "node:test";
import assert from "node:assert/strict";
import {
  analysisBanner,
  analysisJobLines,
  channelNote,
  drivingEventRows,
  eventRow,
  EVENT_LABELS,
  heuristicNotes,
  qualityLines,
  slipEpisodeRow,
  slipEpisodeRows,
  suspensionEventRows,
  turnRow,
  turnRows,
} from "../src/analysis-state.ts";
import { UNAVAILABLE } from "../src/telemetry/formatting.ts";

// The analysis document as `src-tauri/src/analysis.rs` serializes it. Every
// field is present, so a view-model change that starts depending on a field
// that does not exist fails here rather than in the app.

const config = {
  max_gap_ms: 1000,
  min_event_ms: 80,
  full_throttle_enter: 0.95,
  full_throttle_exit: 0.9,
  braking_enter: 0.05,
  braking_exit: 0.02,
  hard_braking_enter: 0.8,
  hard_braking_exit: 0.7,
  throttle_lift_window_ms: 250,
  throttle_lift_from: 0.8,
  throttle_lift_to: 0.2,
  throttle_lift_cooldown_ms: 500,
  acceleration_window_ms: 250,
  max_plausible_acceleration_mps2: 50,
  strong_acceleration_enter_mps2: 4,
  strong_acceleration_exit_mps2: 3,
  strong_deceleration_enter_mps2: -6,
  strong_deceleration_exit_mps2: -4.5,
  slip_ratio_enter: 1,
  slip_ratio_exit: 0.7,
  combined_slip_enter: 1,
  combined_slip_exit: 0.7,
  slip_min_ms: 120,
  slip_merge_gap_ms: 400,
  suspension_compression_enter: 0.95,
  suspension_compression_exit: 0.9,
  suspension_extension_enter: 0.05,
  suspension_extension_exit: 0.1,
  suspension_min_ms: 250,
  suspension_merge_gap_ms: 150,
  turn_min_speed_mps: 5,
  turn_yaw_rate_enter_rad_s: 0.2,
  turn_yaw_rate_exit_rad_s: 0.1,
  turn_exit_hold_ms: 250,
  turn_min_duration_ms: 600,
  turn_min_abs_yaw_change_rad: 0.2,
  max_events: 400,
  max_slip_episodes: 200,
  max_turn_segments: 200,
};

function episode(index, start_ms, end_ms, overrides = {}) {
  return {
    index,
    start_ms,
    end_ms,
    duration_ms: end_ms - start_ms,
    engaged_seconds: (end_ms - start_ms) / 1000,
    corners: ["rear_left", "rear_right"],
    families: ["slip_ratio", "combined_slip"],
    entry_speed_mps: 40,
    min_speed_mps: 24,
    max_speed_mps: 40,
    exit_speed_mps: 24,
    max_abs_slip_ratio: {
      front_left: null,
      front_right: null,
      rear_left: 75.46,
      rear_right: 76.01,
    },
    signed_peak_slip_ratio: {
      front_left: null,
      front_right: null,
      rear_left: 75.46,
      rear_right: -76.01,
    },
    max_combined_slip: {
      front_left: null,
      front_right: null,
      rear_left: 75.61,
      rear_right: 76.11,
    },
    peak_abs_slip_ratio: 76.01,
    peak_combined_slip: 76.11,
    ...overrides,
  };
}

function event(kind, start_ms, end_ms, overrides = {}) {
  return {
    kind,
    corner: null,
    start_ms,
    end_ms,
    duration_ms: end_ms - start_ms,
    entry_speed_mps: 40,
    exit_speed_mps: 24,
    min_speed_mps: 24,
    max_speed_mps: 40,
    speed_change_mps: -16,
    max_rpm: 6100,
    peak: 1,
    signed_peak: 1,
    peak_combined_slip: null,
    ...overrides,
  };
}

const corners = (value) => ({
  front_left: value,
  front_right: value,
  rear_left: value,
  rear_right: value,
});

function segment(index, start_ms, end_ms, overrides = {}) {
  return {
    index,
    start_ms,
    end_ms,
    duration_ms: end_ms - start_ms,
    signed_yaw_change_rad: 1.5707963267948966,
    mean_yaw_rate_rad_s: 0.6,
    peak_yaw_rate_rad_s: 0.9,
    entry_speed_mps: 40,
    min_speed_mps: 22,
    exit_speed_mps: 31,
    max_speed_mps: 40,
    average_speed_mps: 28,
    brake_seconds: 0.5,
    throttle_seconds: 1.75,
    full_throttle_seconds: 1,
    max_brake: 0.9,
    max_abs_slip_ratio: { ...corners(0.4), rear_right: 1.25 },
    max_combined_slip: { ...corners(0.5), rear_right: 1.3 },
    max_suspension_compression: { ...corners(0.6), front_left: 0.97 },
    ...overrides,
  };
}

function analysis(overrides = {}) {
  return {
    schema_version: 2,
    session_id: "abc-1",
    telemetry_frame_schema_version: 2,
    analyzed_at_unix_ms: 1_800_000_100_000,
    requested_at_unix_ms: 1_800_000_045_000,
    queued_ms: 53_700,
    analysis_duration_ms: 1_170,
    analyzed_by_racelab_version: "0.8.0",
    config,
    coverage: {
      first_monotonic_ms: 500,
      last_monotonic_ms: 120_500,
      recorded_seconds: 120,
      analyzed_seconds: 118.5,
      excluded_gap_count: 1,
      excluded_gap_seconds: 1.2,
      inactive_interval_count: 2,
      inactive_interval_seconds: 0.3,
    },
    driving_summary: {
      event_count: 3,
      slip_episode_count: 1,
      slip_episode_seconds: 0.62,
      turn_segment_count: 2,
      events_by_kind: [],
      full_throttle_seconds: 31.5,
      braking_seconds: 12.25,
      hard_braking_seconds: 3.5,
      max_speed_mps: 61,
      max_longitudinal_acceleration_mps2: 7.5,
      max_longitudinal_deceleration_mps2: -9.25,
    },
    events: [
      event("hard_braking", 84_520, 86_100, { peak: 1, signed_peak: 1 }),
      event("full_throttle", 87_300, 91_900, {
        entry_speed_mps: 25.28,
        exit_speed_mps: 45.56,
        speed_change_mps: 20.28,
      }),
      event("high_suspension_extension", 93_000, 93_400, {
        corner: "front_left",
        peak: 0.02,
        signed_peak: 0.02,
      }),
    ],
    slip_episodes: [episode(1, 92_100, 92_720)],
    turn_segments: [segment(1, 20_000, 23_400), segment(2, 60_000, 62_800)],
    data_quality: {
      telemetry_frame_schema_version: 2,
      frames_read: 8_640,
      active_frames: 8_500,
      inactive_frames: 140,
      zero_interval_frames: 3,
      speed_discontinuities: 0,
      frame_stream_complete: true,
      speed_available: true,
      controls_available: true,
      engine_available: true,
      orientation_available: true,
      wheel_telemetry_available: true,
      suspension_available: true,
      events_truncated: 0,
      slip_episodes_truncated: 0,
      turn_segments_truncated: 0,
      slip_ratio_detector_events: 82,
      combined_slip_detector_events: 138,
    },
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    session_id: "abc-1",
    state: "available",
    analysis: analysis(),
    analysis_schema_version: 2,
    supported_analysis_schema_version: 2,
    message: null,
    file: "analysis.json",
    queued_ms: null,
    analysis_duration_ms: null,
    failure_reason: null,
    can_reanalyze: true,
    ...overrides,
  };
}

// ------------------------------------------------------------------ states

test("an available analysis is shown", () => {
  const banner = analysisBanner(state());
  assert.equal(banner.state, "available");
  assert.equal(banner.showAnalysis, true);
  assert.equal(banner.problem, false);
});

test("a queued analysis says it is waiting, not that it is being worked on", () => {
  const banner = analysisBanner(
    state({ state: "queued", analysis: null, queued_ms: 42_000 }),
  );
  assert.equal(banner.state, "queued");
  assert.equal(banner.showAnalysis, false);
  assert.equal(banner.problem, false);
  // The wait is stated, which is what stops a queue looking like a hang.
  assert.match(banner.detail, /waiting/i);
  assert.match(banner.detail, /42 s/);
  // The recording is already safe, and says so.
  assert.match(banner.detail, /already saved/i);
  // Nothing is offered to press: it is already on its way.
  assert.equal(banner.offerReanalysis, false);
});

test("a queued analysis and one being analyzed are different states", () => {
  const queued = analysisBanner(state({ state: "queued", analysis: null }));
  const analyzing = analysisBanner(
    state({ state: "analyzing", analysis: null }),
  );
  assert.notEqual(queued.state, analyzing.state);
  assert.notEqual(queued.headline, analyzing.headline);
  assert.match(analyzing.detail, /being analyzed/i);
  assert.equal(analyzing.problem, false);
  assert.equal(analyzing.offerReanalysis, false);
});

test("a short wait is not reported as a number", () => {
  const banner = analysisBanner(
    state({ state: "queued", analysis: null, queued_ms: 300 }),
  );
  assert.ok(!/300/.test(banner.detail), banner.detail);
  assert.deepEqual(analysisJobLines(state({ queued_ms: 300 })), []);
});

test("an unanalyzed session never reads as an analysis that found nothing", () => {
  const banner = analysisBanner(
    state({ state: "not_analyzed", analysis: null }),
  );
  assert.equal(banner.showAnalysis, false);
  assert.match(banner.headline, /Not analyzed/);
  // The distinction is stated outright, because it is the whole point.
  assert.match(
    banner.detail,
    /not the same as an analysis that found no events/i,
  );
  // And no rows are produced from a missing analysis.
  assert.deepEqual(drivingEventRows(null), []);
  assert.deepEqual(turnRows(null), []);
  assert.deepEqual(qualityLines(null), []);
});

test("a failed analysis says so and offers to run again", () => {
  const banner = analysisBanner(
    state({
      state: "failed",
      analysis: null,
      failure_reason: "Could not analyze the frame stream: unexpected end",
    }),
  );
  assert.equal(banner.state, "failed");
  assert.equal(banner.showAnalysis, false);
  assert.equal(banner.problem, true);
  // A failure is never presented as an absence.
  assert.ok(!/Not analyzed/.test(banner.headline), banner.headline);
  assert.match(banner.detail, /unexpected end/);
  assert.match(banner.detail, /recording itself is unaffected/i);
  assert.equal(banner.offerReanalysis, true);
});

test("a failed analysis on an unreadable recording is not offered a re-run", () => {
  const banner = analysisBanner(
    state({ state: "failed", analysis: null, can_reanalyze: false }),
  );
  assert.equal(banner.problem, true);
  assert.equal(banner.offerReanalysis, false);
});

test("an unsupported analysis schema names both versions", () => {
  const banner = analysisBanner(
    state({
      state: "unsupported_schema",
      analysis: null,
      analysis_schema_version: 9,
      supported_analysis_schema_version: 1,
    }),
  );
  assert.equal(banner.showAnalysis, false);
  assert.equal(banner.problem, true);
  assert.match(banner.detail, /v9/);
  assert.match(banner.detail, /v1/);
  // It can be regenerated, and the offer is made.
  assert.equal(banner.offerReanalysis, true);
});

test("a read failure is a failed state, not an empty analysis", () => {
  const banner = analysisBanner(
    null,
    "Session analysis read failed: disk error",
  );
  assert.equal(banner.state, "failed");
  assert.equal(banner.showAnalysis, false);
  assert.equal(banner.problem, true);
  assert.match(banner.detail, /disk error/);
  assert.equal(banner.offerReanalysis, false);
});

test("job diagnostics are bounded to wait and duration", () => {
  const lines = analysisJobLines(
    state({ queued_ms: 125_000, analysis_duration_ms: 2_400 }),
  );
  assert.deepEqual(
    lines.map((line) => line.label),
    ["Waited in queue", "Analysis took"],
  );
  assert.equal(lines[0].value, "2 min 5 s");
  assert.equal(lines[1].value, "2.4 s");
  // Nothing internal leaks: no queue depth, no worker, no thread.
  const text = JSON.stringify(lines);
  assert.ok(!/queue_capacity|pending|thread|worker/i.test(text), text);
});

test("no job diagnostics exist before a job does", () => {
  assert.deepEqual(analysisJobLines(null), []);
});

test("no state is fabricated before the first read completes", () => {
  const banner = analysisBanner(null);
  assert.equal(banner.showAnalysis, false);
  assert.match(banner.headline, /Loading/);
});

// -------------------------------------------------------- event formatting

test("an event renders as a reading, not a log line", () => {
  const row = eventRow(
    event("hard_braking", 84_520, 86_100, {
      entry_speed_mps: 39.72,
      exit_speed_mps: 24.17,
      peak: 1,
    }),
    0,
  );
  assert.equal(row.label, "Hard braking");
  assert.equal(row.time, "1:24.520 – 1:26.100");
  assert.equal(row.duration, "1.58 s");
  assert.equal(row.speed, "143 → 87 km/h");
  assert.equal(row.detail, "Max brake 100%");
  assert.equal(row.hasCorner, false);
  assert.equal(row.corner, UNAVAILABLE);
});

test("a per-corner event names its corner from the canonical code", () => {
  const row = eventRow(
    event("high_suspension_extension", 92_100, 92_720, {
      corner: "rear_right",
      peak: 0.02,
    }),
    0,
  );
  assert.equal(row.hasCorner, true);
  assert.equal(row.corner, "Rear right");
  assert.equal(row.detail, "Lowest normalized travel 0.02");
  assert.equal(row.time, "1:32.100 – 1:32.720");
});

test("every event label is neutral", () => {
  const labels = Object.values(EVENT_LABELS).join(" ").toLowerCase();
  for (const forbidden of [
    "wheelspin",
    "lock",
    "understeer",
    "oversteer",
    "spin",
    "mistake",
    "good",
    "bad",
    "ideal",
    "corner",
  ]) {
    assert.ok(!labels.includes(forbidden), `a label says "${forbidden}"`);
  }
  // Suspension events say what the channel did and nothing more.
  assert.equal(
    EVENT_LABELS.high_suspension_compression,
    "High suspension compression",
  );
});

test("a suspension extension event reports its lowest travel", () => {
  const row = eventRow(
    event("high_suspension_extension", 0, 400, {
      corner: "front_left",
      peak: 0.02,
      signed_peak: 0.02,
    }),
    0,
  );
  assert.equal(row.detail, "Lowest normalized travel 0.02");
});

test("an event whose speed was never recorded renders unavailable, not zero", () => {
  const row = eventRow(
    event("braking", 0, 500, {
      entry_speed_mps: null,
      exit_speed_mps: null,
      speed_change_mps: null,
    }),
    0,
  );
  assert.equal(row.speed, UNAVAILABLE);
  assert.ok(!row.speed.includes("0"));
});

test("events are grouped and stay in time order", () => {
  const document = analysis({
    // Deliberately out of order, to prove the view model does not trust it.
    events: [
      event("full_throttle", 9_000, 9_500),
      event("braking", 1_000, 1_500),
      event("hard_braking", 5_000, 5_500),
      event("high_suspension_compression", 2_000, 2_300, {
        corner: "front_right",
      }),
    ],
    slip_episodes: [episode(2, 7_000, 7_800), episode(1, 3_000, 3_400)],
  });
  const driving = drivingEventRows(document);
  assert.deepEqual(
    driving.map((row) => row.kind),
    ["braking", "hard_braking", "full_throttle"],
  );
  assert.deepEqual(
    suspensionEventRows(document).map((row) => row.kind),
    ["high_suspension_compression"],
  );
  // Episodes are ordered too, whatever order they arrive in.
  assert.deepEqual(
    slipEpisodeRows(document).map((row) => row.time),
    ["0:03.000 – 0:03.400", "0:07.000 – 0:07.800"],
  );
});

test("grouping covers every event kind exactly once", () => {
  const kinds = Object.keys(EVENT_LABELS);
  const document = analysis({
    events: kinds.map((kind, index) =>
      event(kind, index * 1000, index * 1000 + 400, {
        corner: kind.startsWith("high_") ? "front_left" : null,
      }),
    ),
  });
  const seen = [
    ...drivingEventRows(document),
    ...suspensionEventRows(document),
  ].map((row) => row.kind);
  assert.deepEqual(seen.slice().sort(), kinds.slice().sort());
  // Slip is not an event kind at all: it has its own presented model.
  assert.ok(!kinds.some((kind) => kind.includes("slip")));
});

// --------------------------------------------------------- turn formatting

test("a turn segment renders compactly and is never labelled left or right", () => {
  const row = turnRow(segment(4, 20_000, 23_400));
  assert.equal(row.title, "Turn segment 4");
  assert.equal(row.time, "0:20.000 – 0:23.400");
  assert.equal(row.duration, "3.40 s");
  assert.equal(row.entrySpeed, "144");
  assert.equal(row.minSpeed, "79");
  assert.equal(row.exitSpeed, "112");
  assert.equal(row.yawChange, "90°");
  assert.equal(row.brakeTime, "0.50 s");
  assert.equal(row.fullThrottleTime, "1.00 s");
  assert.equal(row.maxBrake, "90%");
  // The peak is named by corner, and the corner comes from the canonical code.
  assert.equal(row.peakSlip, "1.25 (Rear right)");
  assert.equal(row.peakCompression, "0.97 (Front left)");
  const text = Object.values(row).join(" ").toLowerCase();
  for (const forbidden of [
    "left turn",
    "right turn",
    "score",
    "ideal",
    "rating",
  ]) {
    assert.ok(!text.includes(forbidden), `turn row says "${forbidden}"`);
  }
});

test("a negative yaw change keeps its sign and still gets a neutral title", () => {
  const row = turnRow(
    segment(2, 0, 2_000, { signed_yaw_change_rad: -1.5707963267948966 }),
  );
  assert.equal(row.yawChange, "-90°");
  assert.equal(row.title, "Turn segment 2");
});

test("turn segments are returned in time order", () => {
  const document = analysis({
    turn_segments: [segment(2, 60_000, 62_800), segment(1, 20_000, 23_400)],
  });
  assert.deepEqual(
    turnRows(document).map((row) => row.title),
    ["Turn segment 1", "Turn segment 2"],
  );
});

// ------------------------------------------- V1 sessions and null channels

test("a V1 analysis reports wheel and suspension channels as unavailable", () => {
  const document = analysis({
    telemetry_frame_schema_version: 1,
    events: [event("full_throttle", 1_000, 4_000)],
    turn_segments: [
      segment(1, 20_000, 23_400, {
        max_abs_slip_ratio: corners(null),
        max_combined_slip: corners(null),
        max_suspension_compression: corners(null),
      }),
    ],
    data_quality: {
      ...analysis().data_quality,
      telemetry_frame_schema_version: 1,
      wheel_telemetry_available: false,
      suspension_available: false,
    },
  });
  // The event groups that need those channels say why they are empty.
  const wheelNote = channelNote(document, "wheel");
  assert.match(wheelNote, /schema v1/);
  assert.match(wheelNote, /Nothing is reconstructed from adapter data/);
  assert.equal(channelNote(document, "suspension") != null, true);
  // Speed and control analysis still works.
  assert.equal(drivingEventRows(document).length, 1);
  assert.equal(turnRows(document).length, 1);
  // And a turn's per-corner peaks are unavailable rather than zero.
  const row = turnRow(document.turn_segments[0]);
  assert.equal(row.peakSlip, UNAVAILABLE);
  assert.equal(row.peakCompression, UNAVAILABLE);
});

test("an available channel produces no note", () => {
  const document = analysis();
  assert.equal(channelNote(document, "wheel"), null);
  assert.equal(channelNote(document, "suspension"), null);
  assert.equal(channelNote(document, "orientation"), null);
  assert.equal(channelNote(null, "wheel"), null);
});

test("data quality states what was unavailable instead of counting it as zero", () => {
  const document = analysis({
    data_quality: {
      ...analysis().data_quality,
      wheel_telemetry_available: false,
      frame_stream_complete: false,
      events_truncated: 12,
      speed_discontinuities: 4,
    },
  });
  const lines = qualityLines(document);
  const find = (key) => lines.find((line) => line.key === key);
  assert.equal(find("wheels").value, "Unavailable");
  assert.equal(find("wheels").available, false);
  assert.equal(find("speed").value, "Available");
  assert.equal(find("stream").value, "Incomplete (no footer)");
  assert.equal(find("stream").available, false);
  assert.equal(find("schema").value, "v2");
  assert.equal(find("truncated").available, false);
  assert.match(find("analyzed").value, /118\.5 s of 120\.0 s recorded/);
  // A discontinuity is surfaced as a quality problem, not hidden.
  assert.equal(find("discontinuities").value, "4");
  assert.equal(find("discontinuities").available, false);
});

// --------------------------------------------------------------- heuristics

test("the heuristics shown are the ones the analysis was produced with", () => {
  const document = analysis({
    config: { ...config, hard_braking_enter: 0.66, turn_min_duration_ms: 900 },
  });
  const notes = heuristicNotes(document).join(" ");
  assert.match(notes, /0\.66/);
  assert.match(notes, /900 ms/);
  assert.match(notes, /RaceLab definitions, not automotive standards/);
  // The claims RaceLab explicitly refuses to make are named as refused.
  assert.match(notes, /never called wheelspin|Nothing is called wheelspin/i);
  assert.match(notes, /not a claim about a track corner/);
  assert.match(notes, /not mapped to left or right/);
  assert.match(notes, /never taken from the source acceleration vector/);
  assert.match(notes, /discontinuity in the recorded speed/);
  assert.deepEqual(heuristicNotes(null), []);
});

// ------------------------------------------------- slip episode presentation

test("a slip episode renders as one card naming every affected corner", () => {
  const row = slipEpisodeRow(episode(3, 92_100, 92_720));
  assert.equal(row.title, "High slip episode 3");
  assert.equal(row.time, "1:32.100 – 1:32.720");
  assert.equal(row.duration, "0.62 s");
  assert.match(row.engaged, /0\.62 s above threshold/);
  // Both affected corners appear, named, in canonical order.
  assert.equal(row.corners, "Rear left, Rear right");
  assert.equal(row.channels, "slip ratio, combined slip");
  assert.equal(row.speed, "144 → 86 km/h");
  assert.match(row.peak, /peak slip 76\.01/);
  assert.match(row.peak, /combined 76\.11/);
});

test("coalescing keeps every affected corner's measured peak", () => {
  const row = slipEpisodeRow(episode(1, 0, 1_000));
  // Only the corners that crossed a threshold appear, and each keeps its own
  // signed peak — a large value is never clamped for being large.
  assert.deepEqual(
    row.cornerPeaks.map((corner) => corner.label),
    ["Rear left", "Rear right"],
  );
  assert.match(row.cornerPeaks[0].value, /slip 75\.46/);
  assert.match(row.cornerPeaks[1].value, /slip -76\.01/);
  assert.match(row.cornerPeaks[1].value, /combined 76\.11/);
});

test("a one-corner, one-channel episode says exactly that", () => {
  const row = slipEpisodeRow(
    episode(1, 0, 800, {
      corners: ["front_left"],
      families: ["combined_slip"],
      max_abs_slip_ratio: {
        front_left: 0.05,
        front_right: null,
        rear_left: null,
        rear_right: null,
      },
      signed_peak_slip_ratio: {
        front_left: 0.05,
        front_right: null,
        rear_left: null,
        rear_right: null,
      },
      max_combined_slip: {
        front_left: 2.0,
        front_right: null,
        rear_left: null,
        rear_right: null,
      },
      peak_abs_slip_ratio: 0.05,
      peak_combined_slip: 2.0,
    }),
  );
  assert.equal(row.corners, "Front left");
  assert.equal(row.channels, "combined slip");
  assert.equal(row.cornerPeaks.length, 1);
});

test("nothing in an episode card names a vehicle-dynamics state", () => {
  const row = slipEpisodeRow(episode(1, 0, 1_000));
  const text = [
    ...Object.values(row).filter((value) => typeof value === "string"),
    ...row.cornerPeaks.map((corner) => `${corner.label} ${corner.value}`),
  ]
    .join(" ")
    .toLowerCase();
  for (const forbidden of [
    "wheelspin",
    "wheel lock",
    "understeer",
    "oversteer",
    "traction loss",
    "slide",
    "mistake",
    "bad",
    "poor",
    "score",
  ]) {
    assert.ok(!text.includes(forbidden), `episode card says "${forbidden}"`);
  }
  assert.match(row.title, /High slip episode/);
});

test("an analysis with no episodes produces no episode rows", () => {
  assert.deepEqual(slipEpisodeRows(analysis({ slip_episodes: [] })), []);
  assert.deepEqual(slipEpisodeRows(null), []);
});

test("a V1 analysis has no slip episodes and says why", () => {
  const document = analysis({
    slip_episodes: [],
    telemetry_frame_schema_version: 1,
    driving_summary: {
      ...analysis().driving_summary,
      slip_episode_count: 0,
      slip_episode_seconds: 0,
    },
    data_quality: {
      ...analysis().data_quality,
      telemetry_frame_schema_version: 1,
      wheel_telemetry_available: false,
      slip_ratio_detector_events: 0,
      combined_slip_detector_events: 0,
    },
  });
  assert.deepEqual(slipEpisodeRows(document), []);
  assert.match(channelNote(document, "wheel"), /schema v1/);
});

// ----------------------------------------------------- coalescing diagnostics

test("data quality shows the raw detector count next to the episode count", () => {
  const lines = qualityLines(analysis());
  const detectors = lines.find((line) => line.key === "slip-detectors");
  // 82 + 138 raw detections collapsing to 1 episode is the normal shape of one
  // maneuver lighting up several corners, and the UI shows both numbers.
  assert.equal(detectors.value, "220 → 1 episodes");
  const coverage = lines.find((line) => line.key === "slip-coverage");
  assert.match(coverage.value, /0\.6 s of 118\.5 s analyzed/);
});

test("the heuristics state the coalescing and significance rules", () => {
  const notes = heuristicNotes(analysis()).join(" ");
  assert.match(notes, /400 ms belongs to the same episode/);
  assert.match(notes, /120 ms above threshold/);
  assert.match(notes, /never discards or clamps a measurement/);
  assert.match(notes, /250 ms to be reported/);
  assert.match(notes, /150 ms continues the same excursion/);
  assert.match(notes, /0\.2 rad net/);
});

// --------------------------------------------------------------- job timing

test("an analysis carries its queue wait separately from its runtime", () => {
  const document = analysis();
  // A long wall-clock gap between a session ending and its analysis appearing
  // is a queue observation, not a slow analyzer, and the document says which.
  assert.equal(document.queued_ms, 53_700);
  assert.equal(document.analysis_duration_ms, 1_170);
  assert.ok(document.requested_at_unix_ms < document.analyzed_at_unix_ms);
});
