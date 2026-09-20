/// The `get_live_telemetry` contract (`live_telemetry::LiveSnapshot`) plus the
/// ordering rule the UI applies to it. Connection/session semantics are owned
/// by the backend; the frontend only presents them.
import type { TelemetryFrame } from "./frame.ts";

export type ConnectionState =
  | "STARTING"
  | "LISTENING"
  | "PROBING"
  | "CONNECTED_IDLE"
  | "SESSION_ACTIVE"
  | "GRACE"
  | "DISCONNECTED"
  | "DEGRADED"
  | "ERROR";

export type Health = "GOOD" | "DEGRADED" | "LOST";

export type SessionState = "ACTIVE" | "GRACE" | "COMPLETED";

export interface LiveSession {
  id: string;
  started_at: number | null;
  duration_ms: number;
  game: string | null;
  vehicle_id: string | null;
  state: SessionState;
  grace_remaining_ms: number | null;
  ended_reason: string | null;
}

export interface HubStats {
  published: number;
  recent_frames: number;
  ring_capacity: number;
  ring_evictions: number;
  subscribers: number;
  subscriber_drops: number;
  last_drop_ms: number | null;
}

export interface ValidationIssue {
  field: string;
  offset: number;
  reason: string;
}

export interface LiveSnapshot {
  revision: number;
  connection: ConnectionState;
  health: Health;
  protocol: string | null;
  protocol_confidence: number;
  valid_packets: number;
  invalid_packets: number;
  valid_active_fh6: number;
  valid_inactive_fh6: number;
  invalid_fh6: number;
  unknown_protocol: number;
  input_packet_hz: number;
  valid_frame_hz: number;
  last_packet_age_ms: number | null;
  last_valid_frame_age_ms: number | null;
  receive_errors: number;
  /// Backend-owned freshness verdict. When true the backend has already
  /// withheld `frame`; the UI must not resurrect the previous one.
  stale: boolean;
  frame: TelemetryFrame | null;
  issues: ValidationIssue[];
  transport_error: string | null;
  session: LiveSession | null;
  hub: HubStats;
  grace_period_ms: number;
}

/// Snapshots may complete out of order across an await boundary. Only a newer
/// revision replaces the current one, so a late reply cannot revive telemetry
/// the backend has since withdrawn.
export function newerLive(
  current: LiveSnapshot | null,
  incoming: LiveSnapshot,
): LiveSnapshot {
  return !current || incoming.revision > current.revision ? incoming : current;
}
