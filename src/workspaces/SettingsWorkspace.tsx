import { useId, useState, type ReactNode } from "react";
import { useF1Live } from "../hooks/use-f1-live.ts";
import { useSetup } from "../hooks/use-setup-state.ts";
import { useActiveGame } from "../state/active-game.ts";
import { AppMark, VersionLabel, Wordmark } from "../components/brand/Brand";
import { WorkspaceHeader } from "../components/shell/WorkspaceHeader";
import { DetectionLine, SetupSteps } from "../components/SetupInstructions";
import { StorageBudget } from "../components/StorageBudget";
import { OverlaySettings } from "../components/OverlaySettings";
import { clockTime } from "../session-state.ts";
import type { SetupState } from "../telemetry/setup-view-model.ts";

/// One preferences group: a title and a sentence on the left, the controls
/// on the right; stacked on a narrow window.
function SettingsGroup({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-group" aria-labelledby={`${id}-title`}>
      <header className="settings-group-header">
        <h2 id={`${id}-title`}>{title}</h2>
        <p>{description}</p>
      </header>
      <div className="settings-group-body">{children}</div>
    </section>
  );
}

/// The Forza Horizon 6 group: whether the game has been detected, the address
/// to send to, and the full setup steps on request — the way back to them
/// once first-run guidance has gone for good.
function GameSetup({ setup }: { setup: SetupState }) {
  const [open, setOpen] = useState(false);
  const stepsId = useId();
  if (setup.first_run) {
    return (
      <p className="settings-status tone-neutral">
        <span className="state-glyph" aria-hidden="true">
          ○
        </span>
        Not set up yet. The setup steps are shown at the top of the window until
        RaceLab receives telemetry from the game.
      </p>
    );
  }
  return (
    <>
      <p className="settings-status tone-good">
        <span className="state-glyph" aria-hidden="true">
          ●
        </span>
        Set up
        {setup.fh6_first_detected_unix_ms != null
          ? ` · first connected ${clockTime(setup.fh6_first_detected_unix_ms)}`
          : ""}
      </p>
      <dl className="settings-facts">
        <div>
          <dt>Data Out IP Address</dt>
          <dd>{setup.listen_host}</dd>
        </div>
        <div>
          <dt>Data Out IP Port</dt>
          <dd>{setup.listen_port}</dd>
        </div>
      </dl>
      <button
        type="button"
        className="ghost"
        aria-expanded={open}
        aria-controls={stepsId}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Hide setup steps" : "Show setup steps"}
      </button>
      <div id={stepsId} className="settings-setup" hidden={!open}>
        {/* Mounted only while open: the detection line is the one part of
            Settings that follows live telemetry. */}
        {open ? (
          <>
            <SetupSteps setup={setup} />
            <DetectionLine setup={setup} />
          </>
        ) : null}
      </div>
    </>
  );
}

/// The F1 25 group: whether RaceLab is receiving it, and the values F1 25's
/// own telemetry settings need. The menu labels are quoted exactly as the
/// game names them (`data-game-menu`), including its own word "UDP"; RaceLab's
/// words around them stay plain. Reads coarse facts only — never the live
/// values — so Settings does not re-render at the telemetry rate.
function F1Setup() {
  const available = useF1Live((state) => state.available);
  const listening = useF1Live((state) => state.status?.listening ?? null);
  const port = useF1Live(
    (state) =>
      state.status?.bound_port ?? state.status?.configured_port ?? null,
  );
  const listenerError = useF1Live(
    (state) => state.status?.listener_error ?? null,
  );
  const activity = useActiveGame((state) => state.f1_25);
  if (available === false) {
    return (
      <p className="settings-status tone-neutral">
        <span className="state-glyph" aria-hidden="true">
          ○
        </span>
        F1 25 support is not enabled in this build.
      </p>
    );
  }
  const receiving = activity === "active" || activity === "detected";
  const status =
    available == null || listening == null
      ? { tone: "neutral", glyph: "○", text: "Starting…" }
      : !listening
        ? {
            tone: "bad",
            glyph: "✕",
            text: `Not listening${listenerError ? `: ${listenerError}` : ""}`,
          }
        : receiving
          ? { tone: "good", glyph: "●", text: "Receiving F1 25 telemetry" }
          : {
              tone: "neutral",
              glyph: "○",
              text: "Listening · nothing arriving yet",
            };
  const rows: [string, string][] = [
    ["UDP Telemetry", "On"],
    ["UDP Broadcast Mode", "Off"],
    ["UDP IP Address", "127.0.0.1"],
    ["UDP Port", port == null ? "—" : String(port)],
    ["UDP Send Rate", "20Hz"],
    ["UDP Format", "2025"],
  ];
  return (
    <>
      <p className={`settings-status tone-${status.tone}`} role="status">
        <span className="state-glyph" aria-hidden="true">
          {status.glyph}
        </span>
        {status.text}
      </p>
      <p className="settings-note">
        In F1 25, open{" "}
        <span data-game-menu="">
          Game Options › Settings › UDP Telemetry Settings
        </span>{" "}
        and set:
      </p>
      <dl className="settings-facts f1-settings-facts">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt data-game-menu="">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="settings-note">
        RaceLab switches to F1 25 on its own when it starts sending. Live shows
        F1 25 telemetry, and each F1 25 session is recorded on its own and
        listed in Sessions. The send rate is the one RaceLab was checked with.
      </p>
    </>
  );
}

