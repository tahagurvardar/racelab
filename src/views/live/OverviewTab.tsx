import { ControlBar } from "../../components/live/ControlBar";
import { NotAvailable } from "../../components/live/NotAvailable";
import { Readout } from "../../components/live/Readout";
import { RpmBar } from "../../components/live/RpmBar";
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
      <section className="live-panel overview-drive" aria-label="Driving state">
        <div className="drive-main">
          <Readout reading={model.speed} size="hero" className="drive-speed" />
          <div className="drive-rpm">
            <Readout reading={model.rpm} size="display" />
            <RpmBar fraction={model.rpm.fraction} max={model.rpm.max} />
          </div>
        </div>
        <div className="drive-secondary">
          <Readout reading={model.power} size="figure" />
          <Readout reading={model.torque} size="figure" />
          <Readout reading={model.gear} size="figure" />
        </div>
      </section>

      <section
        className="live-panel overview-inputs"
        aria-label="Driver inputs"
      >
        <h2 className="live-section-title">Inputs</h2>
        <div className="inputs-primary">
          {model.pedals.map((reading) => (
            <ControlBar key={reading.key} reading={reading} />
          ))}
          <ControlBar reading={model.steering} />
        </div>
        <div className="inputs-auxiliary">
          {model.auxiliary.map((reading) => (
            <ControlBar key={reading.key} reading={reading} size="compact" />
          ))}
        </div>
      </section>

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
            className={`context-state tone-${context.recording.tone}${
              context.recording.active ? " is-recording" : ""
            }`}
          >
            <span className="context-label">Recording</span>
            <span className="context-value">{context.recording.value}</span>
          </p>
        </div>
        <div className="context-group">
          {model.race.map((reading) => (
            <Readout key={reading.key} reading={reading} size="compact" />
          ))}
        </div>
        <div className="context-group">
          {model.identity.map((reading) => (
            <Readout key={reading.key} reading={reading} size="compact" />
          ))}
        </div>
      </section>

      <div className="overview-notes">
        <p className="live-footnote">
          Lap and position are counters: both read 0 outside a race, which is a
          measured value rather than a missing one.
        </p>
        <NotAvailable
          items={[
            // Gear already has its reading above; only its reason is here.
            ...(model.gear.available
              ? []
              : [{ key: "gear", label: "Gear", note: model.gear.note }]),
            ...model.unavailable,
          ]}
        />
      </div>
    </div>
  );
}
