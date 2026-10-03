import {
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { activeGameStore } from "../../state/active-game.ts";
import {
  f1LiveStore,
  f1RecorderStore,
  liveStore,
  recorderStore,
  setupStore,
  transportStore,
} from "../../state/stores.ts";
import { useDerived } from "../../state/use-store.ts";
import { integer } from "../../telemetry/formatting.ts";
import { shellStatus } from "../../telemetry/shell-view-model.ts";
import { Icon } from "./Icon";

const STORES = [
  liveStore,
  recorderStore,
  transportStore,
  setupStore,
  f1LiveStore,
  f1RecorderStore,
  activeGameStore,
];

function readShell() {
  return shellStatus({
    live: liveStore.get(),
    recorder: recorderStore.get(),
    transport: transportStore.get(),
    setup: setupStore.get(),
    f1Live: f1LiveStore.get(),
    activeGame: activeGameStore.get(),
    f1Recorder: f1RecorderStore.get(),
  });
}

/// Persistent global status: one primary state, the facts a driver checks,
/// and the recording indicator. The four detailed V1.0 readings are one click
/// away. Re-renders only when the text it shows changes — about once a second
/// while a session clock runs, not at the 20 Hz live rate.
///
/// The details are a non-modal disclosure, not a dialog: nothing traps focus.
/// The panel follows its trigger in the DOM and is itself a tab stop, so Tab
/// from the trigger reaches it; Escape closes it and returns focus to the
/// trigger; moving focus or clicking anywhere else closes it.
export function TopBar() {
  const model = useDerived(STORES, readShell);
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: Event) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (open && event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    }
  }

  function onBlur(event: FocusEvent<HTMLDivElement>) {
    const next = event.relatedTarget as Node | null;
    if (open && next != null && !root.current?.contains(next)) {
      setOpen(false);
    }
  }

  const { state, recording } = model;
  return (
    <header className="topbar" data-state={state.kind}>
      <div
        className="topbar-state"
        ref={root}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      >
        <button
          ref={trigger}
          type="button"
          className={`state-pill tone-${state.tone}`}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="state-dot" aria-hidden="true" />
          <span className="visually-hidden">Status: </span>
          <span className="state-pill-title">
            {state.countdown ? (
              <>
                {state.countdown.lead}
                {/* A fixed tabular slot sized to the longest possible figure:
                    the pill keeps its width while the countdown ticks. */}
                <span
                  className="state-pill-figure"
                  style={{ minWidth: `${state.countdown.digits}ch` }}
                >
                  {state.countdown.figure}
                </span>
                {state.countdown.tail}
              </>
            ) : (
              state.title
            )}
          </span>
          <Icon name="chevron-down" size={14} />
        </button>
        <div
          className="state-popover"
          id={panelId}
          role="group"
          aria-label="Connection details"
          tabIndex={0}
          hidden={!open}
        >
          <p className="state-popover-detail">{state.detail}</p>
          <dl className="state-popover-items">
            {model.items.map((item) => (
              <div key={item.key} className={`tone-${item.tone}`}>
                <dt>{item.label}</dt>
                <dd>
                  <span className="state-glyph" aria-hidden="true">
                    {item.glyph}
                  </span>
                  {item.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>

      {model.activeGame ? (
        <p className="topbar-game" data-game={model.activeGame}>
          {model.game}
        </p>
      ) : null}

      <dl className="topbar-facts">
        {model.facts.map((fact) => (
          <div key={fact.key}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>

      <p
        className={`rec-indicator tone-${recording.tone}${
          recording.active ? " is-recording" : ""
        }`}
        data-recording-game={recording.owner ?? undefined}
      >
        <span className="rec-dot" aria-hidden="true" />
        {/* REC names the game being recorded, which need not be the game on
            screen. */}
        <span>{recording.active ? recording.label : recording.value}</span>
        {model.droppedFrames > 0 ? (
          <span className="rec-drops">
            {integer(model.droppedFrames)} dropped
          </span>
        ) : null}
      </p>
    </header>
  );
}
