import { memo, useMemo, useState } from "react";
import {
  channelNote,
  slipEpisodeRows,
  type SessionAnalysis,
} from "../../analysis-state.ts";
import { integer } from "../../telemetry/formatting.ts";
import { PAGE_SIZE, RowToggle, ShowMore } from "./parts";

/// Slip episodes as measured: when a corner's slip channel stayed above a
/// RaceLab threshold, which corners and channels, and each corner's own peak.
/// Nothing here is called wheelspin, lock-up or traction loss, and no value is
/// coloured against a threshold. Corners are always listed FL, FR, RL, RR.
export const SlipTab = memo(function SlipTab({
  analysis,
}: {
  analysis: SessionAnalysis;
}) {
  const rows = useMemo(() => slipEpisodeRows(analysis), [analysis]);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const note = channelNote(analysis, "wheel");
  const truncated = analysis.data_quality.slip_episodes_truncated;
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
        No corner's slip channels crossed a RaceLab threshold for long enough to
        report in this session.
      </p>
    );
  }

  return (
    <div className="session-slip">
      {truncated > 0 ? (
        <p className="inline-alert tone-warn" role="status">
          {integer(truncated)} further slip episodes were detected but not
          stored: the analysis keeps at most{" "}
          {integer(analysis.config.max_slip_episodes)}.
        </p>
      ) : null}
      <table className="data-table">
        <caption className="visually-hidden">
          Slip episodes, in time order
        </caption>
        <thead>
          <tr>
            <th scope="col" className="toggle-col">
              <span className="visually-hidden">Details</span>
            </th>
            <th scope="col" className="numeric">
              Episode
            </th>
            <th scope="col" className="numeric">
              Start
            </th>
            <th scope="col" className="numeric">
              Duration
            </th>
            <th scope="col" className="numeric">
              Above threshold
            </th>
            <th scope="col">Corners</th>
            <th scope="col">Channels</th>
            <th scope="col" className="numeric">
              Peak |slip&nbsp;ratio|
            </th>
            <th scope="col" className="numeric">
              Peak combined
            </th>
          </tr>
        </thead>
        {shown.map((row) => {
          const expanded = open.has(row.key);
          const detailId = `slip-detail-${row.key}`;
          return (
            <tbody key={row.key}>
              <tr className={expanded ? "is-expanded" : undefined}>
                <td className="toggle-col">
                  <RowToggle
                    expanded={expanded}
                    controls={detailId}
                    label={`slip episode ${row.index} at ${row.start}`}
                    onToggle={() => toggle(row.key)}
                  />
                </td>
                <th scope="row" className="numeric">
                  {row.index}
                </th>
                <td className="numeric">{row.start}</td>
                <td className="numeric">{row.duration}</td>
                <td className="numeric">{row.engagedTime}</td>
                <td>
                  <span className="visually-hidden">{row.corners}</span>
                  <span aria-hidden="true">{row.cornerCodes}</span>
                </td>
                <td className="wrap">{row.channels}</td>
                <td className="numeric">{row.peakSlipRatio}</td>
                <td className="numeric">{row.peakCombined}</td>
              </tr>
              {expanded ? (
                <tr className="detail-row" id={detailId}>
                  <td />
                  <td colSpan={8}>
                    <dl className="detail-facts">
                      <div>
                        <dt>End</dt>
                        <dd>{row.end}</dd>
                      </div>
                      {row.speeds.map((item) => (
                        <div key={item.key}>
                          <dt>{item.label}</dt>
                          <dd>{item.value}</dd>
                        </div>
                      ))}
                    </dl>
                    <table className="corner-table">
                      <caption className="visually-hidden">
                        Per-corner peaks in slip episode {row.index}
                      </caption>
                      <thead>
                        <tr>
                          <th scope="col">Corner</th>
                          <th scope="col">Crossed threshold</th>
                          <th scope="col" className="numeric">
                            Max |slip&nbsp;ratio|
                          </th>
                          <th scope="col" className="numeric">
                            Signed peak slip ratio
                          </th>
                          <th scope="col" className="numeric">
                            Max combined slip
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {row.cornerTable.map((corner) => (
                          <tr
                            key={corner.corner}
                            data-corner={corner.corner}
                            className={corner.affected ? undefined : "is-quiet"}
                          >
                            <th scope="row">
                              <abbr title={corner.label}>{corner.corner}</abbr>
                            </th>
                            <td>{corner.affected ? "Yes" : "No"}</td>
                            <td className="numeric">
                              {corner.maxAbsSlipRatio}
                            </td>
                            <td className="numeric">
                              {corner.signedPeakSlipRatio}
                            </td>
                            <td className="numeric">
                              {corner.maxCombinedSlip}
                            </td>
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
        noun="slip episodes"
        onMore={() => setLimit((current) => current + PAGE_SIZE)}
      />
      <p className="panel-footnote">
        An episode groups slip on any corner and either slip channel: it starts
        when a channel crosses its RaceLab entry threshold, and slip resuming
        within the merge gap continues the same episode. Above threshold is the
        engaged time, not counting those gaps. A corner's peaks are measured
        while that corner was engaged; corners that never crossed read “—”.
        Signed values keep their measured sign, which is not interpreted.
      </p>
    </div>
  );
});
