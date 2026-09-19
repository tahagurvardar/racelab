import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  newerLive,
  liveMetrics,
  connectionLabel,
  type LiveSnapshot,
} from "./live-state";
import { startLatestPolling } from "./latest-poller";

export default function LiveTelemetryPanel({
  listenerRunning,
}: {
  listenerRunning: boolean;
}) {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    return startLatestPolling(
      () => invoke<LiveSnapshot>("get_live_telemetry"),
      (incoming) => {
        setError(null);
        setSnapshot((current) => newerLive(current, incoming));
      },
      (reason) => {
        setError(String(reason));
        setSnapshot(null);
      },
    );
  }, []);
  const values = liveMetrics(snapshot, listenerRunning);
  const fields = [
    ["Speed km/h", values.speed],
    ["RPM", values.rpm],
    ["Gear (code)", values.gear],
    ["Throttle %", values.throttle],
    ["Brake %", values.brake],
    ["Steering %", values.steering],
  ];
  return (
    <section className="packet panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">V0.6 · AUTOMATIC TELEMETRY</p>
          <h2>Live telemetry</h2>
        </div>
        <span>{connectionLabel(snapshot?.connection)}</span>
      </div>
      <p>
        Connection health: <strong>{snapshot?.health ?? "LOST"}</strong> ·
        Protocol:{" "}
        {snapshot?.protocol === "fh6" ? "Forza Horizon 6" : "Not identified"} ·
        Confidence: {((snapshot?.protocol_confidence ?? 0) * 100).toFixed(0)}%
      </p>
      <p>
        Input: {(snapshot?.input_packet_hz ?? 0).toFixed(1)} Hz · Valid frames:{" "}
        {(snapshot?.valid_frame_hz ?? 0).toFixed(1)} Hz · Last packet:{" "}
        {snapshot?.last_packet_age_ms == null
          ? "—"
          : `${snapshot.last_packet_age_ms} ms ago`}{" "}
        · Last valid frame:{" "}
        {snapshot?.last_valid_frame_age_ms == null
          ? "—"
          : `${snapshot.last_valid_frame_age_ms} ms ago`}
      </p>
      <p>
        Receive errors: {snapshot?.receive_errors ?? 0} · Hub subscriber drops:{" "}
        {snapshot?.hub.subscriber_drops ?? 0} · Recent frames:{" "}
        {snapshot?.hub.recent_frames ?? 0}/{snapshot?.hub.ring_capacity ?? 512}
      </p>
      {snapshot?.transport_error && (
        <p className="error-banner" role="alert">
          {snapshot.transport_error}
        </p>
      )}
      {snapshot?.session ? (
        <p style={{ overflowWrap: "anywhere" }}>
          Session: {snapshot.session.id} · {snapshot.session.state}
          <br />
          Started:{" "}
          {snapshot.session.started_at == null
            ? "—"
            : new Date(snapshot.session.started_at).toLocaleString()}{" "}
          · Duration: {(snapshot.session.duration_ms / 1000).toFixed(1)} s ·
          Game: {snapshot.session.game ?? "—"} · Vehicle ID:{" "}
          {snapshot.session.vehicle_id ?? "—"}
          {snapshot.session.grace_remaining_ms != null
            ? ` · Grace remaining: ${(snapshot.session.grace_remaining_ms / 1000).toFixed(1)} s`
            : ""}
        </p>
      ) : (
        <p>
          No session yet. A session starts automatically with validated active
          telemetry.
        </p>
      )}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <p role="status">
        FH6 active: {(snapshot?.valid_active_fh6 ?? 0).toLocaleString()} · FH6
        inactive (menus/loading):{" "}
        {(snapshot?.valid_inactive_fh6 ?? 0).toLocaleString()} · Invalid FH6:{" "}
        {(snapshot?.invalid_fh6 ?? 0).toLocaleString()} · Unknown protocol:{" "}
        {(snapshot?.unknown_protocol ?? 0).toLocaleString()}
      </p>
      {snapshot?.issues.map((issue, index) => (
        <p
          key={`${issue.field}-${index}`}
          className="error-banner"
          role="alert"
        >
          {issue.field} @{issue.offset}: {issue.reason}
        </p>
      ))}
      <div className="metrics">
        {fields.map(([name, value]) => (
          <article key={name} className="metric panel">
            <span>{name}</span>
            <strong>{value}</strong>
          </article>
        ))}
      </div>
    </section>
  );
}
