/// The application's icon set: a handful of 16-unit stroke glyphs drawn
/// inline, so there is no icon font or image dependency. Decorative by
/// default — the control that holds an icon carries the accessible name.

export type IconName =
  | "live"
  | "sessions"
  | "settings"
  | "diagnostics"
  | "chevron-down";

const PATHS: Record<IconName, string[]> = {
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
