/// What the application frame shows on every screen: the top bar and the
/// global alert. Pure, so it is tested without React, and plain data, so the
/// top bar re-renders only when this result actually changes (`useDerived`).
import type { ActiveGameState } from "../state/active-game.ts";
import { f1RecordingPresentation } from "./f1-recording.ts";
import { recordingOwner, type SessionGameId } from "../f1-sessions.ts";
import type {
  F1LiveState,
  F1RecorderState,
  LiveState,
  RecorderState,
  SetupStoreState,
} from "../state/stores.ts";
import type { TelemetryState } from "../telemetry-state.ts";
import { f1Families } from "./f1-live-layout.ts";
import { UNAVAILABLE } from "./formatting.ts";
import {
  GAME_NAMES,
  arbitrate,
  f1Facts,
  fh6Facts,
  type GameActivity,
  type SupportedGame,
} from "./games.ts";
import {
  resolveF1ProductState,
  resolveProductState,
  type ProductState,
} from "./product-state.ts";
import {
  buildStatus,
  type StatusItem,
  type StatusTone,
} from "./telemetry-view-model.ts";

export interface ShellInput {
  live: LiveState;
  recorder: RecorderState;
  transport: TelemetryState;
  setup: SetupStoreState;
  /// Absent where only FH6 is wired (older callers): F1 25 is then inactive.
  f1Live?: F1LiveState;
  /// The sticky choice from `activeGameStore`. Absent, it is arbitrated
  /// afresh from the facts, with no previous choice.
  activeGame?: ActiveGameState;
  /// F1 25 recording (V2.0 Phase D). Absent where only FH6 is wired.
  f1Recorder?: F1RecorderState;
}

export interface ShellFact {
  key: string;
  label: string;
  value: string;
}

export interface ShellStatus {
  state: ProductState;
  /// The active game's product name, or "No game detected".
  game: string;
  /// The active game, or null while RaceLab is waiting for one.
  activeGame: SupportedGame | null;
  vehicleId: string;
  sessionDuration: string;
  /// The two top-bar facts for the active game.
  facts: ShellFact[];
  /// The four V1.0 status readings, unchanged, for the state popover.
  items: StatusItem[];
  /// `owner` is the game RaceLab is recording, which need not be the game
  /// on screen: the indicator follows the recording, never the screen.
  /// `label` is the indicator's text while recording ("REC · F1 25").
  recording: {
    active: boolean;
    value: string;
    tone: StatusTone;
    owner: SessionGameId | null;
    label: string;
  };
  /// Current-session recorder drops; the same figure Sessions warns about.
  droppedFrames: number;
}

/// A failure to read the backend at all — live telemetry or the transport
/// statistics. The same precedence V1.0 used for its banner.
function serviceError(input: ShellInput): string | null {
  return input.live.error ?? input.transport.connectionError;
}

function status(input: ShellInput) {
  const recorder = input.recorder.recorder;
  return buildStatus(
    input.live.snapshot,
    recorder?.recording ?? false,
    serviceError(input),
    recorder,
  );
}

/// The recording indicator's words. A failed recorder is "Not recording"
/// in the failure tone: the failure itself is the global alert's message
/// (title and the backend's words), so it is never repeated beside it.
export function recordingIndicator(
  recording: boolean,
  recorderStatus: string | null | undefined,
): { value: string; tone: StatusTone } {
  if (recorderStatus === "error")
    return { value: "Not recording", tone: "bad" };
  return recording
    ? { value: "Recording", tone: "good" }
    : { value: "Not recording", tone: "neutral" };
}

function activeOf(input: ShellInput): {
  game: SupportedGame | null;
  f1: GameActivity;
} {
  if (input.activeGame) {
    return { game: input.activeGame.game, f1: input.activeGame.f1_25 };
  }
  const fh6 = fh6Facts(input.live);
  const f1 = input.f1Live
    ? f1Facts(input.f1Live)
    : { activity: "inactive" as const, ageMs: null };
  return { game: arbitrate(null, { fh6, f1_25: f1 }), f1: f1.activity };
}

const GLYPHS: Record<StatusTone, string> = {
  neutral: "○",
  good: "●",
  warn: "◐",
  bad: "✕",
};

function item(
  key: string,
  label: string,
  value: string,
  tone: StatusTone,
): StatusItem {
  return { key, label, value, tone, glyph: GLYPHS[tone] };
}

/// The REC indicator, from whichever recorder owns RaceLab's one recording
/// slot. A failed FH6 recorder keeps its V1.1 "Not recording" failure tone.
function recordingOf(input: ShellInput): ShellStatus["recording"] {
  const recorder = input.recorder.recorder;
  const owner = recordingOwner(
    recorder?.recording ?? false,
    input.f1Recorder?.status ?? null,
  );
  const active = owner.game != null;
  return {
    active,
    ...recordingIndicator(
      active,
      owner.game === "f1_25" ? null : recorder?.status,
    ),
    owner: owner.game,
    label: owner.label,
  };
}

