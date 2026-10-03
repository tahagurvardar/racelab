import "./dev-only.ts";
/// DEV-ONLY session fixtures for the review harness. Illustrative shapes for
/// layout and lifecycle review — not captured telemetry, not test evidence,
/// and never imported by the application.
///
/// `?sessions=` selects a set:
///   mixed   (default) one session in every analysis state, plus an
///           interrupted/recovered one and a large capped analysis
///   none    no sessions yet
///   delayed the mixed set, with the newest session's replies held back so a
///           quick A → B → C selection receives them out of order
///
/// Analysis states in the mixed set: available, analyzing (stays), queued
/// (stays), progressing (queued → analyzing → available over ~8 s, to watch
/// the 2 s refresh), failed (re-run turns it into progressing), not analyzed,
/// unsupported schema.
import type {
  AnalysisAvailability,
  DrivingEvent,
  EventKind,
  SessionAnalysis,
  SessionAnalysisState,
  SlipEpisode,
  TurnSegment,
} from "../src/analysis-state.ts";
import type { SessionManifest } from "../src/session-state.ts";

export const sessionSet = (new URLSearchParams(location.search).get(
  "sessions",
) ?? "mixed") as "mixed" | "none" | "delayed";

const NOW = Date.now();
const MINUTE = 60_000;

