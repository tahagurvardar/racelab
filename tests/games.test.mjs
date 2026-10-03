// V2.0 Phase C: which supported game the product presents. Pure facts and a
// sticky arbitration, then the derived store that applies them.
import test from "node:test";
import assert from "node:assert/strict";
import {
  F1_DETECTION_WINDOW_MS,
  F1_STALE_LIMIT_MS,
  arbitrate,
  f1Facts,
  fh6Facts,
} from "../src/telemetry/games.ts";
import {
  INITIAL_ACTIVE_GAME,
  activeGameStore,
  nextActiveGame,
} from "../src/state/active-game.ts";
import {
  INITIAL_F1_LIVE,
  INITIAL_LIVE,
  f1LiveFailed,
  f1LiveReceived,
  f1LiveStore,
  liveStore,
} from "../src/state/stores.ts";

const fresh = (ageMs = 10) => ({ activity: "active", ageMs });
const detected = (ageMs = 10) => ({ activity: "detected", ageMs });
const stale = (ageMs = 3000) => ({ activity: "stale", ageMs });
const off = { activity: "inactive", ageMs: null };
const facts = (fh6, f1_25) => ({ fh6, f1_25 });

// -------------------------------------------------------------- arbitration

test("no game: neutral waiting", () => {
  assert.equal(arbitrate(null, facts(off, off)), null);
});

test("one game sending selects it", () => {
  assert.equal(arbitrate(null, facts(fresh(), off)), "fh6");
  assert.equal(arbitrate(null, facts(off, fresh())), "f1_25");
  // Connected but not driving still selects the game.
  assert.equal(arbitrate(null, facts(off, detected())), "f1_25");
});

test("the active game stays while it is fresh, even when the other is fresh", () => {
  assert.equal(arbitrate("fh6", facts(fresh(500), fresh(5))), "fh6");
  assert.equal(arbitrate("f1_25", facts(fresh(5), detected(900))), "f1_25");
});

test("a game that stops sending hands over to one that is sending", () => {
  assert.equal(arbitrate("fh6", facts(off, fresh())), "f1_25");
  assert.equal(arbitrate("fh6", facts(stale(), fresh())), "f1_25");
  assert.equal(arbitrate("f1_25", facts(fresh(), off)), "fh6");
  assert.equal(arbitrate("f1_25", facts(detected(), stale())), "fh6");
});

test("both starting together: the most recent wins, ties go to the fixed order", () => {
  assert.equal(arbitrate(null, facts(fresh(40), fresh(12))), "f1_25");
  assert.equal(arbitrate(null, facts(fresh(12), fresh(40))), "fh6");
  assert.equal(arbitrate(null, facts(fresh(20), fresh(20))), "fh6");
});

test("both sending never flaps, however their ages interleave", () => {
  let game = null;
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    // FH6 at 60 Hz and F1 25 at 20 Hz: whichever packet is newer alternates.
    const fh6Age = (i * 17) % 16;
    const f1Age = (i * 31) % 50;
    game = arbitrate(game, facts(fresh(fh6Age), fresh(f1Age)));
    seen.add(game);
  }
  assert.equal(seen.size, 1);
});

test("neither fresh: waiting — unless the selected game is only paused", () => {
  assert.equal(arbitrate("fh6", facts(off, off)), null);
  assert.equal(arbitrate("f1_25", facts(off, off)), null);
  // FH6's held session (grace) keeps its own screen and words.
  assert.equal(arbitrate("fh6", facts(stale(), off)), "fh6");
  assert.equal(arbitrate("f1_25", facts(off, stale())), "f1_25");
  // From nothing, a single held game is still that game (FH6 degraded with
  // no valid frame says "degraded", not "waiting").
  assert.equal(arbitrate(null, facts(stale(), off)), "fh6");
  // Two held games and nothing fresh: no basis to choose.
  assert.equal(arbitrate(null, facts(stale(), stale())), null);
});

// -------------------------------------------------------------------- facts

function fh6(overrides = {}) {
  return {
    snapshot: {
      revision: 1,
      connection: "SESSION_ACTIVE",
      health: "GOOD",
      protocol: "fh6",
      last_valid_frame_age_ms: 8,
      stale: false,
      frame: { active: true },
      ...overrides,
    },
    error: null,
  };
}

test("FH6 facts come from the backend's own connection state", () => {
  assert.equal(fh6Facts(INITIAL_LIVE).activity, "inactive");
  assert.equal(fh6Facts(fh6()).activity, "active");
  assert.equal(
    fh6Facts(fh6({ frame: { active: false } })).activity,
    "detected",
  );
  assert.equal(
    fh6Facts(fh6({ connection: "CONNECTED_IDLE", frame: null })).activity,
    "detected",
  );
  assert.equal(
    fh6Facts(fh6({ connection: "GRACE", frame: null })).activity,
    "stale",
  );
  assert.equal(
    fh6Facts(fh6({ connection: "DEGRADED", frame: null })).activity,
    "stale",
  );
  // A recent fault beside fresh valid frames is still driving telemetry.
  assert.equal(fh6Facts(fh6({ connection: "DEGRADED" })).activity, "active");
  assert.equal(
    fh6Facts(fh6({ connection: "LISTENING", protocol: null, frame: null }))
      .activity,
    "inactive",
  );
  assert.equal(
    fh6Facts(fh6({ connection: "PROBING", protocol: null })).activity,
    "inactive",
  );
  // A withheld (stale) frame is never driving.
  assert.equal(fh6Facts(fh6({ stale: true })).activity, "detected");
  // A service error is never a game.
  assert.equal(fh6Facts({ ...fh6(), error: "down" }).activity, "inactive");
});

