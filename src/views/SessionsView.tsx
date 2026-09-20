import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MetricGrid } from "../components/MetricCard";
import { TelemetrySection, ViewHeader } from "../components/TelemetrySection";
import {
  clockTime,
  duration,
  orderSessions,
  sessionRow,
  statusLabel,
  value,
  type RecentSessions,
  type RecorderStatus,
  type SessionManifest,
} from "../session-state.ts";
import type { Metric } from "../telemetry/telemetry-view-model.ts";

const RECENT_LIMIT = 20;

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
  const [error, setError] = useState<string | null>(null);

  // Manifest metadata only. The frame stream is never requested from React.
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

  async function open(sessionId: string) {
    try {
      setSelected(await invoke<SessionManifest>("get_session", { sessionId }));
      setError(null);
    } catch (reason) {
      setError(String(reason));
    }
  }

  const rows = orderSessions(recent?.sessions ?? []).map(sessionRow);
  const summary = selected?.summary ?? null;
  const message = error ?? recorderError ?? recorder?.last_error ?? null;

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
              This session was not finalized. Its data is incomplete and no
              summary was calculated.
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
    </>
  );
}
