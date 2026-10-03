// Painted-layout regressions, measured in a real browser engine with element
// bounds (jsdom has no layout). Runs the dev-only review harness against its
// mock backend; see tests/support/browser.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { startBrowser } from "./support/browser.mjs";

const env = await startBrowser();
const skip = env.skip ?? false;
if (skip) console.log(`# browser layout tests skipped: ${skip}`);
test.after(async () => {
  if (!skip) await env.close();
});

const TABS = ["Overview", "Powertrain", "Chassis", "Dynamics"];

/// The release resolution matrix: the minimum window, the default window,
/// the most common laptop panel, and full HD.
const RELEASE_SIZES = [
  [960, 640],
  [1280, 680],
  [1366, 768],
  [1920, 1080],
];

async function openTab(label) {
  await env.page.evaluate(`(async () => {
    [...document.querySelectorAll('[role=tab]')]
      .find((tab) => tab.textContent === ${JSON.stringify(label)})
      .click();
    await new Promise((resolve) => setTimeout(resolve, 250));
  })()`);
}

/// Document vs workspace scroll extents. The workspace is the one intended
/// scroll container; the document itself must never scroll.
const SCROLL = `(() => {
  const root = document.scrollingElement;
  const workspace = document.querySelector("main.workspace");
  return {
    documentHeight: root.scrollHeight,
    documentWidth: root.scrollWidth,
    viewportHeight: innerHeight,
    viewportWidth: innerWidth,
    workspaceScrolls: workspace.scrollHeight > workspace.clientHeight,
  };
})()`;

/// Every painted conflict in the open tab, from element bounds:
/// a value overlapping its unit, a value squeezed narrower than its own
/// digits, any text escaping its reading box or table cell, and two readings
/// overlapping each other.
const CONFLICTS = `(() => {
  const panel = document.querySelector("[role=tabpanel]");
  const box = (element) => element.getBoundingClientRect();
  const painted = (element) => {
    const r = box(element);
    return r.width > 0 && r.height > 0 && !element.closest(".visually-hidden");
  };
  const overlap = (a, b) =>
    a.left < b.right - 0.5 && b.left < a.right - 0.5 &&
    a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
  const name = (element) =>
    (element.className || element.tagName) + " '" +
    element.textContent.trim().slice(0, 28) + "'";
  const problems = [];

  for (const line of panel.querySelectorAll(".readout-line")) {
    const value = line.querySelector(".readout-value");
    const unit = line.querySelector(".readout-unit");
    if (value && unit && overlap(box(value), box(unit))) {
      problems.push("value overlaps unit: " + name(line));
    }
    if (value && value.scrollWidth > value.clientWidth + 1) {
      problems.push("value squeezed below its width: " + name(value));
    }
  }

  const containers = panel.querySelectorAll(
    ".readout, .control-bar, .rpm-bar-end, .context-state, td, th",
  );
  for (const container of containers) {
    if (!painted(container)) continue;
    const outer = box(container);
    if (container.matches("td, th") &&
        container.scrollWidth > container.clientWidth + 1) {
      problems.push("text wider than its cell: " + name(container));
    }
    for (const child of container.querySelectorAll("*")) {
      if (!painted(child)) continue;
      const inner = box(child);
      if (inner.left < outer.left - 1 || inner.right > outer.right + 1) {
        problems.push("escapes " + name(container) + ": " + name(child));
      }
    }
  }

  const readings = [...panel.querySelectorAll(".readout, .control-bar")]
    .filter(painted);
  for (let i = 0; i < readings.length; i += 1) {
    for (let j = i + 1; j < readings.length; j += 1) {
      const [a, b] = [readings[i], readings[j]];
      if (a.contains(b) || b.contains(a)) continue;
      if (overlap(box(a), box(b))) {
        problems.push("readings overlap: " + name(a) + " / " + name(b));
      }
    }
  }

  for (const table of panel.querySelectorAll("table")) {
    const outer = box(table.closest(".live-panel"));
    const inner = box(table);
    if (inner.right > outer.right + 1) {
      problems.push("table wider than its panel");
    }
  }
  return [...new Set(problems)];
})()`;

// ------------------------------------------------------------- blocker A

