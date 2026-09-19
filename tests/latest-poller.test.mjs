import test from "node:test";
import assert from "node:assert/strict";
import { startLatestPolling } from "../src/latest-poller.ts";
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("slow snapshot request cannot create stale queued UI reads", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requests = 0;
  let resolve;
  const values = [];
  const stop = startLatestPolling(
    () => {
      requests++;
      return new Promise((done) => {
        resolve = done;
      });
    },
    (value) => values.push(value),
    assert.fail,
  );
  t.mock.timers.tick(10000);
  assert.equal(requests, 1);
  resolve(500);
  await settle();
  assert.deepEqual(values, [500]);
  t.mock.timers.tick(49);
  assert.equal(requests, 1);
  t.mock.timers.tick(1);
  assert.equal(requests, 2);
  stop();
  resolve(600);
  await settle();
  assert.deepEqual(values, [500]);
  t.mock.timers.tick(10000);
  assert.equal(requests, 2);
});

test("failed reads recover without overlapping requests or exceeding 20 Hz", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let requests = 0;
  const values = [],
    errors = [];
  const stop = startLatestPolling(
    async () => {
      if (++requests === 1) throw new Error("IPC unavailable");
      return requests;
    },
    (value) => values.push(value),
    (error) => errors.push(String(error)),
    1,
  );
  await settle();
  assert.equal(errors.length, 1);
  t.mock.timers.tick(49);
  assert.equal(requests, 1);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(values, [2]);
  stop();
});
