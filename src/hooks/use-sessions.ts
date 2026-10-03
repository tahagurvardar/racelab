import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SessionAnalysisState } from "../analysis-state.ts";
import {
  createSessionsController,
  type SessionsBackend,
  type SessionsController,
  type SessionsState,
} from "../session-controller.ts";
import type {
  RecentSessions,
  SessionManifest,
  StorageStatus,
} from "../session-state.ts";
import { useStore } from "../state/use-store.ts";

/// The same metadata-scale commands V1.0 called. None of them returns frames.
export const invokeSessionsBackend: SessionsBackend = {
  listRecent: (limit) =>
    invoke<RecentSessions>("list_recent_sessions", { limit }),
  storageStatus: () => invoke<StorageStatus>("get_storage_status"),
  session: (sessionId) => invoke<SessionManifest>("get_session", { sessionId }),
  analysis: (sessionId) =>
    invoke<SessionAnalysisState>("get_session_analysis", { sessionId }),
  reanalyze: (sessionId) => invoke("reanalyze_session", { sessionId }),
};

/// One controller per mounted Sessions workspace. Created inside the effect
/// so a remount (StrictMode, or leaving and returning) never shares a
/// disposed controller, and disposed on unmount so a late reply or a pending
/// analysis refresh can never land after the workspace is gone.
export function useSessionsController(
  backend: SessionsBackend = invokeSessionsBackend,
): SessionsController | null {
  const [controller, setController] = useState<SessionsController | null>(null);
  useEffect(() => {
    const created = createSessionsController(backend);
    setController(created);
    void created.refreshList();
    return () => created.dispose();
  }, [backend]);
  return controller;
}

/// Reads one slice of the controller's state; re-renders only when it changes.
export function useSessions<S>(
  controller: SessionsController,
  select: (state: SessionsState) => S,
): S {
  return useStore(controller.store, select);
}
