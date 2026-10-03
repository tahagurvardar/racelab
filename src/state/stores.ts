/// Application state that changes faster than the shell should re-render.
///
/// Through V1.0 every subscription wrote into `useState` in `App`, so a 20 Hz
/// live snapshot re-rendered the whole tree — including Sessions, which never
/// reads live telemetry. Here each subscription writes into a small external
/// store instead, and only the components that read a store re-render when it
/// changes. The polling itself is unchanged: the same three loops and one event
/// listener, started once by the owner hooks in `App`.
///
/// Plain TypeScript with no React import, so the update rules are tested under
/// Node directly.
import { newerLive, type LiveSnapshot } from "../telemetry/live-snapshot.ts";
import type { SetupState } from "../telemetry/setup-view-model.ts";
import { newerRecorder, type RecorderStatus } from "../session-state.ts";
import {
  initialTelemetryState,
  telemetryReducer,
  type StatsSnapshot,
  type TelemetryState,
} from "../telemetry-state.ts";

export interface Store<T> {
  get(): T;
  /// Replaces the value. Listeners are told only when the reference changed,
  /// so an update that keeps the current value costs no render at all.
  set(next: T): void;
  update(change: (current: T) => T): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  const store: Store<T> = {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
    update(change) {
      store.set(change(value));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return store;
}

// ------------------------------------------------------------ live telemetry

export interface LiveState {
  snapshot: LiveSnapshot | null;
  error: string | null;
}

export const INITIAL_LIVE: LiveState = { snapshot: null, error: null };

/// A newer snapshot replaces the current one; a late reply never does. When
/// nothing changes, the same object is returned so no listener fires.
export function liveReceived(
  state: LiveState,
  incoming: LiveSnapshot,
): LiveState {
  const snapshot = newerLive(state.snapshot, incoming);
  if (snapshot === state.snapshot && state.error === null) return state;
  return { snapshot, error: null };
}

/// A failed read never keeps presenting the previous reading as current.
export function liveFailed(state: LiveState, reason: unknown): LiveState {
  const error = String(reason);
  if (state.snapshot === null && state.error === error) return state;
  return { snapshot: null, error };
}

// ------------------------------------------------------------------ recorder

export interface RecorderState {
  recorder: RecorderStatus | null;
  error: string | null;
}

export const INITIAL_RECORDER: RecorderState = { recorder: null, error: null };

export function recorderReceived(
  state: RecorderState,
  incoming: RecorderStatus,
): RecorderState {
  const recorder = newerRecorder(state.recorder, incoming);
  if (recorder === state.recorder && state.error === null) return state;
  return { recorder, error: null };
}

/// The last good recorder status is kept, exactly as V1.0 kept it.
export function recorderFailed(
  state: RecorderState,
  reason: unknown,
): RecorderState {
  const error = String(reason);
  return state.error === error ? state : { ...state, error };
}

// --------------------------------------------------------------------- setup

export interface SetupStoreState {
  setup: SetupState | null;
  /// True once this run has observed `first_run`. Latched, never cleared: it
  /// is what lets the success state outlive the fact it reports.
  sawFirstRun: boolean;
  error: string | null;
}

export const INITIAL_SETUP: SetupStoreState = {
  setup: null,
  sawFirstRun: false,
  error: null,
};

function sameSetup(a: SetupState | null, b: SetupState): boolean {
  return (
    a != null &&
    a.first_run === b.first_run &&
    a.listen_host === b.listen_host &&
    a.listen_port === b.listen_port &&
    a.fh6_first_detected_unix_ms === b.fh6_first_detected_unix_ms
  );
}

/// Setup is read at 1 Hz but changes at most once per installation, so an
/// identical reading keeps the current object and renders nothing.
export function setupReceived(
  state: SetupStoreState,
  incoming: SetupState,
): SetupStoreState {
  const sawFirstRun = state.sawFirstRun || incoming.first_run;
  if (
    sameSetup(state.setup, incoming) &&
    sawFirstRun === state.sawFirstRun &&
    state.error === null
  ) {
    return state;
  }
  return {
    setup: sameSetup(state.setup, incoming) ? state.setup : incoming,
    sawFirstRun,
    error: null,
  };
}

export function setupFailed(
  state: SetupStoreState,
  reason: unknown,
): SetupStoreState {
  const error = String(reason);
  return state.error === error ? state : { ...state, error };
}

// ----------------------------------------------------------------- transport

export function transportReceived(
  state: TelemetryState,
  snapshot: StatsSnapshot,
): TelemetryState {
  return telemetryReducer(state, { type: "snapshot", snapshot });
}

export function transportFailed(
  state: TelemetryState,
  message: string,
): TelemetryState {
  return telemetryReducer(state, { type: "connectionFailure", message });
}

// -------------------------------------------------------------- the stores

export const liveStore = createStore<LiveState>(INITIAL_LIVE);
export const recorderStore = createStore<RecorderState>(INITIAL_RECORDER);
export const setupStore = createStore<SetupStoreState>(INITIAL_SETUP);
export const transportStore = createStore<TelemetryState>(
  initialTelemetryState,
);

/// The listener controls in Diagnostics apply the snapshot a start/stop
/// command returns, exactly as V1.0's `apply` did.
export function applyTransportSnapshot(snapshot: StatsSnapshot): void {
  transportStore.update((state) => transportReceived(state, snapshot));
}
