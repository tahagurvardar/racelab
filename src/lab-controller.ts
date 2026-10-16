/// Telemetry Lab state, its backend reads and its replay clock (v2.1 M2, M3).
///
/// One controller per open Lab. It owns its own store — never a live
/// telemetry store — and its reads are request-sequenced: a reply for a lap,
/// axis or session that is no longer asked for is dropped, and nothing lands
/// after `dispose`. Plain TypeScript, tested under Node.
///
/// Replay (M3) moves the shared cursor along the current lap's own clock.
/// Each frame places the cursor at `anchor lap time + elapsed wall time ×
/// rate`, so a dropped or late frame never makes the replay drift; any seek,
/// rate change or cursor move re-anchors it. The frame source is injected:
/// `requestAnimationFrame` in the app, a hand-driven clock in tests.
import { createStore, type Store } from "./state/stores.ts";
import type { F1SessionDetail } from "./f1-sessions.ts";
import {
  defaultLaps,
  LAB_TRACE_SCHEMA,
  labLaps,
  playbackMap,
  PLAYBACK_RATES,
  sharedXDomain,
  labSession,
  type LabLap,
  type PlaybackMap,
  type PlaybackRate,
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

/// The replay's time and frame source.
export interface LabClock {
  /// Milliseconds, monotonic.
  now(): number;
  /// Runs `callback` before the next frame; returns a handle for `cancel`.
  frame(callback: () => void): number;
  cancel(handle: number): void;
}

export type LapSlot = "current" | "reference";

export interface LabTraceState {
  lap: number | null;
  status: "empty" | "loading" | "ready" | "error";
  trace: SessionTrace | null;
  error: string | null;
}

export interface LabPlayback {
  playing: boolean;
  rate: PlaybackRate;
  /// The replay reached the end of the lap and stopped there.
  ended: boolean;
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
  playback: LabPlayback;
}

const EMPTY_TRACE: LabTraceState = {
  lap: null,
  status: "empty",
  trace: null,
  error: null,
};

const STOPPED: LabPlayback = { playing: false, rate: 1, ended: false };

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
    playback: STOPPED,
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
  /// The current lap's replay map, or why it cannot be replayed.
  playback(): PlaybackMap;
  play(): void;
  pause(): void;
  togglePlay(): void;
  setRate(rate: PlaybackRate): void;
  /// One step faster (`1`) or slower (`-1`) through `PLAYBACK_RATES`.
  stepRate(direction: 1 | -1): void;
  /// Seek to a lap time, in milliseconds.
  seekTime(ms: number): void;
}

