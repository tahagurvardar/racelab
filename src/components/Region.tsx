import type { ReactNode } from "react";

// One instrument region. No data ownership or polling, so regions can also
// be mounted independently in a future overlay without changing contracts.
export function Region({
  title,
  className = "",
  children,
}: {
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`live-panel region ${className}`} aria-label={title}>
      <h2 className="live-section-title">{title}</h2>
      {children}
    </section>
  );
}
