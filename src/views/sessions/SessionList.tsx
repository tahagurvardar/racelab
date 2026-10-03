import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { useF1Recorder } from "../../hooks/use-f1-recorder-status.ts";
import { useRecorder } from "../../hooks/use-recorder-status.ts";
import { useSessions } from "../../hooks/use-sessions.ts";
import type { SessionsController } from "../../session-controller.ts";
import {
  listNotices,
  recorderRow,
  storageUsage,
} from "../../session-workspace.ts";
import {
  GAME_FILTERS,
  f1RecordingRow,
  multiGameDays,
} from "../../f1-sessions.ts";
import { f1RecorderStore, recorderStore } from "../../state/stores.ts";
import { useDerived } from "../../state/use-store.ts";
import { integer } from "../../telemetry/formatting.ts";
import { SessionRow } from "./SessionRow";

const RECORDER = [recorderStore];
const F1_RECORDER = [f1RecorderStore];

/// Scrolls `container` by exactly as much as `element` is cut off by it.
export function reveal(container: HTMLElement, element: HTMLElement): void {
  const outer = container.getBoundingClientRect();
  const inner = element.getBoundingClientRect();
  if (inner.top < outer.top) {
    container.scrollTop -= outer.top - inner.top;
  } else if (inner.bottom > outer.bottom) {
    container.scrollTop += Math.min(
      inner.bottom - outer.bottom,
      // Never push the top of a tall row out of view to show its bottom.
      inner.top - outer.top,
    );
  }
}

