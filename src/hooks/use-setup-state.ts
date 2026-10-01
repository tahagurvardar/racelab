import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { startLatestPolling } from "../latest-poller.ts";
import type { SetupState } from "../telemetry/setup-view-model.ts";

/// Setup state changes at most once in the life of an installation, so this is
/// the slowest loop in the application. It exists at all only so the first-run
/// user sees the success state without restarting.
export const SETUP_POLL_INTERVAL_MS = 1000;

export interface SetupStateResult {
  setup: SetupState | null;
  /// True once this run has observed `first_run`. Latched, never cleared: it is
  /// what lets the success state outlive the fact it reports.
  sawFirstRun: boolean;
  error: string | null;
}

/// Mounted once, above the view switch, like every other subscription.
export function useSetupState(): SetupStateResult {
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [sawFirstRun, setSawFirstRun] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref as well as state: the latch must be read synchronously inside the
  // poll callback, where the state value would still be the previous render's.
  const latched = useRef(false);

  useEffect(
    () =>
      startLatestPolling(
        () => invoke<SetupState>("get_setup_state"),
        (incoming) => {
          setError(null);
          if (incoming.first_run && !latched.current) {
            latched.current = true;
            setSawFirstRun(true);
          }
          setSetup(incoming);
        },
        (reason) => setError(String(reason)),
        SETUP_POLL_INTERVAL_MS,
      ),
    [],
  );

  return { setup, sawFirstRun, error };
}
