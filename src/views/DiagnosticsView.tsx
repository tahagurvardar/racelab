import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import CapturePanel from "../CapturePanel";
import { useF1 } from "../hooks/use-f1-evidence.ts";
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
import {
  f1Connection,
  f1CounterEntries,
  f1HeaderEntries,
  f1KindRows,
} from "../telemetry/f1-evidence.ts";
import {
  playerAvailability,
  playerSections,
  type CaptureManifest,
  type CaptureStatus,
  type F1LiveSnapshot,
} from "../telemetry/f1-player.ts";

export type DiagnosticsTab =
  | "connection"
  | "pipeline"
  | "adapter"
  | "capture"
  | "f1";

export const DIAGNOSTICS_TABS: { id: DiagnosticsTab; label: string }[] = [
  { id: "connection", label: "Connection" },
  { id: "pipeline", label: "Pipeline" },
  { id: "adapter", label: "Adapter" },
  { id: "capture", label: "Capture" },
];

/// Shown only when the backend reports the F1 25 evidence listener enabled
/// (a development build, or `RACELAB_F1_EVIDENCE=1`).
export const F1_EVIDENCE_TAB: { id: DiagnosticsTab; label: string } = {
  id: "f1",
  label: "F1 25",
};

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

// ---------------------------------------------------------------------- f1

