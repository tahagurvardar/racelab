/// F1 25 recorded sessions (V2.0 Phase D): the backend's shapes and the pure
/// view model the Sessions workspace shows for them.
///
/// Everything here is a field the backend persisted or a specification label
/// it attached on read. Nothing is a rating, a recommendation or a judgement;
/// an unavailable value is a dash, never a zero. FH6 sessions keep their own
/// view model (`session-workspace.ts`); the two meet only in the list rows.
import { UNAVAILABLE, integer } from "./telemetry/formatting.ts";
import type { RecoveryOutcome, SessionManifest } from "./session-state.ts";
import {
  dayLabel,
  sessionListRow,
  type Badge,
  type Fact,
  type FactGroup,
  type SessionListRow,
} from "./session-workspace.ts";
import { gameName } from "./telemetry/telemetry-view-model.ts";

// --------------------------------------------------------------- shapes

export interface Labelled<T> {
  raw: T;
  label: string | null;
}

export type SessionGameId = "fh6" | "f1_25";

export interface RaceLabSessionEnvelope {
  envelope_version: number;
  session_id: string;
  game: SessionGameId;
  status: "recording" | "completed" | "interrupted";
  started_at_unix_ms: number | null;
  ended_at_unix_ms: number | null;
  completion_reason: string | null;
  game_session_identity: { kind: string; value: string } | null;
  created_by_racelab_version: string;
}

export interface F1SessionContext {
  received_unix_ms: number;
  session_time: number;
  weather: number;
  track_temperature_c: number;
  air_temperature_c: number;
  total_laps: number;
  track_length_m: number;
  session_type: number;
  track_id: number;
  formula: number;
  session_time_left_s: number;
  session_duration_s: number;
  pit_speed_limit_kmh: number;
  game_paused: number;
  is_spectating: number;
  safety_car_status: number;
  network_game: number;
  ai_difficulty: number;
  game_mode: number;
  rule_set: number;
  num_safety_car_periods: number;
  num_virtual_safety_car_periods: number;
  num_red_flag_periods: number;
  sector2_lap_distance_start_m: number;
  sector3_lap_distance_start_m: number;
  num_weather_forecast_samples: number;
  forecast: unknown[];
}

export interface F1Integrity {
  sample_count: number;
  idle_ticks: number;
  late_ticks: number;
  events_stored: number;
  events_over_cap: number;
  events_missed: number;
  button_events_ignored: number;
  out_of_order_dropped: number;
  telemetry_gaps: number;
  lap_count: number;
  write_error: string | null;
}

export interface F1Recovery {
  outcome: RecoveryOutcome;
  scanned_at_unix_ms: number | null;
  readable_samples: number;
  sample_stream_complete: boolean;
  unreadable_sample_tail_bytes: number;
  readable_events: number;
  event_tail_discarded: boolean;
  laps_readable: boolean;
  tyres_readable: boolean;
  result_readable: boolean | null;
  detail: string | null;
  recovered_by_racelab_version: string;
}

export interface F1TimeTrialSet {
  car_idx: number;
  team_id: number;
  lap_time_ms: number;
  sector1_time_ms: number;
  sector2_time_ms: number;
  sector3_time_ms: number;
  valid: number;
}

export interface F1Metadata {
  schema_version: number;
  protocol: {
    packet_format: number;
    game_year: number;
    game_major_version: number;
    game_minor_version: number;
  } | null;
  session_uid: string;
  player_car_index: number;
  duration_ms: number;
  sample_rate_hz: number;
  sample_schema_version: number;
  context_at_start: F1SessionContext | null;
  context_latest: F1SessionContext | null;
  participant: {
    num_active_cars: number;
    ai_controlled: number;
    team_id: number;
    my_team: number;
    race_number: number;
  } | null;
  time_trial: {
    received_unix_ms: number;
    player_session_best: F1TimeTrialSet;
    personal_best: F1TimeTrialSet;
    rival: F1TimeTrialSet;
  } | null;
  damage_latest: Record<string, unknown> | null;
  end_signals: {
    session_started_event: boolean;
    session_ended_event: boolean;
    chequered_flag_event: boolean;
    final_classification: boolean;
  };
  families: {
    packet_id: number;
    observed_updates: number;
    first_received_unix_ms: number;
    last_received_unix_ms: number;
  }[];
  integrity: F1Integrity;
  recovery: F1Recovery | null;
}

