import { EmptyTelemetryState } from "../components/EmptyTelemetryState";
import { InputBar } from "../components/InputBar";
import { TelemetrySection, ViewHeader } from "../components/TelemetrySection";
import {
  buildInputs,
  type LiveFrameState,
} from "../telemetry/telemetry-view-model.ts";

export default function InputsView({ state }: { state: LiveFrameState }) {
  const model = buildInputs(state);
  return (
    <>
      <ViewHeader
        title="Inputs"
        summary="Canonical normalized driver inputs. Pedals and handbrake are 0..100%; steering is -100..100%."
      />
      <EmptyTelemetryState state={state} />

      <TelemetrySection
        eyebrow="CANONICAL NORMALIZED CONTROLS"
        title="Driver inputs"
        description="Normalized values only. The raw FH6 input bytes are engineering data and stay in Diagnostics."
      >
        <div className="input-stack input-stack-large">
          {model.bars.map((metric) => (
            <InputBar key={metric.key} metric={metric} />
          ))}
        </div>
        <p className="section-footnote">
          An unavailable input shows no bar and no percentage. It is never drawn
          as 0%.
        </p>
      </TelemetrySection>
    </>
  );
}
