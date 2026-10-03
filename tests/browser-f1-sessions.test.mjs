// Phase D Sessions acceptance in installed Chromium: real layout, trusted
// keyboard input, recorder ownership and render isolation. No game needed.
import test from "node:test";
import assert from "node:assert/strict";
import { startBrowser } from "./support/browser.mjs";
import { FOCUS, press } from "./support/keyboard.mjs";

const env = await startBrowser();
const skip = env.skip ?? false;
if (skip) console.log(`# F1 browser QA skipped: ${skip}`);
test.after(async () => {
  if (!skip) await env.close();
});
const sizes = [
  [960, 640],
  [1280, 680],
  [1366, 768],
  [1920, 1080],
];
const evaluate = (expression) => env.page.evaluate(expression);
const wait = () =>
  evaluate("new Promise((resolve) => setTimeout(resolve, 180))");

async function open(mode = "multi-game", scenario = "f1-recording") {
  await env.open(`/review/shell.html?scenario=${scenario}&sessions=${mode}`);
  await evaluate(
    "[...document.querySelectorAll('.sidebar-item')].find((button) => button.textContent.includes('Sessions')).click()",
  );
  await wait();
  await evaluate(
    "document.querySelector('[role=option][data-game=f1_25]').click()",
  );
  await wait();
  assert.equal(
    await evaluate("document.querySelector('.sessions-detail').dataset.game"),
    "f1_25",
  );
}
async function tab(id) {
  await evaluate(`document.getElementById('session-tab-${id}').click()`);
  await wait();
  assert.equal(
    await evaluate(
      "document.querySelector('[role=tab][aria-selected=true]').id",
    ),
    `session-tab-${id}`,
  );
}

const geometry = `(() => {
  const problems = [];
  const root = document.scrollingElement;
  if (root.scrollWidth > innerWidth) problems.push('horizontal document scroll');
  if (root.scrollHeight > innerHeight) problems.push('vertical document scroll');
  const detail = document.querySelector('.sessions-detail');
  if (detail.scrollWidth > detail.clientWidth + 1) problems.push('detail clipping');
  for (const element of detail.querySelectorAll('table, .fact, .session-header-main')) {
    const box = element.getBoundingClientRect();
    if (element.matches('table') && box.right > detail.getBoundingClientRect().right + 1) problems.push('table escapes detail');
    for (const child of element.querySelectorAll('*')) {
      if (child.closest('.visually-hidden')) continue;
      const inner = child.getBoundingClientRect();
      if (inner.width && (inner.left < box.left - 1 || inner.right > box.right + 1)) problems.push('child escapes ' + element.className);
    }
  }
  for (const cell of detail.querySelectorAll('td, th')) {
    const outer = cell.getBoundingClientRect();
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if (walker.currentNode.parentElement.closest('.visually-hidden')) continue;
      const range = document.createRange(); range.selectNodeContents(walker.currentNode);
      for (const rect of range.getClientRects()) {
        if (rect.width && (rect.left < outer.left - 1 || rect.right > outer.right + 1)) problems.push('text escapes cell ' + cell.textContent);
      }
    }
  }
  const master = document.querySelector('.sessions-master').getBoundingClientRect();
  const d = detail.getBoundingClientRect();
  if (master.right > d.left + 1 && master.bottom > d.top + 1) problems.push('master/detail overlap');
  const row = document.querySelector('[role=option][aria-selected=true]');
  if (row) {
    const r = row.getBoundingClientRect();
    const list = row.closest('.session-listbox').getBoundingClientRect();
    if (r.top < list.top - 1 || r.bottom > list.bottom + 1) problems.push('selected row clipped');
  }
  return [...new Set(problems)];
})()`;

