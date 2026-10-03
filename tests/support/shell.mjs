// The application shell, mounted for behaviour tests. Import after dom.mjs.
//
// `ShellHarness` is App without its polling owner hooks: the same AppShell, the
// same navigation reducer and the same workspaces, with stores driven by the
// test instead of by polling loops. That makes every update explicit and
// wrapped in act(), so a test states exactly which update caused a render.
import { act, createElement as h, useReducer } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "../../src/components/AppShell.tsx";
import SessionsWorkspace from "../../src/workspaces/SessionsWorkspace.tsx";
import DiagnosticsWorkspace from "../../src/workspaces/DiagnosticsWorkspace.tsx";
import LiveWorkspace from "../../src/workspaces/LiveWorkspace.tsx";
import SettingsWorkspace from "../../src/workspaces/SettingsWorkspace.tsx";
import HomeWorkspace from "../../src/workspaces/HomeWorkspace.tsx";
import {
  INITIAL_F1,
  INITIAL_F1_LIVE,
  INITIAL_F1_RECORDER,
  INITIAL_LIVE,
  INITIAL_RECORDER,
  INITIAL_SETUP,
  f1LiveStore,
  f1RecorderStore,
  f1Store,
  liveStore,
  recorderStore,
  setupStore,
  transportStore,
} from "../../src/state/stores.ts";
import { initialTelemetryState } from "../../src/telemetry-state.ts";
import {
  activeGameStore,
  INITIAL_ACTIVE_GAME,
} from "../../src/state/active-game.ts";
import {
  INITIAL_NAVIGATION,
  navigationReducer,
} from "../../src/views/navigation.ts";
import { responses } from "./dom.mjs";
import { DEFAULT_OVERLAY } from "../../src/overlay/model.ts";

export { act, h };

// --------------------------------------------------------------- fixtures

export function frame(speed = 40) {
  const wheel = {
    temperature_c: 80,
    slip_ratio: 0.05,
    slip_angle: 0.01,
    combined_slip: 0.1,
    rotation_rad_s: 90,
    normalized_suspension_travel: 0.4,
    suspension_travel_m: 0.06,
  };
  return {
    active: true,
    game: "fh6",
    vehicle_id: "3421",
    game_timestamp_ms: 1000,
    engine: {
      rpm: 5000,
      idle_rpm: 900,
      max_rpm: 8000,
      power_w: 100000,
      torque_nm: 300,
    },
    acceleration: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: speed },
    angular_velocity: { x: 0, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: 0 },
    position: { x: 0, y: 0, z: 0 },
    speed_mps: speed,
    controls: {
      throttle: 0.5,
      brake: 0,
      clutch: 0,
      handbrake: 0,
      steering: 0,
    },
    gear: { kind: "unmapped", value: 3 },
    vehicle: {
      class_code: 5,
      performance_index: 800,
      drivetrain_code: 2,
      cylinders: 6,
    },
    wheels: {
      front_left: wheel,
      front_right: wheel,
      rear_left: wheel,
      rear_right: wheel,
    },
    race: { lap_number: 0, race_position: 0, race_time_seconds: 10 },
    sourceSpecific: null,
  };
}

let revision = 0;
export function snapshot(overrides = {}) {
  revision += 1;
  return {
    revision,
    connection: "SESSION_ACTIVE",
    health: "GOOD",
    protocol: "fh6",
    protocol_confidence: 1,
    valid_packets: 100,
    invalid_packets: 0,
    valid_active_fh6: 100,
    valid_inactive_fh6: 0,
    invalid_fh6: 0,
    unknown_protocol: 0,
    input_packet_hz: 60,
    valid_frame_hz: 60,
    last_packet_age_ms: 5,
    last_valid_frame_age_ms: 5,
    receive_errors: 0,
    stale: false,
    frame: frame(),
    issues: [],
    transport_error: null,
    session: null,
    hub: {
      published: 100,
      recent_frames: 10,
      ring_capacity: 512,
      ring_evictions: 0,
      subscribers: 2,
      subscriber_drops: 0,
      last_drop_ms: null,
    },
    grace_period_ms: 10000,
    ...overrides,
  };
}

let recorderRevision = 0;
export function recorder(overrides = {}) {
  recorderRevision += 1;
  return {
    revision: recorderRevision,
    status: "recording",
    recording: true,
    sessions_directory: "sessions",
    session_id: "s-live",
    session_directory: null,
    game: "fh6",
    vehicle_id: "3421",
    started_at_unix_ms: 0,
    duration_ms: recorderRevision * 500,
    frames_written: recorderRevision * 30,
    active_frames: 0,
    inactive_frames: 0,
    queued_frames: 0,
    recorder_dropped_frames: 0,
    lifetime_dropped_frames: 0,
    queue_capacity: 4096,
    last_completed_session_id: null,
    completed_sessions: 1,
    last_error: null,
    ...overrides,
  };
}

const MANIFEST = {
  schema_version: 1,
  session_id: "s-1",
  status: "completed",
  game: "fh6",
  protocol: "fh6",
  vehicle_id: "3421",
  started_at_unix_ms: 1_700_000_000_000,
  ended_at_unix_ms: 1_700_000_600_000,
  duration_us: 600_000_000,
  frame_count: 36000,
  active_frame_count: 36000,
  inactive_frame_count: 0,
  recorder_dropped_frames: 0,
  completion_reason: "idle_timeout",
  frame_file: "frames.rlframes",
  frame_format_version: 1,
  telemetry_frame_schema_version: 2,
  summary: null,
  created_by_racelab_version: "1.0.0",
  recovery: null,
};

