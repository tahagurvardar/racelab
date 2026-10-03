import { APP_VERSION } from "../../app-version.ts";

/// The RaceLab app mark: a full-height raked bar beside a half-height one.
/// Read together they are a livery stripe and a level reading — the second
/// bar stops at a measured height rather than repeating the first, which is
/// what keeps the pair from being a generic double racing stripe.
///
/// Drawn on a 24-unit grid whose key coordinates fall on 1.5-unit steps, so
/// at 16 px every horizontal edge lands on a whole pixel. Flat fills, no
/// gradient. The tall bar is `currentColor`; the short bar carries the one
/// accent, or `currentColor` too when `mono` (single-colour contexts: a
/// monochrome print, a system tray, the review sheet). The shape alone
/// carries the identity, so it reads the same in either form.
///
/// The packaged icons in src-tauri/icons are rendered from the same geometry
/// (src-tauri/icons/icon.svg); change both together.
export function AppMark({
  size = 24,
  title,
  mono = false,
}: {
  size?: number;
  /// Omit when the mark sits beside the wordmark: the pair is one label.
  title?: string;
  mono?: boolean;
}) {
  const label = title
    ? { role: "img", "aria-label": title }
    : { "aria-hidden": true };
  return (
    <svg
      className="app-mark"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      {...label}
    >
      <path d="M4.5 19.5 10.5 4.5H15L9 19.5Z" fill="currentColor" />
      <path
        d="M12 19.5 15 12h4.5l-3 7.5Z"
        fill={mono ? "currentColor" : "var(--accent)"}
      />
    </svg>
  );
}

/// The RaceLab wordmark. Live text, not outlines: it renders at any DPI and
/// is read by assistive technology as the product name. Always "RaceLab" —
/// one word, two weights of the same colour family, upright (the rake
/// belongs to the mark alone).
export function Wordmark() {
  return (
    <span className="wordmark" aria-label="RaceLab">
      <span aria-hidden="true" className="wordmark-race">
        Race
      </span>
      <span aria-hidden="true" className="wordmark-lab">
        Lab
      </span>
    </span>
  );
}

export function VersionLabel() {
  return <span className="version-label">v{APP_VERSION}</span>;
}
