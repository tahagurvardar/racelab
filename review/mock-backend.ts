/// DEV-ONLY review harness. Never imported by the application and never part
/// of `pnpm build` (Vite builds `index.html` alone).
///
/// It stands in for the Tauri backend so the redesigned shell can be reviewed
/// and screenshotted in a plain browser, in every product state, without a
/// game running. The values are illustrative fixtures for layout review only;
/// they are not captured telemetry and must never be used as test evidence.
///
/// Scenarios: ?scenario=live | stress | degraded | idle | waiting |
///            first-run | grace |
///            port-error | recording-failed | recovered-recorder
/// Session sets: ?sessions=mixed | none | delayed (see session-fixtures.ts)
/// Storage: ?storage=over — over the limit, one failed deletion, and a saved
///          limit that differs from the one in force (applies next start)
import "./dev-only.ts";
import type { LiveSnapshot } from "../src/telemetry/live-snapshot.ts";
import type { RecorderStatus } from "../src/session-state.ts";
import { SESSION_RESPONSES } from "./session-fixtures.ts";

type Scenario =
  | "live"
  | "stress"
  | "degraded"
  | "idle"
  | "waiting"
  | "first-run"
  /// First run, then Forza Horizon 6 detected after ~2.5 s: the setup
  /// guide turns into its completion state.
  | "setup-complete"
  | "grace"
  | "port-error"
  | "recording-failed"
  /// Recording again after an earlier write failure: `last_error` is still
  /// set, `status` is not "error". Nothing may present it as current.
  | "recovered-recorder";

const scenario = (new URLSearchParams(location.search).get("scenario") ??
  "live") as Scenario;
const started = Date.now();
let revision = 0;

function wheel(phase: number, rear: boolean) {
  const t = (Date.now() - started) / 1000;
  return {
    temperature_c: 78 + (rear ? 6 : 0) + Math.sin(t / 4 + phase) * 2,
    slip_ratio:
      0.03 + Math.abs(Math.sin(t * 1.3 + phase)) * (rear ? 0.12 : 0.05),
    slip_angle: Math.sin(t + phase) * 0.06,
    combined_slip: 0.05 + Math.abs(Math.sin(t * 1.1 + phase)) * 0.2,
    rotation_rad_s: 92 + Math.sin(t / 3) * 20,
    normalized_suspension_travel: 0.42 + Math.sin(t * 2 + phase) * 0.08,
    suspension_travel_m: 0.061 + Math.sin(t * 2 + phase) * 0.01,
  };
}

/// Layout stress: the widest, signed values each field plausibly takes, held
/// constant so a layout test sees the worst case on every frame. Not a claim
/// that FH6 produces these; a claim that the layout survives them.
function stressFrame() {
  const wheel = (sign: number) => ({
    temperature_c: sign < 0 ? -40.0 : 123.4,
    slip_ratio: -12.345 * sign,
    slip_angle: -1.234 * sign,
    combined_slip: 12.345,
    rotation_rad_s: -1234.5,
    normalized_suspension_travel: 1.234,
    suspension_travel_m: -0.1234,
  });
  const vector = { x: -123456.7, y: -98765.4, z: -12345.6 };
  return {
    ...frame(true),
    engine: {
      rpm: 12345,
      idle_rpm: 1000,
      max_rpm: 15000,
      power_w: 1_234_567,
      torque_nm: -1500,
    },
    acceleration: { x: -98.76, y: -87.65, z: -76.54 },
    velocity: { x: -88.88, y: -77.77, z: -99.99 },
    angular_velocity: { x: -12.345, y: -23.456, z: -34.567 },
    orientation: { x: -3.1, y: -1.5, z: -3.0 },
    position: vector,
    speed_mps: 105.5,
    controls: {
      throttle: 1,
      brake: 1,
      clutch: 1,
      handbrake: 1,
      steering: -1,
    },
    wheels: {
      front_left: wheel(1),
      front_right: wheel(-1),
      rear_left: wheel(-1),
      rear_right: wheel(1),
    },
    race: {
      lap_number: 123,
      race_position: 12,
      race_time_seconds: 35999.999,
    },
  };
}