/// F1 25's top-bar readings: its lap facts, and popover readings in the same
/// four slots FH6 uses. Session and recording come from the F1 25 recorder.
function f1Shell(input: ShellInput, activity: GameActivity) {
  const families = f1Families(input.f1Live?.status?.live ?? null);
  const lap = families.lap.player;
  const current = (["telemetry", "status", "lap", "motion"] as const).filter(
    (key) => families[key].freshness === "fresh",
  ).length;
  const sending = activity === "active" || activity === "detected";
  return {
    facts: [
      {
        key: "lap",
        label: "Lap",
        value: lap ? String(lap.current_lap_num) : UNAVAILABLE,
      },
      {
        key: "position",
        label: "Position",
        value: lap ? String(lap.car_position) : UNAVAILABLE,
      },
    ],
    items: [
      item(
        "connection",
        "Connection",
        sending ? "F1 25 connected" : "F1 25 not sending",
        sending ? "good" : "warn",
      ),
      item(
        "health",
        "Telemetry",
        current + " of 4 data types current",
        current === 4 ? "good" : current === 0 ? "neutral" : "warn",
      ),
      f1SessionItem(input),
      f1RecordingItem(input),
    ],
  };
}

function f1SessionItem(input: ShellInput): StatusItem {
  const status = input.f1Recorder?.status ?? null;
  if (status?.recording) {
    const context = [status.track_label, status.session_type_label]
      .filter(Boolean)
      .join(" · ");
    return item("session", "Session", context || "F1 25 session", "good");
  }
  return item("session", "Session", "No F1 25 session recorded", "neutral");
}

function f1RecordingItem(input: ShellInput): StatusItem {
  const presentation = f1RecordingPresentation(input.f1Recorder);
  return item("recording", "Recording", presentation.value, presentation.tone);
}

export function shellStatus(input: ShellInput): ShellStatus {
  const recorder = input.recorder.recorder;
  const model = status(input);
  const active = activeOf(input);
  if (active.game === "f1_25") {
    const serviceDown = serviceError(input) ?? input.f1Live?.error ?? null;
    const state =
      serviceDown != null
        ? resolveProductState({
            snapshot: input.live.snapshot,
            serviceError: serviceDown,
            listenerRunning: input.transport.stats?.running ?? null,
            recorderStatus: null,
            recorderError: null,
            setup: input.setup.setup,
          })
        : resolveF1ProductState(active.f1);
    const f1 = f1Shell(input, active.f1);
    return {
      state,
      game: GAME_NAMES.f1_25,
      activeGame: "f1_25",
      vehicleId: UNAVAILABLE,
      sessionDuration: UNAVAILABLE,
      facts: f1.facts,
      items: f1.items,
      recording: recordingOf(input),
      // FH6 recorder drops belong to an FH6 recording only.
      droppedFrames: recorder?.recording ? recorder.recorder_dropped_frames : 0,
    };
  }
  const resolve = (recorderStatus: string | null) =>
    resolveProductState({
      snapshot: input.live.snapshot,
      serviceError: serviceError(input),
      listenerRunning: input.transport.stats?.running ?? null,
      recorderStatus,
      recorderError: recorder?.last_error ?? null,
      setup: input.setup.setup,
    });
  let state = resolve(recorder?.status ?? null);
  // A recording failure is announced once, by the global alert. The state
  // pill keeps saying where the game is, so the two never repeat each other.
  if (state.kind === "recording_failed") state = resolve(null);
  return {
    state,
    game: active.game === "fh6" ? GAME_NAMES.fh6 : model.game,
    activeGame: active.game,
    vehicleId: model.vehicleId,
    sessionDuration: model.sessionDuration,
    // No active game: the pill says "Waiting for a supported game" and the
    // top bar adds no game's facts beside it.
    facts:
      active.game == null
        ? []
        : [
            { key: "vehicle", label: "Vehicle", value: model.vehicleId },
            { key: "session", label: "Session", value: model.sessionDuration },
          ],
    items: model.items,
    recording: recordingOf(input),
    droppedFrames: recorder?.recorder_dropped_frames ?? 0,
  };
}

export interface ShellAlert {
  title: string;
  /// One plain sentence: what the failure means for the user.
  summary: string;
  /// The backend's own words, kept verbatim: they are what makes a report
  /// actionable. Shown under "Technical details", never as the only text.
  detail: string;
}

/// The global alert: exactly V1.0's banner condition and text, with a short
/// human title above it.
export function shellAlert(input: ShellInput): ShellAlert | null {
  const banner = status(input).banner;
  if (banner == null) return null;
  const recorderFailed = input.recorder.recorder?.status === "error";
  const fromRecorder =
    recorderFailed &&
    serviceError(input) == null &&
    input.live.snapshot?.transport_error == null;
  if (fromRecorder) {
    return {
      title: "Recording failed",
      summary:
        "RaceLab could not save this drive. Live telemetry is still shown, but it is not being recorded.",
      detail: banner,
    };
  }
  if (serviceError(input) != null) {
    return {
      title: "RaceLab service not responding",
      summary:
        "The window cannot reach the RaceLab background service, so nothing on screen is current. Restarting RaceLab usually fixes this.",
      detail: banner,
    };
  }
  return {
    title: "RaceLab cannot receive telemetry",
    summary:
      "RaceLab could not open its telemetry port, so nothing from the game can arrive. Another program may be using the port; restarting RaceLab usually fixes this.",
    detail: banner,
  };
}
