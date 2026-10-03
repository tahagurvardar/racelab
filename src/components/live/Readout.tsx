import type { Reading } from "../../telemetry/live-layout.ts";

export type ReadoutSize = "hero" | "display" | "figure" | "value" | "compact";

/// One labelled reading. The value string is the view model's: this never
/// converts, rounds or substitutes. An unavailable reading shows a quiet dash,
/// says "unavailable" to assistive technology, and drops its unit, so it can
/// never be read as a measured zero.
///
/// `data-source` / `data-role` name the canonical field and whether this tab
/// owns it; the field-coverage tests read them from the DOM.
export function Readout({
  reading,
  size = "value",
  className = "",
  hideLabel = false,
}: {
  reading: Reading;
  size?: ReadoutSize;
  className?: string;
  /// For a second unit of a reading already labelled beside it (W next to
  /// kW, rpm next to rad/s): the label stays for assistive technology only.
  hideLabel?: boolean;
}) {
  return (
    <div
      className={`readout readout-${size}${
        reading.available ? "" : " is-unavailable"
      }${reading.stale ? " is-stale" : ""}${className ? ` ${className}` : ""}`}
      data-source={reading.source}
      data-channel={reading.key}
      data-compound={
        reading.key.includes("tyre_compound")
          ? reading.value.toLowerCase()
          : undefined
      }
      data-role={reading.role}
      data-available={reading.available}
    >
      <span className={hideLabel ? "visually-hidden" : "readout-label"}>
        {reading.label}
      </span>
      <span className="readout-line">
        {reading.available ? (
          <span className="readout-value">{reading.value}</span>
        ) : (
          <>
            <span className="readout-value" aria-hidden="true">
              {reading.value}
            </span>
            <span className="visually-hidden">unavailable</span>
          </>
        )}
        {reading.unit && reading.available ? (
          <span className="readout-unit">{reading.unit}</span>
        ) : null}
        {/* A real value that is no longer updating (F1 25 packet families).
            Said in words, not only by the dimmed style. */}
        {reading.stale ? (
          <span className="visually-hidden">, not updating</span>
        ) : null}
      </span>
    </div>
  );
}
