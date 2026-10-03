import { Readout } from "../../../components/live/Readout";
import {
  f1TyresLayout,
  type F1CornerLayout,
} from "../../../telemetry/f1-live-layout.ts";
import type { F1LiveSnapshot } from "../../../telemetry/f1-player.ts";
import { F1Panel, FamilyLine } from "./parts";

/// One wheel. All four have the same internal layout, so a channel sits in
/// the same place on every corner and comparison is by position.
function Corner({ corner }: { corner: F1CornerLayout }) {
  return (
    <section
      className={`live-panel corner f1-corner corner-${corner.corner.toLowerCase()}`}
      aria-label={`${corner.label} (${corner.corner})`}
      data-corner={corner.corner}
    >
      <header className="corner-head">
        <span className="corner-code" aria-hidden="true">
          {corner.corner}
        </span>
        <span className="corner-name">{corner.label}</span>
      </header>
      <div className="f1-corner-temps">
        <Readout reading={corner.surface} size="figure" />
        <Readout reading={corner.inner} size="figure" />
      </div>
      <div className="f1-corner-values">
        <Readout reading={corner.pressure} size="compact" />
        <Readout reading={corner.brake} size="compact" />
        <Readout reading={corner.wheelSpeed} size="compact" />
        <Readout reading={corner.slipRatio} size="compact" />
        <Readout reading={corner.slipAngle} size="compact" />
        <Readout reading={corner.suspension} size="compact" />
        <Readout reading={corner.vertForce} size="compact" />
        <Readout reading={corner.surfaceType} size="compact" />
      </div>
    </section>
  );
}

/// The four corners in their physical arrangement — front axle above, left
/// on the left — from F1 25's one corner mapping (`f1-wheels.ts`). Nothing
/// here indexes or sorts a wheel. Values only: no temperature band, no tyre
/// condition, no slip called wheelspin or lockup.
export default function F1TyresTab({ live }: { live: F1LiveSnapshot | null }) {
  const model = f1TyresLayout(live);
  const [fl, fr, rl, rr] = model.corners;
  return (
    <div className="f1-tyres">
      <F1Panel
        title="Tyre set"
        family={model.families[2]}
        className="f1-tyre-set"
      >
        <div className="f1-readings">
          {model.tyreSet.map((reading) => (
            <Readout key={reading.key} reading={reading} size="value" />
          ))}
        </div>
      </F1Panel>
      <p className="axle-label">Front</p>
      <div className="f1-corner-grid">
        <Corner corner={fl} />
        <Corner corner={fr} />
        <Corner corner={rl} />
        <Corner corner={rr} />
      </div>
      <p className="axle-label">Rear</p>
      <div className="chassis-notes">
        <FamilyLine families={model.families} />
        <p className="live-footnote">
          Temperatures in °C and pressures in psi, as F1 25 sends them. Wheel
          speed, slip ratio, slip angle, suspension position and vertical force
          are shown as sent: F1 25 states no unit for them, and no value is
          interpreted as a tyre or handling condition.
        </p>
        <p className="live-footnote">
          F1 25 sends its wheels rear-left first; each value is placed on its
          corner in one place, checked against real recordings.
        </p>
      </div>
    </div>
  );
}