export interface F1SessionFile {
  racelab_session: RaceLabSessionEnvelope;
  f1_25: F1Metadata;
}

export interface F1Labels {
  track: Labelled<number> | null;
  session_type: Labelled<number> | null;
  weather: Labelled<number> | null;
  formula: Labelled<number> | null;
  safety_car_status: Labelled<number> | null;
  network_game: Labelled<number> | null;
  game_mode: Labelled<number> | null;
  rule_set: Labelled<number> | null;
  team: Labelled<number> | null;
  result_status: Labelled<number> | null;
  result_reason: Labelled<number> | null;
}

export interface F1SessionListing {
  session: F1SessionFile;
  labels: F1Labels;
}

export interface F1LapRecord {
  lap_number: number;
  source: "session_history" | "lap_data";
  lap_time_ms: number;
  sector1_ms: number | null;
  sector2_ms: number | null;
  sector3_ms: number | null;
  valid_bit_flags: number | null;
  lap_valid: boolean | null;
  sector1_valid: boolean | null;
  sector2_valid: boolean | null;
  sector3_valid: boolean | null;
  position_at_end: number | null;
  position_at_start: number | null;
  recorded_at_monotonic_ms: number;
}

export interface F1LapsFile {
  schema_version: number;
  laps: F1LapRecord[];
  best_lap_time_lap_num: number | null;
  best_sector1_lap_num: number | null;
  best_sector2_lap_num: number | null;
  best_sector3_lap_num: number | null;
  history_num_laps: number | null;
  lap_positions: { lap_index: number; position: number }[];
}

export interface F1Stint {
  end_lap: number;
  actual_compound: number;
  visual_compound: number;
}

export interface F1TyresFile {
  schema_version: number;
  stints: F1Stint[];
  tyre_sets: {
    received_unix_ms: number;
    fitted_idx: number;
    sets: Record<string, number>[];
  } | null;
  fitted_changes: unknown[];
}

export interface F1Result {
  schema_version: number;
  received_unix_ms: number;
  num_cars: number;
  player: {
    position: number;
    num_laps: number;
    grid_position: number;
    points: number;
    num_pit_stops: number;
    result_status: number;
    result_reason: number;
    best_lap_time_ms: number;
    total_race_time_s: number;
    penalties_time_s: number;
    num_penalties: number;
    num_tyre_stints: number;
    stints: F1Stint[];
  };
}

/// An event's details, as the backend's decoder serializes them: a `kind`,
/// plain numbers, and coded fields as `{ raw, label }`.
export interface F1EventDetails {
  kind: string;
  [field: string]: unknown;
}

export interface F1EventView {
  sequence: number;
  monotonic_ms: number;
  session_time: number;
  code: string;
  details: F1EventDetails | null;
  vehicles: { index: number; is_player: boolean }[];
}

export interface F1SessionDetail {
  session: F1SessionFile;
  labels: F1Labels;
  laps: F1LapsFile | null;
  tyres: F1TyresFile | null;
  stints: {
    stint: F1Stint;
    actual_label: string | null;
    visual_label: string | null;
  }[];
  result: F1Result | null;
  events: F1EventView[];
  events_total: number;
  events_not_shown: number;
  unreadable_files: string[];
}

export type F1RecorderPhase =
  | "disabled"
  | "idle"
  | "candidate"
  | "recording"
  | "grace"
  | "ending";

export interface F1RecorderStatus {
  revision: number;
  enabled: boolean;
  phase: F1RecorderPhase;
  recording: boolean;
  sessions_directory: string;
  session_id: string | null;
  session_uid: string | null;
  started_at_unix_ms: number | null;
  duration_ms: number;
  samples_written: number;
  events_stored: number;
  laps: number;
  waiting_reason: string | null;
  grace_remaining_ms: number | null;
  ending_reason: string | null;
  track_label: string | null;
  session_type_label: string | null;
  completed_sessions: number;
  last_completed_session_id: string | null;
  last_completion_reason: string | null;
  sessions_refused_by_owner: number;
  recording_owner: SessionGameId | null;
  last_error: string | null;
}

// ------------------------------------------------------------ formatting

