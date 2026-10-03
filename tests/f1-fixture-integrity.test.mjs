import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";

const SIZES = { 2: 1285, 6: 1352, 7: 1239, 13: 273 };

test("real F1 25 fixtures match reviewed digests and carry only the sanitized session UID", () => {
  const directory = new URL(
    "../src-tauri/tests/fixtures/f1_25/",
    import.meta.url,
  );
  const manifest = JSON.parse(
    fs.readFileSync(new URL("manifest.json", directory), "utf8"),
  );
  // Four snapshots of exactly the four decoded families; nothing else.
  assert.equal(manifest.files.length, 16);
  const onDisk = fs
    .readdirSync(directory, { recursive: true })
    .map((name) => String(name).replaceAll("\\", "/"))
    .filter((name) => name.endsWith(".bin"))
    // Synthetic fixtures live in their own folder with their own manifest.
    .filter((name) => !name.startsWith("synthetic/"))
    .sort();
  assert.deepEqual(onDisk, manifest.files.map((file) => file.file).sort());
  for (const file of manifest.files) {
    const bytes = fs.readFileSync(new URL(file.file, directory));
    assert.equal(
      crypto.createHash("sha256").update(bytes).digest("hex"),
      file.sha256,
      file.file,
    );
    assert.equal(bytes.length, SIZES[file.packet_id], file.file);
    assert.equal(bytes.readUInt16LE(0), 2025);
    assert.equal(bytes[2], 25);
    assert.equal(bytes[5], 1);
    assert.equal(bytes[6], file.packet_id);
    assert.equal(bytes.subarray(7, 15).toString("latin1"), "RACELAB!");
  }
});

const SYNTHETIC_SIZES = {
  1: 753,
  3: 45,
  4: 1284,
  8: 1042,
  10: 1041,
  11: 1460,
  12: 231,
  14: 101,
  15: 1131,
};

test("synthetic F1 25 fixtures are labelled, digested and never carry the real UID", () => {
  const directory = new URL(
    "../src-tauri/tests/fixtures/f1_25/synthetic/",
    import.meta.url,
  );
  const manifest = JSON.parse(
    fs.readFileSync(new URL("manifest.json", directory), "utf8"),
  );
  assert.match(manifest.provenance, /^SYNTHETIC\./);
  assert.match(manifest.provenance, /Never captured from a game/);
  const onDisk = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".bin"))
    .sort();
  assert.deepEqual(onDisk, manifest.files.map((file) => file.file).sort());
  for (const file of manifest.files) {
    const bytes = fs.readFileSync(new URL(file.file, directory));
    assert.equal(
      crypto.createHash("sha256").update(bytes).digest("hex"),
      file.sha256,
      file.file,
    );
    assert.equal(bytes.length, SYNTHETIC_SIZES[file.packet_id], file.file);
    assert.equal(bytes.readUInt16LE(0), 2025);
    assert.equal(bytes[6], file.packet_id);
    assert.equal(bytes.subarray(7, 15).toString("latin1"), "SYNTHET!");
  }
  const readme = fs.readFileSync(new URL("README.md", directory), "utf8");
  assert.match(readme, /not captured from a game/);
});
