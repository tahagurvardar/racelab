import { MetricCard } from "./MetricCard";
import type { CornerModel } from "../telemetry/telemetry-view-model.ts";

/// Four-corner vehicle view. The row order comes from `cornerRows`, which
/// always emits FL, FR, RL, RR; this component renders that order and never
/// re-sorts it, so a corner cannot be swapped in presentation.
export function WheelTelemetry({ model }: { model: CornerModel }) {
  return (
    <div className="wheel-grid">
      {model.rows.map((row) => (
        <section key={row.corner} className="panel wheel-corner">
          <header className="wheel-corner-head">
            <span className="wheel-corner-code">{row.corner}</span>
            <span className="wheel-corner-label">{row.label}</span>
          </header>
          <div className="wheel-corner-values">
            {row.values.map((metric) => (
              <MetricCard key={metric.key} metric={metric} size="compact" />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
