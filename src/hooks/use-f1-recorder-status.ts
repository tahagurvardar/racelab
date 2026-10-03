import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { startLatestPolling } from "../latest-poller.ts";
import type { F1RecorderStatus } from "../f1-sessions.ts";
import {
  f1RecorderFailed,
  f1RecorderReceived,
  f1RecorderStore,
  type F1RecorderState,
} from "../state/stores.ts";
import { useStore } from "../state/use-store.ts";

/// F1 25 recording status: a status indicator, read at the FH6 recorder's
/// 2 Hz.
export const F1_RECORDER_POLL_INTERVAL_MS = 500;

/// Owner of the F1 25 recorder loop. Mounted once, above the workspace
/// switch, beside the FH6 recorder loop: the top bar's REC indicator needs
/// both on every view.
export function useF1RecorderStatus(): void {
  useEffect(
    () =>
      startLatestPolling(
        () => invoke<F1RecorderStatus>("get_f1_recorder_status"),
        (incoming) =>
          f1RecorderStore.update((state) =>
            f1RecorderReceived(state, incoming),
          ),
        (reason) =>
          f1RecorderStore.update((state) => f1RecorderFailed(state, reason)),
        F1_RECORDER_POLL_INTERVAL_MS,
      ),
    [],
  );
}

/// Reader; see `useLive`.
export function useF1Recorder<S>(select: (state: F1RecorderState) => S): S {
  return useStore(f1RecorderStore, select);
}
