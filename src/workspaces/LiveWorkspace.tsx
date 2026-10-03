import { useActiveGame } from "../state/active-game.ts";
import {
  f1LiveStore,
  liveStore,
  setupStore,
  transportStore,
} from "../state/stores.ts";
import { useDerived } from "../state/use-store.ts";
import { WorkspaceHeader } from "../components/shell/WorkspaceHeader";
import { liveWaitingModel } from "../telemetry/live-waiting.ts";
import type { F1TabId, LiveTabId } from "../views/navigation.ts";
import F1LiveWorkspace from "./F1LiveWorkspace";
import Fh6LiveWorkspace from "./Fh6LiveWorkspace";

const WAITING_STORES = [liveStore, transportStore, setupStore, f1LiveStore];

const GLYPHS = { good: "●", neutral: "○", bad: "✕" } as const;

/// No supported game is active. One product-level message and each game's
/// listening state, re-rendered only when that text changes — never at the
/// telemetry rate.
function LiveWaiting() {
  const model = useDerived(WAITING_STORES, () =>
    liveWaitingModel({
      live: liveStore.get(),
      transport: transportStore.get(),
      setup: setupStore.get(),
      f1Live: f1LiveStore.get(),
    }),
  );
  return (
    <div className="live-workspace" data-game="none">
      <WorkspaceHeader title="Live" />
      {model.covered ? null : (
        <div className="panel telemetry-empty live-waiting" role="status">
          <p className="telemetry-empty-title">{model.title}</p>
          <p className="telemetry-empty-reason">{model.reason}</p>
        </div>
      )}
      <section
        className="live-panel waiting-games"
        aria-label="Supported games"
      >
        <h2 className="live-section-title">Supported games</h2>
        <ul className="waiting-game-list">
          {model.games.map((game) => (
            <li key={game.key} data-game={game.key}>
              <span className="waiting-game-name">{game.name}</span>
              <span className="waiting-game-target">{game.target}</span>
              <span className={`waiting-game-status tone-${game.tone}`}>
                <span className="state-glyph" aria-hidden="true">
                  {GLYPHS[game.tone]}
                </span>
                {game.status}
              </span>
            </li>
          ))}
        </ul>
        <p className="live-footnote">
          The settings each game needs are in Settings.
        </p>
      </section>
    </div>
  );
}

/// Live for whichever supported game is active (`activeGameStore`), or the
/// neutral waiting view. Each game's workspace is isolated: nothing below
/// mixes one game's fields or wording into the other's. Only the active
/// game's workspace is mounted, so only its data subscription renders.
export default function LiveWorkspace({
  tab,
  f1Tab,
  onTab,
  onF1Tab,
}: {
  tab: LiveTabId;
  f1Tab: F1TabId;
  onTab: (tab: LiveTabId) => void;
  onF1Tab: (tab: F1TabId) => void;
}) {
  const game = useActiveGame((state) => state.game);
  if (game === "f1_25") return <F1LiveWorkspace tab={f1Tab} onTab={onF1Tab} />;
  if (game === "fh6") return <Fh6LiveWorkspace tab={tab} onTab={onTab} />;
  return <LiveWaiting />;
}
