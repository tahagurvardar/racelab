import { memo } from "react";
import { useLab } from "../../hooks/use-lab.ts";
import type { LabController, LapSlot } from "../../lab-controller.ts";
import {
  formatChannel,
  gearText,
  steeringText,
  valueAt,
  yDomain,
} from "../../telemetry-lab.ts";
import { LabEmpty, LabPanel, SlotTitle } from "./parts";

/// The right column: the current lap and the reference lap side by side, at
/// the shared cursor. The reference half is always present; without a
/// reference lap it says so instead of disappearing.
export function LabCompareColumn({
  controller,
}: {
  controller: LabController;
}) {
  return (
    <aside className="lab-column lab-compare" aria-label="Lap comparison">
      <SyncToggle controller={controller} />
      <div className="lab-compare-grid">
        <Slot controller={controller} slot="current" />
        <Slot controller={controller} slot="reference" />
      </div>
    </aside>
  );
}

function SyncToggle({ controller }: { controller: LabController }) {
  const axis = useLab(controller, (state) => state.axis);
  return (
    <div className="lab-sync" role="radiogroup" aria-label="Chart axis">
      {(
        [
          ["distance", "Distance sync"],
          ["time", "Time sync"],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="radio"
          aria-checked={axis === id}
          className={axis === id ? "is-active" : undefined}
          onClick={() => controller.setAxis(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const Slot = memo(function Slot({
  controller,
  slot,
}: {
  controller: LabController;
  slot: LapSlot;
}) {
  const lap = useLab(controller, (state) => state[slot].lap);
  const status = useLab(controller, (state) => state[slot].status);
  const error = useLab(controller, (state) => state[slot].error);
  const tone = slot;
  const name = slot === "current" ? "Current" : "Reference";
  const blocker =
    lap == null
      ? slot === "reference"
        ? "Choose a reference lap in Analysis laps."
        : "This session has no lap to show."
      : status === "error"
        ? `This lap could not be read: ${error}`
        : null;

  return (
    <div className={`lab-slot slot-${slot}`} role="group" aria-label={name}>
      <LabPanel
        tone={tone}
        className="lab-gauge-panel"
        title={
          <SlotTitle slot={slot}>
            {slot === "current" ? "Current lap" : "Reference"}
            {lap != null ? (
              <span className="lab-slot-lap"> · Lap {lap}</span>
            ) : null}
          </SlotTitle>
        }
      >
        <SpeedGauge controller={controller} slot={slot} />
        {blocker ? <LabEmpty>{blocker}</LabEmpty> : null}
      </LabPanel>

      <LabPanel
        tone={tone}
        className="lab-steering-panel"
        title={
          <SlotTitle slot={slot}>
            {slot === "current" ? "Steering" : "Reference"}
          </SlotTitle>
        }
      >
        <Steering controller={controller} slot={slot} />
      </LabPanel>

      <LabPanel
        tone={tone}
        className="lab-tyres-panel"
        title={
          <SlotTitle slot={slot}>
            {slot === "current" ? "Tyres state" : "Ref tyres"}
          </SlotTitle>
        }
      >
        <Tyres />
      </LabPanel>

      <LabPanel
        tone={tone}
        className="lab-fuel-panel"
        title={
          <SlotTitle slot={slot}>
            {slot === "current" ? "Fuel" : "Ref fuel"}
          </SlotTitle>
        }
        aside={<span className="lab-pending">Not linked</span>}
      >
        <div className="lab-fuel-bar" aria-hidden="true">
          <span className="lab-fuel-fill" />
        </div>
        <p className="lab-quiet">
          F1 25 sends fuel without a unit or tank size.
        </p>
      </LabPanel>
    </div>
  );
});

const ARC = { radius: 64, sweep: 260 };

/// An arc from the gauge's start angle covering `fraction` of the sweep.
function arc(fraction: number, radius: number): string {
  const start = 90 + (360 - ARC.sweep) / 2;
  const end = start + ARC.sweep * Math.min(1, Math.max(0, fraction));
  const point = (degrees: number) => {
    const radians = (degrees * Math.PI) / 180;
    return `${(80 + radius * Math.cos(radians)).toFixed(2)} ${(80 + radius * Math.sin(radians)).toFixed(2)}`;
  };
  const large = end - start > 180 ? 1 : 0;
  return `M${point(start)} A${radius} ${radius} 0 ${large} 1 ${point(end)}`;
}

function SpeedGauge({
  controller,
  slot,
}: {
  controller: LabController;
  slot: LapSlot;
}) {
  const cursor = useLab(controller, (state) => state.cursor);
  const trace = useLab(controller, (state) => state[slot].trace);
  const other = useLab(controller, (state) =>
    slot === "current" ? state.reference.trace : state.current.trace,
  );
  const at = (id: "speed" | "rpm" | "gear") =>
    cursor == null ? null : valueAt(trace, id, cursor);
  const speed = at("speed");
  const rpm = at("rpm");
  const gear = at("gear");
  // Both gauges share one scale, so the two arcs compare honestly.
  const speedMax = yDomain([trace, other], "speed").y1;
  const rpmMax = yDomain([trace, other], "rpm").y1;
  return (
    <div className="lab-gauge">
      <svg viewBox="0 0 160 160" aria-hidden="true">
        <path className="lab-gauge-track" d={arc(1, ARC.radius)} />
        <path
          className="lab-gauge-track is-inner"
          d={arc(1, ARC.radius - 13)}
        />
        {speed != null ? (
          <path
            className="lab-gauge-value"
            d={arc(speed / speedMax, ARC.radius)}
          />
        ) : null}
        {rpm != null ? (
          <path
            className="lab-gauge-value is-inner"
            d={arc(rpm / rpmMax, ARC.radius - 13)}
          />
        ) : null}
      </svg>
      <span className="lab-gauge-tag">Speed</span>
      <div className="lab-gauge-readings">
        <span className="lab-gauge-speed">{formatChannel("speed", speed)}</span>
        <span className="lab-gauge-unit">km/h</span>
        <span className="lab-gauge-rpm">{formatChannel("rpm", rpm)}</span>
        <span className="lab-gauge-unit">rpm</span>
        <span className="lab-gauge-unit is-gear">Gear</span>
        <span className="lab-gauge-gear">{gearText(gear)}</span>
      </div>
    </div>
  );
}

function Steering({
  controller,
  slot,
}: {
  controller: LabController;
  slot: LapSlot;
}) {
  const cursor = useLab(controller, (state) => state.cursor);
  const trace = useLab(controller, (state) => state[slot].trace);
  const value = cursor == null ? null : valueAt(trace, "steering", cursor);
  const share = value == null ? 0 : Math.max(-1, Math.min(1, value));
  return (
    <div className="lab-steering">
      <div className="lab-wheel-tile" aria-hidden="true">
        {/* A generic formula wheel, drawn for RaceLab: grips, a display,
            buttons and rotaries. Not any manufacturer's wheel. */}
        <svg viewBox="0 0 64 64" className="lab-wheel">
          <path
            className="lab-wheel-grip"
            d="M5 21c-3 7-3 16 1 23l6-1c-3-7-3-14 0-21z"
          />
          <path
            className="lab-wheel-grip"
            d="M59 21c3 7 3 16-1 23l-6-1c3-7 3-14 0-21z"
          />
          <path
            className="lab-wheel-rim"
            d="M10 22c0-4 3-7 8-7h28c5 0 8 3 8 7v9c0 8-4 13-10 15l-5 2H25l-5-2c-6-2-10-7-10-15z"
          />
          <rect
            className="lab-wheel-screen"
            x="23"
            y="20"
            width="18"
            height="10"
            rx="2"
          />
          <circle className="lab-wheel-dot" cx="16.5" cy="24" r="2" />
          <circle className="lab-wheel-dot" cx="16.5" cy="31" r="2" />
          <circle className="lab-wheel-dot" cx="47.5" cy="24" r="2" />
          <circle className="lab-wheel-dot" cx="47.5" cy="31" r="2" />
          <circle className="lab-wheel-rotary" cx="25" cy="38" r="3.2" />
          <circle className="lab-wheel-rotary" cx="39" cy="38" r="3.2" />
          <circle className="lab-wheel-dot is-accent" cx="32" cy="38" r="1.8" />
        </svg>
      </div>
      <div
        className="lab-steer-bar"
        role="meter"
        aria-label="Steering"
        aria-valuemin={-100}
        aria-valuemax={100}
        aria-valuenow={value == null ? undefined : Math.round(share * 100)}
        aria-valuetext={steeringText(value)}
      >
        <span
          className="lab-steer-fill"
          style={{
            left: `${50 + Math.min(0, share) * 50}%`,
            width: `${Math.abs(share) * 50}%`,
          }}
        />
        <span className="lab-steer-centre" />
      </div>
      <p className="lab-steer-value">{steeringText(value)}</p>
      <p className="lab-steer-note">Lock angle not recorded</p>
    </div>
  );
}

const CORNERS = ["FL", "FR", "RL", "RR"] as const;

/// Tyre pressures, compound, wear and temperatures are in the recording but
/// not in the trace yet: the structure is final, every value unavailable.
function Tyres() {
  return (
    <>
      <div className="lab-tyres">
        {CORNERS.map((corner) => (
          <div
            key={corner}
            className="lab-tyre is-unavailable"
            role="group"
            aria-label={`${corner}: not linked yet`}
          >
            <span className="lab-tyre-corner">{corner}</span>
            <span className="lab-tyre-ring" aria-hidden="true" />
          </div>
        ))}
      </div>
      <p className="lab-quiet">
        Pressure, compound, wear and temperature are in the recording and arrive
        in a later milestone.
      </p>
    </>
  );
}
