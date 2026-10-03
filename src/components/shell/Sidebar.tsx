import { liveStore, recorderStore } from "../../state/stores.ts";
import { useDerived } from "../../state/use-store.ts";
import {
  ENGINEERING_SECTIONS,
  PRODUCT_SECTIONS,
  type SectionId,
  type SectionItem,
} from "../../views/navigation.ts";
import { AppMark, VersionLabel, Wordmark } from "../brand/Brand";
import { Icon } from "./Icon";

type Indicator = "degraded" | "rec" | "live";

const INDICATOR_LABELS: Record<Indicator, string> = {
  degraded: "Live, degraded",
  rec: "Recording",
  live: "Live",
};

/// Whether Live deserves a mark in the sidebar while another section is open.
/// A degraded connection or health outranks everything (the same rule as the
/// top bar: degraded is never shown green); recording outranks plain live.
/// The REC indicator in the top bar stays visible either way.
function liveIndicator(): Indicator | null {
  const snapshot = liveStore.get().snapshot;
  const live = Boolean(snapshot && !snapshot.stale && snapshot.frame?.active);
  if (
    live &&
    (snapshot?.connection === "DEGRADED" || snapshot?.health === "DEGRADED")
  ) {
    return "degraded";
  }
  if (recorderStore.get().recorder?.recording) return "rec";
  return live ? "live" : null;
}

function NavList({
  items,
  active,
  onSelect,
  indicator,
}: {
  items: SectionItem[];
  active: SectionId;
  onSelect: (id: SectionId) => void;
  indicator: Indicator | null;
}) {
  return (
    <ul className="sidebar-list">
      {items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            className={`sidebar-item${item.id === active ? " is-active" : ""}`}
            aria-current={item.id === active ? "page" : undefined}
            title={item.label}
            onClick={() => onSelect(item.id)}
          >
            <Icon name={item.id} />
            <span className="sidebar-item-label">{item.label}</span>
            {item.id === "live" && indicator ? (
              <span
                className={`sidebar-indicator is-${indicator}`}
                role="img"
                aria-label={INDICATOR_LABELS[indicator]}
              />
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

/// The section rail. Expanded with labels on wide windows, a 56 px icon rail
/// below 1200 px (CSS only — the markup is the same). Engineering sits apart,
/// at the bottom, so Diagnostics never reads as a product view.
export function Sidebar({
  active,
  onSelect,
}: {
  active: SectionId;
  onSelect: (id: SectionId) => void;
}) {
  const indicator = useDerived([liveStore, recorderStore], liveIndicator);
  return (
    <nav className="sidebar" aria-label="Sections">
      <div className="sidebar-brand" role="img" aria-label="RaceLab">
        <AppMark size={24} />
        <span className="sidebar-wordmark" aria-hidden="true">
          <Wordmark />
        </span>
      </div>
      <NavList
        items={PRODUCT_SECTIONS}
        active={active}
        onSelect={onSelect}
        indicator={indicator}
      />
      <div className="sidebar-spacer" />
      <p className="sidebar-group-label">Engineering</p>
      <NavList
        items={ENGINEERING_SECTIONS}
        active={active}
        onSelect={onSelect}
        indicator={null}
      />
      <div className="sidebar-footer">
        <VersionLabel />
      </div>
    </nav>
  );
}
