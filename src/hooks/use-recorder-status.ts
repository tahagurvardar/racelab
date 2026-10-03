import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { startLatestPolling } from "../latest-poller.ts";
import type { RecorderStatus } from "../session-state.ts";
import {
  recorderFailed,
  recorderReceived,
  recorderStore,
  type RecorderState,
} from "../state/stores.ts";
import { useStore } from "../state/use-store.ts";

/// Recorder status is a status indicator, not telemetry. It is read at 2 Hz.
export const RECORDER_POLL_INTERVAL_MS = 500;

/// Owner of the recorder loop. Mounted once, above the workspace switch: the
/// top bar needs the recording indicator on every view, and the Sessions view
/// must not start a second loop when it is opened.
export function useRecorderStatus(): void {
  useEffect(
    () =>
      startLatestPolling(
        () => invoke<RecorderStatus>("get_recorder_status"),
        (incoming) =>
          recorderStore.update((state) => recorderReceived(state, incoming)),
        (reason) =>
          recorderStore.update((state) => recorderFailed(state, reason)),
        RECORDER_POLL_INTERVAL_MS,
      ),
    [],
  );
}

/// Reader; see `useLive`.
export function useRecorder<S>(select: (state: RecorderState) => S): S {
  return useStore(recorderStore, select);
}
