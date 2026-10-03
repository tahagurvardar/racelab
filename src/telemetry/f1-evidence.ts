/// F1 25 Phase A evidence, as diagnostics shows it. Engineering data only:
/// header values, counts, sizes and rates. The backend never sends payload
/// bytes, and nothing here may be imported by a product view.
import {
  UNAVAILABLE,
  ageMs,
  code,
  hertz,
  integer,
  text,
} from "./formatting.ts";
import type { CaptureStatus, F1LiveSnapshot } from "./f1-player.ts";

export interface F1Header {
  packet_format: number;
  game_year: number;
  game_major_version: number;
  game_minor_version: number;
  packet_version: number;
  packet_id: number;
  /// Decimal string: a uint64 does not survive a JavaScript number.
  session_uid: string;
  session_time: number | null;
  frame_identifier: number;
  overall_frame_identifier: number;
  player_car_index: number;
  secondary_player_car_index: number;
}

export type F1Rejection =
  | { reason: "truncated"; size: number }
  | { reason: "wrong_packet_format"; found: number }
  | { reason: "wrong_game_year"; found: number }
  | { reason: "unknown_packet_id"; found: number }
  | { reason: "unsupported_packet_version"; kind: string; found: number }
  | {
      reason: "size_mismatch";
      kind: string;
      expected: number;
      observed: number;
    };

export interface F1KindEvidence {
  id: number;
  kind: string;
  name: string;
  expected_size: number;
  size_evidence: "spec_and_live" | "spec_only";
  accepted: number;
  accepted_bytes: number;
  rate_hz: number;
  size_mismatches: number;
  unsupported_versions: number;
  last_observed_size: number | null;
  last_accepted_unix_ms: number | null;
}

export interface F1Evidence {
  detected: boolean;
  last_accepted_age_ms: number | null;
  last_accepted_unix_ms: number | null;
  header: F1Header | null;
  session_uid_changes: number;
  datagrams: number;
  accepted: number;
  truncated: number;
  wrong_packet_format: number;
  wrong_game_year: number;
  unknown_packet_id: number;
  unsupported_version: number;
  size_mismatch: number;
  last_rejection: F1Rejection | null;
  kinds: F1KindEvidence[];
}

export interface F1EvidenceStatus {
  enabled: boolean;
  configured_port: number;
  listening: boolean;
  bound_port: number | null;
  transport_datagrams: number;
  receive_errors: number;
  listener_error: string | null;
  evidence: F1Evidence;
  /// Decoded player values (Phase B), per packet family.
  live: F1LiveSnapshot;
  /// Present only when development fixture capture is enabled.
  capture: CaptureStatus | null;
}

/// Same shape as the diagnostics view model's entry, declared here because
/// only `DiagnosticsView` may import that module.
export interface DiagnosticEntry {
  key: string;
  label: string;
  value: string;
}

export type Tone = "good" | "warn" | "bad";

export function f1Connection(status: F1EvidenceStatus | null): {
  tone: Tone;
  text: string;
} {
  if (status == null) return { tone: "warn", text: "Waiting for the backend" };
  if (!status.listening)
    return {
      tone: "bad",
      text: `Not listening on 127.0.0.1:${status.configured_port}`,
    };
  const port = `127.0.0.1:${code(status.bound_port)}`;
  if (status.evidence.detected)
    return { tone: "good", text: `F1 25 detected on ${port}` };
  if (status.evidence.datagrams > 0)
    return {
      tone: "warn",
      text: `Traffic on ${port}, but no valid F1 25 (Format 2025) packet in the last 2 s`,
    };
  return { tone: "warn", text: `Listening on ${port} — nothing received` };
}

