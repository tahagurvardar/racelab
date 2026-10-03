import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

test("the title-bar/taskbar ICO frame uses the locked 16px optical master pixel for pixel", () => {
  const ico = readFileSync(
    new URL("../src-tauri/icons/icon.ico", import.meta.url),
  );
  const count = ico.readUInt16LE(4);
  const entry = Array.from({ length: count }, (_, i) => 6 + i * 16).find(
    (offset) => ico[offset] === 16 && ico[offset + 1] === 16,
  );
  assert.notEqual(entry, undefined, "a dedicated 16px frame is required");
  const start = ico.readUInt32LE(entry + 12);
  const png = ico.subarray(start, start + ico.readUInt32LE(entry + 8));
  const compressed = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const kind = png.toString("ascii", offset + 4, offset + 8);
    if (kind === "IHDR") {
      assert.equal(png.readUInt32BE(offset + 8), 16);
      assert.equal(png.readUInt32BE(offset + 12), 16);
      assert.equal(png[offset + 16], 8, "8-bit channels");
      assert.equal(
        png[offset + 17],
        6,
        "RGBA with a transparent negative step",
      );
    }
    if (kind === "IDAT")
      compressed.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const scanlines = inflateSync(Buffer.concat(compressed));
  const decoded = Buffer.alloc(16 * 16 * 4);
  const stride = 64;
  for (let y = 0; y < 16; y++) {
    const filter = scanlines[y * (stride + 1)];
    for (let byte = 0; byte < stride; byte++) {
      const index = y * stride + byte;
      const left = byte >= 4 ? decoded[index - 4] : 0;
      const above = y > 0 ? decoded[index - stride] : 0;
      const corner = y > 0 && byte >= 4 ? decoded[index - stride - 4] : 0;
      const prediction = left + above - corner;
      const distances = [left, above, corner].map((value) =>
        Math.abs(prediction - value),
      );
      const paeth = [left, above, corner][
        distances.indexOf(Math.min(...distances))
      ];
      assert.ok(filter <= 4, "supported PNG scanline filter");
      decoded[index] =
        (scanlines[y * (stride + 1) + 1 + byte] +
          [0, left, above, Math.floor((left + above) / 2), paeth][filter]) &
        255;
    }
    for (let x = 0; x < 16; x++) {
      // SVG M1 4H14V12H8V9H1Z: two exact, half-open rectangles.
      const solid =
        (y >= 4 && y < 9 && x >= 1 && x < 14) ||
        (y >= 9 && y < 12 && x >= 8 && x < 14);
      const pixel = [
        ...decoded.subarray((y * 16 + x) * 4, (y * 16 + x + 1) * 4),
      ];
      assert.deepEqual(
        pixel,
        solid ? [241, 244, 245, 255] : [0, 0, 0, 0],
        `pixel ${x},${y}`,
      );
    }
  }
});
