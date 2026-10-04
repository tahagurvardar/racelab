import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/// Repository root, derived from this file rather than from `process.cwd()`,
/// so the suite gives the same answer whatever directory it is run from.
const ROOT = fileURLToPath(new URL("..", import.meta.url));

const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");
const json = (...parts) => JSON.parse(read(...parts));

const PACKAGE = json("package.json");
const TAURI = json("src-tauri", "tauri.conf.json");
const CARGO = read("src-tauri", "Cargo.toml");

// ------------------------------------------------------------- versioning

/// One version, in three files that cannot be changed together automatically.
/// A packaged build whose installer, executable metadata and frontend disagree
/// is unsupportable, and the disagreement is invisible until a user reports it.
test("the application version is identical in every file that declares one", () => {
  const cargoVersion = /^version = "([^"]+)"/m.exec(CARGO)?.[1];
  assert.equal(PACKAGE.version, TAURI.version);
  assert.equal(PACKAGE.version, cargoVersion);
});

test("the stable release version is 2.0.0", () => {
  // Deliberate release decision after F1 25 and Overlay live-game acceptance.
  assert.equal(PACKAGE.version, "2.0.0");
});

// --------------------------------------------------------------- packaging

test("the version shown in the window matches the version that was built", () => {
  // The version a user sees is a literal in `app-version.ts`. It is the one
  // copy most easily forgotten when the other three files are bumped together.
  const version = read("src", "app-version.ts");
  assert.ok(
    version.includes(`APP_VERSION = "${PACKAGE.version}"`),
    `app-version.ts must declare ${PACKAGE.version}`,
  );
  // And it is actually on screen: the brand renders it, and the sidebar
  // renders the brand's version label.
  const brand = read("src", "components", "brand", "Brand.tsx");
  assert.ok(brand.includes("{APP_VERSION}"));
  const sidebar = read("src", "components", "shell", "Sidebar.tsx");
  assert.ok(sidebar.includes("<VersionLabel />"));
});

test("a Windows installer is actually produced", () => {
  assert.equal(TAURI.bundle.active, true);
  assert.ok(TAURI.bundle.targets.includes("nsis"));
});

test("the installer does not require administrator privileges", () => {
  // A per-user NSIS install writes under the user's own profile. A per-machine
  // installer would prompt for elevation, which a telemetry viewer has no
  // business asking for.
  assert.equal(TAURI.bundle.windows.nsis.installMode, "currentUser");
});

test("identity and publisher metadata are set for the executable and installer", () => {
  assert.equal(TAURI.productName, "RaceLab");
  assert.equal(TAURI.identifier, "com.tahagurvardar.racelab");
  assert.ok(TAURI.bundle.publisher?.length > 0);
  assert.ok(TAURI.bundle.copyright?.length > 0);
  assert.ok(TAURI.bundle.shortDescription?.length > 0);
});

test("every bundled icon exists on disk", () => {
  assert.ok(TAURI.bundle.icon.length > 0);
  for (const icon of TAURI.bundle.icon) {
    assert.ok(
      existsSync(join(ROOT, "src-tauri", icon)),
      `missing bundle icon ${icon}`,
    );
  }
});

test("Windows installer and uninstaller use the approved application ICO", () => {
  const nsis = TAURI.bundle.windows.nsis;
  assert.equal(nsis.installerIcon, "icons/icon.ico");
  assert.equal(nsis.uninstallerIcon, nsis.installerIcon);
  assert.ok(TAURI.bundle.icon.includes(nsis.installerIcon));
});

