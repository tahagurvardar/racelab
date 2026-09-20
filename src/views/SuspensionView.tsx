import {
  EmptyTelemetryState,
  UnavailableChannel,
} from "../components/EmptyTelemetryState";
import { TelemetrySection, ViewHeader } from "../components/TelemetrySection";
import { WheelTelemetry } from "../components/WheelTelemetry";
import {
  buildSuspension,
  type LiveFrameState,
} from "../telemetry/telemetry-view-model.ts";

export default function SuspensionView({ state }: { state: LiveFrameState }) {
  const model = buildSuspension();
  return (
    <>
      <ViewHeader
        title="Suspension"
        summary="Four-corner suspension travel from canonical telemetry."
      />
      <EmptyTelemetryState state={state} />
      {model.available ? null : <UnavailableChannel reason={model.reason} />}

      <TelemetrySection
        eyebrow="FL · FR · RL · RR"
        title="Corners"
        description="Corner positions are fixed by the view model and rendered in order. No travel value is interpreted as bottoming out, rebound or spring behaviour; V0.7 presents telemetry and does not analyse it."
      >
        <WheelTelemetry model={model} />
      </TelemetrySection>
    </>
  );
}
