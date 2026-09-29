/// Derived session analysis, as `src-tauri/src/analysis.rs` serializes it, plus
/// the pure view model the Sessions view renders.
///
/// Three rules hold here, and they are the frontend half of the V0.9 contract:
///
/// 1. **The frame stream never reaches React.** This module describes an
///    analysis document — events and segments the backend already reduced — and
///    there is no type here for a telemetry frame array.
/// 2. **Unavailable is not zero, and absent is not empty.** A session with no
///    analysis renders an explicit state. It never renders as "0 events", which
///    would say analysis ran and found nothing.
/// 3. **Neutral language.** Labels name a channel and a direction. Nothing here
///    says wheelspin, lock, understeer, left, right, good or bad, because the
///    telemetry does not establish any of them.
///
/// Unit conversions come from `telemetry/formatting.ts`, the same module the
/// live dashboard uses. Analysis stores canonical m/s and m/s²; km/h is a
/// presentation choice made here and nowhere else.
import {
  UNAVAILABLE,
  number,
  offsetClock,
  percent,
  speedKmh,
} from "./telemetry/formatting.ts";
import type { Wheels } from "./telemetry/frame.ts";
import {
  canonicalCornerRows,
  cornerLabelOf,
  type CanonicalCornerSet,
} from "./telemetry/telemetry-view-model.ts";

/// Presented driving events. Slip is deliberately absent: one maneuver lights
/// up two slip channels on several corners at once, so slip is presented as a
/// coalesced `SlipEpisode` rather than as per-corner rows.
export type EventKind =
  | "full_throttle"
  | "braking"
  | "hard_braking"
  | "rapid_throttle_lift"
  | "strong_acceleration"
  | "strong_deceleration"
  | "high_suspension_compression"
  | "high_suspension_extension";

/// Which slip channel an episode crossed. Neither name asserts a
/// vehicle-dynamics state.
export type SlipFamily = "slip_ratio" | "combined_slip";

/// Canonical corner codes, exactly as the backend serializes `WheelPosition`.
/// Derived from the canonical `Wheels` shape rather than written out again:
/// the four names exist in exactly one frontend module, and this is not it.
export type CornerCode = keyof Wheels;

export interface DrivingEvent {
  kind: EventKind;
  corner: CornerCode | null;
  /// Session-relative monotonic milliseconds.
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  entry_speed_mps: number | null;
  exit_speed_mps: number | null;
  min_speed_mps: number | null;
  max_speed_mps: number | null;
  speed_change_mps: number | null;
  max_rpm: number | null;
  peak: number | null;
  signed_peak: number | null;
  peak_combined_slip: number | null;
}

export type CornerValues = CanonicalCornerSet<number | null>;

export interface TurnSegment {
  index: number;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  signed_yaw_change_rad: number;
  mean_yaw_rate_rad_s: number;
  peak_yaw_rate_rad_s: number;
  entry_speed_mps: number | null;
  min_speed_mps: number | null;
  exit_speed_mps: number | null;
  max_speed_mps: number | null;
  average_speed_mps: number | null;
  brake_seconds: number;
  throttle_seconds: number;
  full_throttle_seconds: number;
  max_brake: number | null;
  max_abs_slip_ratio: CornerValues;
  max_combined_slip: CornerValues;
  max_suspension_compression: CornerValues;
}

/// One coherent high-slip episode: the union of every corner and channel that
/// went over threshold during one maneuver, with each affected corner's own
/// measured peaks kept intact. Never called wheelspin, wheel lock or a slide.
export interface SlipEpisode {
  index: number;
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  /// Time actually spent above threshold, which can be much less than the
  /// duration when the episode spans short recoveries.
  engaged_seconds: number;
  corners: CornerCode[];
  families: SlipFamily[];
  entry_speed_mps: number | null;
  min_speed_mps: number | null;
  max_speed_mps: number | null;
  exit_speed_mps: number | null;
  max_abs_slip_ratio: CornerValues;
  signed_peak_slip_ratio: CornerValues;
  max_combined_slip: CornerValues;
  peak_abs_slip_ratio: number | null;
  peak_combined_slip: number | null;
}

