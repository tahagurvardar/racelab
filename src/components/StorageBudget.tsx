import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  BUDGET_CHOICES,
  budgetChoiceLabel,
  describeBudget,
  type SettingsSnapshot,
} from "../settings-state.ts";

/// The one setting V1.0 exposes.
///
/// A fixed set of choices rather than a byte field: the honest range is a
/// handful of sizes, and a free-form number would only invite a value small
/// enough to delete a recording as fast as it was made. "Keep everything" is
/// offered because some users would rather manage the folder themselves, and
/// hiding that option would not stop them — it would just make RaceLab delete
/// their recordings without ever having offered an alternative.
export function StorageBudget() {
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const snapshot = await invoke<SettingsSnapshot>("get_settings");
        if (!disposed) setSettings(snapshot);
      } catch (reason) {
        // Settings are additive. The sessions list must render regardless.
        if (!disposed) setError(String(reason));
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  async function choose(budget: number) {
    if (pending) return;
    setPending(true);
    setError(null);
    setSaved(false);
    try {
      setSettings(
        await invoke<SettingsSnapshot>("set_storage_budget", {
          budgetBytes: budget,
        }),
      );
      setSaved(true);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPending(false);
    }
  }

  if (!settings) {
    return error ? (
      <p className="section-footnote" role="status">
        The storage limit could not be read: {error}
      </p>
    ) : null;
  }

  const locked = settings.storage_budget_from_environment;
  return (
    <div className="storage-budget">
      <p>{describeBudget(settings)}</p>
      {locked ? (
        <p className="section-footnote" role="status">
          The storage limit is being set by the RACELAB_STORAGE_BUDGET_BYTES
          environment variable, so it cannot be changed here.
        </p>
      ) : (
        <>
          <div className="controls">
            {BUDGET_CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                className={
                  choice === settings.storage_budget_bytes ? "primary" : ""
                }
                disabled={pending}
                onClick={() => void choose(choice)}
              >
                {budgetChoiceLabel(choice)}
              </button>
            ))}
          </div>
          <p className="section-footnote">
            A new limit applies the next time RaceLab starts. Nothing is deleted
            when you change it.
          </p>
        </>
      )}
      {saved && !error ? (
        <p className="section-footnote" role="status">
          Saved.
        </p>
      ) : null}
      {error ? (
        <p className="error-banner" role="alert">
          {error}
        </p>
      ) : null}
      {settings.last_error ? (
        <p className="error-banner" role="alert">
          {settings.last_error}
        </p>
      ) : null}
    </div>
  );
}
