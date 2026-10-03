import { useLive } from "../hooks/use-live-telemetry.ts";
import { useSetup } from "../hooks/use-setup-state.ts";
import { useRecorder } from "../hooks/use-recorder-status.ts";
import { useTransport } from "../hooks/use-transport-stats.ts";
import { EmptyTelemetryState } from "../components/EmptyTelemetryState";
import { Tabs } from "../components/shell/Tabs";
import { WorkspaceHeader } from "../components/shell/WorkspaceHeader";
import { elapsed, UNAVAILABLE } from "../telemetry/formatting.ts";
import { degradedCause } from "../telemetry/product-state.ts";
import { recordingIndicator } from "../telemetry/shell-view-model.ts";
import {
  resolveLiveFrame,
  sessionPresentation,
} from "../telemetry/telemetry-view-model.ts";
import { LIVE_TABS, type LiveTabId } from "../views/navigation.ts";
import ChassisTab from "../views/live/ChassisTab";
import DynamicsTab from "../views/live/DynamicsTab";
import OverviewTab from "../views/live/OverviewTab";
import PowertrainTab from "../views/live/PowertrainTab";

/// The only workspace that reads live telemetry, and therefore the only one
/// that re-renders at the 20 Hz poll rate. Exactly one tab is mounted at a
/// time: a hidden tab does not exist, so it costs nothing.
export default function LiveWorkspace({
  tab,
  onTab,
}: {
  tab: LiveTabId;
  onTab: (tab: LiveTabId) => void;
}) {
  const snapshot = useLive((state) => state.snapshot);
  const listenerRunning = useTransport(
    (state) => state.stats?.running ?? false,
  );
  // Two coarse recorder facts for the Overview context strip (2 Hz at most).
  const recording = useRecorder((state) => state.recorder?.recording ?? false);
  const recorderStatus = useRecorder((state) => state.recorder?.status ?? null);
  const state = resolveLiveFrame(snapshot, listenerRunning);
  // Coarse facts (they change rarely): whether the first-run guide is on
  // screen, and whether the global alert is reporting a service or port
  // failure. Either already explains an empty dashboard.
  const firstRun = useSetup((setup) => setup.setup?.first_run ?? false);
  const serviceDown = useLive((live) => live.error != null);
  const transportFailed = snapshot?.transport_error != null;
  const coveredElsewhere =
    (firstRun && state.availability === "waiting") ||
    serviceDown ||
    (transportFailed && state.availability === "stopped");
  const current = LIVE_TABS.find((item) => item.id === tab) ?? LIVE_TABS[0];

  // Valid readings can arrive while the backend reports a recent fault; they
  // stay on screen, with the fault stated once, quietly, above them.
  const degraded =
    state.availability === "live" &&
    snapshot != null &&
    (snapshot.connection === "DEGRADED" || snapshot.health === "DEGRADED");

  return (
    <div className="live-workspace" data-availability={state.availability}>
      <WorkspaceHeader title="Live">
        <Tabs
          items={LIVE_TABS}
          value={current.id}
          onChange={onTab}
          label="Live telemetry"
          idPrefix="live"
        />
      </WorkspaceHeader>
      {coveredElsewhere ? null : <EmptyTelemetryState state={state} />}
      {degraded ? (
        <p className="live-caution" role="status">
          <span className="live-caution-glyph" aria-hidden="true">
            ◐
          </span>
          <span>
            <strong>Telemetry degraded.</strong> {degradedCause(snapshot)} The
            readings below come from the latest valid frame.
          </span>
        </p>
      ) : null}
      {/* One stable panel element: keyboard focus on the panel survives a tab
          change. It is a tab stop because its content starts with no
          focusable control. Only the inner content is keyed, for the short
          entry transition. */}
      <div
        className="tab-panel"
        id="live-panel"
        role="tabpanel"
        aria-labelledby={`live-tab-${current.id}`}
        tabIndex={0}
      >
        <div className="tab-panel-content" key={current.id}>
          {current.id === "overview" ? (
            <OverviewTab
              state={state}
              context={{
                session: sessionPresentation(snapshot),
                duration: snapshot?.session
                  ? elapsed(snapshot.session.duration_ms / 1000)
                  : UNAVAILABLE,
                recording: {
                  ...recordingIndicator(recording, recorderStatus),
                  active: recording,
                },
              }}
            />
          ) : null}
          {current.id === "powertrain" ? <PowertrainTab state={state} /> : null}
          {current.id === "chassis" ? <ChassisTab state={state} /> : null}
          {current.id === "dynamics" ? <DynamicsTab state={state} /> : null}
        </div>
      </div>
    </div>
  );
}
