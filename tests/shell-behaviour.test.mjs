// Behaviour of the V1.1 shell in a DOM: keyboard and focus, scroll, first-run
// subscriptions and render isolation. The architecture tests assert the
// structure; these assert what a user (or a 20 Hz update) actually gets.
import { calls, nextTabbable, renders, resetRenders } from "./support/dom.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {
  act,
  click,
  focus,
  h,
  installBackend,
  cleanup,
  mount,
  onCleanup,
  press,
  recorder,
  resetStores,
  settle,
  ShellHarness,
  snapshot,
  update,
  frame,
} from "./support/shell.mjs";
import { FirstRunSlot } from "../src/components/shell/FirstRunSlot.tsx";
import { TopBar } from "../src/components/shell/TopBar.tsx";
import { liveStore, recorderStore, setupStore } from "../src/state/stores.ts";

installBackend();
test.afterEach(cleanup);

/// Element identity. Never pass DOM nodes to assert.equal: on failure it tries
/// to diff two jsdom object graphs and runs out of memory.
function describe(element) {
  if (element == null) return String(element);
  const text = element.textContent?.trim().slice(0, 24) ?? "";
  return `<${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${
    element.className
      ? `.${String(element.className).split(" ").join(".")}`
      : ""
  }> "${text}"`;
}
function same(actual, expected, message = "") {
  assert.ok(
    actual === expected,
    `${message} expected ${describe(expected)}, got ${describe(actual)}`,
  );
}

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const selectedTab = () => $('[role="tab"][aria-selected="true"]');
const tab = (label) =>
  $$('[role="tab"]').find((element) => element.textContent === label);
const sidebar = (label) =>
  $$(".sidebar-item").find((element) => element.textContent.includes(label));

async function live(overrides = {}) {
  await update(liveStore, { snapshot: snapshot(overrides), error: null });
}

// ------------------------------------------------------- status disclosure

test("status details are a non-modal disclosure reachable from the keyboard", async () => {
  resetStores();
  await live();
  await update(recorderStore, { recorder: recorder(), error: null });
  const view = await mount(h(TopBar));
  const trigger = $(".state-pill");
  const panel = document.getElementById(trigger.getAttribute("aria-controls"));

  // Closed: the trigger says so, and controls a panel that exists but is hidden.
  assert.equal(trigger.tagName, "BUTTON");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.ok(panel, "aria-controls must name the panel");
  assert.equal(panel.hidden, true);
  // Not a dialog: nothing modal, no focus trap.
  assert.notEqual(panel.getAttribute("role"), "dialog");
  assert.equal(panel.getAttribute("aria-modal"), null);
  assert.equal(panel.getAttribute("aria-label"), "Connection details");

  // A native button: Enter and Space activate it as a click.
  await focus(trigger);
  await click(trigger);
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.equal(panel.hidden, false);

  // Tab from the trigger reaches the details.
  same(nextTabbable(trigger), panel);
  await focus(panel);
  same(document.activeElement, panel);

  // All four V1.0 readings are inside it.
  for (const label of ["Connection", "Health", "Session", "Recording"]) {
    assert.ok(
      [...panel.querySelectorAll("dt")].some((dt) => dt.textContent === label),
      `missing ${label}`,
    );
  }
  assert.match(panel.textContent, /Connected/);
  assert.match(panel.textContent, /Good/);

  // Escape closes and returns focus to the trigger.
  await press("Escape");
  assert.equal(panel.hidden, true);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  same(document.activeElement, trigger);
  await view.unmount();
});

test("the details close when focus or a click moves elsewhere", async () => {
  resetStores();
  await live();
  const outside = document.createElement("button");
  document.body.append(outside);
  const view = await mount(h(TopBar));
  const trigger = $(".state-pill");
  const panel = document.getElementById(trigger.getAttribute("aria-controls"));

  await click(trigger);
  await focus(panel);
  await focus(outside);
  assert.equal(panel.hidden, true, "focus leaving closes it");

  await click(trigger);
  assert.equal(panel.hidden, false);
  await focus(trigger);
  await focus(panel); // moving within the disclosure keeps it open
  assert.equal(panel.hidden, false);
  await update(liveStore, { snapshot: snapshot(), error: null });
  await act(async () => {
    outside.dispatchEvent(
      new window.MouseEvent("pointerdown", { bubbles: true }),
    );
  });
  assert.equal(panel.hidden, true, "a click outside closes it");
  outside.remove();
  await view.unmount();
});

// ---------------------------------------------------------------- Live tabs

