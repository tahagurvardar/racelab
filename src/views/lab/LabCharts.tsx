import {
  memo,
  useMemo,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { useLab } from "../../hooks/use-lab.ts";
import type { LabController, LabTraceState } from "../../lab-controller.ts";
import {
  CHANNEL_TITLES,
  CHANNEL_UNITS,
  formatChannel,
  seriesPath,
  valueAt,
  xTicks,
  yDomain,
  yTicks,
  type TraceAxisId,
  type TraceChannelId,
} from "../../telemetry-lab.ts";
import { Icon } from "../../components/shell/Icon";
import {
  cursorText,
  useLabDomain,
  useLapComparison,
  useLapDelta,
} from "./parts";
import {
  deltaAt,
  deltaPath,
  deltaRange,
  formatDelta,
} from "../../lap-delta.ts";
import {
  differenceAt,
  DIFFERENCE_UNITS,
  formatDifference,
  isCompareChannel,
  type CompareChannel,
} from "../../lap-comparison.ts";

/// The chart stack: delta first, then every recorded channel, each on the
/// same x axis and the same cursor. Current is solid blue, reference dotted
/// gold.
export function LabCharts({ controller }: { controller: LabController }) {
  return (
    <div className="lab-charts">
      <DeltaPanel controller={controller} />
      {CHART_ORDER.map((id) => (
        <TracePanel key={id} controller={controller} id={id} />
      ))}
    </div>
  );
}

/// The charted channels. Lap time and distance pair the axes; they are
/// never drawn.
type ChartChannel = Exclude<TraceChannelId, "lap_time" | "lap_distance">;

const CHART_ORDER: ChartChannel[] = [
  "speed",
  "rpm",
  "throttle",
  "brake",
  "steering",
  "gear",
];

/// Plot heights in CSS pixels, after the reference: speed dominates, the
/// delta strip and RPM follow, the inputs are compact. lab.css sets the same
/// heights, so the SVG is never stretched vertically.
const PLOT_HEIGHT: Record<ChartChannel | "delta", number> = {
  delta: 104,
  speed: 236,
  rpm: 150,
  throttle: 118,
  brake: 118,
  steering: 130,
  gear: 110,
};

const PLOT_WIDTH = 1000;

function PanelHeader({
  controller,
  panel,
  title,
  tone,
  children,
}: {
  controller: LabController;
  panel: string;
  title: string;
  tone: string;
  children?: ReactNode;
}) {
  const collapsed = useLab(controller, (state) => !!state.collapsed[panel]);
  return (
    <header className="lab-chart-header">
      <h3 className={`lab-chart-chip tone-${tone}`} id={`lab-chart-${panel}`}>
        {title}
      </h3>
      <span className="lab-chart-readout">{children}</span>
      <button
        type="button"
        className="lab-collapse"
        aria-expanded={!collapsed}
        aria-controls={`lab-chart-body-${panel}`}
        aria-label={`${collapsed ? "Expand" : "Collapse"} ${title}`}
        onClick={() => controller.toggle(panel)}
      >
        <Icon name={collapsed ? "plus" : "minus"} />
      </button>
    </header>
  );
}

function XAxis({
  domain,
  axis,
}: {
  domain: { x0: number; x1: number };
  axis: TraceAxisId;
}) {
  const ticks = useMemo(() => xTicks(domain, axis), [domain, axis]);
  const span = domain.x1 - domain.x0 || 1;
  return (
    <div className="lab-xaxis" aria-hidden="true">
      {ticks.map((tick) => (
        <span
          key={tick.value}
          className="lab-xtick"
          style={{ left: `${((tick.value - domain.x0) / span) * 100}%` }}
        >
          {tick.label}
        </span>
      ))}
    </div>
  );
}

/// The shared cursor line, rendered alone so a cursor move re-renders it and
/// the readouts, never the traces.
function CursorLine({
  controller,
  domain,
}: {
  controller: LabController;
  domain: { x0: number; x1: number };
}) {
  const cursor = useLab(controller, (state) => state.cursor);
  if (cursor == null) return null;
  const span = domain.x1 - domain.x0 || 1;
  const left = ((cursor - domain.x0) / span) * 100;
  if (left < 0 || left > 100) return null;
  return (
    <span
      className="lab-cursor"
      style={{ left: `${left}%` }}
      aria-hidden="true"
    />
  );
}

/// Pointer and keyboard control of the shared cursor over one plot.
function usePlotControl(
  controller: LabController,
  domain: { x0: number; x1: number },
) {
  return {
    onPointerMove(event: PointerEvent<HTMLDivElement>) {
      const box = event.currentTarget.getBoundingClientRect();
      if (box.width <= 0) return;
      const fraction = Math.min(
        1,
        Math.max(0, (event.clientX - box.left) / box.width),
      );
      controller.setCursor(domain.x0 + fraction * (domain.x1 - domain.x0));
    },
    onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      const step = event.shiftKey ? 10 : 1;
      if (event.key === "ArrowRight") controller.stepCursor(step);
      else if (event.key === "ArrowLeft") controller.stepCursor(-step);
      else if (event.key === "Home") controller.cursorTo("start");
      else if (event.key === "End") controller.cursorTo("end");
      else return;
      event.preventDefault();
    },
  };
}

