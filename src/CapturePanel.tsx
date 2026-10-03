import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  CAPTURE_STATES,
  newerCapture,
  type CaptureSnapshot,
  type PacketTimestamp,
} from "./capture-state.ts";
import { Notice } from "./components/shell/Notice";
import { integer, namedCode, type NamedCode } from "./telemetry/formatting.ts";

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
  // The writer is draining after Stop: nothing to change until it is saved.
  const busy = pending || capture?.status === "stopping";
  async function changeCapture() {
    if (busy) return;
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
  const status: NamedCode = pending
    ? { name: "Saving / updating…", code: null }
    : capture == null
      ? { name: "Connecting…", code: null }
      : namedCode(capture.status, CAPTURE_STATES);
  const facts: [string, string][] = [
    ["Label", capture?.label || "—"],
    ["Duration", `${((capture?.duration_us ?? 0) / 1_000_000).toFixed(1)} s`],
    ["Captured packets", integer(capture?.captured_packets ?? 0)],
    ["Dropped capture frames", integer(capture?.dropped_capture_frames ?? 0)],
    [
      "Packet sizes",
      Object.entries(capture?.packet_sizes ?? {})
        .map(([size, count]) => `${size} B × ${integer(count)}`)
        .join(", ") || "—",
    ],
    ["First packet", timestamp(capture?.first_packet_timestamp)],
    ["Last packet", timestamp(capture?.last_packet_timestamp)],
    ["Capture files", capture?.file_path ?? capture?.directory ?? "—"],
  ];
  return (
    <div className="diag-columns capture">
      <div className="diag-column">
        <section className="diag-group" aria-labelledby="capture-title">
          <h2 className="diag-group-title" id="capture-title">
            Raw capture
          </h2>
          <p className="diag-status" role="status">
            {status.name}
            {status.code ? (
              <code className="diag-code">{status.code}</code>
            ) : null}
          </p>
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
              type="button"
              className={active ? "danger" : "primary"}
              disabled={
                !capture || (!active && (!listenerRunning || !label.trim()))
              }
              // Busy is not `disabled`: the button keeps keyboard focus
              // while the action it started completes.
              aria-disabled={busy}
              onClick={() => void changeCapture()}
            >
              {active ? "Stop Capture" : "Start Capture"}
            </button>
          </div>
          <p className="diag-note">
            Raw capture saves every received datagram exactly, independently of
            Forza Horizon 6 validation and of session recording. Stop Capture
            drains the writer queue and saves the file and summary; live counts
            are provisional until Saved. Captures continue independently of
            listener stop/restart.
          </p>
          {message ? (
            <Notice tone="bad" title="Capture problem" technical={message}>
              The last capture action did not complete.
            </Notice>
          ) : null}
          {(capture?.dropped_capture_frames ?? 0) > 0 ? (
            <Notice tone="bad" title="Capture loss">
              {integer(capture?.dropped_capture_frames)} frames dropped. This
              dataset is incomplete; record it again.
            </Notice>
          ) : null}
          {active && !listenerRunning ? (
            <Notice tone="warn" title="Listener stopped">
              Capture is open, but the UDP listener is stopped. Start the
              listener to receive packets, or Stop Capture to save.
            </Notice>
          ) : null}
        </section>
        <section className="diag-group" aria-label="Capture summary">
          <h2 className="diag-group-title">Summary</h2>
          <table className="diag-table">
            <caption className="visually-hidden">Capture summary</caption>
            <tbody>
              {facts.map(([name, value]) => (
                <tr key={name}>
                  <th scope="row">{name}</th>
                  <td className="diag-value">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
      <div className="diag-column">
        <section className="diag-group" aria-labelledby="capture-first">
          <h2 className="diag-group-title" id="capture-first">
            First packet · first 32 bytes
          </h2>
          <pre>
            {capture?.first_packet_hex_preview ?? "No captured packets"}
            {capture?.first_packet_hex_preview === ""
              ? "Empty datagram (0 bytes)"
              : ""}
          </pre>
        </section>
        <section className="diag-group" aria-labelledby="capture-last">
          <h2 className="diag-group-title" id="capture-last">
            Last packet · first 32 bytes
          </h2>
          <pre>
            {capture?.last_packet_hex_preview ?? "No captured packets"}
            {capture?.last_packet_hex_preview === ""
              ? "Empty datagram (0 bytes)"
              : ""}
          </pre>
        </section>
      </div>
    </div>
  );
}
