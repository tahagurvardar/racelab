import { Readout } from "../../../components/live/Readout";
import { f1RaceLayout } from "../../../telemetry/f1-live-layout.ts";
import type { F1LiveSnapshot } from "../../../telemetry/f1-player.ts";
import { F1Panel } from "./parts";

/// Lap and session context, exactly as F1 25 reports it: times, standing,
/// pit state, penalties and warnings, this lap's energy and the speed trap.
/// No predicted lap, no delta the game did not send, no strategy.
export default function F1RaceTab({ live }: { live: F1LiveSnapshot | null }) {
  const model = f1RaceLayout(live);
  return (
    <div className="f1-race">
      <div className="f1-race-grid">
        {model.groups.map((group) => (
          <F1Panel
            key={group.key}
            title={group.title}
            family={group.family}
            className={`f1-race-${group.key}`}
          >
            <div className="f1-readings">
              {group.readings.map((reading) => (
                <Readout key={reading.key} reading={reading} size="value" />
              ))}
            </div>
          </F1Panel>
        ))}
      </div>
      <p className="live-footnote">
        Times are shown as F1 25 sends them, including 0:00.000 for a time the
        game has not set yet. F1 25 states no unit for the energy harvested and
        deployed this lap, so those are shown as sent.
      </p>
    </div>
  );
}
