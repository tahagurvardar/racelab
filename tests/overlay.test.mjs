import { responses, calls, renders, resetRenders } from "./support/dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  cleanup,
  h,
  mount,
  settle,
  click,
  installBackend,
  resetStores,
  ShellHarness,
  act,
} from "./support/shell.mjs";
import {
  DEFAULT_OVERLAY,
  OVERLAY_UPDATE_MS,
  overlayView,
} from "../src/overlay/model.ts";
import {
  FAMILY_FRESH_MS,
  FAMILY_STALE_MS,
} from "../src/telemetry/f1-freshness.ts";
import Overlay from "../src/overlay/Overlay.tsx";
import { OverlaySettings } from "../src/components/OverlaySettings.tsx";

const golden = JSON.parse(
  fs.readFileSync(
    new URL(
      "../src-tauri/tests/fixtures/f1_25/live-snapshots.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const wait = (ms) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
function fixture(name = "driving") {
  const live = structuredClone(golden[name]);
  for (const f of [live.car_telemetry, live.car_status, live.lap_data])
    if (f) f.age_ms = 0;
  return {
    state: {
      preferences: { ...DEFAULT_OVERLAY, enabled: true },
      visible: true,
      editing: false,
      error: null,
    },
    f1: { enabled: true, listening: true, last_accepted_age_ms: 0, live },
    fh6_active: false,
    sample_age_ms: 0,
  };
}
test.afterEach(async () => {
  await cleanup();
  responses.clear();
  calls.length = 0;
  resetStores();
});

for (const name of Object.keys(golden))
  test(`overlay all eleven factual readings from real ${name} fixture`, () => {
    const frame = fixture(name),
      r = overlayView(frame).readings;
    const t = frame.f1.live.car_telemetry.value.player;
    const s = frame.f1.live.car_status.value.player;
    const l = frame.f1.live.lap_data.value.player;
    assert.deepEqual(
      Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.text])),
      {
        gear:
          t.gear.raw === -1 ? "R" : t.gear.raw === 0 ? "N" : String(t.gear.raw),
        speed: String(t.speed_kmh),
        rpm: String(t.engine_rpm),
        throttle: (t.throttle * 100).toFixed(0),
        brake: (t.brake * 100).toFixed(0),
        lap: String(l.current_lap_num),
        sector: String(l.sector.raw + 1),
        position: String(l.car_position),
        drs: t.drs.raw === 1 ? "ON" : "OFF",
        ers: `${(s.ers_store_energy_j / 1e6).toFixed(2)} MJ`,
        fuel: s.fuel_in_tank.toFixed(1),
      },
    );
    assert.equal(overlayView(frame).visible, true);
  });

