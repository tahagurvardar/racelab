import {
  EmptyTelemetryState,
  UnavailableChannel,
} from "../components/EmptyTelemetryState";
import { TelemetrySection, ViewHeader } from "../components/TelemetrySection";
import { WheelTelemetry } from "../components/WheelTelemetry";
import {
  buildTires,
  type LiveFrameState,
} from "../telemetry/telemetry-view-model.ts";

export default function TiresView({ state }: { state: LiveFrameState }) {
  const model = buildTires();
  return (
    <>
      <ViewHeader
        title="Tires"
        summary="Four-corner tire channels from canonical telemetry."
      />
      <EmptyTelemetryState state={state} />
      {model.available ? null : <UnavailableChannel reason={model.reason} />}

      <TelemetrySection
        eyebrow="FL · FR · RL · RR"
        title="Corners"
        description="Corner positions are fixed by the view model and rendered in order, so a corner cannot be swapped in presentation."
      >
        <WheelTelemetry model={model} />
      </TelemetrySection>
    </>
  );
}