/// A seeded generator, so a fixture looks the same on every load.
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const CONFIG = {
  max_gap_ms: 250,
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

const KINDS: EventKind[] = [
  "full_throttle",
  "braking",
  "hard_braking",
  "rapid_throttle_lift",
  "strong_acceleration",
  "strong_deceleration",
  "high_suspension_compression",
  "high_suspension_extension",
];
const CORNERS = [
  "front_left",
  "front_right",
  "rear_left",
  "rear_right",
] as const;

function corners<T>(value: (corner: string, index: number) => T) {
  return {
    front_left: value("front_left", 0),
    front_right: value("front_right", 1),
    rear_left: value("rear_left", 2),
    rear_right: value("rear_right", 3),
  };
}

interface Size {
  events: number;
  turns: number;
  slips: number;
  /// Kinds that reached the per-kind event cap: each stores exactly
  /// `max_events` rows and counts this many more, as `push_event` does.
  cappedKinds?: Partial<Record<EventKind, number>>;
  truncatedTurns?: number;
  truncatedSlips?: number;
  streamComplete?: boolean;
}

function analysisDocument(
  id: string,
  minutes: number,
  size: Size,
  seed: number,
): SessionAnalysis {
  const next = random(seed);
  const span = minutes * MINUTE;
  const speed = () => 20 + next() * 50;
  const capped = size.cappedKinds ?? {};
  const makeEvent = (kind: EventKind): DrivingEvent => {
    const start = Math.floor(next() * (span - 4000));
    const length = 120 + Math.floor(next() * 3200);
    const entry = speed();
    const exit =
      kind.includes("brak") || kind === "strong_deceleration"
        ? entry * (0.4 + next() * 0.4)
        : entry * (1 + next() * 0.3);
    const corner = kind.startsWith("high_suspension")
      ? CORNERS[Math.floor(next() * 4)]
      : null;
    return {
      kind,
      corner,
      start_ms: start,
      end_ms: start + length,
      duration_ms: length,
      entry_speed_mps: entry,
      exit_speed_mps: exit,
      min_speed_mps: Math.min(entry, exit),
      max_speed_mps: Math.max(entry, exit),
      speed_change_mps: exit - entry,
      max_rpm: 5200 + Math.floor(next() * 2600),
      peak:
        kind === "strong_acceleration" || kind === "strong_deceleration"
          ? null
          : kind === "high_suspension_extension"
            ? next() * 0.05
            : 0.8 + next() * 0.2,
      signed_peak:
        kind === "strong_acceleration"
          ? 4 + next() * 4
          : kind === "strong_deceleration"
            ? -6 - next() * 5
            : null,
      peak_combined_slip: next() < 0.5 ? null : next() * 1.4,
    };
  };
  // Uncapped kinds at random; every capped kind exactly at its own limit.
  const events: DrivingEvent[] = [
    ...Array.from(
      { length: size.events },
      () => KINDS[Math.floor(next() * (next() < 0.85 ? 6 : 8))],
    )
      .filter((kind) => !(kind in capped))
      .map(makeEvent),
    ...(Object.keys(capped) as EventKind[]).flatMap((kind) =>
      Array.from({ length: CONFIG.max_events }, () => makeEvent(kind)),
    ),
  ].sort((a, b) => a.start_ms - b.start_ms);
  const omittedEvents = Object.values(capped).reduce(
    (sum, extra) => sum + (extra ?? 0),
    0,
  );

  const turns: TurnSegment[] = Array.from({ length: size.turns }, (_, i) => {
    const start = Math.floor(((i + next() * 0.6) / size.turns) * (span - 6000));
    const length = 600 + Math.floor(next() * 5000);
    const entry = speed();
    return {
      index: i + 1,
      start_ms: start,
      end_ms: start + length,
      duration_ms: length,
      signed_yaw_change_rad: (next() < 0.5 ? -1 : 1) * (0.2 + next() * 1.8),
      mean_yaw_rate_rad_s: (next() < 0.5 ? -1 : 1) * (0.2 + next() * 0.3),
      peak_yaw_rate_rad_s: 0.5 + next() * 0.6,
      entry_speed_mps: entry,
      min_speed_mps: entry * 0.7,
      exit_speed_mps: entry * (0.8 + next() * 0.3),
      max_speed_mps: entry * 1.05,
      average_speed_mps: entry * 0.85,
      brake_seconds: next() * 1.5,
      throttle_seconds: next() * 3,
      full_throttle_seconds: next() * 1.2,
      max_brake: next() < 0.3 ? null : next(),
      max_abs_slip_ratio: corners(() => next() * 0.8),
      max_combined_slip: corners(() => next() * 0.9),
      max_suspension_compression: corners(() => 0.4 + next() * 0.5),
    };
  });

  const slips: SlipEpisode[] = Array.from({ length: size.slips }, (_, i) => {
    const start = Math.floor(((i + next() * 0.7) / size.slips) * (span - 5000));
    const length = 150 + Math.floor(next() * 4000);
    const affected = CORNERS.filter(() => next() < 0.55);
    const used = affected.length ? affected : [CORNERS[2 + (i % 2)]];
    const value = (corner: string) =>
      used.includes(corner as (typeof CORNERS)[number]) ? 1 + next() * 2 : null;
    const ratio = corners(value);
    const entry = speed();
    return {
      index: i + 1,
      start_ms: start,
      end_ms: start + length,
      duration_ms: length,
      engaged_seconds: (length / 1000) * (0.4 + next() * 0.6),
      corners: [...used],
      families:
        next() < 0.5 ? ["slip_ratio", "combined_slip"] : ["combined_slip"],
      entry_speed_mps: entry,
      min_speed_mps: entry * 0.9,
      max_speed_mps: entry * 1.1,
      exit_speed_mps: entry,
      max_abs_slip_ratio: ratio,
      signed_peak_slip_ratio: corners((corner) => {
        const magnitude = ratio[corner as keyof typeof ratio];
        return magnitude == null ? null : magnitude * (next() < 0.5 ? -1 : 1);
      }),
      max_combined_slip: corners((corner) =>
        used.includes(corner as (typeof CORNERS)[number])
          ? 1 + next() * 1.5
          : null,
      ),
      peak_abs_slip_ratio: Math.max(
        ...Object.values(ratio).filter((x): x is number => x != null),
      ),
      peak_combined_slip: 1 + next() * 1.5,
    };
  });

  // Every detected event is counted, stored or not, as the backend does.
  const counts = KINDS.map((kind) => ({
    kind,
    count:
      events.filter((event) => event.kind === kind).length +
      (capped[kind] ?? 0),
  }));
  const recorded = span / 1000;
  return {
    schema_version: 2,
    session_id: id,
    telemetry_frame_schema_version: 2,
    analyzed_at_unix_ms: NOW - 5 * MINUTE,
    requested_at_unix_ms: NOW - 6 * MINUTE,
    queued_ms: 1800,
    analysis_duration_ms: 2400,
    analyzed_by_racelab_version: "1.1.0",
    config: CONFIG,
    coverage: {
      first_monotonic_ms: 912_000,
      last_monotonic_ms: 912_000 + span,
      recorded_seconds: recorded,
      analyzed_seconds: recorded * 0.97,
      excluded_gap_count: 2,
      excluded_gap_seconds: recorded * 0.01,
      inactive_interval_count: 3,
      inactive_interval_seconds: recorded * 0.02,
    },
    driving_summary: {
      event_count: events.length + omittedEvents,
      slip_episode_count: slips.length + (size.truncatedSlips ?? 0),
      slip_episode_seconds: slips.reduce(
        (sum, s) => sum + s.engaged_seconds,
        0,
      ),
      turn_segment_count: turns.length + (size.truncatedTurns ?? 0),
      events_by_kind: counts,
      full_throttle_seconds: recorded * 0.36,
      braking_seconds: recorded * 0.11,
      hard_braking_seconds: recorded * 0.03,
      max_speed_mps: 67.0,
      max_longitudinal_acceleration_mps2: 7.4,
      max_longitudinal_deceleration_mps2: -11.8,
    },
    events,
    slip_episodes: slips,
    turn_segments: turns,
    data_quality: {
      telemetry_frame_schema_version: 2,
      frames_read: minutes * 3600,
      active_frames: minutes * 3500,
      inactive_frames: minutes * 100,
      zero_interval_frames: 4,
      speed_discontinuities: 0,
      frame_stream_complete: size.streamComplete ?? true,
      speed_available: true,
      controls_available: true,
      engine_available: true,
      orientation_available: true,
      wheel_telemetry_available: true,
      suspension_available: true,
      events_truncated: omittedEvents,
      slip_episodes_truncated: size.truncatedSlips ?? 0,
      turn_segments_truncated: size.truncatedTurns ?? 0,
      slip_ratio_detector_events: slips.length * 3,
      combined_slip_detector_events: slips.length * 4,
    },
  };
}

interface Fixture {
  manifest: SessionManifest;
  analysis: () => SessionAnalysisState;
}

function manifest(
  id: string,
  startedAt: number,
  minutes: number,
  extra: Partial<SessionManifest> = {},
): SessionManifest {
  const completed = (extra.status ?? "completed") === "completed";
  return {
    schema_version: 1,
    session_id: id,
    status: "completed",
    game: "fh6",
    protocol: "fh6",
    vehicle_id: "3421",
    started_at_unix_ms: startedAt,
    ended_at_unix_ms: startedAt + minutes * MINUTE,
    duration_us: minutes * 60_000_000,
    frame_count: minutes * 3600,
    active_frame_count: minutes * 3500,
    inactive_frame_count: minutes * 100,
    recorder_dropped_frames: 0,
    completion_reason: "grace_expired",
    frame_file: "frames.rlframes",
    frame_format_version: 1,
    telemetry_frame_schema_version: 2,
    summary: completed
      ? {
          duration_seconds: minutes * 60,
          measured_seconds: minutes * 59.4,
          frame_count: minutes * 3600,
          max_speed_kmh: 241.3,
          average_speed_kmh: 128.4,
          max_rpm: 7820,
          average_rpm: 5110,
          full_throttle_seconds: minutes * 22,
          full_throttle_percent: 36.7,
          braking_seconds: minutes * 7,
          braking_percent: 11.6,
          gear_change_count: null,
          distance_meters: minutes * 2140,
          data_quality: {
            recorder_dropped_frames: extra.recorder_dropped_frames ?? 0,
            complete: (extra.recorder_dropped_frames ?? 0) === 0,
            excluded_gaps: 2,
          },
        }
      : null,
    created_by_racelab_version: "1.0.0",
    recovery: null,
    ...extra,
  };
}

function state(
  id: string,
  availability: AnalysisAvailability,
  document: SessionAnalysis | null,
  extra: Partial<SessionAnalysisState> = {},
): SessionAnalysisState {
  return {
    session_id: id,
    state: availability,
    analysis: availability === "available" ? document : null,
    analysis_schema_version: availability === "available" ? 2 : null,
    supported_analysis_schema_version: 2,
    message: null,
    file: "analysis.json",
    queued_ms: availability === "available" ? 1800 : null,
    analysis_duration_ms: availability === "available" ? 2400 : null,
    failure_reason: null,
    can_reanalyze: availability !== "queued" && availability !== "analyzing",
    ...extra,
  };
}

/// A session whose analysis moves queued → analyzing → available, measured
/// from `since` (the first time it is read, or a re-run).
function progressing(id: string, document: SessionAnalysis) {
  let since: number | null = null;
  return {
    restart() {
      since = Date.now();
    },
    read(): SessionAnalysisState {
      since ??= Date.now();
      const age = Date.now() - since;
      if (age < 4000) {
        return state(id, "queued", null, {
          queued_ms: age,
          can_reanalyze: false,
        });
      }
      if (age < 8000) {
        return state(id, "analyzing", null, {
          queued_ms: 4000,
          can_reanalyze: false,
        });
      }
      return state(id, "available", document);
    },
  };
}

function idAt(time: number): string {
  return new Date(time)
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\.\d+Z$/, "Z");
}

