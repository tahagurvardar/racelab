import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type PacketEvent = {
  received_at_ms: number;
  size: number;
  source: string;
  preview_hex: string;
};

type ListenerError = {
  message: string;
};

type Status = "idle" | "starting" | "listening" | "traffic" | "error";

const DEFAULT_PORT = 5300;

export default function App() {
  const [status, setStatus] = useState<Status>("idle");
  const [port, setPort] = useState(DEFAULT_PORT);
  const [packetCount, setPacketCount] = useState(0);
  const [packetsPerSecond, setPacketsPerSecond] = useState(0);
  const [lastPacket, setLastPacket] = useState<PacketEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const packetTimesRef = useRef<number[]>([]);

  useEffect(() => {
    const unlistenPacket = listen<PacketEvent>("telemetry://packet", (event) => {
      const now = Date.now();
      packetTimesRef.current.push(now);
      setPacketCount((count) => count + 1);
      setLastPacket(event.payload);
      setStatus("traffic");
    });

    const unlistenError = listen<ListenerError>("telemetry://error", (event) => {
      setError(event.payload.message);
      setStatus("error");
    });

    const interval = window.setInterval(() => {
      const cutoff = Date.now() - 1000;
      packetTimesRef.current = packetTimesRef.current.filter((value) => value >= cutoff);
      setPacketsPerSecond(packetTimesRef.current.length);
    }, 250);

    return () => {
      window.clearInterval(interval);
      unlistenPacket.then((fn) => fn());
      unlistenError.then((fn) => fn());
    };
  }, []);

  async function startListener() {
    setError(null);
    setStatus("starting");
    setPacketCount(0);
    setPacketsPerSecond(0);
    setLastPacket(null);
    packetTimesRef.current = [];

    try {
      await invoke("start_udp_listener", { port });
      setStatus("listening");
    } catch (reason) {
      setError(String(reason));
      setStatus("error");
    }
  }

  async function stopListener() {
    try {
      await invoke("stop_udp_listener");
    } finally {
      setStatus("idle");
      setPacketsPerSecond(0);
      packetTimesRef.current = [];
    }
  }

  const statusText = useMemo(() => {
    switch (status) {
      case "idle":
        return "STOPPED";
      case "starting":
        return "STARTING";
      case "listening":
        return "LISTENING";
      case "traffic":
        return "RECEIVING";
      case "error":
        return "ERROR";
    }
  }, [status]);

  const active = status === "starting" || status === "listening" || status === "traffic";

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">RACELAB / V0.1</p>
          <h1>Telemetry Link</h1>
          <p className="subtitle">Raw UDP capture first. Parser comes after we observe FH6's real packets.</p>
        </div>
        <div className={`status status-${status}`}>
          <span className="status-dot" />
          {statusText}
        </div>
      </header>

      <section className="controls panel">
        <label>
          <span>UDP port</span>
          <input
            type="number"
            min={1024}
            max={65535}
            value={port}
            disabled={active}
            onChange={(event) => setPort(Number(event.target.value))}
          />
        </label>
        {!active ? (
          <button className="primary" onClick={startListener} disabled={status === "starting"}>
            Start listener
          </button>
        ) : (
          <button className="danger" onClick={stopListener}>
            Stop listener
          </button>
        )}
      </section>

      {error && <section className="error-banner">{error}</section>}

      <section className="metrics">
        <article className="metric panel">
          <span>Packets</span>
          <strong>{packetCount.toLocaleString()}</strong>
        </article>
        <article className="metric panel">
          <span>Packets / sec</span>
          <strong>{packetsPerSecond}</strong>
        </article>
        <article className="metric panel">
          <span>Packet size</span>
          <strong>{lastPacket ? `${lastPacket.size} B` : "—"}</strong>
        </article>
        <article className="metric panel">
          <span>Source</span>
          <strong className="small-value">{lastPacket?.source ?? "—"}</strong>
        </article>
      </section>

      <section className="packet panel">
        <div className="section-heading">
          <div>
            <p className="eyebrow">LAST PACKET</p>
            <h2>Hex preview</h2>
          </div>
          <span>{lastPacket ? new Date(lastPacket.received_at_ms).toLocaleTimeString() : "No traffic yet"}</span>
        </div>
        <pre>{lastPacket?.preview_hex ?? "Start the listener, then run scripts/send-test-udp.ps1 while FH6 is downloading."}</pre>
      </section>

      <section className="next panel">
        <p className="eyebrow">SUCCESS CRITERION</p>
        <p>
          V0.1 is complete when this screen receives stable UDP traffic. We intentionally do not guess the FH6
          packet layout before capturing the real stream.
        </p>
      </section>
    </main>
  );
}
