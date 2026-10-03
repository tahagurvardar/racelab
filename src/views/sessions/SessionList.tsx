import { useEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { useRecorder } from "../../hooks/use-recorder-status.ts";
import { useSessions } from "../../hooks/use-sessions.ts";
import type { SessionsController } from "../../session-controller.ts";
import {
  listNotices,
  recorderRow,
  sessionDays,
  storageUsage,
} from "../../session-workspace.ts";
import { recorderStore } from "../../state/stores.ts";
import { useDerived } from "../../state/use-store.ts";
import { integer } from "../../telemetry/formatting.ts";
import { Badge } from "./parts";

const RECORDER = [recorderStore];

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
/// on its own and the list around it stays still.
export function RecordingRow() {
  const row = useDerived(RECORDER, () => recorderRow(recorderStore.get()));
  if (row == null) return null;
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

/// Re-reads the listing when a recording completes — the only event that can
/// add a session. Renders nothing; isolated so the recorder's 2 Hz status
/// never re-renders the list itself.
export function ListRefresher({
  controller,
}: {
  controller: SessionsController;
}) {
  const completed = useRecorder(
    (state) => state.recorder?.completed_sessions ?? null,
  );
  const seen = useRef<number | null>(null);
  useEffect(() => {
    const previous = seen.current;
    seen.current = completed;
    // The first reading is not a completion; the workspace already read the
    // listing when it opened.
    if (previous != null && completed != null && completed !== previous) {
      void controller.refreshList();
    }
  }, [completed, controller]);
  return null;
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
  const recordingId = useRecorder((state) =>
    state.recorder?.recording ? state.recorder.session_id : null,
  );
  const sessions = list.recent?.sessions;
  // Rebuilt only when the listing or the recording session changes — never
  // on a recorder tick and never while a session's analysis loads.
  const days = useMemo(
    () => sessionDays(sessions ?? [], Date.now(), recordingId),
    [sessions, recordingId],
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
    if (box instanceof HTMLElement) reveal(box, option);
    const workspace = option.closest(".workspace");
    if (workspace instanceof HTMLElement) reveal(workspace, option);
  }, [selectedId]);

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
              {integer(sessions.length)}
              {list.recent && sessions.length >= list.recent.limit
                ? " newest"
                : ""}
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
        <p className="pane-empty">No sessions recorded yet.</p>
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
                  <div
                    key={row.id}
                    ref={(node) => {
                      if (node) options.current.set(row.id, node);
                      else options.current.delete(row.id);
                    }}
                    role="option"
                    id={`session-option-${row.id}`}
                    aria-selected={selected}
                    aria-label={row.label}
                    tabIndex={row.id === tabStop ? 0 : -1}
                    className={`session-option${selected ? " is-selected" : ""}`}
                    data-session={row.id}
                    onClick={() => choose(row.id, false)}
                  >
                    <span className="session-option-time">{row.time}</span>
                    <span className="session-option-duration">
                      {row.duration}
                    </span>
                    <span className="session-option-meta">
                      <span className="session-option-vehicle">
                        {row.vehicle}
                      </span>
                      {row.badges.map((badge) => (
                        <Badge key={badge.key} badge={badge} />
                      ))}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