function build(): Fixture[] {
  if (sessionSet === "none") return [];
  const at = (minutesAgo: number) => NOW - minutesAgo * MINUTE;
  const fixtures: Fixture[] = [];
  const add = (
    startedAt: number,
    minutes: number,
    analysis: (id: string) => () => SessionAnalysisState,
    extra: Partial<SessionManifest> = {},
  ) => {
    const id = idAt(startedAt);
    fixtures.push({
      manifest: manifest(id, startedAt, minutes, extra),
      analysis: analysis(id),
    });
  };

  // Today
  add(at(40), 18, (id) => {
    const document = analysisDocument(
      id,
      18,
      { events: 64, turns: 26, slips: 9 },
      7,
    );
    return () => state(id, "available", document);
  });
  add(
    at(95),
    6,
    (id) => () =>
      state(id, "analyzing", null, { queued_ms: 2100, can_reanalyze: false }),
  );
  add(
    at(160),
    9,
    (id) => () =>
      state(id, "queued", null, {
        queued_ms: Date.now() - NOW + 42_000,
        can_reanalyze: false,
      }),
  );
  add(
    at(230),
    4,
    (id) => {
      const document = analysisDocument(
        id,
        4,
        { events: 14, turns: 6, slips: 2, streamComplete: false },
        11,
      );
      return () => state(id, "available", document);
    },
    {
      status: "interrupted",
      completion_reason: "interrupted_racelab_did_not_finalize",
      summary: null,
      frame_count: 14_220,
      recovery: {
        outcome: "truncated",
        scanned_at_unix_ms: NOW - 2 * MINUTE,
        readable_frame_count: 14_220,
        readable_active_frame_count: 14_000,
        readable_duration_us: 237_000_000,
        frame_stream_complete: false,
        unreadable_tail_bytes: 4096,
        detail: null,
        recovered_by_racelab_version: "1.1.0",
      },
    },
  );
  // Yesterday and earlier
  const failedId = idAt(at(60 * 20));
  const failedDocument = analysisDocument(
    failedId,
    22,
    { events: 80, turns: 31, slips: 12 },
    13,
  );
  const failedProgress = progressing(failedId, failedDocument);
  let failedRerun = false;
  reanalyzers.set(failedId, () => {
    failedRerun = true;
    failedProgress.restart();
  });
  add(
    at(60 * 20),
    22,
    (id) => () =>
      failedRerun
        ? failedProgress.read()
        : state(id, "failed", null, {
            failure_reason:
              "Could not analyze the frame stream: unexpected end of record at byte 18 874 112.",
          }),
  );
  add(at(60 * 22), 12, (id) => () => state(id, "not_analyzed", null), {
    vehicle_id: "1187",
  });
  add(
    at(60 * 47),
    15,
    (id) => () =>
      state(id, "unsupported_schema", null, { analysis_schema_version: 3 }),
  );
  add(
    at(60 * 70),
    45,
    (id) => {
      const document = analysisDocument(
        id,
        45,
        {
          // Two kinds past the per-kind limit; the rest well under it,
          // so the stored total (> max_events) is per kind, not global.
          events: 160,
          cappedKinds: { braking: 137, full_throttle: 12 },
          turns: 200,
          slips: 200,
          truncatedTurns: 18,
          truncatedSlips: 4,
        },
        17,
      );
      return () => state(id, "available", document);
    },
    { recorder_dropped_frames: 37 },
  );
  add(at(60 * 96), 8, (id) => {
    const document = analysisDocument(
      id,
      8,
      { events: 30, turns: 12, slips: 4 },
      19,
    );
    const progress = progressing(id, document);
    return () => progress.read();
  });
  return fixtures;
}

