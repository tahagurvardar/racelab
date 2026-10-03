/// What Live says while no supported game is active: one product-level
/// sentence and each game's listening state, so nobody is told to wait for a
/// game they are not playing. Pure; the same words as the top bar.
import type {
  F1LiveState,
  LiveState,
  SetupStoreState,
} from "../state/stores.ts";
import type { TelemetryState } from "../telemetry-state.ts";
import { GAME_NAMES } from "./games.ts";
import { SUPPORTED_GAMES_TEXT } from "./product-state.ts";
import { resolveLiveFrame } from "./telemetry-view-model.ts";

export type WaitingTone = "good" | "neutral" | "bad";

export interface WaitingGame {
  key: "fh6" | "f1_25";
  name: string;
  /// Where the game must send, as the game's own settings ask for it.
  target: string;
  status: string;
  tone: WaitingTone;
}

export interface LiveWaitingModel {
  title: string;
  reason: string;
  /// True when the first-run guide or the global alert already explains the
  /// empty screen; Live then adds no second message.
  covered: boolean;
  games: WaitingGame[];
}

export function liveWaitingModel(input: {
  live: LiveState;
  transport: TelemetryState;
  setup: SetupStoreState;
  f1Live: F1LiveState;
}): LiveWaitingModel {
  const snapshot = input.live.snapshot;
  const listening = input.transport.stats?.running ?? false;
  const frame = resolveLiveFrame(snapshot, listening);
  const setup = input.setup.setup;
  const covered =
    (setup?.first_run ?? false) ||
    input.live.error != null ||
    (snapshot?.transport_error != null && frame.availability === "stopped");

  let title = "Waiting for a supported game";
  let reason = `RaceLab is listening and switches on its own to whichever game sends telemetry: ${SUPPORTED_GAMES_TEXT}.`;
  if (snapshot == null) {
    title = "Starting";
    reason = "RaceLab is starting.";
  } else if (frame.availability === "stopped") {
    title = "Not listening";
    reason = frame.reason;
  } else if (snapshot.connection === "PROBING") {
    title = "Detecting game";
    reason = "Data is arriving and RaceLab is identifying it.";
  }

  const f1 = input.f1Live;
  const f1Status = f1.status;
  const f1Game: WaitingGame =
    f1.available === false
      ? {
          key: "f1_25",
          name: GAME_NAMES.f1_25,
          target: "—",
          status: "Not available in this build",
          tone: "neutral",
        }
      : {
          key: "f1_25",
          name: GAME_NAMES.f1_25,
          target: f1Status
            ? `127.0.0.1, port ${f1Status.bound_port ?? f1Status.configured_port}`
            : "—",
          status:
            f1Status == null
              ? "Starting"
              : f1Status.listening
                ? "Listening · nothing arriving"
                : "Not listening",
          tone: f1Status != null && !f1Status.listening ? "bad" : "neutral",
        };

  return {
    title,
    reason,
    covered,
    games: [
      {
        key: "fh6",
        name: GAME_NAMES.fh6,
        target: setup ? `${setup.listen_host}, port ${setup.listen_port}` : "—",
        status: listening ? "Listening · nothing arriving" : "Not listening",
        tone: listening ? "neutral" : "bad",
      },
      f1Game,
    ],
  };
}