test("Live tabs follow the WAI-ARIA tab pattern", async () => {
  resetStores();
  await live();
  const view = await mount(h(ShellHarness));
  const panel = $('[role="tabpanel"]');
  const tabs = $$('[role="tab"]');
  assert.deepEqual(
    tabs.map((element) => element.textContent),
    ["Overview", "Powertrain", "Chassis", "Dynamics"],
  );

  const check = (label) => {
    const selected = selectedTab();
    assert.equal(selected.textContent, label);
    // Roving tabindex: exactly the selected tab is a tab stop.
    for (const element of tabs) {
      assert.equal(element.tabIndex, element === selected ? 0 : -1);
      assert.equal(element.getAttribute("aria-controls"), panel.id);
    }
    assert.equal(panel.getAttribute("aria-labelledby"), selected.id);
  };

  check("Overview");
  // The panel is keyboard reachable: the next tab stop after the tab list.
  assert.equal(panel.tabIndex, 0);
  same(nextTabbable(selectedTab()), panel);

  await focus(tab("Overview"));
  await press("ArrowRight");
  check("Powertrain");
  same(document.activeElement, tab("Powertrain"));
  assert.ok(
    panel.querySelector('[data-source="engine.power_w"][data-role="home"]'),
    "the panel shows the Powertrain tab",
  );

  await press("End");
  check("Dynamics");
  same(document.activeElement, tab("Dynamics"));

  await press("ArrowRight"); // wraps
  check("Overview");
  await press("ArrowLeft"); // wraps back
  check("Dynamics");
  await press("Home");
  check("Overview");
  same(document.activeElement, tab("Overview"));
  await view.unmount();
});

test("numeric shortcuts keep the selected tab and keyboard focus together", async () => {
  resetStores();
  await live();
  const view = await mount(h(ShellHarness));
  const panel = $('[role="tabpanel"]');

  // Focus on a tab: focus follows the shortcut, so the focused tab is always
  // the selected one (never a tabindex=-1 tab).
  await focus(tab("Overview"));
  await press("3");
  assert.equal(selectedTab().textContent, "Chassis");
  same(document.activeElement, tab("Chassis"));
  assert.equal(document.activeElement.tabIndex, 0);

  // Focus in the panel: the panel element is stable, so focus stays on it and
  // it is relabelled by the new tab.
  await focus(panel);
  await press("2");
  assert.equal(selectedTab().textContent, "Powertrain");
  same(document.activeElement, panel);
  same($('[role="tabpanel"]'), panel);
  assert.equal(panel.getAttribute("aria-labelledby"), tab("Powertrain").id);
  await view.unmount();
});

test("typing in a form control never triggers a shortcut", async () => {
  resetStores();
  await live();
  const view = await mount(h(ShellHarness));
  for (const tag of ["input", "textarea", "select"]) {
    const field = document.createElement(tag);
    if (tag === "select") field.append(new Option("2", "2"));
    document.querySelector(".workspace-inner").append(field);
    await focus(field);
    for (const key of ["1", "2", "3", "4"]) await press(key);
    assert.equal(selectedTab().textContent, "Overview", tag);
    same(document.activeElement, field);
    field.remove();
  }
  // Ctrl+digit is a command, not text; it still switches sections.
  const field = document.createElement("input");
  document.querySelector(".workspace-inner").append(field);
  await focus(field);
  await press("2", { ctrlKey: true });
  await settle();
  assert.equal($(".sidebar-item.is-active").textContent, "Sessions");
  await view.unmount();
});

// ------------------------------------------------------------ scroll reset

test("navigation always opens at the top of the workspace", async () => {
  resetStores();
  await live();
  const view = await mount(h(ShellHarness));
  const workspace = $("main.workspace");

  workspace.scrollTop = 480;
  await click(sidebar("Sessions"));
  assert.equal(workspace.scrollTop, 0, "section change by click");

  workspace.scrollTop = 300;
  await press("1", { ctrlKey: true, target: document.body });
  await settle();
  assert.equal(selectedTab().textContent, "Overview");
  assert.equal(workspace.scrollTop, 0, "section change by shortcut");

  workspace.scrollTop = 250;
  await click(tab("Chassis"));
  assert.equal(workspace.scrollTop, 0, "Live tab change by click");

  workspace.scrollTop = 200;
  await focus(tab("Chassis"));
  await press("4");
  assert.equal(selectedTab().textContent, "Dynamics");
  assert.equal(workspace.scrollTop, 0, "Live tab change by shortcut");

  workspace.scrollTop = 150;
  await press("ArrowLeft");
  assert.equal(workspace.scrollTop, 0, "Live tab change by arrow key");

  // Re-selecting where you already are is not navigation: nothing resets.
  workspace.scrollTop = 120;
  await click(sidebar("Live"));
  assert.equal(workspace.scrollTop, 120);
  await click(selectedTab());
  assert.equal(workspace.scrollTop, 120);

  workspace.scrollTop = 90;
  await click(sidebar("Diagnostics"));
  assert.equal(workspace.scrollTop, 0);
  workspace.scrollTop = 60;
  await click(sidebar("Settings"));
  assert.equal(workspace.scrollTop, 0);
  await view.unmount();
});

// ------------------------------------------------- first-run subscription

function countLiveSubscribers() {
  const original = liveStore.subscribe;
  const counter = { active: 0, restore() {} };
  onCleanup(() => (liveStore.subscribe = original));
  liveStore.subscribe = (listener) => {
    counter.active += 1;
    const dispose = original(listener);
    return () => {
      counter.active -= 1;
      dispose();
    };
  };
  return counter;
}

