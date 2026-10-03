import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { startLatestPolling } from "../latest-poller.ts";
import type { F1LiveStatus } from "../telemetry/f1-player.ts";
import {
  f1LiveFailed,
  f1LiveReceived,
  f1LiveStore,
  type F1LiveState,
} from "../state/stores.ts";
import { useStore } from "../state/use-store.ts";

/// The F1 25 Live read rate. F1 25 sends at the rate chosen in its menus
/// (20 Hz in the verified setup); the Live view needs a steady visual
/// refresh, not every packet, so it reads the latest values ten times a
/// second.
export const F1_LIVE_POLL_INTERVAL_MS = 100;

/// Once the backend has said this build runs no F1 25 listener, nothing will
/// change for the life of the process: the loop keeps its timer but stops
/// asking.
function read(): Promise<F1LiveStatus | null> {
  return f1LiveStore.get().available === false
    ? Promise.resolve(null)
    : invoke<F1LiveStatus>("get_f1_live");
}

/// Owner of the F1 25 Live loop. Mounted once, above the workspace switch,
/// like every other subscription. Components only read `f1LiveStore`; a
/// hidden F1 tab is not mounted and starts nothing.
export function useF1LiveTelemetry(): void {
  useEffect(
    () =>
      startLatestPolling(
        read,
        (incoming) =>
          f1LiveStore.update((state) =>
            incoming == null ? state : f1LiveReceived(state, incoming),
          ),
        (reason) => f1LiveStore.update((state) => f1LiveFailed(state, reason)),
        F1_LIVE_POLL_INTERVAL_MS,
      ),
    [],
  );
}

/// Reader; see `useLive`.
export function useF1Live<S>(select: (state: F1LiveState) => S): S {
  return useStore(f1LiveStore, select);
}
