import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MetricGrid } from "../components/MetricCard";
import { TelemetrySection, ViewHeader } from "../components/TelemetrySection";
import {
  bytes,
  clockTime,
  duration,
  orderSessions,
  recoveryLabel,
  recoveryNote,
  retentionNote,
  sessionRow,
  statusLabel,
  value,
  type RecentSessions,
  type RecorderStatus,
  type SessionManifest,
  type StorageStatus,
} from "../session-state.ts";
import {
  analysisBanner,
  analysisJobLines,
  channelNote,
  drivingEventRows,
  heuristicNotes,
  qualityLines,
  slipEpisodeRows,
  suspensionEventRows,
  turnRows,
  type EventRow,
  type SessionAnalysisState,
} from "../analysis-state.ts";
import type { Metric } from "../telemetry/telemetry-view-model.ts";

const RECENT_LIMIT = 20;

/// One event, rendered as a compact reading rather than a log line. The view
/// model already produced every string; this only places them.
function EventList({
  rows,
  empty,
  note,
}: {
  rows: EventRow[];
  empty: string;
  note: string | null;
}) {
  if (note != null) {
    return (
      <p className="section-footnote" role="status">
        {note}
      </p>
    );
  }
  if (rows.length === 0) {
    return <p className="section-description">{empty}</p>;
  }
  return (
    <ul className="session-list">
      {rows.map((row) => (
        <li key={row.key} className="panel session-row">
          <div className="session-row-main">
            <p className="session-row-title">
              {row.label}
              {row.hasCorner ? ` · ${row.corner}` : ""}
            </p>
            <p className="session-row-meta">
              {row.time} · {row.duration}
            </p>
          </div>
          <div className="session-row-figures">
            <span>{row.speed}</span>
          </div>
          <p className="session-row-status">{row.detail}</p>
        </li>
      ))}
    </ul>
  );
}

/// V0.6 semantics are unchanged: manifest metadata only, no frame stream in
/// React, and no user-facing recording control. Only the presentation changed.
function detail(key: string, label: string, text: string): Metric {
  return {
    key,
    label,
    value: text,
    unit: null,
    available: text !== "—",
  };
}

