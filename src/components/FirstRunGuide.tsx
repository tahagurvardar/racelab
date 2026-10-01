import { useState } from "react";
import type { LiveSnapshot } from "../telemetry/live-snapshot.ts";
import {
  detectionStatus,
  resolveSetupStage,
  setupSteps,
  type SetupState,
} from "../telemetry/setup-view-model.ts";

/// The whole first-run experience: six steps and a live statement of what
/// RaceLab is currently receiving. Deliberately not a wizard — there is nothing
/// to step through, nothing to choose and nothing to save. The only thing that
/// completes setup is telemetry actually arriving, and when it does this panel
/// says so once and is never shown again.
export function FirstRunGuide({
  setup,
  sawFirstRun,
  snapshot,
}: {
  setup: SetupState | null;
  sawFirstRun: boolean;
  snapshot: LiveSnapshot | null;
}) {
  // Owned here rather than by the shell: whether the success confirmation has
  // been acknowledged is this panel's business and nothing else reads it.
  const [dismissed, setDismissed] = useState(false);
  const stage = resolveSetupStage({ setup, sawFirstRun, dismissed });
  if (stage === "hidden" || !setup) return null;

  if (stage === "detected") {
    return (
      <section className="panel setup-guide tone-good" role="status">
        <div className="setup-heading">
          <div>
            <p className="eyebrow">SETUP COMPLETE</p>
            <h2>Forza Horizon 6 connected</h2>
          </div>
          <button
            type="button"
            className="primary"
            onClick={() => setDismissed(true)}
          >
            Continue
          </button>
        </div>
        <p>
          RaceLab is receiving telemetry. From now on it starts listening the
          moment you open it, records each drive on its own, and analyzes every
          session when it ends. There is nothing else to set up.
        </p>
      </section>
    );
  }

  const detection = detectionStatus(setup, snapshot);
  return (
    <section className="panel setup-guide" role="status">
      <div className="setup-heading">
        <div>
          <p className="eyebrow">FIRST RUN</p>
          <h2>Turn on Data Out in Forza Horizon 6</h2>
        </div>
      </div>
      <p>
        RaceLab records and analyzes your driving automatically, but Forza
        Horizon 6 has to be told to send it. This is a one-time change inside
        the game.
      </p>
      <ol className="setup-steps">
        {setupSteps(setup).map((step) => (
          <li key={step.key}>{step.text}</li>
        ))}
      </ol>
      <p className={`setup-detection tone-${detection.tone}`} role="status">
        <span className="state-glyph" aria-hidden="true">
          {detection.tone === "good"
            ? "●"
            : detection.tone === "warn"
              ? "◐"
              : detection.tone === "bad"
                ? "✕"
                : "○"}
        </span>
        {detection.text}
      </p>
    </section>
  );
}
