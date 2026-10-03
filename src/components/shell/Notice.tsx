import type { ReactNode } from "react";

export type NoticeTone = "neutral" | "good" | "warn" | "bad";

const GLYPHS: Record<NoticeTone, string> = {
  neutral: "○",
  good: "●",
  warn: "◐",
  bad: "✕",
};

/// An inline message inside a workspace: a short human title, an optional
/// plain sentence, and — when there is one — the backend's own words behind a
/// "Technical details" disclosure, so a report stays actionable without the
/// raw text being the message. Tone is always echoed by a glyph and words,
/// never carried by colour alone. A failure is an alert; anything else is a
/// polite status.
export function Notice({
  tone,
  title,
  children,
  technical,
  live = true,
}: {
  tone: NoticeTone;
  title: string;
  children?: ReactNode;
  /// The verbatim backend text, shown on request in a monospace block.
  technical?: string | null;
  /// False for a notice that is part of a page's static content rather than
  /// a change worth announcing.
  live?: boolean;
}) {
  const role = !live ? undefined : tone === "bad" ? "alert" : "status";
  return (
    <div className={`notice tone-${tone}`} role={role}>
      <span className="notice-glyph" aria-hidden="true">
        {GLYPHS[tone]}
      </span>
      <div className="notice-body">
        <p className="notice-title">{title}</p>
        {children ? <div className="notice-detail">{children}</div> : null}
        {technical ? (
          <details className="notice-technical">
            <summary>Technical details</summary>
            <p className="mono">{technical}</p>
          </details>
        ) : null}
      </div>
    </div>
  );
}