export interface AnalysisCoverage {
  first_monotonic_ms: number;
  last_monotonic_ms: number;
  recorded_seconds: number;
  analyzed_seconds: number;
  excluded_gap_count: number;
  excluded_gap_seconds: number;
  inactive_interval_count: number;
  inactive_interval_seconds: number;
}

export interface EventCount {
  kind: EventKind;
  count: number;
}

export interface DrivingSummary {
  event_count: number;
  slip_episode_count: number;
  slip_episode_seconds: number;
  turn_segment_count: number;
  events_by_kind: EventCount[];
  full_throttle_seconds: number;
  braking_seconds: number;
  hard_braking_seconds: number;
  max_speed_mps: number | null;
  max_longitudinal_acceleration_mps2: number | null;
  max_longitudinal_deceleration_mps2: number | null;
}

export interface AnalysisDataQuality {
  telemetry_frame_schema_version: number;
  frames_read: number;
  active_frames: number;
  inactive_frames: number;
  zero_interval_frames: number;
  speed_discontinuities: number;
  frame_stream_complete: boolean;
  speed_available: boolean;
  controls_available: boolean;
  engine_available: boolean;
  orientation_available: boolean;
  wheel_telemetry_available: boolean;
  suspension_available: boolean;
  events_truncated: number;
  slip_episodes_truncated: number;
  turn_segments_truncated: number;
  /// Raw per-corner detector engagements before coalescing. Diagnostics, not
  /// driving events: far more of these than episodes is the normal shape of one
  /// maneuver lighting up several corners at once.
  slip_ratio_detector_events: number;
  combined_slip_detector_events: number;
}

/// Every threshold that produced the analysis. Mirrored so the UI can state a
/// heuristic as the value that was actually applied rather than a constant
/// duplicated in the frontend.
export interface AnalysisConfig {
  max_gap_ms: number;
  min_event_ms: number;
  full_throttle_enter: number;
  full_throttle_exit: number;
  braking_enter: number;
  braking_exit: number;
  hard_braking_enter: number;
  hard_braking_exit: number;
  throttle_lift_window_ms: number;
  throttle_lift_from: number;
  throttle_lift_to: number;
  throttle_lift_cooldown_ms: number;
  acceleration_window_ms: number;
  max_plausible_acceleration_mps2: number;
  strong_acceleration_enter_mps2: number;
  strong_acceleration_exit_mps2: number;
  strong_deceleration_enter_mps2: number;
  strong_deceleration_exit_mps2: number;
  slip_ratio_enter: number;
  slip_ratio_exit: number;
  combined_slip_enter: number;
  combined_slip_exit: number;
  slip_min_ms: number;
  slip_merge_gap_ms: number;
  suspension_compression_enter: number;
  suspension_compression_exit: number;
  suspension_extension_enter: number;
  suspension_extension_exit: number;
  suspension_min_ms: number;
  suspension_merge_gap_ms: number;
  turn_min_speed_mps: number;
  turn_yaw_rate_enter_rad_s: number;
  turn_yaw_rate_exit_rad_s: number;
  turn_exit_hold_ms: number;
  turn_min_duration_ms: number;
  turn_min_abs_yaw_change_rad: number;
  max_events: number;
  max_slip_episodes: number;
  max_turn_segments: number;
}

export interface SessionAnalysis {
  schema_version: number;
  session_id: string;
  telemetry_frame_schema_version: number;
  /// When the analysis finished, not when it was requested.
  analyzed_at_unix_ms: number;
  requested_at_unix_ms: number | null;
  /// How long the job waited behind other sessions before it started.
  queued_ms: number | null;
  analysis_duration_ms: number;
  analyzed_by_racelab_version: string;
  config: AnalysisConfig;
  coverage: AnalysisCoverage;
  driving_summary: DrivingSummary;
  events: DrivingEvent[];
  slip_episodes: SlipEpisode[];
  turn_segments: TurnSegment[];
  data_quality: AnalysisDataQuality;
}

