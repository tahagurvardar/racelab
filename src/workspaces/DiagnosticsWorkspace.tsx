import { useState } from "react";
import { Tabs } from "../components/shell/Tabs";
import { WorkspaceHeader } from "../components/shell/WorkspaceHeader";
import DiagnosticsView, {
  DIAGNOSTICS_TABS,
  type DiagnosticsTab,
} from "../views/DiagnosticsView";

/// The last Diagnostics tab, kept while another section is open (the
/// workspace unmounts when the user leaves it).
let rememberedTab: DiagnosticsTab = "connection";

/// Engineering data for troubleshooting, kept apart from the product. The
/// workspace frame reads no store; only the open tab subscribes, to what it
/// shows.
export default function DiagnosticsWorkspace() {
  const [tab, setTab] = useState<DiagnosticsTab>(rememberedTab);
  function choose(next: DiagnosticsTab) {
    rememberedTab = next;
    setTab(next);
  }
  const current =
    DIAGNOSTICS_TABS.find((item) => item.id === tab) ?? DIAGNOSTICS_TABS[0];
  return (
    <div className="diagnostics-workspace">
      <WorkspaceHeader title="Diagnostics">
        <p className="diag-badge">Engineering data</p>
        <Tabs
          items={DIAGNOSTICS_TABS}
          value={current.id}
          onChange={choose}
          label="Diagnostics"
          idPrefix="diagnostics"
        />
      </WorkspaceHeader>
      <div
        className="tab-panel"
        id="diagnostics-panel"
        role="tabpanel"
        aria-labelledby={`diagnostics-tab-${current.id}`}
        tabIndex={0}
      >
        <div className="tab-panel-content" key={current.id}>
          <DiagnosticsView tab={current.id} />
        </div>
      </div>
    </div>
  );
}
