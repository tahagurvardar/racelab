// DEV-ONLY, SYNTHETIC. Telemetry Lab traces for the review harness.
//
// These laps are generated from an invented corner list, not captured from a
// game and not a model of any real circuit. They exist so the Lab's layout
// can be reviewed and screenshotted; every screen that shows them also shows
// a "SYNTHETIC REVIEW DATA" badge. They are bucketed with the same integer
// arithmetic as `session_trace.rs`, so the shapes match the real command.
import type {
  SessionTrace,
  TraceAxisId,
  TraceChannelId,
} from "../src/telemetry-lab.ts";

/// `[apex distance m, apex speed km/h, direction]`. Invented.
const CORNERS: [number, number, 1 | -1][] = [
  [520, 118, 1],
  [980, 205, -1],
  [1420, 92, 1],
  [2160, 236, -1],
  [2720, 138, 1],
  [3060, 176, -1],
  [3640, 86, -1],
  [4380, 214, 1],
  [4960, 128, 1],
  [5470, 162, -1],
];
const TOP_SPEED = 312;

interface Sample {
  timeMs: number;
  distanceM: number;
  values: Record<TraceChannelId, number>;
}

function targetSpeed(distance: number, pace: number): number {
  let speed = TOP_SPEED;
  for (const [apex, minimum] of CORNERS) {
    const away = Math.abs(distance - apex);
    speed = Math.min(speed, minimum * pace + 3.3 * Math.sqrt(away) * 3.6);
  }
  return Math.min(TOP_SPEED, speed);
}

function steeringAt(distance: number): number {
  let steer = 0;
  for (const [apex, minimum, direction] of CORNERS) {
    const width = 140 + minimum;
    const away = Math.abs(distance - apex);
    if (away < width) {
      const strength = Math.min(0.9, 34 / minimum);
      steer += direction * strength * Math.cos((away / width) * (Math.PI / 2));
    }
  }
  return Math.max(-1, Math.min(1, steer));
}

function gearFor(speed: number): number {
  const limits = [0, 85, 120, 152, 185, 218, 252, 285];
  let gear = 1;
  for (let index = 1; index < limits.length; index += 1) {
    if (speed >= limits[index]) gear = index + 1;
  }
  return Math.min(8, gear);
}

/// One synthetic lap at 10 Hz. `pace` scales corner speeds a little, so
/// two laps differ the way two real laps would, without claiming to be real.
function lap(trackLength: number, pace: number): Sample[] {
  const samples: Sample[] = [];
  let distance = 0;
  let speed = targetSpeed(0, pace);
  let timeMs = 0;
  while (distance < trackLength) {
    const target = targetSpeed(distance + speed / 3.6, pace);
    const accelerating = target > speed;
    const next = accelerating
      ? Math.min(target, speed + Math.max(0.45, 2.9 - speed / 115))
      : Math.max(target, speed - 7.5);
    const throttle = accelerating
      ? Math.min(1, 0.55 + (target - speed) / 20)
      : 0;
    const brake = accelerating ? 0 : Math.min(1, (speed - next) / 7.5);
    const gear = gearFor(next);
    samples.push({
      timeMs,
      distanceM: distance,
      values: {
        speed: Math.round(next),
        rpm: Math.round(
          Math.min(11_800, 4200 + ((next % 40) / 40) * 7400 + gear * 120),
        ),
        throttle: Math.round(throttle * 1000) / 1000,
        brake: Math.round(brake * 1000) / 1000,
        steering: Math.round(steeringAt(distance) * 1000) / 1000,
        gear,
      },
    });
    distance += (next / 3.6) * 0.1;
    speed = next;
    timeMs += 100;
  }
  return samples;
}

const CHANNEL_UNITS: Record<
  TraceChannelId,
  SessionTrace["channels"][0]["unit"]
> = {
  speed: "kilometres_per_hour",
  rpm: "revolutions_per_minute",
  throttle: "ratio_0_1",
  brake: "ratio_0_1",
  steering: "ratio_-1_1",
  gear: "gear",
};

