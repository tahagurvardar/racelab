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

    // M3 replay in a real browser: every view must read the same cursor at
    // the same moment, and the cursor must move while playing.
    const SYNC = `(() => {
      const plots = [...document.querySelectorAll('.lab-plot')];
      const lines = [...document.querySelectorAll('.lab-cursor')].map(e => e.style.left);
      return {
        label: document.querySelector('.lab-controls .lab-tool')?.getAttribute('aria-label'),
        clock: document.querySelector('.lab-controls-time')?.textContent,
        cursors: [...new Set(plots.map(p => p.getAttribute('aria-valuetext')))],
        lines: [...new Set(lines)],
        hud: document.querySelector('.lab-hud-value:not(.is-unavailable)')?.textContent,
        gauges: [...document.querySelectorAll('.lab-gauge-speed')].map(e => e.textContent),
        errors: window.labErrors,
        now: performance.now(),
      };
    })()`;
    // "1:02.345 / …" -> milliseconds of lap time.
    const lapMs = (clock) => {
      const [minutes, rest] = clock.split(" / ")[0].split(":");
      return Number(minutes) * 60_000 + Math.round(Number(rest) * 1000);
    };
    await env.page.evaluate(
      "document.querySelector('.lab-controls .lab-tool').click()",
    );
    await wait(700);
    const first = await env.page.evaluate(SYNC);
    await wait(500);
    const second = await env.page.evaluate(SYNC);
    const playing = await capture("telemetry-lab-playing", width, height);
    await env.page.evaluate(
      "document.querySelector('.lab-controls .lab-tool').click()",
    );
    for (const sample of [first, second]) {
      assert.equal(sample.label, "Pause", `${width}: not playing`);
      // One cursor: every plot announces the same position, and every
      // cursor line sits at the same place.
      assert.equal(sample.cursors.length, 1, `${width}: plots disagree`);
      assert.equal(sample.lines.length, 1, `${width}: cursor lines disagree`);
      assert.equal(sample.hud, sample.cursors[0], `${width}: HUD disagrees`);
      assert.ok(
        sample.gauges.every((speed) => /^\d+$/.test(speed)),
        `${width}: a gauge has no reading while playing`,
      );
      assert.deepEqual(sample.errors, [], `${width}: errors while playing`);
    }
    assert.notEqual(first.clock, second.clock, `${width}: replay did not move`);
    // At 1x, lap time advances with the page's own clock. The displayed
    // clock is the last painted frame, so allow a few frames of skew.
    const lapAdvance = lapMs(second.clock) - lapMs(first.clock);
    const wallAdvance = second.now - first.now;
    assert.ok(
      Math.abs(lapAdvance - wallAdvance) <= 80,
      `${width}: 1x drifted: lap ${lapAdvance} ms over ${Math.round(wallAdvance)} ms`,
    );
    assert.notEqual(
      first.cursors[0],
      second.cursors[0],
      `${width}: cursor still`,
    );
    const replay = {
      first,
      second,
      lapAdvance,
      wallAdvance: Math.round(wallAdvance),
    };

    // M4 lap analysis: each lap's badges and the Lap data card, scrolled
    // into view, must fit their column without clipping.
    const lapData = await env.page.evaluate(`(() => {
      const card = document.querySelector('.lab-lapdata');
      card.scrollIntoView({ block: 'center' });
      const table = card.querySelector('.lab-lapdata-table');
      const session = document.querySelector('.lab-session');
      const box = card.getBoundingClientRect();
      const badges = [...document.querySelectorAll('.lab-lap-badges')];
      return {
        badges: badges.map(b => [...b.children].map(c => c.textContent)),
        badgesFit: badges.every(b => b.scrollWidth <= b.clientWidth + 1),
        // Each lap's badges sit under that lap's picker, one pill high.
        badgesPlaced: ['current', 'reference'].every(slot => {
          const picker = document.querySelector('.lab-lap-picker.slot-' + slot)?.getBoundingClientRect();
          const line = document.querySelector('.lab-lap-badges.slot-' + slot);
          if (!picker || !line) return false;
          const box = line.getBoundingClientRect();
          return Math.abs(box.left - picker.left) <= 1 && box.top >= picker.bottom - 1
            && [...line.children].every(c => c.getBoundingClientRect().height <= 24);
        }),
        // The table must end inside the card's padding, and the column must
        // not scroll sideways.
        tableFits: table.getBoundingClientRect().right <= box.right - parseFloat(getComputedStyle(card).paddingRight) + 1
          && session.scrollWidth <= session.clientWidth + 1,
        card: { left: Math.round(box.left), width: Math.round(box.width), height: Math.round(box.height) },
        findings: [...card.querySelectorAll('.lab-issues li')].map(li => li.textContent),
        delta: document.querySelector('.chart-delta .lab-plot-message span')?.textContent,
        documentWidth: document.scrollingElement.scrollWidth,
        errors: window.labErrors,
      };
    })()`);
    await wait(200);
    const lapdata = await capture("telemetry-lab-lapdata", width, height);
    await env.page.evaluate("document.scrollingElement.scrollTo(0, 0)");
    assert.equal(lapData.badges.length, 2, `${width}: lap badges missing`);
    assert.ok(lapData.badgesFit, `${width}: lap badges clipped`);
    assert.ok(lapData.badgesPlaced, `${width}: lap badges misplaced`);
    assert.ok(lapData.tableFits, `${width}: lap data table overflows`);
    assert.equal(lapData.documentWidth, width, `${width}: overflow (M4)`);
    assert.deepEqual(lapData.errors, [], `${width}: errors (M4)`);
    results.push({
      width,
      height,
      entry,
      lab,
      playing,
      lapdata,
      replay,
      lapData,
      ...facts,
    });
    console.log(`Captured ${lab}, ${playing}`, JSON.stringify(replay));
  }
  await fs.writeFile(
    new URL("results.json", directory),
    JSON.stringify(results, null, 2) + "\n",
  );
} finally {
  await env.close();
}
