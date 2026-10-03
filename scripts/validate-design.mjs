// Real-browser visual review of production components through the dev-only
// review backend. Fixtures are layout evidence, never claimed as a live game.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startBrowser } from "../tests/support/browser.mjs";
import { press } from "../tests/support/keyboard.mjs";

const integration = process.argv.includes("--integration");
const output = process.argv
  .find((arg) => arg.startsWith("--output="))
  ?.slice(9);
const directory = output
  ? pathToFileURL(resolve(output) + "/")
  : new URL(
      integration
        ? "../docs/design/integration/"
        : "../docs/design/validation/",
      import.meta.url,
    );
await fs.mkdir(directory, { recursive: true });
const env = await startBrowser();
if (env.skip) throw new Error(env.skip);
const results = [];
const screens = [
  { name: "home", scenario: "waiting", section: "Home" },
  { name: "generic-live", scenario: "waiting", section: "Live" },
  { name: "fh6-live", scenario: "live", section: "Live" },
  { name: "f1-live", scenario: "f1-live&f1=driving", section: "Live" },
  { name: "sessions", scenario: "idle", section: "Sessions" },
  { name: "analysis", scenario: "idle", section: "Sessions", analysis: true },
  { name: "settings", scenario: "idle", section: "Settings" },
  { name: "diagnostics", scenario: "live", section: "Diagnostics" },
  {
    name: "f1-diagnostics",
    scenario: "f1-live&evidence=1",
    section: "Diagnostics",
    tab: "F1 25",
  },
];
if (integration) {
  for (const tab of ["Summary", "Laps", "Events", "Data"]) {
    screens.push({
      name: `f1-session-${tab.toLowerCase()}`,
      scenario: "idle",
      section: "Sessions",
      sessionMode: "multi-game",
      f1Session: true,
      tab,
    });
  }
  screens.push(
    {
      name: "f1-empty-laps",
      scenario: "idle",
      section: "Sessions",
      sessionMode: "f1-empty",
      f1Session: true,
      tab: "Laps",
    },
    {
      name: "f1-long-session",
      scenario: "idle",
      section: "Sessions",
      sessionMode: "f1-long",
      f1Session: true,
    },
    {
      name: "f1-recording-session",
      scenario: "f1-recording",
      section: "Sessions",
      f1Session: true,
    },
    {
      name: "fh6-recording-f1-live",
      scenario: "fh6-recording-f1-live",
      section: "Live",
    },
  );
  for (const phase of [
    "recording",
    "grace",
    "ending",
    "candidate",
    "disabled",
    "error",
  ]) {
    screens.push({
      name: `f1-recorder-${phase}`,
      scenario: `f1-recording&f1recorder=${phase}`,
      section: "Live",
    });
  }
}
try {
  await env.page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.designErrors = [];
      const previous = console.error;
      console.error = (...args) => { window.designErrors.push(args.map(String).join(' ')); previous(...args); };
      window.addEventListener('error', event => window.designErrors.push(event.message));
      window.addEventListener('unhandledrejection', event => window.designErrors.push(String(event.reason)));`,
  });
  for (const [width, height] of [
    [960, 640],
    [1280, 720],
    [1920, 1080],
  ]) {
    await env.page.size(width, height);
    for (const screen of screens) {
      await env.open(
        `/review/shell.html?scenario=${screen.scenario}&sessions=${screen.sessionMode ?? "mixed"}`,
      );
      await env.page.evaluate(`(async () => {
        [...document.querySelectorAll('.sidebar-item')].find(e => e.textContent.includes(${JSON.stringify(screen.section)})).click();
        await new Promise(r => setTimeout(r, 650));
        await document.fonts.ready;
      })()`);
      if (screen.f1Session) {
        await env.page.evaluate(
          `document.querySelector('[role=option][data-game="f1_25"]').click()`,
        );
        await env.page.evaluate("new Promise(r=>setTimeout(r,300))");
        assert.equal(
          await env.page.evaluate(
            "document.querySelector('.sessions-detail').dataset.game",
          ),
          "f1_25",
        );
        await env.page.evaluate(
          "document.querySelector('.sessions-detail').scrollIntoView({block:'start'})",
        );
      }
      if (screen.tab) {
        await env.page.evaluate(
          `[...document.querySelectorAll('[role=tab]')].find(e => e.textContent.includes(${JSON.stringify(screen.tab)})).click()`,
        );
        await env.page.evaluate("new Promise(r=>setTimeout(r,250))");
      }
      if (screen.analysis) {
        await env.page.evaluate(
          "document.querySelector('.timeline').scrollIntoView({block:'center'})",
        );
        await env.page.evaluate(
          "document.querySelector('#session-time-cursor').focus()",
        );
        await press(env.page, "End");
        const cursor = await env.page.evaluate(`(() => {
          const range = document.querySelector('#session-time-cursor');
          const line = document.querySelector('.shared-cursor');
          const tracks = [...document.querySelectorAll('.timeline-track')].map(e => e.getBoundingClientRect());
          return { count: document.querySelectorAll('.shared-cursor').length, lanes: tracks.length,
            value: range.value, max: range.max, left: line.style.left,
            lineRight: line.getBoundingClientRect().left, trackRight: tracks[0].right,
            spans: tracks.every(r => line.getBoundingClientRect().top <= r.top && line.getBoundingClientRect().bottom >= r.bottom),
            inspector: document.querySelector('.timeline-inspector').textContent };
        })()`);
        assert.equal(cursor.count, 1);
        assert.equal(cursor.value, cursor.max);
        assert.equal(cursor.left, "100%");
        assert.ok(cursor.lanes >= 4);
        assert.ok(cursor.spans, "one cursor must span every evidence lane");
        assert.ok(
          Math.abs(cursor.lineRight - cursor.trackRight) <= 1,
          "cursor and lanes share the same end",
        );
        await press(env.page, "Home");
        await press(env.page, "ArrowRight");
        assert.equal(
          await env.page.evaluate(
            "document.querySelector('#session-time-cursor').value",
          ),
          "1",
        );
        await env.page
          .evaluate(`(() => { const range=document.querySelector('#session-time-cursor');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(range,Number(range.max)*0.45); range.dispatchEvent(new Event('input',{bubbles:true}));
          range.dispatchEvent(new Event('change',{bubbles:true})); })()`);
        await env.page.evaluate("new Promise(r=>setTimeout(r,100))");
      }
      const facts = await env.page.evaluate(`(() => {
        const root=document.scrollingElement;
        const hero=document.querySelector('.drive-speed .readout-value');
        return { width:innerWidth, height:innerHeight, documentWidth:root.scrollWidth,
          documentHeight:root.scrollHeight, errors:window.designErrors,
          font:getComputedStyle(document.body).fontFamily,
          heroSize:hero ? parseFloat(getComputedStyle(hero).fontSize) : null,
          logo:document.querySelector('.sidebar .app-mark path')?.getAttribute('d') };
      })()`);
      assert.equal(
        facts.documentWidth,
        width,
        `${screen.name}: horizontal overflow`,
      );
      assert.equal(
        facts.documentHeight,
        height,
        `${screen.name}: document overflow`,
      );
      assert.deepEqual(facts.errors, [], `${screen.name}: console errors`);
      assert.match(facts.font, /Geist/);
      assert.equal(facts.logo, "M1 4H14V12H8V9H1Z");
      if (screen.f1Session) {
        const overflow = await env.page
          .evaluate(`(() => { const panel=document.querySelector('.sessions-detail'); const right=panel.getBoundingClientRect().right;
          return [...panel.querySelectorAll('.data-table,.inline-alert')].filter(e=>e.getBoundingClientRect().right>right+1).map(e=>e.className); })()`);
        assert.deepEqual(
          overflow,
          [],
          `${screen.name}: clipped session evidence`,
        );
      }
      if (screen.name === "fh6-live" || screen.name === "f1-live")
        assert.ok(facts.heroSize >= 56);
      const capture = await env.page.send("Page.captureScreenshot", {
        format: "png",
      });
      const filename = `${screen.name}-${width}x${height}.png`;
      await fs.writeFile(
        new URL(filename, directory),
        Buffer.from(capture.data, "base64"),
      );
      results.push({ screen: screen.name, filename, ...facts });
      console.log(`Verified ${filename}`);
    }
  }
  await fs.writeFile(
    new URL("results.json", directory),
    JSON.stringify(results, null, 2),
  );
  console.log(
    `${results.length} screenshots verified; shared cursor and keyboard checks passed.`,
  );
} finally {
  await env.close();
}
