// v2.1 Telemetry Lab: real-browser review captures through the DEV-ONLY
// review backend. The laps are SYNTHETIC (review/lab-fixtures.ts) and every
// capture shows the on-screen "SYNTHETIC REVIEW DATA" badge; these are layout
// evidence, never a recorded session.
//
//   node scripts/capture-lab.mjs [--output=DIRECTORY]
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startBrowser } from "../tests/support/browser.mjs";

const output = process.argv
  .find((arg) => arg.startsWith("--output="))
  ?.slice(9);
const directory = output
  ? pathToFileURL(resolve(output) + "/")
  : new URL("../docs/design/v2.1-lab/", import.meta.url);
await fs.mkdir(directory, { recursive: true });

const env = await startBrowser();
if (env.skip) throw new Error(env.skip);
const wait = (ms) =>
  env.page.evaluate(`new Promise(r => setTimeout(r, ${ms}))`);
const results = [];

async function until(expression, what) {
  for (let i = 0; i < 100; i += 1) {
    if (await env.page.evaluate(expression)) return;
    await wait(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function capture(name, width, height) {
  const shot = await env.page.send("Page.captureScreenshot", { format: "png" });
  const filename = `${name}-${width}x${height}.png`;
  await fs.writeFile(
    new URL(filename, directory),
    Buffer.from(shot.data, "base64"),
  );
  return filename;
}

try {
  await env.page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.labErrors = [];
      const previous = console.error;
      console.error = (...args) => { window.labErrors.push(args.map(String).join(' ')); previous(...args); };
      window.addEventListener('error', e => window.labErrors.push(e.message));
      window.addEventListener('unhandledrejection', e => window.labErrors.push(String(e.reason)));`,
  });
  for (const [width, height] of [
    [1920, 1080],
    [1280, 720],
    [960, 640],
  ]) {
    await env.page.size(width, height);
    await env.open("/review/shell.html?scenario=idle&sessions=multi-game");
    await env.page.evaluate(`(async () => {
      [...document.querySelectorAll('.sidebar-item')].find(e => e.textContent.includes('Sessions')).click();
      await new Promise(r => setTimeout(r, 500));
      document.querySelector('[role=option][data-game="f1_25"]').click();
      await document.fonts.ready;
    })()`);
    await until(
      "!!document.querySelector('.session-lab-open')",
      "the Open in Telemetry Lab button",
    );
    const entry = await capture("sessions-f1-entry", width, height);

    await env.page.evaluate(
      "document.querySelector('.session-lab-open').click()",
    );
    await until(
      "(document.querySelector('.lab-series.slot-current')?.getAttribute('d') ?? '').length > 100 && (document.querySelector('.lab-series.slot-reference')?.getAttribute('d') ?? '').length > 100",
      "both lap traces",
    );
    // Put the shared cursor 37% into the lap, as a person would by hovering.
    await env.page.evaluate(`(() => {
      const plot = document.querySelector('.chart-speed .lab-plot');
      const box = plot.getBoundingClientRect();
      plot.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true, clientX: box.left + box.width * 0.37, clientY: box.top + box.height / 2,
      }));
    })()`);
    await wait(250);
    const facts = await env.page.evaluate(`(() => {
      const rect = (selector) => {
        const box = document.querySelector(selector)?.getBoundingClientRect();
        return box ? { left: Math.round(box.left), width: Math.round(box.width), height: Math.round(box.height) } : null;
      };
      const root = document.scrollingElement;
      return {
        errors: window.labErrors,
        documentWidth: root.scrollWidth,
        rail: getComputedStyle(document.querySelector('.app-shell')).gridTemplateColumns,
        synthetic: !!document.getElementById('review-synthetic-badge'),
        session: rect('.lab-session'),
        center: rect('.lab-center'),
        compare: rect('.lab-compare'),
        viewport: rect('.lab-viewport'),
        speed: document.querySelector('.lab-gauge-speed')?.textContent,
        cursor: document.querySelector('.lab-controls-time')?.textContent,
        title: document.activeElement?.id ?? null,
      };
    })()`);
    assert.deepEqual(facts.errors, [], `${width}: console errors`);
    assert.equal(facts.documentWidth, width, `${width}: horizontal overflow`);
    assert.ok(facts.synthetic, `${width}: synthetic badge missing`);
    assert.ok(facts.rail.startsWith("56px"), `${width}: sidebar not folded`);
    assert.notEqual(facts.speed, "—", `${width}: gauge has no reading`);
    const lab = await capture("telemetry-lab", width, height);
    results.push({ width, height, entry, lab, ...facts });
    console.log(`Captured ${lab}`, JSON.stringify(facts));
  }
  await fs.writeFile(
    new URL("results.json", directory),
    JSON.stringify(results, null, 2) + "\n",
  );
} finally {
  await env.close();
}
