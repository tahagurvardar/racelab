import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import CapturePanel from "../CapturePanel";
import { useLive } from "../hooks/use-live-telemetry.ts";
import { useRecorder } from "../hooks/use-recorder-status.ts";
import { useSetup } from "../hooks/use-setup-state.ts";
import { useTransport } from "../hooks/use-transport-stats.ts";
import { APP_VERSION } from "../app-version.ts";
import { Notice } from "../components/shell/Notice";
import { applyTransportSnapshot } from "../state/stores.ts";
import type { StatsSnapshot } from "../telemetry-state.ts";
import { code, integer, text } from "../telemetry/formatting.ts";
import {
  deferredFields,
  fh6GearCode,
  fh6Powertrain,
  fh6Race,
  fh6TireTemperatures,
  fh6Vehicle,
  hubDiagnostics,
  protocolDiagnostics,
  recorderState,
  transportDiagnostics,
  type DiagnosticEntry,
} from "../telemetry/diagnostics-view-model.ts";

export type DiagnosticsTab = "connection" | "pipeline" | "adapter" | "capture";

export const DIAGNOSTICS_TABS: { id: DiagnosticsTab; label: string }[] = [
  { id: "connection", label: "Connection" },
  { id: "pipeline", label: "Pipeline" },
  { id: "adapter", label: "Adapter" },
  { id: "capture", label: "Capture" },
];

