import { useEffect, useId, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { StorageStatus } from "../session-state.ts";
import {
  BUDGET_CHOICES,
  budgetChoiceLabel,
  storageView,
  type SettingsSnapshot,
} from "../settings-state.ts";
import { Notice } from "./shell/Notice";

/// The storage limit — the one product setting RaceLab has, and the only
/// place it can be changed.
///
/// A fixed set of choices rather than a byte field: the honest range is a
/// handful of sizes, and a free-form number would only invite a value small
/// enough to delete a recording as fast as it was made. "Keep everything" is
/// offered because some users would rather manage the folder themselves.
///
/// Two one-off reads on open (the setting and current usage) and one write
/// per choice. Nothing here polls or follows live telemetry.
export function StorageBudget() {
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null);
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState<string | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const labelId = useId();

  useEffect(() => {
    let disposed = false;
    void (async () => {
      const [read, usage] = await Promise.allSettled([
        invoke<SettingsSnapshot>("get_settings"),
        invoke<StorageStatus>("get_storage_status"),
      ]);
      if (disposed) return;
      if (read.status === "fulfilled") setSettings(read.value);
      else setReadError(String(read.reason));
      // Usage is additive: the limit can still be shown and changed without it.
      if (usage.status === "fulfilled") setStorage(usage.value);
      setLoading(false);
    })();
    return () => {
      disposed = true;
    };
  }, []);

  async function choose(budget: number) {
    if (pending != null || settings?.storage_budget_bytes === budget) return;
    setPending(budget);
    setSaveError(null);
    setSaved(false);
    try {
      setSettings(
        await invoke<SettingsSnapshot>("set_storage_budget", {
          budgetBytes: budget,
        }),
      );
      setSaved(true);
    } catch (reason) {
      setSaveError(String(reason));
    } finally {
      setPending(null);
    }
  }

  if (loading) {
    return (
      <p className="settings-loading" role="status">
        Reading storage settings…
      </p>
    );
  }
  if (settings == null) {
    return (
      <Notice
        tone="bad"
        title="The storage limit could not be read"
        technical={readError}
      >
        Recording and clean-up carry on as before. Reopen Settings to try again.
      </Notice>
    );
  }

  const view = storageView(settings, storage);
  const locked = settings.storage_budget_from_environment;

  return (
    <div className="storage-settings">
      <div className="storage-usage-block">
        <p className="storage-usage-figure">
          {view.used != null ? (
            <>
              <strong>{view.used}</strong> used
              {view.limit && view.limit !== "No limit" ? (
                <> of {view.limit}</>
              ) : (
                <> · no limit</>
              )}
            </>
          ) : (
            "Current usage is not available."
          )}
        </p>
        {view.fraction != null ? (
          <div
            className="storage-meter-track"
            role="meter"
            aria-label="Storage used"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(view.fraction * 100)}
            aria-valuetext={`${view.used} of ${view.limit}`}
          >
            <span
              className="storage-meter-bar"
              style={{ width: `${(view.fraction * 100).toFixed(1)}%` }}
            />
          </div>
        ) : null}
        {view.sessions ? (
          <p className="settings-note">{view.sessions}</p>
        ) : null}
      </div>

      <div className="settings-field">
        <p className="settings-label" id={labelId}>
          Storage limit
        </p>
        {locked ? (
          <p className="settings-note">
            This limit is set outside RaceLab, by the
            RACELAB_STORAGE_BUDGET_BYTES environment variable, so it cannot be
            changed here.
          </p>
        ) : (
          <div className="segmented" role="group" aria-labelledby={labelId}>
            {BUDGET_CHOICES.map((choice) => {
              const current = choice === settings.storage_budget_bytes;
              return (
                <button
                  key={choice}
                  type="button"
                  className="segment"
                  aria-pressed={current}
                  // Not `disabled`: a focused button that becomes disabled
                  // drops keyboard focus to the page. `choose` ignores
                  // presses while a save is pending.
                  aria-disabled={pending != null}
                  onClick={() => void choose(choice)}
                >
                  {pending === choice ? "Saving…" : budgetChoiceLabel(choice)}
                </button>
              );
            })}
          </div>
        )}
        <p className="settings-explain">{view.meaning}</p>
        {!locked ? (
          <p className="settings-note">
            Changing the limit deletes nothing now. A new limit applies the next
            time RaceLab starts.
          </p>
        ) : null}
      </div>

      {view.pendingChange ? (
        <Notice tone="neutral" title="Limit changes on next start" live={false}>
          {view.pendingChange}
        </Notice>
      ) : null}
      {saved && !saveError ? (
        <p className="settings-saved" role="status">
          <span className="state-glyph" aria-hidden="true">
            ●
          </span>
          Saved.
        </p>
      ) : null}
      {saveError ? (
        <Notice
          tone="bad"
          title="The new limit could not be saved"
          technical={saveError}
        >
          The previous limit is still in place.
        </Notice>
      ) : null}
      {view.warnings.map((warning) => (
        <Notice
          key={warning.key}
          tone="warn"
          title={warning.title}
          technical={warning.technical}
        >
          {warning.detail}
        </Notice>
      ))}
    </div>
  );
}
