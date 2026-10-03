import { forwardRef, type ReactNode } from "react";
import type {
  Badge as BadgeModel,
  Fact,
  LifecycleView,
} from "../../session-workspace.ts";
import { ANALYSIS_REFRESH_MS } from "../../session-controller.ts";
import { integer } from "../../telemetry/formatting.ts";

const GLYPHS = {
  neutral: "○",
  good: "●",
  warn: "◐",
  bad: "✕",
  rec: "●",
} as const;

/// A short status fact. Text always carries the meaning; tone only echoes it.
export function Badge({ badge }: { badge: BadgeModel }) {
  return (
    <span className={`badge tone-${badge.tone}`}>
      <span className="badge-glyph" aria-hidden="true">
        {GLYPHS[badge.tone]}
      </span>
      {badge.label}
    </span>
  );
}

/// Label/value pairs as a definition list. An unavailable value keeps the
/// dash visible and says "unavailable" to a screen reader.
export function FactList({
  facts,
  className = "",
}: {
  facts: Fact[];
  className?: string;
}) {
  return (
    <dl className={`fact-list ${className}`.trim()}>
      {facts.map((item) => (
        <div
          key={item.key}
          className={`fact${item.available ? "" : " is-unavailable"}${
            item.attention ? " is-attention" : ""
          }`}
          data-fact={item.key}
        >
          <dt>{item.label}</dt>
          <dd className={item.mono ? "mono" : undefined}>
            {item.available ? (
              item.value
            ) : (
              <>
                <span aria-hidden="true">{item.value}</span>
                <span className="visually-hidden">unavailable</span>
              </>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/// The lifecycle pill in the selected-session header. A status region, so a
/// change from queued to analyzing to available is announced without moving
/// focus.
export function LifecyclePill({ view }: { view: LifecycleView }) {
  return (
    <p
      className={`lifecycle-pill tone-${view.tone}`}
      role="status"
      data-state={view.loading ? "loading" : view.state}
    >
      <span className="badge-glyph" aria-hidden="true">
        {GLYPHS[view.tone]}
      </span>
      <span className="visually-hidden">Analysis: </span>
      {view.short}
    </p>
  );
}

/// Where analysis content would be, when there is none to show: what state
/// the analysis is in, why, and — only where V1.0 offered it — a re-run.
export const AnalysisStatePanel = forwardRef<
  HTMLDivElement,
  {
    view: LifecycleView;
    jobLines: { key: string; label: string; value: string }[];
    reanalyzing: boolean;
    reanalyzeError: string | null;
    onReanalyze: () => void;
    children?: ReactNode;
  }
>(function AnalysisStatePanel(
  { view, jobLines, reanalyzing, reanalyzeError, onReanalyze, children },
  ref,
) {
  const pending = view.state === "queued" || view.state === "analyzing";
  return (
    <div
      ref={ref}
      tabIndex={-1}
      className={`analysis-state tone-${view.tone}`}
      data-state={view.loading ? "loading" : view.state}
    >
      <p className="analysis-state-title">
        <span className="badge-glyph" aria-hidden="true">
          {GLYPHS[view.tone]}
        </span>
        {view.headline}
      </p>
      <p className="analysis-state-detail">{view.detail}</p>
      {pending || view.loading ? (
        <div className="analysis-progress" aria-hidden="true">
          <span />
        </div>
      ) : null}
      {pending ? (
        <p className="analysis-state-note">
          RaceLab checks this session again every {ANALYSIS_REFRESH_MS / 1000} s
          while it is open.
        </p>
      ) : null}
      {jobLines.length > 0 ? (
        <p className="analysis-state-note">
          {jobLines.map((line) => `${line.label}: ${line.value}`).join(" · ")}
        </p>
      ) : null}
      {view.offerReanalysis && view.problem ? (
        <div className="analysis-state-action">
          <button
            type="button"
            className="ghost"
            // Not `disabled`, which would drop keyboard focus to the page
            // while the re-run is in progress.
            aria-disabled={reanalyzing}
            onClick={reanalyzing ? undefined : onReanalyze}
          >
            {reanalyzing ? "Re-running…" : "Re-run analysis"}
          </button>
          <span className="analysis-state-note">
            Reads the saved recording again and replaces its analysis. The
            recording itself is never modified.
          </span>
        </div>
      ) : null}
      {reanalyzeError ? (
        <p className="inline-alert tone-bad" role="alert">
          {reanalyzeError}
        </p>
      ) : null}
      {children}
    </div>
  );
});

/// A table that renders its first `limit` rows and offers the rest on
/// request. The count of what is not yet shown is always stated.
export function ShowMore({
  shown,
  total,
  noun,
  onMore,
}: {
  shown: number;
  total: number;
  noun: string;
  onMore: () => void;
}) {
  if (shown >= total) return null;
  return (
    <div className="show-more">
      <span>
        Showing {integer(shown)} of {integer(total)} {noun}.
      </span>
      <button type="button" className="ghost" onClick={onMore}>
        Show {integer(Math.min(PAGE_SIZE, total - shown))} more
      </button>
    </div>
  );
}

/// Rows rendered at once in a Sessions table. The analysis caps its own
/// output at a few hundred rows; this keeps a long session's first paint
/// small without hiding how many there are.
export const PAGE_SIZE = 100;

/// The disclosure button that opens a table row's full detail.
export function RowToggle({
  expanded,
  controls,
  label,
  onToggle,
}: {
  expanded: boolean;
  controls: string;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="row-toggle"
      aria-expanded={expanded}
      // The detail row exists only while expanded.
      aria-controls={expanded ? controls : undefined}
      onClick={onToggle}
    >
      <span className="row-toggle-glyph" aria-hidden="true" />
      <span className="visually-hidden">Details for {label}</span>
    </button>
  );
}
