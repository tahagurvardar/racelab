import type { BarReading } from "../../telemetry/live-layout.ts";

/// A normalized driver input as a bar. The printed percentage is the view
/// model's string, sign included; the bar shows magnitude only. A signed
/// channel (steering) grows from the centre. An unavailable input draws no
/// fill at all, so it can never be read as 0%.
///
/// `data-channel` is channel identity for the colour tokens: throttle and
/// brake are told apart by colour as well as by label; every other input is
/// neutral.
export function ControlBar({
  reading,
  size = "primary",
}: {
  reading: BarReading;
  size?: "primary" | "compact";
}) {
  const fill = reading.fraction ?? 0;
  const negative = reading.signed && reading.value.startsWith("-");
  return (
    <div
      className={`control-bar control-bar-${size}${
        reading.available ? "" : " is-unavailable"
      }${reading.stale ? " is-stale" : ""}`}
      data-channel={reading.key}
      data-source={reading.source}
      data-role={reading.role}
      data-available={reading.available}
    >
      <span className="control-bar-label">{reading.label}</span>
      <span
        className={`control-bar-track${reading.signed ? " is-signed" : ""}`}
        role="img"
        aria-label={`${reading.label}: ${
          reading.available ? `${reading.value} percent` : "unavailable"
        }${reading.stale ? ", not updating" : ""}`}
      >
        {reading.available ? (
          <span
            className={`control-bar-fill${negative ? " is-negative" : ""}`}
            style={{ width: `${reading.signed ? fill / 2 : fill}%` }}
          />
        ) : null}
      </span>
      <span className="control-bar-value" aria-hidden="true">
        {reading.value}
        {reading.available ? <span className="readout-unit">%</span> : null}
      </span>
    </div>
  );
}
