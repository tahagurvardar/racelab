// V2.0 Phase A: the F1 25 evidence view model, its store latch, and the
// Diagnostics tab that exists only where the backend runs the listener.
import "./support/dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { cleanup, click, h, mount, update } from "./support/shell.mjs";
import DiagnosticsWorkspace from "../src/workspaces/DiagnosticsWorkspace.tsx";
import {
  describeRejection,
  f1Connection,
  f1CounterEntries,
  f1HeaderEntries,
  f1KindRows,
} from "../src/telemetry/f1-evidence.ts";
import {
  INITIAL_F1,
  f1Failed,
  f1Received,
  f1Store,
} from "../src/state/stores.ts";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const SIZES = [
  1349, 753, 1285, 45, 1284, 1133, 1352, 1239, 1042, 954, 1041, 1460, 231, 273,
  101, 1131,
];
const NAMES = [
  "Motion",
  "Session",
  "Lap Data",
  "Event",
  "Participants",
  "Car Setups",
  "Car Telemetry",
  "Car Status",
  "Final Classification",
  "Lobby Info",
  "Car Damage",
  "Session History",
  "Tyre Sets",
  "Motion Ex",
  "Time Trial",
  "Lap Positions",
];
const SPEC_ONLY = new Set([4, 8, 9, 14, 15]);

const EMPTY_LIVE = {
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

function status(overrides = {}, evidence = {}) {
  return {
    enabled: true,
    configured_port: 20777,
    listening: true,
    bound_port: 20777,
    transport_datagrams: 0,
    receive_errors: 0,
    listener_error: null,
    live: EMPTY_LIVE,
    capture: null,
    ...overrides,
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
      kinds: SIZES.map((size, id) => ({
        id,
        kind: NAMES[id].toLowerCase().replace(/ /g, "_"),
        name: NAMES[id],
        expected_size: size,
        size_evidence: SPEC_ONLY.has(id) ? "spec_only" : "spec_and_live",
        accepted: 0,
        accepted_bytes: 0,
        rate_hz: 0,
        size_mismatches: 0,
        unsupported_versions: 0,
        last_observed_size: null,
        last_accepted_unix_ms: null,
      })),
      ...evidence,
    },
  };
}

const HEADER = {
  packet_format: 2025,
  game_year: 25,
  game_major_version: 1,
  game_minor_version: 7,
  packet_version: 1,
  packet_id: 6,
  session_uid: "9007199254740993",
  session_time: 83.25,
  frame_identifier: 1665,
  overall_frame_identifier: 1700,
  player_car_index: 19,
  secondary_player_car_index: 255,
};

test("connection states say what is and is not arriving", () => {
  assert.equal(f1Connection(null).tone, "warn");
  assert.match(
    f1Connection(status({ listening: false, bound_port: null })).text,
    /Not listening on 127\.0\.0\.1:20777/,
  );
  assert.match(f1Connection(status()).text, /nothing received/);
  assert.match(
    f1Connection(status({}, { datagrams: 5 })).text,
    /no valid F1 25/,
  );
  const live = f1Connection(status({}, { datagrams: 5, detected: true }));
  assert.equal(live.tone, "good");
  assert.equal(live.text, "F1 25 detected on 127.0.0.1:20777");
});

test("header entries keep the session UID exact and show the player index", () => {
  const entries = Object.fromEntries(
    f1HeaderEntries(HEADER).map((entry) => [entry.key, entry.value]),
  );
  assert.equal(entries.session_uid, "9007199254740993");
  assert.equal(entries.player_car_index, "19");
  assert.equal(entries.secondary_player_car_index, "255");
  assert.equal(entries.packet_format, "2025");
  assert.equal(entries.game_version, "1.07");
  assert.equal(entries.session_time, "83.250 s");
  // Identifiers are never digit-grouped.
  assert.equal(entries.overall_frame_identifier, "1700");
  assert.ok(f1HeaderEntries(null).every((entry) => entry.value === "—"));
});

