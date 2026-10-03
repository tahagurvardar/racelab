import type { ReactNode } from "react";

/// The title row of a workspace, with room for its own navigation (tabs).
export function WorkspaceHeader({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="workspace-header">
      {/* Focusable by script only (never a tab stop): where focus goes when
          the control the user was on disappears, e.g. setup's Continue. */}
      <h1 tabIndex={-1}>{title}</h1>
      {children}
    </header>
  );
}
