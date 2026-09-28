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
        summary="Canonical engine telemetry: RPM, power and torque."
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
        eyebrow="CANONICAL OUTPUT"
        title="Power and torque"
        description="Canonical power is watts and canonical torque is newton-metres, established by power = torque × angular velocity holding across real FH6 captures. Kilowatts is an exact presentation of the same canonical watts."
      >
        <MetricGrid metrics={model.output} columns={3} />
      </TelemetrySection>

      <TelemetrySection
        eyebrow="NOT IN CANONICAL TELEMETRY"
        title="Fluids and boost"
        description="FH6 transmits boost and fuel, but their units are not established — boost saturates at a constant with no known scale, and fuel held a single value in every captured packet. Neither is promoted; the decoded raw values stay in Diagnostics."
      >
        <MetricGrid metrics={model.unavailable} columns={2} />
      </TelemetrySection>
    </>
  );
}
