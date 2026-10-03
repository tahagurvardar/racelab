import { useSessions, useSessionsController } from "../hooks/use-sessions.ts";
import type { SessionsController } from "../session-controller.ts";
import { WorkspaceHeader } from "../components/shell/WorkspaceHeader";
import { SessionDetail } from "../views/sessions/SessionDetail";
import {
  ListRefresher,
  RecordingRow,
  SessionList,
} from "../views/sessions/SessionList";

/// Recorded history and its analysis, as a master/detail workspace.
///
/// Reads no live telemetry: the list and detail re-render for session,
/// analysis and selection changes only. The two recorder facts it needs (a
/// recording completed; which session is recording) are coarse selections,
/// and the one part that follows the recorder while it records — the pinned
/// recording row — subscribes on its own.
export default function SessionsWorkspace({
  onOpenSettings,
}: {
  onOpenSettings?: () => void;
}) {
  const controller = useSessionsController();
  return (
    <div className="sessions-workspace">
      <WorkspaceHeader title="Sessions" />
      {controller ? (
        <SessionsBody controller={controller} onOpenSettings={onOpenSettings} />
      ) : null}
    </div>
  );
}

function SessionsBody({
  controller,
  onOpenSettings,
}: {
  controller: SessionsController;
  onOpenSettings?: () => void;
}) {
  const empty = useSessions(
    controller,
    (state) =>
      state.list.loaded &&
      state.list.error == null &&
      (state.list.recent?.sessions.length ?? 0) === 0,
  );
  return (
    <>
      <ListRefresher controller={controller} />
      {empty ? (
        <div className="sessions-empty">
          <RecordingRow />
          <div className="state-screen">
            <p className="state-screen-title">No sessions yet</p>
            <p className="state-screen-detail">
              Drive in Forza Horizon 6 with Data Out on. RaceLab records each
              session automatically and analyzes it when it ends; it appears
              here once it is saved.
            </p>
          </div>
        </div>
      ) : (
        <div className="sessions-layout">
          <SessionList
            controller={controller}
            onOpenSettings={onOpenSettings}
          />
          <SessionDetail controller={controller} />
        </div>
      )}
    </>
  );
}