export default function SessionsView({
  recorder,
  recorderError,
}: {
  recorder: RecorderStatus | null;
  recorderError: string | null;
}) {
  const [recent, setRecent] = useState<RecentSessions | null>(null);
  const [selected, setSelected] = useState<SessionManifest | null>(null);
  const [analysis, setAnalysis] = useState<SessionAnalysisState | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [reanalyzing, setReanalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Manifest metadata only. The frame stream is never requested from React.
  // Storage status is a second metadata-sized read of counters the backend
  // already holds; neither opens a recording.
  const refresh = useCallback(async () => {
    try {
      setRecent(
        await invoke<RecentSessions>("list_recent_sessions", {
          limit: RECENT_LIMIT,
        }),
      );
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
    try {
      setStorage(await invoke<StorageStatus>("get_storage_status"));
    } catch {
      // Housekeeping status is additive. Failing to read it must never stop
      // the sessions list from rendering.
      setStorage(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The recorder status this view receives is polled once, at the app shell.
  // A finished recording is the only thing that can add a row, so the listing
  // is re-read on that transition instead of on a timer of its own.
  const completed = recorder?.completed_sessions ?? null;
  useEffect(() => {
    if (completed != null) void refresh();
  }, [completed, refresh]);

  // Two manifest-scale reads: the session's metadata and its derived analysis.
  // Neither opens the frame stream; there is no command that would let React
  // ask for one, and the analysis is already reduced to events and segments.
  async function open(sessionId: string) {
    setAnalysis(null);
    setAnalysisError(null);
    try {
      setSelected(await invoke<SessionManifest>("get_session", { sessionId }));
      setError(null);
    } catch (reason) {
      setError(String(reason));
      return;
    }
    try {
      setAnalysis(
        await invoke<SessionAnalysisState>("get_session_analysis", {
          sessionId,
        }),
      );
    } catch (reason) {
      // An analysis that cannot be read is its own failure. The session is
      // already open and stays open.
      setAnalysisError(String(reason));
    }
  }

  // Recovery only, and deliberately not a driving control: this is offered for
  // a failed or unreadable analysis, never as part of a normal drive. It
  // rewrites `analysis.json` and nothing else.
  async function reanalyze(sessionId: string) {
    setReanalyzing(true);
    try {
      await invoke("reanalyze_session", { sessionId });
      setAnalysisError(null);
      setAnalysis(
        await invoke<SessionAnalysisState>("get_session_analysis", {
          sessionId,
        }),
      );
    } catch (reason) {
      setAnalysisError(String(reason));
    } finally {
      setReanalyzing(false);
    }
  }

  const ordered = orderSessions(recent?.sessions ?? []);
  const rows = ordered.map((manifest) => ({
    ...sessionRow(manifest),
    recovery: recoveryLabel(manifest),
  }));
  const summary = selected?.summary ?? null;
  const storageNote = retentionNote(storage?.retention ?? null);
  const recovering = storage?.recovery ?? null;
  const message = error ?? recorderError ?? recorder?.last_error ?? null;
  const banner = analysisBanner(analysis, analysisError);
  const document = banner.showAnalysis ? (analysis?.analysis ?? null) : null;

  return (
    <>
      <ViewHeader
        title="Sessions"
        summary="Sessions record themselves. There is no Start Recording control: the recorder follows the session lifecycle."
      />

      {message ? (
        <p className="banner" role="alert">
          {message}
        </p>
      ) : null}

      <TelemetrySection
        eyebrow="V0.6 · AUTOMATIC SESSION RECORDER"
        title="Recorder"
        aside={
          <span className="section-status">
            {recorder?.recording
              ? "Recording"
              : recorder?.status === "error"
                ? "Recorder error"
                : "Idle · waiting for an active session"}
          </span>
        }
      >
        {(recorder?.recorder_dropped_frames ?? 0) > 0 ? (
          <p className="banner" role="alert">
            Recorder loss: {recorder?.recorder_dropped_frames.toLocaleString()}{" "}
            frames dropped. Affected sessions are marked incomplete.
          </p>
        ) : null}
        <MetricGrid
          columns={5}
          metrics={[
            detail("id", "Session ID", recorder?.session_id ?? "—"),
            detail(
              "duration",
              "Duration",
              recorder?.recording
                ? duration((recorder.duration_ms ?? 0) / 1000)
                : "—",
            ),
            detail(
              "frames",
              "Frames written",
              (recorder?.frames_written ?? 0).toLocaleString(),
            ),
            detail(
              "queue",
              "Queued frames",
              `${(recorder?.queued_frames ?? 0).toLocaleString()} / ${(
                recorder?.queue_capacity ?? 0
              ).toLocaleString()}`,
            ),
            detail(
              "drops",
              "Recorder drops",
              (recorder?.recorder_dropped_frames ?? 0).toLocaleString(),
            ),
          ]}
        />
        <p className="section-footnote path">
          Sessions directory: {recorder?.sessions_directory ?? "—"}
          {storage
            ? ` · ${bytes(storage.retention.used_bytes)} used${
                storage.retention.enabled
                  ? ` of a ${bytes(storage.retention.budget_bytes)} limit`
                  : ", no storage limit set"
              }`
            : ""}
        </p>
      </TelemetrySection>

      <TelemetrySection
        eyebrow="V0.6 · MANIFEST METADATA ONLY"
        title="Recent sessions"
        aside={<span className="section-status">{rows.length} shown</span>}
      >
        {(recent?.unreadable ?? 0) > 0 ? (
          <p className="section-footnote" role="status">
            {recent?.unreadable} session folder(s) could not be read and were
            skipped.
          </p>
        ) : null}
        {storageNote ? (
          <p
            className={
              storage?.retention.over_budget ? "banner" : "section-footnote"
            }
            role={storage?.retention.over_budget ? "alert" : "status"}
          >
            {storageNote}
          </p>
        ) : null}
        {recovering && (recovering.pending > 0 || recovering.scanned > 0) ? (
          <p className="section-footnote" role="status">
            {recovering.pending > 0
              ? `Checking ${recovering.pending.toLocaleString()} unfinished recording(s) to see how much of each can be read. `
              : ""}
            {recovering.scanned > 0
              ? `${recovering.scanned.toLocaleString()} checked this run; ${recovering.recovered_frames.toLocaleString()} frames recovered that the manifests had not recorded.`
              : ""}
          </p>
        ) : null}
        {rows.length === 0 ? (
          <p className="section-description">
            No recorded sessions yet. Drive in a detected game and a session is
            saved automatically.
          </p>
        ) : (
          <ul className="session-list">
            {rows.map((row) => (
              <li
                key={row.id}
                className={`panel session-row${
                  row.incomplete ? " is-incomplete" : ""
                }`}
              >
                <div className="session-row-main">
                  <p className="session-row-title">{row.started}</p>
                  <p className="session-row-meta">
                    {row.game} · Vehicle {row.vehicle} · {row.duration}
                  </p>
                </div>
                <div className="session-row-figures">
                  <span>max {row.maxSpeed} km/h</span>
                  <span>avg {row.averageSpeed} km/h</span>
                </div>
                <p className="session-row-status">
                  {row.status}
                  {row.recovery ? ` · ${row.recovery}` : ""}
                  {row.dropped > 0 ? ` · ${row.dropped} dropped frames` : ""}
                </p>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => void open(row.id)}
                >
                  Open
                </button>
              </li>
            ))}
          </ul>
        )}
      </TelemetrySection>

      {selected ? (
        <TelemetrySection
          eyebrow="V0.6 · SESSION DETAILS"
          title="Selected session"
          aside={
            <span className="section-status">
              {statusLabel(selected.status)}
            </span>
          }
        >
          {selected.status !== "completed" ? (
            <p className="banner" role="alert">
              {recoveryNote(selected) ??
                "This session was not finalized. Its data is incomplete and no summary was calculated."}
            </p>
          ) : null}
          {selected.recorder_dropped_frames > 0 ? (
            <p className="banner" role="alert">
              {selected.recorder_dropped_frames.toLocaleString()} frames were
              dropped by the recorder; this session is not a complete dataset.
            </p>
          ) : null}
          <p className="section-description path">
            {selected.session_id} · Game {selected.game ?? "—"} · Vehicle{" "}
            {selected.vehicle_id ?? "—"} · RaceLab{" "}
            {selected.created_by_racelab_version}
            <br />
            Start {clockTime(selected.started_at_unix_ms)} · End{" "}
            {clockTime(selected.ended_at_unix_ms)} · Reason{" "}
            {selected.completion_reason ?? "—"}
          </p>
          <MetricGrid
            columns={4}
            metrics={[
              detail(
                "duration",
                "Duration",
                duration(selected.duration_us / 1_000_000),
              ),
              detail("frames", "Frames", selected.frame_count.toLocaleString()),
              detail(
                "drops",
                "Recorder drops",
                selected.recorder_dropped_frames.toLocaleString(),
              ),
              detail(
                "max-speed",
                "Max speed km/h",
                value(summary?.max_speed_kmh),
              ),
              detail(
                "avg-speed",
                "Average speed km/h",
                value(summary?.average_speed_kmh),
              ),
              detail("max-rpm", "Max RPM", value(summary?.max_rpm, 0)),
              detail("avg-rpm", "Average RPM", value(summary?.average_rpm, 0)),
              detail(
                "throttle",
                "Full throttle",
                summary
                  ? `${value(summary.full_throttle_seconds)} s · ${value(
                      summary.full_throttle_percent,
                    )}%`
                  : "—",
              ),
              detail(
                "braking",
                "Braking",
                summary
                  ? `${value(summary.braking_seconds)} s · ${value(
                      summary.braking_percent,
                    )}%`
                  : "—",
              ),
              detail(
                "gear-changes",
                "Gear changes",
                value(summary?.gear_change_count, 0),
              ),
              detail("distance", "Distance m", value(summary?.distance_meters)),
              detail(
                "quality",
                "Data quality",
                summary
                  ? summary.data_quality.complete
                    ? "Complete"
                    : "Incomplete"
                  : "—",
              ),
            ]}
          />
          <p className="section-footnote">
            Full throttle is normalized throttle ≥ 0.95; braking is normalized
            brake &gt; 0.05. Averages are time-weighted over monotonic frame
            timing. Details come from the manifest and summary alone; the frame
            stream is never loaded here.
          </p>
        </TelemetrySection>
      ) : null}

      {selected ? (
        <TelemetrySection
          eyebrow="V0.9 · DERIVED ANALYSIS"
          title="Session analysis"
          aside={<span className="section-status">{banner.headline}</span>}
          description="Derived from the recorded session after it completed. These are RaceLab measurements and RaceLab definitions, not judgements: nothing here rates a lap, a line or a driver."
        >
          <p
            className={banner.problem ? "banner" : "section-description"}
            role={banner.problem ? "alert" : "status"}
          >
            {banner.detail}
          </p>
          {analysisJobLines(analysis).length > 0 ? (
            <p className="section-footnote" role="status">
              {analysisJobLines(analysis)
                .map((line) => `${line.label}: ${line.value}`)
                .join(" · ")}
            </p>
          ) : null}
          {banner.offerReanalysis && banner.problem ? (
            <p className="section-footnote">
              <button
                type="button"
                className="ghost"
                disabled={reanalyzing}
                onClick={() => void reanalyze(selected.session_id)}
              >
                {reanalyzing ? "Re-running…" : "Re-run analysis"}
              </button>{" "}
              Reads the saved recording again and replaces{" "}
              {analysis?.file ?? "the analysis"}. The recording itself is never
              modified.
            </p>
          ) : null}
          {document ? (
            <>
              <MetricGrid
                columns={4}
                metrics={[
                  detail(
                    "events",
                    "Events",
                    document.driving_summary.event_count.toLocaleString(),
                  ),
                  detail(
                    "slip",
                    "Slip episodes",
                    document.driving_summary.slip_episode_count.toLocaleString(),
                  ),
                  detail(
                    "turns",
                    "Turn segments",
                    document.driving_summary.turn_segment_count.toLocaleString(),
                  ),
                  detail(
                    "analyzed",
                    "Analyzed time",
                    duration(document.coverage.analyzed_seconds),
                  ),
                ]}
              />
              <h3 className="section-subtitle">Driving events</h3>
              <EventList
                rows={drivingEventRows(document)}
                empty="No throttle, brake or acceleration events crossed a RaceLab threshold in this session."
                note={null}
              />

              <h3 className="section-subtitle">Turn segments</h3>
              {turnRows(document).length === 0 ? (
                <p className="section-description">
                  {channelNote(document, "orientation") ??
                    "No yaw-rate interval met the turn-segment thresholds in this session."}
                </p>
              ) : (
                <ul className="session-list">
                  {turnRows(document).map((turn) => (
                    <li key={turn.key} className="panel session-row">
                      <div className="session-row-main">
                        <p className="session-row-title">{turn.title}</p>
                        <p className="session-row-meta">
                          {turn.time} · {turn.duration} · yaw {turn.yawChange}
                        </p>
                      </div>
                      <div className="session-row-figures">
                        <span>
                          entry {turn.entrySpeed} · min {turn.minSpeed} · exit{" "}
                          {turn.exitSpeed} km/h
                        </span>
                        <span>avg {turn.averageSpeed} km/h</span>
                      </div>
                      <p className="session-row-status">
                        brake {turn.brakeTime} · full throttle{" "}
                        {turn.fullThrottleTime} · max brake {turn.maxBrake} ·
                        peak slip {turn.peakSlip}
                      </p>
                    </li>
                  ))}
                </ul>
              )}

              <h3 className="section-subtitle">High slip episodes</h3>
              {channelNote(document, "wheel") ? (
                <p className="section-footnote" role="status">
                  {channelNote(document, "wheel")}
                </p>
              ) : slipEpisodeRows(document).length === 0 ? (
                <p className="section-description">
                  No corner's slip channels crossed a RaceLab threshold for long
                  enough to report in this session.
                </p>
              ) : (
                <ul className="session-list">
                  {slipEpisodeRows(document).map((episode) => (
                    <li key={episode.key} className="panel session-row">
                      <div className="session-row-main">
                        <p className="session-row-title">{episode.title}</p>
                        <p className="session-row-meta">
                          {episode.time} · {episode.duration} ·{" "}
                          {episode.engaged}
                        </p>
                      </div>
                      <div className="session-row-figures">
                        <span>{episode.speed}</span>
                        <span>{episode.peak}</span>
                      </div>
                      <p className="session-row-status">
                        {episode.corners} · {episode.channels}
                      </p>
                      <p className="section-footnote">
                        {episode.cornerPeaks.map((corner) => (
                          <span key={corner.key}>
                            {corner.label}: {corner.value}
                            {"  "}
                          </span>
                        ))}
                      </p>
                    </li>
                  ))}
                </ul>
              )}

              <h3 className="section-subtitle">Suspension events</h3>
              <EventList
                rows={suspensionEventRows(document)}
                empty="No corner's normalized suspension travel crossed a RaceLab threshold in this session."
                note={channelNote(document, "suspension")}
              />

              <h3 className="section-subtitle">Data quality</h3>
              <MetricGrid
                columns={4}
                metrics={qualityLines(document).map((line) => ({
                  key: line.key,
                  label: line.label,
                  value: line.value,
                  unit: null,
                  available: line.available,
                }))}
              />

              {heuristicNotes(document).map((note, index) => (
                <p className="section-footnote" key={`heuristic-${index}`}>
                  {note}
                </p>
              ))}
            </>
          ) : null}
        </TelemetrySection>
      ) : null}
    </>
  );
}