for (const [width, height] of sizes) {
  test(
    `F1 Sessions ${width}x${height}: mixed list, filters, all tabs, long values and empty states`,
    { skip },
    async () => {
      await env.page.size(width, height);
      await open();
      assert.deepEqual(
        await evaluate(
          "[...new Set([...document.querySelectorAll('[role=option]')].map((row) => row.dataset.game))].sort()",
        ),
        ["f1_25", "fh6"],
      );
      assert.match(
        await evaluate("document.querySelector('.recording-row').textContent"),
        /Recording F1 25/,
      );
      assert.equal(
        await evaluate(
          "document.querySelector('.rec-indicator').textContent.trim()",
        ),
        "REC · F1 25",
      );
      for (const id of ["summary", "laps", "events", "data"]) {
        await tab(id);
        assert.deepEqual(await evaluate(geometry), [], id);
        assert.doesNotMatch(
          await evaluate(
            "document.querySelector('[role=tabpanel]').textContent",
          ),
          /NaN|undefined/,
        );
        if (id === "data") {
          assert.equal(
            await evaluate(
              "[...document.querySelectorAll('[role=tabpanel] dt')].find((item) => item.textContent === 'Status').nextElementSibling.textContent",
            ),
            "Recording",
          );
        }
      }
      for (const [label, game] of [
        ["Forza Horizon 6", "fh6"],
        ["F1 25", "f1_25"],
      ]) {
        await evaluate(
          `[...document.querySelectorAll('.session-game-filter button')].find((button) => button.textContent === ${JSON.stringify(label)}).click()`,
        );
        await wait();
        assert.deepEqual(
          await evaluate(
            "[...new Set([...document.querySelectorAll('[role=option]')].map((row) => row.dataset.game))]",
          ),
          [game],
        );
        assert.equal(
          await evaluate(
            "document.querySelector('[role=option][aria-selected=true]').dataset.game",
          ),
          game,
        );
        assert.equal(
          await evaluate(
            "document.querySelector('.sessions-detail').dataset.game ?? 'fh6'",
          ),
          game,
        );
      }
      await evaluate(
        "document.querySelector('.session-game-filter button').click()",
      );
      await wait();
      assert.equal(
        await evaluate(
          "document.querySelector('[role=option][aria-selected=true]').dataset.game",
        ),
        "f1_25",
      );
      for (const mode of ["f1-long", "f1-empty"]) {
        await open(mode);
        for (const id of ["summary", "laps", "events", "data"]) {
          await tab(id);
          assert.deepEqual(await evaluate(geometry), [], `${mode} ${id}`);
          if (mode === "f1-empty" && ["laps", "events"].includes(id))
            assert.match(
              await evaluate(
                "document.querySelector('[role=tabpanel]').textContent",
              ),
              /No .* recorded in this session/,
            );
        }
      }
      await env.open("/review/shell.html?scenario=f1-live&sessions=none");
      await evaluate(
        "[...document.querySelectorAll('.sidebar-item')].find((button) => button.textContent.includes('Sessions')).click()",
      );
      await wait();
      assert.match(
        await evaluate("document.querySelector('.sessions-empty').textContent"),
        /No sessions yet.*Forza Horizon 6 or F1 25/,
      );
      assert.equal(
        await evaluate("document.scrollingElement.scrollWidth <= innerWidth"),
        true,
      );
    },
  );

  test(
    `F1 Sessions ${width}x${height}: keyboard list, filters and tabs retain visible focus`,
    { skip },
    async () => {
      await env.page.size(width, height);
      await open();
      await evaluate(
        "document.querySelector('[role=option][aria-selected=true]').focus()",
      );
      for (const key of ["Home", "End", "ArrowUp", "ArrowDown"]) {
        await press(env.page, key);
        const focus = await evaluate(FOCUS);
        assert.equal(focus.role, "option");
        assert.equal(focus.ring, true);
        assert.equal(focus.onScreen, true);
        assert.equal(
          await evaluate(
            "document.activeElement.getAttribute('aria-selected')",
          ),
          "true",
        );
      }
      await evaluate(
        "[...document.querySelectorAll('.session-game-filter button')].find((button) => button.textContent === 'F1 25').focus()",
      );
      await press(env.page, "Enter");
      assert.equal((await evaluate(FOCUS)).ring, true);
      await press(env.page, "Tab");
      assert.equal((await evaluate(FOCUS)).role, "option");
      await press(env.page, "Tab");
      assert.equal((await evaluate(FOCUS)).role, "tab");
      for (const [key, id] of [
        ["Home", "summary"],
        ["ArrowRight", "laps"],
        ["ArrowRight", "events"],
        ["End", "data"],
        ["ArrowRight", "summary"],
      ]) {
        await press(env.page, key);
        assert.equal(
          await evaluate("document.activeElement.id"),
          `session-tab-${id}`,
        );
        const focus = await evaluate(FOCUS);
        assert.equal(focus.ring, true);
        assert.equal(focus.onScreen, true);
      }
    },
  );
}

test(
  "F1 Live never overrides FH6 recording ownership; F1 recorder ticks isolate renders",
  { skip },
  async () => {
    await env.page.size(1280, 680);
    await open("multi-game", "fh6-recording-f1-live");
    assert.equal(
      await evaluate("document.querySelector('.topbar-game').textContent"),
      "F1 25",
    );
    assert.equal(
      await evaluate(
        "document.querySelector('.rec-indicator').textContent.trim()",
      ),
      "REC · Forza Horizon 6",
    );
    assert.match(
      await evaluate("document.querySelector('.recording-row').textContent"),
      /Recording.*Vehicle 3421/,
    );
    await open();
    const result = await evaluate(`(async () => {
    const { f1RecorderStore } = await import('/src/state/stores.ts');
    const state = f1RecorderStore.get();
    // Hold the mock status stable: only these ten explicit duration updates
    // can account for row renders during the measurement.
    const invoke = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (command, args) => command === 'get_f1_recorder_status' ? Promise.resolve(state.status) : invoke(command, args);
    window.__resetRenders();
    for (let i = 1; i <= 10; i++) {
      f1RecorderStore.set({ ...state, status: { ...state.status, revision: state.status.revision + i, duration_ms: state.status.duration_ms + i * 1000 } });
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return { ...window.__renders };
  })()`);
    assert.equal(result.F1RecordingRow, 10);
    for (const name of [
      "App",
      "AppShell",
      "Sidebar",
      "TopBar",
      "SessionsWorkspace",
      "SessionList",
      "SessionDetail",
      "F1SessionDetail",
    ])
      assert.equal(result[name] ?? 0, 0, name);
  },
);
