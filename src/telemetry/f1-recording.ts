import { f1RecorderPhaseText } from "../f1-sessions.ts";
import type { F1RecorderState } from "../state/stores.ts";
import type { StatusTone } from "./telemetry-view-model.ts";

/// Coarse recorder presentation, shared by Live and the shell status detail.
/// Reading failures keep the last status but must not claim it is current.
export function f1RecordingPresentation(state?: F1RecorderState): {
  value: string;
  tone: StatusTone;
} {
  if (state?.error) {
    return {
      value: `F1 25 recorder status unavailable: ${state.error}`,
      tone: "warn",
    };
  }
  if (state == null || state.available === false || state.status == null) {
    return { value: "F1 25 recording unavailable", tone: "neutral" };
  }
  const status = state.status;
  if (status.last_error) {
    return {
      value: `F1 25 recording error: ${status.last_error}`,
      tone: "bad",
    };
  }
  return {
    value: f1RecorderPhaseText(status),
    tone: status.recording
      ? "good"
      : status.waiting_reason === "another_game_recording"
        ? "warn"
        : "neutral",
  };
}
