import { useF1Live } from "../hooks/use-f1-live.ts";
import { useActiveGame } from "../state/active-game.ts";
import { Tabs } from "../components/shell/Tabs";
import { WorkspaceHeader } from "../components/shell/WorkspaceHeader";
import { f1LiveBanner } from "../telemetry/f1-live-layout.ts";
import { F1_LIVE_TABS, type F1TabId } from "../views/navigation.ts";
import F1DynamicsTab from "../views/live/f1/F1DynamicsTab";
import F1OverviewTab from "../views/live/f1/F1OverviewTab";
import F1RaceTab from "../views/live/f1/F1RaceTab";
import F1TyresTab from "../views/live/f1/F1TyresTab";

/// F1 25's Live view. The only reader of the F1 25 live store, so the only
/// view that re-renders at its 10 Hz read rate; exactly one tab is mounted.
/// Shares the shell's tab, panel and reading components with FH6 and none of
/// FH6's fields, wording or wheel mapping.
export default function F1LiveWorkspace({
  tab,
  onTab,
}: {
  tab: F1TabId;
  onTab: (tab: F1TabId) => void;
}) {
  const status = useF1Live((state) => state.status);
  const activity = useActiveGame((state) => state.f1_25);
  const live = status?.live ?? null;
  const banner = f1LiveBanner(
    live,
    activity,
    status?.last_accepted_age_ms ?? null,
  );
  const current =
    F1_LIVE_TABS.find((item) => item.id === tab) ?? F1_LIVE_TABS[0];
  return (
    <div
      className="live-workspace f1-live"
      data-game="f1_25"
      data-availability={banner?.availability ?? "live"}
    >
      <WorkspaceHeader title="Live">
        <Tabs
          items={F1_LIVE_TABS}
          value={current.id}
          onChange={onTab}
          label="F1 25 live telemetry"
          idPrefix="live"
        />
      </WorkspaceHeader>
      {banner ? (
        <div className="panel telemetry-empty" role="status">
          <p className="telemetry-empty-title">{banner.headline}</p>
          <p className="telemetry-empty-reason">{banner.reason}</p>
        </div>
      ) : null}
      <div
        className="tab-panel"
        id="live-panel"
        role="tabpanel"
        aria-labelledby={`live-tab-${current.id}`}
        tabIndex={0}
      >
        <div className="tab-panel-content" key={current.id}>
          {current.id === "overview" ? <F1OverviewTab live={live} /> : null}
          {current.id === "race" ? <F1RaceTab live={live} /> : null}
          {current.id === "tyres" ? <F1TyresTab live={live} /> : null}
          {current.id === "dynamics" ? <F1DynamicsTab live={live} /> : null}
        </div>
      </div>
    </div>
  );
}
