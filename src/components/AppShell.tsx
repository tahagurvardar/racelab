import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import {
  shortcutAction,
  type NavigationAction,
  type NavigationState,
} from "../views/navigation.ts";
import { AlertSlot } from "./shell/AlertSlot";
import { FirstRunSlot } from "./shell/FirstRunSlot";
import { Sidebar } from "./shell/Sidebar";
import { TopBar } from "./shell/TopBar";

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement)
  );
}

/// The persistent application frame: sidebar, top bar, the global alert and
/// the active workspace. Nothing here owns a polling loop, and the frame
/// itself reads no store: each part of it subscribes to exactly what it
/// shows, so a 20 Hz live update never re-renders the frame or a workspace
/// that does not read live telemetry.
export function AppShell({
  navigation,
  onNavigate,
  children,
}: {
  navigation: NavigationState;
  onNavigate: (action: NavigationAction) => void;
  children: ReactNode;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const action = shortcutAction(
        {
          key: event.key,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          editable: isEditable(event.target),
        },
        navigation,
      );
      if (action == null) return;
      event.preventDefault();
      onNavigate(action);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigation, onNavigate]);

  // The workspace is one scroll container shared by every section, so a new
  // destination would otherwise open at the previous one's scroll position.
  // Reset it before paint on every section or Live-tab change — no animation,
  // and no per-workspace restoration (not in scope yet).
  const workspace = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (workspace.current) workspace.current.scrollTop = 0;
  }, [navigation.section, navigation.liveTab]);

  // A section shortcut pressed with focus inside the workspace removes the
  // focused control with the section it belonged to, and the browser drops
  // focus to the page. Put it on the new workspace's title instead, so the
  // next Tab continues from there. Not on first render: launching the app
  // moves no focus.
  const shownSection = useRef(navigation.section);
  useLayoutEffect(() => {
    if (shownSection.current === navigation.section) return;
    shownSection.current = navigation.section;
    const active = document.activeElement;
    if (active == null || active === document.body || !active.isConnected) {
      workspace.current
        ?.querySelector<HTMLElement>(".workspace-view h1")
        ?.focus({ preventScroll: true });
    }
  }, [navigation.section]);

  return (
    <div className="app-shell">
      <Sidebar
        active={navigation.section}
        onSelect={(section) => onNavigate({ type: "section", section })}
      />
      <div className="app-main">
        <TopBar />
        <main className="workspace" ref={workspace}>
          <div className="workspace-inner">
            <AlertSlot />
            <FirstRunSlot />
            {/* Keyed by section so a section change replays the short
                entry transition; nothing below owns a subscription that a
                remount could duplicate. */}
            <div className="workspace-view" key={navigation.section}>
              {children}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
