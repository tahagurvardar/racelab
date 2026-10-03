import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { startLatestPolling } from "../latest-poller.ts";
import type { LiveSnapshot } from "../telemetry/live-snapshot.ts";
import {
  liveFailed,
  liveReceived,
  liveStore,
  type LiveState,
} from "../state/stores.ts";
import { useStore } from "../state/use-store.ts";

/// Backend FH6 input runs at roughly 60-75 Hz. The UI deliberately does not:
/// it reads one latest snapshot at a time at 20 Hz, and `startLatestPolling`
/// schedules the next read only after the previous one settles, so a slow IPC
/// read can never build a backlog of queued frames.
export const LIVE_POLL_INTERVAL_MS = 50;

/// Owner of the live loop. Mounted once, above the workspace switch, so
/// changing views never starts a second polling loop or tears this one down.
///
/// It writes into `liveStore` rather than into component state: the shell that
/// owns the loop does not re-render at 20 Hz, only the components that read
/// live telemetry through `useLive` do.
export function useLiveTelemetry(): void {
  useEffect(
    () =>
      startLatestPolling(
        () => invoke<LiveSnapshot>("get_live_telemetry"),
        (incoming) =>
          liveStore.update((state) => liveReceived(state, incoming)),
        (reason) => liveStore.update((state) => liveFailed(state, reason)),
        LIVE_POLL_INTERVAL_MS,
      ),
    [],
  );
}

/// Reader. Re-renders the caller whenever the selected value changes, so a
/// caller that only needs a coarse fact should select it rather than the
/// whole snapshot.
export function useLive<S>(select: (state: LiveState) => S): S {
  return useStore(liveStore, select);
}
