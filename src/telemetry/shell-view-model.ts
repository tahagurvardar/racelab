/// What the application frame shows on every screen: the top bar and the
/// global alert. Pure, so it is tested without React, and plain data, so the
/// top bar re-renders only when this result actually changes (`useDerived`).
import type {
  LiveState,
  RecorderState,
  SetupStoreState,
} from "../state/stores.ts";
import type { TelemetryState } from "../telemetry-state.ts";
import { resolveProductState, type ProductState } from "./product-state.ts";
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
}

export interface ShellStatus {
  state: ProductState;
  game: string;
  vehicleId: string;
  sessionDuration: string;
  /// The four V1.0 status readings, unchanged, for the state popover.
  items: StatusItem[];
  recording: { active: boolean; value: string; tone: StatusTone };
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

export function shellStatus(input: ShellInput): ShellStatus {
  const recorder = input.recorder.recorder;
  const model = status(input);
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
    game: model.game,
    vehicleId: model.vehicleId,
    sessionDuration: model.sessionDuration,
    items: model.items,
    recording: {
      active: recorder?.recording ?? false,
      ...recordingIndicator(recorder?.recording ?? false, recorder?.status),
    },
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