/// Metadata-scale responses for the commands the workspaces call on mount.
export function installBackend() {
  responses.set("get_overlay_state", () => ({
    preferences: DEFAULT_OVERLAY,
    editing: false,
    visible: false,
    error: null,
  }));
  responses.set("list_recent_sessions", () => ({
    sessions: [MANIFEST],
    unreadable: 0,
    directory: "sessions",
    limit: 20,
  }));
  responses.set("get_session", ({ sessionId }) => ({
    ...MANIFEST,
    session_id: sessionId,
  }));
  responses.set("get_session_analysis", ({ sessionId }) => ({
    session_id: sessionId,
    state: "not_analyzed",
    analysis: null,
    analysis_schema_version: null,
    supported_analysis_schema_version: 2,
    message: null,
    file: "analysis.json",
    queued_ms: null,
    analysis_duration_ms: null,
    failure_reason: null,
    can_reanalyze: true,
  }));
  responses.set("get_storage_status", () => ({
    retention: {
      budget_bytes: 8 * 1024 ** 3,
      enabled: true,
      used_bytes: 1024 ** 3,
      over_budget: false,
      retained_sessions: 1,
      protected_sessions: 0,
      unidentifiable_sessions: 0,
      unidentifiable_bytes: 0,
      deleted_sessions: 0,
      reclaimed_bytes: 0,
      failed_deletions: 0,
      sweeps: 1,
      last_sweep_unix_ms: null,
      last_deleted_session_id: null,
      last_error: null,
    },
    recovery: {
      reclassified: 0,
      pending: 0,
      scanned: 0,
      complete: 0,
      truncated: 0,
      damaged: 0,
      unreadable: 0,
      recovered_frames: 0,
      running: false,
      last_session_id: null,
      last_error: null,
    },
  }));
  responses.set("get_settings", () => ({
    storage_budget_bytes: 8 * 1024 ** 3,
    storage_budget_from_environment: false,
    min_storage_budget_bytes: 1024 ** 3,
    max_storage_budget_bytes: 1024 ** 4,
    default_storage_budget_bytes: 8 * 1024 ** 3,
    fh6_first_detected_unix_ms: 1,
    last_error: null,
    path: "settings.json",
  }));
  responses.set("get_capture_stats", () => ({
    revision: 1,
    status: "idle",
    accepting_packets: false,
    label: "",
    directory: "captures",
    file_path: null,
    started_at_ms: null,
    duration_us: 0,
    captured_packets: 0,
    dropped_capture_frames: 0,
    queue_capacity: 8192,
    packet_sizes: {},
    first_packet_timestamp: null,
    last_packet_timestamp: null,
    first_packet_hex_preview: null,
    last_packet_hex_preview: null,
    last_error: null,
  }));
}

export function resetStores() {
  f1RecorderStore.set(INITIAL_F1_RECORDER);
  f1LiveStore.set(INITIAL_F1_LIVE);
  f1Store.set(INITIAL_F1);
  liveStore.set(INITIAL_LIVE);
  recorderStore.set(INITIAL_RECORDER);
  setupStore.set(INITIAL_SETUP);
  activeGameStore.set(INITIAL_ACTIVE_GAME);
  transportStore.set({
    ...initialTelemetryState,
    stats: { revision: 1, running: true, bound_port: 20440 },
    connected: true,
  });
}

// ---------------------------------------------------------------- harness

export function ShellHarness() {
  const [navigation, navigate] = useReducer(
    navigationReducer,
    INITIAL_NAVIGATION,
  );
  const section = navigation.section;
  return h(
    AppShell,
    { navigation, onNavigate: navigate },
    section === "live"
      ? h(LiveWorkspace, {
          tab: navigation.liveTab,
          f1Tab: navigation.f1Tab,
          onTab: (tab) => navigate({ type: "liveTab", tab }),
          onF1Tab: (tab) => navigate({ type: "f1Tab", tab }),
        })
      : section === "sessions"
        ? h(SessionsWorkspace, {
            onOpenSettings: () =>
              navigate({ type: "section", section: "settings" }),
          })
        : section === "settings"
          ? h(SettingsWorkspace)
          : section === "home"
            ? h(HomeWorkspace, {
                onNavigate: (section) => navigate({ type: "section", section }),
              })
            : h(DiagnosticsWorkspace),
  );
}

/// Settles pending promises (backend replies) inside act().
export async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      // setImmediate, not setTimeout: a test may mock setTimeout.
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
}

const mounted = new Set();
const restorers = [];

export async function mount(element) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const view = {
    container,
    async unmount() {
      if (!mounted.delete(view)) return;
      await act(async () => root.unmount());
      container.remove();
    },
  };
  mounted.add(view);
  await act(async () => root.render(element));
  await settle();
  return view;
}

/// Registers an undo step (e.g. a patched store method) for `cleanup`.
export function onCleanup(restore) {
  restorers.push(restore);
}

/// Run after every test, pass or fail, so a failing test cannot leave a
/// mounted tree, stray elements or a patched store behind for the next one.
export async function cleanup() {
  for (const view of [...mounted]) await view.unmount();
  while (restorers.length) restorers.pop()();
  document.body.replaceChildren();
}

/// A key press as the browser delivers it: on the focused element, bubbling
/// to the window listener the shell installs.
export async function press(key, options = {}) {
  const target = options.target ?? document.activeElement ?? document.body;
  await act(async () => {
    target.dispatchEvent(
      new window.KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ctrlKey: options.ctrlKey ?? false,
      }),
    );
  });
}

export async function click(element) {
  await act(async () => element.click());
  await settle();
}

export async function focus(element) {
  await act(async () => element.focus());
}

export async function update(store, value) {
  await act(async () => store.set(value));
}
