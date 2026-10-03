/// Navigation is a plain value in component state. A desktop app with four
/// fixed sections does not need a router dependency, and adding one would put
/// URL history in a window that has no address bar.
///
/// V1.1 groups the nine V1.0 views into four sections. Every former live field
/// is presented in one of the four Live tabs (tests/live-tabs.test.mjs).

export type SectionId = "live" | "sessions" | "settings" | "diagnostics";

export type LiveTabId = "overview" | "powertrain" | "chassis" | "dynamics";

export interface SectionItem {
  id: SectionId;
  label: string;
}

/// The product sections, in sidebar order.
export const PRODUCT_SECTIONS: SectionItem[] = [
  { id: "live", label: "Live" },
  { id: "sessions", label: "Sessions" },
  { id: "settings", label: "Settings" },
];

/// Kept in its own group, below the product sections: low-level engineering
/// data must never sit alongside the product as if it were a product view.
export const ENGINEERING_SECTIONS: SectionItem[] = [
  { id: "diagnostics", label: "Diagnostics" },
];

export const SECTIONS: SectionItem[] = [
  ...PRODUCT_SECTIONS,
  ...ENGINEERING_SECTIONS,
];

export interface LiveTab {
  id: LiveTabId;
  label: string;
}

/// Frozen for V1.1. The V1.0 views were recomposed into these four in Stage C:
/// Overview (Overview, Inputs, Race), Powertrain (Engine), Chassis (Tires,
/// Suspension) and Dynamics (Dynamics).
export const LIVE_TABS: LiveTab[] = [
  { id: "overview", label: "Overview" },
  { id: "powertrain", label: "Powertrain" },
  { id: "chassis", label: "Chassis" },
  { id: "dynamics", label: "Dynamics" },
];

export interface NavigationState {
  section: SectionId;
  /// Remembered while another section is open, so returning to Live lands on
  /// the tab that was left.
  liveTab: LiveTabId;
}

export const INITIAL_NAVIGATION: NavigationState = {
  section: "live",
  liveTab: "overview",
};

export type NavigationAction =
  | { type: "section"; section: SectionId }
  | { type: "liveTab"; tab: LiveTabId };

export function navigationReducer(
  state: NavigationState,
  action: NavigationAction,
): NavigationState {
  switch (action.type) {
    case "section":
      return state.section === action.section
        ? state
        : { ...state, section: action.section };
    case "liveTab":
      // Choosing a tab is always a request to look at Live.
      return state.section === "live" && state.liveTab === action.tab
        ? state
        : { section: "live", liveTab: action.tab };
  }
}

export interface ShortcutKey {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  /// True when focus is in a text field, where digits must stay digits.
  editable: boolean;
}

/// Keyboard map: Ctrl+1…4 open a section; on Live, plain 1…4 open a tab.
/// Plain digits are ignored while typing so the Diagnostics port and capture
/// label fields keep working.
export function shortcutAction(
  input: ShortcutKey,
  current: NavigationState,
): NavigationAction | null {
  if (input.altKey || input.metaKey || input.shiftKey) return null;
  const index = ["1", "2", "3", "4"].indexOf(input.key);
  if (index < 0) return null;
  if (input.ctrlKey) {
    return { type: "section", section: SECTIONS[index].id };
  }
  if (input.editable || current.section !== "live") return null;
  return { type: "liveTab", tab: LIVE_TABS[index].id };
}
