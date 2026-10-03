import { memo, useMemo } from "react";
import type { SessionAnalysis } from "../../analysis-state.ts";
import { densityNote, sessionTimeline } from "../../session-timeline.ts";
import { elapsed, integer } from "../../telemetry/formatting.ts";

/// When the analysis's own episodes happened, on one session-time axis.
///
/// The drawing is a summary; the same facts are always available as text: each
/// lane's count beside its name, and the whole timeline as a table in the
/// disclosure below it. Built once per analysis document.
export const SessionTimeline = memo(function SessionTimeline({
  analysis,
}: {
  analysis: SessionAnalysis;
}) {
  const model = useMemo(() => sessionTimeline(analysis), [analysis]);

  return (
    <section
      className="session-panel timeline"
      aria-labelledby="timeline-title"
    >
      <header className="session-panel-header">
        <h3 id="timeline-title" className="panel-title">
          Timeline
        </h3>
        <span className="panel-aside">
          {elapsed(model.durationMs / 1000)} recorded
        </span>
      </header>

      <div className="timeline-grid">
        {model.lanes.map((lane) => (
          <div
            key={lane.key}
            className={`timeline-lane tone-${lane.tone}`}
            data-lane={lane.key}
          >
            <span className="timeline-lane-label">
              {lane.label}
              {/* The total the analysis counted. Where it stored fewer, the
                  footnote below names the lane and both numbers. */}
              <span className="timeline-lane-count">
                {lane.unavailable ? "—" : integer(lane.total)}
              </span>
            </span>
            <span className="timeline-track">
              {lane.unavailable ? (
                <span className="timeline-track-note">{lane.unavailable}</span>
              ) : (
                <svg
                  className="timeline-svg"
                  viewBox={`0 0 ${model.bins} 1`}
                  preserveAspectRatio="none"
                  aria-hidden="true"
                  focusable="false"
                >
                  {lane.marks.map((mark) => (
                    <rect
                      key={mark.key}
                      className={`timeline-mark level-${mark.level}`}
                      x={mark.from}
                      y={0}
                      width={mark.to - mark.from}
                      height={1}
                    >
                      <title>{mark.title}</title>
                    </rect>
                  ))}
                </svg>
              )}
            </span>
          </div>
        ))}
        <div className="timeline-axis" aria-hidden="true">
          {model.ticks.map((tick) => (
            <span
              key={tick.key}
              className="timeline-tick"
              data-edge={tick.fraction > 0.95 ? "end" : undefined}
              style={{ left: `${(tick.fraction * 100).toFixed(3)}%` }}
            >
              {tick.label}
            </span>
          ))}
        </div>
      </div>

      <p className="panel-footnote">
        {densityNote(model)}
        {model.notes.map((note) => ` ${note}`).join("")}
      </p>

      <details className="timeline-table">
        <summary>Timeline as a table</summary>
        <div className="table-scroll">
          <table className="data-table compact">
            <caption className="visually-hidden">
              Analyzed intervals starting in each part of the session
            </caption>
            <thead>
              <tr>
                <th scope="col">Lane</th>
                {model.sliceLabels.map((label) => (
                  <th key={label} scope="col" className="numeric">
                    {label}
                  </th>
                ))}
                <th scope="col" className="numeric">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {model.lanes.map((lane) => (
                <tr key={lane.key}>
                  <th scope="row">{lane.label}</th>
                  {lane.unavailable ? (
                    <td colSpan={model.sliceLabels.length + 1}>
                      {lane.unavailable}
                    </td>
                  ) : (
                    <>
                      {lane.slices.map((count, index) => (
                        <td key={index} className="numeric">
                          {integer(count)}
                        </td>
                      ))}
                      <td className="numeric">{integer(lane.total)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
});
