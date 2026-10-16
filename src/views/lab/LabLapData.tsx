import type { ReactNode } from "react";
import { sectorTime } from "../../f1-sessions.ts";
import type { LabController, LapSlot } from "../../lab-controller.ts";
import {
  analysisStatus,
  sourceLabel,
  validityLabel,
  type LapQuality,
} from "../../lap-quality.ts";
import { lapClock } from "../../telemetry-lab.ts";
import { useLapQuality } from "./parts";

/// M4: one line under a lap picker — where the lap's timing comes from,
/// whether the game counted it, and what its samples allow.
export function LapBadges({
  controller,
  slot,
}: {
  controller: LabController;
  slot: LapSlot;
}) {
  const quality = useLapQuality(controller, slot);
  if (quality == null) return null;
  const validity = validityLabel(quality);
  const status = analysisStatus(quality);
  return (
    <p
      className={`lab-lap-badges slot-${slot}`}
      aria-label={`${slot === "current" ? "Current" : "Reference"} lap ${quality.lap}: ${sourceLabel(quality)}, ${validity.label}, ${status.label}`}
    >
      <span
        className={`lab-badge tone-${quality.timing.source === "session_history" ? "neutral" : "warn"}`}
      >
        {sourceLabel(quality)}
      </span>
      <span className={`lab-badge tone-${validity.tone}`}>
        {validity.label}
      </span>
      <span className={`lab-badge tone-${status.tone}`}>{status.label}</span>
    </p>
  );
}

function percent(share: number | null): string {
  return share == null ? "—" : `${Math.round(share * 100)}%`;
}

function sector(quality: LapQuality | null, index: 0 | 1 | 2) {
  if (quality == null) return <span className="is-unavailable">—</span>;
  const ms = quality.timing.sectorsMs[index];
  const valid = quality.timing.sectorsValid[index];
  return (
    <span className={valid === false ? "is-invalid" : undefined}>
      {sectorTime(ms)}
      {valid === false ? (
        <span className="visually-hidden"> (invalid)</span>
      ) : null}
    </span>
  );
}

function ends(quality: LapQuality | null): string {
  const c = quality?.coverage;
  if (c == null) return "—";
  const word = (captured: boolean | null) =>
    captured == null ? "—" : captured ? "yes" : "no";
  return `${word(c.startCaptured)}/${word(c.endCaptured)}`;
}

/// M4: the two laps' authoritative timing and measured coverage side by
/// side, then what keeps either from reliable distance-aligned analysis.
/// Each lap's timing source is its badge under the picker, not a row.
export function LapDataCard({ controller }: { controller: LabController }) {
  const current = useLapQuality(controller, "current");
  const reference = useLapQuality(controller, "reference");
  if (current == null && reference == null) return null;

  const rows: [string, (quality: LapQuality | null) => ReactNode][] = [
    ["Lap time", (q) => (q == null ? "—" : lapClock(q.timing.lapTimeMs))],
    ["S1", (q) => sector(q, 0)],
    ["S2", (q) => sector(q, 1)],
    ["S3", (q) => sector(q, 2)],
    [
      "Samples",
      (q) =>
        q?.coverage == null
          ? "—"
          : q.coverage.expectedSamples == null
            ? `${q.coverage.samples}`
            : `${q.coverage.samples}/${q.coverage.expectedSamples}`,
    ],
    ["Time covered", (q) => percent(q?.coverage?.timeCoverage ?? null)],
    ["Track covered", (q) => percent(q?.coverage?.distanceCoverage ?? null)],
    [
      "Longest break",
      (q) =>
        q?.coverage?.maxIntervalMs == null
          ? "—"
          : `${Math.round(q.coverage.maxIntervalMs)} ms`,
    ],
    ["Start / end", ends],
  ];

  const issues = [
    ...(current?.issues ?? []).map((issue) => ({ slot: "Current", ...issue })),
    ...(reference?.issues ?? []).map((issue) => ({
      slot: "Reference",
      ...issue,
    })),
  ];

  return (
    <section
      className="lab-card lab-lapdata"
      aria-labelledby="lab-lapdata-title"
    >
      <p className="lab-column-label" id="lab-lapdata-title">
        Lap data
      </p>
      <table className="lab-lapdata-table">
        <thead>
          <tr>
            <th scope="col">
              <span className="visually-hidden">Measure</span>
            </th>
            <th scope="col" className="slot-current">
              {current ? `Lap ${current.lap}` : "Current"}
            </th>
            <th scope="col" className="slot-reference">
              {reference ? `Lap ${reference.lap}` : "Reference"}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, cell]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>{cell(current)}</td>
              <td>{cell(reference)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="lab-quiet">
        Lap and sector times from Session History when it confirmed the lap;
        coverage measured from the lap's 10 Hz samples.
      </p>
      {issues.length > 0 ? (
        <ul className="lab-issues" aria-label="Lap data findings">
          {issues.map((issue) => (
            <li
              key={`${issue.slot}-${issue.code}`}
              className={`tone-${issue.severity === "blocking" ? "warn" : "neutral"}`}
            >
              <strong>{issue.slot}:</strong> {issue.text}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