export type AnalysisAvailability =
  | "available"
  | "pending"
  | "absent"
  | "corrupt"
  | "unsupported"
  | "error";

export interface SessionAnalysisState {
  session_id: string;
  state: AnalysisAvailability;
  analysis: SessionAnalysis | null;
  analysis_schema_version: number | null;
  supported_analysis_schema_version: number;
  message: string | null;
  file: string;
}

/// Neutral event names. Each states the channel and the direction; none of them
/// names a vehicle-dynamics conclusion the telemetry does not establish.
export const EVENT_LABELS: Record<EventKind, string> = {
  full_throttle: "Full throttle",
  braking: "Braking",
  hard_braking: "Hard braking",
  rapid_throttle_lift: "Rapid throttle lift",
  strong_acceleration: "Strong acceleration",
  strong_deceleration: "Strong deceleration",
  high_suspension_compression: "High suspension compression",
  high_suspension_extension: "High suspension extension",
};

/// Presentation order for the event groups. Pedal and motion events first,
/// then the per-corner ones.
export const EVENT_ORDER: EventKind[] = [
  "full_throttle",
  "braking",
  "hard_braking",
  "rapid_throttle_lift",
  "strong_acceleration",
  "strong_deceleration",
  "high_suspension_compression",
  "high_suspension_extension",
];

export const SLIP_FAMILY_LABELS: Record<SlipFamily, string> = {
  slip_ratio: "slip ratio",
  combined_slip: "combined slip",
};

const SUSPENSION_EVENTS: EventKind[] = [
  "high_suspension_compression",
  "high_suspension_extension",
];
const DRIVING_EVENTS: EventKind[] = EVENT_ORDER.filter(
  (kind) => !SUSPENSION_EVENTS.includes(kind),
);

export interface AnalysisBanner {
  state: AnalysisAvailability;
  /// Whether the caller should render the analysis sections at all.
  showAnalysis: boolean;
  headline: string;
  detail: string;
  /// True for a state the user may want to act on or report.
  problem: boolean;
}

/// The one place that turns a backend availability state into what the user
/// reads. Every non-available state gets its own sentence: "no analysis exists"
/// and "analysis found nothing" must never look the same.
export function analysisBanner(
  state: SessionAnalysisState | null,
  error: string | null = null,
): AnalysisBanner {
  if (error != null) {
    return {
      state: "error",
      showAnalysis: false,
      headline: "Analysis unavailable",
      detail: error,
      problem: true,
    };
  }
  if (state == null) {
    return {
      state: "pending",
      showAnalysis: false,
      headline: "Loading analysis…",
      detail: "Reading the analysis for this session.",
      problem: false,
    };
  }
  switch (state.state) {
    case "available":
      return {
        state: state.state,
        showAnalysis: true,
        headline: "Analysis available",
        detail: `Analysis schema v${state.analysis_schema_version ?? "?"}.`,
        problem: false,
      };
    case "pending":
      return {
        state: state.state,
        showAnalysis: false,
        headline: "Analysis in progress",
        detail:
          "This session is being analyzed. Reopen it in a moment to see the result.",
        problem: false,
      };
    case "absent":
      return {
        state: state.state,
        showAnalysis: false,
        headline: "Not analyzed",
        detail:
          "No analysis exists for this session. Sessions are analyzed when they complete; recordings made before V0.9 are not analyzed retroactively. This is not the same as an analysis that found no events.",
        problem: false,
      };
    case "unsupported":
      return {
        state: state.state,
        showAnalysis: false,
        headline: "Unsupported analysis version",
        detail: `This session's analysis was written in schema v${
          state.analysis_schema_version ?? "?"
        }; this build reads v${state.supported_analysis_schema_version}. The recording itself is unaffected.`,
        problem: true,
      };
    case "corrupt":
      return {
        state: state.state,
        showAnalysis: false,
        headline: "Analysis unreadable",
        detail:
          `${state.file} could not be read. The recording itself is unaffected. ${
            state.message ?? ""
          }`.trim(),
        problem: true,
      };
    default:
      return {
        state: "error",
        showAnalysis: false,
        headline: "Analysis unavailable",
        detail: state.message ?? "The analysis could not be read.",
        problem: true,
      };
  }
}

