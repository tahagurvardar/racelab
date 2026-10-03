import { useReducer } from "react";
import { AppShell } from "./components/AppShell";
import { useF1Evidence } from "./hooks/use-f1-evidence.ts";
import { useF1RecorderStatus } from "./hooks/use-f1-recorder-status.ts";
import { useF1LiveTelemetry } from "./hooks/use-f1-live.ts";
import { useLiveTelemetry } from "./hooks/use-live-telemetry.ts";
import { useRecorderStatus } from "./hooks/use-recorder-status.ts";
import { useSetupState } from "./hooks/use-setup-state.ts";
import { useTransportStats } from "./hooks/use-transport-stats.ts";
import { INITIAL_NAVIGATION, navigationReducer } from "./views/navigation.ts";
import DiagnosticsWorkspace from "./workspaces/DiagnosticsWorkspace";
import LiveWorkspace from "./workspaces/LiveWorkspace";
import SessionsWorkspace from "./workspaces/SessionsWorkspace";
import SettingsWorkspace from "./workspaces/SettingsWorkspace";
import HomeWorkspace from "./workspaces/HomeWorkspace";

/// The application root owns every subscription and nothing else. Each owner
/// hook starts its loop exactly once, here, above the workspace switch, and
/// writes into a store; components read the stores they need. App itself
/// reads no store, so it re-renders only when the user navigates.
export default function App() {
  useLiveTelemetry();
  useRecorderStatus();
  useSetupState();
  useTransportStats();
  useF1Evidence();
  useF1LiveTelemetry();
  useF1RecorderStatus();
  const [navigation, navigate] = useReducer(
    navigationReducer,
    INITIAL_NAVIGATION,
  );

  return (
    <AppShell navigation={navigation} onNavigate={navigate}>
      {navigation.section === "home" ? (
        <HomeWorkspace
          onNavigate={(section) => navigate({ type: "section", section })}
        />
      ) : null}
      {navigation.section === "live" ? (
        <LiveWorkspace
          tab={navigation.liveTab}
          f1Tab={navigation.f1Tab}
          onTab={(tab) => navigate({ type: "liveTab", tab })}
          onF1Tab={(tab) => navigate({ type: "f1Tab", tab })}
        />
      ) : null}
      {navigation.section === "sessions" ? (
        <SessionsWorkspace
          onOpenSettings={() =>
            navigate({ type: "section", section: "settings" })
          }
        />
      ) : null}
      {navigation.section === "settings" ? <SettingsWorkspace /> : null}
      {navigation.section === "diagnostics" ? <DiagnosticsWorkspace /> : null}
    </AppShell>
  );
}
