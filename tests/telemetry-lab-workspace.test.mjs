import { responses } from "./support/dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { act } from "react";
import {
  f1Detail,
  f1DetailInconsistent,
} from "../review/f1-session-fixtures.ts";
import { syntheticTrace } from "../review/lab-fixtures.ts";
import { resetSessionsMemory } from "../src/session-controller.ts";
import { manifest } from "./support/sessions.mjs";
import {
  cleanup,
  click,
  focus,
  h,
  installBackend,
  mount,
  press,
  resetStores,
  settle,
  ShellHarness,
} from "./support/shell.mjs";

// The Lab end to end in the real shell, against the fake bridge. Lap traces
// are the review harness's SYNTHETIC laps: layout evidence, never a recording.

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const text = (selector) => $(selector)?.textContent ?? "";

let traceCalls = [];

function list(detail) {
  return {
    sessions: [manifest("fh6-review", { started_at_unix_ms: 1 })],
    f1_sessions: [{ session: detail.session, labels: detail.labels }],
    unreadable: 0,
    directory: "sessions",
    limit: 20,
  };
}

async function openLab({ detail = f1Detail(), trace } = {}) {
  traceCalls = [];
  responses.set("list_recent_sessions", () => list(detail));
  responses.set("get_f1_session", () => detail);
  responses.set(
    "get_session_trace",
    trace ??
      ((args) => {
        traceCalls.push(args);
        return syntheticTrace(
          args.sessionId,
          args.lap,
          args.axis,
          args.channels,
          args.buckets,
          5891,
        );
      }),
  );
  await mount(h(ShellHarness));
  await click(
    $$(".sidebar-item").find((item) => item.textContent.includes("Sessions")),
  );
  await click($('[role=option][data-game="f1_25"]'));
  await settle();
}

test.beforeEach(() => {
  resetStores();
  resetSessionsMemory();
  installBackend();
});
test.afterEach(cleanup);

test("a completed F1 session opens in Telemetry Lab, which folds the sidebar", async () => {
  await openLab();
  const button = $(".session-lab-open");
  assert.equal(button.textContent, "Open in Telemetry Lab");
  assert.equal(button.getAttribute("aria-disabled"), null);
  await click(button);
  await settle();
  assert.ok($(".telemetry-lab"), "the Lab is shown");
  assert.equal($(".sessions-layout"), null, "Sessions is replaced");
  assert.equal($(".app-shell").dataset.lab, "true");
  assert.equal(document.activeElement.id, "lab-title");
  // The latest lap against the best, both on lap distance, every channel.
  assert.deepEqual(
    traceCalls.map((call) => [call.sessionId, call.lap, call.axis]),
    [
      ["f1-review-race", 2, "distance"],
      ["f1-review-race", 1, "distance"],
    ],
  );
  assert.deepEqual(traceCalls[0].channels, [
    "speed",
    "rpm",
    "throttle",
    "brake",
    "steering",
    "gear",
    "lap_time",
    "lap_distance",
  ]);
  assert.ok(traceCalls[0].buckets <= 2000);
});

test("the Lab has the reference layout: session, track view and charts, comparison", async () => {
  await openLab();
  await click($(".session-lab-open"));
  await settle();
  const columns = [...$(".telemetry-lab").children].map(
    (node) =>
      node.getAttribute("aria-label") ?? node.getAttribute("aria-labelledby"),
  );
  assert.deepEqual(columns, ["Session", "lab-title", "Lap comparison"]);
  assert.match(text(".lab-session-type"), /Race/);
  assert.match(text(".lab-identity"), /5\.891 km/);
  assert.deepEqual(
    $$(".lab-chart-chip").map((chip) => chip.textContent),
    ["Delta", "Speed", "RPM", "Throttle", "Brake", "Steering", "Gear"],
  );
  // Both comparison halves are always present.
  assert.deepEqual(
    $$(".lab-slot").map((slot) => slot.getAttribute("aria-label")),
    ["Current", "Reference"],
  );
  assert.equal($$(".lab-gauge").length, 2);
  assert.equal($$(".lab-tyre").length, 8);
  // Each lap is drawn: current solid, reference dotted, in every chart.
  for (const chart of $$(".lab-chart:not(.chart-delta)")) {
    assert.ok(
      chart.querySelector(".lab-series.slot-current").getAttribute("d"),
    );
    assert.ok(
      chart.querySelector(".lab-series.slot-reference").getAttribute("d"),
    );
  }
});

