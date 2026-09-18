export type StatsSnapshot = {
  revision: number;
  session_id: number;
  running: boolean;
  bound_port: number | null;
  /** SO_RCVBUF readback, not a measurement of kernel queue capacity. */
  receive_buffer_bytes: number | null;
  total_packets: number;
  packets_per_second: number;
  total_bytes: number;
  last_packet_size: number | null;
  last_source: string | null;
  last_packet_timestamp_ms: number | null;
  last_packet_monotonic_us: number | null;
  preview_hex: string;
  receive_errors: number;
  last_error: string | null;
};

export type TelemetryState = {
  stats: StatsSnapshot | null;
  connected: boolean;
  connectionError: string | null;
};

export const initialTelemetryState: TelemetryState = {
  stats: null,
  connected: false,
  connectionError: null,
};

type Action =
  | { type: "snapshot"; snapshot: StatsSnapshot }
  | { type: "connectionFailure"; message: string };

export function telemetryReducer(
  state: TelemetryState,
  action: Action,
): TelemetryState {
  if (action.type === "connectionFailure") {
    // A late initial-query rejection must not overwrite a successful event.
    return state.connected
      ? state
      : { ...state, connectionError: action.message };
  }
  return {
    stats:
      !state.stats || action.snapshot.revision > state.stats.revision
        ? action.snapshot
        : state.stats,
    connected: true,
    connectionError: null,
  };
}
