import type { LabController } from "../../lab-controller.ts";
import {
  COMPARE_CHANNELS,
  DIFFERENCE_UNITS,
  formatDifference,
} from "../../lap-comparison.ts";
import { CHANNEL_TITLES } from "../../telemetry-lab.ts";
import { cursorText, LabEmpty, useLapComparison } from "./parts";

/// M5: the current lap against the reference at the same point of the
/// circuit — the mean difference over the distance both laps recorded, and
/// the largest one, which moves the cursor there. Without a qualified pair
/// on Distance sync it states why and shows no figure.
export function ComparisonCard({ controller }: { controller: LabController }) {
  const comparison = useLapComparison(controller);
  const withheld = comparison.available
    ? COMPARE_CHANNELS.map((id) => comparison.channels[id]).filter(
        (channel) => channel.summary == null,
      )
    : [];
  return (
    <section
      className="lab-card lab-lapdata lab-comparison"
      aria-labelledby="lab-comparison-title"
    >
      <p className="lab-column-label" id="lab-comparison-title">
        Lap comparison
      </p>
      {comparison.available ? (
        <>
          <table className="lab-lapdata-table">
            <thead>
              <tr>
                <th scope="col">
                  <span className="visually-hidden">Channel</span>
                </th>
                <th scope="col">Mean</th>
                <th scope="col">Largest</th>
              </tr>
            </thead>
            <tbody>
              {COMPARE_CHANNELS.map((id) => {
                const { summary } = comparison.channels[id];
                const unit = DIFFERENCE_UNITS[id];
                return (
                  <tr key={id} data-channel={id}>
                    <th scope="row">{CHANNEL_TITLES[id]}</th>
                    <td>
                      {summary == null
                        ? "—"
                        : formatDifference(id, summary.meanDifference)}
                    </td>
                    <td>
                      {summary == null ? (
                        "—"
                      ) : (
                        <button
                          type="button"
                          className="lab-comparison-jump"
                          aria-label={`${CHANNEL_TITLES[id]}: largest difference ${formatDifference(id, summary.largest.difference)} ${unit} at ${cursorText(summary.largest.x, "distance")}. Move the cursor there.`}
                          onClick={() =>
                            controller.setCursor(summary.largest.x)
                          }
                        >
                          {formatDifference(id, summary.largest.difference)}
                          <span className="lab-comparison-at">
                            {cursorText(summary.largest.x, "distance")}
                          </span>
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="lab-quiet">
            Current minus reference at the same lap distance, over{" "}
            {cursorText(comparison.x0, "distance")}–
            {cursorText(comparison.x1, "distance")}. Speed in km/h; throttle,
            brake and steering in points of their full range.
          </p>
          {withheld.length > 0 ? (
            <ul className="lab-issues" aria-label="Comparison findings">
              {withheld.map((channel) => (
                <li key={channel.channel} className="tone-warn">
                  <strong>{CHANNEL_TITLES[channel.channel]}:</strong>{" "}
                  {channel.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <LabEmpty>{comparison.reason}</LabEmpty>
      )}
    </section>
  );
}
