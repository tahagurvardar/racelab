import { integer } from "./telemetry/formatting.ts";

export interface RecorderStatus {
  revision: number;
  status: "idle" | "recording" | "error";
  recording: boolean;
  sessions_directory: string;
  session_id: string | null;
  session_directory: string | null;
  game: string | null;
  vehicle_id: string | null;
  started_at_unix_ms: number | null;
  duration_ms: number;
  frames_written: number;
  active_frames: number;
  inactive_frames: number;
  queued_frames: number;
  /// Current (or most recent) session only; drives the user-facing loss warning.
  recorder_dropped_frames: number;
  /// Process-lifetime diagnostic total; never drives the loss warning.
  lifetime_dropped_frames: number;
  queue_capacity: number;
  last_completed_session_id: string | null;
  completed_sessions: number;
  last_error: string | null;
}

export interface SessionSummary {
  duration_seconds: number;
  measured_seconds: number;
  frame_count: number;
  max_speed_kmh: number | null;
  average_speed_kmh: number | null;
  max_rpm: number | null;
  average_rpm: number | null;
  full_throttle_seconds: number;
  full_throttle_percent: number | null;
  braking_seconds: number;
  braking_percent: number | null;
  gear_change_count: number | null;
  distance_meters: number | null;
  data_quality: {
    recorder_dropped_frames: number;
    complete: boolean;
    excluded_gaps: number;
  };
}

/// What a recovery scan concluded about an interrupted recording, as
/// `src-tauri/src/session_format.rs` serializes it.
export type RecoveryOutcome =
  | "pending"
  | "complete"
  | "truncated"
  | "damaged"
  | "unreadable";

export interface RecoveryRecord {
  outcome: RecoveryOutcome;
  scanned_at_unix_ms: number | null;
  readable_frame_count: number;
  readable_active_frame_count: number;
  readable_duration_us: number;
  frame_stream_complete: boolean;
  unreadable_tail_bytes: number;
  detail: string | null;
  recovered_by_racelab_version: string;
}

export interface SessionManifest {
  schema_version: number;
  session_id: string;
  status: "recording" | "completed" | "interrupted";
  game: string | null;
  protocol: string | null;
  vehicle_id: string | null;
  started_at_unix_ms: number | null;
  ended_at_unix_ms: number | null;
  duration_us: number;
  frame_count: number;
  active_frame_count: number;
  inactive_frame_count: number;
  recorder_dropped_frames: number;
  completion_reason: string | null;
  frame_file: string;
  frame_format_version: number;
  telemetry_frame_schema_version: number;
  summary: SessionSummary | null;
  created_by_racelab_version: string;
  /// Present only for an interrupted session, and absent from every manifest
  /// written before V0.10. Optional here for exactly that reason.
  recovery?: RecoveryRecord | null;
}

/// Storage retention, as `session_retention.rs` serializes it.
export interface RetentionStatus {
  budget_bytes: number;
  enabled: boolean;
  used_bytes: number;
  over_budget: boolean;
  retained_sessions: number;
  protected_sessions: number;
  unidentifiable_sessions: number;
  unidentifiable_bytes: number;
  deleted_sessions: number;
  reclaimed_bytes: number;
  failed_deletions: number;
  sweeps: number;
  last_sweep_unix_ms: number | null;
  last_deleted_session_id: string | null;
  last_error: string | null;
}

/// Interrupted-session recovery, as `session_recovery.rs` serializes it.
export interface RecoveryStatus {
  reclassified: number;
  pending: number;
  scanned: number;
  complete: number;
  truncated: number;
  damaged: number;
  unreadable: number;
  recovered_frames: number;
  running: boolean;
  last_session_id: string | null;
  last_error: string | null;
}

export interface StorageStatus {
  retention: RetentionStatus;
  recovery: RecoveryStatus;
}

export interface RecentSessions {
  sessions: SessionManifest[];
  unreadable: number;
  directory: string;
  limit: number;
}

export function newerRecorder(
  current: RecorderStatus | null,
  incoming: RecorderStatus,
): RecorderStatus {
  return !current || incoming.revision > current.revision ? incoming : current;
}

/// An unavailable measurement renders as an em dash. A real zero renders as 0:
/// V0.6 never turns "not measured" into a number.
export function value(
  raw: number | null | undefined,
  digits = 1,
  suffix = "",
): string {
  return raw == null ? "—" : `${raw.toFixed(digits)}${suffix}`;
}

