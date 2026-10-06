// Capture released components through the existing DEV-ONLY review backend.
// Fixtures illustrate the interface; these are not live-game screenshots.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { startBrowser } from "../tests/support/browser.mjs";

const output = new URL("../docs/assets/screenshots/", import.meta.url);
await fs.mkdir(output, { recursive: true });
const browser = await startBrowser();
if (browser.skip) throw new Error(browser.skip);
const captures = [];
const scenes = [
  { name: "f1-telemetry", scenario: "f1-live&f1=driving", section: "Live" },
  { name: "session-history", scenario: "idle", section: "Sessions" },
  { name: "f1-lap-detail", scenario: "idle", section: "Sessions", tab: "Laps" },
  { name: "forza-telemetry", scenario: "live", section: "Live" },
];
try {
  await browser.page.size(1280, 720);
  await browser.page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `const NativeDate = Date;
      const portfolioNow = Date.parse('2026-10-07T12:00:00Z');
      window.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [portfolioNow])); }
        static now() { return portfolioNow; }
      };
      window.portfolioErrors = [];
      window.addEventListener('error', e => window.portfolioErrors.push(e.message));
      window.addEventListener('unhandledrejection', e => window.portfolioErrors.push(String(e.reason)));
      const original = console.error;
      console.error = (...args) => { window.portfolioErrors.push(args.map(String).join(' ')); original(...args); };`,
  });
  for (const scene of scenes) {
    await browser.open(
      `/review/shell.html?scenario=${scene.scenario}&sessions=multi-game`,
    );
    await browser.page.evaluate(`(async () => {
      [...document.querySelectorAll('.sidebar-item')].find(e => e.textContent.includes(${JSON.stringify(scene.section)})).click();
      await document.fonts.ready;
      await new Promise(r => setTimeout(r, 650));
    })()`);
    if (scene.tab) {
      await browser.page.evaluate(`(async () => {
        document.querySelector('[role=option][data-game="f1_25"]').click();
        await new Promise(r => setTimeout(r, 350));
        [...document.querySelectorAll('[role=tab]')].find(e => e.textContent.includes(${JSON.stringify(scene.tab)})).click();
        await new Promise(r => setTimeout(r, 250));
      })()`);
    }
    const evidence = await browser.page.evaluate(`({
      errors: window.portfolioErrors,
      overflow: document.documentElement.scrollWidth > innerWidth,
      text: document.body.innerText,
      heading: document.querySelector('.workspace-view h1')?.textContent
    })`);
    assert.deepEqual(evidence.errors, []);
    assert.equal(evidence.overflow, false);
    assert.match(evidence.text, /v2\.0\.0/);
    assert.doesNotMatch(evidence.text, /[A-Z]:[\\/]|@|token|password/i);
    const { data } = await browser.page.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    const bytes = Buffer.from(data, "base64");
    await fs.writeFile(new URL(`${scene.name}.png`, output), bytes);
    captures.push({
      file: `${scene.name}.png`,
      viewport: [1280, 720],
      scenario: scene.scenario,
      sessions: "multi-game",
      section: scene.section,
      tab: scene.tab ?? null,
      state: "existing review fixture",
      errors: [],
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    console.log(`Captured ${scene.name}: ${evidence.heading}`);
  }
  // The overlay is a standalone HUD fixture, not composited over a game.
  const origin = await browser.page.evaluate("location.origin");
  await browser.page.size(440, 210);
  await browser.page.send("Page.navigate", {
    url: `${origin}/review/overlay.html?scenario=f1-live&f1=driving`,
  });
  await browser.page.evaluate(`(async () => {
    for (let i = 0; i < 50; i++) {
      if (document.querySelector('.telemetry-overlay')) break;
      await new Promise(r => setTimeout(r, 100));
    }
    await document.fonts.ready;
    await new Promise(r => setTimeout(r, 500));
  })()`);
  assert.equal(
    await browser.page.evaluate(
      "!!document.querySelector('.telemetry-overlay')",
    ),
    true,
  );
  assert.deepEqual(await browser.page.evaluate("window.portfolioErrors"), []);
  const overlay = await browser.page.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const overlayBytes = Buffer.from(overlay.data, "base64");
  await fs.writeFile(new URL("f1-overlay.png", output), overlayBytes);
  captures.push({
    file: "f1-overlay.png",
    viewport: [440, 210],
    scenario: "f1-live&f1=driving",
    state: "standalone existing overlay review fixture",
    errors: [],
    sha256: createHash("sha256").update(overlayBytes).digest("hex"),
  });
  console.log("Captured standalone F1 overlay fixture");
  await fs.writeFile(
    new URL("capture-manifest.json", output),
    JSON.stringify(
      {
        applicationVersion: "2.0.0",
        harness: "review/shell.html",
        fixtureClock: "2026-10-07T12:00:00Z",
        captures,
        caveat:
          "Production components with existing review fixtures; no game was running. F1 live values replay checked-in decoded captures; sessions and Forza review values are illustrative fixtures.",
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await browser.close();
}
