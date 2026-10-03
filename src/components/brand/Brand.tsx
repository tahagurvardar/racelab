import { APP_VERSION } from "../../app-version.ts";

// Locked D2-C optical masters. The negative step is transparent, never cyan.
const MASTERS: Record<number, string> = {
  16: "M1 4H14V12H8V9H1Z",
  20: "M2 6H18V16H11V13H2Z",
  24: "M2 7H21V19H12V15H2Z",
  32: "M3 9H27V24H16V19H3Z",
};

export function AppMark({
  size = 24,
  title,
}: {
  size?: number;
  title?: string;
  // Retained for callers of the former asset. D2-C is always monochrome.
  mono?: boolean;
}) {
  const small = MASTERS[size];
  return (
    <svg
      className="app-mark"
      width={size}
      height={size}
      viewBox={small ? `0 0 ${size} ${size}` : "0 0 80 80"}
      shapeRendering={small ? "crispEdges" : undefined}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <path d={small ?? "M0 15H80V65H44V49H0Z"} fill="currentColor" />
    </svg>
  );
}

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