test("every rejection reason is spelled out", () => {
  assert.equal(describeRejection(null), "—");
  assert.match(
    describeRejection({ reason: "truncated", size: 12 }),
    /12 bytes/,
  );
  assert.match(
    describeRejection({ reason: "wrong_packet_format", found: 2024 }),
    /2024, expected 2025/,
  );
  assert.match(
    describeRejection({ reason: "wrong_game_year", found: 24 }),
    /expected 25/,
  );
  assert.match(
    describeRejection({ reason: "unknown_packet_id", found: 99 }),
    /99/,
  );
  assert.match(
    describeRejection({
      reason: "unsupported_packet_version",
      kind: "motion",
      found: 2,
    }),
    /packetVersion 2/,
  );
  assert.match(
    describeRejection({
      reason: "size_mismatch",
      kind: "car_telemetry",
      expected: 1352,
      observed: 1351,
    }),
    /1351 bytes, expected 1352/,
  );
  const counters = f1CounterEntries(status({}, { size_mismatch: 3 }));
  assert.equal(
    counters.find((entry) => entry.key === "size_mismatch").value,
    "3",
  );
});

test("packet rows compare expected and observed size and label their source", () => {
  const evidence = status().evidence;
  evidence.kinds[6] = {
    ...evidence.kinds[6],
    accepted: 400,
    rate_hz: 20,
    last_observed_size: 1352,
  };
  evidence.kinds[2] = {
    ...evidence.kinds[2],
    size_mismatches: 2,
    last_observed_size: 1284,
  };
  const rows = f1KindRows(evidence);
  assert.equal(rows.length, 16);
  assert.deepEqual(
    rows.map((row) => row.name),
    NAMES,
  );
  assert.equal(rows[6].size, "match");
  assert.equal(rows[6].rate, "20.0 Hz");
  assert.equal(rows[2].size, "mismatch");
  assert.equal(rows[2].rejected, "2");
  assert.equal(rows[0].size, "unseen");
  assert.equal(rows[0].rate, "—");
  assert.equal(rows[4].evidence, "Spec");
  assert.equal(rows[0].evidence, "Spec + live");
});

test("the store latches unavailability and never shows a disabled listener", () => {
  const disabled = f1Received(INITIAL_F1, status({ enabled: false }));
  assert.equal(disabled.available, false);
  assert.equal(disabled.status, null);
  assert.equal(f1Received(disabled, status({ enabled: false })), disabled);
  // A backend with no such command is the same as one with it switched off.
  const missing = f1Failed(INITIAL_F1, new Error("no command"));
  assert.equal(missing.available, false);
  assert.equal(missing.error, null);
  // After a real answer, a failure is a real error and keeps the last status.
  const live = f1Received(INITIAL_F1, status());
  const failed = f1Failed(live, "boom");
  assert.equal(failed.available, true);
  assert.equal(failed.error, "boom");
  assert.equal(failed.status, live.status);
});

test("Diagnostics shows an F1 25 tab only when the listener is enabled", async () => {
  f1Store.set(INITIAL_F1);
  await mount(h(DiagnosticsWorkspace));
  assert.deepEqual(
    $$("[role=tab]").map((tab) => tab.textContent),
    ["Connection", "Pipeline", "Adapter", "Capture"],
  );
  await update(f1Store, f1Received(INITIAL_F1, status({ enabled: false })));
  assert.equal($$("[role=tab]").length, 4);

  const kinds = status().evidence.kinds;
  kinds[6] = {
    ...kinds[6],
    accepted: 400,
    rate_hz: 20,
    last_observed_size: 1352,
  };
  await update(
    f1Store,
    f1Received(
      INITIAL_F1,
      status(
        { transport_datagrams: 400 },
        {
          detected: true,
          datagrams: 400,
          accepted: 400,
          header: HEADER,
          kinds,
        },
      ),
    ),
  );
  assert.deepEqual(
    $$("[role=tab]").map((tab) => tab.textContent),
    ["Connection", "Pipeline", "Adapter", "Capture", "F1 25"],
  );
  await click($("#diagnostics-tab-f1"));
  assert.match(
    $("[data-entry=f1-connection]").textContent,
    /F1 25 detected on 127\.0\.0\.1:20777/,
  );
  assert.match($("[data-entry=session_uid]").textContent, /9007199254740993/);
  const row = $("[data-entry=f1-kind-6]");
  assert.match(row.textContent, /Car Telemetry/);
  assert.match(row.textContent, /20\.0 Hz/);
  assert.equal(row.querySelector("[data-size]").dataset.size, "match");
  assert.equal($$("[data-entry^=f1-kind-]").length, 16);
  // No payload, preview or hex anywhere on the tab.
  assert.doesNotMatch(document.body.textContent, /preview|hex/i);
  await cleanup();
  f1Store.set(INITIAL_F1);
});
