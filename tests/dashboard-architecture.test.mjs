import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Node's type stripping cannot load .tsx, so component behaviour that cannot be
// expressed in the view model is asserted structurally against the sources.
// These are boundary tests: they fail when a product view starts reading
// adapter data, or when a second telemetry polling loop appears.

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function read(relative) {
  return fs.readFileSync(path.join(SRC, relative), "utf8");
}

/// Source with comments removed. A boundary rule is about what the code does,
/// so a doc comment naming `sourceSpecific` must not count as reading it.
function code(relative) {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function walk(relative = "") {
  const directory = path.join(SRC, relative);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const next = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) return walk(next);
    return /\.tsx?$/.test(entry.name) ? [next] : [];
  });
}

const ALL = walk();
// Stage C: the seven V1.0 live views became four Live tabs, rendered from
// `telemetry/live-layout.ts` through the components in `components/live/`.
// Every boundary rule below applies to all of them.
const LIVE_TABS = [
  "views/live/OverviewTab.tsx",
  "views/live/PowertrainTab.tsx",
  "views/live/ChassisTab.tsx",
  "views/live/DynamicsTab.tsx",
];
const LIVE_COMPONENTS = [
  "components/live/Readout.tsx",
  "components/live/ControlBar.tsx",
  "components/live/RpmBar.tsx",
  "components/live/NotAvailable.tsx",
];
// Stage D: Sessions is a workspace, its parts, a data controller and a hook.
const SESSIONS = [
  "workspaces/SessionsWorkspace.tsx",
  "views/sessions/SessionList.tsx",
  "views/sessions/SessionDetail.tsx",
  "views/sessions/SessionTimeline.tsx",
  "views/sessions/SummaryTab.tsx",
  "views/sessions/EventsTab.tsx",
  "views/sessions/TurnsTab.tsx",
  "views/sessions/SlipTab.tsx",
  "views/sessions/DataTab.tsx",
  "views/sessions/parts.tsx",
];
const SESSIONS_DATA = [
  "hooks/use-sessions.ts",
  "session-controller.ts",
  "session-workspace.ts",
  "session-timeline.ts",
];
// V2.0: F1 25's own Live workspace and tabs. Every boundary rule applies to
// them too, and they are kept apart from FH6's (see "each game's Live
// presentation is isolated").
const F1_LIVE = [
  "workspaces/F1LiveWorkspace.tsx",
  "views/live/f1/F1OverviewTab.tsx",
  "views/live/f1/F1RaceTab.tsx",
  "views/live/f1/F1TyresTab.tsx",
  "views/live/f1/F1DynamicsTab.tsx",
  "views/live/f1/parts.tsx",
];
const PRODUCT_VIEWS = [
  ...LIVE_TABS,
  ...LIVE_COMPONENTS,
  "workspaces/LiveWorkspace.tsx",
  "workspaces/Fh6LiveWorkspace.tsx",
  ...F1_LIVE,
  ...SESSIONS,
];

test("every Live tab, the shell and the four workspaces exist", () => {
  for (const view of [...PRODUCT_VIEWS, "views/DiagnosticsView.tsx"]) {
    assert.ok(ALL.includes(view), `missing ${view}`);
  }
  for (const file of [
    "components/AppShell.tsx",
    "components/shell/Sidebar.tsx",
    "components/shell/TopBar.tsx",
    "workspaces/HomeWorkspace.tsx", // coarse source readiness, never raw values
    "components/shell/AlertSlot.tsx",
    "workspaces/LiveWorkspace.tsx",
    "workspaces/SettingsWorkspace.tsx",
    "workspaces/DiagnosticsWorkspace.tsx",
  ]) {
    assert.ok(ALL.includes(file), `missing ${file}`);
  }
  // The dashboard is not one file: App.tsx only wires the shell together.
  assert.ok(read("App.tsx").split("\n").length < 80);
});

test("no product view reads source-specific adapter data", () => {
  for (const view of PRODUCT_VIEWS) {
    const source = code(view);
    assert.ok(
      !source.includes("sourceSpecific"),
      `${view} must not read sourceSpecific`,
    );
    assert.ok(
      !source.includes("diagnostics-view-model"),
      `${view} must not import the diagnostics view model`,
    );
  }
});

test("the diagnostics view model is imported by diagnostics alone", () => {
  const importers = ALL.filter((file) =>
    code(file).includes("diagnostics-view-model"),
  );
  assert.deepEqual(importers, ["views/DiagnosticsView.tsx"]);
});

