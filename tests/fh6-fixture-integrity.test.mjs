import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";

test("public real fixtures match reviewed digests and contain only minimal redacted packets", () => {
  const directory = new URL(
    "../src-tauri/tests/fixtures/fh6/",
    import.meta.url,
  );
  const manifest = JSON.parse(
    fs.readFileSync(new URL("manifest.json", directory), "utf8"),
  );
  assert.equal(manifest.fixtures.length, 6);
  for (const fixture of manifest.fixtures) {
    const bytes = fs.readFileSync(new URL(fixture.file, directory));
    assert.equal(
      crypto.createHash("sha256").update(bytes).digest("hex"),
      fixture.sha256,
    );
    assert.equal(bytes.length, 1198);
    assert.equal(bytes.readBigUInt64LE(16), 0n);
    let offset = 24 + bytes.readUInt32LE(12);
    for (let i = 0; i < 3; i++) {
      assert.equal(bytes[offset], 1);
      assert.equal(bytes.readBigUInt64LE(offset + 17), 0n);
      assert.equal(bytes.readUInt16LE(offset + 42), 0);
      assert.equal(bytes.readUInt32LE(offset + 52), 324);
      const packet = bytes.subarray(offset + 56, offset + 380);
      for (const [start, end] of [
        [68, 256],
        [292, 315],
        [321, 324],
      ])
        assert.ok(packet.subarray(start, end).every((byte) => byte === 0));
      offset += 380;
    }
    assert.equal(bytes[offset], 2);
    assert.equal(bytes.readBigUInt64LE(offset + 17), 3n);
    assert.equal(offset + 25, bytes.length);
  }
});
