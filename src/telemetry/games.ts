/// The supported games, what each one is doing right now, and which one the
/// product presents.
///
/// Every fact here is read from a backend store — the FH6 live snapshot and
/// the F1 25 live status — never from text on screen. The choice of game is a
/// pure function of those facts and the previous choice, so it is tested
/// without React and it cannot flicker: a game that is still sending keeps
/// the screen.
import type { F1LiveState, LiveState } from "../state/stores.ts";
import { familyFreshness } from "./f1-freshness.ts";

export type SupportedGame = "fh6" | "f1_25";

/// Fixed order. It is also the tie-break when two games are equally recent.
export const SUPPORTED_GAMES: readonly SupportedGame[] = ["fh6", "f1_25"];

/// The names the product shows. Identifiers such as "fh6" stay internal.
export const GAME_NAMES: Record<SupportedGame, string> = {
  fh6: "Forza Horizon 6",
  f1_25: "F1 25",
};

/// - inactive: nothing current from this game.
/// - detected: the game is sending valid telemetry, but not driving
///   telemetry (a menu, a pause screen, spectating).
/// - active: driving telemetry is current.
/// - stale: the game was connected and has stopped or degraded, but the
///   backend has not let it go (FH6's held session or a recent fault; F1 25
///   silent for a few seconds).
export type GameActivity = "inactive" | "detected" | "active" | "stale";

export interface GameFacts {
  activity: GameActivity;
  /// Age of the game's latest valid telemetry, used only to choose between
  /// two games that start sending together.
  ageMs: number | null;
}

export type GameFactSet = Record<SupportedGame, GameFacts>;

const INACTIVE: GameFacts = { activity: "inactive", ageMs: null };

export function isFresh(facts: GameFacts): boolean {
  return facts.activity === "active" || facts.activity === "detected";
}

/// FH6, from the backend's own connection state. The backend owns FH6's
/// silence, grace and fault timing; this only names its states.
export function fh6Facts(live: LiveState): GameFacts {
  const snapshot = live.snapshot;
  if (live.error != null || snapshot == null || snapshot.protocol !== "fh6") {
    return INACTIVE;
  }
  const ageMs = snapshot.last_valid_frame_age_ms;
  const driving = !snapshot.stale && snapshot.frame?.active === true;
  switch (snapshot.connection) {
    case "SESSION_ACTIVE":
    case "CONNECTED_IDLE":
      return { activity: driving ? "active" : "detected", ageMs };
    case "GRACE":
    case "DEGRADED":
      // A recent fault can coexist with fresh valid frames: those are still
      // current driving telemetry.
      return { activity: driving ? "active" : "stale", ageMs };
    default:
      return INACTIVE;
  }
}

/// F1 25 counts as sending while an accepted packet of any type is at most
/// this old: the backend's own detection window.
export const F1_DETECTION_WINDOW_MS = 2000;
/// Beyond this, a silent F1 25 is gone rather than paused.
export const F1_STALE_LIMIT_MS = 10_000;

/// F1 25, from `get_f1_live`. Driving means the player's Car Telemetry is
/// fresh; any other accepted packet only means the game is there.
export function f1Facts(state: F1LiveState): GameFacts {
  const status = state.status;
  if (
    state.error != null ||
    status == null ||
    !status.enabled ||
    !status.listening
  ) {
    return INACTIVE;
  }
  const ageMs = status.last_accepted_age_ms;
  if (ageMs == null || ageMs > F1_STALE_LIMIT_MS) return INACTIVE;
  if (ageMs > F1_DETECTION_WINDOW_MS) return { activity: "stale", ageMs };
  const telemetry = status.live.car_telemetry;
  const driving =
    status.live.player_available &&
    telemetry?.value.player != null &&
    familyFreshness(telemetry.age_ms) === "fresh";
  return { activity: driving ? "active" : "detected", ageMs };
}

function mostRecent(games: SupportedGame[], facts: GameFactSet): SupportedGame {
  return games.reduce((best, game) =>
    (facts[game].ageMs ?? Infinity) < (facts[best].ageMs ?? Infinity)
      ? game
      : best,
  );
}

/// The game the product presents. Sticky by construction:
///
/// A/E. The selected game keeps the screen while it is fresh, even if the
///      other game is fresh too.
/// B.   When it is no longer fresh and exactly one other game is, switch.
/// C.   With nothing selected and exactly one game fresh, select it.
/// D.   With nothing selected and both fresh, take the most recent.
/// F.   With nothing fresh, nothing is selected — except that a game the
///      backend still holds (stale: FH6's grace or a fault, F1 25 briefly
///      silent) keeps or takes the screen when no other game is fresh, so
///      "Paused" and "Telemetry degraded" keep their meaning instead of
///      turning into "Waiting".
export function arbitrate(
  previous: SupportedGame | null,
  facts: GameFactSet,
): SupportedGame | null {
  const fresh = SUPPORTED_GAMES.filter((game) => isFresh(facts[game]));
  if (previous != null) {
    if (isFresh(facts[previous])) return previous;
    const others = fresh.filter((game) => game !== previous);
    if (others.length > 0) return mostRecent(others, facts);
    return facts[previous].activity === "stale" ? previous : null;
  }
  if (fresh.length > 0) return mostRecent(fresh, facts);
  const stale = SUPPORTED_GAMES.filter(
    (game) => facts[game].activity === "stale",
  );
  return stale.length === 1 ? stale[0] : null;
}
