import { useState } from "react";
import { useF1 } from "../hooks/use-f1-evidence.ts";
import { Tabs } from "../components/shell/Tabs";
import { WorkspaceHeader } from "../components/shell/WorkspaceHeader";
import DiagnosticsView, {
  DIAGNOSTICS_TABS,
  F1_EVIDENCE_TAB,
  type DiagnosticsTab,
} from "../views/DiagnosticsView";

/// The last Diagnostics tab, kept while another section is open (the
/// workspace unmounts when the user leaves it).
let rememberedTab: DiagnosticsTab = "connection";

/// Engineering data for troubleshooting, kept apart from the product. The
/// workspace frame reads one latched boolean (whether the F1 25 tab exists);
/// only the open tab subscribes to what it shows.
export default function DiagnosticsWorkspace() {
  const [tab, setTab] = useState<DiagnosticsTab>(rememberedTab);
  // The F1 25 tab exists only where the backend runs the F1 evidence
  // listener. Otherwise the four FH6 tabs are exactly as they were.
  const f1 = useF1((state) => state.available === true);
  const tabs = f1 ? [...DIAGNOSTICS_TABS, F1_EVIDENCE_TAB] : DIAGNOSTICS_TABS;
  function choose(next: DiagnosticsTab) {
    rememberedTab = next;
    setTab(next);
  }
  const current = tabs.find((item) => item.id === tab) ?? tabs[0];
  return (
    <div className="diagnostics-workspace">
      <WorkspaceHeader title="Diagnostics">
        <p className="diag-badge">Engineering data</p>
        <Tabs
          items={tabs}
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
