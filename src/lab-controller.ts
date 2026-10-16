/// Telemetry Lab state and its backend reads (v2.1 M2).
///
/// One controller per open Lab. It owns its own store — never a live
/// telemetry store — and its reads are request-sequenced: a reply for a lap,
/// axis or session that is no longer asked for is dropped, and nothing lands
/// after `dispose`. Plain TypeScript, tested under Node.
import { createStore, type Store } from "./state/stores.ts";
import type { F1SessionDetail } from "./f1-sessions.ts";
import {
  defaultLaps,
  LAB_TRACE_SCHEMA,
  labLaps,
  sharedXDomain,
  labSession,
  type LabLap,
  type SessionTrace,
  type TraceAxisId,
  type TraceFailure,
} from "./telemetry-lab.ts";

export interface LabBackend {
  f1Session(sessionId: string): Promise<F1SessionDetail>;
  trace(
    sessionId: string,
    lap: number,
    axis: TraceAxisId,
  ): Promise<SessionTrace>;
}

export type LapSlot = "current" | "reference";

export interface LabTraceState {
  lap: number | null;
  status: "empty" | "loading" | "ready" | "error";
  trace: SessionTrace | null;
  error: string | null;
}

export interface LabState {
  sessionId: string;
  detail: F1SessionDetail | null;
  detailError: string | null;
  laps: LabLap[];
  axis: TraceAxisId;
  current: LabTraceState;
  reference: LabTraceState;
  /// The shared cursor, in the axis's own unit (metres or milliseconds).
  cursor: number | null;
  collapsed: Record<string, boolean>;
}

const EMPTY_TRACE: LabTraceState = {
  lap: null,
  status: "empty",
  trace: null,
  error: null,
};

export function initialLabState(sessionId: string): LabState {
  return {
    sessionId,
    detail: null,
    detailError: null,
    laps: [],
    axis: "distance",
    current: EMPTY_TRACE,
    reference: EMPTY_TRACE,
    cursor: null,
    collapsed: {},
  };
}

function failure(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String((error as TraceFailure).message);
  }
  return String(error);
}

export interface LabController {
  store: Store<LabState>;
  start(): void;
  dispose(): void;
  setLap(slot: LapSlot, lap: number | null): void;
  setAxis(axis: TraceAxisId): void;
  setCursor(x: number | null): void;
  /// Moves the cursor by `steps` hundredths of the visible axis.
  stepCursor(steps: number): void;
  cursorTo(edge: "start" | "end"): void;
  toggle(panel: string): void;
}

export function createLabController(
  sessionId: string,
  backend: LabBackend,
): LabController {
  const store = createStore(initialLabState(sessionId));
  let disposed = false;
  const sequence: Record<LapSlot, number> = { current: 0, reference: 0 };

  function patch(change: Partial<LabState>) {
    if (!disposed) store.set({ ...store.get(), ...change });
  }

  function domain() {
    const state = store.get();
    const length =
      state.detail == null ? null : labSession(state.detail).trackLengthM;
    return sharedXDomain(
      [state.current.trace, state.reference.trace],
      state.axis,
      length,
    );
  }

  function load(slot: LapSlot) {
    const state = store.get();
    const lap = state[slot].lap;
    const ticket = ++sequence[slot];
    if (lap == null) {
      patch({ [slot]: EMPTY_TRACE });
      return;
    }
    patch({
      [slot]: { lap, status: "loading", trace: state[slot].trace, error: null },
    });
    const axis = state.axis;
    backend.trace(sessionId, lap, axis).then(
      (trace) => {
        if (disposed || ticket !== sequence[slot]) return;
        if (trace.schema_version !== LAB_TRACE_SCHEMA) {
          patch({
            [slot]: {
              lap,
              status: "error",
              trace: null,
              error: `This build reads trace schema ${LAB_TRACE_SCHEMA}; the backend sent ${trace.schema_version}.`,
            },
          });
          return;
        }
        patch({ [slot]: { lap, status: "ready", trace, error: null } });
        const after = store.get();
        if (slot === "current" && after.cursor == null && trace.axis.records) {
          patch({ cursor: trace.axis.start });
        }
      },
      (error) => {
        if (disposed || ticket !== sequence[slot]) return;
        patch({
          [slot]: { lap, status: "error", trace: null, error: failure(error) },
        });
      },
    );
  }

  const controller: LabController = {
    store,
    start() {
      backend.f1Session(sessionId).then(
        (detail) => {
          if (disposed) return;
          const laps = labLaps(detail);
          const { current, reference } = defaultLaps(laps);
          patch({
            detail,
            detailError: null,
            laps,
            current: { ...EMPTY_TRACE, lap: current },
            reference: { ...EMPTY_TRACE, lap: reference },
          });
          if (detail.session.racelab_session.status !== "completed") return;
          load("current");
          load("reference");
        },
        (error) => {
          if (!disposed) patch({ detailError: failure(error) });
        },
      );
    },
    dispose() {
      disposed = true;
    },
    setLap(slot, lap) {
      const state = store.get();
      if (state[slot].lap === lap) return;
      patch({ [slot]: { ...EMPTY_TRACE, lap } });
      load(slot);
    },
    setAxis(axis) {
      const state = store.get();
      if (state.axis === axis) return;
      patch({ axis, cursor: null });
      load("current");
      load("reference");
    },
    setCursor(x) {
      if (store.get().cursor !== x) patch({ cursor: x });
    },
    stepCursor(steps) {
      const { x0, x1 } = domain();
      const step = (x1 - x0) / 100;
      const from = store.get().cursor ?? x0;
      patch({ cursor: Math.min(x1, Math.max(x0, from + steps * step)) });
    },
    cursorTo(edge) {
      const { x0, x1 } = domain();
      patch({ cursor: edge === "start" ? x0 : x1 });
    },
    toggle(panel) {
      const collapsed = store.get().collapsed;
      patch({ collapsed: { ...collapsed, [panel]: !collapsed[panel] } });
    },
  };
  return controller;
}