export interface EventRow {
  key: string;
  kind: EventKind;
  label: string;
  /// A corner's display label, or `UNAVAILABLE` when the event has no corner.
  corner: string;
  hasCorner: boolean;
  /// "1:24.520 – 1:26.100", from session-relative monotonic milliseconds.
  time: string;
  duration: string;
  /// "143 → 87 km/h", or `UNAVAILABLE` when speed was not recorded.
  speed: string;
  /// The figure that defines this kind of event.
  detail: string;
}

function speedRange(event: DrivingEvent): string {
  const entry = speedKmh(event.entry_speed_mps);
  const exit = speedKmh(event.exit_speed_mps);
  if (entry === UNAVAILABLE || exit === UNAVAILABLE) return UNAVAILABLE;
  return `${entry} → ${exit} km/h`;
}

/// The one figure that says what the event was. Each is a measured or derived
/// value; none of them is a judgement.
function eventDetail(event: DrivingEvent): string {
  switch (event.kind) {
    case "full_throttle":
      return `Peak throttle ${percent(event.peak)}%`;
    case "braking":
    case "hard_braking":
      return `Max brake ${percent(event.peak)}%`;
    case "rapid_throttle_lift":
      return `Throttle fell ${percent(event.peak)} points`;
    case "strong_acceleration":
    case "strong_deceleration":
      return `Peak ${number(event.signed_peak, 1)} m/s²`;
    case "high_suspension_compression":
      return `Peak normalized travel ${number(event.peak, 2)}`;
    case "high_suspension_extension":
      return `Lowest normalized travel ${number(event.peak, 2)}`;
    default:
      return UNAVAILABLE;
  }
}

export function eventRow(event: DrivingEvent, index: number): EventRow {
  return {
    key: `${event.kind}-${event.start_ms}-${event.corner ?? "none"}-${index}`,
    kind: event.kind,
    label: EVENT_LABELS[event.kind] ?? event.kind,
    corner: cornerLabelOf(event.corner),
    hasCorner: event.corner != null,
    time: `${offsetClock(event.start_ms)} – ${offsetClock(event.end_ms)}`,
    duration: `${number(event.duration_ms / 1000, 2)} s`,
    speed: speedRange(event),
    detail: eventDetail(event),
  };
}

/// Events of the given kinds, in time order. The backend already sorts them;
/// this keeps the UI honest if an analysis ever arrives out of order, exactly
/// as `orderSessions` does for the session listing.
export function eventRows(
  analysis: SessionAnalysis | null,
  kinds: EventKind[],
): EventRow[] {
  if (analysis == null) return [];
  const wanted = new Set(kinds);
  return analysis.events
    .filter((event) => wanted.has(event.kind))
    .slice()
    .sort((a, b) => a.start_ms - b.start_ms || a.end_ms - b.end_ms)
    .map(eventRow);
}

export function drivingEventRows(analysis: SessionAnalysis | null): EventRow[] {
  return eventRows(analysis, DRIVING_EVENTS);
}

export function suspensionEventRows(
  analysis: SessionAnalysis | null,
): EventRow[] {
  return eventRows(analysis, SUSPENSION_EVENTS);
}

