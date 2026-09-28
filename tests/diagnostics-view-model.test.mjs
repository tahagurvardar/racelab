import test from "node:test";
import assert from "node:assert/strict";
import { UNAVAILABLE } from "../src/telemetry/formatting.ts";
import {
  fh6GearCode,
  fh6Powertrain,
  fh6Race,
  fh6TireTemperatures,
  fh6Vehicle,
  hubDiagnostics,
  protocolDiagnostics,
  transportDiagnostics,
} from "../src/telemetry/diagnostics-view-model.ts";

const frame = {
  active: true,
  game: "fh6",
  vehicle_id: "2599",
  engine: { rpm: 4321.5, idle_rpm: 800, max_rpm: 7600 },
  controls: {},
  gear: null,
  sourceSpecific: {
    fh6: {
      is_race_on: 1,
      timestamp_ms: 65_000,
      car_ordinal: 2599,
      car_class: 5,
      car_performance_index: 812,
      drivetrain_type: 2,
      num_cylinders: 8,
      power: 150_000.25,
      torque: 480.5,
      boost: 1.25,
      fuel: 0.875,
      tire_temperatures: [70.5, 71.25, 68, 69.75],
      distance_traveled: 1634.5,
      best_lap: 63.456,
      last_lap: 64.125,
      current_lap: 12.5,
      current_race_time: 140.25,
      lap_number: 3,
      race_position: 1,
      gear: 11,
    },
  },
};

test("diagnostics is the only place the raw FH6 gear code is shown", () => {
  const entry = fh6GearCode(frame);
  assert.equal(entry.value, "11");
  assert.match(entry.label, /code/i);
  // The caveat must say it is not a gear.
  assert.match(entry.caveat, /never shown as a gear/i);
});

test("wire powertrain values stay raw, with no unit asserted for boost or fuel", () => {
  const powertrain = fh6Powertrain(frame);
  assert.deepEqual(
    powertrain.map((item) => [item.label, item.value]),
    [
      ["Power (wire)", "150000.3"],
      ["Torque (wire)", "480.5"],
      ["Boost", "1.250"],
      ["Fuel", "0.875"],
    ],
  );
  // Diagnostics reports the wire reading, so it still asserts no unit here.
  for (const item of powertrain) {
    assert.ok(!/\bkW\b/i.test(item.label + item.value));
  }
  const byKey = Object.fromEntries(powertrain.map((item) => [item.key, item]));
  assert.match(byKey.boost.caveat, /unit unverified/i);
  assert.match(byKey.fuel.caveat, /unit unverified/i);
});

test("per-wheel diagnostics keep packet order and are never labelled by corner", () => {
  const entries = fh6TireTemperatures(frame);
  const temperatures = entries.filter((item) =>
    item.key.startsWith("tire-temp-"),
  );
  assert.deepEqual(
    temperatures.map((item) => [item.label, item.value]),
    [
      ["Tire temperature (\u00b0F) 0", "70.5"],
      ["Tire temperature (\u00b0F) 1", "71.3"],
      ["Tire temperature (\u00b0F) 2", "68.0"],
      ["Tire temperature (\u00b0F) 3", "69.8"],
    ],
  );
  // Diagnostics is the wire view: it stays in source order and uses no corner
  // name, so a suspected corner error can be checked against the packet.
  assert.ok(!/\b(FL|FR|RL|RR)\b/.test(JSON.stringify(entries)));
  assert.ok(entries.every((item) => /packet-offset order/i.test(item.caveat)));
  // Every promoted per-wheel channel is still reachable in raw form.
  for (const key of [
    "travel-normalized-0",
    "travel-m-3",
    "slip-ratio-1",
    "slip-angle-2",
    "combined-slip-0",
    "rotation-3",
  ]) {
    assert.ok(
      entries.some((item) => item.key === key),
      "missing " + key,
    );
  }
});

