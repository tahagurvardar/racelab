import type { BarMetric } from "../telemetry/telemetry-view-model.ts";

/// A normalized driver input. The printed percentage is the view model's
/// string, including its sign; the bar only shows magnitude. An unavailable
/// input draws no fill at all, so it can never be read as 0%.
export function InputBar({ metric }: { metric: BarMetric }) {
  const fill = metric.fraction ?? 0;
  const negative = metric.signed && metric.value.startsWith("-");
  return (
    <div className={`input-bar${metric.available ? "" : " is-unavailable"}`}>
      <div className="input-bar-head">
        <span className="metric-label">{metric.label}</span>
        <span className="input-bar-value">
          {metric.value}
          {metric.available ? <em className="metric-unit">%</em> : null}
        </span>
      </div>
      <div
        className={`input-bar-track${metric.signed ? " is-signed" : ""}`}
        role="img"
        aria-label={`${metric.label}: ${
          metric.available ? `${metric.value} percent` : "unavailable"
        }`}
      >
        {metric.available ? (
          <span
            className={`input-bar-fill${negative ? " is-negative" : ""}`}
            style={{ width: `${metric.signed ? fill / 2 : fill}%` }}
          />
        ) : null}
      </div>
    </div>
  );
}

/// A bounded range indicator, e.g. RPM between idle and maximum. A null
/// fraction means the range itself is unavailable and no bar is drawn.
export function RangeBar({
  fraction,
  label,
}: {
  fraction: number | null;
  label: string;
}) {
  return (
    <div
      className={`range-bar${fraction == null ? " is-unavailable" : ""}`}
      role="img"
      aria-label={
        fraction == null
          ? `${label}: unavailable`
          : `${label}: ${fraction.toFixed(0)} percent of range`
      }
    >
      {fraction == null ? null : (
        <span className="range-bar-fill" style={{ width: `${fraction}%` }} />
      )}
    </div>
  );
}