function frame(active: boolean) {
  const t = (Date.now() - started) / 1000;
  const throttle = Math.max(0, Math.sin(t / 2));
  const brake = Math.max(0, -Math.sin(t / 2)) * 0.8;
  const rpm = 2500 + throttle * 5200;
  return {
    active,
    game: "fh6",
    vehicle_id: "3421",
    game_timestamp_ms: Math.round(t * 1000),
    engine: {
      rpm: active ? rpm : 900,
      idle_rpm: 900,
      max_rpm: 8000,
      power_w: active ? throttle * 312000 : 0,
      torque_nm: active ? 180 + throttle * 285 : 0,
    },
    acceleration: { x: Math.sin(t) * 3, y: 0.1, z: throttle * 4 - brake * 9 },
    velocity: { x: Math.sin(t / 5) * 2, y: 0, z: 45 + Math.sin(t / 3) * 8 },
    angular_velocity: { x: 0.01, y: Math.sin(t) * 0.4, z: 0.02 },
    orientation: { x: t % 6.28, y: 0.01, z: -0.02 },
    position: { x: 1204.5 + t * 30, y: 12.1, z: -880.2 },
    speed_mps: active ? 45 + Math.sin(t / 3) * 8 : 0,
    controls: {
      throttle: active ? throttle : 0,
      brake: active ? brake : 0,
      clutch: 0,
      handbrake: 0,
      steering: active ? Math.sin(t / 1.5) * 0.35 : 0,
    },
    gear: { kind: "unmapped", value: 4 },
    vehicle: {
      class_code: 5,
      performance_index: 800,
      drivetrain_code: 2,
      cylinders: 6,
    },
    wheels: {
      front_left: wheel(0, false),
      front_right: wheel(0.4, false),
      rear_left: wheel(0.9, true),
      rear_right: wheel(1.3, true),
    },
    race: { lap_number: 0, race_position: 0, race_time_seconds: t },
    // Illustrative adapter envelope (layout review only): wire values in
    // packet order, as the FH6 adapter serializes them.
    sourceSpecific: {
      fh6: {
        car_ordinal: 2314,
        car_class: 5,
        car_performance_index: 800,
        drivetrain_type: 2,
        num_cylinders: 6,
        gear: 4,
        power: active ? throttle * 312000 : 0,
        torque: active ? 180 + throttle * 285 : 0,
        boost: 0,
        fuel: 0.62,
        tire_temperatures: [176.2, 177.8, 186.9, 187.3],
        normalized_suspension_travel: [0.41, 0.43, 0.52, 0.51],
        suspension_travel_metres: [0.0612, 0.0634, 0.0701, 0.0698],
        tire_slip_ratio: [0.04, 0.05, 0.11, 0.1],
        tire_slip_angle: [0.01, -0.02, 0.03, -0.01],
        tire_combined_slip: [0.08, 0.09, 0.16, 0.15],
        wheel_rotation_rad_s: [92.4, 92.6, 95.1, 95.3],
        distance_traveled: 0,
        best_lap: 0,
        last_lap: 0,
        current_lap: 0,
        current_race_time: t,
        lap_number: 0,
        race_position: 0,
        is_race_on: active ? 1 : 0,
        timestamp_ms: Math.round(t * 1000),
      },
    },
  };
}

