// Keyboard behaviour in a real browser engine, with trusted key events (CDP
// Input), against the dev-only review harness and its mock backend. jsdom
// cannot answer these: it does not move focus on Tab, activate buttons on
// Enter/Space, or drop focus when a focused button becomes disabled.
import test from "node:test";
import assert from "node:assert/strict";
import { startBrowser } from "./support/browser.mjs";
import { FOCUS, press } from "./support/keyboard.mjs";

const env = await startBrowser();
const skip = env.skip ?? false;
if (skip) console.log(`# browser keyboard tests skipped: ${skip}`);
test.after(async () => {
  if (!skip) await env.close();
});

const focus = () => env.page.evaluate(FOCUS);
const evaluate = (expression) => env.page.evaluate(expression);
const wait = (ms) => evaluate(`new Promise((r) => setTimeout(r, ${ms}))`);

/// Focus is on something, painted with a ring, on screen.
async function assertVisibleFocus(what) {
  const now = await focus();
  assert.equal(now.lost, false, `${what}: focus fell to the page`);
  assert.ok(now.ring, `${what}: no focus ring on ${now.text}`);
  assert.ok(now.onScreen, `${what}: focused ${now.text} is off screen`);
  return now;
}

async function open(query = "scenario=live&sessions=mixed") {
  await env.page.size(1280, 680);
  await env.open(`/review/shell.html?${query}`);
}

test(
  "Tab walks the shell in order, one stop per tab list, every stop visibly focused",
  { skip },
  async () => {
    await open();
    await evaluate("document.activeElement?.blur()");
    const stops = [];
    for (let index = 0; index < 8; index += 1) {
      await press(env.page, "Tab");
      stops.push((await assertVisibleFocus(`stop ${index + 1}`)).text);
    }
    assert.deepEqual(stops, [
      'button "Home"',
      'button "Live"',
      'button "Sessions"',
      'button "Diagnostics"',
      'button "Settings"',
      'button "Status: Live"',
      'button[tab] "Overview"',
      stops[7], // the Live tab panel, named by its content
    ]);
    assert.match(stops[7], /^div\[tabpanel\]/);
    // Shift+Tab retraces the same path.
    await press(env.page, "shift+Tab");
    assert.equal((await focus()).text, 'button[tab] "Overview"');
  },
);

test(
  "the status details open with Enter or Space and Escape returns focus",
  { skip },
  async () => {
    await open();
    const expanded = () =>
      evaluate(
        "document.querySelector('.state-pill').getAttribute('aria-expanded')",
      );
    await evaluate("document.querySelector('.state-pill').focus()");
    await press(env.page, "Enter");
    assert.equal(await expanded(), "true");
    await press(env.page, "Tab");
    assert.equal((await focus()).role, "group");
    await press(env.page, "Escape");
    assert.equal(await expanded(), "false");
    assert.equal((await focus()).text, 'button "Status: Live"');
    await press(env.page, " ");
    assert.equal(await expanded(), "true");
    // Moving on closes it; nothing traps focus.
    await press(env.page, "Tab");
    await press(env.page, "Tab");
    assert.equal(await expanded(), "false");
    await assertVisibleFocus("after leaving the details");
  },
);

test(
  "a section shortcut pressed inside a workspace never drops focus",
  { skip },
  async () => {
    await open();
    await press(env.page, "ctrl+3");
    await evaluate("document.querySelector('.segment').focus()");
    for (const [chord, title] of [
      ["ctrl+4", "Diagnostics"],
      ["ctrl+2", "Sessions"],
      ["ctrl+1", "Live"],
    ]) {
      // Focus something inside the open workspace first.
      await evaluate(
        "document.querySelector('.workspace-view button, .workspace-view [tabindex=\"0\"]').focus()",
      );
      await press(env.page, chord);
      const now = await focus();
      assert.equal(now.lost, false, `${chord}: focus fell to the page`);
      assert.equal(now.text, `h1 "${title}"`, chord);
    }
  },
);

test(
  "a button that is busy keeps keyboard focus until its action completes",
  { skip },
  async () => {
    await open();
    // Hold the save for a moment, as a real disk write would.
    await evaluate(`(() => {
      const internals = window.__TAURI_INTERNALS__;
      const invoke = internals.invoke.bind(internals);
      internals.invoke = async (command, args) => {
        if (command === "set_storage_budget") {
          await new Promise((resolve) => setTimeout(resolve, 400));
        }
        return invoke(command, args);
      };
    })()`);
    await press(env.page, "ctrl+3");
    await evaluate(
      "[...document.querySelectorAll('.segment')].find((b) => b.getAttribute('aria-pressed') !== 'true').focus()",
    );
    const chosen = (await focus()).name;
    await press(env.page, "Enter");
    const during = await focus();
    assert.equal(during.lost, false, "focus fell to the page while saving");
    assert.equal(
      await evaluate("document.activeElement.getAttribute('aria-disabled')"),
      "true",
    );
    // A second press while busy changes nothing.
    await press(env.page, "Enter");
    await wait(600);
    const after = await assertVisibleFocus("after saving");
    assert.equal(after.name, chosen);
    assert.equal(
      await evaluate("document.activeElement.getAttribute('aria-pressed')"),
      "true",
    );
  },
);

