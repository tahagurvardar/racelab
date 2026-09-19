export interface LiveSnapshot {
  revision: number;
  valid_packets: number;
  invalid_packets: number;
  valid_active_fh6: number;
  valid_inactive_fh6: number;
  invalid_fh6: number;
  unknown_protocol: number;
  stale: boolean;
  connection:
    | "STARTING"
    | "LISTENING"
    | "PROBING"
    | "CONNECTED_IDLE"
    | "SESSION_ACTIVE"
    | "GRACE"
    | "DISCONNECTED"
    | "DEGRADED"
    | "ERROR";
  health: "GOOD" | "DEGRADED" | "LOST";
  protocol: string | null;
  protocol_confidence: number;
  input_packet_hz: number;
  valid_frame_hz: number;
  last_packet_age_ms: number | null;
  last_valid_frame_age_ms: number | null;
  receive_errors: number;
  transport_error: string | null;
  grace_period_ms: number;
  hub: {
    published: number;
    recent_frames: number;
    ring_capacity: number;
    ring_evictions: number;
    subscribers: number;
    subscriber_drops: number;
  };
  session: {
    id: string;
    started_at: number | null;
    duration_ms: number;
    game: string | null;
    vehicle_id: string | null;
    state: "ACTIVE" | "GRACE" | "COMPLETED";
    grace_remaining_ms: number | null;
    ended_reason: string | null;
  } | null;
  frame: {
    active: boolean;
    speed_mps: number | null;
    engine: { rpm: number | null };
    controls: {
      throttle: number | null;
      brake: number | null;
      steering: number | null;
    };
    gear: {
      kind: "unknown" | "reverse" | "neutral" | "forward" | "unmapped";
      value?: number;
    } | null;
    sourceSpecific: { fh6?: { gear: number } } | null;
  } | null;
  issues: { field: string; offset: number; reason: string }[];
}

export function newerLive(
  current: LiveSnapshot | null,
  incoming: LiveSnapshot,
): LiveSnapshot {
  return !current || incoming.revision > current.revision ? incoming : current;
}

export function liveMetrics(
  snapshot: LiveSnapshot | null,
  listenerRunning: boolean,
) {
  const frame = listenerRunning && !snapshot?.stale ? snapshot?.frame : null;
  const percent = (value: number | null | undefined) =>
    value == null ? "—" : (value * 100).toFixed(1);
  return {
    speed: frame?.speed_mps == null ? "—" : (frame.speed_mps * 3.6).toFixed(1),
    rpm: frame?.engine.rpm == null ? "—" : frame.engine.rpm.toFixed(0),
    gear:
      frame?.active && frame.sourceSpecific?.fh6?.gear != null
        ? String(frame.sourceSpecific.fh6.gear)
        : "—",
    throttle: percent(frame?.controls.throttle),
    brake: percent(frame?.controls.brake),
    steering: percent(frame?.controls.steering),
  };
}

export function connectionLabel(
  state: LiveSnapshot["connection"] | undefined,
): string {
  switch (state) {
    case "STARTING":
      return "Starting listener…";
    case "PROBING":
      return "Detecting…";
    case "CONNECTED_IDLE":
      return "Forza Horizon 6 Connected";
    case "SESSION_ACTIVE":
      return "Session Active";
    case "GRACE":
      return "Grace · waiting for telemetry to resume";
    case "DISCONNECTED":
      return "Disconnected · waiting for game";
    case "DEGRADED":
      return "Telemetry degraded";
    case "ERROR":
      return "Connection error";
    default:
      return "Waiting for game";
  }
}
