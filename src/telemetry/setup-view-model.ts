/// First-run guidance.
///
/// RaceLab is automatic in every respect except one: it cannot make Forza
/// Horizon 6 send it anything. Data Out is off by default and only the user can
/// turn it on. That single manual step is the entire content of this module.
///
/// Two rules shape it:
///
/// 1. **It states what to do, not how it works.** A user is told an address and
///    a port to type into a game menu. The words "UDP", "datagram", "socket"
///    and "loopback" appear nowhere in the product text, because knowing any of
///    them would not help and not knowing them must not block anyone.
/// 2. **It goes away for good.** Guidance is shown until RaceLab has decoded
///    FH6 telemetry once, and the backend records that permanently. Launching
///    before the game, or with the game closed, is ordinary use afterwards and
///    never brings setup back.
import type { LiveSnapshot } from "./live-snapshot.ts";

/// `SetupState` as `lib.rs` serializes it.
export interface SetupState {
  first_run: boolean;
  listen_host: string;
  listen_port: number;
  fh6_first_detected_unix_ms: number | null;
}

/// `hidden` is the state of a configured installation, which is nearly every
/// launch. `detected` is the success confirmation shown once, to the user who
/// was looking at the instructions when the telemetry arrived.
export type SetupStage = "hidden" | "instructions" | "detected";

export interface SetupInput {
  setup: SetupState | null;
  /// True once this run of the application has observed `first_run`. Without
  /// it, the success state could never be shown: the backend marks setup
  /// complete within a quarter second of the first decoded packet, so
  /// `first_run` is already false by the time anyone could read it.
  sawFirstRun: boolean;
  dismissed: boolean;
}

export function resolveSetupStage({
  setup,
  sawFirstRun,
  dismissed,
}: SetupInput): SetupStage {
  // Never flash instructions at a configured user while the first read is
  // still in flight.
  if (!setup || dismissed) return "hidden";
  if (setup.first_run) return "instructions";
  return sawFirstRun ? "detected" : "hidden";
}

export interface SetupStep {
  key: string;
  text: string;
  /// The exact value to type, where the step has one. It also appears in
  /// `text`; it is separate only so it can be presented prominently.
  value?: string;
}

/// The Data Out steps, with the address and port taken from the backend rather
/// than written out here, so the product can never tell a user a number the
/// listener did not bind.
export function setupSteps(setup: SetupState): SetupStep[] {
  return [
    { key: "open", text: "Start Forza Horizon 6." },
    {
      key: "menu",
      text: "Open Settings, then HUD and Gameplay, and scroll to the Data Out section.",
    },
    { key: "enable", text: "Set Data Out to ON." },
    {
      key: "address",
      text: `Set Data Out IP Address to ${setup.listen_host}.`,
      value: setup.listen_host,
    },
    {
      key: "port",
      text: `Set Data Out IP Port to ${setup.listen_port}.`,
      value: String(setup.listen_port),
    },
    {
      key: "drive",
      text: "Go back and start driving. RaceLab picks everything up on its own from here.",
    },
  ];
}

export type DetectionTone = "neutral" | "good" | "warn" | "bad";

export interface DetectionStatus {
  tone: DetectionTone;
  text: string;
}

/// What RaceLab can honestly say about what is arriving, in a sentence.
///
/// The distinction that matters to somebody stuck is between "nothing is
/// arriving" — Data Out off, or the wrong port — and "something is arriving but
/// it is not FH6", which is a different mistake with a different fix.
export function detectionStatus(
  setup: SetupState,
  snapshot: LiveSnapshot | null,
): DetectionStatus {
  if (!snapshot) {
    return { tone: "neutral", text: "Starting RaceLab…" };
  }
  if (snapshot.protocol === "fh6") {
    return {
      tone: "good",
      text: "Forza Horizon 6 telemetry received. Setup is complete.",
    };
  }
  if (snapshot.transport_error) {
    return {
      tone: "bad",
      text: `RaceLab could not open port ${setup.listen_port}: ${snapshot.transport_error}`,
    };
  }
  if (snapshot.invalid_fh6 > 0) {
    return {
      tone: "warn",
      text: `Data is arriving on port ${setup.listen_port}, but it is not valid Forza Horizon 6 telemetry. Check that Data Out format is set to the Forza Horizon option.`,
    };
  }
  if (snapshot.unknown_protocol > 0) {
    return {
      tone: "warn",
      text: `Something is sending to port ${setup.listen_port}, but it is not Forza Horizon 6. Check the Data Out port in the game.`,
    };
  }
  return {
    tone: "neutral",
    text: `Listening on ${setup.listen_host}:${setup.listen_port}. Nothing has arrived yet — this is what RaceLab shows until Data Out is on and you are driving.`,
  };
}
