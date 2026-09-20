import { EmptyTelemetryState } from "../components/EmptyTelemetryState";
import { InputBar, RangeBar } from "../components/InputBar";
import { MetricGrid } from "../components/MetricCard";
import { TelemetrySection, ViewHeader } from "../components/TelemetrySection";
import {
  buildOverview,
  type LiveFrameState,
} from "../telemetry/telemetry-view-model.ts";

/// The main live-driving screen: a small number of large, canonical readings
/// that stay legible at a glance.
export default function OverviewView({ state }: { state: LiveFrameState }) {
  const model = buildOverview(state);
  return (
    <>
      <ViewHeader
        title="Overview"
        summary="Canonical live telemetry. Every reading comes from the normalized TelemetryFrame; no adapter value appears here."
      />
      <EmptyTelemetryState state={state} />

      <div className="hero-row">
        <section className="panel hero hero-primary">
          <p className="hero-label">Speed</p>
          <p className="hero-value">
            {model.speedKmh}
            <em>km/h</em>
          </p>
        </section>
        <section className="panel hero">
          <p className="hero-label">Engine speed</p>
          <p className="hero-value">
            {model.rpm}
            <em>rpm</em>
          </p>
          <RangeBar fraction={model.rpmFraction} label="Engine speed" />
          <p className="hero-footnote">Max {model.maxRpm} rpm</p>
        </section>
        <section
          className={`panel hero hero-gear${
            model.gear.available ? "" : " is-unavailable"
          }`}
        >
          <p className="hero-label">Gear</p>
          <p className="hero-value">{model.gear.value}</p>
          {model.gear.note ? (
            <p className="hero-footnote">{model.gear.note}</p>
          ) : null}
        </section>
      </div>

      <TelemetrySection
        eyebrow="CANONICAL NORMALIZED CONTROLS"
        title="Driver inputs"
      >
        <div className="input-stack">
          {model.inputs.map((input) => (
            <InputBar key={input.key} metric={input} />
          ))}
        </div>
      </TelemetrySection>

      <TelemetrySection eyebrow="CANONICAL IDENTITY" title="Vehicle">
        <MetricGrid metrics={model.identity} columns={2} />
        <p className="section-footnote">
          Car class, performance index, drivetrain and cylinder codes are
          adapter values with no established meaning. They are shown in
          Diagnostics rather than presented here as vehicle facts.
        </p>
      </TelemetrySection>
    </>
  );
}
