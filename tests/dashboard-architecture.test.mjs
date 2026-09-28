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
const PRODUCT_VIEWS = [
  "views/OverviewView.tsx",
  "views/EngineView.tsx",
  "views/DynamicsView.tsx",
  "views/TiresView.tsx",
  "views/SuspensionView.tsx",
  "views/InputsView.tsx",
  "views/RaceView.tsx",
  "views/SessionsView.tsx",
];

test("all nine dashboard views and the shell exist", () => {
  for (const view of [...PRODUCT_VIEWS, "views/DiagnosticsView.tsx"]) {
    assert.ok(ALL.includes(view), `missing ${view}`);
  }
  assert.ok(ALL.includes("components/AppShell.tsx"));
  assert.ok(ALL.includes("components/StatusBar.tsx"));
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
  for (const view of [...PRODUCT_VIEWS, "telemetry/telemetry-view-model.ts"]) {
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
  // Only the two hooks poll. No view, component or panel owns a loop.
  assert.deepEqual(callers.sort(), [
    "hooks/use-live-telemetry.ts",
    "hooks/use-recorder-status.ts",
  ]);
  const app = read("App.tsx");
  // Both hooks are called unconditionally in the shell, so a view change can
  // neither start a second loop nor tear the existing one down.
  assert.ok(app.includes("useLiveTelemetry()"));
  assert.ok(app.includes("useRecorderStatus()"));
  assert.equal(app.match(/useLiveTelemetry\(\)/g).length, 1);
  assert.equal(app.match(/useRecorderStatus\(\)/g).length, 1);
  // Views are rendered as children of the shell; none of them calls a hook
  // that polls.
  for (const view of [...PRODUCT_VIEWS, "views/DiagnosticsView.tsx"]) {
    const source = read(view);
    assert.ok(!source.includes("useLiveTelemetry"), view);
    assert.ok(!source.includes("useRecorderStatus"), view);
  }
});

test("switching views cannot duplicate a polling loop", () => {
  const app = read("App.tsx");
  // The view switch is a plain conditional render below the hook calls.
  const hookLine = app.indexOf("useLiveTelemetry()");
  const switchLine = app.indexOf('view === "overview"');
  assert.ok(hookLine > -1 && switchLine > hookLine);
  // No hook is called inside a conditional branch.
  assert.ok(!/\?\s*use[A-Z]/.test(app));
  // The Sessions view receives recorder status as a prop instead of polling.
  const sessions = read("views/SessionsView.tsx");
  assert.ok(!sessions.includes("startLatestPolling"));
  assert.ok(sessions.includes("recorder,"));
});

test("every subscription cleans up on unmount", () => {
  for (const file of ALL) {
    const source = read(file);
    if (source.includes("startLatestPolling(")) {
      // The poller returns its own disposer; the effect must return it.
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
  const { PRODUCT_VIEWS: product, DIAGNOSTIC_VIEWS: engineering } =
    await import("../src/views/navigation.ts");
  assert.deepEqual(
    product.map((item) => item.id),
    [
      "overview",
      "engine",
      "dynamics",
      "tires",
      "suspension",
      "inputs",
      "race",
      "sessions",
    ],
  );
  assert.deepEqual(
    engineering.map((item) => item.id),
    ["diagnostics"],
  );
  // Diagnostics is never part of the product group.
  assert.ok(!product.some((item) => item.id === "diagnostics"));
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
    "telemetry/frame.ts", // declares the shape
    "telemetry/telemetry-view-model.ts", // maps corner -> field, once
  ]);
  // And no component or view indexes wheels positionally.
  for (const view of [...PRODUCT_VIEWS, "components/WheelTelemetry.tsx"]) {
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
