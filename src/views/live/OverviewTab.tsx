import { CoreDrive } from "../../components/live/CoreDrive";
import { DriverInput } from "../../components/live/DriverInput";
import { Region } from "../../components/Region";
import { NotAvailable } from "../../components/live/NotAvailable";
import { Readout } from "../../components/live/Readout";
import { overviewLayout } from "../../telemetry/live-layout.ts";
import type {
  LiveFrameState,
  StatusTone,
} from "../../telemetry/telemetry-view-model.ts";

/// Session and recording context, as the top bar's own presentation functions
/// state it. Not a frame field: it comes from the live snapshot and the
/// recorder.
export interface SessionContext {
  session: { value: string; tone: StatusTone };
  duration: string;
  recording: { value: string; tone: StatusTone; active: boolean };
}

/// The primary driving screen. One dominant driving-state region (speed, then
/// engine speed with its range, then output), the driver's inputs beside it,
/// and a single quiet strip of session and race context underneath.
export default function OverviewTab({
  state,
  context,
}: {
  state: LiveFrameState;
  context: SessionContext;
}) {
  const model = overviewLayout(state);
  return (
    <div className="live-overview">
      <CoreDrive speed={model.speed} gear={model.gear} rpm={model.rpm} />
      <DriverInput
        pedals={model.pedals}
        steering={model.steering}
        auxiliary={model.auxiliary}
      />
      <Region title="Timing & Race State" className="overview-timing">
        <div className="timing-readings">
          {model.race.map((reading) => (
            <Readout
              key={reading.key}
              reading={reading}
              size={reading.key === "race-time-precise" ? "figure" : "value"}
            />
          ))}
        </div>
        <div className="timing-availability">
          <span className="readout-label">Lap time / delta</span>
          <span className="readout-value">—</span>
          <p className="live-footnote">
            Not available for Forza Horizon 6 yet.
          </p>
        </div>
      </Region>
      <Region title="Powertrain" className="overview-output">
        <div className="drive-secondary">
          <Readout reading={model.power} size="figure" />
          <Readout reading={model.torque} size="figure" />
        </div>
      </Region>
      <section className="overview-context" aria-label="Session and race">
        <div className="context-group">
          <p className={`context-state tone-${context.session.tone}`}>
            <span className="context-label">Session</span>
            <span className="context-value">
              {context.session.value}
              <span className="context-duration">{context.duration}</span>
            </span>
          </p>
          <p
            className={`context-state tone-${context.recording.tone}${context.recording.active ? " is-recording" : ""}`}
          >
            <span className="context-label">Recording</span>
            <span className="context-value">{context.recording.value}</span>
          </p>
        </div>
        <div className="context-group">
          {model.identity.map((reading) => (
            <Readout key={reading.key} reading={reading} size="compact" />
          ))}
        </div>
      </section>
      <details className="overview-notes measurement-notes">
        <summary>Measurement availability</summary>
        <p className="live-footnote">
          Lap and position are counters: both read 0 outside a race, which is a
          measured value rather than a missing one.
        </p>
        <NotAvailable
          items={[
            ...(model.gear.available
              ? []
              : [{ key: "gear", label: "Gear", note: model.gear.note }]),
            ...model.unavailable,
          ]}
        />
      </details>
    </div>
  );
}