function PlotFrame({
  controller,
  id,
  label,
  domain,
  axis,
  height,
  children,
  overlay,
  yLabels,
}: {
  controller: LabController;
  id: string;
  label: string;
  domain: { x0: number; x1: number };
  axis: TraceAxisId;
  height: number;
  children: ReactNode;
  overlay?: ReactNode;
  yLabels: { value: number; label: string; top: number }[];
}) {
  const control = usePlotControl(controller, domain);
  const cursor = useLab(controller, (state) => state.cursor);
  return (
    <div className="lab-chart-body" id={`lab-chart-body-${id}`}>
      <div className="lab-yaxis" aria-hidden="true">
        {yLabels.map((tick) => (
          <span
            key={tick.value}
            className="lab-ytick"
            style={{ top: `${tick.top}%` }}
          >
            {tick.label}
          </span>
        ))}
      </div>
      <div className="lab-plot-column">
        <div
          className="lab-plot"
          role="slider"
          tabIndex={0}
          aria-label={`${label} cursor`}
          aria-valuemin={Math.round(domain.x0)}
          aria-valuemax={Math.round(domain.x1)}
          aria-valuenow={cursor == null ? undefined : Math.round(cursor)}
          aria-valuetext={cursorText(cursor, axis)}
          style={{ height }}
          {...control}
        >
          <svg
            viewBox={`0 0 ${PLOT_WIDTH} ${height}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            {yLabels.map((tick) => (
              <line
                key={tick.value}
                className="lab-gridline"
                x1="0"
                x2={PLOT_WIDTH}
                y1={(tick.top / 100) * height}
                y2={(tick.top / 100) * height}
              />
            ))}
            {children}
          </svg>
          <CursorLine controller={controller} domain={domain} />
          {overlay}
        </div>
        <XAxis domain={domain} axis={axis} />
      </div>
    </div>
  );
}

function status(slot: LabTraceState, name: string): string | null {
  if (slot.status === "error") {
    return `The ${name} lap could not be read: ${slot.error}`;
  }
  if (slot.status === "loading" && slot.trace == null) {
    return `Loading the ${name} lap…`;
  }
  return null;
}

const TracePanel = memo(function TracePanel({
  controller,
  id,
}: {
  controller: LabController;
  id: ChartChannel;
}) {
  const current = useLab(controller, (state) => state.current);
  const reference = useLab(controller, (state) => state.reference);
  const axis = useLab(controller, (state) => state.axis);
  const collapsed = useLab(controller, (state) => !!state.collapsed[id]);
  const domain = useLabDomain(controller);
  const height = PLOT_HEIGHT[id];
  const title = CHANNEL_TITLES[id];

  const y = useMemo(
    () => yDomain([current.trace, reference.trace], id),
    [current.trace, reference.trace, id],
  );
  const paths = useMemo(() => {
    const full = { ...domain, ...y };
    const size = { width: PLOT_WIDTH, height };
    return {
      current: seriesPath(current.trace, id, full, size),
      reference: seriesPath(reference.trace, id, full, size),
    };
  }, [current.trace, reference.trace, domain, y, id, height]);
  const yLabels = useMemo(
    () =>
      yTicks(id, y).map((tick) => ({
        ...tick,
        top: 100 - ((tick.value - y.y0) / (y.y1 - y.y0 || 1)) * 100,
      })),
    [id, y],
  );

  const message =
    current.lap == null
      ? "Choose a lap to compare."
      : (status(current, "current") ??
        (current.trace && current.trace.axis.records === 0
          ? "No samples were recorded for this lap."
          : null));

  return (
    <section
      className={`lab-panel tone-chart lab-chart chart-${id}${collapsed ? " is-collapsed" : ""}`}
      aria-labelledby={`lab-chart-${id}`}
    >
      <PanelHeader controller={controller} panel={id} title={title} tone={id}>
        <Readout controller={controller} id={id} />
        <span className="lab-chart-unit">{CHANNEL_UNITS[id]}</span>
      </PanelHeader>
      {collapsed ? null : (
        <PlotFrame
          controller={controller}
          id={id}
          label={title}
          domain={domain}
          axis={axis}
          height={height}
          yLabels={yLabels}
          overlay={
            message ? <p className="lab-plot-message">{message}</p> : null
          }
        >
          {/* Reference drawn last: its dotted line stays visible where the
              two laps coincide, as in the approved reference. */}
          <path className="lab-series slot-current" d={paths.current} />
          <path className="lab-series slot-reference" d={paths.reference} />
        </PlotFrame>
      )}
    </section>
  );
});

/// Current and reference values at the cursor.
function Readout({
  controller,
  id,
}: {
  controller: LabController;
  id: TraceChannelId;
}) {
  const cursor = useLab(controller, (state) => state.cursor);
  const current = useLab(controller, (state) => state.current.trace);
  const reference = useLab(controller, (state) => state.reference.trace);
  const referenceLap = useLab(controller, (state) => state.reference.lap);
  const value = (trace: typeof current) =>
    formatChannel(id, cursor == null ? null : valueAt(trace, id, cursor));
  return (
    <>
      <span className="lab-readout slot-current" aria-label="Current">
        {value(current)}
      </span>
      {referenceLap != null ? (
        <span className="lab-readout slot-reference" aria-label="Reference">
          {value(reference)}
        </span>
      ) : null}
      {isCompareChannel(id) ? (
        <DifferenceReadout controller={controller} id={id} />
      ) : null}
    </>
  );
}

/// M5: current minus reference at the cursor, on Distance sync between two
/// qualified laps only. Absent otherwise, never a guess.
function DifferenceReadout({
  controller,
  id,
}: {
  controller: LabController;
  id: CompareChannel;
}) {
  const comparison = useLapComparison(controller);
  const cursor = useLab(controller, (state) => state.cursor);
  const current = useLab(controller, (state) => state.current.trace);
  const reference = useLab(controller, (state) => state.reference.trace);
  if (!comparison.available) return null;
  const difference = differenceAt(comparison, current, reference, id, cursor);
  return (
    <span
      className={`lab-readout slot-difference${difference == null ? " is-unavailable" : ""}`}
      aria-label={`Current minus reference, ${DIFFERENCE_UNITS[id]}`}
      title={`Current minus reference, ${DIFFERENCE_UNITS[id]}`}
    >
      {formatDifference(id, difference)}
    </span>
  );
}

/// M6: the current lap's time delta to the reference at the same lap
/// distance, from each lap's recorded lap time. Above zero the current lap
/// is behind (slower), below it ahead. Where the recordings cannot give a
/// delta the panel says why and draws nothing; on Time sync, and for laps
/// M4 does not qualify, there is no delta at all.
function DeltaPanel({ controller }: { controller: LabController }) {
  const axis = useLab(controller, (state) => state.axis);
  const collapsed = useLab(controller, (state) => !!state.collapsed.delta);
  const domain = useLabDomain(controller);
  const delta = useLapDelta(controller);
  const range = deltaRange(delta);
  // The range is whole tenths of a second.
  const seconds = (range / 1000).toFixed(1);
  const path = useMemo(
    () =>
      deltaPath(delta, domain, {
        width: PLOT_WIDTH,
        height: PLOT_HEIGHT.delta,
      }),
    [delta, domain],
  );
  const yLabels = delta.available
    ? [
        { value: range, label: `+${seconds}`, top: 0 },
        { value: 0, label: "0", top: 50 },
        { value: -range, label: `−${seconds}`, top: 100 },
      ]
    : [{ value: 0, label: "0", top: 50 }];
  return (
    <section
      className={`lab-panel tone-delta lab-chart chart-delta${collapsed ? " is-collapsed" : ""}`}
      aria-labelledby="lab-chart-delta"
      data-available={delta.available}
    >
      <PanelHeader
        controller={controller}
        panel="delta"
        title="Delta"
        tone="delta"
      >
        <DeltaReadout controller={controller} />
        <span className="lab-chart-unit">s</span>
      </PanelHeader>
      {collapsed ? null : (
        <PlotFrame
          controller={controller}
          id="delta"
          label="Delta"
          domain={domain}
          axis={axis}
          height={PLOT_HEIGHT.delta}
          yLabels={yLabels}
          overlay={
            delta.available ? null : (
              <p className="lab-plot-message is-quiet">
                Delta time unavailable
                <span>{delta.reason}</span>
              </p>
            )
          }
        >
          {delta.available ? (
            <path className="lab-series slot-delta" d={path} />
          ) : null}
        </PlotFrame>
      )}
    </section>
  );
}

/// Current minus reference elapsed time at the cursor, in seconds.
function DeltaReadout({ controller }: { controller: LabController }) {
  const delta = useLapDelta(controller);
  const cursor = useLab(controller, (state) => state.cursor);
  const ms = deltaAt(delta, cursor);
  const label =
    ms == null
      ? "Delta unavailable"
      : `Delta ${formatDelta(ms)} s, current ${ms > 0 ? "slower" : ms < 0 ? "faster" : "level"}`;
  return (
    <span
      className={`lab-readout slot-delta${ms == null ? " is-unavailable" : ""}`}
      aria-label={label}
      title="Current minus reference lap time at the same distance"
    >
      {formatDelta(ms)}
    </span>
  );
}
