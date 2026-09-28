import { EmptyTelemetryState } from "../components/EmptyTelemetryState";
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

      <TelemetrySection
        eyebrow="CANONICAL TIMING"
        title="Elapsed time"
        description="Race time is canonical seconds: the source clock advances 1:1 with the game timestamp across every captured session. No lap delta, sector, corner or racing-line analysis exists in RaceLab."
      >
        <MetricGrid metrics={model.timing} columns={3} />
      </TelemetrySection>

      <TelemetrySection eyebrow="CANONICAL RACE STATE" title="Standing">
        <MetricGrid metrics={model.standing} columns={2} />
        <p className="section-footnote">
          Lap and position are counters, so there is no unit to establish. Both
          read 0 outside a race, which is a measured value rather than an
          unavailable one.
        </p>
      </TelemetrySection>

      <TelemetrySection
        eyebrow="NOT IN CANONICAL TELEMETRY"
        title="Lap timing and distance"
        description="FH6 transmits these and the adapter preserves them, but no capture has ever carried a non-zero value, so their unit and sentinel conventions are unestablished. They stay raw adapter values in Diagnostics rather than being shown here as zeros."
      >
        <MetricGrid metrics={model.unavailable} columns={4} />
      </TelemetrySection>
    </>
  );
}