export function duration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

export function clockTime(unixMs: number | null | undefined): string {
  return unixMs == null ? "—" : new Date(unixMs).toLocaleString();
}

export function statusLabel(status: SessionManifest["status"]): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "interrupted":
      return "Interrupted · incomplete";
    default:
      return "Recording";
  }
}

/// Bytes as a figure a person reads. Binary units, because that is what a disk
/// budget is expressed in.
export function bytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = Math.max(0, value);
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/// What a recovery scan found, in a sentence a driver can act on.
///
/// Every one of these says the same two things in different words: how much of
/// the recording survived, and that it is not a complete session. Neither may
/// ever be left implied.
export function recoveryNote(manifest: SessionManifest): string | null {
  const recovery = manifest.recovery;
  if (manifest.status !== "interrupted") return null;
  if (recovery == null) {
    return "RaceLab did not finish this recording. It has not been checked, so how much of it is readable is not yet known.";
  }
  const frames = integer(recovery.readable_frame_count);
  switch (recovery.outcome) {
    case "pending":
      return "RaceLab did not finish this recording. It is being checked to see how much of it can be read.";
    case "complete":
      return `RaceLab did not finish this recording, but its telemetry is intact: all ${frames} recorded frames were read. No session summary was calculated, because the session never ended normally.`;
    case "truncated":
      return `RaceLab did not finish this recording. ${frames} frames were recovered and are intact; anything after them never reached the disk.`;
    case "damaged":
      return `This recording is damaged part-way through. The first ${frames} frames were read and are intact; the rest could not be read.`;
    default:
      return "This recording could not be read at all. The session directory is kept so nothing is deleted without you knowing, but it holds no usable telemetry.";
  }
}

/// A one-line badge for the sessions list.
export function recoveryLabel(manifest: SessionManifest): string | null {
  const recovery = manifest.recovery;
  if (manifest.status !== "interrupted") return null;
  if (recovery == null) return "not checked";
  switch (recovery.outcome) {
    case "pending":
      return "checking";
    case "complete":
      return "fully recovered";
    case "truncated":
      return `${integer(recovery.readable_frame_count)} frames recovered`;
    case "damaged":
      return "damaged";
    default:
      return "unreadable";
  }
}

/// How retention is doing, in one sentence, or `null` when there is nothing
/// worth saying.
///
/// Retention deletes recordings, so it is never silent: the sentence names the
/// budget, what is being used, and what has been removed.
export function retentionNote(status: RetentionStatus | null): string | null {
  if (status == null) return null;
  if (!status.enabled) {
    return `Storage limit off. ${bytes(status.used_bytes)} of recordings kept across ${integer(status.retained_sessions)} session(s); RaceLab will not delete anything.`;
  }
  const base = `${bytes(status.used_bytes)} of ${bytes(status.budget_bytes)} used across ${integer(status.retained_sessions)} session(s).`;
  const removed =
    status.deleted_sessions > 0
      ? ` ${integer(status.deleted_sessions)} oldest session(s) deleted this run, freeing ${bytes(status.reclaimed_bytes)}.`
      : "";
  const held = status.over_budget
    ? " Over the limit: the sessions that would be next are still in use, so nothing more was deleted."
    : "";
  return `${base}${removed}${held}`;
}

/// Newest first is produced by the backend; this keeps the UI honest if a
/// listing ever arrives out of order.
export function orderSessions(sessions: SessionManifest[]): SessionManifest[] {
  return [...sessions].sort(
    (a, b) =>
      (b.started_at_unix_ms ?? 0) - (a.started_at_unix_ms ?? 0) ||
      b.session_id.localeCompare(a.session_id),
  );
}

export function sessionRow(manifest: SessionManifest) {
  const summary = manifest.summary;
  return {
    id: manifest.session_id,
    started: clockTime(manifest.started_at_unix_ms),
    game: manifest.game ?? "—",
    vehicle: manifest.vehicle_id ?? "—",
    duration: duration(manifest.duration_us / 1_000_000),
    maxSpeed: value(summary?.max_speed_kmh),
    averageSpeed: value(summary?.average_speed_kmh),
    status: statusLabel(manifest.status),
    incomplete: manifest.status !== "completed",
    dropped: manifest.recorder_dropped_frames,
  };
}
