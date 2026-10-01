/// The `get_settings` / `set_storage_budget` contract (`settings.rs`), plus the
/// presentation rules for the one setting V1.0 exposes.
import { bytes } from "./session-state.ts";

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