test("only the diagnostics view model reads sourceSpecific", () => {
  const readers = ALL.filter(
    (file) =>
      // The canonical frame type declares the field; it does not read it.
      file !== "telemetry/frame.ts" && code(file).includes("sourceSpecific"),
  );
  assert.deepEqual(readers, ["telemetry/diagnostics-view-model.ts"]);
});

test("the raw gear code never reaches a product view", () => {
  for (const view of [
    ...PRODUCT_VIEWS,
    "telemetry/telemetry-view-model.ts",
    "telemetry/live-layout.ts",
  ]) {
    assert.ok(!/fh6\??\.gear/.test(code(view)), view);
  }
  // It is present in exactly one place, labelled as a code.
  const diagnostics = read("telemetry/diagnostics-view-model.ts");
  assert.ok(diagnostics.includes("Gear (raw code)"));
});

test("telemetry polling is started once, above the view switch", () => {
  const callers = ALL.filter((file) =>
    read(file).includes("startLatestPolling("),
  );
  // Main telemetry owner hooks remain above the switch. The separate overlay
  // entry reads its own cached frame; Settings reads coarse window state only.
  assert.deepEqual(callers.sort(), [
    "components/OverlaySettings.tsx",
    "hooks/use-f1-evidence.ts",
    "hooks/use-f1-live.ts",
    "hooks/use-f1-recorder-status.ts",
    "hooks/use-live-telemetry.ts",
    "hooks/use-recorder-status.ts",
    "hooks/use-setup-state.ts",
    "overlay/Overlay.tsx",
  ]);
  assert.ok(!read("overlay/main.tsx").includes('"./App"'));
  assert.match(read("overlay/Overlay.tsx"), /"get_overlay_frame"/);
  assert.ok(
    !/get_f1_live|useF1Live|useRecorder/.test(read("overlay/Overlay.tsx")),
  );
  assert.match(read("components/OverlaySettings.tsx"), /"get_overlay_state"/);
  assert.ok(
    !/get_overlay_frame|get_f1_live|useF1Live/.test(
      read("components/OverlaySettings.tsx"),
    ),
  );
  const app = read("App.tsx");
  // Both hooks are called unconditionally in the shell, so a view change can
  // neither start a second loop nor tear the existing one down.
  assert.ok(app.includes("useLiveTelemetry()"));
  assert.ok(app.includes("useRecorderStatus()"));
  assert.ok(app.includes("useSetupState()"));
  assert.equal(app.match(/useLiveTelemetry\(\)/g).length, 1);
  assert.equal(app.match(/useRecorderStatus\(\)/g).length, 1);
  assert.equal(app.match(/useSetupState\(\)/g).length, 1);
  assert.equal(app.match(/useF1Evidence\(\)/g).length, 1);
  assert.equal(app.match(/useF1LiveTelemetry\(\)/g).length, 1);
  assert.equal(app.match(/useF1RecorderStatus\(\)/g).length, 1);
  // Views are rendered as children of the shell; none of them calls a hook
  // that polls.
  for (const view of [...PRODUCT_VIEWS, "views/DiagnosticsView.tsx"]) {
    const source = read(view);
    assert.ok(!source.includes("useLiveTelemetry"), view);
    assert.ok(!source.includes("useRecorderStatus"), view);
    assert.ok(!source.includes("useSetupState"), view);
    assert.ok(!source.includes("useF1RecorderStatus"), view);
  }
});

test("switching views cannot duplicate a polling loop", () => {
  const app = read("App.tsx");
  // The workspace switch is a plain conditional render below the owner hooks.
  const hookLine = app.indexOf("useLiveTelemetry()");
  const switchLine = app.indexOf('navigation.section === "live"');
  assert.ok(hookLine > -1 && switchLine > hookLine);
  // No hook is called inside a conditional branch.
  assert.ok(!/\?\s*use[A-Z]/.test(app));
  // Sessions reads recorder status from the shared store instead of polling.
  for (const file of [...SESSIONS, ...SESSIONS_DATA]) {
    assert.ok(!read(file).includes("startLatestPolling"), file);
  }
  assert.ok(read("views/sessions/SessionList.tsx").includes("useRecorder("));
});

