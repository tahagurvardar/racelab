import { liveStore } from "../state/stores.ts";
import { useDerived } from "../state/use-store.ts";
import {
  detectionStatus,
  setupSteps,
  type SetupState,
  type SetupStep,
} from "../telemetry/setup-view-model.ts";

const LIVE = [liveStore];

const GLYPHS = { good: "●", warn: "◐", bad: "✕", neutral: "○" } as const;

/// A step's sentence with the value to type set apart, so "127.0.0.1" and
/// "20440" read as exact entries rather than as prose.
function StepText({ step }: { step: SetupStep }) {
  if (!step.value) return <>{step.text}</>;
  const at = step.text.indexOf(step.value);
  if (at < 0) return <>{step.text}</>;
  return (
    <>
      {step.text.slice(0, at)}
      <strong className="setup-value">{step.value}</strong>
      {step.text.slice(at + step.value.length)}
    </>
  );
}

/// The Data Out steps as an ordered list. Shared by the first-run screen and
/// Settings, so the two can never disagree.
export function SetupSteps({ setup }: { setup: SetupState }) {
  return (
    <ol className="setup-steps">
      {setupSteps(setup).map((step) => (
        <li key={step.key} data-step={step.key}>
          <StepText step={step} />
        </li>
      ))}
    </ol>
  );
}

/// What RaceLab is receiving right now, in one sentence. It follows live
/// telemetry, but through a derived value: it re-renders when the sentence
/// changes, not at the 20 Hz live rate. A polite status, so a change (for
/// example "received") is announced once.
export function DetectionLine({ setup }: { setup: SetupState }) {
  const detection = useDerived(LIVE, () =>
    detectionStatus(setup, liveStore.get().snapshot),
  );
  return (
    <p className={`setup-detection tone-${detection.tone}`} role="status">
      <span className="state-glyph" aria-hidden="true">
        {GLYPHS[detection.tone]}
      </span>
      <span>{detection.text}</span>
    </p>
  );
}
