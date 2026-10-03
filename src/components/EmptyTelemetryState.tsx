import type { LiveFrameState } from "../telemetry/telemetry-view-model.ts";

/// The same words the top bar uses for each state, so the two never
/// disagree.
const HEADLINES: Record<LiveFrameState["availability"], string> = {
  live: "Live",
  waiting: "Waiting for a supported game",
  idle: "Connected · not driving",
  grace: "Paused · session held",
  stale: "Telemetry degraded",
  stopped: "Not listening",
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