test("F1 gears R/N/1–8, unknown codes and DRS actual state are independent of allowed", () => {
  const f = fixture();
  for (const [raw, text] of [
    [-1, "R"],
    [0, "N"],
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((g) => [g, String(g)]),
    [9, "—"],
    [127, "—"],
  ]) {
    f.f1.live.car_telemetry.value.player.gear.raw = raw;
    assert.equal(overlayView(f).readings.gear.text, text);
  }
  f.f1.live.car_status.value.player.drs_allowed.raw = 1;
  f.f1.live.car_telemetry.value.player.drs.raw = 0;
  assert.equal(overlayView(f).readings.drs.text, "OFF");
  f.f1.live.car_telemetry.value.player.drs.raw = 1; // synthetic, not live-game evidence
  assert.equal(overlayView(f).readings.drs.text, "ON");
});
test("family limits match Rust; stale is named; unavailable families lose values independently", () => {
  const rust = fs.readFileSync(
    new URL("../src-tauri/src/overlay.rs", import.meta.url),
    "utf8",
  );
  assert.match(rust, new RegExp(`FRESH_MS: u64 = ${FAMILY_FRESH_MS}`));
  assert.match(rust, new RegExp(`STALE_MS: u64 = ${FAMILY_STALE_MS}`));
  const f = fixture();
  assert.equal(overlayView(f, 1000).readings.speed.freshness, "fresh");
  assert.match(overlayView(f, 1001).note, /Not updating/);
  assert.equal(overlayView(f, 3000).visible, true);
  assert.equal(overlayView(f, 3001).visible, false);
  f.f1.live.car_status.age_ms = 3001;
  assert.equal(overlayView(f).readings.ers.text, "—");
  assert.notEqual(overlayView(f).readings.speed.text, "—");
  f.sample_age_ms = 3001;
  assert.equal(overlayView(f).visible, false);
});
test("disabled, FH6, invalid player and failed listener hide; edit allows unavailable preview", () => {
  const f = fixture();
  f.state.preferences.enabled = false;
  assert.equal(overlayView(f).visible, false);
  f.state.preferences.enabled = true;
  f.fh6_active = true;
  assert.equal(overlayView(f).visible, false);
  f.state.editing = true;
  assert.equal(overlayView(f).visible, false);
  f.fh6_active = false;
  f.f1.live.car_telemetry.age_ms = 4000;
  assert.equal(overlayView(f).visible, true);
  assert.equal(overlayView(f).readings.speed.text, "—");
  f.state.editing = false;
  f.f1.listening = false;
  assert.equal(overlayView(f).visible, false);
});
test("one bounded 10Hz IPC reader, no UDP/recorder work, expires even if subsequent read hangs", async () => {
  let reads = 0,
    active = 0,
    max = 0;
  const f = fixture();
  f.f1.live.car_telemetry.age_ms = 2900;
  responses.set("get_overlay_frame", async () => {
    reads++;
    active++;
    max = Math.max(max, active);
    if (reads > 1) return new Promise(() => {});
    active--;
    return f;
  });
  await mount(h(Overlay));
  await wait(350);
  assert.equal(max, 1);
  assert.equal(reads, 2);
  assert.equal(document.querySelector(".telemetry-overlay").hidden, true);
  assert.equal(OVERLAY_UPDATE_MS, 100);
  assert.deepEqual([...new Set(calls)], ["get_overlay_frame"]);
  assert.equal(
    document.querySelectorAll("button,input,select,[tabindex]").length,
    0,
  );
  await cleanup();
  const before = reads;
  await wait(150);
  assert.equal(reads, before);
});
test("Settings enable/scale/opacity/edit/finish and keyboard position commands persist without telemetry", async () => {
  let state = fixture().state;
  state.preferences.enabled = false;
  const writes = [];
  responses.set("get_overlay_state", () => state);
  responses.set("configure_overlay", (args) => {
    writes.push(args);
    state = {
      ...state,
      editing: args.editing && args.enabled,
      preferences: { ...state.preferences, ...args },
    };
    return state;
  });
  responses.set("move_overlay", (args) => writes.push(args));
  await mount(h(OverlaySettings));
  await settle();
  await click(document.querySelector("input"));
  await click(
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Edit position",
    ),
  );
  assert.match(document.body.textContent, /Editing ·/);
  await click(
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Move left",
    ),
  );
  assert.deepEqual(writes.at(-1), { dx: -20, dy: 0 });
  await click(
    [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Finish editing",
    ),
  );
  assert.equal(writes.at(-1).editing, false);
  assert.ok(
    !calls.includes("get_overlay_frame") && !calls.includes("get_f1_live"),
  );
});
test("overlay rendering cannot fan out into mounted Sessions or Settings", async () => {
  resetStores();
  installBackend();
  responses.set("get_overlay_state", () => fixture().state);
  responses.set("get_overlay_frame", () => fixture());
  await mount(
    h("div", null, h(ShellHarness, { workspace: "settings" }), h(Overlay)),
  );
  await click(
    [...document.querySelectorAll(".sidebar-item")].find((b) =>
      b.textContent.includes("Settings"),
    ),
  );
  await wait(250);
  resetRenders();
  await wait(350);
  assert.ok(renders.Overlay >= 1);
  assert.equal(renders.SettingsWorkspace ?? 0, 0);
  assert.equal(renders.OverlaySettings ?? 0, 0);
  assert.equal(renders.SessionsWorkspace ?? 0, 0);
});

test("overlay window controller has no listener, recorder or history construction", () => {
  const source = fs.readFileSync(
    new URL("../src-tauri/src/overlay_window.rs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /UdpSocket|Listener::new|F1EvidenceService::new|RecorderService::start|SessionRecorder::new|VecDeque/,
  );
  assert.match(source, /f1\.live_status\(\)/);
  assert.match(source, /pending\.swap\(true/); // at most one queued main-thread job
});
