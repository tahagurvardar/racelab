import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { startLatestPolling } from "../latest-poller.ts";
import type { F1EvidenceStatus } from "../telemetry/f1-evidence.ts";
import {
  f1Failed,
  f1Received,
  f1Store,
  type F1StoreState,
} from "../state/stores.ts";
import { useStore } from "../state/use-store.ts";

/// F1 25 evidence and decoded player values: engineering data, read at
/// 4 Hz so inputs can be checked against the game while driving.
export const F1_POLL_INTERVAL_MS = 250;

/// Once the backend has said the F1 evidence listener is off, or that it has
/// no such command, nothing will change for the life of the process: the loop
/// keeps its timer but stops asking.
function read(): Promise<F1EvidenceStatus | null> {
  return f1Store.get().available === false
    ? Promise.resolve(null)
    : invoke<F1EvidenceStatus>("get_f1_evidence");
}

/// Owner of the F1 evidence loop. Mounted once, above the workspace switch,
/// like every other subscription; the F1 25 Diagnostics tab only reads.
export function useF1Evidence(): void {
  useEffect(
    () =>
      startLatestPolling(
        read,
        (incoming) =>
          f1Store.update((state) =>
            incoming == null ? state : f1Received(state, incoming),
          ),
        (reason) => f1Store.update((state) => f1Failed(state, reason)),
        F1_POLL_INTERVAL_MS,
      ),
    [],
  );
}

/// Reader; see `useLive`.
export function useF1<S>(select: (state: F1StoreState) => S): S {
  return useStore(f1Store, select);
}