test(
  "Sessions: the history list, detail tabs and expandable rows all work from the keyboard",
  { skip },
  async () => {
    await open();
    await press(env.page, "ctrl+2");
    await wait(300);
    const selected = () =>
      evaluate(
        "document.querySelector('[role=option][aria-selected=true]')?.dataset.session",
      );
    const options = await evaluate(
      "[...document.querySelectorAll('[role=option]')].map((o) => o.dataset.session)",
    );
    await evaluate(
      "document.querySelector('[role=option][tabindex=\"0\"]').focus()",
    );
    await press(env.page, "Home");
    assert.equal(await selected(), options[0]);
    await press(env.page, "ArrowDown");
    assert.equal(await selected(), options[1]);
    await press(env.page, "End");
    assert.equal(await selected(), options.at(-1));
    await assertVisibleFocus("last history row");
    await press(env.page, "ArrowUp");
    assert.equal(await selected(), options.at(-2));
    // Selection and focus move together, and the row stays in view.
    assert.equal(
      await evaluate("document.activeElement.dataset.session"),
      options.at(-2),
    );
    await assertVisibleFocus("history row");

    await press(env.page, "Home");
    await press(env.page, "Tab");
    assert.equal((await focus()).text, 'button[tab] "Summary"');
    await press(env.page, "ArrowRight");
    assert.match((await focus()).text, /^button\[tab\] "Events/);
    await press(env.page, "End");
    assert.equal((await focus()).text, 'button[tab] "Data"');
    await press(env.page, "Home");
    assert.equal((await focus()).text, 'button[tab] "Summary"');

    await evaluate("document.querySelector('#session-tab-events').click()");
    await wait(200);
    await evaluate("document.querySelector('.row-toggle').focus()");
    const expanded = () =>
      evaluate("document.activeElement.getAttribute('aria-expanded')");
    await press(env.page, "Enter");
    assert.equal(await expanded(), "true");
    await press(env.page, " ");
    assert.equal(await expanded(), "false");
    await assertVisibleFocus("row toggle");
  },
);

test(
  "Settings and Diagnostics controls answer Enter, Space and the arrow keys",
  { skip },
  async () => {
    await open();
    await press(env.page, "ctrl+3");
    await evaluate(
      "[...document.querySelectorAll('button')].find((b) => /setup steps/.test(b.textContent)).focus()",
    );
    await press(env.page, "Enter");
    assert.equal(
      await evaluate("document.activeElement.getAttribute('aria-expanded')"),
      "true",
    );
    assert.ok(
      (await evaluate(
        "document.querySelectorAll('.settings-setup li').length",
      )) > 0,
    );
    await press(env.page, " ");
    assert.equal(
      await evaluate("document.activeElement.getAttribute('aria-expanded')"),
      "false",
    );

    await press(env.page, "ctrl+4");
    await evaluate(
      "document.querySelector('#diagnostics-tab-connection').focus()",
    );
    const tab = () =>
      evaluate(
        "document.querySelector('[aria-label=Diagnostics][role=tablist] [aria-selected=true]').textContent",
      );
    await press(env.page, "ArrowRight");
    assert.equal(await tab(), "Pipeline");
    await press(env.page, "End");
    assert.equal(await tab(), "Capture");
    await press(env.page, "ArrowRight");
    assert.equal(await tab(), "Connection");
    await press(env.page, "ArrowLeft");
    assert.equal(await tab(), "Capture");

    // Digits typed into the capture label stay digits.
    await evaluate("document.querySelector('.capture input').focus()");
    for (const key of ["q", "a", "1", "2"]) await press(env.page, key);
    assert.equal(await evaluate("document.activeElement.value"), "qa12");
    assert.equal(
      await evaluate(
        "document.querySelector('[aria-current=page]').textContent",
      ),
      "Diagnostics",
    );
    await press(env.page, "Tab");
    assert.equal((await focus()).text, 'button "Start Capture"');
  },
);

test(
  "F1 25 Live tabs: arrows, Home/End and 1-4, with visible focus",
  { skip },
  async () => {
    await open("scenario=f1-live&f1=driving");
    const selected = () =>
      evaluate(
        `document.querySelector("[role=tab][aria-selected=true]").textContent`,
      );
    // Reached by keyboard, as a user would: sidebar (5), status, tab list.
    await evaluate("document.activeElement?.blur()");
    for (let index = 0; index < 7; index += 1) await press(env.page, "Tab");
    assert.equal(
      (await assertVisibleFocus("F1 Overview tab")).text,
      'button[tab] "Overview"',
    );
    await press(env.page, "ArrowRight");
    assert.equal(await selected(), "Race");
    assert.equal((await assertVisibleFocus("Race")).text, 'button[tab] "Race"');
    await press(env.page, "End");
    assert.equal(await selected(), "Dynamics");
    await press(env.page, "Home");
    assert.equal(await selected(), "Overview");
    await press(env.page, "3");
    assert.equal(await selected(), "Tyres");
    assert.equal(
      (await assertVisibleFocus("Tyres")).text,
      'button[tab] "Tyres"',
    );
    await press(env.page, "Tab");
    assert.match((await assertVisibleFocus("panel")).text, /^div\[tabpanel\]/);
  },
);
