import { memo, useMemo, type ComponentType } from "react";
import { useLab } from "../../hooks/use-lab.ts";
import type { LabController, LapSlot } from "../../lab-controller.ts";
import {
  formatChannel,
  gearText,
  seriesPath,
  valueAt,
  type SessionTrace,
} from "../../telemetry-lab.ts";
import { Icon, type IconName } from "../../components/shell/Icon";
import { cursorText, useLabDomain, useSessionInfo } from "./parts";

/// A way of drawing the circuit. M2 has one: the honest "no geometry" view.
/// A renderer that draws a real circuit needs recorded positions (F1 25
/// Motion, packet 0), which RaceLab does not record yet; a 2D or 3D renderer
/// slots in here without touching the HUD, the chips or the controls.
export interface TrackRendererProps {
  controller: LabController;
}

export interface TrackRenderer {
  id: string;
  /// Whether this renderer has the data it needs for the open session.
  available: boolean;
  Component: ComponentType<TrackRendererProps>;
}

function NoGeometryRenderer() {
  return (
    <div className="lab-track-unavailable" role="note">
      <Icon name="map" size={18} />
      <p className="lab-track-unavailable-title">No track geometry</p>
      <p className="lab-track-unavailable-detail">
        Car positions are not recorded, so no circuit or racing line is drawn.
      </p>
    </div>
  );
}

export const TRACK_RENDERERS: TrackRenderer[] = [
  { id: "no-geometry", available: true, Component: NoGeometryRenderer },
];

/// Distance shown in the HUD chips' input history, and its time equivalent.
const HISTORY = { distance: 400, time: 10_000 };

export const LabTrackViewport = memo(function LabTrackViewport({
  controller,
}: {
  controller: LabController;
}) {
  const renderer = TRACK_RENDERERS.find((item) => item.available)!;
  const Renderer = renderer.Component;
  const axis = useLab(controller, (state) => state.axis);
  const cursor = useLab(controller, (state) => state.cursor);

  return (
    <section
      className="lab-viewport"
      aria-labelledby="lab-viewport-title"
      data-renderer={renderer.id}
    >
      <div className="lab-viewport-floor" aria-hidden="true">
        <div className="lab-viewport-grid" />
      </div>

      <header className="lab-viewport-title">
        <h2 id="lab-viewport-title">Track view</h2>
        <p>Position data not recorded</p>
      </header>

      <div className="lab-hud" role="group" aria-label="Cursor position">
        <span className="lab-hud-item" title="Altitude is not recorded">
          <span className="lab-hud-label">Alt</span>
          <span className="lab-hud-value is-unavailable">—</span>
          <span className="lab-hud-unit">m</span>
        </span>
        <span className="lab-hud-divider" aria-hidden="true" />
        <span className="lab-hud-item">
          <span className="lab-hud-label">
            {axis === "distance" ? "Dist" : "Time"}
          </span>
          <span className="lab-hud-value">{cursorText(cursor, axis)}</span>
        </span>
      </div>

      <div className="lab-minimap" role="note" aria-label="Track map">
        <Icon name="track" size={28} />
        <span>No track outline</span>
      </div>

      <div className="lab-viewport-stage">
        <Renderer controller={controller} />
      </div>

      <div className="lab-chips">
        <HudChip controller={controller} slot="current" />
        <HudChip controller={controller} slot="reference" />
      </div>

      <div className="lab-viewport-footer">
        <LapStrip controller={controller} />
        <ControlBar controller={controller} />
      </div>
    </section>
  );
});

function HudChip({
  controller,
  slot,
}: {
  controller: LabController;
  slot: LapSlot;
}) {
  const state = useLab(controller, (s) => s[slot]);
  const axis = useLab(controller, (s) => s.axis);
  const cursor = useLab(controller, (s) => s.cursor);
  const trace = state.trace;
  const speed = cursor == null ? null : valueAt(trace, "speed", cursor);
  const gear = cursor == null ? null : valueAt(trace, "gear", cursor);
  const name = slot === "current" ? "Current" : "Reference";
  return (
    <div
      className={`lab-chip-hud slot-${slot}`}
      role="group"
      aria-label={`${name} lap at the cursor`}
    >
      <span className="lab-chip-hud-strip" aria-hidden="true">
        {name}
      </span>
      {state.lap == null ? (
        <span className="lab-chip-hud-empty">No reference lap</span>
      ) : (
        <>
          <InputHistory trace={trace} cursor={cursor} span={HISTORY[axis]} />
          <span className="lab-chip-hud-gear" aria-label="Gear">
            {gearText(gear)}
          </span>
          <span className="lab-chip-hud-speed">
            <span aria-label="Speed">{formatChannel("speed", speed)}</span>
            <span className="lab-chip-hud-unit">km/h</span>
          </span>
          <span className="lab-chip-hud-lap">Lap {state.lap}</span>
        </>
      )}
    </div>
  );
}

