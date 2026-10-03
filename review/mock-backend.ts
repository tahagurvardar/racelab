/// DEV-ONLY review harness. Never imported by the application and never part
/// of `pnpm build` (Vite builds the main and overlay entry points alone).
///
/// It stands in for the Tauri backend so the redesigned shell can be reviewed
/// and screenshotted in a plain browser, in every product state, without a
/// game running. The values are illustrative fixtures for layout review only;
/// they are not captured telemetry and must never be used as test evidence.
///
/// Scenarios: ?scenario=live | stress | degraded | idle | waiting |
///            first-run | grace |
///            port-error | recording-failed | recovered-recorder
///            f1-live | f1-stale | f1-idle | f1-spectating | both
/// F1 25 snapshot: ?f1=stationary | driving | braking | high-speed
///   (default driving). F1 25 values are NOT illustrative: they are the real
///   captured fixtures decoded by the backend (live-snapshots.json, pinned by
///   a Rust test). Only their ages are set here.
/// Session sets: ?sessions=mixed | none | delayed (see session-fixtures.ts)
/// Storage: ?storage=over — over the limit, one failed deletion, and a saved
///          limit that differs from the one in force (applies next start)
import "./dev-only.ts";
import type { LiveSnapshot } from "../src/telemetry/live-snapshot.ts";
import type { RecorderStatus } from "../src/session-state.ts";
import { SESSION_RESPONSES } from "./session-fixtures.ts";
import F1_SNAPSHOTS from "../src-tauri/tests/fixtures/f1_25/live-snapshots.json";
import type { F1LiveStatus } from "../src/telemetry/f1-player.ts";
import type { F1EvidenceStatus } from "../src/telemetry/f1-evidence.ts";
import { f1Detail, f1Recorder } from "./f1-session-fixtures.ts";
import {
  DEFAULT_OVERLAY,
  type OverlayFrame,
  type OverlayStatus,
} from "../src/overlay/model.ts";

// Phase D review: ?sessions=multi-game | f1-empty | f1-long, with
// ?scenario=f1-recording | fh6-recording-f1-live. Select an F1 row to review
// Summary, Laps, Events and Data. F1 session data is synthetic and fixed.

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
  | "recovered-recorder"
  /// F1 25 only: real fixture values, every family fresh.
  | "f1-live"
  /// F1 25 only: Car Telemetry not updating (1.8 s), Motion Ex gone (6 s),
  /// Car Status and Lap Data fresh.
  | "f1-stale"
  /// F1 25 sending, but no Car Telemetry: connected, not driving.
  | "f1-idle"
  /// F1 25 sending with no player car (playerCarIndex 255).
  | "f1-spectating"
  /// Forza Horizon 6 live and F1 25 live at once: the first game to send
  /// keeps the screen.
  | "both"
  | "f1-recording"
  | "fh6-recording-f1-live";

const scenario = (new URLSearchParams(location.search).get("scenario") ??
  "live") as Scenario;
const started = Date.now();
let revision = 0;

const F1_SCENARIOS = new Set<string>([
  "f1-live",
  "f1-stale",
  "f1-idle",
  "f1-spectating",
  "both",
  "f1-recording",
  "fh6-recording-f1-live",
]);
const fh6Silent = F1_SCENARIOS.has(scenario) && scenario !== "both";

type F1Name = keyof typeof F1_SNAPSHOTS;
const f1Name = (new URLSearchParams(location.search).get("f1") ??
  "driving") as F1Name;

