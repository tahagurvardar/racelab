// Session and analysis fixtures for the Stage D tests, in the exact shapes
// `session_format.rs` and `analysis.rs` serialize — every field present — plus
// a scripted backend whose replies the test releases one by one, in any order.

export const config = {
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

export const corners = (value) => ({
  front_left: value,
  front_right: value,
  rear_left: value,
  rear_right: value,
});

export function event(kind, start_ms, end_ms, overrides = {}) {
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

export function segment(index, start_ms, end_ms, overrides = {}) {
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

/// Distinct values per corner, so a transposed corner cannot pass.
export function episode(index, start_ms, end_ms, overrides = {}) {
  return {
    index,
    start_ms,
    end_ms,
    duration_ms: end_ms - start_ms,
    engaged_seconds: (end_ms - start_ms) / 1000,
    corners: ["front_right", "rear_left"],
    families: ["slip_ratio", "combined_slip"],
    entry_speed_mps: 40,
    min_speed_mps: 24,
    max_speed_mps: 40,
    exit_speed_mps: 24,
    max_abs_slip_ratio: {
      front_left: null,
      front_right: 1.11,
      rear_left: 3.33,
      rear_right: null,
    },
    signed_peak_slip_ratio: {
      front_left: null,
      front_right: -1.11,
      rear_left: 3.33,
      rear_right: null,
    },
    max_combined_slip: {
      front_left: null,
      front_right: 1.22,
      rear_left: 3.44,
      rear_right: null,
    },
    peak_abs_slip_ratio: 3.33,
    peak_combined_slip: 3.44,
    ...overrides,
  };
}

export function analysis(overrides = {}) {
  const quality = overrides.data_quality ?? {};
  const summary = overrides.driving_summary ?? {};
  const base = {
    schema_version: 2,
    session_id: "s-a",
    telemetry_frame_schema_version: 2,
    analyzed_at_unix_ms: 1_800_000_100_000,
    requested_at_unix_ms: 1_800_000_045_000,
    queued_ms: 53_700,
    analysis_duration_ms: 1_170,
    analyzed_by_racelab_version: "1.1.0",
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
    events: [
      event("hard_braking", 84_520, 86_100),
      event("full_throttle", 87_300, 91_900, {
        entry_speed_mps: 25.28,
        exit_speed_mps: 45.56,
        speed_change_mps: 20.28,
        peak: 0.99,
      }),
      event("high_suspension_extension", 93_000, 93_400, {
        corner: "front_left",
        peak: 0.02,
        signed_peak: 0.02,
      }),
    ],
    slip_episodes: [episode(1, 92_100, 92_720)],
    turn_segments: [segment(1, 20_000, 23_400), segment(2, 60_000, 62_800)],
  };
  const doc = { ...base, ...overrides };
  return {
    ...doc,
    driving_summary: {
      event_count: doc.events.length,
      slip_episode_count: doc.slip_episodes.length,
      slip_episode_seconds: 0.62,
      turn_segment_count: doc.turn_segments.length,
      events_by_kind: [
        "full_throttle",
        "braking",
        "hard_braking",
        "rapid_throttle_lift",
        "strong_acceleration",
        "strong_deceleration",
        "high_suspension_compression",
        "high_suspension_extension",
      ].map((kind) => ({
        kind,
        count: doc.events.filter((item) => item.kind === kind).length,
      })),
      full_throttle_seconds: 31.5,
      braking_seconds: 12.25,
      hard_braking_seconds: 3.5,
      max_speed_mps: 61,
      max_longitudinal_acceleration_mps2: 7.5,
      max_longitudinal_deceleration_mps2: -9.25,
      ...summary,
    },
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
      ...quality,
    },
  };
}

export function analysisState(sessionId, state = "available", overrides = {}) {
  return {
    session_id: sessionId,
    state,
    analysis:
      state === "available"
        ? analysis({ session_id: sessionId, ...(overrides.document ?? {}) })
        : null,
    analysis_schema_version: state === "available" ? 2 : null,
    supported_analysis_schema_version: 2,
    message: null,
    file: "analysis.json",
    queued_ms: null,
    analysis_duration_ms: null,
    failure_reason: null,
    can_reanalyze: state !== "queued" && state !== "analyzing",
    ...Object.fromEntries(
      Object.entries(overrides).filter(([key]) => key !== "document"),
    ),
  };
}

export function manifest(sessionId, overrides = {}) {
  return {
    schema_version: 1,
    session_id: sessionId,
    status: "completed",
    game: "fh6",
    protocol: "fh6",
    vehicle_id: "3421",
    started_at_unix_ms: 1_800_000_000_000,
    ended_at_unix_ms: 1_800_000_600_000,
    duration_us: 600_000_000,
    frame_count: 36_000,
    active_frame_count: 35_000,
    inactive_frame_count: 1_000,
    recorder_dropped_frames: 0,
    completion_reason: "grace_expired",
    frame_file: "frames.rlframes",
    frame_format_version: 1,
    telemetry_frame_schema_version: 2,
    summary: {
      duration_seconds: 600,
      measured_seconds: 598,
      frame_count: 36_000,
      max_speed_kmh: 241.3,
      average_speed_kmh: 128.4,
      max_rpm: 7820,
      average_rpm: 5110,
      full_throttle_seconds: 220,
      full_throttle_percent: 36.7,
      braking_seconds: 70,
      braking_percent: 11.6,
      gear_change_count: null,
      distance_meters: 21_400,
      data_quality: {
        recorder_dropped_frames: 0,
        complete: true,
        excluded_gaps: 0,
      },
    },
    created_by_racelab_version: "1.0.0",
    recovery: null,
    ...overrides,
  };
}

export function storage(overrides = {}) {
  return {
    retention: {
      budget_bytes: 8 * 1024 ** 3,
      enabled: true,
      used_bytes: 3 * 1024 ** 3,
      over_budget: false,
      retained_sessions: 3,
      protected_sessions: 0,
      unidentifiable_sessions: 0,
      unidentifiable_bytes: 0,
      deleted_sessions: 0,
      reclaimed_bytes: 0,
      failed_deletions: 0,
      sweeps: 1,
      last_sweep_unix_ms: null,
      last_deleted_session_id: null,
      last_error: null,
      ...(overrides.retention ?? {}),
    },
    recovery: {
      reclassified: 0,
      pending: 0,
      scanned: 0,
      complete: 0,
      truncated: 0,
      damaged: 0,
      unreadable: 0,
      recovered_frames: 0,
      running: false,
      last_session_id: null,
      last_error: null,
      ...(overrides.recovery ?? {}),
    },
  };
}

/// A backend whose every call returns a pending promise. The test decides
/// when — and in which order — each one settles.
export function scriptedBackend() {
  const pending = [];
  const calls = [];
  function call(name, id) {
    calls.push({ name, id });
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    pending.push({ name, id, resolve, reject, settled: false });
    return promise;
  }
  const backend = {
    listRecent: (limit) => call("listRecent", limit),
    storageStatus: () => call("storageStatus", null),
    session: (id) => call("session", id),
    analysis: (id) => call("analysis", id),
    reanalyze: (id) => call("reanalyze", id),
  };
  function take(name, id) {
    const index = pending.findIndex(
      (item) =>
        !item.settled &&
        item.name === name &&
        (id === undefined || item.id === id),
    );
    if (index < 0) throw new Error(`no pending ${name}(${id ?? ""})`);
    const item = pending[index];
    item.settled = true;
    return item;
  }
  return {
    backend,
    calls,
    open: (name) =>
      pending.filter((item) => !item.settled && (!name || item.name === name)),
    /// Resolves the oldest pending call of that name (and id, if given).
    async reply(name, id, value) {
      take(name, id).resolve(value);
      await flush();
    },
    async fail(name, id, reason) {
      take(name, id).reject(new Error(reason));
      await flush();
    },
  };
}

/// Lets every already-settled promise chain run to completion.
export async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/// Timers the test advances by hand.
export function manualTimers() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    timers: {
      set(callback, ms) {
        nextId += 1;
        timers.set(nextId, { at: now + ms, callback, ms });
        return nextId;
      },
      clear(handle) {
        timers.delete(handle);
      },
    },
    pending: () => [...timers.values()],
    async advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
      await flush();
    },
  };
}
