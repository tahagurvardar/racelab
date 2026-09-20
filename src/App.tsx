import { useState } from "react";
import { AppShell } from "./components/AppShell";
import { StatusBar } from "./components/StatusBar";
import { useLiveTelemetry } from "./hooks/use-live-telemetry.ts";
import { useRecorderStatus } from "./hooks/use-recorder-status.ts";
import { useTransportStats } from "./hooks/use-transport-stats.ts";
import {
  buildStatus,
  resolveLiveFrame,
} from "./telemetry/telemetry-view-model.ts";
import { DEFAULT_VIEW, type ViewId } from "./views/navigation.ts";
import DiagnosticsView from "./views/DiagnosticsView";
import DynamicsView from "./views/DynamicsView";
import EngineView from "./views/EngineView";
import InputsView from "./views/InputsView";
import OverviewView from "./views/OverviewView";
import RaceView from "./views/RaceView";
import SessionsView from "./views/SessionsView";
import SuspensionView from "./views/SuspensionView";
import TiresView from "./views/TiresView";

/// The application shell owns every subscription. Telemetry, recorder status
/// and transport statistics are read once here, above the view switch, so
/// changing views can never start a second polling loop, and the Sessions view
/// cannot affect telemetry ingestion.
export default function App() {
  const [view, setView] = useState<ViewId>(DEFAULT_VIEW);
  const { snapshot, error: liveError } = useLiveTelemetry();
  const { recorder, error: recorderError } = useRecorderStatus();
  const { stats, connectionError, apply } = useTransportStats();

  const listenerRunning = stats?.running ?? false;
  const state = resolveLiveFrame(snapshot, listenerRunning);
  const status = buildStatus(
    snapshot,
    recorder?.recording ?? false,
    liveError ?? connectionError,
  );

  return (
    <AppShell
      active={view}
      onSelect={setView}
      status={<StatusBar model={status} />}
      banner={status.banner}
    >
      {view === "overview" ? <OverviewView state={state} /> : null}
      {view === "engine" ? <EngineView state={state} /> : null}
      {view === "dynamics" ? <DynamicsView state={state} /> : null}
      {view === "tires" ? <TiresView state={state} /> : null}
      {view === "suspension" ? <SuspensionView state={state} /> : null}
      {view === "inputs" ? <InputsView state={state} /> : null}
      {view === "race" ? <RaceView state={state} /> : null}
      {view === "sessions" ? (
        <SessionsView recorder={recorder} recorderError={recorderError} />
      ) : null}
      {view === "diagnostics" ? (
        <DiagnosticsView
          live={snapshot}
          stats={stats}
          recorder={recorder}
          onStats={apply}
        />
      ) : null}
    </AppShell>
  );
}
