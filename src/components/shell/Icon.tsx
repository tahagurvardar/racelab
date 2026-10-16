/// The application's icon set: a handful of 16-unit stroke glyphs drawn
/// inline, so there is no icon font or image dependency. Decorative by
/// default — the control that holds an icon carries the accessible name.

export type IconName =
  | "home"
  | "live"
  | "sessions"
  | "settings"
  | "diagnostics"
  | "chevron-down"
  // v2.1 Telemetry Lab.
  | "play"
  | "pause"
  | "reset"
  | "refresh"
  | "arrow-left"
  | "minus"
  | "plus"
  | "track"
  | "user"
  | "map"
  | "chart"
  | "crosshair"
  | "expand";

const PATHS: Record<IconName, string[]> = {
  home: ["M2.5 7 8 2.5 13.5 7V13.5H9.5V9.5H6.5V13.5H2.5Z"],
  // A gauge: the live instrument.
  live: ["M2.75 11.5a5.25 5.25 0 0 1 10.5 0", "M8 11.5l2.75-3.25"],
  // Stacked recordings.
  sessions: [
    "M2.5 5.25 8 2.75l5.5 2.5L8 7.75z",
    "M2.5 8.25 8 10.75l5.5-2.5",
    "M2.5 11.25 8 13.75l5.5-2.5",
  ],
  // Sliders.
  settings: [
    "M2.5 4.5h4.5",
    "M10 4.5h3.5",
    "M8.5 3v3",
    "M2.5 11.5h2",
    "M7.5 11.5h6",
    "M6 10v3",
  ],
  // A waveform: engineering signals.
  diagnostics: ["M1.75 8h2.5l1.75-4.5 3 9 1.75-4.5h3.5"],
  "chevron-down": ["M4.5 6.5 8 10l3.5-3.5"],
  play: ["M5 3.5v9l7-4.5z"],
  pause: ["M5.5 3.5v9", "M10.5 3.5v9"],
  // Back to the start of the lap.
  reset: ["M3.5 3.5v9", "M12.5 3.5 6 8l6.5 4.5z"],
  refresh: ["M13 8a5 5 0 1 1-1.46-3.54", "M13 3v2.5h-2.5"],
  "arrow-left": ["M13 8H3", "M7 4 3 8l4 4"],
  minus: ["M3.5 8h9"],
  plus: ["M3.5 8h9", "M8 3.5v9"],
  // A closed circuit outline.
  track: [
    "M3 10.5c0-3 1.5-6.5 4.5-6.5 2 0 2 2 4 2 1.5 0 2 1.25 2 2.5 0 2-1.5 3.5-4 3.5H5c-1.25 0-2-.5-2-1.5z",
  ],
  user: [
    "M8 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5",
    "M3 13.5c.75-2.5 2.75-3.5 5-3.5s4.25 1 5 3.5",
  ],
  map: [
    "M2 4.5 6 3l4 1.5 4-1.5v8.5L10 13l-4-1.5L2 13z",
    "M6 3v8.5",
    "M10 4.5V13",
  ],
  chart: ["M2 12.5h12", "M3 10l3-4 3 2.5L13 4"],
  crosshair: [
    "M8 2v3",
    "M8 11v3",
    "M2 8h3",
    "M11 8h3",
    "M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5",
  ],
  expand: ["M9.5 2.5h4v4", "M6.5 13.5h-4v-4", "M13.5 2.5 9 7", "M2.5 13.5 7 9"],
};

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
