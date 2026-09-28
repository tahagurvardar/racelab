import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import CapturePanel from "../CapturePanel";
import { TelemetrySection, ViewHeader } from "../components/TelemetrySection";
import type { StatsSnapshot } from "../telemetry-state.ts";
import type { RecorderStatus } from "../session-state.ts";
import type { LiveSnapshot } from "../telemetry/live-snapshot.ts";
import {
  fh6GearCode,
  fh6Powertrain,
  fh6Race,
  fh6TireTemperatures,
  fh6Vehicle,
  hubDiagnostics,
  protocolDiagnostics,
  transportDiagnostics,
  type DiagnosticEntry,
} from "../telemetry/diagnostics-view-model.ts";

function EntryTable({ entries }: { entries: DiagnosticEntry[] }) {
  return (
    <dl className="diagnostic-table">
      {entries.map((item) => (
        <div key={item.key}>
          <dt>{item.label}</dt>
          <dd>
            <span className="diagnostic-value">{item.value}</span>
            {item.caveat ? <em>{item.caveat}</em> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/// Engineering view. This is the only place adapter-owned and transport-level
/// data appears; no product dashboard view imports this module or reads
/// `sourceSpecific`.
export default function DiagnosticsView({
  live,
  stats,
  recorder,
  onStats,
}: {
  live: LiveSnapshot | null;
  stats: StatsSnapshot | null;
  recorder: RecorderStatus | null;
  onStats: (snapshot: StatsSnapshot) => void;
}) {
  const [port, setPort] = useState(20440);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const frame = live?.frame ?? null;
  const running = stats?.running ?? false;

  async function changeListener() {
    if (pending) return;
    if (!running && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      setError("Enter a UDP port between 1 and 65535.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      onStats(
        await invoke<StatsSnapshot>(
          running ? "stop_udp_listener" : "start_udp_listener",
          running ? {} : { port },
        ),
      );
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPending(false);
    }
  }

  const message = error ?? stats?.last_error ?? null;

  return (
    <>
      <ViewHeader
        title="Diagnostics"
        summary="Engineering data: protocol counters, transport statistics, raw adapter values and raw datagram capture. Nothing here is a validated product measurement."
      />
      {message ? (
        <p className="banner" role="alert">
          {message}
        </p>
      ) : null}

      <TelemetrySection
        eyebrow="DEVELOPER CONTROL"
        title="UDP listener"
        description="RaceLab binds port 20440 automatically at startup. These controls exist for troubleshooting only."
      >
        <div className="controls">
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
              disabled={running || pending}
              onChange={(event) => setPort(Number(event.target.value))}
            />
          </label>
          <button
            type="button"
            className={running ? "danger" : "primary"}
            onClick={() => void changeListener()}
            disabled={pending}
          >
            {running ? "Stop listener" : "Start listener"}
          </button>
        </div>
      </TelemetrySection>

      <TelemetrySection eyebrow="V0.5.1 · DETECTION" title="Protocol">
        <EntryTable entries={protocolDiagnostics(live)} />
        {live?.issues.length ? (
          <ul className="issue-list">
            {live.issues.map((issue, index) => (
              <li key={`${issue.field}-${index}`} role="alert">
                {issue.field} @{issue.offset}: {issue.reason}
              </li>
            ))}
          </ul>
        ) : null}
      </TelemetrySection>

      <TelemetrySection eyebrow="V0.5 · TELEMETRY HUB" title="Hub">
        <EntryTable entries={hubDiagnostics(live)} />
      </TelemetrySection>

      <TelemetrySection eyebrow="V0.2.2 · FROZEN INGRESS" title="Transport">
        <EntryTable entries={transportDiagnostics(stats)} />
        <p className="eyebrow">LAST PACKET · FIRST 32 BYTES</p>
        <pre>
          {stats?.last_packet_size != null
            ? stats.preview_hex || "Empty datagram (0 bytes)"
            : "Waiting for game traffic on UDP port 20440."}
        </pre>
      </TelemetrySection>

      <TelemetrySection
        eyebrow="SOURCE-SPECIFIC · FH6"
        title="Raw adapter values"
        description="The exact values the FH6 adapter read off the wire, in packet order. Some now also have a canonical form in the product views; keeping the wire reading here is what makes a suspected decode or corner error debuggable. Fields with no canonical form are unestablished, not merely unimplemented."
      >
        <p className="section-subtitle">Gear</p>
        <EntryTable entries={[fh6GearCode(frame)]} />
        <p className="section-subtitle">Powertrain</p>
        <EntryTable entries={fh6Powertrain(frame)} />
        <p className="section-subtitle">
          Per-wheel channels · ordered by packet offset, not by corner
        </p>
        <EntryTable entries={fh6TireTemperatures(frame)} />
        <p className="section-subtitle">Race</p>
        <EntryTable entries={fh6Race(frame)} />
        <p className="section-subtitle">Vehicle configuration codes</p>
        <EntryTable entries={fh6Vehicle(frame)} />
      </TelemetrySection>

      <TelemetrySection
        eyebrow="V0.6 · RECORDER"
        title="Recorder queue"
        description="Writer-queue health. Session contents live in the Sessions view."
      >
        <EntryTable
          entries={[
            {
              key: "status",
              label: "Status",
              value: recorder?.status ?? "—",
            },
            {
              key: "queue",
              label: "Queued frames",
              value: `${(recorder?.queued_frames ?? 0).toLocaleString()} / ${(
                recorder?.queue_capacity ?? 0
              ).toLocaleString()}`,
            },
            {
              key: "session-drops",
              label: "Current session drops",
              value: (recorder?.recorder_dropped_frames ?? 0).toLocaleString(),
            },
            {
              key: "lifetime-drops",
              label: "Lifetime drops",
              value: (recorder?.lifetime_dropped_frames ?? 0).toLocaleString(),
              caveat:
                "Process-lifetime diagnostic; never drives a loss warning.",
            },
            {
              key: "active",
              label: "Active frames",
              value: (recorder?.active_frames ?? 0).toLocaleString(),
            },
            {
              key: "inactive",
              label: "Inactive frames",
              value: (recorder?.inactive_frames ?? 0).toLocaleString(),
            },
          ]}
        />
      </TelemetrySection>

      <TelemetrySection
        eyebrow="V0.3 · EXACT RAW DATAGRAMS"
        title="Raw capture"
        description="Raw capture preserves every datagram independently of FH6 validation and of session recording."
      >
        <CapturePanel listenerRunning={running} />
      </TelemetrySection>
    </>
  );
}