export function createLabController(
  sessionId: string,
  backend: LabBackend,
  clock: LabClock | null = null,
): LabController {
  const store = createStore(initialLabState(sessionId));
  let disposed = false;
  const sequence: Record<LapSlot, number> = { current: 0, reference: 0 };
  // Replay: the lap time and wall time the running replay counts from, and
  // the pending frame.
  let anchor: { lapMs: number; wallMs: number } | null = null;
  let pending: number | null = null;
  let cached: {
    trace: SessionTrace | null;
    axis: TraceAxisId;
    map: PlaybackMap;
  } | null = null;

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

  function map(): PlaybackMap {
    const { current, axis } = store.get();
    if (cached?.trace !== current.trace || cached.axis !== axis) {
      cached = {
        trace: current.trace,
        axis,
        map: playbackMap(current.trace, axis),
      };
    }
    return cached.map;
  }

  function cancelFrame() {
    if (pending != null && clock) clock.cancel(pending);
    pending = null;
  }

  /// Stops the replay where it is. The cursor stays.
  function halt(ended = false) {
    cancelFrame();
    anchor = null;
    const playback = store.get().playback;
    if (playback.playing || playback.ended !== ended) {
      patch({ playback: { ...playback, playing: false, ended } });
    }
  }

  function reanchor() {
    const replay = map();
    const state = store.get();
    if (!state.playback.playing || !replay.available || !clock) return;
    const cursor = state.cursor ?? replay.toX(replay.startMs);
    anchor = { lapMs: replay.toTime(cursor), wallMs: clock.now() };
  }

  function tick() {
    pending = null;
    const replay = map();
    if (disposed || !anchor || !clock || !replay.available) {
      halt();
      return;
    }
    const rate = store.get().playback.rate;
    const lapMs = anchor.lapMs + (clock.now() - anchor.wallMs) * rate;
    if (lapMs >= replay.endMs) {
      patch({ cursor: replay.toX(replay.endMs) });
      halt(true);
      return;
    }
    patch({ cursor: replay.toX(lapMs) });
    pending = clock.frame(tick);
  }

  /// Every manual cursor move goes through here, so a running replay
  /// continues from where the person put the cursor.
  function moveCursor(x: number | null) {
    const state = store.get();
    const ended = state.playback.ended;
    if (state.cursor !== x || ended) {
      patch({
        cursor: x,
        playback: ended ? { ...state.playback, ended: false } : state.playback,
      });
    }
    reanchor();
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
      cancelFrame();
      anchor = null;
      disposed = true;
    },
    setLap(slot, lap) {
      const state = store.get();
      if (state[slot].lap === lap) return;
      // A different lap is a different replay.
      halt();
      patch({ [slot]: { ...EMPTY_TRACE, lap } });
      load(slot);
    },
    setAxis(axis) {
      const state = store.get();
      if (state.axis === axis) return;
      halt();
      patch({ axis, cursor: null });
      load("current");
      load("reference");
    },
    setCursor(x) {
      moveCursor(x);
    },
    stepCursor(steps) {
      const { x0, x1 } = domain();
      const step = (x1 - x0) / 100;
      const from = store.get().cursor ?? x0;
      moveCursor(Math.min(x1, Math.max(x0, from + steps * step)));
    },
    cursorTo(edge) {
      const { x0, x1 } = domain();
      moveCursor(edge === "start" ? x0 : x1);
    },
    toggle(panel) {
      const collapsed = store.get().collapsed;
      patch({ collapsed: { ...collapsed, [panel]: !collapsed[panel] } });
    },
    playback: map,
    play() {
      const replay = map();
      const state = store.get();
      if (!clock || !replay.available || state.playback.playing || disposed) {
        return;
      }
      // From the start when the replay ended or the cursor is past the lap.
      const at =
        state.cursor == null ? replay.startMs : replay.toTime(state.cursor);
      const startAt =
        state.playback.ended || at >= replay.endMs ? replay.startMs : at;
      patch({
        cursor: replay.toX(startAt),
        playback: { ...state.playback, playing: true, ended: false },
      });
      anchor = { lapMs: startAt, wallMs: clock.now() };
      pending = clock.frame(tick);
    },
    pause() {
      halt();
    },
    togglePlay() {
      if (store.get().playback.playing) controller.pause();
      else controller.play();
    },
    setRate(rate) {
      const playback = store.get().playback;
      if (playback.rate === rate) return;
      // Re-anchor first, so the time already played keeps its old rate.
      if (playback.playing && anchor && clock) {
        const lapMs =
          anchor.lapMs + (clock.now() - anchor.wallMs) * playback.rate;
        anchor = { lapMs, wallMs: clock.now() };
      }
      patch({ playback: { ...store.get().playback, rate } });
    },
    stepRate(direction) {
      const index = PLAYBACK_RATES.indexOf(store.get().playback.rate);
      const next =
        PLAYBACK_RATES[
          Math.min(PLAYBACK_RATES.length - 1, Math.max(0, index + direction))
        ];
      controller.setRate(next);
    },
    seekTime(ms) {
      const replay = map();
      if (!replay.available) return;
      const clamped = Math.min(replay.endMs, Math.max(replay.startMs, ms));
      moveCursor(replay.toX(clamped));
    },
  };
  return controller;
}
