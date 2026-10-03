import { useState } from "react";
import { useSetup } from "../../hooks/use-setup-state.ts";
import { resolveSetupStage } from "../../telemetry/setup-view-model.ts";
import { FirstRunGuide } from "../FirstRunGuide";

/// First-run guidance, shown above the active workspace wherever the user is.
/// Only the instructions' detection line follows live telemetry — through a
/// derived sentence, not at the live rate — and only while the instructions
/// are on screen. The confirmation reads no live telemetry; once it is
/// acknowledged, or on a configured installation (nearly every launch),
/// nothing here is mounted at all.
export function FirstRunSlot() {
  const setup = useSetup((state) => state.setup);
  const sawFirstRun = useSetup((state) => state.sawFirstRun);
  // Acknowledging the confirmation is local to this run, exactly as in V1.0;
  // the backend's first-run record is untouched.
  const [dismissed, setDismissed] = useState(false);
  const stage = resolveSetupStage({ setup, sawFirstRun, dismissed });
  if (setup == null || stage === "hidden") return null;
  return (
    <FirstRunGuide
      setup={setup}
      stage={stage}
      onDismiss={() => {
        setDismissed(true);
        // Continue disappears with the guide; focus moves to the workspace
        // title instead of being lost to the page.
        document.querySelector<HTMLElement>(".workspace-view h1")?.focus();
      }}
    />
  );
}
