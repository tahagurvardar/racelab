import { EmptyTelemetryState } from "../components/EmptyTelemetryState";
import { MetricGrid } from "../components/MetricCard";
import { TelemetrySection, ViewHeader } from "../components/TelemetrySection";
import { WheelTelemetry } from "../components/WheelTelemetry";
import {
  buildTires,
  type LiveFrameState,
} from "../telemetry/telemetry-view-model.ts";

export default function TiresView({ state }: { state: LiveFrameState }) {
  const model = buildTires(state);
  return (
    <>
      <ViewHeader
        title="Tires"
        summary="Four-corner tire channels from canonical telemetry."
      />
      <EmptyTelemetryState state={state} />

      <TelemetrySection
        eyebrow="FL · FR · RL · RR"
        title="Corners"
        description="Corner identity is resolved once, in the FH6 adapter, from real-capture evidence: axle grouping from rolling radius, suspension travel range and longitudinal load transfer, and side grouping from lateral load transfer. The view model looks corners up by name, so a corner cannot be swapped in presentation."
      >
        <WheelTelemetry model={model} />
      </TelemetrySection>

      <TelemetrySection
        eyebrow="NOT IN CANONICAL TELEMETRY"
        title="Surface contact"
        description="FH6 reserves bytes for these channels and the adapter preserves them, but every captured packet holds zero, so neither their type nor their meaning is established. They are never shown as a measured zero."
      >
        <MetricGrid metrics={model.unavailable} columns={3} />
      </TelemetrySection>
    </>
  );
}