test(
  "960x640, no readings, Chassis: the document never grows a second scrollbar",
  { skip },
  async () => {
    await env.page.size(960, 640);
    // FH6 connected but not driving: FH6's tabs with every reading
    // unavailable. (V2.0's neutral waiting view has no FH6 tabs.)
    await env.open("/review/shell.html?scenario=idle");
    await openTab("Chassis");
    const extents = await env.page.evaluate(SCROLL);
    assert.ok(
      extents.documentHeight <= extents.viewportHeight,
      `document is ${extents.documentHeight}px tall in a ${extents.viewportHeight}px window`,
    );
    // The workspace — the one intentional scroll container — does scroll.
    assert.equal(extents.workspaceScrolls, true);
    // And the screen-reader text is still present, just not painted.
    const hidden = await env.page.evaluate(
      `[...document.querySelectorAll("[role=tabpanel] .visually-hidden")]
        .filter((element) => element.textContent === "unavailable").length`,
    );
    assert.ok(hidden > 20, `${hidden} "unavailable" announcements`);
  },
);

test(
  "no tab, size or scenario makes the document itself scroll",
  { skip },
  async () => {
    for (const [width, height] of RELEASE_SIZES) {
      await env.page.size(width, height);
      for (const scenario of ["idle", "live", "stress"]) {
        await env.open(`/review/shell.html?scenario=${scenario}`);
        for (const tab of TABS) {
          await openTab(tab);
          const extents = await env.page.evaluate(SCROLL);
          const where = `${width}x${height} ${scenario} ${tab}`;
          assert.ok(
            extents.documentHeight <= extents.viewportHeight,
            `${where}: document height ${extents.documentHeight}`,
          );
          assert.ok(
            extents.documentWidth <= extents.viewportWidth,
            `${where}: document width ${extents.documentWidth}`,
          );
        }
      }
    }
  },
);

// ------------------------------------------------------------- blocker B

test(
  "wide signed values never overlap their units or neighbours",
  { skip },
  async () => {
    const failures = [];
    for (const [width, height] of RELEASE_SIZES) {
      await env.page.size(width, height);
      await env.open("/review/shell.html?scenario=stress");
      for (const tab of TABS) {
        await openTab(tab);
        for (const problem of await env.page.evaluate(CONFLICTS)) {
          failures.push(`${width}x${height} ${tab}: ${problem}`);
        }
      }
    }
    assert.deepEqual(failures, []);
  },
);

test(
  "960x640 Powertrain shows -1500.0 N·m in full, beside or below its unit",
  { skip },
  async () => {
    await env.page.size(960, 640);
    await env.open("/review/shell.html?scenario=stress");
    await openTab("Powertrain");
    const torque = await env.page.evaluate(`(() => {
      const readout = document.querySelector('[data-source="engine.torque_nm"]');
      const value = readout.querySelector(".readout-value");
      const unit = readout.querySelector(".readout-unit");
      const v = value.getBoundingClientRect();
      const u = unit.getBoundingClientRect();
      return {
        text: value.textContent,
        unit: unit.textContent,
        fontSize: parseFloat(getComputedStyle(value).fontSize),
        valueFits: value.scrollWidth <= value.clientWidth + 1,
        unitAfterOrBelow: u.left >= v.right - 0.5 || u.top >= v.bottom - 0.5,
      };
    })()`);
    assert.equal(torque.text, "-1500.0", "never truncated or reformatted");
    assert.equal(torque.unit, "N·m");
    assert.equal(torque.valueFits, true);
    assert.equal(torque.unitAfterOrBelow, true);
    assert.ok(torque.fontSize >= 24, `torque drawn at ${torque.fontSize}px`);
  },
);

// ------------------------------------------------------ narrow Chassis

