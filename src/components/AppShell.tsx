import type { ReactNode } from "react";
import {
  DIAGNOSTIC_VIEWS,
  PRODUCT_VIEWS,
  type NavItem,
  type ViewId,
} from "../views/navigation.ts";

function NavGroup({
  title,
  items,
  active,
  onSelect,
}: {
  title: string;
  items: NavItem[];
  active: ViewId;
  onSelect: (id: ViewId) => void;
}) {
  return (
    <div className="nav-group">
      <p className="nav-group-title">{title}</p>
      <ul>
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              className={`nav-item${item.id === active ? " is-active" : ""}`}
              aria-current={item.id === active ? "page" : undefined}
              onClick={() => onSelect(item.id)}
            >
              <span className="nav-item-label">{item.label}</span>
              <span className="nav-item-hint">{item.hint}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/// The persistent application frame: a fixed sidebar, the global status bar and
/// the active view. Views are swapped inside this frame; nothing that owns a
/// polling loop lives below it, so switching views never restarts telemetry.
export function AppShell({
  active,
  onSelect,
  status,
  banner,
  children,
}: {
  active: ViewId;
  onSelect: (id: ViewId) => void;
  status: ReactNode;
  banner: string | null;
  children: ReactNode;
}) {
  return (
    <div className="app-shell">
      <nav className="sidebar" aria-label="Dashboard sections">
        <div className="sidebar-brand">
          <span className="sidebar-mark" aria-hidden="true" />
          <span>
            RaceLab
            <em>V0.9.0</em>
          </span>
        </div>
        <NavGroup
          title="Telemetry"
          items={PRODUCT_VIEWS}
          active={active}
          onSelect={onSelect}
        />
        <div className="nav-divider" role="separator" />
        <NavGroup
          title="Engineering"
          items={DIAGNOSTIC_VIEWS}
          active={active}
          onSelect={onSelect}
        />
      </nav>
      <div className="app-main">
        {status}
        {banner ? (
          <p className="banner" role="alert">
            {banner}
          </p>
        ) : null}
        <main className="view">{children}</main>
      </div>
    </div>
  );
}
