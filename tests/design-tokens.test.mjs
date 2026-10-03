import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// V1.1 design-system hygiene. Colours, type sizes and every other design
// value live in `styles/tokens.css`; components and stylesheets use the names.

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const TOKENS = "styles/tokens.css";

function walk(relative = "") {
  const directory = path.join(SRC, relative);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const next = path.posix.join(relative, entry.name);
    return entry.isDirectory() ? walk(next) : [next];
  });
}

const read = (relative) => fs.readFileSync(path.join(SRC, relative), "utf8");
const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "");
const FILES = walk();
const CSS = FILES.filter((file) => file.endsWith(".css"));
const COMPONENTS = FILES.filter((file) => /\.tsx?$/.test(file));

test("the Geist license is included in the packaged public assets unchanged", () => {
  const source = read("assets/fonts/OFL.txt");
  const packaged = fs.readFileSync(
    new URL("../public/licenses/Geist-OFL.txt", import.meta.url),
    "utf8",
  );
  assert.equal(packaged, source);
  assert.match(packaged, /SIL OPEN FONT LICENSE Version 1\.1/);
});

test("the old single stylesheet is gone and the token file exists", () => {
  assert.ok(!FILES.includes("styles.css"));
  assert.ok(CSS.includes(TOKENS));
});

test("no raw colour appears outside the token file", () => {
  const colour = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
  for (const file of CSS.filter((name) => name !== TOKENS)) {
    const source = withoutComments(read(file));
    assert.ok(!colour.test(source), `${file} contains a raw colour`);
  }
  for (const file of COMPONENTS) {
    assert.ok(
      !/["'`]#[0-9a-fA-F]{3,8}["'`]/.test(read(file)),
      `${file} contains a raw colour literal`,
    );
  }
});

test("every font size comes from the type scale", () => {
  for (const file of CSS.filter((name) => name !== TOKENS)) {
    const sizes = [
      ...withoutComments(read(file)).matchAll(/font-size:\s*([^;]+);/g),
    ].map((match) => match[1].trim());
    for (const size of sizes) {
      assert.ok(
        /^var\(--type-[a-z]+\)$/.test(size) ||
          // Fluid between two type tokens, by window (vw) or workspace (cqi).
          /^clamp\(var\(--type-[a-z]+\), [\d.]+(vw|cqi), var\(--type-[a-z]+\)\)$/.test(
            size,
          ) ||
          /^[\d.]+em$/.test(size), // relative to a token-sized parent
        `${file}: font-size ${size} is not a token`,
      );
    }
  }
});

test("every custom property a stylesheet uses is defined", () => {
  const defined = new Set(
    CSS.flatMap((file) =>
      [...read(file).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((match) => match[1]),
    ),
  );
  for (const file of [...CSS, ...COMPONENTS]) {
    // A property with a fallback (`var(--columns, 4)`) is fed by a component
    // and need not be a token.
    for (const match of read(file).matchAll(/var\((--[a-z0-9-]+)\s*\)/g)) {
      assert.ok(defined.has(match[1]), `${file} uses undefined ${match[1]}`);
    }
  }
});

test("the shell uses no inline style for colour or type", () => {
  for (const file of COMPONENTS) {
    for (const match of read(file).matchAll(/style=\{\{([^}]*)\}\}/g)) {
      assert.ok(
        !/color|background|font/i.test(match[1]),
        `${file} styles colour or type inline`,
      );
    }
  }
});

test("reduced motion turns every duration off", () => {
  const tokens = read(TOKENS);
  const block = tokens.slice(tokens.indexOf("prefers-reduced-motion"));
  for (const name of ["--dur-1", "--dur-2", "--dur-3", "--dur-sample"]) {
    assert.ok(block.includes(`${name}: 0ms`), name);
  }
});

// --------------------------------------------------------------- contrast

function token(name) {
  const match = new RegExp(`${name}:[ \\t]*(#[0-9a-fA-F]{6})`).exec(
    read(TOKENS),
  );
  assert.ok(match, `${name} must be a 6-digit hex token`);
  return match[1];
}

/// WCAG 2.x relative luminance and contrast ratio.
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const channel = parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const SURFACES = ["--bg-app", "--bg-chrome", "--surface-1", "--surface-2"];

test("text tokens that carry content meet WCAG AA on every surface", () => {
  for (const text of ["--text", "--text-2", "--text-3", "--text-unavailable"]) {
    for (const surface of SURFACES) {
      const ratio = contrast(token(text), token(surface));
      assert.ok(
        ratio >= 4.5,
        `${text} on ${surface} is ${ratio.toFixed(2)}:1, below 4.5:1`,
      );
    }
  }
});

test("an unavailable reading is legible but quieter than a reading, and is not a disabled control", () => {
  const unavailable = token("--text-unavailable");
  assert.notEqual(unavailable, token("--text-disabled"));
  // Never dominant: dimmer than secondary text, which is dimmer than a value.
  assert.ok(luminance(unavailable) < luminance(token("--text-2")));
  // Disabled stays visibly distinct (and below text contrast on purpose).
  assert.ok(contrast(token("--text-disabled"), token("--surface-1")) < 4.5);
  // Every unavailable-value rule uses the unavailable token; the disabled
  // colour is used only by controls.
  const rules = {
    "styles/live.css": [
      ".readout.is-unavailable .readout-value",
      ".control-bar.is-unavailable .control-bar-value",
      ".axis-table td.is-unavailable",
    ],
    "styles/sessions.css": [
      ".fact.is-unavailable dd",
      ".count.is-unavailable dd",
      ".timeline-track-note",
    ],
  };
  for (const [file, selectors] of Object.entries(rules)) {
    const source = withoutComments(read(file));
    for (const selector of selectors) {
      const at = source.indexOf(`${selector} {`);
      assert.ok(at >= 0, `${file}: missing ${selector}`);
      const block = source.slice(at).split("}")[0];
      assert.match(block, /var\(--text-unavailable\)/, selector);
    }
  }
  for (const file of CSS.filter((name) => name !== TOKENS)) {
    const source = withoutComments(read(file));
    for (const match of source.matchAll(/([^{}]+)\{[^}]*--text-disabled/g)) {
      assert.match(
        match[1],
        /button|input|disabled/,
        `${file}: --text-disabled used outside a control: ${match[1].trim()}`,
      );
    }
  }
});

// ------------------------------------------------- V1.1 final contrast pass

test("primary, secondary and label text meet AA on hover, selected and popover surfaces too", () => {
  for (const text of ["--text", "--text-2", "--text-3"]) {
    for (const surface of ["--surface-3", "--overlay", "--accent-surface"]) {
      const ratio = contrast(token(text), token(surface));
      assert.ok(ratio >= 4.5, `${text} on ${surface} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test("warning and error text meet AA on their own surfaces and on panels", () => {
  const pairs = [
    ["--warn-text", "--warn-surface"],
    ["--warn-text", "--bg-chrome"],
    ["--warn-text", "--surface-1"],
    ["--warn-text", "--surface-2"],
    ["--warn-text", "--surface-3"],
    ["--bad-text", "--bad-surface"],
    ["--bad-text", "--surface-1"],
    ["--bad-text", "--surface-3"],
    // Detail text and the "Technical details" summary inside a notice.
    ["--text-2", "--warn-surface"],
    ["--text-3", "--warn-surface"],
    ["--text-2", "--bad-surface"],
    ["--text-3", "--bad-surface"],
    // Links, disclosure summaries and the primary button label.
    ["--accent", "--bg-app"],
    ["--accent", "--surface-1"],
    ["--text-on-accent", "--accent"],
    ["--text-on-accent", "--accent-strong"],
  ];
  for (const [text, surface] of pairs) {
    const ratio = contrast(token(text), token(surface));
    assert.ok(ratio >= 4.5, `${text} on ${surface} is ${ratio.toFixed(2)}:1`);
  }
});

test("focus, selection and state indicators meet 3:1 wherever they are drawn", () => {
  const indicators = [
    // The focus ring and the selected edge (nav item, tab, history row).
    ...[
      "--bg-app",
      "--bg-chrome",
      "--surface-1",
      "--surface-2",
      "--surface-3",
      "--warn-surface",
      "--bad-surface",
    ].map((surface) => ["--focus", surface]),
    ["--accent", "--surface-3"],
    // State dots and glyphs: always beside words, but legible as marks.
    ...[
      "--status-ok",
      "--status-warn",
      "--status-bad",
      "--status-neutral",
      "--rec",
    ].flatMap((status) =>
      ["--bg-chrome", "--surface-1"].map((surface) => [status, surface]),
    ),
    ["--status-warn", "--warn-surface"],
    ["--status-bad", "--bad-surface"],
    // Channel fills on their track.
    ["--ch-throttle", "--surface-2"],
    ["--ch-brake", "--surface-2"],
    ["--ch-neutral", "--surface-2"],
  ];
  for (const [mark, surface] of indicators) {
    const value = mark === "--focus" ? token("--accent") : token(mark);
    const ratio = contrast(value, token(surface));
    assert.ok(ratio >= 3, `${mark} on ${surface} is ${ratio.toFixed(2)}:1`);
  }
  assert.match(read(TOKENS), /--focus:\s*var\(--accent\)/);
});

test("an enabled text field has a 3:1 boundary against its panel", () => {
  const source = withoutComments(read("styles/base.css"));
  const block = source.slice(source.indexOf("\ninput {")).split("}")[0];
  const edge = /border-bottom-color:\s*var\((--[a-z0-9-]+)\)/.exec(block);
  assert.ok(edge, "input must draw a contrasting bottom edge");
  for (const surface of ["--surface-1", "--surface-2"]) {
    assert.ok(contrast(token(edge[1]), token(surface)) >= 3, surface);
  }
});

test("unavailable values are only painted on surfaces where they stay legible", () => {
  // --text-unavailable clears 4.5:1 on the app, chrome, panel and inset
  // surfaces (above) but not on hover/selected or popover surfaces. No rule
  // may put it on one of those.
  for (const file of CSS.filter((name) => name !== TOKENS)) {
    const source = withoutComments(read(file));
    for (const match of source.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      if (!match[2].includes("--text-unavailable")) continue;
      assert.ok(
        !/--surface-3|--overlay/.test(match[2]),
        `${file}: ${match[1].trim()} paints unavailable text on a hover/popover surface`,
      );
      assert.ok(
        !/:hover|is-selected|is-active|popover/.test(match[1]),
        `${file}: ${match[1].trim()}`,
      );
    }
  }
});

// ---------------------------------------------------------- reduced motion

test("every continuous animation stops under reduced motion", () => {
  const animated = new Set();
  const stopped = new Set();
  for (const file of CSS) {
    const source = withoutComments(read(file));
    const reduced = [
      ...source.matchAll(
        /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g,
      ),
    ]
      .map((match) => match[1])
      .join("\n");
    for (const match of source.matchAll(
      /([^{}]+)\{[^}]*animation:[^;]*infinite/g,
    )) {
      for (const selector of match[1].split(",")) animated.add(selector.trim());
    }
    for (const match of reduced.matchAll(
      /([^{}]+)\{[^}]*(animation:\s*none|display:\s*none)/g,
    )) {
      for (const selector of match[1].split(",")) stopped.add(selector.trim());
    }
  }
  assert.ok(
    animated.size >= 1,
    "expected the indeterminate analysis progress animation",
  );
  // The approved calm shell has solid REC and connection indicators.
  assert.ok(!animated.has(".sidebar-indicator.is-rec"));
  assert.ok(!animated.has(".rec-indicator.is-recording .rec-dot"));
  assert.ok(!animated.has('.topbar[data-state="live"] .state-dot::after'));
  for (const selector of animated) {
    const covered =
      stopped.has(selector) ||
      // A hidden ancestor stops its children's animation too.
      [...stopped].some((parent) => selector.startsWith(`${parent} `));
    assert.ok(covered, `${selector} keeps animating under reduced motion`);
  }
});

test("finite transitions and entries are timed by tokens that reduced motion zeroes", () => {
  for (const file of CSS.filter((name) => name !== TOKENS)) {
    const source = withoutComments(read(file));
    for (const match of source.matchAll(/(transition|animation):([^;]+);/g)) {
      if (match[2].includes("infinite") || match[2].trim() === "none") continue;
      assert.match(
        match[2],
        /var\(--dur-(1|2|3|sample)\)/,
        `${file}: ${match[0].trim()} is not token-timed`,
      );
    }
  }
});
