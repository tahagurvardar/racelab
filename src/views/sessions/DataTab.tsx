import { memo } from "react";
import type { SessionAnalysisState } from "../../analysis-state.ts";
import type { SessionManifest } from "../../session-state.ts";
import {
  analysisFacts,
  definitions,
  recordingFacts,
  technicalFacts,
} from "../../session-workspace.ts";
import { FactList } from "./parts";

/// Session integrity and technical detail: how the recording ended, what was
/// recovered, what the analysis could see, and the identifiers and format
/// versions worth quoting in a report. The one place in Sessions where
/// engineering detail belongs.
export const DataTab = memo(function DataTab({
  manifest,
  analysis,
}: {
  manifest: SessionManifest;
  analysis: SessionAnalysisState | null;
}) {
  const document = analysis?.state === "available" ? analysis.analysis : null;
  const groups = [
    ...recordingFacts(manifest),
    ...analysisFacts(analysis),
    technicalFacts(manifest, analysis),
  ];
  return (
    <div className="session-data">
      {groups.map((group) => (
        <section
          key={group.key}
          className="session-panel"
          aria-labelledby={`data-${group.key}`}
        >
          <header className="session-panel-header">
            <h3 id={`data-${group.key}`} className="panel-title">
              {group.title}
            </h3>
          </header>
          <FactList facts={group.facts} className="columns-auto" />
        </section>
      ))}
      <details className="session-panel definitions">
        <summary>Definitions</summary>
        {definitions(document).map((note, index) => (
          <p key={index} className="panel-footnote">
            {note}
          </p>
        ))}
      </details>
    </div>
  );
});
