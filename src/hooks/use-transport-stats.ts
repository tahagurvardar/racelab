import { useEffect, useReducer } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  initialTelemetryState,
  telemetryReducer,
  type StatsSnapshot,
  type TelemetryState,
} from "../telemetry-state.ts";

/// V0.2.2 transport counters arrive as 4 Hz backend events, not by polling.
/// Subscribing before the initial query supports remount and reload; a late
/// rejected query cannot undo a successful event.
export function useTransportStats(): TelemetryState & {
  apply: (snapshot: StatsSnapshot) => void;
} {
  const [state, dispatch] = useReducer(telemetryReducer, initialTelemetryState);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    async function subscribe() {
      try {
        const cleanup = await listen<StatsSnapshot>(
          "telemetry://stats",
          (event) => {
            if (!disposed)
              dispatch({ type: "snapshot", snapshot: event.payload });
          },
        );
        if (disposed) {
          cleanup();
          return;
        }
        unlisten = cleanup;
        const snapshot = await invoke<StatsSnapshot>("get_telemetry_stats");
        if (!disposed) dispatch({ type: "snapshot", snapshot });
      } catch (reason) {
        if (!disposed)
          dispatch({ type: "connectionFailure", message: String(reason) });
      }
    }
    void subscribe();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return {
    ...state,
    apply: (snapshot: StatsSnapshot) =>
      dispatch({ type: "snapshot", snapshot }),
  };
}
