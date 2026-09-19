import { useEffect, useReducer, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import CapturePanel from "./CapturePanel";
import LiveTelemetryPanel from "./LiveTelemetryPanel";
import {
  initialTelemetryState,
  telemetryReducer,
  type StatsSnapshot,
} from "./telemetry-state";

export default function App() {
  const [{ stats, connected, connectionError }, dispatch] = useReducer(
    telemetryReducer,
    initialTelemetryState,
  );
  const [port, setPort] = useState(20440);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Commands and events can arrive out of order. Only apply newer snapshots,
  // including across stop/restart and initial subscription hydration.
  function applySnapshot(snapshot: StatsSnapshot) {
    dispatch({ type: "snapshot", snapshot });
  }

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    async function subscribe() {
      try {
        const cleanup = await listen<StatsSnapshot>(
          "telemetry://stats",
          (event) => {
            if (!disposed) applySnapshot(event.payload);
          },
        );
        if (disposed) {
          cleanup();
          return;
        }
        unlisten = cleanup;
        const snapshot = await invoke<StatsSnapshot>("get_telemetry_stats");
        if (!disposed) {
          applySnapshot(snapshot);
        }
      } catch (reason) {
        if (!disposed)
          dispatch({ type: "connectionFailure", message: String(reason) });
      }
    }
    void subscribe();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  async function changeListener() {
    if (pending) return;
    if (
      !stats?.running &&
      (!Number.isInteger(port) || port < 1 || port > 65535)
    ) {
      setError("Enter a UDP port between 1 and 65535.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      applySnapshot(
        await invoke<StatsSnapshot>(
          stats?.running ? "stop_udp_listener" : "start_udp_listener",
          stats?.running ? {} : { port },
        ),
      );
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPending(false);
    }
  }

  const message = error ?? connectionError ?? stats?.last_error;
  const status = message
    ? "error"
    : stats?.running
      ? stats.packets_per_second > 0
        ? "traffic"
        : "listening"
      : "idle";
  const statusText = pending
    ? "UPDATING"
    : status === "traffic"
      ? "RECEIVING"
      : status === "listening"
        ? "LISTENING"
        : status === "error"
          ? "ERROR"
          : "STOPPED";

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">RACELAB / V0.5.1</p>
          <h1>Telemetry Link</h1>
          <p className="subtitle">
            Listening starts automatically on port 20440. Open the game to
            connect. Live values use the latest telemetry; transport counters
            refresh four times per second.
          </p>
        </div>
        <div className={`status status-${status}`}>
          <span className="status-dot" />
          {statusText}
        </div>
      </header>

      <details className="panel" style={{ marginBottom: 16, padding: 12 }}>
        <summary>Diagnostics / developer listener controls</summary>
        <section className="controls">
          <label>
            <span>
              UDP port
              {stats?.bound_port ? ` · bound to ${stats.bound_port}` : ""}
            </span>
            <input
              type="number"
              min={1}
              max={65535}
              value={port}
              disabled={stats?.running || pending}
              onChange={(event) => setPort(Number(event.target.value))}
            />
          </label>
          <button
            className={stats?.running ? "danger" : "primary"}
            onClick={() => void changeListener()}
            disabled={!connected || pending}
          >
            {stats?.running ? "Stop listener" : "Start listener"}
          </button>
        </section>
      </details>

      {message && (
        <section className="error-banner" role="alert">
          {message}
        </section>
      )}

      <section className="metrics">
        <article className="metric panel">
          <span>Packets</span>
          <strong>{(stats?.total_packets ?? 0).toLocaleString()}</strong>
        </article>
        <article className="metric panel">
          <span>Packets / sec</span>
          <strong>{(stats?.packets_per_second ?? 0).toFixed(1)}</strong>
        </article>
        <article className="metric panel">
          <span>Total bytes</span>
          <strong>{(stats?.total_bytes ?? 0).toLocaleString()}</strong>
        </article>
        <article className="metric panel">
          <span>Packet size</span>
          <strong>
            {stats?.last_packet_size != null
              ? `${stats.last_packet_size} B`
              : "—"}
          </strong>
        </article>
        <article className="metric panel">
          <span>Source</span>
          <strong className="small-value">{stats?.last_source ?? "—"}</strong>
        </article>
        <article className="metric panel">
          <span>Receive errors</span>
          <strong>{stats?.receive_errors ?? 0}</strong>
        </article>
      </section>

      <section className="packet panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">LAST PACKET · FIRST 32 BYTES</p>
            <h2>Hex preview</h2>
          </div>
          <span>
            {stats?.last_packet_timestamp_ms != null
              ? new Date(stats.last_packet_timestamp_ms).toLocaleTimeString()
              : "No traffic yet"}
          </span>
        </div>
        <pre>
          {stats?.last_packet_size != null
            ? stats.preview_hex || "Empty datagram (0 bytes)"
            : "Waiting for game traffic on UDP port 20440."}
        </pre>
      </section>

      <LiveTelemetryPanel listenerRunning={stats?.running ?? false} />
      <CapturePanel listenerRunning={stats?.running ?? false} />

      <section className="next panel">
        <p className="eyebrow">RAW CAPTURE + FH6 ADAPTER</p>
        <p>
          Raw capture preserves every datagram independently of FH6 validation.
          Gear displays the original numeric code; unknown FH6 bytes stay
          opaque.
        </p>
      </section>
    </main>
  );
}
