import type { CSSProperties } from "react";
import type { Metric } from "../telemetry/telemetry-view-model.ts";

/// A single formatted reading. The view model has already decided the string,
/// so this never converts units and never substitutes a zero.
export function MetricCard({
  metric,
  size = "normal",
}: {
  metric: Metric;
  size?: "normal" | "compact";
}) {
  return (
    <article
      className={`card metric-card metric-card-${size}${
        metric.available ? "" : " is-unavailable"
      }`}
    >
      <span className="metric-label">{metric.label}</span>
      <span className="metric-value">
        {metric.value}
        {metric.unit && metric.available ? (
          <em className="metric-unit">{metric.unit}</em>
        ) : null}
      </span>
      {metric.note ? <p className="metric-note">{metric.note}</p> : null}
    </article>
  );
}

export function MetricGrid({
  metrics,
  columns = 4,
  size = "normal",
}: {
  metrics: Metric[];
  columns?: number;
  size?: "normal" | "compact";
}) {
  return (
    <div
      className="metric-grid"
      // A CSS custom property is the layout knob; React types do not model them.
      style={{ "--columns": columns } as CSSProperties}
    >
      {metrics.map((metric) => (
        <MetricCard key={metric.key} metric={metric} size={size} />
      ))}
    </div>
  );
}
