import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { startLatestPolling } from "../latest-poller.ts";
import { newerLive, type LiveSnapshot } from "../telemetry/live-snapshot.ts";

/// Backend FH6 input runs at roughly 60-75 Hz. The UI deliberately does not:
/// it reads one latest snapshot at a time at 20 Hz, and `startLatestPolling`
/// schedules the next read only after the previous one settles, so a slow IPC
/// read can never build a backlog of queued frames.
export const LIVE_POLL_INTERVAL_MS = 50;

export interface LiveTelemetry {
  snapshot: LiveSnapshot | null;
  error: string | null;
}

/// Mounted once, above the view switch, so changing dashboard views never
/// starts a second polling loop or tears this one down.
export function useLiveTelemetry(): LiveTelemetry {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      startLatestPolling(
        () => invoke<LiveSnapshot>("get_live_telemetry"),
        (incoming) => {
          setError(null);
          setSnapshot((current) => newerLive(current, incoming));
        },
        (reason) => {
          setError(String(reason));
          // Never keep presenting the previous reading as current.
          setSnapshot(null);
        },
        LIVE_POLL_INTERVAL_MS,
      ),
    [],
  );

  return { snapshot, error };
}
