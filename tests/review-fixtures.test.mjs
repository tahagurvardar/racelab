import test from "node:test";
import assert from "node:assert/strict";
import {
  f1Detail,
  f1DetailInconsistent,
} from "../review/f1-session-fixtures.ts";
import { SYNTHETIC_LAPS, syntheticTrace } from "../review/lab-fixtures.ts";
import { assessLap } from "../src/lap-quality.ts";

// The review harness's F1 session and its synthetic laps must tell the same
// story: what the lap records state is what the samples do.

const TRACK = 5891;

/// Lap time at which a lap's samples reach `metres`, interpolated between
/// the two 10 Hz samples either side.
function crossing(lap, metres) {
  const trace = syntheticTrace(
    "f1-review-race",
    lap,
    "time",
    ["lap_time", "lap_distance"],
    4000,
    TRACK,
  );
  const [time, distance] = trace.channels;
  const points = time.last
    .map((t, index) => [t, distance.last[index]])
    .filter(([t]) => t != null);
  for (let index = 1; index < points.length; index += 1) {
    const [t0, d0] = points[index - 1];
    const [t1, d1] = points[index];
    if (d1 >= metres)
      return Math.round(t0 + ((metres - d0) / (d1 - d0)) * (t1 - t0));
  }
  // The line itself: extrapolate the final step.
  const [[t0, d0], [t1, d1]] = points.slice(-2);
  return Math.round(t1 + ((metres - d1) / (d1 - d0)) * (t1 - t0));
}

test("the synthetic laps' line and sector crossings are what the fixture states", () => {
  for (const lap of [1, 2]) {
    const s1 = crossing(lap, 1700);
    const s2 = crossing(lap, 3900);
    assert.deepEqual(SYNTHETIC_LAPS[lap], {
      lapTimeMs: crossing(lap, TRACK),
      sector1Ms: s1,
      sector2Ms: s2 - s1,
    });
  }
});

test("the F1 review fixture is internally consistent", () => {
  const detail = f1Detail();
  const meta = detail.session.f1_25;
  const [first, second] = detail.laps.laps;
  // Session History's sectors sum to its lap time; Lap Data has no S3.
  assert.equal(first.source, "session_history");
  assert.equal(
    first.sector1_ms + first.sector2_ms + first.sector3_ms,
    first.lap_time_ms,
  );
  assert.equal(second.source, "lap_data");
  assert.equal(second.sector3_ms, null);
  assert.equal(second.sector3_valid, null);
  // Best lap, fastest-lap event and result agree with the records.
  assert.equal(detail.result.player.best_lap_time_ms, first.lap_time_ms);
  assert.ok(second.lap_time_ms > first.lap_time_ms);
  assert.equal(detail.laps.best_lap_time_lap_num, 1);
  const fastest = detail.events.find((event) => event.code === "FTLP");
  assert.equal(fastest.details.lap_time_s * 1000, first.lap_time_ms);
  const total = first.lap_time_ms + second.lap_time_ms;
  assert.equal(detail.result.player.total_race_time_s * 1000, total);
  assert.equal(second.recorded_at_monotonic_ms, total);
  // Both laps fit inside the session, sampled at its own rate.
  assert.ok(total <= meta.duration_ms);
  assert.equal(
    detail.session.racelab_session.ended_at_unix_ms -
      detail.session.racelab_session.started_at_unix_ms,
    meta.duration_ms,
  );
  assert.equal(
    meta.integrity.sample_count,
    (meta.duration_ms / 1000) * meta.sample_rate_hz,
  );
  assert.equal(meta.context_latest.session_duration_s * 1000, meta.duration_ms);
});

test("against the consistent fixture the Lab finds no timing mismatch", () => {
  const detail = f1Detail();
  for (const axis of ["distance", "time"]) {
    for (const record of detail.laps.laps) {
      const trace = syntheticTrace(
        "f1-review-race",
        record.lap_number,
        axis,
        ["lap_time", "lap_distance"],
        2000,
        TRACK,
      );
      const quality = assessLap(record.lap_number, record, trace, TRACK);
      const codes = quality.issues.map((issue) => issue.code);
      for (const code of [
        "runs_past_lap_time",
        "end_missing",
        "start_missing",
        "sparse",
        "sector_sum",
      ]) {
        assert.ok(
          !codes.includes(code),
          `lap ${record.lap_number} ${axis}: ${code}`,
        );
      }
      // Lap 1 is confirmed and fully sampled; lap 2 stays provisional.
      assert.equal(
        quality.distanceAnalysis.eligible,
        record.lap_number === 1,
        `lap ${record.lap_number} ${axis}`,
      );
    }
  }
});

test("the inconsistent scenario keeps the mismatch detectable", () => {
  const detail = f1DetailInconsistent();
  for (const record of detail.laps.laps) {
    const trace = syntheticTrace(
      "f1-review-race",
      record.lap_number,
      "distance",
      ["lap_time", "lap_distance"],
      2000,
      TRACK,
    );
    const quality = assessLap(record.lap_number, record, trace, TRACK);
    assert.ok(
      quality.issues.some((issue) => issue.code === "runs_past_lap_time"),
    );
    assert.equal(quality.distanceAnalysis.eligible, false);
  }
  // Still no invented S3 on the provisional lap.
  assert.equal(detail.laps.laps[1].sector3_ms, null);
});
