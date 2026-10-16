import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { F1SessionDetail } from "../f1-sessions.ts";
import {
  createLabController,
  type LabBackend,
  type LabClock,
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

/// The replay's clock in the app: the display's own frames. The only place
/// the Lab touches `requestAnimationFrame`; tests inject a hand-driven clock.
export const frameClock: LabClock = {
  now: () => performance.now(),
  frame: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
};

/// One controller per mounted Lab, created inside the effect so a remount
/// never shares a disposed controller, and disposed on unmount so no reply
/// or replay frame lands after the Lab is gone. A hidden window pauses the
/// replay rather than letting it run unseen.
export function useLabController(
  sessionId: string,
  backend: LabBackend = invokeLabBackend,
  clock: LabClock = frameClock,
): LabController | null {
  const [controller, setController] = useState<LabController | null>(null);
  useEffect(() => {
    const created = createLabController(sessionId, backend, clock);
    setController(created);
    created.start();
    const onVisibility = () => {
      if (document.hidden) created.pause();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      created.dispose();
      setController(null);
    };
  }, [sessionId, backend, clock]);
  return controller;
}

export function useLab<S>(
  controller: LabController,
  select: (state: LabState) => S,
): S {
  return useStore(controller.store, select);
}