test("the brand is final: one mark, and the packaged icons share its geometry", () => {
  const brand = read("src", "components", "brand", "Brand.tsx");
  // No direction switch is left in the product.
  assert.ok(
    !existsSync(
      join(ROOT, "src", "components", "brand", "brand-directions.ts"),
    ),
  );
  assert.ok(!/direction|ACTIVE_BRAND/.test(brand));
  const svg = read("src-tauri", "icons", "icon.svg");
  const master = "M0 15H80V65H44V49H0Z";
  assert.ok(brand.includes(master));
  assert.ok(svg.includes(`d="${master}"`));
  assert.equal((svg.match(/<path /g) ?? []).length, 1);
  const optical = {
    16: "M1 4H14V12H8V9H1Z",
    20: "M2 6H18V16H11V13H2Z",
    24: "M2 7H21V19H12V15H2Z",
    32: "M3 9H27V24H16V19H3Z",
  };
  for (const [size, path] of Object.entries(optical)) {
    assert.ok(brand.includes(`"${path}"`));
    const icon = read("src-tauri", "icons", `mark-${size}.svg`);
    assert.ok(icon.includes(`d="${path}"`));
    assert.ok(icon.includes('shape-rendering="crispEdges"'));
  }
  assert.equal(
    read("public", "favicon.svg"),
    read("src-tauri", "icons", "mark-16.svg"),
  );
  assert.ok(read("index.html").includes('href="/favicon.svg"'));
  assert.ok(!brand.includes("fill={mono"));
  assert.ok(!brand.includes("var(--accent)"));
  assert.ok(!brand.includes("M4.5 19.5"));
  // No gradient anywhere in the mark or the icon.
  assert.ok(!/<(linear|radial)Gradient|gradient\(/i.test(brand + svg));
  // The installer, executable and window icon are the generated ones: the
  // .ico carries a 16 px layer for the title bar.
  const ico = readFileSync(join(ROOT, "src-tauri", "icons", "icon.ico"));
  const layers = ico.readUInt16LE(4);
  const sizes = Array.from(
    { length: layers },
    (_, index) => ico[6 + index * 16] || 256,
  );
  assert.ok(sizes.includes(16) && sizes.includes(32), `ico layers ${sizes}`);
});

test("a release build opens no console window", () => {
  // Without this attribute a packaged Windows build shows a console behind the
  // application window. The `not(debug_assertions)` guard keeps `tauri dev`
  // printing.
  assert.match(
    read("src-tauri", "src", "main.rs"),
    /#!\[cfg_attr\(not\(debug_assertions\), windows_subsystem = "windows"\)\]/,
  );
});

test("a fatal startup error is shown to the user instead of vanishing", () => {
  // A GUI-subsystem build has no console, so the one path that can fail before
  // the window exists must reach a native message box rather than a panic that
  // prints to nobody.
  const lib = read("src-tauri", "src", "lib.rs");
  assert.ok(
    lib.includes("startup_error::report(&error.to_string())"),
    "the fatal build failure must be reported to the user",
  );
  // Built from Display, never Debug: `{error:?}` would put a struct dump in a
  // dialog.
  assert.ok(!/startup_error::report\([^)]*:\?\}/.test(lib));
});

test("the startup dialog is confined to the fatal startup path", () => {
  // Normal startup, and every background or runtime failure, must keep using
  // the connection, recorder, analysis and storage states that already exist.
  // A modal that could appear while the application is running would be a new
  // and much worse failure mode than the one this fixes.
  // Only lib.rs reports, and only from its two fatal startup paths: the setup
  // hook (which Tauri panics on rather than returning) and the `build()` error
  // arm (for failures that do come back).
  for (const file of rustSources()) {
    const name = relative(ROOT, file).replace(/\\/g, "/");
    if (name.endsWith("src/startup_error.rs")) continue;
    const calls = (
      readFileSync(file, "utf8").match(/startup_error::report/g) ?? []
    ).length;
    const expected = name.endsWith("src/lib.rs") ? 2 : 0;
    assert.equal(
      calls,
      expected,
      `${name} must call startup_error::report ${expected} time(s)`,
    );
  }

  // Both calls precede the event loop. A report after `app.run(` would be a
  // modal raised while RaceLab is running, which is the failure mode this
  // whole design avoids.
  const lib = read("src-tauri", "src", "lib.rs");
  const eventLoop = lib.indexOf("app.run(");
  assert.ok(eventLoop > -1, "lib.rs must start an event loop");
  for (const match of lib.matchAll(/startup_error::report/g)) {
    assert.ok(
      match.index < eventLoop,
      "startup_error::report must never be reachable once the app is running",
    );
  }
});

test("the startup dialog adds no dependency", () => {
  // `MessageBoxW` comes from user32, which every Windows GUI binary already
  // links. A dialog plugin could not help here anyway: this has to work when
  // the application failed to build.
  const cargo = read("src-tauri", "Cargo.toml");
  assert.ok(!/tauri-plugin-dialog/.test(cargo));
  assert.ok(!/^windows\s*=/m.test(cargo));
  assert.ok(
    read("src-tauri", "src", "startup_error.rs").includes('name = "user32"'),
  );
});

test("the packaged build serves the built frontend, never a development server", () => {
  // `devUrl` is used only by `tauri dev`. What matters is that the production
  // build is pointed at built files on disk.
  assert.equal(TAURI.build.frontendDist, "../dist");
  assert.equal(TAURI.build.beforeBuildCommand, "pnpm build");
});