test("what RaceLab does not record is stated, never drawn or filled in", async () => {
  await openLab();
  await click($(".session-lab-open"));
  await settle();
  // No track geometry, no altitude, no map.
  assert.match(text(".lab-viewport"), /No track geometry/);
  assert.equal(
    $(".lab-viewport").querySelectorAll("path.lab-track, .lab-car-marker")
      .length,
    0,
  );
  assert.equal(text(".lab-hud-value.is-unavailable"), "—");
  assert.match(text(".lab-minimap"), /No track outline/);
  // Delta: a full panel and no line.
  assert.equal(text(".chart-delta .lab-readout"), "—");
  assert.equal($(".chart-delta .lab-series"), null);
  assert.match(text(".chart-delta"), /Time delta is not computed yet/);
  // Tyres and fuel: structure only; not a single number.
  for (const tyre of $$(".lab-tyre")) {
    assert.ok(!/\d/.test(tyre.textContent.replace(/^[FR][LR]/, "")));
  }
  for (const fuel of $$(".lab-fuel-panel")) {
    assert.match(fuel.textContent, /Not linked/);
    assert.ok(!/\d/.test(fuel.textContent.replace(/F1 25/, "")));
  }
  // Time of day and steering degrees are never shown.
  assert.match(
    $$(".lab-fact").find((fact) => /Track time/.test(fact.textContent))
      .textContent,
    /—/,
  );
  assert.ok(!/°(?!C)/.test(text(".lab-compare")));
  // The controls that do not work yet say so; replay itself works (M3).
  assert.equal(
    $('.lab-tool[aria-label="Full screen"]').getAttribute("aria-disabled"),
    "true",
  );
  assert.equal(
    $('.lab-tool[aria-label="Play"]').getAttribute("aria-disabled"),
    null,
  );
});

test("the gauges and readouts read both laps at the shared cursor", async () => {
  await openLab();
  await click($(".session-lab-open"));
  await settle();
  const speeds = $$(".lab-gauge-speed").map((node) => node.textContent);
  assert.equal(speeds.length, 2);
  for (const speed of speeds) assert.match(speed, /^\d+$/);
  assert.match(text(".chart-speed .lab-readout.slot-current"), /^\d+$/);
  assert.match(text(".chart-speed .lab-readout.slot-reference"), /^\d+$/);
  // Keyboard moves the one cursor every chart shares.
  const plot = $(".chart-speed .lab-plot");
  await focus(plot);
  await press("Home");
  assert.equal(plot.getAttribute("aria-valuetext"), "0.00 km");
  await press("ArrowRight", { shiftKey: true });
  assert.equal(plot.getAttribute("aria-valuetext"), "0.59 km");
  assert.equal(
    $(".chart-rpm .lab-plot").getAttribute("aria-valuetext"),
    "0.59 km",
  );
  // The HUD reads the cursor on the axis; the replay clock reads lap time.
  assert.equal(text(".lab-hud-value:not(.is-unavailable)"), "0.59 km");
  assert.match(text(".lab-controls-time"), /^0:\d\d\.\d{3} \/ /);
});