/// The pinned "now" row. The only part of the list that follows the recorder
/// while it records (duration ticks at the recorder's 2 Hz), so it subscribes
/// on its own and the list around it stays still. Only one game records at a
/// time; the F1 25 row appears only while F1 25 is the one recording.
export function RecordingRow() {
  const row = useDerived(RECORDER, () => recorderRow(recorderStore.get()));
  if (row == null) return <F1RecordingRow />;
  return (
    <div className={`recording-row tone-${row.tone}`}>
      <span className="recording-row-dot" aria-hidden="true" />
      {/* Only the state is a live region: the duration ticks every second
          and must never be announced as it does. */}
      <span className="recording-row-title" role="status">
        {row.title}
      </span>
      {row.duration ? (
        <span className="recording-row-figure">{row.duration}</span>
      ) : null}
      {row.vehicle || row.drops > 0 ? (
        <span className="recording-row-meta">
          {[
            row.vehicle,
            row.drops > 0 ? `${integer(row.drops)} frames dropped` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
      ) : null}
      {row.detail ? (
        <span className="recording-row-meta mono">{row.detail}</span>
      ) : null}
    </div>
  );
}

function F1RecordingRow() {
  const row = useDerived(F1_RECORDER, () =>
    f1RecordingRow(f1RecorderStore.get().status),
  );
  if (row == null) return null;
  return (
    <div className={`recording-row tone-${row.tone}`} data-game="f1_25">
      <span className="recording-row-dot" aria-hidden="true" />
      <span className="recording-row-title" role="status">
        {row.title}
      </span>
      {row.duration ? (
        <span className="recording-row-figure">{row.duration}</span>
      ) : null}
      {row.detail ? (
        <span className="recording-row-meta">{row.detail}</span>
      ) : null}
    </div>
  );
}

/// Re-reads the listing when a recording completes — the only event that can
/// add a session. Renders nothing; isolated so the recorder's 2 Hz status
/// never re-renders the list itself. Either game's recorder counts.
export function ListRefresher({
  controller,
}: {
  controller: SessionsController;
}) {
  const completed = useRecorder(
    (state) => state.recorder?.completed_sessions ?? null,
  );
  // Any finalized F1 25 recording, completed or interrupted, adds a session.
  const f1Finalized = useF1Recorder(
    (state) => state.status?.last_completed_session_id ?? null,
  );
  useRefreshOnChange(completed, controller);
  useRefreshOnChange(f1Finalized, controller);
  return null;
}

/// Refreshes the listing when `value` changes after its first reading. The
/// first reading is not a completion: the workspace already read the
/// listing when it opened.
function useRefreshOnChange(
  value: number | string | null,
  controller: SessionsController,
) {
  const seen = useRef<number | string | null | undefined>(undefined);
  useEffect(() => {
    const previous = seen.current;
    seen.current = value;
    if (previous !== undefined && value != null && value !== previous) {
      void controller.refreshList();
    }
  }, [value, controller]);
}

/// Session history: storage use, the recording row, then sessions by day.
///
/// A single-select listbox. Arrow keys move the selection (and the focus with
/// it); the selected row carries `aria-selected` and the accent edge. Choosing
/// a session never scrolls the page or moves focus away from the list.
export function SessionList({
  controller,
  onOpenSettings,
}: {
  controller: SessionsController;
  onOpenSettings?: () => void;
}) {
  const list = useSessions(controller, (state) => state.list);
  const selectedId = useSessions(
    controller,
    (state) => state.selected?.id ?? null,
  );
  const filter = useSessions(controller, (state) => state.filter);
  const recordingId = useRecorder((state) =>
    state.recorder?.recording ? state.recorder.session_id : null,
  );
  const f1RecordingId = useF1Recorder((state) =>
    state.status?.recording ? state.status.session_id : null,
  );
  const sessions = list.recent?.sessions;
  const f1Sessions = list.recent?.f1_sessions;
  const total = (sessions?.length ?? 0) + (f1Sessions?.length ?? 0);
  // Rebuilt only when the listing, the filter or a recording session
  // changes — never on a recorder tick and never while a session loads.
  const days = useMemo(
    () =>
      multiGameDays(
        sessions ?? [],
        f1Sessions ?? [],
        Date.now(),
        recordingId,
        f1RecordingId,
        filter,
      ),
    [sessions, f1Sessions, recordingId, f1RecordingId, filter],
  );
  const notices = useMemo(
    () => listNotices(list.recent, list.storage),
    [list.recent, list.storage],
  );
  const usage = storageUsage(list.storage);
  const ids = days.flatMap((day) => day.rows.map((row) => row.id));
  const options = useRef(new Map<string, HTMLDivElement>());

  // Keep the selected row fully visible: first inside the list's own scroll
  // area, then inside the workspace. Each is scrolled only by the distance
  // the row is cut off, so a row already in view never moves anything.
  useEffect(() => {
    if (selectedId == null) return;
    const option = options.current.get(selectedId);
    if (!option) return;
    const box = option.closest(".session-listbox");
    const workspace = option.closest(".workspace");
    const keepVisible = () => {
      if (box instanceof HTMLElement) reveal(box, option);
      if (workspace instanceof HTMLElement) reveal(workspace, option);
    };
    keepVisible();
    // Detail loading or font/layout changes can resize the list after the
    // selection effect. Observe dimensions, without following recorder ticks
    // or forcing a scroll when the row is already visible.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(keepVisible);
    observer.observe(option);
    if (box instanceof HTMLElement) observer.observe(box);
    return () => observer.disconnect();
  }, [selectedId, days]);

  function choose(id: string, focus: boolean) {
    controller.select(id);
    if (focus) options.current.get(id)?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (ids.length === 0) return;
    const index = selectedId == null ? -1 : ids.indexOf(selectedId);
    const next =
      event.key === "ArrowDown"
        ? Math.min(ids.length - 1, index + 1)
        : event.key === "ArrowUp"
          ? Math.max(0, index - 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? ids.length - 1
              : -2;
    if (next === -2) return;
    event.preventDefault();
    choose(ids[next], true);
  }

  const tabStop =
    selectedId != null && ids.includes(selectedId) ? selectedId : ids[0];

  return (
    <section className="sessions-master" aria-labelledby="sessions-history">
      <header className="sessions-master-header">
        <h2 id="sessions-history" className="pane-title">
          History
          {sessions ? (
            // The space keeps "History" and the count two words for a
            // screen reader; the flex gap spaces them on screen.
            <span className="pane-count">
              {" "}
              {integer(total)}
              {list.recent && total >= list.recent.limit ? " newest" : ""}
            </span>
          ) : null}
        </h2>
        {usage ? (
          <div className="storage-usage">
            <span className="storage-usage-text">
              <span className="visually-hidden">Storage used: </span>
              {usage.text}
            </span>
            {usage.fraction != null ? (
              <span className="storage-meter" aria-hidden="true">
                <span
                  className="storage-meter-fill"
                  style={{ width: `${(usage.fraction * 100).toFixed(1)}%` }}
                />
              </span>
            ) : null}
            {onOpenSettings ? (
              <button
                type="button"
                className="link-button"
                onClick={onOpenSettings}
              >
                Storage limit
              </button>
            ) : null}
          </div>
        ) : null}
      </header>

      <RecordingRow />

      {(f1Sessions?.length ?? 0) > 0 ? (
        // Presentation only, and only once there is more than one game to
        // tell apart.
        <div
          className="filter-chips session-game-filter"
          role="group"
          aria-label="Show sessions of one game"
        >
          {GAME_FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="chip"
              aria-pressed={filter === item.id}
              onClick={() => controller.setFilter(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="session-column-head" aria-hidden="true">
        <span>Time</span>
        <span>Vehicle or session</span>
        <span>Duration</span>
      </div>

      {notices.length > 0 ? (
        <ul className="list-notices">
          {notices.map((notice) => (
            <li key={notice.key} className={`list-notice tone-${notice.tone}`}>
              {notice.text}
            </li>
          ))}
        </ul>
      ) : null}

      {list.error ? (
        <p className="inline-alert tone-bad" role="alert">
          Sessions could not be listed: {list.error}
        </p>
      ) : null}

      {!list.loaded ? (
        <p className="pane-empty" role="status">
          Reading recorded sessions…
        </p>
      ) : ids.length === 0 ? (
        <p className="pane-empty">
          {total > 0
            ? "No sessions of this game are listed."
            : "No sessions recorded yet."}
        </p>
      ) : (
        <div
          className="session-listbox"
          role="listbox"
          aria-label="Recorded sessions"
          onKeyDown={onKeyDown}
        >
          {days.map((day) => (
            <div
              key={day.key}
              role="group"
              aria-labelledby={`day-${day.key}`}
              className="session-day"
            >
              <div
                id={`day-${day.key}`}
                className="session-day-label"
                role="presentation"
              >
                {day.label}
              </div>
              {day.rows.map((row) => {
                const selected = row.id === selectedId;
                return (
                  <SessionRow
                    key={row.id}
                    row={row}
                    game={row.gameName}
                    gameId={row.game}
                    selected={selected}
                    tabStop={row.id === tabStop}
                    onSelect={() => choose(row.id, false)}
                    ref={(node) => {
                      if (node) options.current.set(row.id, node);
                      else options.current.delete(row.id);
                    }}
                  />
                );
              })}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