test(
  "960x640 Chassis: every slip label stays inside its own reading",
  { skip },
  async () => {
    await env.page.size(960, 640);
    for (const scenario of ["live", "stress", "idle"]) {
      await env.open(`/review/shell.html?scenario=${scenario}`);
      await openTab("Chassis");
      const problems = await env.page.evaluate(`(() => {
        const out = [];
        for (const row of document.querySelectorAll(".corner-slip")) {
          const readings = [...row.querySelectorAll(".readout")];
          for (const reading of readings) {
            const outer = reading.getBoundingClientRect();
            const label = reading.querySelector(".readout-label");
            const inner = label.getBoundingClientRect();
            if (inner.left < outer.left - 1 || inner.right > outer.right + 1 ||
                label.scrollWidth > label.clientWidth + 1) {
              out.push(label.textContent);
            }
          }
          for (let i = 1; i < readings.length; i += 1) {
            const a = readings[i - 1].getBoundingClientRect();
            const b = readings[i].getBoundingClientRect();
            if (a.top === b.top && a.right > b.left + 0.5) out.push("overlap");
          }
        }
        return out;
      })()`);
      assert.deepEqual(problems, [], scenario);
    }
  },
);

// ------------------------------------------------------------- Sessions

const SESSION_SIZES = RELEASE_SIZES;
const SESSION_TABS = ["summary", "events", "turns", "slip", "data"];

/// Opens Sessions in the harness (mixed fixture set) and waits until the
/// newest session's detail has rendered.
async function openSessions(query = "sessions=mixed") {
  await env.open(`/review/shell.html?scenario=idle&${query}`);
  await env.page.evaluate(`(async () => {
    [...document.querySelectorAll(".sidebar-item")]
      .find((item) => item.textContent.includes("Sessions"))
      .click();
    for (let i = 0; i < 100; i += 1) {
      if (document.querySelector(".sessions-detail[data-session] [role=tabpanel]")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  })()`);
}

async function sessionTab(id) {
  await env.page.evaluate(`(async () => {
    document.getElementById("session-tab-${id}").click();
    await new Promise((resolve) => setTimeout(resolve, 250));
  })()`);
}

async function chooseSession(index) {
  await env.page.evaluate(`(async () => {
    document.querySelectorAll("[role=option]")[${index}].click();
    await new Promise((resolve) => setTimeout(resolve, 400));
  })()`);
}

/// Painted problems in the Sessions workspace: anything wider than its box,
/// text escaping a row or a fact, and a selected row hidden in its list.
const SESSION_CONFLICTS = `(() => {
  const problems = [];
  const box = (element) => element.getBoundingClientRect();
  const name = (element) =>
    (element.className || element.tagName) + " '" +
    element.textContent.trim().slice(0, 32) + "'";
  // Data tables are not wrapped in a scroll box (so their headers can stick):
  // each must fit the detail column outright.
  const column = document.querySelector(".sessions-detail");
  for (const table of document.querySelectorAll(".sessions-detail table")) {
    if (table.closest("details:not([open])")) continue;
    if (table.getBoundingClientRect().right > column.getBoundingClientRect().right + 1) {
      problems.push("table wider than the detail: " +
        name(table.querySelector("caption") ?? table));
    }
  }
  for (const element of document.querySelectorAll(
    ".fact, .count, .session-option, .session-header-main, .timeline-lane-label",
  )) {
    const outer = box(element);
    if (outer.width === 0) continue;
    for (const child of element.querySelectorAll("*")) {
      if (child.closest(".visually-hidden")) continue;
      const inner = box(child);
      if (inner.width === 0) continue;
      if (inner.left < outer.left - 1 || inner.right > outer.right + 1) {
        problems.push("escapes " + name(element) + ": " + name(child));
      }
    }
  }
  const detail = document.querySelector(".sessions-detail");
  if (detail && detail.scrollWidth > detail.clientWidth + 1) {
    problems.push("detail wider than its column");
  }
  const listbox = document.querySelector(".session-listbox");
  const selected = document.querySelector("[role=option][aria-selected=true]");
  if (listbox && selected) {
    const l = box(listbox);
    const s = box(selected);
    if (s.top < l.top - 1 || s.bottom > l.bottom + 1) {
      problems.push("selected row not visible in the list");
    }
  }
  return [...new Set(problems)];
})()`;

const SESSION_GEOMETRY = `(() => {
  const master = document.querySelector(".sessions-master").getBoundingClientRect();
  const detail = document.querySelector(".sessions-detail").getBoundingClientRect();
  return {
    masterRight: master.right,
    masterBottom: master.bottom,
    masterTop: master.top,
    detailLeft: detail.left,
    detailTop: detail.top,
    masterWidth: master.width,
    detailWidth: detail.width,
  };
})()`;

