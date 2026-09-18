// Explicit opt-in local extraction. Never copies a complete private capture.
// Usage: node scripts/extract-fh6-fixtures.mjs OUTPUT_DIR INPUT.rlcap [INPUT.rlcap ...]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const [output, ...inputs] = process.argv.slice(2);
if (!output || inputs.length < 1 || inputs.length > 6)
  throw new Error("Provide an output directory and 1–6 private .rlcap inputs");
const magic = Buffer.from([82, 76, 67, 65, 80, 13, 10, 0]);
const f32Offsets = [
  8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 244, 248, 252, 256,
  260, 264, 268, 272, 276, 280, 284, 288, 292, 296, 300, 304, 308,
];
const redactions = [
  [68, 244],
  [244, 256],
  [292, 315],
  [321, 324],
];
fs.mkdirSync(output, { recursive: true });
const manifest = {
  version: 1,
  provenance:
    "Minimal packets extracted locally from six user-validated real FH6 recordings. No original filenames, labels, endpoints or wall times retained.",
  redactions:
    "Zero bytes 68..255, 292..314, 321..323; rebase game and monotonic timestamps. Capture source becomes 127.0.0.1:0; wall timestamps become 0. Retained physics/engine/control bytes are unchanged.",
  fixtures: [],
};
for (const [caseIndex, input] of inputs.entries()) {
  const original = fs.readFileSync(input);
  if (!original.subarray(0, 8).equals(magic) || original.readUInt32LE(8) !== 1)
    throw new Error("Unsupported capture header");
  const labelLength = original.readUInt32LE(12);
  if (labelLength < 1 || labelLength > 256)
    throw new Error("Invalid label length");
  let offset = 24 + labelLength;
  const records = [];
  while (original[offset] === 1) {
    const len = original.readUInt32LE(offset + 52);
    if (len !== 324 || offset + 56 + len > original.length)
      throw new Error("Expected complete 324-byte FH6 packet");
    records.push({
      time: original.readBigUInt64LE(offset + 1),
      bytes: original.subarray(offset + 56, offset + 56 + len),
    });
    offset += 56 + len;
  }
  if (
    original[offset] !== 2 ||
    offset + 25 !== original.length ||
    original.readBigUInt64LE(offset + 17) !== BigInt(records.length) ||
    original.readBigUInt64LE(offset + 9) !== 0n
  )
    throw new Error("Incomplete or lossy source capture");
  let best = -1,
    score = -Infinity;
  for (let index = 0; index < records.length - 1; index++) {
    const p = records[index].bytes,
      next = records[index + 1].bytes;
    if (p.readInt32LE(0) !== 1 || next.readInt32LE(0) !== 1) continue;
    const value =
      caseIndex === 3
        ? p[316]
        : caseIndex === 4
          ? Math.abs(p.readInt8(320))
          : p.readFloatLE(256);
    if (Number.isFinite(value) && value > score) {
      score = value;
      best = index;
    }
  }
  if (best < 0) throw new Error("No adjacent active packets");
  const inactive = records.findIndex(
    (record) => record.bytes.readInt32LE(0) === 0,
  );
  const indices = [
    ...new Set([best, best + 1, ...(inactive >= 0 ? [inactive] : [])]),
  ].sort((a, b) => a - b);
  const baseGame = records[indices[0]].bytes.readUInt32LE(4),
    baseTime = records[indices[0]].time;
  const name = `sample-${String(caseIndex + 1).padStart(2, "0")}.rlcap`,
    label = Buffer.from(name.replace(".rlcap", ""));
  const header = Buffer.alloc(24 + label.length);
  magic.copy(header);
  header.writeUInt32LE(1, 8);
  header.writeUInt32LE(label.length, 12);
  label.copy(header, 24);
  const parts = [header],
    expected = [];
  let lastTime = 0n;
  for (const index of indices) {
    const record = records[index],
      p = Buffer.from(record.bytes);
    for (const [start, end] of redactions) p.fill(0, start, end);
    p.writeUInt32LE((p.readUInt32LE(4) - baseGame) >>> 0, 4);
    const time = record.time - baseTime;
    if (time < lastTime) throw new Error("Decreasing capture time");
    lastTime = time;
    const metadata = Buffer.alloc(56);
    metadata[0] = 1;
    metadata.writeBigUInt64LE(time, 1);
    metadata.writeBigUInt64LE(time, 9);
    metadata[25] = 4;
    metadata[26] = 127;
    metadata[29] = 1;
    metadata.writeUInt32LE(324, 52);
    parts.push(metadata, p);
    expected.push({
      active: p.readInt32LE(0) === 1,
      timestamp_ms: p.readUInt32LE(4),
      f32: Object.fromEntries(f32Offsets.map((o) => [o, p.readFloatLE(o)])),
      throttle: p[315],
      brake: p[316],
      clutch: p[317],
      handbrake: p[318],
      gear: p[319],
      steering: p.readInt8(320),
    });
  }
  const footer = Buffer.alloc(25);
  footer[0] = 2;
  footer.writeBigUInt64LE(lastTime, 1);
  footer.writeBigUInt64LE(BigInt(indices.length), 17);
  parts.push(footer);
  const bytes = Buffer.concat(parts);
  fs.writeFileSync(path.join(output, name), bytes, { flag: "wx" });
  manifest.fixtures.push({
    file: name,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    packets: expected,
  });
}
fs.writeFileSync(
  path.join(output, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
  { flag: "wx" },
);
console.log(
  `Extracted ${manifest.fixtures.reduce((sum, f) => sum + f.packets.length, 0)} anonymized packets across ${inputs.length} fixtures.`,
);
