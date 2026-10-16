import { useLab } from "../../hooks/use-lab.ts";
import type { LabController, LapSlot } from "../../lab-controller.ts";
import type { LabLap } from "../../telemetry-lab.ts";
import { Icon } from "../../components/shell/Icon";
import { useSessionInfo } from "./parts";

/// The left column: what the session was, and which two laps are compared.
/// Every fact comes from the session's own record; a fact RaceLab does not
/// record reads as unavailable and says why.
export function LabSessionColumn({
  controller,
  onClose,
}: {
  controller: LabController;
  onClose: () => void;
}) {
  const info = useSessionInfo(controller);
  const error = useLab(controller, (state) => state.detailError);

  return (
    <aside className="lab-column lab-session" aria-label="Session">
      <p className="lab-column-label">Session info</p>
      {error ? (
        <p className="inline-alert tone-bad" role="alert">
          This session could not be read: {error}
        </p>
      ) : null}

      <div className="lab-card lab-session-type">
        <p className="lab-display">{info?.sessionType ?? "—"}</p>
      </div>

      <div className="lab-card lab-identity">
        <span className="lab-identity-tile" aria-hidden="true">
          <Icon name="track" size={22} />
        </span>
        <div className="lab-identity-text">
          <p className="lab-display lab-identity-title">{info?.track ?? "—"}</p>
          <p className="lab-identity-detail">
            {info?.trackLengthM != null
              ? `${(info.trackLengthM / 1000).toFixed(3)} km`
              : "Track length not recorded"}
          </p>
        </div>
      </div>

      <div className="lab-card lab-car">
        <p className="lab-card-label">
          <span className="lab-slot-dot slot-current" aria-hidden="true" />
          Current car
        </p>
        <div className="lab-car-main">
          <span className="lab-identity-tile" aria-hidden="true">
            {initials(info?.team)}
          </span>
          <div className="lab-identity-text">
            <p className="lab-display lab-identity-title">
              {info?.team ?? "—"}
            </p>
            <p className="lab-identity-detail">
              {info ? `Race number ${info.raceNumber}` : "—"}
            </p>
          </div>
        </div>
        <div className="lab-car-footer">
          {info?.formula ? (
            <span className="lab-chip">{info.formula}</span>
          ) : (
            <span className="lab-chip is-muted">Formula unknown</span>
          )}
          <span className="lab-driver">
            <Icon name="user" size={14} />
            {info?.driver ?? "—"}
          </span>
        </div>
      </div>

      <dl className="lab-facts">
        <Fact label="Weather" value={info?.weather} tone="cool" />
        <Fact label="Track temp" value={info?.trackTemperature} tone="warm" />
        <Fact
          label="Track time"
          value={null}
          note="Time of day is not recorded"
        />
        <Fact label="Session time" value={info?.sessionTime} tone="time" />
      </dl>

      <AnalysisLaps controller={controller} />

      <button type="button" className="lab-back" onClick={onClose}>
        <Icon name="arrow-left" />
        Sessions
      </button>
    </aside>
  );
}

function initials(name: string | null | undefined): string {
  if (!name || name === "—") return "—";
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");
}

function Fact({
  label,
  value,
  tone = "plain",
  note,
}: {
  label: string;
  value: string | null | undefined;
  tone?: "plain" | "cool" | "warm" | "time";
  note?: string;
}) {
  const available = value != null && value !== "—";
  return (
    <div className="lab-fact" title={available ? undefined : note}>
      <dt>{label}</dt>
      <dd className={available ? `tone-${tone}` : "is-unavailable"}>
        {available ? value : "—"}
        {!available && note ? (
          <span className="visually-hidden">: {note}</span>
        ) : null}
      </dd>
    </div>
  );
}

function AnalysisLaps({ controller }: { controller: LabController }) {
  const laps = useLab(controller, (state) => state.laps);
  return (
    <div className="lab-card lab-laps">
      <p className="lab-column-label lab-laps-title">Analysis laps</p>
      <LapPicker controller={controller} slot="current" laps={laps} />
      <LapPicker controller={controller} slot="reference" laps={laps} />
      {laps.length === 0 ? (
        <p className="lab-note">This session recorded no completed lap.</p>
      ) : null}
    </div>
  );
}

function lapOption(lap: LabLap): string {
  const flags = [
    lap.best ? "best" : null,
    lap.valid === false ? "invalid" : null,
    lap.provisional ? "provisional" : null,
  ].filter(Boolean);
  return `${lap.label}  ${lap.time}${flags.length ? `  (${flags.join(", ")})` : ""}`;
}

function LapPicker({
  controller,
  slot,
  laps,
}: {
  controller: LabController;
  slot: LapSlot;
  laps: LabLap[];
}) {
  const selected = useLab(controller, (state) => state[slot].lap);
  const lap = laps.find((item) => item.number === selected) ?? null;
  const id = `lab-lap-${slot}`;
  return (
    <div className={`lab-lap-picker slot-${slot}`}>
      <label htmlFor={id} className="lab-lap-label">
        {slot === "current" ? "Current" : "Reference"}
      </label>
      <div className="lab-lap-value" aria-hidden="true">
        <span className="lab-lap-name">{lap?.label ?? "None"}</span>
        <span
          className={`lab-lap-time${lap?.best ? " is-best" : ""}${lap?.valid === false ? " is-invalid" : ""}`}
        >
          {lap?.time ?? "—"}
        </span>
        <Icon name="chevron-down" />
      </div>
      <select
        id={id}
        className="lab-lap-select"
        value={selected ?? ""}
        onChange={(event) =>
          controller.setLap(
            slot,
            event.target.value === "" ? null : Number(event.target.value),
          )
        }
      >
        {slot === "reference" ? <option value="">No reference</option> : null}
        {laps.map((item) => (
          <option key={item.number} value={item.number}>
            {lapOption(item)}
          </option>
        ))}
      </select>
    </div>
  );
}
