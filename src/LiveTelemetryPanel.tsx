import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { newerLive, liveMetrics, type LiveSnapshot } from "./live-state";

export default function LiveTelemetryPanel({
  listenerRunning,
}: {
  listenerRunning: boolean;
}) {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    let recovered = false;
    let unlisten: UnlistenFn | undefined;
    const apply = (incoming: LiveSnapshot) =>
      setSnapshot((current) => newerLive(current, incoming));
    async function subscribe() {
      try {
        const cleanup = await listen<LiveSnapshot>(
          "telemetry://frame",
          (event) => {
            if (!disposed) {
              recovered = true;
              setError(null);
              apply(event.payload);
            }
          },
        );
        if (disposed) {
          cleanup();
          return;
        }
        unlisten = cleanup;
        const initial = await invoke<LiveSnapshot>("get_live_telemetry");
        if (!disposed) apply(initial);
      } catch (reason) {
        if (!disposed && !recovered) setError(String(reason));
      }
    }
    void subscribe();
    return () => {
      disposed = true;
      unlisten?.();
    };
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
          <p className="eyebrow">FH6 · V0.4 ADAPTER</p>
          <h2>Live telemetry</h2>
        </div>
        <span>
          {!listenerRunning
            ? "Listener stopped"
            : snapshot?.stale
              ? "Waiting for telemetry"
              : snapshot?.frame?.active
                ? "Active"
                : snapshot?.frame
                  ? "Inactive · zero telemetry"
                  : "No valid frame"}
        </span>
      </div>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {snapshot && snapshot.invalid_packets > 0 && (
        <p role="status">
          Rejected packets: {snapshot.invalid_packets.toLocaleString()}
        </p>
      )}
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
