import type { LiveFrameState } from "../telemetry/telemetry-view-model.ts";

const HEADLINES: Record<LiveFrameState["availability"], string> = {
  live: "Live telemetry",
  waiting: "Waiting for game",
  idle: "Connected · not driving",
  grace: "Telemetry paused · session held",
  stale: "Telemetry degraded",
  stopped: "Listener stopped",
};

/// Shown above a view whenever no live frame exists. It states, in words, why
/// every reading below is unavailable, so an empty dashboard is never mistaken
/// for a dashboard reading zero.
export function EmptyTelemetryState({ state }: { state: LiveFrameState }) {
  if (state.availability === "live") return null;
  return (
    <div
      className={`panel telemetry-empty tone-${state.availability}`}
      role="status"
    >
      <p className="telemetry-empty-title">{HEADLINES[state.availability]}</p>
      <p className="telemetry-empty-reason">{state.reason}</p>
    </div>
  );
}

/// A permanent explanation that a whole channel has no canonical
/// representation. Unlike `EmptyTelemetryState`, this is not about the current
/// connection: the data does not exist in RaceLab's canonical model at all.
export function UnavailableChannel({ reason }: { reason: string }) {
  return (
    <div className="panel channel-unavailable" role="note">
      <p className="channel-unavailable-title">
        No canonical data for this view
      </p>
      <p>{reason}</p>
    </div>
  );
}