test(
  "Sessions never makes the document scroll, at any size or tab",
  { skip },
  async () => {
    const failures = [];
    for (const [width, height] of SESSION_SIZES) {
      await env.page.size(width, height);
      await openSessions();
      for (const tab of SESSION_TABS) {
        await sessionTab(tab);
        const extents = await env.page.evaluate(SCROLL);
        const where = `${width}x${height} ${tab}`;
        if (extents.documentHeight > extents.viewportHeight) {
          failures.push(`${where}: document height ${extents.documentHeight}`);
        }
        if (extents.documentWidth > extents.viewportWidth) {
          failures.push(`${where}: document width ${extents.documentWidth}`);
        }
      }
    }
    assert.deepEqual(failures, []);
  },
);

test(
  "Sessions is master/detail from 1280 px and stacked, list first, at 960 px",
  { skip },
  async () => {
    for (const [width, height] of SESSION_SIZES) {
      await env.page.size(width, height);
      await openSessions();
      const g = await env.page.evaluate(SESSION_GEOMETRY);
      const where = `${width}x${height}`;
      if (width >= 1280) {
        assert.ok(g.masterRight <= g.detailLeft, `${where}: side by side`);
        assert.ok(Math.abs(g.masterTop - g.detailTop) < 2, `${where}: aligned`);
        assert.ok(g.detailWidth > g.masterWidth * 2, `${where}: detail leads`);
      } else {
        assert.ok(g.masterBottom <= g.detailTop, `${where}: list above detail`);
        // The detail starts within the first screen.
        assert.ok(
          g.detailTop < height * 0.75,
          `${where}: detail at ${g.detailTop}`,
        );
      }
    }
  },
);

test(
  "Sessions: no table, fact or row overflows its box, in any tab or state",
  { skip },
  async () => {
    const failures = [];
    for (const [width, height] of SESSION_SIZES) {
      await env.page.size(width, height);
      await openSessions();
      // Newest (available), interrupted, large capped analysis.
      for (const index of [0, 3, 7]) {
        await chooseSession(index);
        for (const tab of SESSION_TABS) {
          await sessionTab(tab);
          // Expand the first row of a table so detail rows are measured too.
          await env.page.evaluate(`(async () => {
            document.querySelector(".row-toggle")?.click();
            await new Promise((resolve) => setTimeout(resolve, 150));
          })()`);
          for (const problem of await env.page.evaluate(SESSION_CONFLICTS)) {
            failures.push(`${width}x${height} #${index} ${tab}: ${problem}`);
          }
        }
      }
    }
    assert.deepEqual(failures, []);
  },
);

test(
  "Sessions: the list stays in view while the detail scrolls, and a new selection opens at its header",
  { skip },
  async () => {
    await env.page.size(1280, 680);
    await openSessions();
    await chooseSession(7);
    await sessionTab("events");
    const result = await env.page.evaluate(`(async () => {
      const workspace = document.querySelector("main.workspace");
      workspace.scrollTop = 2000;
      await new Promise((resolve) => setTimeout(resolve, 100));
      const master = document.querySelector(".sessions-master").getBoundingClientRect();
      const scrolled = workspace.scrollTop;
      document.querySelectorAll("[role=option]")[0].click();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const header = document.querySelector(".session-header").getBoundingClientRect();
      const port = workspace.getBoundingClientRect();
      return {
        scrolled,
        masterTop: master.top,
        portTop: port.top,
        headerTop: header.top,
        portBottom: port.bottom,
      };
    })()`);
    assert.ok(result.scrolled > 500, "the detail did scroll");
    assert.ok(
      result.masterTop >= result.portTop - 1 &&
        result.masterTop < result.portTop + 40,
      `list stuck at ${result.masterTop}`,
    );
    assert.ok(
      result.headerTop >= result.portTop - 1 &&
        result.headerTop < result.portBottom,
      `header at ${result.headerTop}`,
    );
  },
);

