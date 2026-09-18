export interface LiveSnapshot {
  revision: number;
  valid_packets: number;
  invalid_packets: number;
  stale: boolean;
  frame: {
    active: boolean;
    speed_mps: number;
    engine: { rpm: number };
    controls: { throttle: number; brake: number; steering: number };
    gear: {
      kind: "unknown" | "reverse" | "neutral" | "forward" | "unmapped";
      value?: number;
    };
  } | null;
  issues: { field: string; offset: number; reason: string }[];
}

export function newerLive(
  current: LiveSnapshot | null,
  incoming: LiveSnapshot,
): LiveSnapshot {
  return !current || incoming.revision > current.revision ? incoming : current;
}

export function liveMetrics(
  snapshot: LiveSnapshot | null,
  listenerRunning: boolean,
) {
  const frame = listenerRunning && !snapshot?.stale ? snapshot?.frame : null;
  return {
    speed: frame ? (frame.speed_mps * 3.6).toFixed(1) : "—",
    rpm: frame ? frame.engine.rpm.toFixed(0) : "—",
    gear: frame
      ? frame.gear.kind === "unmapped" || frame.gear.kind === "forward"
        ? String(frame.gear.value)
        : frame.gear.kind === "reverse"
          ? "R"
          : frame.gear.kind === "neutral"
            ? "N"
            : "—"
      : "—",
    throttle: frame ? (frame.controls.throttle * 100).toFixed(1) : "—",
    brake: frame ? (frame.controls.brake * 100).toFixed(1) : "—",
    steering: frame ? (frame.controls.steering * 100).toFixed(1) : "—",
  };
}