/// Whether a group of events is unavailable because the channel it needs was
/// never recorded — which is the normal case for a schema-v1 session.
export function channelNote(
  analysis: SessionAnalysis | null,
  channel: "wheel" | "suspension" | "orientation",
): string | null {
  if (analysis == null) return null;
  const quality = analysis.data_quality;
  const available =
    channel === "wheel"
      ? quality.wheel_telemetry_available
      : channel === "suspension"
        ? quality.suspension_available
        : quality.orientation_available;
  if (available) return null;
  return `Unavailable: this recording (telemetry frame schema v${quality.telemetry_frame_schema_version}) carries no ${
    channel === "orientation" ? "orientation" : `${channel} telemetry`
  }. Nothing is reconstructed from adapter data.`;
}

export interface SlipEpisodeRow {
  key: string;
  /// "High slip episode 3". Never wheelspin, wheel lock or a slide.
  title: string;
  time: string;
  duration: string;
  /// How much of the episode was actually above threshold.
  engaged: string;
  /// "Rear left, Rear right" — every affected corner, named.
  corners: string;
  /// "slip ratio, combined slip".
  channels: string;
  speed: string;
  /// Peak magnitudes across the affected corners.
  peak: string;
  /// Per-corner detail, so no measured peak is lost to coalescing.
  cornerPeaks: { key: string; label: string; value: string }[];
}

/// One episode as a compact card. Every affected corner keeps its own measured
/// peak, so coalescing changes how many rows describe a maneuver and never what
/// the maneuver measured.
export function slipEpisodeRow(episode: SlipEpisode): SlipEpisodeRow {
  // A corner that never crossed a threshold carries null peaks, so filtering on
  // the values is the same as filtering on `corners` and cannot disagree with it.
  const cornerPeaks = canonicalCornerRows(episode.max_abs_slip_ratio)
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.values != null)
    .map(({ row, index }) => {
      const signed = canonicalCornerRows(episode.signed_peak_slip_ratio)[index]
        .values;
      const combined = canonicalCornerRows(episode.max_combined_slip)[index]
        .values;
      return {
        key: `${episode.index}-${row.corner}`,
        label: row.label,
        // The sign is shown because it was measured, and is not interpreted.
        value: `slip ${number(signed, 2)} · combined ${number(combined, 2)}`,
      };
    });
  const entry = speedKmh(episode.entry_speed_mps);
  const exit = speedKmh(episode.exit_speed_mps);
  return {
    key: `slip-${episode.index}-${episode.start_ms}`,
    title: `High slip episode ${episode.index}`,
    time: `${offsetClock(episode.start_ms)} – ${offsetClock(episode.end_ms)}`,
    duration: `${number(episode.duration_ms / 1000, 2)} s`,
    engaged: `${number(episode.engaged_seconds, 2)} s above threshold`,
    corners:
      episode.corners.length === 0
        ? UNAVAILABLE
        : episode.corners.map((corner) => cornerLabelOf(corner)).join(", "),
    channels:
      episode.families.length === 0
        ? UNAVAILABLE
        : episode.families
            .map((family) => SLIP_FAMILY_LABELS[family] ?? family)
            .join(", "),
    speed:
      entry === UNAVAILABLE || exit === UNAVAILABLE
        ? UNAVAILABLE
        : `${entry} → ${exit} km/h`,
    peak: `peak slip ${number(episode.peak_abs_slip_ratio, 2)} · combined ${number(
      episode.peak_combined_slip,
      2,
    )}`,
    cornerPeaks,
  };
}

export function slipEpisodeRows(
  analysis: SessionAnalysis | null,
): SlipEpisodeRow[] {
  if (analysis == null) return [];
  return analysis.slip_episodes
    .slice()
    .sort((a, b) => a.start_ms - b.start_ms)
    .map(slipEpisodeRow);
}

