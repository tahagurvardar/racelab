import { useLayoutEffect, useRef } from "react";
import { analysisJobLines } from "../../analysis-state.ts";
import { useRecorder } from "../../hooks/use-recorder-status.ts";
import { useSessions } from "../../hooks/use-sessions.ts";
import {
  DETAIL_TABS,
  type SessionsController,
} from "../../session-controller.ts";
import {
  lifecycle,
  sessionHeader,
  tabCounts,
} from "../../session-workspace.ts";
import { Tabs } from "../../components/shell/Tabs";
import { DataTab } from "./DataTab";
import { EventsTab } from "./EventsTab";
import { AnalysisStatePanel, Badge, FactList, LifecyclePill } from "./parts";
import { SlipTab } from "./SlipTab";
import { SummaryTab } from "./SummaryTab";
import { TurnsTab } from "./TurnsTab";
import { F1SessionDetail } from "./F1SessionDetail";

/// The selected session: a compact header, then Summary, Events, Turns, Slip
/// and Data. Everything shown belongs to `selected.id` — the controller drops
/// any reply that does not — so switching sessions can never mix two. An
/// F1 25 session has its own factual detail (`F1SessionDetail`).
export function SessionDetail({
  controller,
}: {
  controller: SessionsController;
}) {
  const selected = useSessions(controller, (state) => state.selected);
  if (selected?.game === "f1_25") {
    return <F1SessionDetail controller={controller} selected={selected} />;
  }
  return <Fh6SessionDetail controller={controller} />;
}

function Fh6SessionDetail({ controller }: { controller: SessionsController }) {
  const selected = useSessions(controller, (state) => state.selected);
  const tab = useSessions(controller, (state) => state.tab);
  const loaded = useSessions(controller, (state) => state.list.loaded);
  const recordingId = useRecorder((state) =>
    state.recorder?.recording ? state.recorder.session_id : null,
  );
  const section = useRef<HTMLElement>(null);
  const statePanel = useRef<HTMLDivElement>(null);

  // A new selection keeps the reader's place unless they had scrolled past
  // the top of the detail; then its header is brought back into view, so the
  // new session is never shown from the middle of the previous one's table.
  useLayoutEffect(() => {
    const element = section.current;
    const scroller = element?.closest(".workspace");
    if (!element || !(scroller instanceof HTMLElement)) return;
    const offset =
      element.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top;
    if (offset < 0) scroller.scrollTop += offset;
  }, [selected?.id]);

  if (selected == null) {
    return (
      <section className="sessions-detail is-empty" aria-label="Session">
        <p className="pane-empty" role="status">
          {loaded ? "Choose a session to see it here." : "Loading sessions…"}
        </p>
      </section>
    );
  }

  const manifest = selected.manifest;
  const view = lifecycle(selected.analysis, selected.analysisError);
  const doc = view.showAnalysis ? (selected.analysis?.analysis ?? null) : null;
  const counts = tabCounts(doc);
  const tabs = DETAIL_TABS.map((item) => ({
    ...item,
    count:
      item.id === "events" || item.id === "turns" || item.id === "slip"
        ? counts[item.id]
        : undefined,
  }));

  async function reanalyze() {
    await controller.reanalyze();
    const active = document.activeElement;
    if (active == null || active === document.body || !active.isConnected) {
      statePanel.current?.focus();
    }
  }

  const statePanelElement = (
    <AnalysisStatePanel
      ref={statePanel}
      view={view}
      jobLines={analysisJobLines(selected.analysis)}
      reanalyzing={selected.reanalyzing}
      reanalyzeError={selected.reanalyzeError}
      onReanalyze={() => void reanalyze()}
    />
  );

  if (manifest == null) {
    return (
      <section
        ref={section}
        className="sessions-detail"
        aria-label="Session"
        data-session={selected.id}
      >
        {selected.manifestError ? (
          <p className="inline-alert tone-bad" role="alert">
            This session could not be read: {selected.manifestError}
          </p>
        ) : (
          <p className="pane-empty" role="status">
            Loading session…
          </p>
        )}
      </section>
    );
  }

  const header = sessionHeader(manifest, Date.now(), recordingId);

  return (
    <section
      ref={section}
      className="sessions-detail"
      aria-labelledby="session-title"
      data-session={selected.id}
      aria-busy={selected.manifestLoading || selected.analysisLoading}
    >
      <header className="session-header">
        <div className="session-header-main">
          <h2 id="session-title" className="session-title">
            {header.title}
          </h2>
          <Badge badge={header.status} />
          <LifecyclePill view={view} />
        </div>
        <FactList facts={header.facts} className="inline" />
      </header>

      {selected.manifestError ? (
        <p className="inline-alert tone-warn" role="status">
          Showing the listed details; the latest could not be read:{" "}
          {selected.manifestError}
        </p>
      ) : null}
      {header.alerts.map((alert) => (
        <div
          key={alert.key}
          className={`inline-alert tone-${alert.tone}`}
          role={alert.tone === "bad" ? "alert" : "status"}
        >
          <p className="inline-alert-title">{alert.title}</p>
          <p>{alert.detail}</p>
        </div>
      ))}

      <Tabs
        items={tabs}
        value={tab}
        onChange={(next) => controller.setTab(next)}
        label="Session detail"
        idPrefix="session"
      />
      <div
        className="tab-panel session-tab-panel"
        id="session-panel"
        role="tabpanel"
        aria-labelledby={`session-tab-${tab}`}
        tabIndex={0}
      >
        {/* Keyed by session and tab: row expansion and "show more" belong
            to one session's table, never carried into another's. */}
        <div className="tab-panel-content" key={`${selected.id}-${tab}`}>
          {tab === "summary" ? (
            <SummaryTab
              manifest={manifest}
              analysis={doc}
              analysisState={doc ? null : statePanelElement}
            />
          ) : null}
          {tab === "events" ? (
            doc ? (
              <EventsTab analysis={doc} />
            ) : (
              statePanelElement
            )
          ) : null}
          {tab === "turns" ? (
            doc ? (
              <TurnsTab analysis={doc} />
            ) : (
              statePanelElement
            )
          ) : null}
          {tab === "slip" ? (
            doc ? (
              <SlipTab analysis={doc} />
            ) : (
              statePanelElement
            )
          ) : null}
          {tab === "data" ? (
            <DataTab manifest={manifest} analysis={selected.analysis} />
          ) : null}
        </div>
      </div>
    </section>
  );
}