test("no updater artifacts are produced for a release with no update server", () => {
  assert.equal(TAURI.bundle.createUpdaterArtifacts, false);
});

// ------------------------------------------------- production storage paths

test("no Rust source resolves storage from the current working directory", () => {
  // Every storage root is derived from Tauri's resolved application data
  // directory in `lib.rs`. A relative path or a `current_dir` call anywhere in
  // the backend would make an installed build's storage depend on how it was
  // launched.
  for (const file of rustSources()) {
    const source = readFileSync(file, "utf8");
    assert.ok(
      !/std::env::current_dir/.test(source),
      `${relative(ROOT, file)} resolves a path from the working directory`,
    );
  }
});

test("the application data directory is read once and every store derives from it", () => {
  const lib = read("src-tauri", "src", "lib.rs");
  assert.equal(
    (lib.match(/app_local_data_dir\(\)/g) ?? []).length,
    1,
    "app_local_data_dir must be resolved exactly once",
  );
  for (const store of ["captures", "sessions", "logs"]) {
    assert.ok(
      lib.includes(`data_directory.join("${store}")`),
      `${store} must derive from the resolved data directory`,
    );
  }
});

// ------------------------------------------------------- release privacy

/// Files that legitimately contain a developer path: none. Evidence documents
/// are anonymized instead of exempted, because an exemption list is how a real
/// path eventually ships.
const PRIVACY_SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "target",
]);

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (PRIVACY_SKIP_DIRECTORIES.has(entry.name)) continue;
      yield* walk(join(directory, entry.name));
    } else if (entry.isFile()) {
      yield join(directory, entry.name);
    }
  }
}

function rustSources() {
  return [...walk(join(ROOT, "src-tauri", "src"))].filter((file) =>
    file.endsWith(".rs"),
  );
}

/// Text files only. A binary fixture is reviewed by its own suite.
const TEXT_EXTENSIONS = new Set([
  ".rs",
  ".ts",
  ".tsx",
  ".mjs",
  ".js",
  ".json",
  ".md",
  ".css",
  ".html",
  ".toml",
  ".ps1",
  ".txt",
  ".yaml",
]);

function textFiles() {
  return [...walk(ROOT)].filter((file) => {
    const dot = file.lastIndexOf(".");
    return dot > 0 && TEXT_EXTENSIONS.has(file.slice(dot));
  });
}

test("no file in the repository contains a developer machine path", () => {
  // A Windows user profile path names the developer's account and would ship
  // in any document built from these sources.
  const pattern = /[A-Za-z]:[\\/]Users[\\/][^\s"'`]+/;
  const offenders = [];
  for (const file of textFiles()) {
    const source = readFileSync(file, "utf8");
    for (const [index, line] of source.split(/\r?\n/).entries()) {
      if (pattern.test(line)) {
        offenders.push(`${relative(ROOT, file)}:${index + 1}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `developer paths found: ${offenders.join(", ")}`,
  );
});

test("no private capture, recording or backup is present in the repository", () => {
  // Only the six reviewed, redacted fixtures may exist, and only where the
  // fixture suite expects them.
  const allowed = join("src-tauri", "tests", "fixtures", "fh6") + sep;
  const offenders = [];
  for (const file of walk(ROOT)) {
    const relativePath = relative(ROOT, file);
    const isCapture = /\.(rlcap|rlframes|rlf1)$/.test(file);
    const isSummary = file.endsWith(".summary.json");
    if ((isCapture || isSummary) && !relativePath.startsWith(allowed)) {
      offenders.push(relativePath);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the reviewed fixtures are the only captures, and there are exactly six", () => {
  const fixtures = readdirSync(
    join(ROOT, "src-tauri", "tests", "fixtures", "fh6"),
  ).filter((name) => name.endsWith(".rlcap"));
  assert.equal(fixtures.length, 6);
  for (const fixture of fixtures) {
    const size = statSync(
      join(ROOT, "src-tauri", "tests", "fixtures", "fh6", fixture),
    ).size;
    // Each reviewed fixture is three packets. A larger file would mean an
    // unreviewed capture had been dropped in beside them.
    assert.equal(
      size,
      1198,
      `${fixture} is not a reviewed three-packet fixture`,
    );
  }
});

test("the repository ignores private captures and recordings by default", () => {
  const ignore = read(".gitignore");
  for (const rule of [
    "*.rlcap",
    "*.rlframes",
    "*.rlf1",
    "*.summary.json",
    "src-tauri/target/",
    "dist/",
  ]) {
    assert.ok(ignore.includes(rule), `.gitignore must contain ${rule}`);
  }
});