export interface TurnRow {
  key: string;
  /// "Turn segment 4". Deliberately not "Turn 4" and never left or right.
  title: string;
  time: string;
  duration: string;
  entrySpeed: string;
  minSpeed: string;
  exitSpeed: string;
  averageSpeed: string;
  yawChange: string;
  brakeTime: string;
  fullThrottleTime: string;
  maxBrake: string;
  peakSlip: string;
  peakCompression: string;
}

/// The largest value across the four corners, with the corner named. Returns
/// `UNAVAILABLE` when no corner carried the channel, never 0.
function peakCorner(values: CornerValues, digits: number): string {
  let best: { label: string; value: number } | null = null;
  for (const row of canonicalCornerRows(values)) {
    const value = row.values;
    if (value == null || !Number.isFinite(value)) continue;
    if (best == null || value > best.value) {
      best = { label: row.label, value };
    }
  }
  if (best == null) return UNAVAILABLE;
  return `${number(best.value, digits)} (${best.label})`;
}

export function turnRow(segment: TurnSegment): TurnRow {
  return {
    key: `turn-${segment.index}-${segment.start_ms}`,
    title: `Turn segment ${segment.index}`,
    time: `${offsetClock(segment.start_ms)} – ${offsetClock(segment.end_ms)}`,
    duration: `${number(segment.duration_ms / 1000, 2)} s`,
    entrySpeed: speedKmh(segment.entry_speed_mps),
    minSpeed: speedKmh(segment.min_speed_mps),
    exitSpeed: speedKmh(segment.exit_speed_mps),
    averageSpeed: speedKmh(segment.average_speed_mps),
    // Degrees are presentation only; the stored value stays in radians. The
    // sign is shown because it was measured, and is never called left or right.
    yawChange: `${number((segment.signed_yaw_change_rad * 180) / Math.PI, 0)}°`,
    brakeTime: `${number(segment.brake_seconds, 2)} s`,
    fullThrottleTime: `${number(segment.full_throttle_seconds, 2)} s`,
    maxBrake:
      segment.max_brake == null
        ? UNAVAILABLE
        : `${percent(segment.max_brake)}%`,
    peakSlip: peakCorner(segment.max_abs_slip_ratio, 2),
    peakCompression: peakCorner(segment.max_suspension_compression, 2),
  };
}

export function turnRows(analysis: SessionAnalysis | null): TurnRow[] {
  if (analysis == null) return [];
  return analysis.turn_segments
    .slice()
    .sort((a, b) => a.start_ms - b.start_ms)
    .map(turnRow);
}

export interface QualityLine {
  key: string;
  label: string;
  value: string;
  available: boolean;
}