test("without a reference lap its half stays, empty and explained", async () => {
  await openLab();
  await click($(".session-lab-open"));
  await settle();
  const select = $("#lab-lap-reference");
  await act(async () => {
    select.value = "";
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await settle();
  const reference = $('.lab-slot[aria-label="Reference"]');
  assert.ok(reference, "the reference half is still there");
  assert.equal(reference.querySelector(".lab-gauge-speed").textContent, "—");
  assert.match(reference.textContent, /Choose a reference lap/);
  assert.match(text(".lab-chip-hud.slot-reference"), /No reference lap/);
  assert.equal($(".chart-speed .lab-readout.slot-reference"), null);
  assert.equal(
    $(".chart-speed .lab-series.slot-reference").getAttribute("d"),
    "",
  );
});

test("time sync re-reads both laps on lap time", async () => {
  await openLab();
  await click($(".session-lab-open"));
  await settle();
  const time = $$(".lab-sync button").find((b) => /Time/.test(b.textContent));
  await click(time);
  await settle();
  assert.equal(time.getAttribute("aria-checked"), "true");
  assert.deepEqual(
    traceCalls.slice(2).map((call) => [call.lap, call.axis]),
    [
      [2, "time"],
      [1, "time"],
    ],
  );
  assert.match(text(".lab-xaxis"), /0:30/);
});

test("a lap that cannot be read says so and shows no reading", async () => {
  await openLab({
    trace: () => {
      throw { kind: "damaged", message: "The recording could not be read" };
    },
  });
  await click($(".session-lab-open"));
  await settle();
  assert.match(
    text(".chart-speed .lab-plot-message"),
    /current lap could not be read: The recording could not be read/,
  );
  assert.equal(text(".chart-speed .lab-readout.slot-current"), "—");
  assert.ok($$(".lab-gauge-speed").every((node) => node.textContent === "—"));
});

test("Sessions comes back from the Lab, and any section leaves it", async () => {
  await openLab();
  await click($(".session-lab-open"));
  await settle();
  await click($(".lab-back"));
  await settle();
  assert.equal($(".telemetry-lab"), null);
  assert.equal($(".app-shell").dataset.lab, undefined);
  assert.equal($(".sessions-detail").dataset.game, "f1_25");
  await click($(".session-lab-open"));
  await settle();
  await click(
    $$(".sidebar-item").find((item) => item.textContent.includes("Settings")),
  );
  assert.equal($(".telemetry-lab"), null);
});

test("a session that is not completed cannot open the Lab", async () => {
  const detail = f1Detail();
  detail.session.racelab_session.status = "interrupted";
  await openLab({ detail });
  const button = $(".session-lab-open");
  assert.equal(button.getAttribute("aria-disabled"), "true");
  assert.match(button.textContent, /completed sessions only/);
  await click(button);
  assert.equal($(".telemetry-lab"), null);
  assert.equal(traceCalls.length, 0);
});

test("the Lab names its recording and keeps the live status marked as live", async () => {
  await openLab();
  assert.equal($(".topbar").dataset.analysis, undefined);
  assert.equal($(".topbar-analysis"), null);
  await click($(".session-lab-open"));
  await settle();
  // The top bar leads with the analysis context; live facts stay, labelled.
  assert.equal($(".topbar").dataset.analysis, "true");
  assert.match(text(".topbar-analysis"), /Analysing a recorded session/);
  assert.equal(text(".topbar-live-label"), "Live");
  // The Lab's own header names the recording it reads.
  assert.match(text(".lab-recorded"), /Recorded · F1 25/);
  assert.match(text(".lab-recorded"), /Silverstone Race/);
  await click($(".lab-back"));
  assert.equal($(".topbar-analysis"), null);
  assert.equal($(".topbar").dataset.analysis, undefined);
});

// ------------------------------------------------------------- M3 replay

/// Lets the app's real frame clock run (jsdom's requestAnimationFrame).
async function play(ms) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

const playButton = () =>
  $('.lab-tool[aria-label="Play"], .lab-tool[aria-label="Pause"]');

async function lab() {
  await openLab();
  await click($(".session-lab-open"));
  await settle();
}

test("Play moves every view along the lap, and Pause holds it", async () => {
  await lab();
  const start = text(".lab-controls-time");
  assert.match(start, /^0:00\.000 \/ \d:\d\d\.\d{3}$/);
  const before = {
    plot: $(".chart-speed .lab-plot").getAttribute("aria-valuetext"),
    hud: text(".lab-hud-value:not(.is-unavailable)"),
  };
  await click(playButton());
  assert.equal(playButton().getAttribute("aria-label"), "Pause");
  assert.match(text('[aria-live="polite"]'), /Playing at 1×/);
  await play(250);
  // The one cursor moved, and with it every chart, the HUD and the clock.
  const plot = $(".chart-speed .lab-plot").getAttribute("aria-valuetext");
  assert.notEqual(plot, before.plot);
  assert.equal($(".chart-rpm .lab-plot").getAttribute("aria-valuetext"), plot);
  assert.notEqual(text(".lab-hud-value:not(.is-unavailable)"), before.hud);
  assert.notEqual(text(".lab-controls-time"), start);
  await click(playButton());
  assert.equal(playButton().getAttribute("aria-label"), "Play");
  assert.match(text('[aria-live="polite"]'), /Paused/);
  const held = text(".lab-controls-time");
  await play(150);
  assert.equal(text(".lab-controls-time"), held);
});

test("seeking with the scrubber moves the cursor, the charts and the gauges", async () => {
  await lab();
  const scrub = $(".lab-scrub");
  assert.equal(scrub.getAttribute("aria-label"), "Replay position");
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    ).set.call(scrub, "30000");
    scrub.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  assert.match(text(".lab-controls-time"), /^0:30\.000/);
  const plot = $(".chart-speed .lab-plot").getAttribute("aria-valuetext");
  assert.notEqual(plot, "0.00 km");
  // Both gauges read their own lap at the same distance.
  for (const speed of $$(".lab-gauge-speed")) {
    assert.match(speed.textContent, /^\d+$/);
  }
});

test("rate is a radio group, and [ and ] step it from anywhere in the Lab", async () => {
  await lab();
  const checked = () =>
    $$(".lab-rates [role=radio]")
      .filter((radio) => radio.getAttribute("aria-checked") === "true")
      .map((radio) => radio.textContent);
  assert.deepEqual(
    $$(".lab-rates [role=radio]").map((radio) => radio.textContent),
    ["0.5×", "1×", "2×", "4×"],
  );
  assert.deepEqual(checked(), ["1×"]);
  await click($$(".lab-rates [role=radio]")[2]);
  assert.deepEqual(checked(), ["2×"]);
  const plot = $(".chart-speed .lab-plot");
  await focus(plot);
  await press("]");
  assert.deepEqual(checked(), ["4×"]);
  await press("[");
  await press("[");
  assert.deepEqual(checked(), ["1×"]);
});

test("Space plays and pauses, but never on top of a focused control", async () => {
  await lab();
  await focus($(".chart-speed .lab-plot"));
  await press(" ");
  assert.equal(playButton().getAttribute("aria-label"), "Pause");
  await press(" ");
  assert.equal(playButton().getAttribute("aria-label"), "Play");
  // On a button, Space is that button's own key.
  await focus($(".lab-back"));
  await press(" ");
  assert.equal(playButton().getAttribute("aria-label"), "Play");
  // In a list, it chooses; it never plays.
  await focus($("#lab-lap-reference"));
  await press(" ");
  assert.equal(playButton().getAttribute("aria-label"), "Play");
});

test("changing the axis pauses, and leaving the Lab stops the replay", async () => {
  await lab();
  await click(playButton());
  await play(80);
  await click($$(".lab-sync button").find((b) => /Time/.test(b.textContent)));
  await settle();
  assert.equal(playButton().getAttribute("aria-label"), "Play");
  await click(playButton());
  await play(50);
  await click($(".lab-back"));
  // No frame lands on the closed Lab.
  await play(120);
  assert.equal($(".telemetry-lab"), null);
});

// ---------------------------------------------------------- M4 lap analysis

/// The review session with its provisional lap 2 confirmed by Session
/// History as well: both records valid, with the S3 History would state.
function confirmedDetail() {
  const detail = f1Detail();
  for (const lap of detail.laps.laps) {
    Object.assign(lap, {
      source: "session_history",
      sector3_ms: lap.lap_time_ms - lap.sector1_ms - lap.sector2_ms,
      valid_bit_flags: 15,
      lap_valid: true,
      sector1_valid: true,
      sector2_valid: true,
      sector3_valid: true,
    });
  }
  return detail;
}

const findings = () => $$(".lab-issues li").map((item) => item.textContent);

test("each lap states its timing source, validity and what its samples allow", async () => {
  await lab();
  // Current is lap 2 (Lap Data only); reference is lap 1 (Session History).
  assert.deepEqual(
    $$(".lab-lap-badges").map((badges) =>
      [...badges.children].map((badge) => badge.textContent),
    ),
    [
      ["Provisional", "Validity unknown", "Replay only"],
      ["History", "Valid", "Analysis ready"],
    ],
  );
  assert.equal(
    $$(".lab-lap-badges")[0].getAttribute("aria-label"),
    "Current lap 2: Provisional, Validity unknown, Replay only",
  );
  const row = (label) =>
    $$(".lab-lapdata-table tbody tr")
      .find((tr) => tr.firstChild.textContent === label)
      .querySelectorAll("td");
  const cells = (label) => [...row(label)].map((td) => td.textContent);
  assert.deepEqual(
    $$(".lab-lapdata-table thead th").map((th) => th.textContent),
    ["Measure", "Lap 2", "Lap 1"],
  );
  assert.deepEqual(cells("Lap time"), ["1:41.162", "1:40.781"]);
  // Lap Data has no S3; only Session History states one.
  assert.deepEqual(cells("S3"), ["—", "32.298"]);
  // Coverage is measured from the samples, never taken from the record.
  assert.deepEqual(cells("Samples"), ["1012/1012", "1008/1008"]);
  assert.deepEqual(cells("Time covered"), ["100%", "100%"]);
  assert.deepEqual(cells("Longest break"), ["100 ms", "100 ms"]);
  assert.deepEqual(cells("Start / end"), ["yes/yes", "yes/yes"]);
  // What keeps each lap out of reliable analysis is named, per lap.
  assert.ok(
    findings().includes(
      "Current: Provisional: from Lap Data; Session History never confirmed this lap.",
    ),
  );
  // The consistent review session has nothing against the reference lap.
  assert.ok(!findings().some((f) => f.startsWith("Reference:")));
  // The delta panel names the first reason and draws nothing.
  const message = $(".chart-delta .lab-plot-message");
  assert.equal(message.dataset.ready, "false");
  assert.match(message.textContent, /Current lap 2: Provisional/);
  assert.equal($(".chart-delta .lab-series"), null);
});

test("lap records that disagree with their samples are reported, not trimmed", async () => {
  await openLab({ detail: f1DetailInconsistent() });
  await click($(".session-lab-open"));
  await settle();
  assert.deepEqual(
    $$(".lab-lap-badges").map((badges) => badges.lastChild.textContent),
    ["Replay only", "Replay only"],
  );
  assert.ok(
    findings().includes(
      "Reference: Recorded lap time reaches 100700 ms, past the 91234 ms the lap record states.",
    ),
  );
  assert.ok(
    findings().includes(
      "Current: Recorded lap time reaches 101100 ms, past the 92456 ms the lap record states.",
    ),
  );
  assert.equal($(".chart-delta .lab-plot-message").dataset.ready, "false");
});

test("two confirmed, fully covered laps qualify for alignment, and no delta is drawn", async () => {
  await openLab({ detail: confirmedDetail() });
  await click($(".session-lab-open"));
  await settle();
  assert.deepEqual(
    $$(".lab-lap-badges").map((badges) => badges.lastChild.textContent),
    ["Analysis ready", "Analysis ready"],
  );
  assert.deepEqual(findings(), []);
  const message = $(".chart-delta .lab-plot-message");
  assert.equal(message.dataset.ready, "true");
  assert.match(message.textContent, /Both laps qualify for distance alignment/);
  assert.match(message.textContent, /Time delta is not computed yet/);
  assert.equal(text(".chart-delta .lab-readout"), "—");
  assert.equal($(".chart-delta .lab-series"), null);
  // The same lap twice is not a comparison.
  const select = $("#lab-lap-reference");
  await act(async () => {
    select.value = "2";
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await settle();
  assert.equal(message.dataset.ready, "false");
  assert.match(message.textContent, /Current and reference are the same lap/);
});

test("lap data follows the axis and an empty reference slot", async () => {
  await openLab({ detail: confirmedDetail() });
  await click($(".session-lab-open"));
  await settle();
  await click($$(".lab-sync button").find((b) => /Time/.test(b.textContent)));
  await settle();
  assert.deepEqual(
    $$(".lab-lap-badges").map((badges) => badges.lastChild.textContent),
    ["Analysis ready", "Analysis ready"],
  );
  const select = $("#lab-lap-reference");
  await act(async () => {
    select.value = "";
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await settle();
  assert.equal($$(".lab-lap-badges").length, 1);
  assert.deepEqual(
    [...$$(".lab-lapdata-table tbody tr")[0].querySelectorAll("td")].map(
      (td) => td.textContent,
    )[1],
    "—",
  );
  assert.match(
    text(".chart-delta .lab-plot-message"),
    /No reference lap is selected/,
  );
});

test("a lap whose samples cannot be read is never analysis ready", async () => {
  await openLab({
    trace: () => {
      throw { kind: "damaged", message: "The recording could not be read" };
    },
  });
  await click($(".session-lab-open"));
  await settle();
  assert.deepEqual(
    $$(".lab-lap-badges").map((badges) => badges.lastChild.textContent),
    ["Samples not loaded", "Samples not loaded"],
  );
  assert.equal(
    text(".chart-delta .lab-plot-message span"),
    "Current lap 2: The lap's samples are not loaded.",
  );
});