/// A labelled group of readings as a table: the reading, then its value with
/// any caveat that qualifies it directly beneath. A caveat shared by every
/// row is stated once below the table instead.
function EntryTable({
  title,
  entries,
  note,
}: {
  title: string;
  entries: DiagnosticEntry[];
  note?: string;
}) {
  const caveats = new Set(entries.map((item) => item.caveat ?? ""));
  const shared =
    caveats.size === 1 && entries[0]?.caveat ? entries[0].caveat : null;
  return (
    <section className="diag-group" aria-label={title}>
      <h2 className="diag-group-title">{title}</h2>
      <table className="diag-table">
        <caption className="visually-hidden">{title}</caption>
        <thead className="visually-hidden">
          <tr>
            <th scope="col">Reading</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((item) => (
            <tr key={item.key} data-entry={item.key}>
              <th scope="row">{item.label}</th>
              <td>
                {item.code === undefined ? (
                  <span className="diag-value">{item.value}</span>
                ) : (
                  // A state or identifier: its name, then the verbatim code.
                  <span className="diag-name">
                    {item.value}
                    {item.code ? (
                      <code className="diag-code">{item.code}</code>
                    ) : null}
                  </span>
                )}
                {item.caveat && shared == null ? (
                  <span className="diag-caveat">{item.caveat}</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {shared || note ? (
        <p className="diag-note">{[shared, note].filter(Boolean).join(" ")}</p>
      ) : null}
    </section>
  );
}

// -------------------------------------------------------------- connection

/// The listener control. RaceLab binds its port at startup; this exists for
/// troubleshooting. The port field starts at the port actually bound (or the
/// configured one), never at a constant.
function ListenerControl() {
  const stats = useTransport((state) => state.stats);
  const configured = useSetup((state) => state.setup?.listen_port ?? null);
  const [port, setPort] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = stats?.running ?? false;
  const value = port ?? stats?.bound_port ?? configured ?? 20440;

  async function change() {
    if (pending) return;
    if (!running && (!Number.isInteger(value) || value < 1 || value > 65535)) {
      setError("Enter a port between 1 and 65535.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      applyTransportSnapshot(
        await invoke<StatsSnapshot>(
          running ? "stop_udp_listener" : "start_udp_listener",
          running ? {} : { port: value },
        ),
      );
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPending(false);
    }
  }

  const problem = error ?? stats?.last_error ?? null;
  return (
    <section className="diag-group" aria-labelledby="diag-listener">
      <h2 className="diag-group-title" id="diag-listener">
        UDP listener
      </h2>
      <p className="diag-status">
        <span
          className={`state-glyph tone-${running ? "good" : "bad"}`}
          aria-hidden="true"
        >
          {running ? "●" : "✕"}
        </span>
        {running
          ? `Listening on port ${code(stats?.bound_port)}`
          : "Stopped — no telemetry can arrive"}
      </p>
      <div className="controls">
        <label>
          <span>UDP port</span>
          <input
            type="number"
            min={1}
            max={65535}
            value={value}
            disabled={running || pending}
            onChange={(event) => setPort(Number(event.target.value))}
          />
        </label>
        <button
          type="button"
          className={running ? "danger" : "primary"}
          onClick={() => void change()}
          // Not `disabled`, which would drop keyboard focus to the page
          // mid-change; `change` ignores presses while one is pending.
          aria-disabled={pending}
        >
          {running ? "Stop listener" : "Start listener"}
        </button>
      </div>
      <p className="diag-note">
        RaceLab opens this port automatically when it starts. Stopping it stops
        all telemetry, including recording.
      </p>
      {problem ? (
        <Notice tone="bad" title="Listener problem" technical={problem}>
          The last listener change did not succeed.
        </Notice>
      ) : null}
    </section>
  );
}

function ConnectionTab() {
  const live = useLive((state) => state.snapshot);
  const stats = useTransport((state) => state.stats);
  const issues = live?.issues ?? [];
  return (
    <div className="diag-columns">
      <div className="diag-column">
        <ListenerControl />
        <EntryTable title="Protocol" entries={protocolDiagnostics(live)} />
        <section className="diag-group" aria-labelledby="diag-issues">
          <h2 className="diag-group-title" id="diag-issues">
            Validation issues in the latest packet ({issues.length})
          </h2>
          {issues.length > 0 ? (
            <ul className="issue-list">
              {issues.map((issue, index) => (
                <li key={`${issue.field}-${index}`} className="mono">
                  {issue.field} @{issue.offset}: {issue.reason}
                </li>
              ))}
            </ul>
          ) : (
            <p className="diag-note">None.</p>
          )}
        </section>
      </div>
      <div className="diag-column">
        <EntryTable title="Transport" entries={transportDiagnostics(stats)} />
        <section className="diag-group" aria-labelledby="diag-hex">
          <h2 className="diag-group-title" id="diag-hex">
            Last packet · first 32 bytes
          </h2>
          <pre>
            {stats?.last_packet_size != null
              ? stats.preview_hex || "Empty datagram (0 bytes)"
              : `Waiting for traffic on port ${code(stats?.bound_port)}.`}
          </pre>
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- pipeline

function PipelineTab() {
  const live = useLive((state) => state.snapshot);
  const recorder = useRecorder((state) => state.recorder);
  const recorderError = useRecorder((state) => state.error);
  const setup = useSetup((state) => state.setup);
  return (
    <div className="diag-columns">
      <div className="diag-column">
        <EntryTable title="Telemetry hub" entries={hubDiagnostics(live)} />
        <EntryTable
          title="This installation"
          entries={[
            { key: "version", label: "RaceLab version", value: APP_VERSION },
            {
              key: "listen",
              label: "Listening address",
              value: setup ? `${setup.listen_host}:${setup.listen_port}` : "—",
            },
            {
              key: "sessions-dir",
              label: "Sessions folder",
              value: text(recorder?.sessions_directory),
            },
          ]}
        />
      </div>
      <div className="diag-column">
        <EntryTable
          title="Recorder"
          entries={[
            recorderState(recorder?.status),
            {
              key: "session",
              label: "Session ID",
              value: text(recorder?.session_id),
            },
            {
              key: "queue",
              label: "Queued frames",
              value: recorder
                ? `${integer(recorder.queued_frames)} / ${integer(recorder.queue_capacity)}`
                : "—",
            },
            {
              key: "written",
              label: "Frames written",
              value: integer(recorder?.frames_written),
            },
            {
              key: "session-drops",
              label: "Current session drops",
              value: integer(recorder?.recorder_dropped_frames),
            },
            {
              key: "lifetime-drops",
              label: "Lifetime drops",
              value: integer(recorder?.lifetime_dropped_frames),
              caveat:
                "Process-lifetime diagnostic; never drives a loss warning.",
            },
            {
              key: "active",
              label: "Active frames",
              value: integer(recorder?.active_frames),
            },
            {
              key: "inactive",
              label: "Inactive frames",
              value: integer(recorder?.inactive_frames),
            },
            {
              key: "last-error",
              label: "Last recorder error",
              value: text(recorder?.last_error),
              caveat:
                recorder?.last_error && recorder.status !== "error"
                  ? "Historical: the recorder has recovered since."
                  : undefined,
            },
          ]}
        />
        {recorderError ? (
          <Notice
            tone="bad"
            title="Recorder status could not be read"
            technical={recorderError}
          />
        ) : null}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- adapter

/// The per-wheel channels as a channel × source-index matrix: exactly the
/// adapter's wire order (0–3), never relabelled as corners here.
function WireWheelTable({ entries }: { entries: DiagnosticEntry[] }) {
  const rows = new Map<string, DiagnosticEntry[]>();
  for (const item of entries) {
    const channel = item.label.replace(/ \d$/, "");
    rows.set(channel, [...(rows.get(channel) ?? []), item]);
  }
  return (
    <section className="diag-group" aria-labelledby="diag-wheels">
      <h2 className="diag-group-title" id="diag-wheels">
        Per-wheel channels · packet order
      </h2>
      <div className="table-scroll">
        <table className="diag-table diag-matrix">
          <caption className="visually-hidden">
            Per-wheel adapter values by packet index, not by corner
          </caption>
          <thead>
            <tr>
              <th scope="col">Channel</th>
              {[0, 1, 2, 3].map((index) => (
                <th key={index} scope="col" className="numeric">
                  Index {index}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...rows].map(([channel, values]) => (
              <tr key={channel}>
                <th scope="row">{channel}</th>
                {values.map((item) => (
                  <td
                    key={item.key}
                    className="diag-value numeric"
                    data-entry={item.key}
                  >
                    {item.value}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="diag-note">{entries[0]?.caveat}</p>
    </section>
  );
}

function AdapterTab() {
  const frame = useLive((state) => state.snapshot?.frame ?? null);
  return (
    <div className="diag-stack">
      <p className="diag-intro">
        Values exactly as the Forza Horizon 6 adapter read them from the packet.
        A unit or meaning is stated only where it has been established;
        everything else is a raw number or an opaque code.
      </p>
      <div className="diag-columns">
        <div className="diag-column">
          <EntryTable title="Gear" entries={[fh6GearCode(frame)]} />
          <EntryTable title="Powertrain" entries={fh6Powertrain(frame)} />
          <EntryTable title="Race" entries={fh6Race(frame)} />
        </div>
        <div className="diag-column">
          <EntryTable
            title="Vehicle configuration codes"
            entries={fh6Vehicle(frame)}
          />
          <EntryTable
            title="Not shown in Live"
            entries={deferredFields()}
            note="These stay out of the product until their meaning is established."
          />
        </div>
      </div>
      <WireWheelTable entries={fh6TireTemperatures(frame)} />
    </div>
  );
}

// ----------------------------------------------------------------- capture

function CaptureTab() {
  const running = useTransport((state) => state.stats?.running ?? false);
  return <CapturePanel listenerRunning={running} />;
}

/// Engineering view: the only place adapter-owned and transport-level data
/// appears. No product view imports the diagnostics view model or reads
/// `sourceSpecific`. Each tab subscribes to exactly what it shows, and only
/// the open tab is mounted.
export default function DiagnosticsView({ tab }: { tab: DiagnosticsTab }) {
  switch (tab) {
    case "pipeline":
      return <PipelineTab />;
    case "adapter":
      return <AdapterTab />;
    case "capture":
      return <CaptureTab />;
    default:
      return <ConnectionTab />;
  }
}