function live(): LiveSnapshot {
  revision += 1;
  const elapsed = Date.now() - started;
  const base = {
    revision,
    health: "GOOD",
    protocol: "fh6",
    protocol_confidence: 1,
    valid_packets: Math.round(elapsed / 16),
    invalid_packets: 0,
    valid_active_fh6: Math.round(elapsed / 16),
    valid_inactive_fh6: 120,
    invalid_fh6: 0,
    unknown_protocol: 0,
    input_packet_hz: 60,
    valid_frame_hz: 60,
    last_packet_age_ms: 8,
    last_valid_frame_age_ms: 8,
    receive_errors: 0,
    stale: false,
    issues: [],
    transport_error: null,
    hub: {
      published: Math.round(elapsed / 16),
      recent_frames: 512,
      ring_capacity: 512,
      ring_evictions: 0,
      subscribers: 2,
      subscriber_drops: 0,
      last_drop_ms: null,
    },
    grace_period_ms: 10000,
  };
  const session = {
    id: "2026-10-01T14-32-05Z",
    started_at: started,
    duration_ms: elapsed + 754_000,
    game: "fh6",
    vehicle_id: "3421",
    state: "ACTIVE",
    grace_remaining_ms: null,
    ended_reason: null,
  };
  const detected = scenario === "setup-complete" && elapsed > 2500;
  if (scenario === "setup-complete") {
    return (
      detected
        ? { ...base, connection: "SESSION_ACTIVE", frame: frame(true), session }
        : {
            ...base,
            connection: "LISTENING",
            health: "LOST",
            protocol: null,
            frame: null,
            session: null,
          }
    ) as LiveSnapshot;
  }
  switch (scenario) {
    case "stress":
      return {
        ...base,
        connection: "SESSION_ACTIVE",
        frame: stressFrame(),
        session,
      } as LiveSnapshot;
    case "live":
    case "recording-failed":
    case "recovered-recorder":
      return {
        ...base,
        connection: "SESSION_ACTIVE",
        frame: frame(true),
        session,
      } as LiveSnapshot;
    case "degraded":
      // A recent hub subscriber drop (< 2 s) holds connection and health at
      // DEGRADED while fresh frames keep arriving (live_telemetry.rs).
      return {
        ...base,
        connection: "DEGRADED",
        health: "DEGRADED",
        frame: frame(true),
        session,
        hub: { ...base.hub, subscriber_drops: 3, last_drop_ms: elapsed },
      } as LiveSnapshot;
    case "idle":
      return {
        ...base,
        connection: "CONNECTED_IDLE",
        frame: frame(false),
        session: null,
      } as LiveSnapshot;
    case "grace":
      return {
        ...base,
        connection: "GRACE",
        frame: null,
        session: {
          ...session,
          state: "GRACE",
          grace_remaining_ms: Math.max(0, 10000 - (elapsed % 10000)),
        },
      } as LiveSnapshot;
    case "port-error":
      return {
        ...base,
        connection: "ERROR",
        health: "LOST",
        protocol: null,
        frame: null,
        session: null,
        transport_error:
          "could not bind 127.0.0.1:20440: Only one usage of each socket address is normally permitted. (os error 10048)",
      } as LiveSnapshot;
    default:
      return {
        ...base,
        connection: "LISTENING",
        health: "LOST",
        protocol: null,
        valid_packets: 0,
        valid_active_fh6: 0,
        valid_inactive_fh6: 0,
        input_packet_hz: 0,
        valid_frame_hz: 0,
        last_packet_age_ms: null,
        last_valid_frame_age_ms: null,
        frame: null,
        session: null,
      } as LiveSnapshot;
  }
}

let recorderRevision = 0;
function recorder(): RecorderStatus {
  const recording = scenario === "live" || scenario === "recovered-recorder";
  if (recording || recorderRevision === 0) recorderRevision += 1;
  const elapsed = Date.now() - started;
  return {
    revision: recorderRevision,
    status:
      scenario === "recording-failed"
        ? "error"
        : recording
          ? "recording"
          : "idle",
    recording,
    sessions_directory: "%LOCALAPPDATA%\\com.tahagurvardar.racelab\\sessions",
    session_id: recording ? "2026-10-01T14-32-05Z" : null,
    session_directory: null,
    game: recording ? "fh6" : null,
    vehicle_id: recording ? "3421" : null,
    started_at_unix_ms: recording ? started : null,
    duration_ms: recording ? elapsed + 754_000 : 0,
    frames_written: recording ? Math.round((elapsed + 754_000) / 16) : 0,
    active_frames: 0,
    inactive_frames: 0,
    queued_frames: recording ? 3 : 0,
    recorder_dropped_frames: 0,
    lifetime_dropped_frames: 0,
    queue_capacity: 4096,
    last_completed_session_id: null,
    completed_sessions: 3,
    last_error:
      scenario === "recording-failed" || scenario === "recovered-recorder"
        ? "Could not write frames.rlframes: There is not enough space on the disk. (os error 112)"
        : null,
  };
}

const GIB = 1024 ** 3;
const storageOver =
  new URLSearchParams(location.search).get("storage") === "over";
/// The saved limit; with ?storage=over it differs from the one in force.
let configuredBudget = storageOver ? 25 * GIB : 8 * GIB;