const reanalyzers = new Map<string, () => void>();
const FIXTURES = build();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/// Reply latency for the `delayed` set: the newest session answers slowly,
/// the rest quickly, so selecting it and then another session returns the
/// replies out of order.
function latency(id: string): number {
  if (sessionSet !== "delayed") return 0;
  const index = FIXTURES.findIndex((item) => item.manifest.session_id === id);
  return index === 0 ? 2500 : 150 + ((index * 97) % 400);
}

function find(id: unknown): Fixture {
  const fixture = FIXTURES.find((item) => item.manifest.session_id === id);
  if (!fixture) throw new Error(`Could not read session ${String(id)}`);
  return fixture;
}

export const SESSION_RESPONSES: Record<
  string,
  (args: Record<string, unknown>) => unknown
> = {
  list_recent_sessions: () => ({
    sessions: FIXTURES.map((item) => item.manifest),
    unreadable: sessionSet === "none" ? 0 : 1,
    directory: "%LOCALAPPDATA%\\com.tahagurvardar.racelab\\sessions",
    limit: 20,
  }),
  get_session: async (args) => {
    await sleep(latency(String(args.sessionId)));
    return find(args.sessionId).manifest;
  },
  get_session_analysis: async (args) => {
    await sleep(latency(String(args.sessionId)));
    return find(args.sessionId).analysis();
  },
  reanalyze_session: async (args) => {
    const rerun = reanalyzers.get(String(args.sessionId));
    if (!rerun) throw new Error("This session is already queued for analysis.");
    rerun();
    return { running: true };
  },
};