export function f1HeaderEntries(header: F1Header | null): DiagnosticEntry[] {
  const h = header;
  const n = (key: keyof F1Header, label: string): DiagnosticEntry => ({
    key,
    label,
    value: h == null ? UNAVAILABLE : code(h[key] as number),
  });
  return [
    n("packet_format", "packetFormat"),
    n("game_year", "gameYear"),
    {
      key: "game_version",
      label: "Game version",
      value:
        h == null
          ? UNAVAILABLE
          : `${h.game_major_version}.${String(h.game_minor_version).padStart(2, "0")}`,
    },
    n("packet_version", "packetVersion (latest)"),
    n("packet_id", "packetId (latest)"),
    {
      key: "session_uid",
      label: "sessionUID",
      value: text(h?.session_uid),
    },
    {
      key: "session_time",
      label: "sessionTime",
      value:
        h?.session_time == null
          ? UNAVAILABLE
          : `${h.session_time.toFixed(3)} s`,
    },
    n("frame_identifier", "frameIdentifier"),
    n("overall_frame_identifier", "overallFrameIdentifier"),
    n("player_car_index", "playerCarIndex"),
    n("secondary_player_car_index", "secondaryPlayerCarIndex"),
  ];
}

export function describeRejection(rejection: F1Rejection | null): string {
  if (rejection == null) return UNAVAILABLE;
  switch (rejection.reason) {
    case "truncated":
      return `Truncated: ${rejection.size} bytes, header needs 29`;
    case "wrong_packet_format":
      return `packetFormat ${rejection.found}, expected 2025`;
    case "wrong_game_year":
      return `gameYear ${rejection.found}, expected 25`;
    case "unknown_packet_id":
      return `Unknown packetId ${rejection.found}`;
    case "unsupported_packet_version":
      return `${rejection.kind} packetVersion ${rejection.found}, supported 1`;
    case "size_mismatch":
      return `${rejection.kind}: ${rejection.observed} bytes, expected ${rejection.expected}`;
  }
}

export function f1CounterEntries(status: F1EvidenceStatus): DiagnosticEntry[] {
  const e = status.evidence;
  const c = (key: string, label: string, value: number): DiagnosticEntry => ({
    key,
    label,
    value: integer(value),
  });
  return [
    c("datagrams", "Datagrams", e.datagrams),
    c("accepted", "Accepted", e.accepted),
    c("truncated", "Malformed (truncated header)", e.truncated),
    c("wrong_packet_format", "Wrong packetFormat", e.wrong_packet_format),
    c("wrong_game_year", "Wrong gameYear", e.wrong_game_year),
    c("unknown_packet_id", "Unknown packetId", e.unknown_packet_id),
    c(
      "unsupported_version",
      "Unsupported packetVersion",
      e.unsupported_version,
    ),
    c("size_mismatch", "Size mismatches", e.size_mismatch),
    c("session_uid_changes", "sessionUID changes", e.session_uid_changes),
    c("receive_errors", "Receive errors", status.receive_errors),
    {
      key: "last_accepted_age",
      label: "Last accepted",
      value:
        e.last_accepted_age_ms == null
          ? UNAVAILABLE
          : `${ageMs(e.last_accepted_age_ms)} ago`,
    },
    {
      key: "last_rejection",
      label: "Last rejection",
      value: describeRejection(e.last_rejection),
    },
  ];
}

export interface F1KindRow {
  id: string;
  name: string;
  expected: string;
  observed: string;
  /// "match", "mismatch", or "unseen" when nothing with this ID arrived.
  size: "match" | "mismatch" | "unseen";
  evidence: string;
  rate: string;
  accepted: string;
  rejected: string;
}

export function f1KindRows(evidence: F1Evidence): F1KindRow[] {
  return evidence.kinds.map((kind) => ({
    id: String(kind.id),
    name: kind.name,
    expected: String(kind.expected_size),
    observed:
      kind.last_observed_size == null
        ? UNAVAILABLE
        : String(kind.last_observed_size),
    size:
      kind.last_observed_size == null
        ? "unseen"
        : kind.last_observed_size === kind.expected_size
          ? "match"
          : "mismatch",
    evidence: kind.size_evidence === "spec_and_live" ? "Spec + live" : "Spec",
    rate: kind.accepted === 0 ? UNAVAILABLE : hertz(kind.rate_hz),
    accepted: integer(kind.accepted),
    rejected: integer(kind.size_mismatches + kind.unsupported_versions),
  }));
}