const SPARK = { width: 120, height: 30 };

/// Throttle and brake just before the cursor, from the recorded trace.
function InputHistory({
  trace,
  cursor,
  span,
}: {
  trace: SessionTrace | null;
  cursor: number | null;
  span: number;
}) {
  const paths = useMemo(() => {
    if (trace == null || cursor == null) return null;
    const domain = { x0: cursor - span, x1: cursor, y0: 0, y1: 1 };
    return {
      throttle: seriesPath(trace, "throttle", domain, SPARK),
      brake: seriesPath(trace, "brake", domain, SPARK),
    };
  }, [trace, cursor, span]);
  return (
    <svg
      className="lab-spark"
      viewBox={`0 0 ${SPARK.width} ${SPARK.height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {paths ? (
        <>
          <path className="lab-spark-throttle" d={paths.throttle} />
          <path className="lab-spark-brake" d={paths.brake} />
        </>
      ) : null}
    </svg>
  );
}

/// The lap as a line: sector boundaries from the session's own record, and
/// where each lap's cursor is. A helper, never a map.
function LapStrip({ controller }: { controller: LabController }) {
  const info = useSessionInfo(controller);
  const axis = useLab(controller, (state) => state.axis);
  const cursor = useLab(controller, (state) => state.cursor);
  const domain = useLabDomain(controller);
  const span = domain.x1 - domain.x0 || 1;
  const at = (x: number) => `${((x - domain.x0) / span) * 100}%`;
  // Sector boundaries are the session's own (Session packet): drawn only on
  // the distance axis, where they mean something, and only when recorded.
  const length = info?.trackLengthM ?? null;
  const sectors =
    axis === "distance" &&
    length != null &&
    info?.sector2StartM &&
    info.sector3StartM
      ? [
          { name: "S1", from: 0, to: info.sector2StartM },
          { name: "S2", from: info.sector2StartM, to: info.sector3StartM },
          { name: "S3", from: info.sector3StartM, to: length },
        ]
      : [];
  const active =
    cursor == null
      ? null
      : (sectors.find((s) => cursor >= s.from && cursor < s.to)?.name ?? null);
  return (
    <div className="lab-strip" aria-hidden="true">
      {sectors.length > 0 ? (
        sectors.map((sector) => (
          <span
            key={sector.name}
            className={`lab-strip-sector${active === sector.name ? " is-active" : ""}`}
            style={{
              left: at(sector.from),
              width: `${((sector.to - sector.from) / span) * 100}%`,
            }}
          >
            <span className="lab-strip-sector-name">{sector.name}</span>
            <span className="lab-strip-sector-length">
              {((sector.to - sector.from) / 1000).toFixed(2)} km
            </span>
          </span>
        ))
      ) : (
        <div className="lab-strip-line" />
      )}
      {cursor != null ? (
        <span className="lab-strip-cursor" style={{ left: at(cursor) }} />
      ) : null}
    </div>
  );
}

function ToolButton({
  icon,
  label,
  onClick,
  disabledReason,
  pressed,
}: {
  icon: IconName;
  label: string;
  onClick?: () => void;
  disabledReason?: string;
  pressed?: boolean;
}) {
  const disabled = disabledReason != null;
  return (
    <button
      type="button"
      className="lab-tool"
      aria-label={label}
      aria-disabled={disabled || undefined}
      aria-pressed={pressed}
      title={disabled ? `${label}: ${disabledReason}` : label}
      onClick={disabled ? undefined : onClick}
    >
      <Icon name={icon} />
    </button>
  );
}

const LATER = "arrives in a later milestone";
const NO_POSITION = "needs recorded car positions";

function ControlBar({ controller }: { controller: LabController }) {
  const axis = useLab(controller, (state) => state.axis);
  const cursor = useLab(controller, (state) => state.cursor);
  return (
    <div className="lab-controls" role="toolbar" aria-label="Playback">
      <ToolButton icon="play" label="Play" disabledReason={LATER} />
      <button
        type="button"
        className="lab-speed"
        disabled
        title={`Playback speed ${LATER}`}
      >
        1x
      </button>
      <span className="lab-controls-time" aria-label="Cursor">
        {cursorText(cursor, axis)}
      </span>
      <span className="lab-controls-divider" aria-hidden="true" />
      <ToolButton icon="map" label="Track map" disabledReason={NO_POSITION} />
      <ToolButton icon="chart" label="Charts" pressed />
      <ToolButton
        icon="reset"
        label="Cursor to lap start"
        onClick={() => controller.cursorTo("start")}
      />
      <span className="lab-controls-divider" aria-hidden="true" />
      <ToolButton icon="crosshair" label="Shared cursor" pressed />
      <ToolButton icon="expand" label="Full screen" disabledReason={LATER} />
    </div>
  );
}