/// "1:31.234". A time of 0 is the game sending no time, never a lap time.
export function lapTime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return UNAVAILABLE;
  const minutes = Math.floor(ms / 60_000);
  const seconds = (ms % 60_000) / 1000;
  return `${minutes}:${seconds.toFixed(3).padStart(6, "0")}`;
}

/// "31.234". Sector times are shown in seconds.
export function sectorTime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return UNAVAILABLE;
  return (ms / 1000).toFixed(3);
}

function duration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return UNAVAILABLE;
  const whole = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = String(whole % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

function clock(unixMs: number | null | undefined): string {
  return unixMs == null ? UNAVAILABLE : new Date(unixMs).toLocaleString();
}

function label(value: Labelled<number> | null | undefined): string {
  if (value == null) return UNAVAILABLE;
  return value.label ?? `Code ${value.raw}`;
}

function fact(key: string, text: string, value: string, mono = false): Fact {
  return {
    key,
    label: text,
    value,
    available: value !== UNAVAILABLE,
    mono,
  };
}

function yesNo(flag: boolean | null | undefined): string {
  if (flag == null) return UNAVAILABLE;
  return flag ? "Yes" : "No";
}

// ---------------------------------------------------------- list rows

export const F1_GAME_NAME = "F1 25";

/// "Silverstone · Race", or what is known of it.
export function f1Activity(labels: F1Labels): string {
  const parts = [labels.track, labels.session_type]
    .filter((item): item is Labelled<number> => item != null)
    .map((item) => label(item));
  return parts.length > 0 ? parts.join(" · ") : "Session details unknown";
}

const F1_RECOVERY_LABELS: Record<RecoveryOutcome, string> = {
  pending: "checking",
  complete: "fully recovered",
  truncated: "recovered",
  damaged: "damaged",
  unreadable: "unreadable",
};

export function f1Badges(
  file: F1SessionFile,
  recordingId: string | null,
): Badge[] {
  const envelope = file.racelab_session;
  const badges: Badge[] = [];
  if (envelope.status === "recording") {
    badges.push(
      envelope.session_id === recordingId
        ? { key: "status", label: "Recording", tone: "rec" }
        : { key: "status", label: "Not finalized", tone: "warn" },
    );
  } else if (envelope.status === "interrupted") {
    const recovery = file.f1_25.recovery;
    badges.push({
      key: "status",
      label: recovery
        ? `Interrupted · ${F1_RECOVERY_LABELS[recovery.outcome]}`
        : "Interrupted",
      tone: "warn",
    });
  }
  const integrity = file.f1_25.integrity;
  const lost = integrity.events_missed + integrity.events_over_cap;
  if (lost > 0) {
    badges.push({
      key: "events",
      label: `${integer(lost)} events not stored`,
      tone: "warn",
    });
  }
  return badges;
}

export interface MultiGameRow extends SessionListRow {
  game: SessionGameId;
  gameName: string;
  started: number | null;
}

function timeOfDay(unixMs: number | null): string {
  if (unixMs == null) return UNAVAILABLE;
  return new Date(unixMs).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function f1ListRow(
  listing: F1SessionListing,
  recordingId: string | null,
): MultiGameRow {
  const envelope = listing.session.racelab_session;
  const time = timeOfDay(envelope.started_at_unix_ms);
  const length = duration(listing.session.f1_25.duration_ms);
  const activity = f1Activity(listing.labels);
  const badges = f1Badges(listing.session, recordingId);
  return {
    id: envelope.session_id,
    time,
    duration: length,
    vehicle: activity,
    badges,
    label: [
      time,
      `duration ${length}`,
      activity,
      ...badges.map((badge) => badge.label),
    ].join(", "),
    game: "f1_25",
    gameName: F1_GAME_NAME,
    started: envelope.started_at_unix_ms,
  };
}

export type GameFilter = "all" | SessionGameId;

export const GAME_FILTERS: { id: GameFilter; label: string }[] = [
  { id: "all", label: "All games" },
  { id: "fh6", label: "Forza Horizon 6" },
  { id: "f1_25", label: "F1 25" },
];

export interface MultiGameDay {
  key: string;
  label: string;
  rows: MultiGameRow[];
}

function startOfDay(unixMs: number): number {
  const date = new Date(unixMs);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
  ).getTime();
}

/// One history for every game: FH6 rows exactly as V1.1 built them, F1 25
/// rows beside them, newest first, grouped by local day. The optional game
/// filter is presentation only; it never changes what the backend lists.
export function multiGameDays(
  fh6: SessionManifest[],
  f1: F1SessionListing[],
  now: number,
  fh6RecordingId: string | null,
  f1RecordingId: string | null,
  filter: GameFilter = "all",
): MultiGameDay[] {
  const rows: MultiGameRow[] = [
    ...(filter === "f1_25" ? [] : fh6).map((manifest) => ({
      ...sessionListRow(manifest, now, fh6RecordingId),
      game: "fh6" as const,
      gameName: gameName(manifest.game) ?? "Unknown game",
      started: manifest.started_at_unix_ms,
    })),
    ...(filter === "fh6" ? [] : f1).map((listing) =>
      f1ListRow(listing, f1RecordingId),
    ),
  ];
  rows.sort(
    (a, b) => (b.started ?? 0) - (a.started ?? 0) || b.id.localeCompare(a.id),
  );
  const days: MultiGameDay[] = [];
  for (const row of rows) {
    const key =
      row.started == null ? "unknown" : String(startOfDay(row.started));
    let day = days.find((item) => item.key === key);
    if (!day) {
      day = { key, label: dayLabel(row.started, now), rows: [] };
      days.push(day);
    }
    day.rows.push(row);
  }
  return days;
}

// --------------------------------------------------------- recorder row

/// Phase words for the pinned row and the top bar popover.
export function f1RecorderPhaseText(status: F1RecorderStatus): string {
  switch (status.phase) {
    case "recording":
      return "Recording F1 25";
    case "grace":
      return "Recording F1 25 · paused";
    case "ending":
      return "Recording F1 25 · finishing";
    case "candidate":
      return "Checking the F1 25 session";
    case "disabled":
      return "F1 25 recording is off in this build";
    default:
      return status.waiting_reason === "another_game_recording"
        ? "F1 25 not recorded: Forza Horizon 6 was already recording"
        : "Not recording F1 25";
  }
}

export interface F1RecordingRowModel {
  tone: "rec" | "warn";
  title: string;
  duration: string | null;
  detail: string | null;
}

export function f1RecordingRow(
  status: F1RecorderStatus | null,
): F1RecordingRowModel | null {
  if (status == null || !status.recording) return null;
  const context = [status.track_label, status.session_type_label]
    .filter(Boolean)
    .join(" · ");
  return {
    tone: "rec",
    title: f1RecorderPhaseText(status),
    duration: duration(status.duration_ms),
    detail: context || null,
  };
}

// ------------------------------------------------------------- header

const F1_COMPLETION_REASONS: Record<string, string> = {
  session_uid_changed: "A new F1 25 session began",
  session_ended_event: "F1 25 ended the session",
  final_classification: "F1 25 sent the final classification",
  telemetry_lost: "F1 25 stopped sending telemetry",
  player_car_changed: "The player's car changed",
  racelab_shutdown: "RaceLab was closed while recording",
  recorder_write_error: "The recorder could not write",
  interrupted_racelab_did_not_finalize:
    "RaceLab did not finalize the recording",
};

export function f1CompletionReason(reason: string | null): string {
  if (reason == null) return UNAVAILABLE;
  return F1_COMPLETION_REASONS[reason] ?? reason;
}

export function f1StatusBadge(
  file: F1SessionFile,
  recordingId: string | null,
): Badge {
  switch (file.racelab_session.status) {
    case "completed":
      return { key: "status", label: "Completed", tone: "good" };
    case "interrupted":
      return { key: "status", label: "Interrupted", tone: "warn" };
    default:
      return file.racelab_session.session_id === recordingId
        ? { key: "status", label: "Recording", tone: "rec" }
        : { key: "status", label: "Not finalized", tone: "warn" };
  }
}

export interface F1Alert {
  key: string;
  tone: "warn" | "bad";
  title: string;
  detail: string;
}

/// What a reader must know before trusting the figures below.
export function f1Alerts(detail: F1SessionDetail): F1Alert[] {
  const alerts: F1Alert[] = [];
  const file = detail.session;
  const recovery = file.f1_25.recovery;
  if (file.racelab_session.status === "interrupted") {
    alerts.push({
      key: "interrupted",
      tone: "warn",
      title: "Interrupted recording",
      detail:
        recovery == null || recovery.outcome === "pending"
          ? "RaceLab did not finish this recording normally. How much of it is readable is being checked."
          : `RaceLab did not finish this recording normally. ${integer(
              recovery.readable_samples,
            )} samples and ${integer(
              recovery.readable_events,
            )} events were read back; nothing after them is shown.`,
    });
  }
  if (file.f1_25.integrity.write_error) {
    alerts.push({
      key: "write",
      tone: "bad",
      title: "Recording write failed",
      detail: file.f1_25.integrity.write_error,
    });
  }
  if (detail.unreadable_files.length > 0) {
    alerts.push({
      key: "unreadable",
      tone: "warn",
      title: "Part of this session could not be read",
      detail: `Unreadable: ${detail.unreadable_files.join(", ")}.`,
    });
  }
  return alerts;
}

// ------------------------------------------------------------ summary

function bestLap(detail: F1SessionDetail): F1LapRecord | null {
  const laps = detail.laps;
  if (laps == null) return null;
  const reference = laps.best_lap_time_lap_num;
  return (
    laps.laps.find(
      (lap) => lap.lap_number === reference && lap.source === "session_history",
    ) ?? null
  );
}

export function f1SummaryFacts(detail: F1SessionDetail): FactGroup[] {
  const file = detail.session;
  const meta = file.f1_25;
  const context = meta.context_latest ?? meta.context_at_start;
  const result = detail.result?.player ?? null;
  const best = bestLap(detail);
  const groups: FactGroup[] = [
    {
      key: "session",
      title: "Session",
      facts: [
        fact("game", "Game", F1_GAME_NAME),
        fact("track", "Track", label(detail.labels.track)),
        fact("type", "Session type", label(detail.labels.session_type)),
        fact("duration", "Duration", duration(meta.duration_ms)),
        fact("laps", "Laps recorded", integer(meta.integrity.lap_count)),
        fact(
          "best",
          "Best lap",
          best
            ? `${lapTime(best.lap_time_ms)} · lap ${best.lap_number}`
            : UNAVAILABLE,
        ),
        fact(
          "total-laps",
          "Race laps",
          context && context.total_laps > 0
            ? integer(context.total_laps)
            : UNAVAILABLE,
        ),
        fact("team", "Team", label(detail.labels.team)),
      ],
    },
  ];
  if (result) {
    groups.push({
      key: "result",
      title: "Result",
      facts: [
        fact("position", "Finishing position", integer(result.position)),
        fact("grid", "Grid position", integer(result.grid_position)),
        fact("points", "Points", integer(result.points)),
        fact("status", "Result status", label(detail.labels.result_status)),
        fact("reason", "Result reason", label(detail.labels.result_reason)),
        fact("result-laps", "Laps completed", integer(result.num_laps)),
        fact("pits", "Pit stops", integer(result.num_pit_stops)),
        fact(
          "best-lap",
          "Best lap (classification)",
          lapTime(result.best_lap_time_ms),
        ),
        fact(
          "race-time",
          "Race time without penalties",
          `${result.total_race_time_s.toFixed(3)} s`,
        ),
        fact(
          "penalties",
          "Penalties",
          `${integer(result.num_penalties)} · ${integer(result.penalties_time_s)} s`,
        ),
      ],
    });
  }
  if (context) {
    groups.push({
      key: "conditions",
      title: "Conditions",
      facts: [
        fact("weather", "Weather", label(detail.labels.weather)),
        fact(
          "track-temp",
          "Track temperature",
          `${context.track_temperature_c} °C`,
        ),
        fact("air-temp", "Air temperature", `${context.air_temperature_c} °C`),
        fact("formula", "Formula", label(detail.labels.formula)),
        fact("mode", "Game mode", label(detail.labels.game_mode)),
        fact("network", "Network game", label(detail.labels.network_game)),
        fact(
          "safety-car",
          "Safety cars · virtual · red flags",
          `${context.num_safety_car_periods} · ${context.num_virtual_safety_car_periods} · ${context.num_red_flag_periods}`,
        ),
        fact(
          "pit-limit",
          "Pit speed limit",
          context.pit_speed_limit_kmh > 0
            ? `${context.pit_speed_limit_kmh} km/h`
            : UNAVAILABLE,
        ),
      ],
    });
  }
  if (detail.stints.length > 0) {
    groups.push({
      key: "tyres",
      title: "Tyre stints",
      facts: detail.stints.map((item, index) =>
        fact(
          `stint-${index}`,
          `Stint ${index + 1}`,
          `${item.visual_label ?? `visual ${item.stint.visual_compound}`} (${
            item.actual_label ?? `actual ${item.stint.actual_compound}`
          }) · ${
            item.stint.end_lap === 255
              ? "current tyre"
              : `to lap ${item.stint.end_lap}`
          }`,
        ),
      ),
    });
  }
  const trial = meta.time_trial;
  if (trial) {
    groups.push({
      key: "time-trial",
      title: "Time Trial",
      facts: [
        fact(
          "tt-session",
          "Session best",
          lapTime(trial.player_session_best.lap_time_ms),
        ),
        fact(
          "tt-personal",
          "Personal best (ghost)",
          lapTime(trial.personal_best.lap_time_ms),
        ),
        fact("tt-rival", "Rival (ghost)", lapTime(trial.rival.lap_time_ms)),
      ],
    });
  }
  return groups;
}

// --------------------------------------------------------------- laps

export interface F1LapRow {
  key: string;
  lap: string;
  time: string;
  sectors: [string, string, string];
  validity: string;
  invalid: boolean;
  position: string;
  source: string;
  provisional: boolean;
  best: boolean;
}

function validity(lap: F1LapRecord): string {
  if (lap.lap_valid == null) return UNAVAILABLE;
  if (!lap.lap_valid) return "Invalid";
  const sectors = [lap.sector1_valid, lap.sector2_valid, lap.sector3_valid];
  const invalid = sectors
    .map((valid, index) => (valid === false ? `S${index + 1}` : null))
    .filter(Boolean);
  return invalid.length > 0 ? `Valid · ${invalid.join(", ")} invalid` : "Valid";
}

export function f1LapRows(detail: F1SessionDetail): F1LapRow[] {
  const laps = detail.laps;
  if (laps == null) return [];
  return laps.laps.map((lap) => ({
    key: String(lap.lap_number),
    lap: integer(lap.lap_number),
    time: lapTime(lap.lap_time_ms),
    sectors: [
      sectorTime(lap.sector1_ms),
      sectorTime(lap.sector2_ms),
      sectorTime(lap.sector3_ms),
    ],
    validity: validity(lap),
    invalid: lap.lap_valid === false,
    position:
      lap.position_at_end != null
        ? `P${lap.position_at_end}`
        : lap.position_at_start != null
          ? `P${lap.position_at_start} at start`
          : UNAVAILABLE,
    source:
      lap.source === "session_history"
        ? "Session History"
        : "Lap Data (provisional)",
    provisional: lap.source === "lap_data",
    best:
      lap.source === "session_history" &&
      lap.lap_number === laps.best_lap_time_lap_num,
  }));
}

// ------------------------------------------------------------- events

const EVENT_NAMES: Record<string, string> = {
  SSTA: "Session started",
  SEND: "Session ended",
  FTLP: "Fastest lap",
  RTMT: "Retirement",
  DRSE: "DRS enabled",
  DRSD: "DRS disabled",
  TMPT: "Team mate in pits",
  CHQF: "Chequered flag",
  RCWN: "Race winner",
  PENA: "Penalty issued",
  SPTP: "Speed trap",
  STLG: "Start lights",
  LGOT: "Lights out",
  DTSV: "Drive through served",
  SGSV: "Stop go served",
  FLBK: "Flashback",
  BUTN: "Button status",
  RDFL: "Red flag",
  OVTK: "Overtake",
  SCAR: "Safety car",
  COLL: "Collision",
};

export function eventName(code: string): string {
  return EVENT_NAMES[code] ?? `Unknown event ${code}`;
}

function coded(value: unknown): string {
  if (value != null && typeof value === "object" && "raw" in value) {
    const item = value as { raw: number; label: string | null };
    return item.label ?? `code ${item.raw}`;
  }
  return String(value);
}

function car(index: unknown, player: number): string {
  if (typeof index !== "number") return UNAVAILABLE;
  if (index === 255) return "no car";
  return index === player ? "you" : `car ${index}`;
}

/// The event's own fields in words. Factual: no event is called good or bad.
export function eventDetail(event: F1EventView, player: number): string {
  const d = event.details;
  if (d == null) return "Details could not be read.";
  switch (d.kind) {
    case "fastest_lap":
      return `${car(d.vehicle_idx, player)} · ${Number(d.lap_time_s).toFixed(3)} s`;
    case "retirement":
      return `${car(d.vehicle_idx, player)} · ${coded(d.reason)}`;
    case "drs_disabled":
      return coded(d.reason);
    case "team_mate_in_pits":
    case "race_winner":
    case "drive_through_served":
      return car(d.vehicle_idx, player);
    case "penalty":
      return [
        coded(d.penalty_type),
        coded(d.infringement_type),
        car(d.vehicle_idx, player),
        `${d.time_s} s`,
        `lap ${d.lap_num}`,
      ].join(" · ");
    case "speed_trap":
      return `${car(d.vehicle_idx, player)} · ${Number(d.speed_kmh).toFixed(1)} km/h`;
    case "start_lights":
      return `${d.num_lights} lights`;
    case "stop_go_served":
      return `${car(d.vehicle_idx, player)} · ${Number(d.stop_time_s).toFixed(1)} s`;
    case "flashback":
      return `to ${Number(d.flashback_session_time).toFixed(1)} s`;
    case "overtake":
      return `${car(d.overtaking_vehicle_idx, player)} passed ${car(
        d.being_overtaken_vehicle_idx,
        player,
      )}`;
    case "safety_car":
      return `${coded(d.safety_car_type)} · ${coded(d.event_type)}`;
    case "collision":
      return `${car(d.vehicle1_idx, player)} and ${car(d.vehicle2_idx, player)}`;
    case "unknown":
      return "Not in the F1 25 specification; kept as received.";
    default:
      return "";
  }
}

export interface F1EventRow {
  key: string;
  time: string;
  name: string;
  code: string;
  detail: string;
  player: boolean;
}

function sessionClock(seconds: number): string {
  if (!Number.isFinite(seconds)) return UNAVAILABLE;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
}

export function f1EventRows(detail: F1SessionDetail): F1EventRow[] {
  const player = detail.session.f1_25.player_car_index;
  return detail.events.map((event) => ({
    key: String(event.sequence),
    time: sessionClock(event.session_time),
    name: eventName(event.code),
    code: event.code,
    detail: eventDetail(event, player),
    player: event.vehicles.some((vehicle) => vehicle.is_player),
  }));
}

// --------------------------------------------------------------- data

const FAMILY_NAMES: Record<number, string> = {
  0: "Motion",
  1: "Session",
  2: "Lap Data",
  3: "Event",
  4: "Participants",
  5: "Car Setups",
  6: "Car Telemetry",
  7: "Car Status",
  8: "Final Classification",
  9: "Lobby Info",
  10: "Car Damage",
  11: "Session History",
  12: "Tyre Sets",
  13: "Motion Ex",
  14: "Time Trial",
  15: "Lap Positions",
};

export function f1DataGroups(
  detail: F1SessionDetail,
  recordingId: string | null = null,
): FactGroup[] {
  const file = detail.session;
  const envelope = file.racelab_session;
  const meta = file.f1_25;
  const integrity = meta.integrity;
  const groups: FactGroup[] = [
    {
      key: "recording",
      title: "Recording",
      facts: [
        fact("status", "Status", f1StatusBadge(file, recordingId).label),
        fact(
          "reason",
          "How it ended",
          f1CompletionReason(envelope.completion_reason),
        ),
        fact("started", "Started", clock(envelope.started_at_unix_ms)),
        fact("ended", "Ended", clock(envelope.ended_at_unix_ms)),
        fact("duration", "Duration", duration(meta.duration_ms)),
        fact(
          "signals",
          "End signals seen",
          [
            meta.end_signals.session_ended_event ? "session ended" : null,
            meta.end_signals.chequered_flag_event ? "chequered flag" : null,
            meta.end_signals.final_classification
              ? "final classification"
              : null,
          ]
            .filter(Boolean)
            .join(", ") || "None",
        ),
      ],
    },
    {
      key: "integrity",
      title: "Recording integrity",
      facts: [
        fact(
          "samples",
          `Samples (${meta.sample_rate_hz} Hz)`,
          integer(integrity.sample_count),
        ),
        fact("idle", "Reads with no new data", integer(integrity.idle_ticks)),
        fact("late", "Late reads", integer(integrity.late_ticks)),
        fact("events", "Events stored", integer(integrity.events_stored)),
        {
          ...fact(
            "over-cap",
            "Events over the cap",
            integer(integrity.events_over_cap),
          ),
          attention: integrity.events_over_cap > 0,
        },
        {
          ...fact("missed", "Events missed", integer(integrity.events_missed)),
          attention: integrity.events_missed > 0,
        },
        fact(
          "buttons",
          "Button events not stored",
          integer(integrity.button_events_ignored),
        ),
        fact(
          "out-of-order",
          "Out-of-order packets dropped",
          integer(integrity.out_of_order_dropped),
        ),
        fact("gaps", "Telemetry gaps", integer(integrity.telemetry_gaps)),
        fact("laps", "Lap records", integer(integrity.lap_count)),
      ],
    },
    {
      key: "families",
      title: "Packet families",
      facts:
        meta.families.length === 0
          ? [fact("none", "Families", UNAVAILABLE)]
          : meta.families.map((family) =>
              fact(
                `family-${family.packet_id}`,
                `${FAMILY_NAMES[family.packet_id] ?? "Unknown"} (${family.packet_id})`,
                `${integer(family.observed_updates)} updates`,
              ),
            ),
    },
  ];
  const recovery = meta.recovery;
  if (recovery) {
    groups.push({
      key: "recovery",
      title: "Recovery",
      facts: [
        fact("outcome", "Outcome", F1_RECOVERY_LABELS[recovery.outcome]),
        fact("scanned", "Checked", clock(recovery.scanned_at_unix_ms)),
        fact(
          "readable-samples",
          "Readable samples",
          integer(recovery.readable_samples),
        ),
        fact(
          "stream",
          "Sample stream",
          recovery.sample_stream_complete ? "Complete" : "Incomplete",
        ),
        fact(
          "readable-events",
          "Readable events",
          integer(recovery.readable_events),
        ),
        fact(
          "event-tail",
          "Cut-off final event",
          yesNo(recovery.event_tail_discarded),
        ),
        ...(recovery.detail
          ? [fact("detail", "Detail", recovery.detail, true)]
          : []),
      ],
    });
  }
  groups.push({
    key: "technical",
    title: "Technical",
    facts: [
      fact("id", "RaceLab session ID", envelope.session_id, true),
      fact("uid", "F1 25 session UID", meta.session_uid, true),
      fact("player", "Player car index", integer(meta.player_car_index), true),
      fact(
        "protocol",
        "Packet format",
        meta.protocol
          ? `${meta.protocol.packet_format} · game ${meta.protocol.game_major_version}.${String(
              meta.protocol.game_minor_version,
            ).padStart(2, "0")}`
          : UNAVAILABLE,
        true,
      ),
      fact(
        "schema",
        "Session schema",
        `envelope v${envelope.envelope_version} · F1 v${meta.schema_version} · samples v${meta.sample_schema_version}`,
        true,
      ),
      fact(
        "recorded-by",
        "Recorded by RaceLab",
        envelope.created_by_racelab_version,
        true,
      ),
    ],
  });
  return groups;
}

// --------------------------------------------------------- REC owner

export interface RecordingOwnerView {
  game: SessionGameId | null;
  label: string;
}

/// Which game RaceLab is recording right now, from the two recorders' own
/// statuses. The backend lets only one record at a time; should both ever
/// report recording, FH6's established V1.1 indicator wins and nothing is
/// invented.
export function recordingOwner(
  fh6Recording: boolean,
  f1: F1RecorderStatus | null,
): RecordingOwnerView {
  if (fh6Recording) return { game: "fh6", label: "REC · Forza Horizon 6" };
  if (f1?.recording) return { game: "f1_25", label: "REC · F1 25" };
  return { game: null, label: "REC" };
}
