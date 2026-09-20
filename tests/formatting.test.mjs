import test from "node:test";
import assert from "node:assert/strict";
import {
  MPS_TO_KMH,
  STANDARD_GRAVITY_MPS2,
  UNAVAILABLE,
  ageMs,
  barPercent,
  code,
  degrees,
  elapsed,
  gForce,
  hertz,
  integer,
  lapTime,
  number,
  percent,
  rangeFraction,
  speedKmh,
  text,
} from "../src/telemetry/formatting.ts";

test("speed converts m/s to km/h exactly", () => {
  assert.equal(MPS_TO_KMH, 3.6);
  assert.equal(speedKmh(10), "36");
  assert.equal(speedKmh(0), "0");
  assert.equal(speedKmh(58.9), "212");
  assert.equal(speedKmh(10, 1), "36.0");
  assert.equal(speedKmh(58.333333, 1), "210.0");
});

test("acceleration converts m/s squared to g using standard gravity", () => {
  assert.equal(STANDARD_GRAVITY_MPS2, 9.80665);
  assert.equal(gForce(9.80665), "1.00");
  assert.equal(gForce(-9.80665), "-1.00");
  assert.equal(gForce(0), "0.00");
  assert.equal(gForce(4.903325), "0.50");
});

test("no watt-to-kilowatt conversion is offered, because none is used", async () => {
  // V0.7 has no canonical power field, and the FH6 power unit is unverified.
  // The conversion is absent on purpose rather than applied speculatively.
  const formatting = await import("../src/telemetry/formatting.ts");
  assert.equal(formatting.kilowatts, undefined);
});

test("normalized inputs become percentages and keep their sign", () => {
  assert.equal(percent(1), "100");
  assert.equal(percent(0.5), "50");
  assert.equal(percent(0), "0");
  // Steering is -1..1: a left input must read as a negative percentage.
  assert.equal(percent(-1), "-100");
  assert.equal(percent(-0.375), "-38");
  assert.equal(percent(-0.375, 1), "-37.5");
});

test("a bar shows magnitude only, and nothing at all when unavailable", () => {
  assert.equal(barPercent(-1), 100);
  assert.equal(barPercent(-0.5), 50);
  assert.equal(barPercent(0), 0);
  assert.equal(barPercent(null), 0);
  // Never overflows the track even if a source exceeds its declared range.
  assert.equal(barPercent(1.4), 100);
});

test("lap times format as minutes, seconds and milliseconds", () => {
  assert.equal(lapTime(0), "0:00.000");
  assert.equal(lapTime(9.5), "0:09.500");
  assert.equal(lapTime(63.456), "1:03.456");
  assert.equal(lapTime(3661.25), "61:01.250");
  // A negative value is not a lap time and is never rendered as a clock.
  assert.equal(lapTime(-1), UNAVAILABLE);
  assert.equal(lapTime(null), UNAVAILABLE);
});

test("elapsed time formats wall duration, not lap timing", () => {
  assert.equal(elapsed(0), "0:00");
  assert.equal(elapsed(65), "1:05");
  assert.equal(elapsed(3725), "1:02:05");
  assert.equal(elapsed(null), UNAVAILABLE);
});

test("radians are converted to degrees for display only", () => {
  assert.equal(degrees(Math.PI), "180.0");
  assert.equal(degrees(-Math.PI / 2), "-90.0");
  assert.equal(degrees(0), "0.0");
});

test("every formatter reports unavailable instead of inventing a zero", () => {
  for (const format of [number, speedKmh, gForce, percent, degrees]) {
    assert.equal(format(null), UNAVAILABLE);
    assert.equal(format(undefined), UNAVAILABLE);
    // A non-finite reading is not a measurement either.
    assert.equal(format(Number.NaN), UNAVAILABLE);
    assert.equal(format(Number.POSITIVE_INFINITY), UNAVAILABLE);
    // A real zero survives.
    assert.notEqual(format(0), UNAVAILABLE);
  }
  assert.equal(integer(null), UNAVAILABLE);
  assert.equal(integer(0), "0");
  assert.equal(code(null), UNAVAILABLE);
  assert.equal(code(0), "0");
  assert.equal(text(null), UNAVAILABLE);
  assert.equal(text(""), UNAVAILABLE);
  assert.equal(text("2599"), "2599");
  assert.equal(hertz(null), UNAVAILABLE);
  assert.equal(hertz(69.4), "69.4 Hz");
  assert.equal(ageMs(null), UNAVAILABLE);
  assert.equal(ageMs(14), "14 ms");
});

test("identifiers and codes are never digit-grouped, quantities are", () => {
  // Digit grouping implies magnitude. A port, ordinal or opaque code has none.
  assert.equal(code(20440), "20440");
  assert.equal(code(2599), "2599");
  assert.equal(code(-1), "-1");
  assert.equal(integer(20440), (20440).toLocaleString());
});

test("a range bar is only drawn for a usable range", () => {
  assert.equal(rangeFraction(4000, 800, 8000), 44.44444444444444);
  assert.equal(rangeFraction(800, 800, 8000), 0);
  assert.equal(rangeFraction(8000, 800, 8000), 100);
  // Outside the declared range the bar clamps; the printed number does not.
  assert.equal(rangeFraction(9000, 800, 8000), 100);
  assert.equal(rangeFraction(0, 800, 8000), 0);
  // No range means no bar, not an empty one.
  assert.equal(rangeFraction(4000, null, 8000), null);
  assert.equal(rangeFraction(4000, 800, null), null);
  assert.equal(rangeFraction(null, 800, 8000), null);
  assert.equal(rangeFraction(4000, 8000, 800), null);
});
