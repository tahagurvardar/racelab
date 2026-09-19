import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { startLatestPolling } from "./latest-poller";
import {
  clockTime,
  duration,
  newerRecorder,
  orderSessions,
  sessionRow,
  statusLabel,
  value,
  type RecentSessions,
  type RecorderStatus,
  type SessionManifest,
} from "./session-state";

const RECENT_LIMIT = 20;

function Detail({ name, text }: { name: string; text: string }) {
  return (
    <article className="metric panel">
      <span>{name}</span>
      <strong className={text.length > 12 ? "small-value" : undefined}>
        {text}
      </strong>
    </article>
  );
}

export default function SessionsPanel() {
  const [recorder, setRecorder] = useState<RecorderStatus | null>(null);
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
    return startLatestPolling(
      () => invoke<RecorderStatus>("get_recorder_status"),
      (incoming) =>
        setRecorder((current) => {
          const next = newerRecorder(current, incoming);
          // A finished recording is the only thing that can add a row.
          if (
            current &&
            next.completed_sessions !== current.completed_sessions
          ) {
            void refresh();
          }
          return next;
        }),
      (reason) => setError(String(reason)),
      500,
    );
  }, [refresh]);

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

  return (
    <>
      <section className="packet panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">V0.6 · AUTOMATIC SESSION RECORDER</p>
            <h2>Recorder</h2>
          </div>
          <span>
            {recorder?.recording
              ? "Recording"
              : recorder?.status === "error"
                ? "Recorder error"
                : "Idle · waiting for an active session"}
          </span>
        </div>
        <p>
          Recording starts and stops with the session lifecycle. There is no
          Start Recording button; normalized telemetry frames are stored, not
          raw datagrams.
        </p>
        {error && (
          <p className="error-banner" role="alert">
            {error}
          </p>
        )}
        {recorder?.last_error && (
          <p className="error-banner" role="alert">
            {recorder.last_error}
          </p>
        )}
        {(recorder?.recorder_dropped_frames ?? 0) > 0 && (
          <p className="error-banner" role="alert">
            Recorder loss: {recorder?.recorder_dropped_frames.toLocaleString()}{" "}
            frames dropped. Affected sessions are marked incomplete.
          </p>
        )}
        <div className="metrics">
          <Detail name="Session ID" text={recorder?.session_id ?? "—"} />
          <Detail
            name="Duration"
            text={
              recorder?.recording
                ? duration((recorder?.duration_ms ?? 0) / 1000)
                : "—"
            }
          />
          <Detail
            name="Frames written"
            text={(recorder?.frames_written ?? 0).toLocaleString()}
          />
          <Detail
            name="Queued frames"
            text={`${(recorder?.queued_frames ?? 0).toLocaleString()} / ${(
              recorder?.queue_capacity ?? 0
            ).toLocaleString()}`}
          />
          <Detail
            name="Recorder drops"
            text={(recorder?.recorder_dropped_frames ?? 0).toLocaleString()}
          />
        </div>
        <p style={{ overflowWrap: "anywhere" }}>
          Sessions: {recorder?.sessions_directory ?? "—"}
        </p>
      </section>

      <section className="packet panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">V0.6 · MANIFEST METADATA ONLY</p>
            <h2>Recent sessions</h2>
          </div>
          <span>{rows.length} shown</span>
        </div>
        {(recent?.unreadable ?? 0) > 0 && (
          <p role="status">
            {recent?.unreadable} session folder(s) could not be read and were
            skipped.
          </p>
        )}
        {rows.length === 0 ? (
          <p>
            No recorded sessions yet. Drive in a detected game and a session is
            saved automatically.
          </p>
        ) : (
          <div className="metrics">
            {rows.map((row) => (
              <article key={row.id} className="metric panel">
                <span>
                  {row.started} · {row.game} · Vehicle {row.vehicle}
                </span>
                <strong className="small-value">
                  {row.duration} · max {row.maxSpeed} km/h · avg{" "}
                  {row.averageSpeed} km/h
                </strong>
                <p className={row.incomplete ? "error-banner" : undefined}>
                  {row.status}
                  {row.dropped > 0 ? ` · ${row.dropped} dropped frames` : ""}
                </p>
                <button className="primary" onClick={() => void open(row.id)}>
                  Open session
                </button>
              </article>
            ))}
          </div>
        )}
      </section>

      {selected && (
        <section className="packet panel">
          <div className="section-heading">
            <div>
              <p className="eyebrow">V0.6 · SESSION DETAILS</p>
              <h2>Selected session</h2>
            </div>
            <span>{statusLabel(selected.status)}</span>
          </div>
          {selected.status !== "completed" && (
            <p className="error-banner" role="alert">
              This session was not finalized. Its data is incomplete and no
              summary was calculated.
            </p>
          )}
          {selected.recorder_dropped_frames > 0 && (
            <p className="error-banner" role="alert">
              {selected.recorder_dropped_frames.toLocaleString()} frames were
              dropped by the recorder; this session is not a complete dataset.
            </p>
          )}
          <p style={{ overflowWrap: "anywhere" }}>
            Session: {selected.session_id} · Game: {selected.game ?? "—"} ·
            Vehicle ID: {selected.vehicle_id ?? "—"} · RaceLab{" "}
            {selected.created_by_racelab_version}
            <br />
            Start: {clockTime(selected.started_at_unix_ms)} · End:{" "}
            {clockTime(selected.ended_at_unix_ms)} · Reason:{" "}
            {selected.completion_reason ?? "—"}
          </p>
          <div className="metrics">
            <Detail
              name="Duration"
              text={duration(selected.duration_us / 1_000_000)}
            />
            <Detail
              name="Frames"
              text={selected.frame_count.toLocaleString()}
            />
            <Detail
              name="Recorder drops"
              text={selected.recorder_dropped_frames.toLocaleString()}
            />
            <Detail
              name="Max speed km/h"
              text={value(summary?.max_speed_kmh)}
            />
            <Detail
              name="Average speed km/h"
              text={value(summary?.average_speed_kmh)}
            />
            <Detail name="Max RPM" text={value(summary?.max_rpm, 0)} />
            <Detail name="Average RPM" text={value(summary?.average_rpm, 0)} />
            <Detail
              name="Full throttle"
              text={
                summary
                  ? `${value(summary.full_throttle_seconds)} s · ${value(
                      summary.full_throttle_percent,
                    )}%`
                  : "—"
              }
            />
            <Detail
              name="Braking"
              text={
                summary
                  ? `${value(summary.braking_seconds)} s · ${value(
                      summary.braking_percent,
                    )}%`
                  : "—"
              }
            />
            <Detail
              name="Gear changes"
              text={value(summary?.gear_change_count, 0)}
            />
            <Detail name="Distance m" text={value(summary?.distance_meters)} />
            <Detail
              name="Data quality"
              text={
                summary
                  ? summary.data_quality.complete
                    ? "Complete"
                    : "Incomplete"
                  : "—"
              }
            />
          </div>
          <p>
            Full throttle is normalized throttle ≥ 0.95; braking is normalized
            brake &gt; 0.05. Averages are time-weighted over monotonic frame
            timing. Details come from the manifest and summary alone; the frame
            stream is never loaded here.
          </p>
        </section>
      )}
    </>
  );
}
