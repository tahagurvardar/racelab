import { CoreDrive } from "../../../components/live/CoreDrive";
import { DriverInput } from "../../../components/live/DriverInput";
import { Readout } from "../../../components/live/Readout";
import { TyreReadout } from "../../../components/live/TyreReadout";
import { NotAvailable } from "../../../components/live/NotAvailable";
import { Region } from "../../../components/Region";
import {
  f1OverviewLayout,
  f1TyresLayout,
  f1RaceLayout,
} from "../../../telemetry/f1-live-layout.ts";
import type { F1LiveSnapshot } from "../../../telemetry/f1-player.ts";
import { f1RecordingPresentation } from "../../../telemetry/f1-recording.ts";
import { useF1Recorder } from "../../../hooks/use-f1-recorder-status.ts";
import { FamilyLine } from "./parts";

/// The F1 25 recorder's state, in words. Subscribes on its own so a recorder
/// update never re-renders the live readings around it.
function F1RecordingLine() {
  const value = useF1Recorder((state) => f1RecordingPresentation(state).value);
  const tone = useF1Recorder((state) => f1RecordingPresentation(state).tone);
  return (
    <p className={`context-state tone-${tone}`}>
      <span className="context-label">Recording</span>
      <span className="context-value">{value}</span>
    </p>
  );
}

export default function F1OverviewTab({
  live,
}: {
  live: F1LiveSnapshot | null;
}) {
  const model = f1OverviewLayout(live);
  const tyres = f1TyresLayout(live);
  const sectors =
    f1RaceLayout(live)
      .groups.find((group) => group.key === "lap")
      ?.readings.filter(
        (reading) =>
          reading.key === "sector1_time" || reading.key === "sector2_time",
      ) ?? [];
  return (
    <div className="live-overview f1-overview">
      <CoreDrive speed={model.speed} gear={model.gear} rpm={model.rpm} f1 />
      <Region title="Race State & Timing" className="overview-timing f1-timing">
        <div className="timing-readings">
          {model.context.map((reading) => (
            <Readout
              key={reading.key}
              reading={reading}
              size={
                reading.key === "car_position"
                  ? "display"
                  : reading.key === "current_lap_time_ms"
                    ? "figure"
                    : "value"
              }
            />
          ))}
        </div>
        <div className="timing-sectors">
          {sectors.map((reading) => (
            <Readout
              key={reading.key}
              reading={{ ...reading, role: "mirror" }}
              size="compact"
            />
          ))}
        </div>
        <div className="timing-availability">
          <span className="readout-label">Performance delta</span>
          <span className="readout-value">—</span>
          <p className="live-footnote">Reference lap not available.</p>
        </div>
      </Region>
      <DriverInput
        pedals={model.pedals}
        steering={model.steering}
        auxiliary={[model.clutch]}
      />
      <Region title="Energy & Car State" className="f1-car-state">
        <div className="f1-car-group" aria-label="ERS">
          {model.ers.map((reading) => (
            <Readout key={reading.key} reading={reading} />
          ))}
        </div>
        <div className="f1-car-group" aria-label="Fuel and brakes">
          {model.car.map((reading) => (
            <Readout key={reading.key} reading={reading} />
          ))}
        </div>
        <div className="f1-car-group" aria-label="DRS">
          {model.drs.map((reading) => (
            <Readout key={reading.key} reading={reading} />
          ))}
        </div>
      </Region>
      <Region title="Tyres" className="overview-tyres">
        <div className="tyres-compact-grid">
          {tyres.corners.map((corner) => (
            <TyreReadout
              key={corner.corner}
              corner={corner.corner}
              temperature={corner.surface}
              pressure={corner.pressure}
            />
          ))}
        </div>
        <div className="tyres-context">
          {tyres.tyreSet.map((reading) => (
            <Readout
              key={reading.key}
              reading={{ ...reading, role: "mirror" }}
              size="compact"
            />
          ))}
        </div>
      </Region>
      <section className="overview-context" aria-label="Recording">
        <F1RecordingLine />
      </section>
      <div className="overview-notes">
        <FamilyLine families={model.families} />
        <details className="measurement-notes">
          <summary>Measurement availability</summary>
          <p className="live-footnote">
            ERS store is the game&rsquo;s joules shown in megajoules (1 MJ =
            1,000,000 J). F1 25 states no unit for fuel in the tank, so it is
            shown as sent. DRS, DRS allowed and the distance to DRS are three
            separate values from the game.
          </p>
          <NotAvailable items={model.notes} />
        </details>
      </div>
    </div>
  );
}
