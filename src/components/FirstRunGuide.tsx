import { useId } from "react";
import type { SetupStage, SetupState } from "../telemetry/setup-view-model.ts";
import { DetectionLine, SetupSteps } from "./SetupInstructions";

/// The first-run experience: the Data Out steps and one live sentence about
/// what is arriving. Deliberately not a wizard — there is nothing to choose
/// and nothing to save. Only telemetry actually arriving completes setup; when
/// it does, this says so once, calmly, and is never shown again. The steps
/// stay available in Settings.
///
/// Whether the confirmation was acknowledged is owned by the caller
/// (`FirstRunSlot`), so nothing stays mounted once it has been.
export function FirstRunGuide({
  setup,
  stage,
  onDismiss,
}: {
  setup: SetupState;
  stage: Exclude<SetupStage, "hidden">;
  onDismiss: () => void;
}) {
  const heading = useId();

  if (stage === "detected") {
    return (
      <section
        className="setup-guide tone-good"
        role="status"
        aria-labelledby={heading}
      >
        <div className="setup-heading">
          <div>
            <p className="setup-eyebrow">
              <span className="state-glyph" aria-hidden="true">
                ●
              </span>
              Setup complete
            </p>
            <h2 id={heading}>Forza Horizon 6 is connected</h2>
          </div>
          <button type="button" className="primary" onClick={onDismiss}>
            Continue
          </button>
        </div>
        <p className="setup-lead">
          RaceLab is receiving telemetry. From now on it listens whenever it is
          open, records each drive on its own and analyzes it when the session
          ends.
        </p>
      </section>
    );
  }

  return (
    <section className="setup-guide" aria-labelledby={heading}>
      <div className="setup-heading">
        <div>
          <p className="setup-eyebrow">Setup</p>
          <h2 id={heading}>Turn on Data Out in Forza Horizon 6</h2>
        </div>
      </div>
      <p className="setup-lead">
        RaceLab is waiting for telemetry from Forza Horizon 6. The game sends
        nothing until Data Out is on — a one-time change in its settings.
      </p>
      <SetupSteps setup={setup} />
      <DetectionLine setup={setup} />
      <p className="setup-footnote">
        You can reopen these steps at any time from Settings.
      </p>
    </section>
  );
}
