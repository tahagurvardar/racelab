import { memo, useMemo, useState } from "react";
import {
  channelNote,
  turnRows,
  type SessionAnalysis,
} from "../../analysis-state.ts";
import { integer, UNAVAILABLE } from "../../telemetry/formatting.ts";
import { PAGE_SIZE, RowToggle, ShowMore } from "./parts";

function withUnit(value: string, unit: string): string {
  return value === UNAVAILABLE ? value : `${value} ${unit}`;
}

/// Turn segments exactly as the analysis stored them: yaw-rate intervals with
/// their measured speeds, pedal times and per-corner peaks. A segment is not a
/// track corner, and its yaw sign is shown, never called left or right.
export const TurnsTab = memo(function TurnsTab({
  analysis,
}: {
  analysis: SessionAnalysis;
}) {
  const rows = useMemo(() => turnRows(analysis), [analysis]);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const note = channelNote(analysis, "orientation");
  const truncated = analysis.data_quality.turn_segments_truncated;
  const shown = rows.slice(0, limit);

  function toggle(key: string) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (note) return <p className="pane-empty">{note}</p>;
  if (rows.length === 0) {
    return (
      <p className="pane-empty">
        No yaw-rate interval met the turn-segment thresholds in this session.
      </p>
    );
  }

  return (
    <div className="session-turns">
      {truncated > 0 ? (
        <p className="inline-alert tone-warn" role="status">
          {integer(truncated)} further turn segments were detected but not
          stored: the analysis keeps at most{" "}
          {integer(analysis.config.max_turn_segments)}.
        </p>
      ) : null}
      <table className="data-table">
        <caption className="visually-hidden">
          Turn segments, in time order
        </caption>
        <thead>
          <tr>
            <th scope="col" className="toggle-col">
              <span className="visually-hidden">Details</span>
            </th>
            <th scope="col" className="numeric">
              Segment
            </th>
            <th scope="col" className="numeric">
              Start
            </th>
            <th scope="col" className="numeric">
              Duration
            </th>
            <th scope="col" className="numeric">
              Yaw change
            </th>
            <th scope="col" className="numeric">
              Entry km/h
            </th>
            <th scope="col" className="numeric">
              Min km/h
            </th>
            <th scope="col" className="numeric">
              Exit km/h
            </th>
            <th scope="col" className="numeric">
              Max brake
            </th>
          </tr>
        </thead>
        {shown.map((row) => {
          const expanded = open.has(row.key);
          const detailId = `turn-detail-${row.key}`;
          return (
            <tbody key={row.key}>
              <tr className={expanded ? "is-expanded" : undefined}>
                <td className="toggle-col">
                  <RowToggle
                    expanded={expanded}
                    controls={detailId}
                    label={`${row.title} at ${row.start}`}
                    onToggle={() => toggle(row.key)}
                  />
                </td>
                <th scope="row" className="numeric">
                  {row.index}
                </th>
                <td className="numeric">{row.start}</td>
                <td className="numeric">{row.duration}</td>
                <td className="numeric">{row.yawChange}</td>
                <td className="numeric">{row.entrySpeed}</td>
                <td className="numeric">{row.minSpeed}</td>
                <td className="numeric">{row.exitSpeed}</td>
                <td className="numeric">{row.maxBrake}</td>
              </tr>
              {expanded ? (
                <tr className="detail-row" id={detailId}>
                  <td />
                  <td colSpan={8}>
                    <dl className="detail-facts">
                      {[
                        ["End", row.end],
                        ["Average speed", withUnit(row.averageSpeed, "km/h")],
                        ["Max speed", withUnit(row.maxSpeed, "km/h")],
                        ["Mean yaw rate", row.meanYawRate],
                        ["Peak yaw rate", row.peakYawRate],
                        ["Brake time", row.brakeTime],
                        ["Throttle time", row.throttleTime],
                        ["Full throttle time", row.fullThrottleTime],
                      ].map(([label, value]) => (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>{value}</dd>
                        </div>
                      ))}
                    </dl>
                    <table className="corner-table">
                      <caption className="visually-hidden">
                        Per-corner peaks in {row.title}
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Corner</th>
                          <th scope="col" className="numeric">
                            Max |slip&nbsp;ratio|
                          </th>
                          <th scope="col" className="numeric">
                            Max combined slip
                          </th>
                          <th scope="col" className="numeric">
                            Max compression
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {row.cornerTable.map((corner) => (
                          <tr key={corner.corner} data-corner={corner.corner}>
                            <th scope="row">
                              <abbr title={corner.label}>{corner.corner}</abbr>
                            </th>
                            <td className="numeric">
                              {corner.maxAbsSlipRatio}
                            </td>
                            <td className="numeric">
                              {corner.maxCombinedSlip}
                            </td>
                            <td className="numeric">{corner.maxCompression}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </td>
                </tr>
              ) : null}
            </tbody>
          );
        })}
      </table>
      <ShowMore
        shown={shown.length}
        total={rows.length}
        noun="turn segments"
        onMore={() => setLimit((current) => current + PAGE_SIZE)}
      />
      <p className="panel-footnote">
        Yaw change is the net heading change over the segment; its sign is
        measured and is not mapped to left or right. Compression is normalized
        suspension travel.
      </p>
    </div>
  );
});
