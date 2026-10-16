import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useLab, useLabController } from "../hooks/use-lab.ts";
import type { LabController } from "../lab-controller.ts";
import { Wordmark } from "../components/brand/Brand";
import { Icon } from "../components/shell/Icon";
import { LabSessionColumn } from "../views/lab/LabSessionColumn";
import { LabTrackViewport } from "../views/lab/LabTrackViewport";
import { LabCharts } from "../views/lab/LabCharts";
import { LabCompareColumn } from "../views/lab/LabCompareColumn";
import { traceNotes } from "../telemetry-lab.ts";
import { dayLabel, timeOfDay } from "../session-workspace.ts";
import { useSessionInfo } from "../views/lab/parts";

/// v2.1 F1 Telemetry Lab: one completed F1 25 session, two of its laps,
/// compared on one axis and one cursor. Three columns — the session, the
/// track view with its charts, and the current/reference comparison — after
/// the approved reference layout. It reads the session's facts and bounded
/// lap traces; it never reads live telemetry or writes anything.
export default function TelemetryLabWorkspace({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const controller = useLabController(sessionId);
  return (
    <div className="telemetry-lab" data-session={sessionId}>
      {controller ? (
        <LabBody controller={controller} onClose={onClose} />
      ) : null}
    </div>
  );
}

/// Until it is resized, the track view follows the window (lab.css), at
/// about the share of the column the reference gives it.
const VIEWPORT = { min: 260, max: 720, step: 24 };

function LabBody({
  controller,
  onClose,
}: {
  controller: LabController;
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState<number | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const height = chosen ?? Math.round(frame.current?.offsetHeight ?? 0);
  const setHeight = (next: number | ((current: number) => number)) =>
    setChosen((current) => {
      const base = current ?? frame.current?.offsetHeight ?? VIEWPORT.min;
      return typeof next === "function" ? next(base) : next;
    });
  // The control that opened the Lab is gone with Sessions; continue from the
  // Lab's title rather than from the page.
  useEffect(() => {
    const active = document.activeElement;
    if (active == null || active === document.body || !active.isConnected) {
      document.getElementById("lab-title")?.focus({ preventScroll: true });
    }
  }, []);
  const clamp = (value: number) =>
    Math.min(VIEWPORT.max, Math.max(VIEWPORT.min, value));

  function drag(event: ReactPointerEvent<HTMLDivElement>) {
    const startY = event.clientY;
    const startHeight = chosen ?? frame.current?.offsetHeight ?? VIEWPORT.min;
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    const move = (next: PointerEvent) =>
      setHeight(clamp(startHeight + next.clientY - startY));
    const stop = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", stop);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", stop);
  }

  function key(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowUp") setHeight((h) => clamp(h - VIEWPORT.step));
    else if (event.key === "ArrowDown")
      setHeight((h) => clamp(h + VIEWPORT.step));
    else return;
    event.preventDefault();
  }

  return (
    <>
      <LabSessionColumn controller={controller} onClose={onClose} />
      <section className="lab-column lab-center" aria-labelledby="lab-title">
        <LabHeader controller={controller} />
        <div
          ref={frame}
          className="lab-viewport-frame"
          style={
            chosen == null
              ? undefined
              : ({ "--lab-viewport-h": `${chosen}px` } as CSSProperties)
          }
        >
          <LabTrackViewport controller={controller} />
        </div>
        <div
          className="lab-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Track view height"
          aria-valuemin={VIEWPORT.min}
          aria-valuemax={VIEWPORT.max}
          aria-valuenow={height || undefined}
          tabIndex={0}
          onPointerDown={drag}
          onKeyDown={key}
        >
          <span aria-hidden="true" />
        </div>
        <TraceNotes controller={controller} />
        <LabCharts controller={controller} />
      </section>
      <LabCompareColumn controller={controller} />
    </>
  );
}

function LabHeader({ controller }: { controller: LabController }) {
  const status = useLab(
    controller,
    (state) => state.detail?.session.racelab_session.status ?? null,
  );
  return (
    <header className="lab-header">
      <div className="lab-brand">
        <span className="lab-brand-mark">
          <Wordmark />
        </span>
        <h1 id="lab-title" className="lab-brand-title" tabIndex={-1}>
          Telemetry Lab
        </h1>
        <span className="lab-brand-divider" aria-hidden="true" />
        <span className="lab-brand-view">Telemetry view</span>
      </div>
      <div className="lab-header-tools">
        <div
          className="lab-dimension"
          role="group"
          aria-label="Track view mode"
          title="2D and 3D track views need recorded car positions"
        >
          <button type="button" disabled>
            2D
          </button>
          <button type="button" disabled>
            3D
          </button>
        </div>
        <RecordedSession controller={controller} />
        <button
          type="button"
          className="lab-icon-button"
          aria-label="Reload laps"
          title="Reload laps"
          onClick={() => {
            const state = controller.store.get();
            controller.setLap("current", null);
            controller.setLap("current", state.current.lap);
            controller.setLap("reference", null);
            controller.setLap("reference", state.reference.lap);
          }}
        >
          <Icon name="refresh" />
        </button>
      </div>
      {status != null && status !== "completed" ? (
        <p className="inline-alert tone-warn lab-header-alert" role="status">
          Telemetry Lab opens completed sessions only. This session is {status}.
        </p>
      ) : null}
    </header>
  );
}

/// Which recording this is: the Lab's own session context, kept apart from
/// the live status in the top bar.
function RecordedSession({ controller }: { controller: LabController }) {
  const info = useSessionInfo(controller);
  const started = useLab(
    controller,
    (state) => state.detail?.session.racelab_session.started_at_unix_ms ?? null,
  );
  return (
    <div className="lab-recorded" role="group" aria-label="Recorded session">
      <span className="lab-recorded-icon" aria-hidden="true">
        <Icon name="sessions" />
      </span>
      <span className="lab-recorded-text">
        <span className="lab-recorded-title">Recorded · F1 25</span>
        <span className="lab-recorded-detail">
          {started == null
            ? "Start time unknown"
            : `${dayLabel(started, Date.now())} · ${timeOfDay(started)}`}
          {info ? ` · ${info.track} ${info.sessionType}` : ""}
        </span>
      </span>
    </div>
  );
}

function TraceNotes({ controller }: { controller: LabController }) {
  const current = useLab(controller, (state) => state.current.trace);
  const reference = useLab(controller, (state) => state.reference.trace);
  const notes = [
    ...traceNotes(current).map((note) => `Current lap: ${note}`),
    ...traceNotes(reference).map((note) => `Reference lap: ${note}`),
  ];
  if (notes.length === 0) return null;
  return (
    <ul className="lab-trace-notes" aria-label="Data quality">
      {notes.map((note) => (
        <li key={note}>{note}</li>
      ))}
    </ul>
  );
}
