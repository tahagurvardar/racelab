import { useState } from "react";
import { useF1Recorder } from "../../hooks/use-f1-recorder-status.ts";
import { useSessions } from "../../hooks/use-sessions.ts";
import {
  F1_DETAIL_TABS,
  type SelectedSession,
  type SessionsController,
} from "../../session-controller.ts";
import {
  F1_GAME_NAME,
  f1Activity,
  f1Alerts,
  f1DataGroups,
  f1EventRows,
  f1LapRows,
  f1StatusBadge,
  f1SummaryFacts,
  lapTime,
  type F1SessionDetail as Detail,
} from "../../f1-sessions.ts";
import { dayLabel, timeOfDay } from "../../session-workspace.ts";
import { integer } from "../../telemetry/formatting.ts";
import { Tabs } from "../../components/shell/Tabs";
import { Badge, FactList, PAGE_SIZE, ShowMore } from "./parts";

/// One F1 25 session: what was recorded, as facts. Summary, Laps, Events and
/// Data — never FH6's analysis concepts, never a rating.
export function F1SessionDetail({
  controller,
  selected,
}: {
  controller: SessionsController;
  selected: SelectedSession;
}) {
  const tab = useSessions(controller, (state) => state.f1Tab);
  const recordingId = useF1Recorder((state) =>
    state.status?.recording ? state.status.session_id : null,
  );
  const detail = selected.f1;

  if (detail == null) {
    return (
      <section
        className="sessions-detail"
        aria-label="Session"
        data-session={selected.id}
        data-game="f1_25"
      >
        {selected.f1Error ? (
          <p className="inline-alert tone-bad" role="alert">
            This session could not be read: {selected.f1Error}
          </p>
        ) : (
          <p className="pane-empty" role="status">
            Loading session…
          </p>
        )}
      </section>
    );
  }

  const envelope = detail.session.racelab_session;
  const started = envelope.started_at_unix_ms;
  const laps = detail.laps?.laps.length ?? 0;
  const tabs = F1_DETAIL_TABS.map((item) => ({
    ...item,
    count:
      item.id === "laps"
        ? integer(laps)
        : item.id === "events"
          ? integer(detail.events_total)
          : undefined,
  }));

  return (
    <section
      className="sessions-detail"
      aria-labelledby="session-title"
      data-session={selected.id}
      data-game="f1_25"
      aria-busy={selected.f1Loading}
    >
      <header className="session-header">
        <div className="session-header-main">
          <h2 id="session-title" className="session-title">
            {started == null
              ? "Session, start time unknown"
              : `${dayLabel(started, Date.now())} · ${timeOfDay(started)}`}
          </h2>
          <Badge badge={f1StatusBadge(detail.session, recordingId)} />
        </div>
        <FactList
          className="inline"
          facts={[
            {
              key: "game",
              label: "Game",
              value: F1_GAME_NAME,
              available: true,
            },
            {
              key: "activity",
              label: "Session",
              value: f1Activity(detail.labels),
              available: true,
            },
            {
              key: "laps",
              label: "Laps",
              value: integer(laps),
              available: true,
            },
          ]}
        />
      </header>

      {selected.f1Error ? (
        <p className="inline-alert tone-warn" role="status">
          Showing the last details read; the latest could not be read:{" "}
          {selected.f1Error}
        </p>
      ) : null}
      {f1Alerts(detail).map((alert) => (
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
        onChange={(next) => controller.setF1Tab(next)}
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
        <div className="tab-panel-content" key={`${selected.id}-${tab}`}>
          {tab === "summary" ? (
            <Groups groups={f1SummaryFacts(detail)} />
          ) : null}
          {tab === "laps" ? <LapsTable detail={detail} /> : null}
          {tab === "events" ? <EventsTable detail={detail} /> : null}
          {tab === "data" ? (
            <Groups groups={f1DataGroups(detail, recordingId)} />
          ) : null}
        </div>
      </div>
    </section>
  );
}

function Groups({ groups }: { groups: ReturnType<typeof f1SummaryFacts> }) {
  return (
    <div className="session-data">
      {groups.map((group) => (
        <section
          key={group.key}
          className="session-panel"
          aria-labelledby={`f1-${group.key}`}
        >
          <header className="session-panel-header">
            <h3 id={`f1-${group.key}`} className="panel-title">
              {group.title}
            </h3>
          </header>
          <FactList facts={group.facts} className="columns-auto" />
        </section>
      ))}
    </div>
  );
}

function LapsTable({ detail }: { detail: Detail }) {
  const rows = f1LapRows(detail);
  const [limit, setLimit] = useState(PAGE_SIZE);
  if (rows.length === 0) {
    return (
      <p className="pane-empty">
        No completed lap was recorded in this session.
      </p>
    );
  }
  const provisional = rows.some((row) => row.provisional);
  return (
    <div className="session-laps">
      <table className="data-table">
        <caption className="visually-hidden">Laps</caption>
        <thead>
          <tr>
            <th scope="col" className="numeric">
              Lap
            </th>
            <th scope="col" className="numeric">
              Time
            </th>
            <th scope="col" className="numeric">
              S1
            </th>
            <th scope="col" className="numeric">
              S2
            </th>
            <th scope="col" className="numeric">
              S3
            </th>
            <th scope="col">Validity</th>
            <th scope="col" className="numeric">
              Position
            </th>
            <th scope="col">Source</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map((row) => (
            <tr
              key={row.key}
              className={row.best ? "is-best" : undefined}
              data-lap={row.key}
            >
              <th scope="row" className="numeric">
                {row.lap}
              </th>
              <td className="numeric">
                {row.time}
                {row.best ? (
                  <span className="visually-hidden"> (best lap)</span>
                ) : null}
              </td>
              {row.sectors.map((sector, index) => (
                <td key={index} className="numeric">
                  {sector}
                </td>
              ))}
              <td className={row.invalid ? "tone-warn" : undefined}>
                {row.validity}
              </td>
              <td className="numeric">{row.position}</td>
              <td>{row.source}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ShowMore
        shown={Math.min(limit, rows.length)}
        total={rows.length}
        noun="laps"
        onMore={() => setLimit((value) => value + PAGE_SIZE)}
      />
      <p className="panel-footnote">
        Completed laps come from the game&rsquo;s Session History.
        {provisional
          ? " A lap marked Lap Data (provisional) was only seen ending in Lap Data; Session History never described it."
          : ""}{" "}
        Best lap: {bestLapText(detail)}.
      </p>
    </div>
  );
}

function bestLapText(detail: Detail): string {
  const laps = detail.laps;
  const best = laps?.laps.find(
    (lap) =>
      lap.lap_number === laps.best_lap_time_lap_num &&
      lap.source === "session_history",
  );
  return best ? `${lapTime(best.lap_time_ms)} on lap ${best.lap_number}` : "—";
}

function EventsTable({ detail }: { detail: Detail }) {
  const rows = f1EventRows(detail);
  const [limit, setLimit] = useState(PAGE_SIZE);
  if (rows.length === 0) {
    return (
      <p className="pane-empty">No F1 25 event was recorded in this session.</p>
    );
  }
  return (
    <div className="session-events">
      {detail.events_not_shown > 0 ? (
        <p className="inline-alert tone-warn" role="status">
          This session holds {integer(detail.events_total)} events; the first{" "}
          {integer(detail.events.length)} are listed here.
        </p>
      ) : null}
      <table className="data-table">
        <caption className="visually-hidden">F1 25 events</caption>
        <thead>
          <tr>
            <th scope="col" className="numeric">
              Session time
            </th>
            <th scope="col">Event</th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map((row) => (
            <tr key={row.key} data-code={row.code}>
              <td className="numeric">{row.time}</td>
              <td>
                {row.name}
                {row.player ? <span className="event-you"> · you</span> : null}
              </td>
              <td>{row.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <ShowMore
        shown={Math.min(limit, rows.length)}
        total={rows.length}
        noun="events"
        onMore={() => setLimit((value) => value + PAGE_SIZE)}
      />
    </div>
  );
}
