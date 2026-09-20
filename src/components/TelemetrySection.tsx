import type { ReactNode } from "react";

/// One titled block inside a view. Sections are the only structural container
/// the views use, so spacing and hierarchy stay consistent across the app.
export function TelemetrySection({
  eyebrow,
  title,
  aside,
  description,
  children,
}: {
  eyebrow?: string;
  title: string;
  aside?: ReactNode;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="panel section">
      <header className="section-header">
        <div>
          {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
          <h2>{title}</h2>
        </div>
        {aside ? <div className="section-aside">{aside}</div> : null}
      </header>
      {description ? (
        <p className="section-description">{description}</p>
      ) : null}
      {children}
    </section>
  );
}

/// The heading of a whole view.
export function ViewHeader({
  title,
  summary,
}: {
  title: string;
  summary: string;
}) {
  return (
    <header className="view-header">
      <h1>{title}</h1>
      <p>{summary}</p>
    </header>
  );
}
