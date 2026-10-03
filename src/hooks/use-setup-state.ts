import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { startLatestPolling } from "../latest-poller.ts";
import type { SetupState } from "../telemetry/setup-view-model.ts";
import {
  setupFailed,
  setupReceived,
  setupStore,
  type SetupStoreState,
} from "../state/stores.ts";
import { useStore } from "../state/use-store.ts";

/// Setup state changes at most once in the life of an installation, so this is
/// the slowest loop in the application. It exists at all only so the first-run
/// user sees the success state without restarting.
export const SETUP_POLL_INTERVAL_MS = 1000;

/// Owner of the setup loop. Mounted once, above the workspace switch, like
/// every other subscription. The first-run latch lives in the store's update
/// rule (`setupReceived`), which reads the current value synchronously.
export function useSetupState(): void {
  useEffect(
    () =>
      startLatestPolling(
        () => invoke<SetupState>("get_setup_state"),
        (incoming) =>
          setupStore.update((state) => setupReceived(state, incoming)),
        (reason) => setupStore.update((state) => setupFailed(state, reason)),
        SETUP_POLL_INTERVAL_MS,
      ),
    [],
  );
}

/// Reader; see `useLive`.
export function useSetup<S>(select: (state: SetupStoreState) => S): S {
  return useStore(setupStore, select);
}