test(
  "Sessions: a long capped analysis paints its Events tab promptly and boundedly",
  { skip },
  async () => {
    await env.page.size(1280, 680);
    await openSessions();
    await chooseSession(7);
    const measured = await env.page.evaluate(`(async () => {
      const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const started = performance.now();
      document.getElementById("session-tab-events").click();
      await frame();
      await frame();
      return {
        ms: performance.now() - started,
        rows: document.querySelectorAll(".session-events tbody[data-kind]").length,
      };
    })()`);
    assert.equal(measured.rows, 100, "first page only");
    assert.ok(
      measured.ms < 500,
      `Events painted in ${measured.ms.toFixed(0)} ms`,
    );
    console.log(
      `# long analysis: Events tab painted in ${measured.ms.toFixed(1)} ms`,
    );
    await sessionTab("summary");
    const marks = await env.page.evaluate(
      `document.querySelectorAll(".timeline-mark").length`,
    );
    assert.ok(marks <= 6 * 240, `${marks} timeline marks`);
    console.log(
      `# long analysis: ${marks} timeline marks for the large capped session`,
    );
  },
);

/// Where the selected row sits against everything that can clip it: the
/// list's own scroll box, the workspace scrollport and the window.
const SELECTED_ROW_CLIP = `(() => {
  const row = document.querySelector("[role=option][aria-selected=true]");
  const r = row.getBoundingClientRect();
  const list = document.querySelector(".session-listbox").getBoundingClientRect();
  const port = document.querySelector("main.workspace").getBoundingClientRect();
  const top = Math.max(list.top, port.top, 0);
  const bottom = Math.min(list.bottom, port.bottom, innerHeight);
  return r.top >= top - 1 && r.bottom <= bottom + 1
    ? null
    : "row " + Math.round(r.top) + "-" + Math.round(r.bottom) +
      " outside " + Math.round(top) + "-" + Math.round(bottom);
})()`;

test(
  "Sessions: the selected history row is fully visible however it was chosen",
  { skip },
  async () => {
    const failures = [];
    for (const [width, height] of SESSION_SIZES) {
      await env.page.size(width, height);
      await openSessions();
      const where = `${width}x${height}`;
      // The list never starts below the window's bottom edge.
      const edge = await env.page.evaluate(`(() => {
        const master = document.querySelector(".sessions-master").getBoundingClientRect();
        return { bottom: master.bottom, height: innerHeight };
      })()`);
      if (edge.bottom > edge.height + 1) {
        failures.push(`${where}: list ends at ${Math.round(edge.bottom)}`);
      }
      // A pointer selection (which does not move focus) of every row.
      const clicks = await env.page.evaluate(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const out = [];
        const rows = document.querySelectorAll("[role=option]");
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          rows[i].click();
          await frame(); await frame();
          const problem = ${SELECTED_ROW_CLIP};
          if (problem) out.push("click " + i + ": " + problem);
        }
        return out;
      })()`);
      failures.push(...clicks.map((problem) => `${where} ${problem}`));
      // Keyboard, through the whole list and back.
      const keys = await env.page.evaluate(`(async () => {
        const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
        const out = [];
        const key = async (name) => {
          document.activeElement.dispatchEvent(
            new KeyboardEvent("keydown", { key: name, bubbles: true }),
          );
          await frame(); await frame();
          const problem = ${SELECTED_ROW_CLIP};
          if (problem) out.push(name + ": " + problem);
        };
        document.querySelector("[role=option][aria-selected=true]").focus();
        const count = document.querySelectorAll("[role=option]").length;
        for (let i = 1; i < count; i += 1) await key("ArrowDown");
        await key("Home");
        await key("End");
        return out;
      })()`);
      failures.push(...keys.map((problem) => `${where} ${problem}`));
      // A remembered selection, shown again on returning to Sessions.
      const remembered = await env.page.evaluate(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const rows = document.querySelectorAll("[role=option]");
        rows[rows.length - 1].click();
        await wait(300);
        const nav = (label) => [...document.querySelectorAll(".sidebar-item")]
          .find((item) => item.textContent.includes(label)).click();
        nav("Settings");
        await wait(300);
        nav("Sessions");
        for (let i = 0; i < 60; i += 1) {
          if (document.querySelector("[role=option][aria-selected=true]")) break;
          await wait(50);
        }
        await wait(300);
        return ${SELECTED_ROW_CLIP};
      })()`);
      if (remembered) failures.push(`${where} remembered: ${remembered}`);
    }
    assert.deepEqual(failures, []);
  },
);

// ------------------------------------------- Settings, Diagnostics, states

