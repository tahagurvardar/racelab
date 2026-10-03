import { NotAvailable } from "../../components/live/NotAvailable";
import { Readout } from "../../components/live/Readout";
import { RpmBar } from "../../components/live/RpmBar";
import { powertrainLayout } from "../../telemetry/live-layout.ts";
import type { LiveFrameState } from "../../telemetry/telemetry-view-model.ts";

/// Engine output first — engine speed against its reported range, then power
/// and torque — and the vehicle's static configuration codes below it.
export default function PowertrainTab({ state }: { state: LiveFrameState }) {
  const model = powertrainLayout(state);
  return (
    <div className="live-powertrain">
      <section className="live-panel powertrain-engine" aria-label="Engine">
        <div className="engine-speed">
          <Readout reading={model.rpm} size="hero" />
          <RpmBar
            fraction={model.rpmFraction}
            idle={model.idle}
            max={model.max}
          />
        </div>
        <div className="engine-output">
          <div className="engine-output-item">
            <Readout reading={model.power} size="display" />
            <Readout
              reading={model.powerWatts}
              size="compact"
              className="readout-detail"
              hideLabel
            />
          </div>
          <div className="engine-output-item">
            <Readout reading={model.torque} size="display" />
          </div>
        </div>
        <p className="live-footnote engine-note">
          Power and torque units were confirmed from real Forza Horizon 6
          recordings (power = torque × engine speed holds throughout); kilowatts
          are the same watts, converted for display. The range bar runs from the
          reported idle to the reported maximum and marks no shift point.
        </p>
      </section>

      <section
        className="live-panel powertrain-vehicle"
        aria-label="Vehicle configuration"
      >
        <h2 className="live-section-title">Vehicle configuration</h2>
        <div className="vehicle-codes">
          {model.configuration.map((reading) => (
            <Readout key={reading.key} reading={reading} size="value" />
          ))}
        </div>
        <p className="live-footnote">
          The codes the game sent, shown as codes. RaceLab has no class,
          drivetrain or model database and never turns a code into a name it
          cannot substantiate.
        </p>
      </section>

      <NotAvailable items={model.unavailable} />
    </div>
  );
}
