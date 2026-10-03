import type { Reading } from "../../telemetry/live-layout.ts";

/// Engine speed between the reported idle and maximum. Drawn only when both
/// limits are available; it marks no shift point and no "red line" — the
/// telemetry establishes neither.
export function RpmBar({
  fraction,
  idle,
  max,
}: {
  fraction: number | null;
  /// Labels for the ends of the bar, when the tab shows them.
  idle?: Reading;
  max?: Reading;
}) {
  return (
    <div className={`rpm-bar${fraction == null ? " is-unavailable" : ""}`}>
      <span
        className="rpm-bar-track"
        role="img"
        aria-label={
          fraction == null
            ? "Engine speed range: unavailable"
            : `Engine speed: ${fraction.toFixed(0)} percent of the idle-to-maximum range`
        }
      >
        {fraction == null ? null : (
          <span className="rpm-bar-fill" style={{ width: `${fraction}%` }} />
        )}
      </span>
      {idle || max ? (
        <span className="rpm-bar-scale">
          {idle ? <ScaleEnd reading={idle} /> : <span />}
          {max ? <ScaleEnd reading={max} /> : null}
        </span>
      ) : null}
    </div>
  );
}

function ScaleEnd({ reading }: { reading: Reading }) {
  return (
    <span
      className="rpm-bar-end"
      data-source={reading.source}
      data-role={reading.role}
      data-available={reading.available}
    >
      {reading.label}{" "}
      {reading.available ? (
        <span className="rpm-bar-end-value">
          {reading.value}
          {reading.unit ? ` ${reading.unit}` : ""}
        </span>
      ) : (
        <>
          <span className="rpm-bar-end-value" aria-hidden="true">
            {reading.value}
          </span>
          <span className="visually-hidden">unavailable</span>
        </>
      )}
    </span>
  );
}
