import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { StatsSnapshot, TelemetryState } from "../telemetry-state.ts";
import {
  transportFailed,
  transportReceived,
  transportStore,
} from "../state/stores.ts";
import { useStore } from "../state/use-store.ts";

/// V0.2.2 transport counters arrive as 4 Hz backend events, not by polling.
/// Subscribing before the initial query supports remount and reload; a late
/// rejected query cannot undo a successful event.
export function useTransportStats(): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    async function subscribe() {
      try {
        const cleanup = await listen<StatsSnapshot>(
          "telemetry://stats",
          (event) => {
            if (!disposed)
              transportStore.update((state) =>
                transportReceived(state, event.payload),
              );
          },
        );
        if (disposed) {
          cleanup();
          return;
        }
        unlisten = cleanup;
        const snapshot = await invoke<StatsSnapshot>("get_telemetry_stats");
        if (!disposed)
          transportStore.update((state) => transportReceived(state, snapshot));
      } catch (reason) {
        if (!disposed)
          transportStore.update((state) =>
            transportFailed(state, String(reason)),
          );
      }
    }
    void subscribe();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}

/// Reader; see `useLive`.
export function useTransport<S>(select: (state: TelemetryState) => S): S {
  return useStore(transportStore, select);
}