/// Settings: the storage limit (the only configurable product setting), each
/// supported game's setup, and the version. Reads no live telemetry
/// except the setup detection line while the steps are open.
export default function SettingsWorkspace() {
  const setup = useSetup((state) => state.setup);
  const setupError = useSetup((state) => state.error);
  return (
    <div className="settings-workspace">
      <WorkspaceHeader title="Settings" />

      <nav className="settings-index" aria-label="Settings groups">
        <a href="#settings-application-title">Application</a>
        <a href="#settings-storage-title">Recording & Storage</a>
        <a href="#settings-overlay-title">Overlay</a>
        <a href="#settings-game-title">Game Sources</a>
        <a href="#settings-privacy-title">Data & Privacy</a>
        <a href="#settings-appearance-title">Appearance & Accessibility</a>
        <a href="#settings-about-title">About</a>
      </nav>

      <SettingsGroup
        id="settings-application"
        title="Application"
        description="RaceLab listens for supported telemetry sources when it starts."
      >
        <p className="settings-explain">
          Live follows the active game automatically. Forza Horizon 6 sessions
          record when driving begins and finish when the session ends.
        </p>
      </SettingsGroup>

      <SettingsGroup
        id="settings-storage"
        title="Storage"
        description="Recordings are kept on this computer. When they reach the limit, RaceLab deletes the oldest finished sessions first."
      >
        <StorageBudget />
      </SettingsGroup>

      <SettingsGroup
        id="settings-game"
        title="Forza Horizon 6"
        description="The one change RaceLab needs inside the game: turning on Data Out. It is made once."
      >
        {setup ? (
          <GameSetup setup={setup} />
        ) : (
          <p className="settings-loading" role="status">
            {setupError
              ? "The address RaceLab listens on could not be read yet."
              : "Reading the address RaceLab listens on…"}
          </p>
        )}
      </SettingsGroup>

      <SettingsGroup
        id="settings-f1"
        title="F1 25"
        description="F1 25 sends telemetry once its telemetry output is on, set to the address and port below."
      >
        <F1Setup />
      </SettingsGroup>

      <SettingsGroup
        id="settings-overlay"
        title="Overlay"
        description="A compact second screen over F1 25, controlled here."
      >
        <OverlaySettings />
      </SettingsGroup>

      <SettingsGroup
        id="settings-privacy"
        title="Data & Privacy"
        description="Your recordings and analysis stay on this computer."
      >
        <p className="settings-explain">
          Telemetry is received locally. RaceLab requires no account or cloud
          service. Storage retention follows the limit selected above.
        </p>
      </SettingsGroup>

      <SettingsGroup
        id="settings-appearance"
        title="Appearance & Accessibility"
        description="A consistent engineering workspace across every game source."
      >
        <p className="settings-explain">
          Dark appearance · Geist Sans and Geist Mono · tabular telemetry
          numerals. RaceLab follows the system preference for reduced motion.
        </p>
        <p className="settings-note">
          Keyboard: Ctrl+1 Live · Ctrl+2 Sessions · Ctrl+3 Settings · Ctrl+4
          Diagnostics · Ctrl+5 Home. In Live, 1–4 selects a tab.
        </p>
      </SettingsGroup>

      <SettingsGroup
        id="settings-about"
        title="About"
        description="Telemetry for Forza Horizon 6 and F1 25. Forza Horizon 6 drives are recorded and analyzed."
      >
        <div className="about-brand">
          <AppMark size={40} />
          <div>
            <p className="about-wordmark">
              <Wordmark />
            </p>
            <p className="settings-note">
              <VersionLabel />
            </p>
          </div>
        </div>
      </SettingsGroup>
    </div>
  );
}
