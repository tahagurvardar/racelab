import { memo, useMemo, useState } from "react";
import {
  EVENT_ORDER,
  channelNote,
  eventRows,
  type EventKind,
  type SessionAnalysis,
} from "../../analysis-state.ts";
import { eventCapNote, kindCounts } from "../../session-workspace.ts";
import { integer } from "../../telemetry/formatting.ts";
import { PAGE_SIZE, RowToggle, ShowMore } from "./parts";

type Filter = EventKind | "all";

/// Every stored driving event, in time order, as a table. The event kinds and
/// their names are the analysis's own; the filter is a view of the stored
/// rows, never a new query.
export const EventsTab = memo(function EventsTab({
  analysis,
}: {
  analysis: SessionAnalysis;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [open, setOpen] = useState<Set<string>>(() => new Set());

  const counts = useMemo(() => kindCounts(analysis), [analysis]);
  const all = useMemo(() => eventRows(analysis, EVENT_ORDER), [analysis]);
  const rows = useMemo(
    () => (filter === "all" ? all : all.filter((row) => row.kind === filter)),
    [all, filter],
  );
  const shown = rows.slice(0, limit);
  const withCorner = shown.some((row) => row.hasCorner);
  const suspensionNote = channelNote(analysis, "suspension");
  const capNote = useMemo(() => eventCapNote(analysis), [analysis]);
  const columns = withCorner ? 8 : 7;

  function choose(next: Filter) {
    setFilter(next);
    setLimit(PAGE_SIZE);
  }

  function toggle(key: string) {
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="session-events">
      <div
        className="filter-chips"
        role="group"
        aria-label="Show events of one kind"
      >
        <button
          type="button"
          className="chip"
          aria-pressed={filter === "all"}
          onClick={() => choose("all")}
        >
          All <span className="chip-count">{integer(all.length)}</span>
        </button>
        {counts
          .filter((kind) => kind.available && kind.stored > 0)
          .map((kind) => (
            <button
              key={kind.kind}
              type="button"
              className="chip"
              aria-pressed={filter === kind.kind}
              onClick={() => choose(kind.kind)}
            >
              {kind.label}{" "}
              <span className="chip-count">{integer(kind.stored)}</span>
            </button>
          ))}
      </div>

      {capNote ? (
        <p className="inline-alert tone-warn" role="status">
          {capNote}
        </p>
      ) : null}

      {all.length === 0 ? (
        <p className="pane-empty">
          No throttle, brake, acceleration or suspension event met its RaceLab
          definition in this session.
        </p>
      ) : (
        <table className="data-table">
          <caption className="visually-hidden">
            Driving events
            {filter === "all"
              ? ""
              : `, ${counts.find((kind) => kind.kind === filter)?.label ?? ""}`}
            , in time order
          </caption>
          <thead>
            <tr>
              <th scope="col" className="toggle-col">
                <span className="visually-hidden">Details</span>
              </th>
              <th scope="col">Event</th>
              {withCorner ? <th scope="col">Corner</th> : null}
              <th scope="col" className="numeric">
                Start
              </th>
              <th scope="col" className="numeric">
                End
              </th>
              <th scope="col" className="numeric">
                Duration
              </th>
              <th scope="col" className="numeric">
                Speed
              </th>
              <th scope="col">Peak</th>
            </tr>
          </thead>
          {shown.map((row) => {
            const expanded = open.has(row.key);
            const detailId = `event-detail-${row.key}`;
            return (
              <tbody key={row.key} data-kind={row.kind}>
                <tr className={expanded ? "is-expanded" : undefined}>
                  <td className="toggle-col">
                    <RowToggle
                      expanded={expanded}
                      controls={detailId}
                      label={`${row.label} at ${row.start}`}
                      onToggle={() => toggle(row.key)}
                    />
                  </td>
                  <th scope="row">{row.label}</th>
                  {withCorner ? <td>{row.corner}</td> : null}
                  <td className="numeric">{row.start}</td>
                  <td className="numeric">{row.end}</td>
                  <td className="numeric">{row.duration}</td>
                  <td className="numeric">{row.speed}</td>
                  <td className="wrap">{row.detail}</td>
                </tr>
                {expanded ? (
                  <tr className="detail-row" id={detailId}>
                    <td />
                    <td colSpan={columns - 1}>
                      <dl className="detail-facts">
                        {row.facts.map((item) => (
                          <div key={item.key}>
                            <dt>{item.label}</dt>
                            <dd>{item.value}</dd>
                          </div>
                        ))}
                      </dl>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            );
          })}
        </table>
      )}
      <ShowMore
        shown={shown.length}
        total={rows.length}
        noun="events"
        onMore={() => setLimit((current) => current + PAGE_SIZE)}
      />

      {suspensionNote ? (
        <p className="panel-footnote">{suspensionNote}</p>
      ) : null}
      <p className="panel-footnote">
        Times are offsets from the first recorded frame. Speed is entry → exit.
        Peak is the figure that defines each kind of event. How each kind is
        detected is described under Definitions in the Data tab.
      </p>
    </div>
  );
});
