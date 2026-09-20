/// Navigation is a plain value: a view id in component state. A desktop app
/// with nine fixed sections does not need a router dependency, and adding one
/// would put URL history in a window that has no address bar.

export type ViewId =
  | "overview"
  | "engine"
  | "dynamics"
  | "tires"
  | "suspension"
  | "inputs"
  | "race"
  | "sessions"
  | "diagnostics";

export interface NavItem {
  id: ViewId;
  label: string;
  hint: string;
}

/// The product sections, in the order the brief defines them.
export const PRODUCT_VIEWS: NavItem[] = [
  { id: "overview", label: "Overview", hint: "Live driving summary" },
  { id: "engine", label: "Engine", hint: "RPM range and output" },
  { id: "dynamics", label: "Dynamics", hint: "Motion, attitude, position" },
  { id: "tires", label: "Tires", hint: "Four-corner tire channels" },
  { id: "suspension", label: "Suspension", hint: "Four-corner travel" },
  { id: "inputs", label: "Inputs", hint: "Driver controls" },
  { id: "race", label: "Race", hint: "Lap and race state" },
  { id: "sessions", label: "Sessions", hint: "Recorded sessions" },
];

/// Kept in its own group, below the product sections: low-level engineering
/// data must never sit alongside the dashboard as if it were a product view.
export const DIAGNOSTIC_VIEWS: NavItem[] = [
  { id: "diagnostics", label: "Diagnostics", hint: "Protocol and transport" },
];

export const DEFAULT_VIEW: ViewId = "overview";

export function isViewId(value: string): value is ViewId {
  return [...PRODUCT_VIEWS, ...DIAGNOSTIC_VIEWS].some(
    (item) => item.id === value,
  );
}
