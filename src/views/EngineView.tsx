import { EmptyTelemetryState } from "../components/EmptyTelemetryState";
import { RangeBar } from "../components/InputBar";
import { MetricGrid } from "../components/MetricCard";
import { TelemetrySection, ViewHeader } from "../components/TelemetrySection";
import {
  buildEngine,
  type LiveFrameState,
} from "../telemetry/telemetry-view-model.ts";

export default function EngineView({ state }: { state: LiveFrameState }) {
  const model = buildEngine(state);
  return (
    <>
      <ViewHeader
        title="Engine"
        summary="Canonical engine telemetry. RPM is the only engine channel the canonical TelemetryFrame carries today."
      />
      <EmptyTelemetryState state={state} />

      <div className="hero-row">
        <section className="panel hero hero-primary">
          <p className="hero-label">Engine speed</p>
          <p className="hero-value">
            {model.rpm}
            <em>rpm</em>
          </p>
          <RangeBar fraction={model.rpmFraction} label="Engine speed" />
          <p className="hero-footnote">
            Bar position is current RPM within the reported idle-to-maximum
            range. It is drawn only when both limits are available.
          </p>
        </section>
      </div>

      <TelemetrySection eyebrow="CANONICAL ENGINE" title="RPM range">
        <MetricGrid metrics={model.range} columns={3} />
      </TelemetrySection>

      <TelemetrySection
        eyebrow="NOT IN CANONICAL TELEMETRY"
        title="Output and fluids"
        description="FH6 transmits power, torque, boost and fuel, but their units are not established, so they are not promoted into canonical telemetry and no W-to-kW conversion is applied anywhere in the product. The decoded raw values are available in Diagnostics."
      >
        <MetricGrid metrics={model.output} columns={4} />
      </TelemetrySection>
    </>
  );
}