/// V2.0 Phase A: what the F1 25 listener has seen, from headers and sizes
/// alone. Read at 1 Hz by the shell's `useF1Evidence`; no events, no packet
/// stream, no payload bytes.
/// Phase B: one table per decoded section, values exactly as decoded, each
/// with the packet it came from and how old that packet is.
function F1PlayerSections({ live }: { live: F1LiveSnapshot }) {
  const unavailable = playerAvailability(live);
  return (
    <section className="diag-group" aria-labelledby="diag-f1-player">
      <h2 className="diag-group-title" id="diag-f1-player">
        Player car · decoded
      </h2>
      <p className="diag-note" data-entry="f1-player-key">
        playerCarIndex {code(live.player_car_index)} · out-of-order dropped{" "}
        {integer(live.out_of_order_dropped)} · session resets{" "}
        {integer(live.session_resets)} · player resets{" "}
        {integer(live.player_resets)}
      </p>
      {unavailable ? (
        <p className="diag-status" data-entry="f1-player-unavailable">
          {unavailable}
        </p>
      ) : null}
      <div className="diag-columns">
        {playerSections(live).map((section) => (
          <div
            className="diag-column"
            key={section.key}
            data-section={section.key}
          >
            {section.entries ? (
              <EntryTable
                title={section.title}
                entries={section.entries}
                note={section.source}
              />
            ) : (
              <section className="diag-group" aria-label={section.title}>
                <h2 className="diag-group-title">{section.title}</h2>
                <p className="diag-note">{section.source} · no player values</p>
              </section>
            )}
            {section.wheels.length > 0 ? (
              <div className="table-scroll">
                <table className="diag-table diag-matrix">
                  <caption className="visually-hidden">
                    {section.title} by wheel
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Channel</th>
                      <th scope="col" className="numeric">
                        FL
                      </th>
                      <th scope="col" className="numeric">
                        FR
                      </th>
                      <th scope="col" className="numeric">
                        RL
                      </th>
                      <th scope="col" className="numeric">
                        RR
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {section.wheels.map((row) => (
                      <tr key={row.key} data-entry={"f1-wheels-" + row.key}>
                        <th scope="row">{row.label}</th>
                        <td className="diag-value numeric">{row.values.fl}</td>
                        <td className="diag-value numeric">{row.values.fr}</td>
                        <td className="diag-value numeric">{row.values.rl}</td>
                        <td className="diag-value numeric">{row.values.rr}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      <p className="diag-note">
        Values are the decoded wire values in the F1 25 specification&rsquo;s
        units; a unit is shown only where the specification states one. Each
        table comes from its own packet and frame: they are not one moment.
      </p>
    </section>
  );
}

const CAPTURE_LABELS = ["stationary", "driving", "braking", "high-speed"];
const CAPTURE_DELAYS = [0, 5000, 10000];

/// Development only, present only with `RACELAB_F1_CAPTURE=1`. Writes one
/// bounded snapshot of the four decoded packets; shows the manifest, never
/// the bytes.
function F1CapturePanel({ capture }: { capture: CaptureStatus }) {
  const [label, setLabel] = useState(CAPTURE_LABELS[0]);
  const [delay, setDelay] = useState(0);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function take() {
    if (pending) return;
    setPending(true);
    setError(null);
    setResult(null);
    try {
      const manifest = await invoke<CaptureManifest>("capture_f1_fixtures", {
        label,
        delayMs: delay,
      });
      setResult(manifest.directory);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPending(false);
    }
  }
  const problem = error ?? capture.last_error;
  return (
    <section className="diag-group" aria-labelledby="diag-f1-capture">
      <h2 className="diag-group-title" id="diag-f1-capture">
        Fixture capture · development only
      </h2>
      <div className="controls">
        <label>
          <span>Label</span>
          <select
            value={label}
            disabled={pending}
            onChange={(event) => setLabel(event.target.value)}
          >
            {CAPTURE_LABELS.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Delay</span>
          <select
            value={delay}
            disabled={pending}
            onChange={(event) => setDelay(Number(event.target.value))}
          >
            {CAPTURE_DELAYS.map((item) => (
              <option key={item} value={item}>
                {item === 0 ? "now" : String(item / 1000) + " s"}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="primary"
          onClick={() => void take()}
          aria-disabled={pending}
        >
          {pending ? "Capturing…" : "Capture snapshot"}
        </button>
      </div>
      <p className="diag-note" data-entry="f1-capture-count">
        {capture.snapshots_taken} of {capture.max_snapshots} snapshots this run,
        into {capture.directory}
      </p>
      {result ? (
        <p className="diag-status" data-entry="f1-capture-result">
          Written to {result}
        </p>
      ) : null}
      {problem ? (
        <Notice tone="bad" title="Capture refused" technical={problem}>
          Nothing was written.
        </Notice>
      ) : null}
    </section>
  );
}

function F1Tab() {
  const status = useF1((state) => state.status);
  const error = useF1((state) => state.error);
  const connection = f1Connection(status);
  const problem = error ?? status?.listener_error ?? null;
  const glyph =
    connection.tone === "good" ? "●" : connection.tone === "bad" ? "✕" : "○";
  return (
    <div className="diag-stack">
      <p className="diag-intro">
        F1 25 evidence: header checks, packet counts and the player car&rsquo;s
        decoded values. Live shows the current player telemetry; recording
        status is shown in the status bar and recorded sessions in Sessions.
      </p>
      <p className="diag-status" data-entry="f1-connection">
        <span
          className={`state-glyph tone-${connection.tone}`}
          aria-hidden="true"
        >
          {glyph}
        </span>
        {connection.text}
      </p>
      {problem ? (
        <Notice tone="bad" title="F1 25 listener problem" technical={problem}>
          The F1 25 evidence listener is not receiving.
        </Notice>
      ) : null}
      {status ? (
        <>
          <div className="diag-columns">
            <div className="diag-column">
              <EntryTable
                title="Latest accepted header"
                entries={f1HeaderEntries(status.evidence.header)}
              />
            </div>
            <div className="diag-column">
              <EntryTable title="Counters" entries={f1CounterEntries(status)} />
            </div>
          </div>
          <section className="diag-group" aria-labelledby="diag-f1-kinds">
            <h2 className="diag-group-title" id="diag-f1-kinds">
              Packet types
            </h2>
            <div className="table-scroll">
              <table className="diag-table diag-matrix">
                <caption className="visually-hidden">
                  F1 25 packet types by ID: expected and observed size, rate
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className="numeric">
                      ID
                    </th>
                    <th scope="col">Packet</th>
                    <th scope="col" className="numeric">
                      Expected
                    </th>
                    <th scope="col" className="numeric">
                      Observed
                    </th>
                    <th scope="col">Size source</th>
                    <th scope="col" className="numeric">
                      Rate
                    </th>
                    <th scope="col" className="numeric">
                      Accepted
                    </th>
                    <th scope="col" className="numeric">
                      Rejected
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {f1KindRows(status.evidence).map((row) => (
                    <tr key={row.id} data-entry={`f1-kind-${row.id}`}>
                      <td className="diag-value numeric">{row.id}</td>
                      <th scope="row">{row.name}</th>
                      <td className="diag-value numeric">{row.expected}</td>
                      <td
                        className={`diag-value numeric${row.size === "mismatch" ? " tone-bad" : ""}`}
                        data-size={row.size}
                      >
                        {row.observed}
                      </td>
                      <td>{row.evidence}</td>
                      <td className="diag-value numeric">{row.rate}</td>
                      <td className="diag-value numeric">{row.accepted}</td>
                      <td className="diag-value numeric">{row.rejected}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="diag-note">
              Rate is accepted packets over the last one-second window.
              &ldquo;Spec&rdquo; sizes come from the F1 25 specification and
              have not yet been seen from the installed game.
            </p>
          </section>
          <F1PlayerSections live={status.live} />
          {status.capture ? <F1CapturePanel capture={status.capture} /> : null}
        </>
      ) : null}
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
    case "f1":
      return <F1Tab />;
    default:
      return <ConnectionTab />;
  }
}
