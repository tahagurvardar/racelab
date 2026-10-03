/// Which supported game the product presents, kept current from the two
/// telemetry stores.
///
/// A derived store with memory: the choice is sticky (`arbitrate`), so it
/// needs the previous choice, and it must be the same choice for the top bar,
/// Live, Settings and every other reader. This module is its only writer. It
/// recomputes when either telemetry store changes — no timer, no React owner
/// — and notifies only when the choice or a game's activity changes, so a
/// reader selecting the game re-renders a handful of times per session, not
/// at the telemetry rate.
import { createStore, f1LiveStore, liveStore } from "./stores.ts";
import { useStore } from "./use-store.ts";
import {
  arbitrate,
  f1Facts,
  fh6Facts,
  type GameActivity,
  type SupportedGame,
} from "../telemetry/games.ts";

export interface ActiveGameState {
  game: SupportedGame | null;
  fh6: GameActivity;
  f1_25: GameActivity;
}

export const INITIAL_ACTIVE_GAME: ActiveGameState = {
  game: null,
  fh6: "inactive",
  f1_25: "inactive",
};

export const activeGameStore =
  createStore<ActiveGameState>(INITIAL_ACTIVE_GAME);

/// One arbitration step from the current telemetry stores.
export function nextActiveGame(previous: ActiveGameState): ActiveGameState {
  const fh6 = fh6Facts(liveStore.get());
  const f1 = f1Facts(f1LiveStore.get());
  const game = arbitrate(previous.game, { fh6, f1_25: f1 });
  if (
    game === previous.game &&
    fh6.activity === previous.fh6 &&
    f1.activity === previous.f1_25
  ) {
    return previous;
  }
  return { game, fh6: fh6.activity, f1_25: f1.activity };
}

function recompute() {
  activeGameStore.update(nextActiveGame);
}

liveStore.subscribe(recompute);
f1LiveStore.subscribe(recompute);
recompute();

/// Reader. Select a primitive — the game or one activity — so a component
/// re-renders only when that changes.
export function useActiveGame<S>(select: (state: ActiveGameState) => S): S {
  return useStore(activeGameStore, select);
}
