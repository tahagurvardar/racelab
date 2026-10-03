/// The one application state a user reads first.
///
/// RaceLab reports connection, health, session and recording as four separate
/// readings (`buildStatus`). A person glancing at the window wants one answer —
/// "live", "waiting for the game", "not listening" — with the four readings one
/// click away. This module chooses that answer.
///
/// It adds an order, never a meaning: every state below is a direct reading of
/// a field the backend already reports, and the four detailed readings are
/// still produced by `buildStatus` unchanged.
import type { LiveSnapshot } from "./live-snapshot.ts";
import type { SetupState } from "./setup-view-model.ts";
import { number } from "./formatting.ts";

export type ProductStateKind =
  | "service_unreachable"
  | "not_listening"
  | "recording_failed"
  | "starting"
  | "first_run"
  | "waiting"
  | "detecting"
  | "degraded"
  | "paused"
  | "connected_idle"
  | "live";

export type ProductTone = "neutral" | "good" | "warn" | "bad";

export interface ProductState {
  kind: ProductStateKind;
  tone: ProductTone;
  /// A few words for the top bar.
  title: string;
  /// One sentence for the state popover.
  detail: string;
  /// Present when the title carries a ticking figure (the grace countdown):
  /// the title split around the figure, and the figure's widest digit count,
  /// so the top bar can give it a fixed tabular slot and never reflow.
  /// `lead + figure + tail` is exactly `title`.
  countdown?: {
    lead: string;
    figure: string;
    tail: string;
    digits: number;
  };
}

export interface ProductStateInput {
  snapshot: LiveSnapshot | null;
  /// A failure to read live telemetry or transport statistics at all.
  serviceError: string | null;
  /// `null` until the first transport statistics arrive.
  listenerRunning: boolean | null;
  recorderStatus: string | null;
  recorderError: string | null;
  setup: SetupState | null;
}

export const GAME = "Forza Horizon 6";

/// Priority, highest first: a broken service, then a listener that cannot
/// receive anything, then a failing recording, then where the game is.
/// Transport problems outrank a recorder failure exactly as they do in the
/// global banner.
export function resolveProductState(input: ProductStateInput): ProductState {
  const { snapshot } = input;
  if (input.serviceError != null) {
    return {
      kind: "service_unreachable",
      tone: "bad",
      title: "RaceLab service not responding",
      detail:
        "The window cannot read telemetry from the RaceLab background service.",
    };
  }
  if (snapshot?.transport_error != null || snapshot?.connection === "ERROR") {
    return {
      kind: "not_listening",
      tone: "bad",
      title: "Not listening",
      detail:
        "RaceLab could not open its telemetry port, so nothing from the game can arrive.",
    };
  }
  if (input.listenerRunning === false) {
    return {
      kind: "not_listening",
      tone: "bad",
      title: "Not listening",
      detail:
        "RaceLab is not listening for telemetry, so nothing from the game can arrive. Restarting RaceLab starts it again.",
    };
  }
  if (input.recorderStatus === "error") {
    return {
      kind: "recording_failed",
      tone: "bad",
      title: "Recording failed",
      detail: input.recorderError ?? "RaceLab could not write this recording.",
    };
  }
  if (snapshot == null || input.listenerRunning == null) {
    return {
      kind: "starting",
      tone: "neutral",
      title: "Starting",
      detail: "RaceLab is starting.",
    };
  }
  if (input.setup?.first_run) {
    return {
      kind: "first_run",
      tone: "neutral",
      title: `Set up ${GAME}`,
      detail: `Turn on Data Out in ${GAME} once, and RaceLab does the rest.`,
    };
  }
  const frame = snapshot.stale ? null : snapshot.frame;
  // Degradation outranks an ordinary healthy Live. The backend still delivers
  // a fresh frame while a recent fault holds connection or health at DEGRADED,
  // and those readings stay on screen — but the state is never green.
  const degraded =
    snapshot.connection === "DEGRADED" || snapshot.health === "DEGRADED";
  if (frame?.active) {
    if (degraded) return degradedState(snapshot, true);
    return {
      kind: "live",
      tone: "good",
      title: "Live",
      detail: `Receiving live driving telemetry from ${GAME}.`,
    };
  }
  switch (snapshot.connection) {
    case "GRACE": {
      const remaining = snapshot.session?.grace_remaining_ms;
      const detail =
        "Driving telemetry stopped. The session is held open until driving resumes or the hold runs out.";
      if (remaining == null) {
        return { kind: "paused", tone: "warn", title: "Paused", detail };
      }
      const lead = "Paused · session ends in ";
      const figure = number(remaining / 1000, 0);
      const tail = " s";
      // The widest the figure can be is the backend's own grace period.
      const longest = number(
        Math.max(snapshot.grace_period_ms ?? 0, remaining) / 1000,
        0,
      );
      return {
        kind: "paused",
        tone: "warn",
        title: `${lead}${figure}${tail}`,
        detail,
        countdown: { lead, figure, tail, digits: longest.length },
      };
    }
    case "DEGRADED":
      return degradedState(snapshot, false);
    case "CONNECTED_IDLE":
    case "SESSION_ACTIVE":
      if (degraded) return degradedState(snapshot, false);
      return {
        kind: "connected_idle",
        tone: "good",
        title: "Connected · not driving",
        detail: `${GAME} is connected but is not sending driving telemetry — usually a menu, a loading screen or a pause.`,
      };
    case "PROBING":
      return {
        kind: "detecting",
        tone: "neutral",
        title: "Detecting game",
        detail: "Data is arriving and RaceLab is identifying it.",
      };
    default:
      return {
        kind: "waiting",
        tone: "neutral",
        title: `Waiting for ${GAME}`,
        detail:
          "RaceLab is listening and connects on its own as soon as the game sends telemetry.",
      };
  }
}

/// Why the backend says telemetry is degraded, in the backend's own terms.
///
/// `live_telemetry.rs` degrades connection and health for three reasons: an
/// invalid packet in the last two seconds, a frame dropped between RaceLab's
/// own components (a hub subscriber drop) in the last two seconds, or a
/// transport error — which is reported separately, as Not listening. The
/// snapshot carries the validation issues and lifetime counters but not which
/// fault is the recent one, so a cause is named only when the counters leave
/// a single possibility; otherwise the sentence names both.
export function degradedCause(snapshot: LiveSnapshot): string {
  if (snapshot.issues.length > 0) {
    return "The latest packets failed validation.";
  }
  const invalid = snapshot.invalid_fh6 + snapshot.invalid_packets;
  const drops = snapshot.hub?.subscriber_drops ?? 0;
  if (invalid > 0 && drops === 0) {
    return "Recent packets failed validation.";
  }
  if (drops > 0 && invalid === 0) {
    return "Telemetry frames were recently dropped inside RaceLab.";
  }
  return "RaceLab recently saw invalid packets or dropped telemetry frames internally.";
}

function degradedState(
  snapshot: LiveSnapshot,
  readingsShown: boolean,
): ProductState {
  return {
    kind: "degraded",
    tone: "warn",
    title: readingsShown ? "Live · degraded" : "Telemetry degraded",
    detail: `${degradedCause(snapshot)} ${
      readingsShown
        ? "The readings on screen come from the latest valid frame."
        : "No reading is presented as current."
    }`,
  };
}
