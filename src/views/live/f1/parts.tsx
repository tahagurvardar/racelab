import type { ReactNode } from "react";
import type { FamilyStatus } from "../../../telemetry/f1-live-layout.ts";

const GLYPHS = { fresh: "●", stale: "◐", unavailable: "○" } as const;

/// One packet family's state in words with a glyph, never by colour alone:
/// "Car telemetry · Updating", "Lap data · Not updating · 1.4 s".
export function FamilyBadge({ family }: { family: FamilyStatus }) {
  return (
    <span
      className={`family-badge is-${family.freshness}`}
      data-family={family.key}
      data-freshness={family.freshness}
    >
      <span className="state-glyph" aria-hidden="true">
        {GLYPHS[family.freshness]}
      </span>
      <span className="family-badge-name">{family.name}</span>
      <span className="family-badge-text">{family.text}</span>
    </span>
  );
}

/// Where a tab's values come from. Each family ages on its own; this line is
/// how the screen says so.
export function FamilyLine({ families }: { families: FamilyStatus[] }) {
  return (
    <p className="family-line" aria-label="Data sources">
      {families.map((family) => (
        <FamilyBadge key={family.key} family={family} />
      ))}
    </p>
  );
}

/// A titled F1 25 panel with the state of the family its values come from.
export function F1Panel({
  title,
  family,
  className = "",
  children,
}: {
  title: string;
  family?: FamilyStatus;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`live-panel f1-panel ${className}`} aria-label={title}>
      <header className="f1-panel-head">
        <h2 className="live-section-title">{title}</h2>
        {family ? <FamilyBadge family={family} /> : null}
      </header>
      {children}
    </section>
  );
}
