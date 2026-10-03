/// The Sessions workspace view model: list rows, the selected-session header,
/// the Summary figures, the Data tab and the pinned recorder row.
///
/// Pure and React-free, like `session-state.ts` and `analysis-state.ts`, whose
/// sentences and formatters it reuses rather than restating. Everything here is
/// a manifest or analysis field the backend already wrote; nothing is a score,
/// a grade or a judgement, and an unavailable value is never shown as zero.
import {
  EVENT_LABELS,
  EVENT_ORDER,
  analysisBanner,
  analysisJobLines,
  heuristicNotes,
  qualityLines,
  type AnalysisBanner,
  type EventKind,
  type SessionAnalysis,
  type SessionAnalysisState,
} from "./analysis-state.ts";
import {
  bytes,
  clockTime,
  duration,
  recoveryLabel,
  recoveryNote,
  retentionNote,
  value,
  type RecentSessions,
  type SessionManifest,
  type StorageStatus,
} from "./session-state.ts";
import type { RecorderState } from "./state/stores.ts";
import {
  UNAVAILABLE,
  elapsed,
  gForce,
  integer,
  kilometres,
  number,
  signed,
  speedKmh,
} from "./telemetry/formatting.ts";
import { gameName } from "./telemetry/telemetry-view-model.ts";

export type Tone = "neutral" | "good" | "warn" | "bad" | "rec";

export interface Badge {
  key: string;
  label: string;
  tone: Tone;
}

// ------------------------------------------------------------------ list

export interface SessionListRow {
  id: string;
  /// "14:32", or UNAVAILABLE without a start time.
  time: string;
  duration: string;
  vehicle: string;
  badges: Badge[];
  /// The row's accessible name: every fact on it, in one sentence.
  label: string;
}

export interface SessionDay {
  key: string;
  /// "Today", "Yesterday", or a date.
  label: string;
  rows: SessionListRow[];
}

const DAY_MS = 86_400_000;

