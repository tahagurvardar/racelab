/// The `get_settings` / `set_storage_budget` contract (`settings.rs`), plus the
/// presentation rules for the one setting V1.0 exposes.
import { bytes, retentionNote, type StorageStatus } from "./session-state.ts";
import { integer } from "./telemetry/formatting.ts";

export interface SettingsSnapshot {
  storage_budget_bytes: number;
  storage_budget_from_environment: boolean;
  min_storage_budget_bytes: number;
  max_storage_budget_bytes: number;
  default_storage_budget_bytes: number;
  fh6_first_detected_unix_ms: number | null;
  last_error: string | null;
  path: string;
}

const GIB = 1024 * 1024 * 1024;

/// The offered sizes, in bytes. `0` means "never delete anything" and is
/// deliberately the last choice rather than the first.
export const BUDGET_CHOICES = [
  2 * GIB,
  8 * GIB,
  25 * GIB,
  100 * GIB,
  0,
] as const;

export function budgetChoiceLabel(budget: number): string {
  return budget === 0 ? "Keep everything" : `${Math.round(budget / GIB)} GB`;
}

/// One sentence naming the limit in force and what it means, so a user is never
/// left to infer what "8 GB" does to their recordings.
export function describeBudget(settings: SettingsSnapshot): string {
  if (settings.storage_budget_bytes === 0) {
    return "RaceLab keeps every recording and never deletes one. Recordings use roughly 3 MB for each second of driving, so this folder will grow without limit.";
  }
  return `RaceLab keeps up to ${bytes(
    settings.storage_budget_bytes,
  )} of recordings. When that is exceeded, the oldest complete sessions are deleted first. The session being recorded and any session waiting for analysis are never deleted.`;
}

// ------------------------------------------------------------ storage view

export interface StorageWarning {
  key: string;
  title: string;
  detail: string;
  /// The backend's own words, for a "Technical details" disclosure.
  technical: string | null;
}

export interface StorageView {
  /// "3.1 GB", or null before storage status is known.
  used: string | null;
  /// "8 GB" / "No limit", for the limit RaceLab is enforcing now.
  limit: string | null;
  /// Use against the enforced limit, 0..1, or null with no limit.
  fraction: number | null;
  /// "12 sessions kept".
  sessions: string | null;
  /// What the configured limit does, in one sentence.
  meaning: string | null;
  /// When the saved limit differs from the one being enforced (a change
  /// takes effect on the next start), the sentence that says so.
  pendingChange: string | null;
  warnings: StorageWarning[];
}

/// A limit as the rest of the storage text writes sizes ("8.0 GB"), so a
/// sentence never says "8 GB" and "8.0 GB" for the same thing.
function limitLabel(budget: number): string {
  return budget === 0 ? "No limit" : bytes(budget);
}

/// Everything the Settings storage group says, from the two reads it makes.
/// Either may be missing; nothing is guessed in its place.
export function storageView(
  settings: SettingsSnapshot | null,
  storage: StorageStatus | null,
): StorageView {
  const retention = storage?.retention ?? null;
  const enforced = retention
    ? retention.enabled
      ? retention.budget_bytes
      : 0
    : null;
  const warnings: StorageWarning[] = [];
  if (retention?.over_budget) {
    warnings.push({
      key: "over-budget",
      title: "Over the storage limit",
      detail: retentionNote(retention) ?? "",
      technical: null,
    });
  }
  if (retention && retention.failed_deletions > 0) {
    warnings.push({
      key: "failed-deletions",
      title: "Some recordings could not be deleted",
      detail: `${integer(retention.failed_deletions)} old recording(s) could not be removed when the limit was applied. They are still on disk, and RaceLab tries again later.`,
      technical: retention.last_error,
    });
  } else if (retention?.last_error) {
    warnings.push({
      key: "retention-error",
      title: "Storage clean-up problem",
      detail: "RaceLab could not finish applying the storage limit.",
      technical: retention.last_error,
    });
  }
  if (settings?.last_error) {
    warnings.push({
      key: "settings-file",
      title: "Settings may not be saved",
      detail:
        "RaceLab could not read or write its settings file. It keeps working, but a change made here may not survive a restart.",
      technical: settings.last_error,
    });
  }
  const configured = settings?.storage_budget_bytes ?? null;
  return {
    used: retention ? bytes(retention.used_bytes) : null,
    limit: enforced == null ? null : limitLabel(enforced),
    fraction:
      retention && retention.enabled && retention.budget_bytes > 0
        ? Math.min(1, retention.used_bytes / retention.budget_bytes)
        : null,
    sessions: retention
      ? `${integer(retention.retained_sessions)} session(s) kept`
      : null,
    meaning: settings ? describeBudget(settings) : null,
    pendingChange:
      configured != null && enforced != null && configured !== enforced
        ? `The new limit (${limitLabel(configured)}) applies the next time RaceLab starts. Until then the current limit (${limitLabel(enforced)}) is used.`
        : null,
    warnings,
  };
}