const SETUP = {
  listen_host: "127.0.0.1",
  listen_port: 20440,
  fh6_first_detected_unix_ms: null,
};

test("first-run guidance reads live telemetry only while instructions show", async () => {
  resetStores();
  const subscribers = countLiveSubscribers();
  const view = await mount(h(FirstRunSlot));
  assert.equal(subscribers.active, 0, "nothing before setup is known");

  await update(setupStore, {
    setup: { ...SETUP, first_run: true },
    sawFirstRun: true,
    error: null,
  });
  assert.match(view.container.textContent, /Turn on Data Out/);
  assert.equal(subscribers.active, 1, "instructions state what is arriving");

  // Telemetry arrives: the backend clears first_run; the latch keeps the
  // success confirmation, which does not read live telemetry.
  await update(setupStore, {
    setup: { ...SETUP, first_run: false, fh6_first_detected_unix_ms: 1 },
    sawFirstRun: true,
    error: null,
  });
  assert.match(view.container.textContent, /Setup complete/);
  assert.match(view.container.textContent, /Forza Horizon 6 is connected/);
  assert.equal(subscribers.active, 0, "confirmation unsubscribed");

  await click([...view.container.querySelectorAll("button")].at(-1));
  assert.equal(view.container.textContent, "");
  assert.equal(subscribers.active, 0, "dismissed: nothing mounted reads live");
  await view.unmount();
  subscribers.restore();
});

test("a configured installation mounts no first-run subscriber at all", async () => {
  resetStores();
  const subscribers = countLiveSubscribers();
  const view = await mount(h(FirstRunSlot));
  await update(setupStore, {
    setup: { ...SETUP, first_run: false, fh6_first_detected_unix_ms: 1 },
    sawFirstRun: false,
    error: null,
  });
  assert.equal(view.container.textContent, "");
  assert.equal(subscribers.active, 0);
  await view.unmount();
  subscribers.restore();
});

// --------------------------------------------------------- render isolation

async function liveUpdates(count) {
  for (let i = 0; i < count; i += 1) {
    await update(liveStore, {
      snapshot: snapshot({ frame: frame(10 + i) }),
      error: null,
    });
  }
}

test("live updates reach mounted Live content (positive control)", async () => {
  resetStores();
  await live();
  const view = await mount(h(ShellHarness));
  resetRenders();
  await liveUpdates(20);
  assert.equal(renders.Fh6LiveWorkspace, 20, "one Live render per update");
  // The game router selects the game, not the reading: it never re-renders
  // for telemetry.
  assert.equal(renders.LiveWorkspace ?? 0, 0);
  assert.ok(renders.OverviewTab >= 20);
  // And the reading on screen is the latest one: 29 m/s = 104 km/h.
  assert.match($(".drive-speed .readout-value").textContent, /^104$/);
  // The frame itself never re-renders for telemetry.
  assert.equal(renders.AppShell ?? 0, 0);
  assert.equal(renders.Sidebar ?? 0, 0);
  await view.unmount();
});

test("Sessions does not render from the same live updates", async () => {
  resetStores();
  await live();
  await update(recorderStore, { recorder: recorder(), error: null });
  const view = await mount(h(ShellHarness));
  await click(sidebar("Sessions"));
  await settle();
  assert.match(document.body.textContent, /History/);
  assert.ok($("[role=option][aria-selected=true]"), "a session is open");

  resetRenders();
  await liveUpdates(20);
  for (const name of [
    "SessionsWorkspace",
    "SessionList",
    "SessionDetail",
    "RecordingRow",
  ]) {
    assert.equal(renders[name] ?? 0, 0, `${name} stays still`);
  }
  assert.equal(renders.LiveWorkspace ?? 0, 0, "Live is unmounted");

  // Recorder ticks (duration, frames written) re-render only the pinned
  // recording row — at most once per tick, and only when its text changes —
  // never the list or the selected session around it.
  resetRenders();
  for (let i = 0; i < 6; i += 1) {
    await update(recorderStore, {
      recorder: recorder({ completed_sessions: 1 }),
      error: null,
    });
  }
  assert.ok(renders.RecordingRow >= 1 && renders.RecordingRow <= 6);
  for (const name of ["SessionsWorkspace", "SessionList", "SessionDetail"]) {
    assert.equal(renders[name] ?? 0, 0, `${name} ignores recorder ticks`);
  }

  // Positive control: a completed session — the change Sessions exists to
  // show — does render it, and re-reads the list.
  resetRenders();
  const before = calls.filter((name) => name === "list_recent_sessions").length;
  await update(recorderStore, {
    recorder: recorder({ completed_sessions: 2 }),
    error: null,
  });
  await settle();
  assert.ok(renders.SessionList >= 1);
  assert.equal(
    calls.filter((name) => name === "list_recent_sessions").length,
    before + 1,
  );
  await view.unmount();
});