// D2(b), approved for Stage D: the one bounded refresh outside the three
// owner hooks. It reads only the selected session's analysis, every
// ANALYSIS_REFRESH_MS, only while it is queued or analyzing (behaviour in
// tests/session-controller.test.mjs). Any other timer in the frontend is a
// new loop and must be reviewed, not added quietly.
test("main analysis refresh and the separate overlay freshness watchdog are the only extra timers", () => {
  const timers = ALL.filter((file) =>
    /\bset(Timeout|Interval)\(/.test(code(file)),
  ).sort();
  assert.deepEqual(timers, [
    "latest-poller.ts",
    "overlay/Overlay.tsx",
    "session-controller.ts",
  ]);
  assert.deepEqual(
    ALL.filter((file) => /\bsetInterval\(/.test(code(file))),
    ["overlay/Overlay.tsx"],
  );
  const controller = code("session-controller.ts");
  assert.match(controller, /ANALYSIS_REFRESH_MS = 2000/);
  // It re-reads one command — the selected session's analysis — and nothing
  // else is ever scheduled.
  const scheduled = [
    ...controller.matchAll(/timers\.set\(([\s\S]*?)\}, refreshMs\)/g),
  ];
  assert.equal(scheduled.length, 1);
  assert.match(scheduled[0][1], /requestAnalysis\(of\)/);
  assert.ok(!/readManifest|refreshList/.test(scheduled[0][1]));
  // The workspace disposes its controller on unmount.
  assert.match(
    read("hooks/use-sessions.ts"),
    /return \(\) => created\.dispose\(\);/,
  );
});

test("Sessions never asks for frames and holds no editable setting", () => {
  for (const file of [...SESSIONS, ...SESSIONS_DATA]) {
    const source = code(file);
    assert.ok(
      !/read_frames|get_frames|\bframe_stream\b|\.rlframes/i.test(source),
      file,
    );
    // The storage limit belongs to Settings: Sessions shows usage only.
    assert.ok(
      !/StorageBudget|set_storage_budget|get_settings/.test(source),
      file,
    );
  }
  assert.match(read("workspaces/SettingsWorkspace.tsx"), /<StorageBudget \/>/);
});

// V1.1: live telemetry is held in a store, not in App state, so a 20 Hz
// snapshot re-renders only the components that read it. These lists are the
// complete set; adding a live reader is a deliberate, reviewed decision.
test("only the views that show live telemetry re-render with it", () => {
  const liveReaders = ALL.filter((file) => /\buseLive\(/.test(code(file)));
  assert.deepEqual(liveReaders.sort(), [
    "views/DiagnosticsView.tsx", // its open tab's counters, only while open
    "workspaces/Fh6LiveWorkspace.tsx",
  ]);
  // F1 25's live values have one full reader: its own workspace. Settings
  // selects coarse facts (available, listening, port) and never the values.
  const f1Readers = ALL.filter((file) => /\buseF1Live\(/.test(code(file)));
  assert.deepEqual(f1Readers.sort(), [
    "workspaces/F1LiveWorkspace.tsx",
    "workspaces/SettingsWorkspace.tsx",
  ]);
  assert.ok(
    !/state\.status\?\.live/.test(code("workspaces/SettingsWorkspace.tsx")),
  );
  // The frame components derive small view models and re-render only when
  // what they display changes.
  const derivedReaders = ALL.filter(
    (file) =>
      /useDerived\(/.test(code(file)) && code(file).includes("liveStore"),
  );
  assert.deepEqual(derivedReaders.sort(), [
    // The setup detection sentence (first-run and Settings): re-renders when
    // the sentence changes, never at the live rate.
    "components/SetupInstructions.tsx",
    "components/shell/AlertSlot.tsx",
    "components/shell/Sidebar.tsx",
    "components/shell/TopBar.tsx",
    "workspaces/HomeWorkspace.tsx", // source readiness changes, not raw values
    // V2.0: Live's neutral waiting view, re-rendered when its sentence
    // changes.
    "workspaces/LiveWorkspace.tsx",
  ]);
  // Settings and the first-run slot read no live telemetry themselves.
  for (const file of [
    "workspaces/SettingsWorkspace.tsx",
    "components/shell/FirstRunSlot.tsx",
    "components/FirstRunGuide.tsx",
    "components/StorageBudget.tsx",
    "workspaces/DiagnosticsWorkspace.tsx",
  ]) {
    assert.ok(
      !/\buseLive\(|liveStore/.test(code(file)),
      `${file} must not read live telemetry`,
    );
  }
  // App and the frame read no store at all: they re-render on navigation only.
  for (const file of ["App.tsx", "components/AppShell.tsx"]) {
    const source = code(file);
    assert.ok(
      !/\buse(Live|Recorder|Transport|Setup|Store|Derived)\(/.test(source),
      `${file} must not read a store`,
    );
  }
  // Sessions reads no live telemetry or transport state, and selects only
  // coarse recorder facts outside its pinned recording row.
  for (const file of [...SESSIONS, ...SESSIONS_DATA]) {
    assert.ok(
      !/useLive\(|useTransport\(|liveStore|transportStore|use-live-telemetry/.test(
        code(file),
      ),
      `${file} must not read live telemetry`,
    );
  }
  assert.ok(
    code("views/sessions/SessionList.tsx").includes(
      "state.recorder?.completed_sessions",
    ),
  );
});

test("each store is written only by its owner", () => {
  const writers = (store) =>
    ALL.filter((file) =>
      new RegExp(`\\b${store}\\.(set|update)\\(`).test(code(file)),
    ).sort();
  assert.deepEqual(writers("liveStore"), ["hooks/use-live-telemetry.ts"]);
  assert.deepEqual(writers("recorderStore"), ["hooks/use-recorder-status.ts"]);
  assert.deepEqual(writers("setupStore"), ["hooks/use-setup-state.ts"]);
  assert.deepEqual(writers("f1Store"), ["hooks/use-f1-evidence.ts"]);
  assert.deepEqual(writers("f1LiveStore"), ["hooks/use-f1-live.ts"]);
  // The active game is a derived store: one module recomputes it from the two
  // telemetry stores, and nothing else ever sets it.
  assert.deepEqual(writers("activeGameStore"), ["state/active-game.ts"]);
  // The listener controls apply the snapshot their command returns, as V1.0's
  // `apply` did, through the one exported action next to the store.
  assert.deepEqual(writers("transportStore"), [
    "hooks/use-transport-stats.ts",
    "state/stores.ts",
  ]);
});

test("every subscription cleans up on unmount", () => {
  for (const file of ALL) {
    const source = read(file);
    if (source.includes("startLatestPolling(")) {
      // The poller returns its own disposer; the effect must return it.
      if (file === "overlay/Overlay.tsx") {
        assert.match(
          source,
          /return \(\) => \{\s*stop\(\);\s*clearInterval\(timer\);/,
        );
      } else
        assert.match(
          source,
          /useEffect\(\s*\(\)\s*=>\s*\n?\s*startLatestPolling\(/,
          `${file} must return the poller disposer from useEffect`,
        );
    }
    if (source.includes("await listen<")) {
      assert.ok(source.includes("unlisten?.()"), `${file} must unlisten`);
      assert.ok(source.includes("disposed = true"), `${file} must guard`);
    }
  }
});

test("the UI reads at most 20 Hz and keeps no frame history", () => {
  const hook = read("hooks/use-live-telemetry.ts");
  assert.ok(hook.includes("LIVE_POLL_INTERVAL_MS = 50"));
  const poller = read("latest-poller.ts");
  // The floor in the poller itself prevents any caller exceeding 20 Hz.
  assert.ok(poller.includes("Math.max(50, intervalMs)"));
  // No frontend module accumulates frames.
  for (const file of ALL) {
    const source = read(file);
    assert.ok(
      !/\.push\(\s*(frame|snapshot|incoming)\b/.test(source),
      `${file} must not accumulate telemetry`,
    );
  }
});

test("navigation separates the product sections from diagnostics", async () => {
  const {
    PRODUCT_SECTIONS: product,
    ENGINEERING_SECTIONS: engineering,
    LIVE_TABS: tabs,
  } = await import("../src/views/navigation.ts");
  assert.deepEqual(
    product.map((item) => item.id),
    ["home", "live", "sessions"],
  );
  assert.deepEqual(
    engineering.map((item) => item.id),
    ["diagnostics"],
  );
  // Diagnostics is never part of the product group.
  assert.ok(!product.some((item) => item.id === "diagnostics"));
  assert.deepEqual(
    tabs.map((tab) => tab.label),
    ["Overview", "Powertrain", "Chassis", "Dynamics"],
  );
});

test("no routing or charting dependency was introduced", async () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), [
    "@tauri-apps/api",
    "react",
    "react-dom",
  ]);
  for (const file of ALL) {
    const source = read(file);
    assert.ok(
      !/from "(react-router|recharts|chart\.js|d3|victory)/.test(source),
      `${file} imports a routing or charting library`,
    );
  }
});

test("diagnostics keeps the existing engineering tools", () => {
  const source = read("views/DiagnosticsView.tsx");
  for (const expected of [
    "CapturePanel", // V0.3 raw datagram capture
    "protocolDiagnostics",
    "hubDiagnostics",
    "transportDiagnostics",
    "start_udp_listener",
    "stop_udp_listener",
    "preview_hex",
    "lifetime_dropped_frames",
  ]) {
    assert.ok(source.includes(expected), `diagnostics lost ${expected}`);
  }
});

test("the wheel corner mapping exists in exactly one frontend module", () => {
  // Corner identity is resolved in the backend adapter. The frontend maps a
  // corner code to a named field once; no view, component or second module may
  // repeat it, because a duplicated mapping is how corners get transposed.
  const mappers = ALL.filter((file) =>
    /front_left|rear_right/.test(code(file)),
  );
  assert.deepEqual(mappers.sort(), [
    // F1 25 (V2.0): the backend names F1 corners from the F1 wire order
    // (RL, RR, FL, FR); this one module reads those names into presentation
    // order for F1 Live and Diagnostics alike, and shares nothing with FH6.
    "telemetry/f1-wheels.ts",
    "telemetry/frame.ts", // declares the shape
    "telemetry/telemetry-view-model.ts", // maps corner -> field, once
  ]);
  // And no component or view indexes wheels positionally.
  for (const view of [...PRODUCT_VIEWS, "telemetry/live-layout.ts"]) {
    const source = code(view);
    assert.ok(!/wheels\s*\[/.test(source), `${view} must not index wheels`);
    assert.ok(
      !/\.sort\(|\.reverse\(/.test(source),
      `${view} must not reorder corners`,
    );
  }
});

test("no product view rescales a canonical telemetry unit itself", () => {
  // Presentation conversions live in formatting.ts alone. A view doing its own
  // arithmetic on a canonical measurement is how a unit silently drifts. A
  // millisecond-to-second divide on a session duration is not one of those:
  // the rule is about the telemetry units this phase introduced.
  for (const view of PRODUCT_VIEWS) {
    const source = code(view);
    assert.ok(
      !/- 32|\* 5 \/ 9|5 \/ 9/.test(source),
      `${view} converts temperature`,
    );
    assert.ok(
      !/(temperature|travel|power|torque|rotation)\w*\s*[*/]\s*\d/i.test(
        source,
      ),
      `${view} rescales a canonical telemetry value`,
    );
  }
  // The Fahrenheit conversion exists only in the Rust adapter, nowhere in the
  // frontend at all.
  for (const file of ALL) {
    assert.ok(!/32\)\s*\* 5/.test(read(file)), `${file} converts temperature`);
  }
});

test("diagnostics still exposes the raw per-wheel and race adapter values", () => {
  const diagnostics = read("telemetry/diagnostics-view-model.ts");
  for (const expected of [
    "tire_temperatures",
    "normalized_suspension_travel",
    "tire_slip_ratio",
    "tire_slip_angle",
    "tire_combined_slip",
    "wheel_rotation_rad_s",
    "suspension_travel_metres",
    "distance_traveled",
    "best_lap",
    "boost",
    "fuel",
    "Gear (raw code)",
  ]) {
    assert.ok(diagnostics.includes(expected), `diagnostics lost ${expected}`);
  }
});

test("each game's Live presentation is isolated", () => {
  // F1 25 views never reach FH6's builders, wheel mapping or wording, and
  // FH6's never reach F1 25's.
  for (const file of F1_LIVE) {
    const source = code(file);
    assert.ok(
      !/telemetry-view-model|from "\.\.\/\.\.\/telemetry\/live-layout\.ts"|useLive\(|liveStore/.test(
        source.replace(/import type[^;]+;/g, ""),
      ),
      `${file} must not use FH6 telemetry`,
    );
  }
  for (const file of [
    ...LIVE_TABS,
    "workspaces/Fh6LiveWorkspace.tsx",
    "telemetry/live-layout.ts",
    "telemetry/telemetry-view-model.ts",
  ]) {
    // Imports and identifiers, not prose: the neutral waiting sentence may
    // name "F1 25" as a supported game.
    assert.ok(
      !/from "[^"]*f1-|useF1|f1LiveStore|f1Store|F1Live|F1_/.test(code(file)),
      `${file} must not use F1 25 data`,
    );
  }
  // Wheels reach F1 tabs only through the F1 layout, never by index.
  for (const file of F1_LIVE) {
    const source = code(file);
    assert.ok(!/wheels\s*\[|\[\s*[0-3]\s*\]\./.test(source), file);
    assert.ok(
      !/front_left|rear_right|rear_left|front_right/.test(source),
      file,
    );
  }
});
