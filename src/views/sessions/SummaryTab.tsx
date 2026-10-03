import { memo, type ReactNode } from "react";
import type { SessionAnalysis } from "../../analysis-state.ts";
import type { SessionManifest } from "../../session-state.ts";
import {
  analysisFigures,
  eventCapNote,
  kindCounts,
  segmentCounts,
  sessionFigures,
} from "../../session-workspace.ts";
import { FactList } from "./parts";
import { SessionTimeline } from "./SessionTimeline";
import { duration } from "../../session-state.ts";
import { integer } from "../../telemetry/formatting.ts";

/// "What happened in this session?" — in recorded facts only. The manifest's
/// own summary first, then, when an analysis exists, its timeline, the
/// figures it computed and how many of each episode it found. No figure here
/// is a score, and none is coloured as good or bad.
export const SummaryTab = memo(function SummaryTab({
  manifest,
  analysis,
  analysisState,
}: {
  manifest: SessionManifest;
  analysis: SessionAnalysis | null;
  /// The lifecycle panel, rendered in place of analysis content.
  analysisState: ReactNode;
}) {
  return (
    <div className="session-summary">
      <div className="insight-strip" aria-label="Session insight">
        <div>
          <span>Recorded time</span>
          <strong>{duration(manifest.duration_us / 1_000_000)}</strong>
        </div>
        <div>
          <span>Frames</span>
          <strong>{integer(manifest.frame_count)}</strong>
        </div>
        {sessionFigures(manifest)
          .filter((fact) =>
            ["duration", "max-speed", "distance", "frames"].includes(fact.key),
          )
          .map((fact) => (
            <div key={fact.key}>
              <span>{fact.label}</span>
              <strong>{fact.value}</strong>
            </div>
          ))}
      </div>

      <div className="summary-columns">
        <section
          className="session-panel"
          aria-labelledby="summary-session-title"
        >
          <header className="session-panel-header">
            <h3 id="summary-session-title" className="panel-title">
              Session
            </h3>
            {manifest.summary == null ? (
              <span className="panel-aside">No summary recorded</span>
            ) : null}
          </header>
          <FactList facts={sessionFigures(manifest)} />
        </section>

        {analysis ? (
          <section
            className="session-panel"
            aria-labelledby="summary-analysis-title"
          >
            <header className="session-panel-header">
              <h3 id="summary-analysis-title" className="panel-title">
                Analysis
              </h3>
            </header>
            <FactList facts={analysisFigures(analysis)} />
          </section>
        ) : null}
      </div>

      {analysis ? <SessionTimeline analysis={analysis} /> : analysisState}

      {analysis ? <EventCounts analysis={analysis} /> : null}
    </div>
  );
});

function EventCounts({ analysis }: { analysis: SessionAnalysis }) {
  const kinds = kindCounts(analysis);
  const segments = segmentCounts(analysis);
  const capNote = eventCapNote(analysis);
  return (
    <section className="session-panel" aria-labelledby="summary-counts-title">
      <header className="session-panel-header">
        <h3 id="summary-counts-title" className="panel-title">
          Detected
        </h3>
        <span className="panel-aside">
          Counts of RaceLab-defined intervals, not ratings
        </span>
      </header>
      <dl className="count-list">
        {kinds.map((kind) => (
          <div
            key={kind.kind}
            className={`count${kind.available ? "" : " is-unavailable"}`}
            data-kind={kind.kind}
          >
            <dt>{kind.label}</dt>
            <dd>
              {kind.available ? (
                kind.text
              ) : (
                <>
                  <span aria-hidden="true">{kind.text}</span>
                  <span className="visually-hidden">not recorded</span>
                </>
              )}
            </dd>
          </div>
        ))}
        {segments.map((segment) => (
          <div
            key={segment.key}
            className={`count is-segment${segment.available ? "" : " is-unavailable"}`}
            data-kind={segment.key}
          >
            <dt>{segment.label}</dt>
            <dd>
              {segment.available ? (
                segment.text
              ) : (
                <>
                  <span aria-hidden="true">{segment.text}</span>
                  <span className="visually-hidden">not recorded</span>
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {capNote ? <p className="panel-footnote">{capNote}</p> : null}
    </section>
  );
}
