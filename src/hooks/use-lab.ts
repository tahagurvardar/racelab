import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { F1SessionDetail } from "../f1-sessions.ts";
import {
  createLabController,
  type LabBackend,
  type LabController,
  type LabState,
} from "../lab-controller.ts";
import {
  LAB_BUCKETS,
  LAB_CHANNELS,
  type SessionTrace,
} from "../telemetry-lab.ts";
import { useStore } from "../state/use-store.ts";

/// The two reads Telemetry Lab makes: the session's facts, and a bounded
/// trace of one lap. Neither returns a frame or a sample.
export const invokeLabBackend: LabBackend = {
  f1Session: (sessionId) =>
    invoke<F1SessionDetail>("get_f1_session", { sessionId }),
  trace: (sessionId, lap, axis) =>
    invoke<SessionTrace>("get_session_trace", {
      sessionId,
      channels: LAB_CHANNELS,
      buckets: LAB_BUCKETS,
      lap,
      axis,
    }),
};

/// One controller per mounted Lab, created inside the effect so a remount
/// never shares a disposed controller, and disposed on unmount so no reply
/// lands after the Lab is gone.
export function useLabController(
  sessionId: string,
  backend: LabBackend = invokeLabBackend,
): LabController | null {
  const [controller, setController] = useState<LabController | null>(null);
  useEffect(() => {
    const created = createLabController(sessionId, backend);
    setController(created);
    created.start();
    return () => {
      created.dispose();
      setController(null);
    };
  }, [sessionId, backend]);
  return controller;
}

export function useLab<S>(
  controller: LabController,
  select: (state: LabState) => S,
): S {
  return useStore(controller.store, select);
}
