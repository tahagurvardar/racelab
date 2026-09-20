import {
  EmptyTelemetryState,
  UnavailableChannel,
} from "../components/EmptyTelemetryState";
import { MetricGrid } from "../components/MetricCard";
import { TelemetrySection, ViewHeader } from "../components/TelemetrySection";
import {
  buildRace,
  type LiveFrameState,
} from "../telemetry/telemetry-view-model.ts";

export default function RaceView({ state }: { state: LiveFrameState }) {
  const model = buildRace(state);
  return (
    <>
      <ViewHeader title="Race" summary="Canonical lap and race telemetry." />
      <EmptyTelemetryState state={state} />
      {model.available ? null : <UnavailableChannel reason={model.reason} />}

      <TelemetrySection
        eyebrow="CANONICAL TIMING"
        title="Lap timing"
        description="Lap times render as m:ss.mmm through the shared formatter. No lap delta, sector, corner or racing-line analysis exists in V0.7."
      >
        <MetricGrid metrics={model.timing} columns={4} />
      </TelemetrySection>

      <TelemetrySection eyebrow="CANONICAL RACE STATE" title="Standing">
        <MetricGrid metrics={model.standing} columns={4} />
        <p className="section-footnote">
          NormalizedDrivingLine and AIBrakeDifference are not exposed as product
          values: their semantics are not documented, so they remain
          source-specific data.
        </p>
      </TelemetrySection>
    </>
  );
}
