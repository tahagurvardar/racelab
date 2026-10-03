import { useReducer } from "react";
import { AppShell } from "./components/AppShell";
import { useLiveTelemetry } from "./hooks/use-live-telemetry.ts";
import { useRecorderStatus } from "./hooks/use-recorder-status.ts";
import { useSetupState } from "./hooks/use-setup-state.ts";
import { useTransportStats } from "./hooks/use-transport-stats.ts";
import { INITIAL_NAVIGATION, navigationReducer } from "./views/navigation.ts";
import DiagnosticsWorkspace from "./workspaces/DiagnosticsWorkspace";
import LiveWorkspace from "./workspaces/LiveWorkspace";
import SessionsWorkspace from "./workspaces/SessionsWorkspace";
import SettingsWorkspace from "./workspaces/SettingsWorkspace";

/// The application root owns every subscription and nothing else. Each owner
/// hook starts its loop exactly once, here, above the workspace switch, and
/// writes into a store; components read the stores they need. App itself
/// reads no store, so it re-renders only when the user navigates.
export default function App() {
  useLiveTelemetry();
  useRecorderStatus();
  useSetupState();
  useTransportStats();
  const [navigation, navigate] = useReducer(
    navigationReducer,
    INITIAL_NAVIGATION,
  );

  return (
    <AppShell navigation={navigation} onNavigate={navigate}>
      {navigation.section === "live" ? (
        <LiveWorkspace
          tab={navigation.liveTab}
          onTab={(tab) => navigate({ type: "liveTab", tab })}
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
