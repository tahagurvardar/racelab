import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The review/ harness (mock backend, render probe, brand sheet) is kept
// through Stage F. It must never be able to reach, or pose as, the product.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");

test("every harness entry runs the development-only guard first", () => {
  const guard = read("review", "dev-only.ts");
  assert.match(guard, /import\.meta\.env\.DEV/);
  assert.match(guard, /__TAURI_INTERNALS__/);
  assert.match(guard, /throw new Error/);
  for (const entry of [
    "shell.ts",
    "brand.tsx",
    "mock-backend.ts",
    "session-fixtures.ts",
  ]) {
    const firstImport = /^import\s+[^;]*;/m.exec(read("review", entry))?.[0];
    assert.equal(firstImport, 'import "./dev-only.ts";', entry);
  }
});

test("nothing in the application imports the harness", () => {
  const walk = (directory) =>
    fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const next = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(next) : [next];
    });
  for (const file of walk(path.join(ROOT, "src"))) {
    assert.ok(
      !/from\s+["'][./]*review\/|import\s+["'][./]*review\//.test(
        fs.readFileSync(file, "utf8"),
      ),
      `${path.relative(ROOT, file)} imports review/`,
    );
  }
  // The only production page is index.html, and it loads the application.
  assert.match(read("index.html"), /src="\/src\/main\.tsx"/);
  assert.ok(!/review/.test(read("index.html")));
  assert.ok(!/review/.test(read("vite.config.ts")));
});

test("the production entry graph contains no harness module", async () => {
  const { build } = await import("vite");
  const result = await build({
    root: ROOT,
    configFile: path.join(ROOT, "vite.config.ts"),
    logLevel: "silent",
    build: { write: false },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(
    (item) => item.output,
  );
  const modules = outputs
    .filter((item) => item.type === "chunk")
    .flatMap((chunk) => chunk.moduleIds);
  assert.ok(
    modules.some((id) => id.replaceAll("\\", "/").endsWith("/src/main.tsx")),
    "the build must contain the application entry",
  );
  const harness = modules.filter((id) =>
    id.replaceAll("\\", "/").includes("/review/"),
  );
  assert.deepEqual(harness, []);
  const code = outputs
    .filter((item) => item.type === "chunk")
    .map((chunk) => chunk.code)
    .join("\n");
  assert.ok(!code.includes("review harness"), "harness text in the bundle");
  assert.ok(!code.includes("fake backend"), "test fixture text in the bundle");
});