const STAGE_E_SIZES = RELEASE_SIZES;

async function openSection(query, label) {
  await env.open(`/review/shell.html?${query}`);
  await env.page.evaluate(`(async () => {
    const item = [...document.querySelectorAll(".sidebar-item")]
      .find((element) => element.textContent.includes(${JSON.stringify(label)}));
    item.click();
    await new Promise((resolve) => setTimeout(resolve, 600));
  })()`);
}

/// Anything painted outside its box, clipped text, or a table wider than its
/// group, in the Stage E surfaces present on screen.
const STAGE_E_CONFLICTS = `(() => {
  const problems = [];
  const box = (element) => element.getBoundingClientRect();
  const name = (element) =>
    (element.className || element.tagName) + " '" +
    element.textContent.trim().slice(0, 32) + "'";
  const containers = document.querySelectorAll(
    ".notice, .settings-group, .diag-group, .setup-guide, .segmented, " +
    ".setup-detection, .topbar-state, .settings-facts",
  );
  for (const container of containers) {
    const outer = box(container);
    if (outer.width === 0) continue;
    for (const child of container.querySelectorAll("*")) {
      if (child.closest(".visually-hidden, [hidden], details:not([open]) > :not(summary)")) continue;
      const inner = box(child);
      if (inner.width === 0) continue;
      if (inner.left < outer.left - 1 || inner.right > outer.right + 1) {
        problems.push("escapes " + name(container) + ": " + name(child));
      }
    }
  }
  for (const element of document.querySelectorAll(
    ".notice-title, .notice-detail, .state-pill-title, .settings-status, " +
    ".diag-value, .setup-steps li, .segment",
  )) {
    if (box(element).width === 0) continue;
    if (element.scrollWidth > element.clientWidth + 1) {
      problems.push("clipped: " + name(element));
    }
  }
  return [...new Set(problems)];
})()`;

async function checkScreen(where, failures) {
  const extents = await env.page.evaluate(SCROLL);
  if (extents.documentHeight > extents.viewportHeight) {
    failures.push(`${where}: document height ${extents.documentHeight}`);
  }
  if (extents.documentWidth > extents.viewportWidth) {
    failures.push(`${where}: document width ${extents.documentWidth}`);
  }
  for (const problem of await env.page.evaluate(STAGE_E_CONFLICTS)) {
    failures.push(`${where}: ${problem}`);
  }
}

test(
  "Settings, empty Sessions and every Diagnostics tab fit at every size, with nothing clipped",
  { skip },
  async () => {
    const failures = [];
    for (const [width, height] of STAGE_E_SIZES) {
      await env.page.size(width, height);
      await openSection("scenario=live&storage=over", "Settings");
      await env.page.evaluate(`(async () => {
        [...document.querySelectorAll("button")]
          .find((b) => b.textContent === "Show setup steps").click();
        await new Promise((resolve) => setTimeout(resolve, 300));
      })()`);
      await checkScreen(`${width}x${height} Settings`, failures);
      // No sessions yet, while the first one records: the empty state with
      // the pinned recording row above it.
      await openSection("scenario=live&sessions=none", "Sessions");
      await checkScreen(`${width}x${height} Sessions empty`, failures);
      await openSection("scenario=live", "Diagnostics");
      for (const tab of ["connection", "pipeline", "adapter", "capture"]) {
        await env.page.evaluate(`(async () => {
          document.getElementById("diagnostics-tab-${tab}").click();
          await new Promise((resolve) => setTimeout(resolve, 300));
        })()`);
        await checkScreen(`${width}x${height} Diagnostics ${tab}`, failures);
      }
    }
    assert.deepEqual(failures, []);
  },
);

