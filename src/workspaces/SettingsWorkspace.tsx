import { useId, useState, type ReactNode } from "react";
import { useSetup } from "../hooks/use-setup-state.ts";
import { AppMark, VersionLabel, Wordmark } from "../components/brand/Brand";
import { WorkspaceHeader } from "../components/shell/WorkspaceHeader";
import { DetectionLine, SetupSteps } from "../components/SetupInstructions";
import { StorageBudget } from "../components/StorageBudget";
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

/// Settings: the storage limit (the only configurable product setting), the
/// Forza Horizon 6 setup steps, and the version. Reads no live telemetry
/// except the setup detection line while the steps are open.
export default function SettingsWorkspace() {
  const setup = useSetup((state) => state.setup);
  const setupError = useSetup((state) => state.error);
  return (
    <div className="settings-workspace">
      <WorkspaceHeader title="Settings" />

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
        id="settings-about"
        title="About"
        description="Forza Horizon 6 telemetry recorder and analyzer."
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
