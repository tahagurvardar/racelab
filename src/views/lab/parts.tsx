import { useMemo, type ReactNode } from "react";
import { useLab } from "../../hooks/use-lab.ts";
import type { LabController, LapSlot } from "../../lab-controller.ts";
import {
  labSession,
  sharedXDomain,
  type LabSessionInfo,
} from "../../telemetry-lab.ts";
import { assessLap, type LapQuality } from "../../lap-quality.ts";

/// A raised Lab panel. `tone` tints it for the reference lap or the delta.
export function LabPanel({
  tone = "neutral",
  title,
  aside,
  className = "",
  children,
  labelledBy,
}: {
  tone?: "neutral" | "current" | "reference" | "delta" | "chart";
  title?: ReactNode;
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
  labelledBy?: string;
}) {
  return (
    <section
      className={`lab-panel tone-${tone} ${className}`}
      aria-labelledby={labelledBy}
    >
      {title != null || aside != null ? (
        <header className="lab-panel-header">
          {title}
          {aside != null ? (
            <span className="lab-panel-aside">{aside}</span>
          ) : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

/// "● CURRENT" / "● REFERENCE": the slot's colour beside its name.
export function SlotTitle({
  slot,
  children,
  id,
}: {
  slot: LapSlot | "neutral";
  children: ReactNode;
  id?: string;
}) {
  return (
    <h3 className={`lab-slot-title slot-${slot}`} id={id}>
      <span className="lab-slot-dot" aria-hidden="true" />
      {children}
    </h3>
  );
}

/// Why a panel shows no reading. Never a value.
export function LabEmpty({ children }: { children: ReactNode }) {
  return <p className="lab-empty">{children}</p>;
}

export function useSessionInfo(
  controller: LabController,
): LabSessionInfo | null {
  const detail = useLab(controller, (state) => state.detail);
  return useMemo(() => (detail ? labSession(detail) : null), [detail]);
}

/// M4: what the slot's lap record and its loaded samples establish. Null
/// when no lap is chosen. Recomputed only when the record, the trace or the
/// circuit length changes.
export function useLapQuality(
  controller: LabController,
  slot: LapSlot,
): LapQuality | null {
  const lap = useLab(controller, (state) => state[slot].lap);
  const trace = useLab(controller, (state) => state[slot].trace);
  const records = useLab(controller, (state) => state.detail?.laps?.laps);
  const info = useSessionInfo(controller);
  const length = info?.trackLengthM ?? null;
  return useMemo(() => {
    if (lap == null) return null;
    const record = records?.find((item) => item.lap_number === lap) ?? null;
    return assessLap(lap, record, trace, length);
  }, [lap, trace, records, length]);
}

/// The x range every chart, the viewport and the cursor share.
export function useLabDomain(controller: LabController) {
  const current = useLab(controller, (state) => state.current.trace);
  const reference = useLab(controller, (state) => state.reference.trace);
  const axis = useLab(controller, (state) => state.axis);
  const info = useSessionInfo(controller);
  const length = info?.trackLengthM ?? null;
  return useMemo(
    () => sharedXDomain([current, reference], axis, length),
    [current, reference, axis, length],
  );
}

/// The cursor's position as the axis reads it: "1.24 km" or "1:02.345".
export function cursorText(cursor: number | null, axis: "time" | "distance") {
  if (cursor == null) return "—";
  if (axis === "distance") return `${(cursor / 1000).toFixed(2)} km`;
  const ms = Math.max(0, Math.round(cursor));
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}
