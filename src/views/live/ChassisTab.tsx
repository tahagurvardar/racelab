import { NotAvailable } from "../../components/live/NotAvailable";
import { Readout } from "../../components/live/Readout";
import {
  chassisLayout,
  type CornerLayout,
} from "../../telemetry/live-layout.ts";
import type { LiveFrameState } from "../../telemetry/telemetry-view-model.ts";

/// Normalized travel as a vertical bar: 0 at full extension (bottom), 1 at
/// full compression (top). The canonical range is 0..1, so the bar has a real
/// scale; the printed value beside it is never clamped.
function TravelBar({ corner }: { corner: CornerLayout }) {
  const { travelFraction: fraction, travelNormalized } = corner;
  return (
    <span
      className={`travel-bar${fraction == null ? " is-unavailable" : ""}`}
      role="img"
      aria-label={`${corner.label} normalized suspension travel: ${
        fraction == null ? "unavailable" : travelNormalized.value
      }`}
    >
      {fraction == null ? null : (
        <span className="travel-bar-fill" style={{ height: `${fraction}%` }} />
      )}
    </span>
  );
}

/// One wheel. Every corner has exactly the same internal layout, so the same
/// channel sits in the same place in all four — comparison is by position.
function Corner({ corner }: { corner: CornerLayout }) {
  return (
    <section
      className={`live-panel corner corner-${corner.corner.toLowerCase()}`}
      aria-label={`${corner.label} (${corner.corner})`}
      data-corner={corner.corner}
    >
      <header className="corner-head">
        <span className="corner-code">{corner.corner}</span>
        <span className="corner-name">{corner.label}</span>
      </header>
      <div className="corner-tire">
        <Readout
          reading={corner.temperature}
          size="figure"
          className="corner-temperature"
        />
        <div className="corner-slip">
          <Readout reading={corner.slipRatio} size="compact" />
          <Readout reading={corner.slipAngle} size="compact" />
          <Readout reading={corner.combinedSlip} size="compact" />
        </div>
        <div className="corner-rotation">
          <Readout reading={corner.rotation} size="compact" />
          <Readout
            reading={corner.rotationRpm}
            size="compact"
            className="readout-detail"
            hideLabel
          />
        </div>
      </div>
      <div className="corner-suspension">
        <TravelBar corner={corner} />
        <div className="corner-travel">
          <Readout reading={corner.travel} size="value" />
          <Readout reading={corner.travelNormalized} size="compact" />
        </div>
      </div>
    </section>
  );
}

/// A plan-view outline between the corners, for orientation only.
function ChassisOutline() {
  return (
    <svg
      className="chassis-outline"
      viewBox="0 0 64 160"
      fill="none"
      aria-hidden="true"
    >
      <rect x="14" y="10" width="36" height="140" rx="12" />
      <rect x="4" y="26" width="8" height="26" rx="2" />
      <rect x="52" y="26" width="8" height="26" rx="2" />
      <rect x="4" y="108" width="8" height="26" rx="2" />
      <rect x="52" y="108" width="8" height="26" rx="2" />
      <path d="M32 22 L32 34" />
    </svg>
  );
}

/// The four corners in their physical arrangement: front axle above, rear
/// below, left on the left. Rendered in FL, FR, RL, RR order from the layout;
/// nothing here sorts or indexes the wheels.
export default function ChassisTab({ state }: { state: LiveFrameState }) {
  const model = chassisLayout(state);
  const [fl, fr, rl, rr] = model.corners;
  return (
    <div className="live-chassis">
      <p className="axle-label">Front</p>
      <div className="chassis-grid">
        <Corner corner={fl} />
        <ChassisOutline />
        <Corner corner={fr} />
        <Corner corner={rl} />
        <Corner corner={rr} />
      </div>
      <p className="axle-label">Rear</p>

      <div className="chassis-notes">
        <p className="live-footnote">
          Temperature in °C. Slip ratio, slip angle and combined slip have no
          unit and are shown as numbers, with no range or rating attached.
          Normalized travel runs from 0 at full extension to 1 at full
          compression; travel in millimetres is the recorded metres, converted
          for display. No value is interpreted as a tyre or suspension
          condition.
        </p>
        <p className="live-footnote">
          Which corner each value belongs to was established from real Forza
          Horizon 6 recordings and is applied in one place, so corners are never
          swapped on screen.
        </p>
        <NotAvailable items={model.unavailable} />
      </div>
    </div>
  );
}
