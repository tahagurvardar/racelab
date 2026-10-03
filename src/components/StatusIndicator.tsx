import type { ReactNode } from "react";

export function StatusIndicator({
  tone = "neutral",
  children,
}: {
  tone?: "good" | "neutral" | "warn" | "bad";
  children: ReactNode;
}) {
  return (
    <span className={`status-indicator tone-${tone}`}>
      <span className="state-glyph" aria-hidden="true">
        {tone === "good" ? "●" : tone === "bad" ? "✕" : "○"}
      </span>
      {children}
    </span>
  );
}
