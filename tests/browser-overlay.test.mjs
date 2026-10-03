import test from "node:test";
import assert from "node:assert/strict";
import { startBrowser } from "./support/browser.mjs";
import { press } from "./support/keyboard.mjs";

const env = await startBrowser();
const skip = env.skip ?? false;
test.after(async () => {
  if (!skip) await env.close();
});
const evaluate = (expression) => env.page.evaluate(expression);
const wait = (ms) =>
  evaluate(`new Promise(resolve => setTimeout(resolve, ${ms}))`);
async function open(params = "") {
  // Existing browser helper waits on a main-shell h1. Navigate to shell first
  // to learn the live server origin, then the independent overlay entry.
  await env.open("/review/shell.html?scenario=f1-live");
  const origin = await evaluate("location.origin");
  await env.page.send("Page.navigate", {
    url: `${origin}/review/overlay.html?scenario=f1-live&${params}`,
  });
  for (let i = 0; i < 30; i++) {
    if (
      await evaluate(
        "document.readyState === 'complete' && !!document.querySelector('.telemetry-overlay')",
      ).catch(() => false)
    )
      break;
    await wait(100);
  }
  await wait(400);
}
const bounds = `(() => {
  const failures = [], root = document.querySelector('.telemetry-overlay');
  const box = root.getBoundingClientRect();
  if (document.scrollingElement.scrollWidth > innerWidth || document.scrollingElement.scrollHeight > innerHeight) failures.push('document scroll');
  if (box.right > innerWidth + 1 || box.bottom > innerHeight + 1) failures.push('overlay exceeds window');
  for (const el of root.querySelectorAll('dt,dd,header,p')) {
    const outer = el.getBoundingClientRect();
    if (outer.right > box.right + 1 || outer.bottom > box.bottom + 1) failures.push('element clipped: ' + el.textContent);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while(walker.nextNode()) {
      const range = document.createRange(); range.selectNodeContents(walker.currentNode);
      for (const r of range.getClientRects()) if(r.right > outer.right + 1 || r.bottom > box.bottom + 1) failures.push('text clipped: ' + el.textContent);
    }
  }
  return [...new Set(failures)];
})()`;

for (const [width, height, scale] of [
  [360, 210, 1],
  [440, 210, 1],
  [550, 263, 1.25],
  [660, 315, 1.5],
]) {
  test(
    `overlay ${width}x${height} scale ${scale}: R/N/8, DRS and long values fit`,
    { skip },
    async () => {
      await env.page.size(width, height);
      for (const gear of ["R", "N", "8"]) {
        await open(`f1=high-speed&gear=${gear}&scale=${scale}&drs=on&long=1`);
        assert.equal(
          await evaluate(
            "document.querySelector('.overlay-gear dd').textContent",
          ),
          gear,
        );
        assert.equal(
          await evaluate(
            "document.querySelector('.overlay-drs dd').textContent",
          ),
          "ON",
        );
        assert.equal(
          await evaluate(
            "document.querySelector('.overlay-rpm dd').textContent",
          ),
          "65535",
        );
        assert.deepEqual(await evaluate(bounds), []);
        assert.equal(
          await evaluate(
            "getComputedStyle(document.querySelector('.telemetry-overlay')).pointerEvents",
          ),
          "none",
        );
      }
    },
  );
}
test(
  "overlay stale text, family expiry, DRS OFF and fresh/braking golden values",
  { skip },
  async () => {
    await env.page.size(440, 210);
    await open("overlay=stale&f1=braking");
    assert.match(
      await evaluate("document.querySelector('header').textContent"),
      /Not updating/,
    );
    assert.equal(
      await evaluate("document.querySelector('.overlay-drs dd').textContent"),
      "OFF",
    );
    assert.equal(
      await evaluate(
        "document.querySelector('.overlay-speed').dataset.freshness",
      ),
      "stale",
    );
    assert.deepEqual(await evaluate(bounds), []);
    await open("overlay=unavailable");
    assert.equal(
      await evaluate("document.querySelector('.telemetry-overlay').hidden"),
      true,
    );
    await open("overlay=unavailable&edit=1");
    assert.match(
      await evaluate("document.querySelector('header').textContent"),
      /EDITING/,
    );
    assert.equal(
      await evaluate("document.querySelector('.overlay-speed dd').textContent"),
      "—km/h",
    );
    assert.deepEqual(await evaluate(bounds), []);
  },
);
test(
  "separate webview makes only bounded latest reads and has no gameplay focus targets",
  { skip },
  async () => {
    await open();
    await evaluate(
      "for(const key in window.__overlayCalls) delete window.__overlayCalls[key]",
    );
    await wait(650);
    const calls = await evaluate("window.__overlayCalls");
    assert.deepEqual(Object.keys(calls), ["get_overlay_frame"]);
    assert.ok(calls.get_overlay_frame >= 4 && calls.get_overlay_frame <= 8);
    assert.equal(
      await evaluate(
        "document.querySelectorAll('button,input,select,[tabindex]').length",
      ),
      0,
    );
    assert.equal(
      await evaluate(
        "!!document.querySelector('.app-shell,.sessions-workspace,.settings-workspace')",
      ),
      false,
    );
  },
);
test(
  "main Settings trusted keyboard enables/edits/scales/finishes, telemetry never fans out",
  { skip },
  async () => {
    await env.page.size(960, 640);
    await env.open("/review/shell.html?scenario=f1-live");
    await evaluate(
      "[...document.querySelectorAll('.sidebar-item')].find(b=>b.textContent.includes('Settings')).click()",
    );
    await wait(400);
    await evaluate("document.querySelector('.overlay-enable input').focus()");
    await press(env.page, " ");
    await wait(100);
    assert.equal(
      await evaluate("document.querySelector('.overlay-enable input').checked"),
      true,
    );
    await evaluate(
      "[...document.querySelectorAll('.overlay-settings button')].find(b=>b.textContent==='Edit position').focus()",
    );
    await press(env.page, "Enter");
    await wait(150);
    assert.match(
      await evaluate("document.querySelector('.overlay-settings').textContent"),
      /Editing ·/,
    );
    await evaluate(
      "[...document.querySelectorAll('.overlay-settings button')].find(b=>b.textContent==='Move left').focus()",
    );
    await press(env.page, "Enter");
    await wait(100);
    await evaluate(
      "document.querySelector('.overlay-setting-controls select').focus()",
    );
    await press(env.page, "ArrowDown");
    await wait(100);
    assert.equal(
      await evaluate(
        "document.querySelector('.overlay-setting-controls select').value",
      ),
      "1.25",
    );
    await evaluate(
      "document.querySelectorAll('.overlay-setting-controls select')[1].focus()",
    );
    await press(env.page, "ArrowDown");
    await wait(100);
    assert.equal(
      await evaluate(
        "document.querySelectorAll('.overlay-setting-controls select')[1].value",
      ),
      "1",
    );
    await evaluate(
      "[...document.querySelectorAll('.overlay-settings button')].find(b=>b.textContent==='Finish editing').focus()",
    );
    await press(env.page, "Enter");
    await wait(100);
    assert.equal(
      await evaluate("document.querySelector('.overlay-position-controls')"),
      null,
    );
    await evaluate("window.__resetRenders()");
    await wait(650);
    const renders = await evaluate("window.__renders");
    assert.equal(renders.SettingsWorkspace ?? 0, 0);
    assert.equal(renders.OverlaySettings ?? 0, 0);
    assert.equal(
      await evaluate("window.__overlayCalls.get_overlay_frame ?? 0"),
      0,
    );
  },
);