/// Buckets samples exactly as `session_trace.rs` does: integer ticks
/// (milliseconds, or millimetres on distance), width rounded up.
export function syntheticTrace(
  sessionId: string,
  lapNumber: number,
  axis: TraceAxisId,
  channels: TraceChannelId[],
  buckets: number,
  trackLength: number,
): SessionTrace {
  const pace = lapNumber === 1 ? 1 : 0.975 + ((lapNumber * 7) % 5) * 0.004;
  const samples = lap(trackLength, pace);
  const ticks = samples.map((sample) =>
    axis === "distance" ? Math.round(sample.distanceM * 1000) : sample.timeMs,
  );
  const low = Math.min(...ticks);
  const high = Math.max(...ticks);
  const span = high - low;
  const width = Math.max(1, Math.ceil((span + 1) / buckets));
  const count = Math.floor(span / width) + 1;
  const scale = axis === "distance" ? 1000 : 1;
  const bucketRecords = new Array<number>(count).fill(0);
  const data = channels.map((channel) => ({
    channel,
    unit: CHANNEL_UNITS[channel],
    min: new Array<number | null>(count).fill(null),
    max: new Array<number | null>(count).fill(null),
    last: new Array<number | null>(count).fill(null),
    samples: new Array<number>(count).fill(0),
    missing: new Array<number>(count).fill(0),
    total_samples: 0,
    total_missing: 0,
    total_non_finite: 0,
  }));
  samples.forEach((sample, index) => {
    const bucket = Math.floor((ticks[index] - low) / width);
    bucketRecords[bucket] += 1;
    for (const entry of data) {
      const value = sample.values[entry.channel];
      entry.min[bucket] = Math.min(entry.min[bucket] ?? value, value);
      entry.max[bucket] = Math.max(entry.max[bucket] ?? value, value);
      entry.last[bucket] = value;
      entry.samples[bucket] += 1;
      entry.total_samples += 1;
    }
  });
  return {
    schema_version: 2,
    session_id: sessionId,
    game: "f1_25",
    scope: {
      lap: lapNumber,
      stream_records: samples.length * 2,
      unattributed_records: 0,
    },
    source: {
      format: "rlf1",
      container_version: 1,
      payload_schema_version: 1,
      recorded_by_racelab_version: "synthetic-review",
      nominal_sample_rate_hz: 10,
      stream_complete: true,
      truncated_tail: false,
      declared_records: samples.length * 2,
      recorder_dropped_frames: null,
      f1_integrity: {
        idle_ticks: 0,
        late_ticks: 0,
        telemetry_gaps: 0,
        out_of_order_dropped: 0,
      },
    },
    axis: {
      kind: axis === "distance" ? "lap_distance" : "lap_time",
      unit: axis === "distance" ? "m" : "ms",
      origin: axis === "distance" ? "start_finish_line" : "lap_start",
      start: low / scale,
      end: high / scale,
      records: samples.length,
      bucket_width: width / scale,
      bucket_count: count,
      max_interval_ms: 100,
      reversals: 0,
    },
    bucket_records: bucketRecords,
    gaps: { threshold_ms: 1000, total: 0, stored: [] },
    channels: data,
  };
}

/// A fixed, unmistakable label on every screen that shows synthetic laps.
export function markSynthetic() {
  if (document.getElementById("review-synthetic-badge")) return;
  const badge = document.createElement("div");
  badge.id = "review-synthetic-badge";
  badge.textContent = "SYNTHETIC REVIEW DATA · not a recorded session";
  Object.assign(badge.style, {
    position: "fixed",
    right: "12px",
    bottom: "10px",
    zIndex: "1000",
    padding: "3px 10px",
    border: "1px solid var(--status-warn)",
    borderRadius: "4px",
    background: "var(--warn-surface)",
    color: "var(--warn-text)",
    font: "500 11px/1.4 var(--font-sans)",
    letterSpacing: "0.08em",
    pointerEvents: "none",
  });
  document.body.append(badge);
}