const RESPONSES: Record<string, (args: Record<string, unknown>) => unknown> = {
  get_live_telemetry: live,
  get_recorder_status: recorder,
  get_setup_state: () => {
    const firstRun =
      scenario === "first-run" ||
      (scenario === "setup-complete" && Date.now() - started <= 2500);
    return {
      first_run: firstRun,
      listen_host: "127.0.0.1",
      listen_port: 20440,
      fh6_first_detected_unix_ms: firstRun ? null : started,
    };
  },
  get_telemetry_stats: () => ({
    revision: 1,
    session_id: 1,
    running: scenario !== "port-error",
    bound_port: scenario === "port-error" ? null : 20440,
    receive_buffer_bytes: 4_194_304,
    total_packets: 120_400,
    packets_per_second: scenario === "live" ? 60 : 0,
    total_bytes: 39_853_000,
    last_packet_size: 331,
    last_source: "127.0.0.1:61234",
    last_packet_timestamp_ms: Date.now(),
    last_packet_monotonic_us: 1,
    preview_hex:
      "01 00 00 00 9c 4a 0b 00 00 40 7a 44 00 00 61 44 c3 1e 1f 45 00 00 00 00 00 00 00 00 00 00 00 00",
    receive_errors: 0,
    last_error:
      scenario === "port-error"
        ? "could not bind 127.0.0.1:20440 (os error 10048)"
        : null,
  }),
  get_capture_stats: () => ({
    revision: 1,
    status: "idle",
    accepting_packets: false,
    label: "",
    directory: "%LOCALAPPDATA%\\com.tahagurvardar.racelab\\captures",
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
  }),
  ...SESSION_RESPONSES,
  get_storage_status: () => ({
    retention: {
      budget_bytes: 8 * GIB,
      enabled: true,
      used_bytes: storageOver ? 9.2 * GIB : 3.1 * GIB,
      over_budget: storageOver,
      retained_sessions: storageOver ? 41 : 3,
      protected_sessions: 1,
      unidentifiable_sessions: 0,
      unidentifiable_bytes: 0,
      deleted_sessions: storageOver ? 3 : 0,
      reclaimed_bytes: storageOver ? 1.4 * GIB : 0,
      failed_deletions: storageOver ? 1 : 0,
      sweeps: 1,
      last_sweep_unix_ms: started,
      last_deleted_session_id: null,
      last_error: storageOver
        ? "Could not delete session 2026-09-12T18-02-11Z: The process cannot access the file because it is being used by another process. (os error 32)"
        : null,
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
  }),
  get_settings: () => settingsSnapshot(),
  set_storage_budget: (args) => {
    configuredBudget = Number(args.budgetBytes);
    return settingsSnapshot();
  },
};

function settingsSnapshot() {
  return {
    storage_budget_bytes: configuredBudget,
    storage_budget_from_environment: false,
    min_storage_budget_bytes: 1 * GIB,
    max_storage_budget_bytes: 1024 * GIB,
    default_storage_budget_bytes: 8 * GIB,
    fh6_first_detected_unix_ms: started,
    last_error: null,
    path: "%APPDATA%\\com.tahagurvardar.racelab\\settings.json",
  };
}

let callbackId = 0;
const callbacks = new Map<number, (payload: unknown) => void>();

const internals = {
  transformCallback(callback: (payload: unknown) => void) {
    callbackId += 1;
    callbacks.set(callbackId, callback);
    return callbackId;
  },
  unregisterCallback(id: number) {
    callbacks.delete(id);
  },
  async invoke(command: string, args: Record<string, unknown> = {}) {
    if (command === "plugin:event|listen") return ++callbackId;
    if (command === "plugin:event|unlisten") return undefined;
    const respond = RESPONSES[command];
    if (!respond) throw new Error(`mock backend: no fixture for ${command}`);
    return structuredClone(await respond(args));
  },
  convertFileSrc: (path: string) => path,
};

Object.assign(window, {
  __TAURI_INTERNALS__: internals,
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
});

// ------------------------------------------------------------ render probe

/// Counts which components actually rendered, per commit, through the React
/// DevTools hook — no instrumentation in the application. A fiber was
/// processed in a commit iff it is not the same object as in the previous
/// committed tree; it rendered iff React also flagged it PerformedWork (1).
type Fiber = {
  type?: { name?: string; displayName?: string } | string | null;
  flags: number;
  child: Fiber | null;
  sibling: Fiber | null;
};
const renders: Record<string, number> = {};
let previous = new WeakSet<Fiber>();
Object.assign(window, {
  __renders: renders,
  __resetRenders: () => {
    for (const key of Object.keys(renders)) delete renders[key];
  },
  __REACT_DEVTOOLS_GLOBAL_HOOK__: {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject: () => 1,
    checkDCE() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onScheduleFiberRoot() {},
    onCommitFiberRoot(_id: number, root: { current: Fiber }) {
      const seen = new WeakSet<Fiber>();
      const stack: Fiber[] = [root.current];
      while (stack.length) {
        const fiber = stack.pop()!;
        seen.add(fiber);
        const type = fiber.type;
        if (
          type &&
          typeof type !== "string" &&
          !previous.has(fiber) &&
          (fiber.flags & 1) === 1
        ) {
          const name = type.displayName ?? type.name;
          if (name) renders[name] = (renders[name] ?? 0) + 1;
        }
        if (fiber.sibling) stack.push(fiber.sibling);
        if (fiber.child) stack.push(fiber.child);
      }
      previous = seen;
    },
  },
});