/// `get_f1_live`. Outside the F1 scenarios F1 25 is listening and silent, as
/// in a development build with only Forza Horizon 6 running.
function f1Live(): F1LiveStatus {
  const base = {
    enabled: true,
    configured_port: 20777,
    listening: true,
    bound_port: 20777,
    listener_error: null,
  };
  const empty = {
    session_uid: null,
    player_car_index: null,
    player_available: false,
    session_resets: 0,
    player_resets: 0,
    out_of_order_dropped: 0,
    car_telemetry: null,
    car_status: null,
    lap_data: null,
    motion_ex: null,
  };
  if (!F1_SCENARIOS.has(scenario)) {
    return { ...base, last_accepted_age_ms: null, live: empty };
  }
  const source = structuredClone(
    F1_SNAPSHOTS[f1Name] ?? F1_SNAPSHOTS.driving,
  ) as unknown as F1LiveStatus["live"];
  const aged = <T extends { age_ms: number } | null>(family: T, age: number) =>
    family == null ? null : { ...family, age_ms: age };
  const live = {
    ...source,
    car_telemetry: aged(source.car_telemetry, 30),
    car_status: aged(source.car_status, 30),
    lap_data: aged(source.lap_data, 30),
    motion_ex: aged(source.motion_ex, 30),
  };
  switch (scenario) {
    case "f1-stale":
      return {
        ...base,
        last_accepted_age_ms: 30,
        live: {
          ...live,
          car_telemetry: aged(source.car_telemetry, 1800),
          motion_ex: aged(source.motion_ex, 6000),
        },
      };
    case "f1-idle":
      return {
        ...base,
        last_accepted_age_ms: 30,
        live: { ...live, car_telemetry: null, motion_ex: null },
      };
    case "f1-spectating":
      return {
        ...base,
        last_accepted_age_ms: 30,
        live: {
          ...live,
          player_car_index: 255,
          player_available: false,
          car_telemetry: live.car_telemetry && {
            ...live.car_telemetry,
            value: { ...live.car_telemetry.value, player: null },
          },
          car_status: live.car_status && {
            ...live.car_status,
            value: { player: null },
          },
          lap_data: live.lap_data && {
            ...live.lap_data,
            value: { ...live.lap_data.value, player: null },
          },
          motion_ex: live.motion_ex && {
            ...live.motion_ex,
            value: { player: null },
          },
        },
      };
    default:
      return { ...base, last_accepted_age_ms: 30, live };
  }
}

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
  if (fh6Silent) {
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
  switch (scenario) {
    case "stress":
      return {
        ...base,
        connection: "SESSION_ACTIVE",
        frame: stressFrame(),
        session,
      } as LiveSnapshot;
    case "both":
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
  const recording =
    scenario === "live" ||
    scenario === "recovered-recorder" ||
    scenario === "fh6-recording-f1-live";
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
let f1RecorderRevision = 1;
const sessionMode = new URLSearchParams(location.search).get("sessions");
const reviewF1Sessions =
  ["multi-game", "f1-empty", "f1-long"].includes(sessionMode ?? "") ||
  scenario === "f1-recording" ||
  scenario === "fh6-recording-f1-live"
    ? [f1Detail()]
    : [];
for (const detail of reviewF1Sessions) {
  if (scenario === "f1-recording") {
    detail.session.racelab_session.status = "recording";
    detail.session.racelab_session.ended_at_unix_ms = null;
    detail.session.racelab_session.completion_reason = null;
  }
  if (sessionMode === "f1-empty") {
    detail.laps = null;
    detail.events = [];
    detail.events_total = 0;
    detail.result = null;
  }
  if (sessionMode === "f1-long") {
    detail.labels.track = {
      raw: 127,
      label: "A very long synthetic track name for narrow window layout review",
    };
    detail.session.f1_25.integrity.write_error =
      "Synthetic review error: " + "long-directory-segment/".repeat(16);
  }
}

// Overlay-specific variants never change the frozen main-window fixtures.
// ?overlay=stale|unavailable|disabled, ?drs=on (SYNTHETIC), ?gear=R|N|8,
// ?long=1 (SYNTHETIC limits), ?scale=1|1.25|1.5, ?edit=1.
const overlayParams = new URLSearchParams(location.search);
const overlayState: OverlayStatus = {
  preferences: {
    ...DEFAULT_OVERLAY,
    enabled:
      location.pathname.includes("overlay") &&
      overlayParams.get("overlay") !== "disabled",
    scale: Number(overlayParams.get("scale") ?? 1),
  },
  editing: overlayParams.get("edit") === "1",
  visible: true,
  error: null,
};
const overlayCalls: Record<string, number> = {};
function overlayFrame(): OverlayFrame {
  const f1 = f1Live();
  const variant = overlayParams.get("overlay");
  for (const family of [
    f1.live.car_telemetry,
    f1.live.car_status,
    f1.live.lap_data,
  ]) {
    if (family)
      family.age_ms =
        variant === "unavailable"
          ? 4000
          : variant === "stale"
            ? 1800
            : family.age_ms;
  }
  const telemetry = f1.live.car_telemetry?.value.player;
  if (telemetry) {
    if (overlayParams.get("drs") === "on")
      telemetry.drs = { raw: 1, label: "On" }; // synthetic UI acceptance only
    const gear = overlayParams.get("gear");
    if (gear === "R" || gear === "N" || gear === "8")
      telemetry.gear = {
        raw: gear === "R" ? -1 : gear === "N" ? 0 : 8,
        label: gear,
      };
    if (overlayParams.get("long") === "1") {
      telemetry.engine_rpm = 65535;
      telemetry.speed_kmh = 65535;
    }
  }
  return {
    state: overlayState,
    f1,
    fh6_active: scenario === "both" || scenario === "live",
    sample_age_ms: 0,
  };
}

const RESPONSES: Record<string, (args: Record<string, unknown>) => unknown> = {
  get_overlay_frame: overlayFrame,
  get_overlay_state: () => overlayState,
  configure_overlay: (args) => {
    overlayState.preferences.enabled = Boolean(args.enabled);
    overlayState.preferences.scale = Number(args.scale);
    overlayState.preferences.opacity = Number(args.opacity);
    overlayState.editing =
      Boolean(args.editing) && overlayState.preferences.enabled;
    return overlayState;
  },
  move_overlay: (args) => {
    overlayState.preferences.x =
      (overlayState.preferences.x ?? 24) + Number(args.dx);
    overlayState.preferences.y =
      (overlayState.preferences.y ?? 24) + Number(args.dy);
  },
  get_live_telemetry: live,
  get_f1_live: f1Live,
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
  // Opt-in visual review of the development Diagnostics tab. Evidence counters
  // stay empty; player values come from the captured, decoder-pinned fixtures.
  get_f1_evidence: () =>
    ({
      ...f1Live(),
      enabled: new URLSearchParams(location.search).get("evidence") === "1",
      transport_datagrams: 0,
      receive_errors: 0,
      capture: null,
      evidence: {
        detected: false,
        last_accepted_age_ms: null,
        last_accepted_unix_ms: null,
        header: null,
        session_uid_changes: 0,
        datagrams: 0,
        accepted: 0,
        truncated: 0,
        wrong_packet_format: 0,
        wrong_game_year: 0,
        unknown_packet_id: 0,
        unsupported_version: 0,
        size_mismatch: 0,
        last_rejection: null,
        kinds: [],
      },
    }) satisfies F1EvidenceStatus,
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
  get_f1_recorder_status: () => {
    const status = f1Recorder(scenario === "f1-recording");
    const phase = new URLSearchParams(location.search).get("f1recorder");
    if (
      phase === "grace" ||
      phase === "ending" ||
      phase === "candidate" ||
      phase === "disabled"
    ) {
      status.phase = phase;
      status.recording = phase === "grace" || phase === "ending";
      status.enabled = phase !== "disabled";
    }
    if (phase === "error") {
      status.phase = "idle";
      status.recording = false;
      status.last_error =
        "Synthetic review error: Access denied writing samples.rlf1";
    }
    if (status.recording) {
      status.revision = ++f1RecorderRevision;
      status.duration_ms += Date.now() - started;
    }
    if (recorder().recording) {
      status.recording_owner = "fh6";
      status.waiting_reason = "another_game_recording";
      status.sessions_refused_by_owner = 1;
    }
    return status;
  },
  list_recent_sessions: (args) => {
    const fh6 = SESSION_RESPONSES.list_recent_sessions(
      args,
    ) as import("../src/session-state.ts").RecentSessions;
    return {
      ...fh6,
      f1_sessions: reviewF1Sessions.map(({ session, labels }) => ({
        session,
        labels,
      })),
    };
  },
  get_f1_session: (args) => {
    const detail = reviewF1Sessions.find(
      (item) => item.session.racelab_session.session_id === args.sessionId,
    );
    if (!detail) throw new Error("F1 review session not found");
    return detail;
  },
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
    overlayCalls[command] = (overlayCalls[command] ?? 0) + 1;
    if (command === "plugin:event|listen") return ++callbackId;
    if (command === "plugin:event|unlisten") return undefined;
    const respond = RESPONSES[command];
    if (!respond) throw new Error(`mock backend: no fixture for ${command}`);
    return structuredClone(await respond(args));
  },
  convertFileSrc: (path: string) => path,
};

Object.assign(window, {
  __overlayCalls: overlayCalls,
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