test(
  "every product state fits at every size: one alert, no clipped status text",
  { skip },
  async () => {
    const failures = [];
    for (const [width, height] of STAGE_E_SIZES) {
      await env.page.size(width, height);
      for (const scenario of [
        "first-run",
        "waiting",
        "degraded",
        "grace",
        "recording-failed",
        "recovered-recorder",
        "port-error",
      ]) {
        await env.open(`/review/shell.html?scenario=${scenario}`);
        const where = `${width}x${height} ${scenario}`;
        await checkScreen(where, failures);
        const alerts = await env.page.evaluate(
          `document.querySelectorAll(".shell-alert-slot .notice").length`,
        );
        if (alerts > 1) failures.push(`${where}: ${alerts} global alerts`);
      }
      await env.open("/review/shell.html?scenario=setup-complete");
      await new Promise((resolve) => setTimeout(resolve, 3200));
      const done = await env.page.evaluate(
        `document.querySelector(".setup-guide.tone-good h2")?.textContent ?? null`,
      );
      if (done !== "Forza Horizon 6 is connected") {
        failures.push(`${width}x${height} setup-complete: ${done}`);
      }
      await checkScreen(`${width}x${height} setup-complete`, failures);
    }
    assert.deepEqual(failures, []);
  },
);

// --------------------------------------------------------------- F1 25 Live

const F1_TABS = ["Overview", "Race", "Tyres", "Dynamics"];

test(
  "F1 25 Live: every tab, size and snapshot fits with nothing overlapping",
  { skip },
  async () => {
    const failures = [];
    for (const [width, height] of RELEASE_SIZES) {
      await env.page.size(width, height);
      for (const query of [
        "scenario=f1-live&f1=driving",
        "scenario=f1-live&f1=stationary",
        "scenario=f1-stale&f1=high-speed",
      ]) {
        await env.open(`/review/shell.html?${query}`);
        const game = await env.page.evaluate(
          `document.querySelector(".live-workspace")?.dataset.game`,
        );
        if (game !== "f1_25") failures.push(`${query}: Live shows ${game}`);
        for (const tab of F1_TABS) {
          await openTab(tab);
          const where = `${width}x${height} ${query} ${tab}`;
          const extents = await env.page.evaluate(SCROLL);
          if (extents.documentHeight > extents.viewportHeight) {
            failures.push(
              `${where}: document height ${extents.documentHeight}`,
            );
          }
          if (extents.documentWidth > extents.viewportWidth) {
            failures.push(`${where}: document width ${extents.documentWidth}`);
          }
          for (const problem of await env.page.evaluate(CONFLICTS)) {
            failures.push(`${where}: ${problem}`);
          }
        }
      }
    }
    assert.deepEqual(failures, []);
  },
);

test(
  "F1 25 Tyres: four readable corners, front above rear, left beside right",
  { skip },
  async () => {
    for (const [width, height] of [
      [960, 640],
      [1280, 680],
      [1920, 1080],
    ]) {
      await env.page.size(width, height);
      await env.open("/review/shell.html?scenario=f1-live&f1=driving");
      await openTab("Tyres");
      const corners = await env.page.evaluate(`(() =>
        Object.fromEntries([...document.querySelectorAll("[data-corner]")]
          .map((element) => {
            const r = element.getBoundingClientRect();
            return [element.dataset.corner, { left: r.left, top: r.top, width: r.width }];
          })))()`);
      const where = `${width}x${height}`;
      assert.deepEqual(Object.keys(corners), ["FL", "FR", "RL", "RR"], where);
      assert.ok(corners.FL.left < corners.FR.left, `${where}: FL left of FR`);
      assert.ok(corners.RL.left < corners.RR.left, `${where}: RL left of RR`);
      assert.ok(corners.FL.top < corners.RL.top, `${where}: front above rear`);
      for (const [code, box] of Object.entries(corners)) {
        assert.ok(
          box.width >= 260,
          `${where}: ${code} only ${box.width}px wide`,
        );
      }
    }
  },
);

test(
  "no supported game: the neutral waiting view fits at every size",
  { skip },
  async () => {
    for (const [width, height] of RELEASE_SIZES) {
      await env.page.size(width, height);
      await env.open("/review/shell.html?scenario=waiting");
      const state = await env.page.evaluate(`({
        pill: document.querySelector(".state-pill-title").textContent,
        live: document.querySelector(".telemetry-empty-title")?.textContent,
        tabs: document.querySelectorAll("[role=tab]").length,
      })`);
      assert.deepEqual(state, {
        pill: "Waiting for a supported game",
        live: "Waiting for a supported game",
        tabs: 0,
      });
      const extents = await env.page.evaluate(SCROLL);
      assert.ok(extents.documentWidth <= extents.viewportWidth);
      assert.ok(extents.documentHeight <= extents.viewportHeight);
    }
  },
);
