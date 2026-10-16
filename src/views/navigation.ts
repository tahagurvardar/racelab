/// Navigation is a plain value in component state. A desktop app with four
/// fixed sections does not need a router dependency, and adding one would put
/// URL history in a window that has no address bar.
///
/// V1.1 groups the nine V1.0 views into four sections. Every former live field
/// is presented in one of the four Live tabs (tests/live-tabs.test.mjs).

export type SectionId =
  | "home"
  | "live"
  | "sessions"
  | "settings"
  | "diagnostics";

export type LiveTabId = "overview" | "powertrain" | "chassis" | "dynamics";

/// F1 25's own Live tabs. Not the FH6 labels: F1 25 sends lap, tyre-set and
/// per-wheel motion data FH6 does not, and its tabs are named for that.
export type F1TabId = "overview" | "race" | "tyres" | "dynamics";

export interface SectionItem {
  id: SectionId;
  label: string;
}

/// The product sections, in sidebar order.
export const PRODUCT_SECTIONS: SectionItem[] = [
  { id: "home", label: "Home" },
  { id: "live", label: "Live" },
  { id: "sessions", label: "Sessions" },
];

export const UTILITY_SECTIONS: SectionItem[] = [
  { id: "settings", label: "Settings" },
];

/// Kept in its own group, below the product sections: low-level engineering
/// data must never sit alongside the product as if it were a product view.
export const ENGINEERING_SECTIONS: SectionItem[] = [
  { id: "diagnostics", label: "Diagnostics" },
];

export const SECTIONS: SectionItem[] = [
  // Preserve the established Ctrl+1…4 shortcuts. Home adds Ctrl+5.
  ...PRODUCT_SECTIONS.filter((item) => item.id !== "home"),
  ...UTILITY_SECTIONS,
  ...ENGINEERING_SECTIONS,
  PRODUCT_SECTIONS[0],
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

export interface F1Tab {
  id: F1TabId;
  label: string;
}

export const F1_LIVE_TABS: F1Tab[] = [
  { id: "overview", label: "Overview" },
  { id: "race", label: "Race" },
  { id: "tyres", label: "Tyres" },
  { id: "dynamics", label: "Dynamics" },
];

export interface NavigationState {
  section: SectionId;
  /// Remembered while another section is open, so returning to Live lands on
  /// the tab that was left.
  liveTab: LiveTabId;
  /// The F1 25 tab. Both games keep the same tab *position*, so the 1…4
  /// shortcuts and a remembered tab mean the same place whichever game is
  /// active, and the shell never needs to know which game that is.
  f1Tab: F1TabId;
  /// v2.1: the F1 25 session open in Telemetry Lab, over Sessions. Not a
  /// sidebar section: it is entered from a session and left back to it, and
  /// choosing any section leaves it.
  lab: string | null;
}

export const INITIAL_NAVIGATION: NavigationState = {
  section: "live",
  liveTab: "overview",
  f1Tab: "overview",
  lab: null,
};

export type NavigationAction =
  | { type: "section"; section: SectionId }
  | { type: "liveTab"; tab: LiveTabId }
  | { type: "f1Tab"; tab: F1TabId }
  | { type: "openLab"; sessionId: string }
  | { type: "closeLab" };

function atPosition(
  index: number,
): Pick<NavigationState, "liveTab" | "f1Tab" | "lab"> {
  return {
    liveTab: LIVE_TABS[index].id,
    f1Tab: F1_LIVE_TABS[index].id,
    lab: null,
  };
}

export function navigationReducer(
  state: NavigationState,
  action: NavigationAction,
): NavigationState {
  switch (action.type) {
    case "section":
      return state.section === action.section && state.lab == null
        ? state
        : { ...state, section: action.section, lab: null };
    case "liveTab": {
      // Choosing a tab is always a request to look at Live.
      if (state.section === "live" && state.liveTab === action.tab)
        return state;
      const index = LIVE_TABS.findIndex((item) => item.id === action.tab);
      return { section: "live", ...atPosition(Math.max(0, index)) };
    }
    case "f1Tab": {
      if (state.section === "live" && state.f1Tab === action.tab) return state;
      const index = F1_LIVE_TABS.findIndex((item) => item.id === action.tab);
      return { section: "live", ...atPosition(Math.max(0, index)) };
    }
    case "openLab":
      return state.section === "sessions" && state.lab === action.sessionId
        ? state
        : { ...state, section: "sessions", lab: action.sessionId };
    case "closeLab":
      return state.lab == null ? state : { ...state, lab: null };
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
  const index = ["1", "2", "3", "4", "5"].indexOf(input.key);
  if (index < 0) return null;
  if (input.ctrlKey) {
    return { type: "section", section: SECTIONS[index].id };
  }
  if (input.editable || current.section !== "live" || index >= LIVE_TABS.length)
    return null;
  return { type: "liveTab", tab: LIVE_TABS[index].id };
}
