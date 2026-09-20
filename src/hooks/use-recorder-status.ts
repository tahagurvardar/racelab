import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { startLatestPolling } from "../latest-poller.ts";
import { newerRecorder, type RecorderStatus } from "../session-state.ts";

/// Recorder status is a status indicator, not telemetry. It is read at 2 Hz.
export const RECORDER_POLL_INTERVAL_MS = 500;

export interface RecorderState {
  recorder: RecorderStatus | null;
  error: string | null;
}

/// Mounted once, above the view switch: the global status bar needs the
/// recording indicator on every view, and the Sessions view must not start a
/// second loop when it is opened.
export function useRecorderStatus(): RecorderState {
  const [recorder, setRecorder] = useState<RecorderStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      startLatestPolling(
        () => invoke<RecorderStatus>("get_recorder_status"),
        (incoming) => {
          setError(null);
          setRecorder((current) => newerRecorder(current, incoming));
        },
        (reason) => setError(String(reason)),
        RECORDER_POLL_INTERVAL_MS,
      ),
    [],
  );

  return { recorder, error };
}
