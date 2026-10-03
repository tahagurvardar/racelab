import { WorkspaceHeader } from "../components/shell/WorkspaceHeader";
import { StatusIndicator } from "../components/StatusIndicator";
import { activeGameStore } from "../state/active-game.ts";
import {
  f1LiveStore,
  liveStore,
  setupStore,
  transportStore,
  recorderStore,
  f1RecorderStore,
} from "../state/stores.ts";
import { useDerived } from "../state/use-store.ts";
import { liveWaitingModel } from "../telemetry/live-waiting.ts";
import { shellStatus } from "../telemetry/shell-view-model.ts";
import { clockTime } from "../session-state.ts";
import type { SectionId } from "../views/navigation.ts";

const STORES = [
  liveStore,
  setupStore,
  transportStore,
  f1LiveStore,
  recorderStore,
  f1RecorderStore,
  activeGameStore,
];

export default function HomeWorkspace({
  onNavigate,
}: {
  onNavigate: (section: SectionId) => void;
}) {
  const model = useDerived(STORES, () => {
    const live = liveStore.get();
    const setup = setupStore.get();
    const transport = transportStore.get();
    const f1Live = f1LiveStore.get();
    const activeGame = activeGameStore.get();
    const shell = shellStatus({
      live,
      setup,
      transport,
      f1Live,
      activeGame,
      recorder: recorderStore.get(),
      f1Recorder: f1RecorderStore.get(),
    });
    const waiting = liveWaitingModel({ live, setup, transport, f1Live });
    return {
      state: shell.state,
      recording: shell.recording.active
        ? shell.recording.label
        : shell.recording.value,
      firstConnected: setup.setup?.fh6_first_detected_unix_ms ?? null,
      firstRun: setup.setup?.first_run ?? true,
      games: waiting.games.map((game) => ({
        ...game,
        active: activeGame.game === game.key,
        status:
          activeGame.game === game.key
            ? shell.state.title
            : game.key === "fh6" && setup.setup?.first_run
              ? "Setup needed"
              : game.status,
        tone: activeGame.game === game.key ? shell.state.tone : game.tone,
      })),
    };
  });
  return (
    <div className="home-workspace" data-density="comfort">
      <WorkspaceHeader title="Home" />
      <header className="home-intro">
        <p className="eyebrow">Telemetry workspace</p>
        <h2>Welcome to RaceLab</h2>
        <p>
          Connect a supported game to read live telemetry and review recorded
          sessions.
        </p>
      </header>
      <section className="home-sources" aria-labelledby="home-sources-title">
        <h2 id="home-sources-title" className="live-section-title">
          Game sources
        </h2>
        <div className="source-heading" aria-hidden="true">
          <span>Source</span>
          <span>Connection</span>
          <span>Setup</span>
        </div>
        {model.games.map((game) => (
          <div className="source-row" key={game.key} data-game={game.key}>
            <div className="source-name">
              <h3>{game.name}</h3>
              <p>
                {game.key === "fh6"
                  ? "Live · automatic recording · analysis"
                  : "Live · automatic recording"}
              </p>
            </div>
            <div>
              <StatusIndicator tone={game.tone}>{game.status}</StatusIndicator>
              <p className="source-target mono">{game.target}</p>
            </div>
            <button
              className="button"
              type="button"
              onClick={() => onNavigate(game.active ? "live" : "settings")}
            >
              {game.active ? "Open Live" : "Source settings"}
            </button>
          </div>
        ))}
      </section>
      <section className="home-health" aria-label="Setup health">
        <StatusIndicator tone={model.state.tone}>
          {model.state.title}
        </StatusIndicator>
        <span>{model.recording}</span>
        <button
          className="button"
          type="button"
          onClick={() => onNavigate("diagnostics")}
        >
          Open Diagnostics
        </button>
      </section>
      <p className="home-note">
        {model.firstConnected
          ? `Forza Horizon 6 first connected ${clockTime(model.firstConnected)}.`
          : "RaceLab detects a game when its telemetry arrives."}{" "}
        Recordings stay on this computer.
      </p>
    </div>
  );
}
