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