function startOfDay(unixMs: number): number {
  const date = new Date(unixMs);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

export function dayLabel(unixMs: number | null, now: number): string {
  if (unixMs == null) return "Date unknown";
  const day = startOfDay(unixMs);
  const today = startOfDay(now);
  if (day === today) return "Today";
  // A DST day is 23 or 25 hours; rounding keeps "yesterday" one calendar day.
  if (Math.round((today - day) / DAY_MS) === 1) return "Yesterday";
  return new Date(unixMs).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function timeOfDay(unixMs: number | null): string {
  if (unixMs == null) return UNAVAILABLE;
  return new Date(unixMs).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/// The status facts a row carries. A completed session carries none: that is
/// the normal case, and a badge on every row would be noise.
export function sessionBadges(
  manifest: SessionManifest,
  recordingId: string | null,
): Badge[] {
  const badges: Badge[] = [];
  if (manifest.status === "recording") {
    badges.push(
      manifest.session_id === recordingId
        ? { key: "status", label: "Recording", tone: "rec" }
        : { key: "status", label: "Not finalized", tone: "warn" },
    );
  } else if (manifest.status === "interrupted") {
    const recovery = recoveryLabel(manifest);
    badges.push({
      key: "status",
      label: recovery ? `Interrupted · ${recovery}` : "Interrupted",
      tone: "warn",
    });
  } else if (manifest.summary && !manifest.summary.data_quality.complete) {
    badges.push({ key: "quality", label: "Incomplete data", tone: "warn" });
  }
  if (manifest.recorder_dropped_frames > 0) {
    badges.push({
      key: "drops",
      label: `${integer(manifest.recorder_dropped_frames)} dropped`,
      tone: "bad",
    });
  }
  return badges;
}

function vehicleText(manifest: SessionManifest): string {
  return manifest.vehicle_id ? `Vehicle ${manifest.vehicle_id}` : "Vehicle —";
}

export function sessionListRow(
  manifest: SessionManifest,
  now: number,
  recordingId: string | null,
): SessionListRow {
  const time = timeOfDay(manifest.started_at_unix_ms);
  const length = duration(manifest.duration_us / 1_000_000);
  const vehicle = vehicleText(manifest);
  const badges = sessionBadges(manifest, recordingId);
  const day = dayLabel(manifest.started_at_unix_ms, now);
  return {
    id: manifest.session_id,
    time,
    duration: length,
    vehicle,
    badges,
    label: [
      `${day} ${time}`,
      `duration ${length}`,
      vehicle,
      ...badges.map((badge) => badge.label),
    ].join(", "),
  };
}

/// Sessions grouped by local calendar day, newest first. The input order is
/// re-established here (as `orderSessions` does) rather than trusted.
export function sessionDays(
  sessions: SessionManifest[],
  now: number,
  recordingId: string | null,
): SessionDay[] {
  const ordered = [...sessions].sort(
    (a, b) =>
      (b.started_at_unix_ms ?? 0) - (a.started_at_unix_ms ?? 0) ||
      b.session_id.localeCompare(a.session_id),
  );
  const days: SessionDay[] = [];
  for (const manifest of ordered) {
    const started = manifest.started_at_unix_ms;
    const key = started == null ? "unknown" : String(startOfDay(started));
    let day = days.find((item) => item.key === key);
    if (!day) {
      day = { key, label: dayLabel(started, now), rows: [] };
      days.push(day);
    }
    day.rows.push(sessionListRow(manifest, now, recordingId));
  }
  return days;
}

export interface ListNotice {
  key: string;
  tone: Tone;
  text: string;
}

/// Facts about the listing as a whole: storage use, retention, recovery
/// progress and unreadable folders. Storage use is shown; the storage *limit*
/// is a setting and lives in Settings.
export function listNotices(
  recent: RecentSessions | null,
  storage: StorageStatus | null,
): ListNotice[] {
  const notices: ListNotice[] = [];
  const retention = storage?.retention ?? null;
  if (retention?.over_budget) {
    notices.push({
      key: "retention",
      tone: "warn",
      text: retentionNote(retention) ?? "",
    });
  } else if (retention && retention.deleted_sessions > 0) {
    notices.push({
      key: "retention",
      tone: "neutral",
      text: retentionNote(retention) ?? "",
    });
  }
  if (retention?.last_error) {
    notices.push({
      key: "retention-error",
      tone: "warn",
      text: `Storage clean-up problem: ${retention.last_error}`,
    });
  }
  const recovering = storage?.recovery ?? null;
  if (recovering && recovering.pending > 0) {
    notices.push({
      key: "recovery",
      tone: "neutral",
      text: `Checking ${integer(recovering.pending)} unfinished recording(s) to see how much of each can be read.`,
    });
  }
  if (recovering && recovering.scanned > 0) {
    notices.push({
      key: "recovered",
      tone: "neutral",
      text: `${integer(recovering.scanned)} unfinished recording(s) checked this run; ${integer(recovering.recovered_frames)} frames recovered that their session details had not yet counted.`,
    });
  }
  if ((recent?.unreadable ?? 0) > 0) {
    notices.push({
      key: "unreadable",
      tone: "warn",
      text: `${integer(recent?.unreadable)} session folder(s) could not be read and were skipped.`,
    });
  }
  return notices;
}

/// "3.1 GB of 8.0 GB" — usage against the limit set in Settings.
export function storageUsage(storage: StorageStatus | null): {
  text: string;
  fraction: number | null;
} | null {
  const retention = storage?.retention;
  if (retention == null) return null;
  if (!retention.enabled) {
    return {
      text: `${bytes(retention.used_bytes)} · no limit`,
      fraction: null,
    };
  }
  return {
    text: `${bytes(retention.used_bytes)} of ${bytes(retention.budget_bytes)}`,
    fraction:
      retention.budget_bytes > 0
        ? Math.min(1, retention.used_bytes / retention.budget_bytes)
        : null,
  };
}

// --------------------------------------------------------- recorder row

export interface RecorderRow {
  tone: Tone;
  title: string;
  /// Ticking duration while recording, else null.
  duration: string | null;
  vehicle: string | null;
  /// Current-session recorder drops, while recording.
  drops: number;
  /// The backend's own words for a failure to read the recorder.
  detail: string | null;
}

/// The pinned "now" row above the list. It follows the same truth model as the
/// top bar and global alert (`buildStatus`): only a recorder that is
/// *currently* in its error state is a failure — and that failure is the
/// global alert's message, so this row is absent rather than repeating it. A
/// `last_error` left over from an earlier failure is history, not status, and
/// is never shown here once the recorder has recovered.
export function recorderRow(state: RecorderState): RecorderRow | null {
  const recorder = state.recorder;
  if (state.error != null) {
    return {
      tone: "warn",
      title: "Recorder status unavailable",
      duration: null,
      vehicle: null,
      drops: 0,
      detail: state.error,
    };
  }
  if (recorder == null) return null;
  // A failed recorder is the global alert's message, shown above every
  // workspace; repeating it here would say the same thing twice.
  if (recorder.status === "error") return null;
  if (!recorder.recording) return null;
  return {
    tone: "rec",
    title: "Recording now",
    duration: elapsed(recorder.duration_ms / 1000),
    vehicle: recorder.vehicle_id ? `Vehicle ${recorder.vehicle_id}` : null,
    drops: recorder.recorder_dropped_frames,
    detail: null,
  };
}

// ------------------------------------------------------------- header

export interface Fact {
  key: string;
  label: string;
  value: string;
  /// False only for a value that does not exist (the dash). Never used to
  /// mean "worth a look": that is `attention`, and the value is still read.
  available: boolean;
  /// An integrity fact that deserves a look (an incomplete stream, a
  /// discontinuity, a cap that omitted rows, a channel not recorded). The
  /// value itself is always presented, visually and to assistive technology.
  attention?: boolean;
  mono?: boolean;
}

function fact(key: string, label: string, text: string, mono = false): Fact {
  return { key, label, value: text, available: text !== UNAVAILABLE, mono };
}

export interface SessionAlert {
  key: string;
  tone: Tone;
  title: string;
  detail: string;
}

export interface SessionHeader {
  title: string;
  status: Badge;
  facts: Fact[];
  alerts: SessionAlert[];
}

export function sessionTitle(manifest: SessionManifest, now: number): string {
  const started = manifest.started_at_unix_ms;
  if (started == null) return "Session, start time unknown";
  return `${dayLabel(started, now)} · ${timeOfDay(started)}`;
}

export function sessionStatus(
  manifest: SessionManifest,
  recordingId: string | null,
): Badge {
  switch (manifest.status) {
    case "completed":
      return { key: "status", label: "Completed", tone: "good" };
    case "interrupted":
      return { key: "status", label: "Interrupted", tone: "warn" };
    default:
      return manifest.session_id === recordingId
        ? { key: "status", label: "Recording", tone: "rec" }
        : { key: "status", label: "Not finalized", tone: "warn" };
  }
}

export function sessionHeader(
  manifest: SessionManifest,
  now: number,
  recordingId: string | null,
): SessionHeader {
  const alerts: SessionAlert[] = [];
  if (manifest.status !== "completed") {
    alerts.push({
      key: "recovery",
      tone: "warn",
      title:
        manifest.status === "interrupted"
          ? `Interrupted recording${
              recoveryLabel(manifest) ? ` · ${recoveryLabel(manifest)}` : ""
            }`
          : "Not finalized",
      detail:
        recoveryNote(manifest) ??
        "This session was not finalized. Its data is incomplete and no summary was calculated.",
    });
  }
  if (manifest.recorder_dropped_frames > 0) {
    alerts.push({
      key: "drops",
      tone: "bad",
      title: "Recorder dropped frames",
      detail: `${integer(manifest.recorder_dropped_frames)} frames were dropped by the recorder; this session is not a complete dataset.`,
    });
  }
  return {
    title: sessionTitle(manifest, now),
    status: sessionStatus(manifest, recordingId),
    facts: [
      fact("duration", "Duration", duration(manifest.duration_us / 1_000_000)),
      fact("vehicle", "Vehicle", manifest.vehicle_id ?? UNAVAILABLE),
      fact("game", "Game", gameName(manifest.game) ?? manifest.game ?? "—"),
      fact("frames", "Frames", integer(manifest.frame_count)),
      fact(
        "drops",
        "Recorder drops",
        integer(manifest.recorder_dropped_frames),
      ),
    ],
    alerts,
  };
}

// ------------------------------------------------------ analysis status

export interface LifecycleView extends AnalysisBanner {
  tone: Tone;
  /// "Loading", "Queued", "Analyzing", "Available", "Not analyzed", "Failed",
  /// "Unsupported" — the short pill text.
  short: string;
  loading: boolean;
}

/// The lifecycle as the header pill and the state panels show it. The
/// sentences come from `analysisBanner`, unchanged in meaning.
export function lifecycle(
  analysis: SessionAnalysisState | null,
  error: string | null,
): LifecycleView {
  const banner = analysisBanner(analysis, error);
  if (error != null) {
    return { ...banner, tone: "bad", short: "Unavailable", loading: false };
  }
  if (analysis == null) {
    return { ...banner, tone: "neutral", short: "Loading", loading: true };
  }
  switch (banner.state) {
    case "available":
      return { ...banner, tone: "good", short: "Available", loading: false };
    case "queued":
      return { ...banner, tone: "neutral", short: "Queued", loading: false };
    case "analyzing":
      return { ...banner, tone: "neutral", short: "Analyzing", loading: false };
    case "not_analyzed":
      return {
        ...banner,
        tone: "neutral",
        short: "Not analyzed",
        loading: false,
      };
    case "unsupported_schema":
      return { ...banner, tone: "warn", short: "Unsupported", loading: false };
    default:
      return { ...banner, tone: "bad", short: "Failed", loading: false };
  }
}

// -------------------------------------------------------------- summary

/// Figures from the manifest's own summary, written when the session
/// completed. Separate from the analysis on purpose: an interrupted or
/// unanalyzed session still has (or explicitly lacks) these.
export function sessionFigures(manifest: SessionManifest): Fact[] {
  const summary = manifest.summary;
  return [
    fact(
      "distance",
      "Distance",
      summary?.distance_meters == null
        ? UNAVAILABLE
        : `${kilometres(summary.distance_meters, 2)} km`,
    ),
    fact(
      "max-speed",
      "Max speed",
      summary?.max_speed_kmh == null
        ? UNAVAILABLE
        : `${value(summary.max_speed_kmh)} km/h`,
    ),
    fact(
      "avg-speed",
      "Average speed",
      summary?.average_speed_kmh == null
        ? UNAVAILABLE
        : `${value(summary.average_speed_kmh)} km/h`,
    ),
    fact("max-rpm", "Max RPM", value(summary?.max_rpm, 0)),
    fact("avg-rpm", "Average RPM", value(summary?.average_rpm, 0)),
    fact(
      "throttle",
      "Full throttle",
      summary
        ? `${value(summary.full_throttle_seconds)} s · ${value(
            summary.full_throttle_percent,
          )}%`
        : UNAVAILABLE,
    ),
    fact(
      "braking",
      "Braking",
      summary
        ? `${value(summary.braking_seconds)} s · ${value(
            summary.braking_percent,
          )}%`
        : UNAVAILABLE,
    ),
    fact("gear-changes", "Gear changes", value(summary?.gear_change_count, 0)),
  ];
}

/// Analysis-only figures that V1.0 computed and never showed.
export function analysisFigures(analysis: SessionAnalysis): Fact[] {
  const summary = analysis.driving_summary;
  const coverage = analysis.coverage;
  const quality = analysis.data_quality;
  const acceleration = (raw: number | null) =>
    raw == null
      ? UNAVAILABLE
      : `${signed(raw, 1)}\u00a0m/s² · ${signed(Number(gForce(raw, 2)), 2)}\u00a0g`;
  return [
    fact(
      "analyzed",
      "Analyzed time",
      `${elapsed(coverage.analyzed_seconds)} of ${elapsed(
        coverage.recorded_seconds,
      )}`,
    ),
    fact(
      "max-accel",
      "Max longitudinal acceleration",
      quality.speed_available
        ? acceleration(summary.max_longitudinal_acceleration_mps2)
        : UNAVAILABLE,
    ),
    fact(
      "max-decel",
      "Max longitudinal deceleration",
      quality.speed_available
        ? acceleration(summary.max_longitudinal_deceleration_mps2)
        : UNAVAILABLE,
    ),
    fact(
      "hard-braking",
      "Hard braking time",
      quality.controls_available
        ? `${number(summary.hard_braking_seconds, 1)} s`
        : UNAVAILABLE,
    ),
    fact(
      "slip-time",
      "Time above a slip threshold",
      quality.wheel_telemetry_available
        ? `${number(summary.slip_episode_seconds, 1)} s`
        : UNAVAILABLE,
    ),
  ];
}

/// Which recorded channel each event kind depends on. A kind whose channel was
/// not recorded has no count — not a count of zero.
const EVENT_CHANNEL: Record<
  EventKind,
  "controls_available" | "speed_available" | "suspension_available"
> = {
  full_throttle: "controls_available",
  braking: "controls_available",
  hard_braking: "controls_available",
  rapid_throttle_lift: "controls_available",
  strong_acceleration: "speed_available",
  strong_deceleration: "speed_available",
  high_suspension_compression: "suspension_available",
  high_suspension_extension: "suspension_available",
};

export function eventChannelAvailable(
  analysis: SessionAnalysis,
  kind: EventKind,
): boolean {
  return analysis.data_quality[EVENT_CHANNEL[kind]];
}

export interface KindCount {
  kind: EventKind;
  label: string;
  /// Every detected event, including any the output cap did not store.
  count: number;
  /// How many of them the analysis stored (and the tables can list).
  stored: number;
  available: boolean;
  text: string;
}

/// `events_by_kind`, in presentation order, with the stored row count beside
/// it so a cap is visible instead of silent.
export function kindCounts(analysis: SessionAnalysis): KindCount[] {
  const totals = new Map(
    analysis.driving_summary.events_by_kind.map((item) => [
      item.kind,
      item.count,
    ]),
  );
  return EVENT_ORDER.map((kind) => {
    const stored = analysis.events.filter(
      (event) => event.kind === kind,
    ).length;
    const count = totals.get(kind) ?? stored;
    const available = eventChannelAvailable(analysis, kind);
    return {
      kind,
      label: EVENT_LABELS[kind],
      count,
      stored,
      available,
      text: available ? integer(count) : UNAVAILABLE,
    };
  });
}

/// What the event cap did, worded for what it is. `max_events` is a limit
/// PER EVENT KIND (`analysis_engine::push_event`): each kind stores up to that
/// many rows and counts the rest, so one busy kind never crowds out another,
/// and the stored total may exceed `max_events`. Only the kinds that passed
/// their own limit are named, each with its counted and listed figures. Null
/// when nothing was omitted.
export function eventCapNote(analysis: SessionAnalysis): string | null {
  const omitted = analysis.data_quality.events_truncated;
  const kinds = kindCounts(analysis).filter(
    (kind) => kind.available && kind.count > kind.stored,
  );
  if (omitted === 0 && kinds.length === 0) return null;
  const limit = `RaceLab stores up to ${integer(analysis.config.max_events)} events per event kind`;
  if (kinds.length === 0) {
    // Omitted events were reported without a per-kind breakdown to match.
    return `${limit}; ${integer(omitted)} detected events were over their kind's limit and not stored. Counts include them; the Events tab lists stored events only.`;
  }
  const detail = kinds
    .map(
      (kind) =>
        `${kind.label}: ${integer(kind.count)} counted, ${integer(kind.stored)} listed`,
    )
    .join("; ");
  return `${limit}. ${
    kinds.length === 1 ? "One kind" : `${kinds.length} kinds`
  } passed that limit — ${detail}. Counts include every detected event; the Events tab lists stored events only.`;
}

export interface SegmentCount {
  key: "turns" | "slip";
  label: string;
  text: string;
  available: boolean;
}

export function segmentCounts(analysis: SessionAnalysis): SegmentCount[] {
  const quality = analysis.data_quality;
  const summary = analysis.driving_summary;
  return [
    {
      key: "turns",
      label: "Turn segments",
      available: quality.orientation_available,
      text: quality.orientation_available
        ? integer(summary.turn_segment_count)
        : UNAVAILABLE,
    },
    {
      key: "slip",
      label: "Slip episodes",
      available: quality.wheel_telemetry_available,
      text: quality.wheel_telemetry_available
        ? integer(summary.slip_episode_count)
        : UNAVAILABLE,
    },
  ];
}

/// Tab counts: shown only once an analysis is available, and only for a
/// channel that was recorded.
export function tabCounts(
  analysis: SessionAnalysis | null,
): Partial<Record<"events" | "turns" | "slip", string>> {
  if (analysis == null) return {};
  const quality = analysis.data_quality;
  return {
    events: integer(analysis.driving_summary.event_count),
    ...(quality.orientation_available
      ? { turns: integer(analysis.driving_summary.turn_segment_count) }
      : {}),
    ...(quality.wheel_telemetry_available
      ? { slip: integer(analysis.driving_summary.slip_episode_count) }
      : {}),
  };
}

// ------------------------------------------------------------ data tab

export interface FactGroup {
  key: string;
  title: string;
  facts: Fact[];
}

const COMPLETION_REASONS: Record<string, string> = {
  grace_expired: "Telemetry stopped and the session ended",
  vehicle_or_game_changed: "Vehicle or game changed",
  recorder_write_error: "The recorder could not write",
  recorder_stopped_before_completion:
    "RaceLab stopped before the session ended",
  interrupted_racelab_did_not_finalize:
    "RaceLab did not finalize the recording",
};

export function completionReason(reason: string | null): string {
  if (reason == null) return UNAVAILABLE;
  return COMPLETION_REASONS[reason] ?? reason;
}

function yesNo(flag: boolean, yes: string, no: string): string {
  return flag ? yes : no;
}

export function recordingFacts(manifest: SessionManifest): FactGroup[] {
  const summary = manifest.summary;
  const groups: FactGroup[] = [
    {
      key: "recording",
      title: "Recording",
      facts: [
        fact("status", "Status", sessionStatus(manifest, null).label),
        fact(
          "reason",
          "How it ended",
          completionReason(manifest.completion_reason),
        ),
        fact("started", "Started", clockTime(manifest.started_at_unix_ms)),
        fact("ended", "Ended", clockTime(manifest.ended_at_unix_ms)),
        fact(
          "duration",
          "Duration",
          duration(manifest.duration_us / 1_000_000),
        ),
        fact(
          "measured",
          "Measured time",
          summary ? duration(summary.measured_seconds) : UNAVAILABLE,
        ),
        fact("frames", "Frames", integer(manifest.frame_count)),
        fact("active", "Active frames", integer(manifest.active_frame_count)),
        fact(
          "inactive",
          "Inactive frames",
          integer(manifest.inactive_frame_count),
        ),
        fact(
          "drops",
          "Recorder drops",
          integer(manifest.recorder_dropped_frames),
        ),
        fact(
          "complete",
          "Summary data",
          summary
            ? yesNo(summary.data_quality.complete, "Complete", "Incomplete")
            : "No summary",
        ),
        fact(
          "gaps",
          "Excluded gaps",
          summary ? integer(summary.data_quality.excluded_gaps) : UNAVAILABLE,
        ),
      ],
    },
  ];
  const recovery = manifest.recovery;
  if (manifest.status === "interrupted" && recovery != null) {
    groups.push({
      key: "recovery",
      title: "Recovery",
      facts: [
        fact("outcome", "Outcome", recoveryLabel(manifest) ?? UNAVAILABLE),
        fact("scanned", "Checked", clockTime(recovery.scanned_at_unix_ms)),
        fact(
          "readable",
          "Readable frames",
          integer(recovery.readable_frame_count),
        ),
        fact(
          "readable-active",
          "Readable active frames",
          integer(recovery.readable_active_frame_count),
        ),
        fact(
          "readable-duration",
          "Readable duration",
          duration(recovery.readable_duration_us / 1_000_000),
        ),
        fact(
          "stream",
          "Frame stream",
          yesNo(recovery.frame_stream_complete, "Complete", "Incomplete"),
        ),
        fact(
          "tail",
          "Unreadable tail",
          recovery.unreadable_tail_bytes > 0
            ? bytes(recovery.unreadable_tail_bytes)
            : "None",
        ),
        ...(recovery.detail
          ? [fact("detail", "Detail", recovery.detail, true)]
          : []),
      ],
    });
  }
  return groups;
}

export function analysisFacts(state: SessionAnalysisState | null): FactGroup[] {
  if (state == null) return [];
  const analysis = state.state === "available" ? state.analysis : null;
  const job: Fact[] = [
    ...analysisJobLines(state).map((line) =>
      fact(line.key, line.label, line.value),
    ),
  ];
  if (analysis) {
    job.unshift(
      fact("analyzed-at", "Analyzed", clockTime(analysis.analyzed_at_unix_ms)),
    );
  }
  const groups: FactGroup[] = [];
  if (job.length > 0)
    groups.push({ key: "job", title: "Analysis", facts: job });
  if (analysis) {
    const quality = analysis.data_quality;
    const summary = analysis.driving_summary;
    groups.push({
      key: "quality",
      title: "What the analysis could see",
      facts: [
        // `QualityLine.available` means "nothing to flag", not "a value
        // exists": "Incomplete (no footer)" or "3" discontinuities are facts
        // that must be read out, so they become attention, never unavailable.
        ...qualityLines(analysis).map((line) => ({
          key: line.key,
          label: line.label,
          value: line.value,
          available: line.value !== UNAVAILABLE,
          attention: !line.available,
        })),
        {
          ...fact(
            "slip-truncated",
            "Slip episodes omitted by the cap",
            integer(quality.slip_episodes_truncated),
          ),
          attention: quality.slip_episodes_truncated > 0,
        },
        {
          ...fact(
            "turns-truncated",
            "Turn segments omitted by the cap",
            integer(quality.turn_segments_truncated),
          ),
          attention: quality.turn_segments_truncated > 0,
        },
        fact(
          "inactive-intervals",
          "Inactive intervals",
          `${integer(analysis.coverage.inactive_interval_count)} · ${number(
            analysis.coverage.inactive_interval_seconds,
            1,
          )} s`,
        ),
      ],
    });
    groups.push({
      key: "totals",
      title: "Analysis totals",
      facts: [
        fact(
          "throttle",
          "Full throttle time",
          quality.controls_available
            ? `${number(summary.full_throttle_seconds, 1)} s`
            : UNAVAILABLE,
        ),
        fact(
          "braking",
          "Braking time",
          quality.controls_available
            ? `${number(summary.braking_seconds, 1)} s`
            : UNAVAILABLE,
        ),
        fact(
          "max-speed",
          "Max speed",
          summary.max_speed_mps == null
            ? UNAVAILABLE
            : `${speedKmh(summary.max_speed_mps, 1)} km/h`,
        ),
      ],
    });
  }
  return groups;
}

/// Machine identifiers and format versions: useful when reporting a problem,
/// so they are kept — here, labelled, and nowhere else in the workspace.
export function technicalFacts(
  manifest: SessionManifest,
  state: SessionAnalysisState | null,
): FactGroup {
  const analysis = state?.state === "available" ? state.analysis : null;
  return {
    key: "technical",
    title: "Technical",
    facts: [
      fact("id", "Session ID", manifest.session_id, true),
      fact(
        "created-by",
        "Recorded by RaceLab",
        manifest.created_by_racelab_version,
        true,
      ),
      ...(manifest.recovery
        ? [
            fact(
              "recovered-by",
              "Checked by RaceLab",
              manifest.recovery.recovered_by_racelab_version,
              true,
            ),
          ]
        : []),
      ...(analysis
        ? [
            fact(
              "analyzed-by",
              "Analyzed by RaceLab",
              analysis.analyzed_by_racelab_version,
              true,
            ),
          ]
        : []),
      fact("manifest", "Manifest schema", `v${manifest.schema_version}`, true),
      fact(
        "frame-format",
        "Frame format",
        `v${manifest.frame_format_version}`,
        true,
      ),
      fact(
        "frame-schema",
        "Telemetry frame schema",
        `v${manifest.telemetry_frame_schema_version}`,
        true,
      ),
      fact(
        "analysis-schema",
        "Analysis schema",
        state?.analysis_schema_version == null
          ? UNAVAILABLE
          : `v${state.analysis_schema_version} (this build reads v${state.supported_analysis_schema_version})`,
        true,
      ),
    ],
  };
}

/// The definitions behind the figures: the manifest summary's own two, then
/// the analysis heuristics read from the configuration that produced it.
export function definitions(analysis: SessionAnalysis | null): string[] {
  return [
    "Session figures: full throttle is normalized throttle ≥ 0.95 and braking is normalized brake > 0.05. Averages are time-weighted over monotonic frame timing.",
    ...heuristicNotes(analysis),
  ];
}
