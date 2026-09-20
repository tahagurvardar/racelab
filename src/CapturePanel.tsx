import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  newerCapture,
  type CaptureSnapshot,
  type PacketTimestamp,
} from "./capture-state.ts";

function timestamp(value: PacketTimestamp | null | undefined) {
  return value
    ? `${new Date(value.received_at_ms).toISOString()} · +${(value.capture_at_us / 1_000_000).toFixed(6)} s`
    : "—";
}

export default function CapturePanel({
  listenerRunning,
}: {
  listenerRunning: boolean;
}) {
  const [capture, setCapture] = useState<CaptureSnapshot | null>(null);
  const [label, setLabel] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  function apply(snapshot: CaptureSnapshot) {
    setCapture((current) => newerCapture(current, snapshot));
  }

  useEffect(() => {
    let disposed = false;
    let recovered = false;
    let unlisten: UnlistenFn | undefined;
    async function subscribe() {
      try {
        const cleanup = await listen<CaptureSnapshot>(
          "capture://stats",
          (event) => {
            if (!disposed) {
              recovered = true;
              setConnectionError(null);
              apply(event.payload);
            }
          },
        );
        if (disposed) {
          cleanup();
          return;
        }
        unlisten = cleanup;
        const snapshot = await invoke<CaptureSnapshot>("get_capture_stats");
        if (!disposed) apply(snapshot);
      } catch (reason) {
        if (!disposed && !recovered) setConnectionError(String(reason));
      }
    }
    void subscribe();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const active = capture?.accepting_packets || capture?.status === "stopping";
  async function changeCapture() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      apply(
        await invoke<CaptureSnapshot>(
          active ? "stop_capture" : "start_capture",
          active ? {} : { label },
        ),
      );
    } catch (reason) {
      setError(String(reason));
      // Hydrate failure state even if event delivery is unavailable.
      try {
        apply(await invoke<CaptureSnapshot>("get_capture_stats"));
      } catch {
        /* Original error stays visible. */
      }
    } finally {
      setPending(false);
    }
  }

  const message = error ?? connectionError ?? capture?.last_error;
  return (
    <section className="packet panel">
      <div className="section-heading">
        <div>
          <p className="eyebrow">V0.3 · EXACT RAW DATAGRAMS</p>
          <h2>Real telemetry capture</h2>
        </div>
        <span>
          {pending
            ? "Saving / updating…"
            : capture?.status === "complete"
              ? "Saved"
              : (capture?.status ?? "Connecting…")}
        </span>
      </div>
      <div className="controls">
        <label>
          <span>Capture label</span>
          <input
            value={label}
            placeholder="01-fh6-stationary-idle"
            disabled={active || pending}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <button
          className={active ? "danger" : "primary"}
          disabled={
            !capture ||
            pending ||
            capture.status === "stopping" ||
            (!active && (!listenerRunning || !label.trim()))
          }
          onClick={() => void changeCapture()}
        >
          {active ? "Stop Capture" : "Start Capture"}
        </button>
      </div>
      {message && (
        <p className="error-banner" role="alert">
          {message}
        </p>
      )}
      {(capture?.dropped_capture_frames ?? 0) > 0 && (
        <p className="error-banner" role="alert">
          Capture loss: {capture?.dropped_capture_frames.toLocaleString()}{" "}
          frames dropped. This dataset is incomplete; record it again.
        </p>
      )}
      {active && !listenerRunning && (
        <p role="status">
          Capture is open, but the UDP listener is stopped. Start the listener
          to receive packets, or Stop Capture to save.
        </p>
      )}
      <p>
        Label: {capture?.label || "—"} · Duration:{" "}
        {((capture?.duration_us ?? 0) / 1_000_000).toFixed(1)} s · Captured:{" "}
        {(capture?.captured_packets ?? 0).toLocaleString()} · Dropped capture
        frames: {capture?.dropped_capture_frames ?? 0}
      </p>
      <p>
        Packet sizes:{" "}
        {Object.entries(capture?.packet_sizes ?? {})
          .map(([size, count]) => `${size} B × ${count.toLocaleString()}`)
          .join(", ") || "—"}
      </p>
      <p>
        First packet: {timestamp(capture?.first_packet_timestamp)}
        <br />
        Last packet: {timestamp(capture?.last_packet_timestamp)}
      </p>
      <p className="eyebrow">FIRST PACKET · FIRST 32 BYTES</p>
      <pre>
        {capture?.first_packet_hex_preview ?? "No captured packets"}
        {capture?.first_packet_hex_preview === ""
          ? "Empty datagram (0 bytes)"
          : ""}
      </pre>
      <p className="eyebrow">LAST PACKET · FIRST 32 BYTES</p>
      <pre>
        {capture?.last_packet_hex_preview ?? "No captured packets"}
        {capture?.last_packet_hex_preview === ""
          ? "Empty datagram (0 bytes)"
          : ""}
      </pre>
      <p style={{ overflowWrap: "anywhere" }}>
        Capture files: {capture?.file_path ?? capture?.directory ?? "—"}
      </p>
      <p>
        Stop Capture drains the writer queue and saves the file and summary.
        Live counts are provisional until Saved. Captures continue independently
        of listener stop/restart.
      </p>
    </section>
  );
}