function f1(lastAcceptedAgeMs, telemetryAgeMs = 20, overrides = {}) {
  return f1LiveReceived(INITIAL_F1_LIVE, {
    enabled: true,
    configured_port: 20777,
    listening: true,
    bound_port: 20777,
    listener_error: null,
    last_accepted_age_ms: lastAcceptedAgeMs,
    live: {
      session_uid: "1",
      player_car_index: 0,
      player_available: true,
      session_resets: 0,
      player_resets: 0,
      out_of_order_dropped: 0,
      car_telemetry:
        telemetryAgeMs == null
          ? null
          : { age_ms: telemetryAgeMs, value: { player: { speed_kmh: 1 } } },
      car_status: null,
      lap_data: null,
      motion_ex: null,
      ...overrides,
    },
  });
}

test("F1 25 facts: sending, driving, paused, gone", () => {
  assert.equal(f1Facts(INITIAL_F1_LIVE).activity, "inactive");
  assert.equal(f1Facts(f1(20)).activity, "active");
  // Packets arriving but no fresh Car Telemetry: connected, not driving.
  assert.equal(f1Facts(f1(20, null)).activity, "detected");
  assert.equal(f1Facts(f1(20, 1500)).activity, "detected");
  // Spectating (no player car) is never driving.
  assert.equal(
    f1Facts(f1(20, 20, { player_car_index: 255, player_available: false }))
      .activity,
    "detected",
  );
  assert.equal(f1Facts(f1(F1_DETECTION_WINDOW_MS + 1)).activity, "stale");
  assert.equal(f1Facts(f1(F1_STALE_LIMIT_MS + 1)).activity, "inactive");
  assert.equal(f1Facts(f1(null)).activity, "inactive");
  // A release build (no listener) and a failing read are never a game.
  assert.equal(
    f1Facts(f1LiveReceived(INITIAL_F1_LIVE, { enabled: false })).activity,
    "inactive",
  );
  assert.equal(f1Facts(f1LiveFailed(f1(20), "down")).activity, "inactive");
});

// ------------------------------------------------------------ derived store

test("the active-game store follows both telemetry stores and stays sticky", () => {
  liveStore.set(INITIAL_LIVE);
  f1LiveStore.set(INITIAL_F1_LIVE);
  assert.equal(activeGameStore.get().game, null);

  f1LiveStore.set(f1(20));
  assert.equal(activeGameStore.get().game, "f1_25");
  assert.equal(activeGameStore.get().f1_25, "active");

  // FH6 starts too: F1 25 keeps the screen while it is sending.
  liveStore.set(fh6());
  assert.equal(activeGameStore.get().game, "f1_25");
  assert.equal(activeGameStore.get().fh6, "active");

  // F1 25 stops: FH6 takes over.
  f1LiveStore.set(f1(F1_STALE_LIMIT_MS + 1));
  assert.equal(activeGameStore.get().game, "fh6");

  // Both gone: waiting.
  liveStore.set(INITIAL_LIVE);
  assert.equal(activeGameStore.get().game, null);
  f1LiveStore.set(INITIAL_F1_LIVE);
});

test("an F1 25 session or player change does not move the selection", () => {
  liveStore.set(fh6({ last_valid_frame_age_ms: 5 }));
  f1LiveStore.set(INITIAL_F1_LIVE);
  f1LiveStore.set(f1(20));
  // FH6 was first: it keeps the screen.
  assert.equal(activeGameStore.get().game, "fh6");
  // A new F1 session clears every F1 family for a moment, and the player
  // index changes: neither is a reason to switch, or to flap.
  f1LiveStore.set(
    f1(20, null, { session_uid: "2", session_resets: 1, player_car_index: 3 }),
  );
  assert.equal(activeGameStore.get().game, "fh6");
  liveStore.set(INITIAL_LIVE);
  f1LiveStore.set(INITIAL_F1_LIVE);
});

test("the store notifies only when the choice or an activity changes", () => {
  liveStore.set(INITIAL_LIVE);
  f1LiveStore.set(INITIAL_F1_LIVE);
  f1LiveStore.set(f1(20));
  const before = activeGameStore.get();
  let notified = 0;
  const dispose = activeGameStore.subscribe(() => (notified += 1));
  for (let i = 0; i < 50; i += 1) f1LiveStore.set(f1(10 + (i % 30)));
  dispose();
  assert.equal(notified, 0, "steady telemetry never re-notifies");
  assert.equal(activeGameStore.get(), before);
  assert.equal(nextActiveGame(before), before);
  assert.deepEqual(INITIAL_ACTIVE_GAME, {
    game: null,
    fh6: "inactive",
    f1_25: "inactive",
  });
  f1LiveStore.set(INITIAL_F1_LIVE);
});