/// What the analysis could and could not see. A channel that was unavailable is
/// stated as unavailable; it never degrades into a zero count.
export function qualityLines(analysis: SessionAnalysis | null): QualityLine[] {
  if (analysis == null) return [];
  const quality = analysis.data_quality;
  const coverage = analysis.coverage;
  const line = (
    key: string,
    label: string,
    value: string,
    available = true,
  ): QualityLine => ({ key, label, value, available });
  const channel = (key: string, label: string, present: boolean) =>
    line(key, label, present ? "Available" : "Unavailable", present);
  return [
    line("frames", "Frames analyzed", quality.frames_read.toLocaleString()),
    line("active", "Active frames", quality.active_frames.toLocaleString()),
    line(
      "inactive",
      "Inactive frames",
      quality.inactive_frames.toLocaleString(),
    ),
    line(
      "analyzed",
      "Analyzed time",
      `${number(coverage.analyzed_seconds, 1)} s of ${number(
        coverage.recorded_seconds,
        1,
      )} s recorded`,
    ),
    line(
      "gaps",
      "Excluded gaps",
      `${coverage.excluded_gap_count.toLocaleString()} · ${number(
        coverage.excluded_gap_seconds,
        1,
      )} s`,
    ),
    line(
      "duplicates",
      "Duplicate timestamps",
      quality.zero_interval_frames.toLocaleString(),
    ),
    line(
      "discontinuities",
      "Speed discontinuities",
      quality.speed_discontinuities.toLocaleString(),
      quality.speed_discontinuities === 0,
    ),
    line(
      "schema",
      "Telemetry frame schema",
      `v${quality.telemetry_frame_schema_version}`,
    ),
    line(
      "stream",
      "Frame stream",
      quality.frame_stream_complete ? "Complete" : "Incomplete (no footer)",
      quality.frame_stream_complete,
    ),
    channel("speed", "Speed", quality.speed_available),
    channel("controls", "Controls", quality.controls_available),
    channel("orientation", "Orientation", quality.orientation_available),
    channel("wheels", "Wheel telemetry", quality.wheel_telemetry_available),
    channel("suspension", "Suspension travel", quality.suspension_available),
    line(
      "truncated",
      "Events omitted by the cap",
      quality.events_truncated.toLocaleString(),
      quality.events_truncated === 0,
    ),
    line(
      "slip-detectors",
      "Raw slip detections",
      `${(
        quality.slip_ratio_detector_events +
        quality.combined_slip_detector_events
      ).toLocaleString()} → ${analysis.driving_summary.slip_episode_count.toLocaleString()} episodes`,
    ),
    line(
      "slip-coverage",
      "Time above a slip threshold",
      `${number(analysis.driving_summary.slip_episode_seconds, 1)} s of ${number(
        coverage.analyzed_seconds,
        1,
      )} s analyzed`,
    ),
  ];
}

/// The heuristics that produced this analysis, phrased as RaceLab definitions
/// rather than as facts about driving. Read from the stored configuration, so
/// the UI can never state a threshold the analysis did not use.
export function heuristicNotes(analysis: SessionAnalysis | null): string[] {
  if (analysis == null) return [];
  const config = analysis.config;
  return [
    `RaceLab definitions, not automotive standards. Full throttle is normalized throttle ≥ ${config.full_throttle_enter} (releasing below ${config.full_throttle_exit}); braking is brake > ${config.braking_enter}; hard braking is brake ≥ ${config.hard_braking_enter} (releasing below ${config.hard_braking_exit}).`,
    `Longitudinal acceleration is the change in canonical speed over monotonic time across at least ${config.acceleration_window_ms} ms. It is never taken from the source acceleration vector, whose vehicle-axis orientation is not established, and a negative value is not called braking. A change beyond ${config.max_plausible_acceleration_mps2} m/s² is treated as a discontinuity in the recorded speed — a collision, a respawn, a rewind or fast travel — and is counted rather than reported as acceleration.`,
    `Slip and suspension events report a channel crossing a RaceLab threshold. Nothing is called wheelspin, wheel lock, understeer, oversteer or bottoming out; those meanings are not established by this telemetry.`,
    `One maneuver puts several corners over threshold on both slip channels at once, so slip is reported as episodes rather than per-corner rows: slip resuming within ${config.slip_merge_gap_ms} ms belongs to the same episode, and an episode needs ${config.slip_min_ms} ms above threshold to be reported. Every affected corner keeps its own measured peak — coalescing never discards or clamps a measurement.`,
    `A suspension excursion needs ${config.suspension_min_ms} ms to be reported, and a corner re-crossing its threshold within ${config.suspension_merge_gap_ms} ms continues the same excursion rather than starting a new one.`,
    `A turn segment is a yaw-rate interval above ${config.turn_yaw_rate_enter_rad_s} rad/s lasting at least ${config.turn_min_duration_ms} ms above ${config.turn_min_speed_mps} m/s, which must also change the car's heading by at least ${config.turn_min_abs_yaw_change_rad} rad net. It is not a claim about a track corner, and the yaw sign is not mapped to left or right because that mapping is unvalidated.`,
    `Intervals longer than ${config.max_gap_ms} ms are telemetry gaps: they are excluded from analyzed time and they close any open event rather than spanning it.`,
  ];
}