test("vehicle configuration values stay opaque codes with no inferred meaning", () => {
  const entries = fh6Vehicle(frame);
  const byKey = Object.fromEntries(entries.map((item) => [item.key, item]));
  assert.equal(byKey.class.value, "5");
  assert.equal(byKey.pi.value, "812");
  // Codes and ordinals are never digit-grouped either.
  assert.equal(byKey.ordinal.value, "2599");
  assert.equal(byKey.drivetrain.value, "2");
  assert.equal(byKey.cylinders.value, "8");
  // No drivetrain name, class letter or car name is invented from a code.
  assert.ok(!/AWD|RWD|FWD|\bclass [A-S]\b/i.test(JSON.stringify(entries)));
  assert.match(byKey.drivetrain.caveat, /no meaning inferred/i);
});

test("raw race values stay raw and carry a unit caveat", () => {
  const entries = fh6Race(frame);
  const byKey = Object.fromEntries(entries.map((item) => [item.key, item]));
  assert.equal(byKey["lap-number"].value, "3");
  assert.equal(byKey["best-lap"].value, "63.456");
  // The raw value is not formatted as a lap clock; that would assert seconds.
  assert.ok(!/:/.test(byKey["best-lap"].value));
  assert.ok(entries.every((item) => item.caveat.length > 0));
});

test("a frame without adapter data yields unavailable, never zero", () => {
  for (const empty of [
    null,
    { sourceSpecific: null },
    { sourceSpecific: {} },
  ]) {
    const entries = [
      fh6GearCode(empty),
      ...fh6Powertrain(empty),
      ...fh6TireTemperatures(empty),
      ...fh6Race(empty),
      ...fh6Vehicle(empty),
    ];
    assert.ok(
      entries.every((item) => item.value === UNAVAILABLE),
      JSON.stringify(entries.filter((item) => item.value !== UNAVAILABLE)),
    );
  }
});

test("protocol, hub and transport counters reach diagnostics", () => {
  const snapshot = {
    protocol: "fh6",
    protocol_confidence: 1,
    input_packet_hz: 69.4,
    valid_frame_hz: 69.4,
    last_packet_age_ms: 14,
    last_valid_frame_age_ms: 14,
    receive_errors: 0,
    valid_active_fh6: 1200,
    valid_inactive_fh6: 300,
    invalid_fh6: 0,
    unknown_protocol: 2,
    grace_period_ms: 10_000,
    hub: {
      published: 1500,
      recent_frames: 512,
      ring_capacity: 512,
      ring_evictions: 988,
      subscribers: 1,
      subscriber_drops: 0,
      last_drop_ms: null,
    },
  };
  const protocol = Object.fromEntries(
    protocolDiagnostics(snapshot).map((item) => [item.key, item.value]),
  );
  assert.equal(protocol.protocol, "fh6");
  assert.equal(protocol.confidence, "100%");
  assert.equal(protocol["input-hz"], "69.4 Hz");
  assert.equal(protocol["packet-age"], "14 ms");
  // Counted quantities group for the reader's locale; the test must not
  // assume a separator.
  assert.equal(protocol.active, (1200).toLocaleString());
  assert.equal(protocol.inactive, "300");
  assert.equal(protocol.invalid, "0");
  assert.equal(protocol.unknown, "2");

  const hub = Object.fromEntries(
    hubDiagnostics(snapshot).map((item) => [item.key, item.value]),
  );
  assert.equal(hub.recent, "512 / 512");
  assert.equal(hub.drops, "0");
  assert.equal(hub.grace, `${(10000).toLocaleString()} ms`);

  const transport = Object.fromEntries(
    transportDiagnostics({
      running: true,
      bound_port: 20440,
      last_source: "127.0.0.1:5200",
      last_packet_size: 324,
      total_packets: 18165,
      packets_per_second: 69.4,
      total_bytes: 5_885_460,
      receive_errors: 0,
      receive_buffer_bytes: 4_194_304,
    }).map((item) => [item.key, item.value]),
  );
  // A port is an identifier, not a quantity: it is never digit-grouped.
  assert.equal(transport["bound-port"], "20440");
  assert.equal(transport.source, "127.0.0.1:5200");
  assert.equal(transport["packet-size"], "324 B");
  assert.equal(transport.errors, "0");
});

test("every diagnostic reads unavailable when there is no snapshot", () => {
  for (const entry of [
    ...protocolDiagnostics(null),
    ...hubDiagnostics(null),
    ...transportDiagnostics(null),
  ]) {
    assert.equal(entry.value, UNAVAILABLE, entry.key);
  }
});
