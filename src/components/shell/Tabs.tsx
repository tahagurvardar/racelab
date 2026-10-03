import { useEffect, useRef, type KeyboardEvent } from "react";

export interface TabItem<T extends string> {
  id: T;
  label: string;
  /// An optional count shown after the label (how many rows a tab holds).
  /// Part of the tab's accessible name.
  count?: string;
}

/// Segmented tabs following the WAI-ARIA tabs pattern (automatic activation):
/// one tab stop on the selected tab, ArrowLeft/ArrowRight move between tabs and
/// select them, Home/End jump to the ends. The panel each tab controls is
/// `${idPrefix}-panel`, labelled by the selected tab's id.
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  idPrefix,
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  idPrefix: string;
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const list = useRef<HTMLDivElement>(null);

  // When the selection changes from outside the tab list — a keyboard
  // shortcut — while focus is on a tab, focus follows the selection, so the
  // focused tab is never a tabIndex=-1 one that is no longer selected.
  useEffect(() => {
    const focused = document.activeElement;
    const selected = refs.current.get(value);
    if (
      selected &&
      focused !== selected &&
      focused instanceof Node &&
      list.current?.contains(focused)
    ) {
      selected.focus();
    }
  }, [value]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = items.findIndex((item) => item.id === value);
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % items.length
        : event.key === "ArrowLeft"
          ? (index - 1 + items.length) % items.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    const id = items[next].id;
    onChange(id);
    refs.current.get(id)?.focus();
  }

  return (
    <div
      ref={list}
      className="tabs"
      role="tablist"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            ref={(node) => {
              if (node) refs.current.set(item.id, node);
              else refs.current.delete(item.id);
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${item.id}`}
            className={`tab${selected ? " is-selected" : ""}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.id)}
          >
            {item.label}
            {item.count != null ? (
              <>
                {" "}
                <span className="tab-count">{item.count}</span>
              </>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
