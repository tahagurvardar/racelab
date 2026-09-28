import { EmptyTelemetryState } from "../components/EmptyTelemetryState";
import { TelemetrySection, ViewHeader } from "../components/TelemetrySection";
import { WheelTelemetry } from "../components/WheelTelemetry";
import {
  buildSuspension,
  type LiveFrameState,
} from "../telemetry/telemetry-view-model.ts";

export default function SuspensionView({ state }: { state: LiveFrameState }) {
  const model = buildSuspension(state);
  return (
    <>
      <ViewHeader
        title="Suspension"
        summary="Four-corner suspension travel from canonical telemetry."
      />
      <EmptyTelemetryState state={state} />

      <TelemetrySection
        eyebrow="FL · FR · RL · RR"
        title="Corners"
        description="Normalized travel runs 0 at full extension to 1 at full compression; travel in millimetres is an exact presentation of the canonical metres. No travel value is interpreted as bottoming out, rebound or spring behaviour: RaceLab presents telemetry and does not analyse it."
      >
        <WheelTelemetry model={model} />
      </TelemetrySection>
    </>
  );
}
