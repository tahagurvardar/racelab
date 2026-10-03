import { useRef, useState, type ReactNode, type PointerEvent } from "react";
import { offsetClock } from "../telemetry/formatting.ts";

// All evidence lanes live under one timebase and one cursor. The wrapper
// knows nothing about a game's schema or how the evidence was calculated.
export function SharedTimeline({
  durationMs,
  children,
  inspector,
}: {
  durationMs: number;
  children: ReactNode;
  inspector?: (timeMs: number) => ReactNode;
}) {
  const [fraction, setFraction] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const time = Math.round(fraction * durationMs);
  function point(event: PointerEvent<HTMLDivElement>) {
    const track = root.current
      ?.querySelector(".timeline-track")
      ?.getBoundingClientRect();
    if (!track || track.width <= 0 || event.clientX < track.left) return;
    setFraction(
      Math.max(0, Math.min(1, (event.clientX - track.left) / track.width)),
    );
  }
  return (
    <div className="shared-timeline">
      <div
        ref={root}
        className="shared-timebase"
        onPointerMove={point}
        onPointerDown={point}
      >
        {children}
        <div className="shared-cursor-space" aria-hidden="true">
          <div
            className="shared-cursor"
            style={{ left: `${fraction * 100}%` }}
          />
        </div>
      </div>
      <div className="timeline-toolbar">
        <label htmlFor="session-time-cursor">Time cursor</label>
        <input
          id="session-time-cursor"
          aria-label="Shared timeline cursor"
          type="range"
          min={0}
          max={durationMs}
          step={1}
          value={time}
          onChange={(event) =>
            setFraction(Number(event.target.value) / durationMs)
          }
          aria-valuetext={offsetClock(time)}
        />
        <output htmlFor="session-time-cursor">{offsetClock(time)}</output>
      </div>
      {inspector ? (
        <div className="timeline-inspector">{inspector(time)}</div>
      ) : null}
    </div>
  );
}
