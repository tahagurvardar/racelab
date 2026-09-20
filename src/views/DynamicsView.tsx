import { EmptyTelemetryState } from "../components/EmptyTelemetryState";
import { MetricGrid } from "../components/MetricCard";
import { TelemetrySection, ViewHeader } from "../components/TelemetrySection";
import {
  buildDynamics,
  type LiveFrameState,
} from "../telemetry/telemetry-view-model.ts";

export default function DynamicsView({ state }: { state: LiveFrameState }) {
  const model = buildDynamics(state);
  return (
    <>
      <ViewHeader
        title="Dynamics"
        summary="Canonical motion, attitude and position in SI units, in the source axes exactly as received."
      />
      <EmptyTelemetryState state={state} />

      <div className="hero-row">
        <section className="panel hero hero-primary">
          <p className="hero-label">Speed</p>
          <p className="hero-value">
            {model.speedKmh}
            <em>km/h</em>
          </p>
          <p className="hero-footnote">{model.speedMps} m/s canonical</p>
        </section>
      </div>

      <TelemetrySection
        eyebrow="CANONICAL ACCELERATION"
        title="Acceleration"
        description="Components are named X, Y and Z because the vehicle-axis orientation of this vector is not established. No component is called lateral or longitudinal."
      >
        <MetricGrid metrics={model.acceleration} columns={3} />
        <p className="section-subtitle">Same components in g</p>
        <MetricGrid metrics={model.accelerationG} columns={3} />
        <p className="section-footnote">
          g = m/s² ÷ 9.80665. This is a display conversion; the canonical value
          stays in m/s².
        </p>
      </TelemetrySection>

      <TelemetrySection eyebrow="CANONICAL VELOCITY" title="Velocity">
        <MetricGrid metrics={model.velocity} columns={3} />
      </TelemetrySection>

      <TelemetrySection
        eyebrow="CANONICAL ANGULAR VELOCITY"
        title="Angular velocity"
      >
        <MetricGrid metrics={model.angularVelocity} columns={3} />
      </TelemetrySection>

      <TelemetrySection
        eyebrow="CANONICAL ORIENTATION"
        title="Attitude"
        description="The canonical orientation vector is documented as x = yaw, y = pitch, z = roll. Values are converted from radians to degrees for display only."
      >
        <MetricGrid metrics={model.orientation} columns={3} />
      </TelemetrySection>

      <TelemetrySection
        eyebrow="CANONICAL POSITION"
        title="Position"
        description="Metres in the source coordinate system. No coordinate transform is applied."
      >
        <MetricGrid metrics={model.position} columns={3} />
      </TelemetrySection>
    </>
  );
}
