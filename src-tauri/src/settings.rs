//! Persisted product settings and first-run state.
//!
//! This is deliberately one file holding two things and no framework around
//! them, because V1.0 needs exactly two things:
//!
//! - **`storage_budget_bytes`** — the one setting a user can genuinely need to
//!   change. Retention's budget was environment-only through V0.10, which is
//!   unreachable from an installed build: a user with a small SSD had no way to
//!   lower it and a user with a large one no way to keep more driving.
//! - **`fh6_first_detected_unix_ms`** — not a setting but recorded state, kept
//!   here because it is the same one small file. It is what makes first-run
//!   guidance disappear permanently once RaceLab has actually seen FH6, rather
//!   than reappearing every launch that starts before the game.
//! - **`f1_first_detected_unix_ms`** (V2.0 Phase D) — the same record for
//!   F1 25. Setup is complete once *either* supported game has been seen:
//!   a user needs only one of them. The field is additive and optional, so
//!   a V1.1 file reads unchanged, and a V1.1 user who has seen FH6 is not
//!   asked to set anything up again.
//!
//! Three properties matter:
//!
//! 1. **A broken settings file never stops RaceLab.** Anything unreadable,
//!    malformed or written by a future schema falls back to defaults and is
//!    reported through `last_error`. Refusing to launch because a preferences
//!    file is corrupt would be a worse failure than the one it describes.
//! 2. **Writes are atomic.** A temporary file in the same directory, then a
//!    rename. A crash or a full disk during a write leaves the previous
//!    settings intact; it can never produce a half-written file that the next
//!    launch has to fall back from.
//! 3. **The environment still wins.** `RACELAB_STORAGE_BUDGET_BYTES` overrides
//!    this file, which keeps every V0.10 retention test, example and validation
//!    document working exactly as written.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
};

pub const SETTINGS_FILE_NAME: &str = "settings.json";
pub const SETTINGS_SCHEMA_VERSION: u32 = 1;

/// The smallest budget worth accepting. A budget below one session's worth of
/// driving would delete a recording almost as fast as it was made, which is a
/// more confusing failure than running out of space. `0` is still accepted and
/// still means "never delete anything".
pub const MIN_STORAGE_BUDGET_BYTES: u64 = 1024 * 1024 * 1024;
/// An upper bound so a typo cannot store a nonsensical number.
pub const MAX_STORAGE_BUDGET_BYTES: u64 = 1024 * 1024 * 1024 * 1024;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

/// The on-disk shape. Every field is optional so a file written by an older
/// build stays readable, and unknown fields are ignored rather than rejected.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SettingsV1 {
    /// Additive overlay preferences; older files keep the overlay off.
    #[serde(default, deserialize_with = "crate::overlay::read_preferences")]
    pub overlay: crate::overlay::OverlayPreferences,
    #[serde(default)]
    pub schema_version: u32,
    /// `None` means "use the built-in default".
    #[serde(default)]
    pub storage_budget_bytes: Option<u64>,
    /// When RaceLab first decoded FH6 telemetry on this installation.
    #[serde(default)]
    pub fh6_first_detected_unix_ms: Option<u64>,
    /// When RaceLab first accepted F1 25 telemetry on this installation.
    /// Absent from every file written before V2.0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub f1_first_detected_unix_ms: Option<u64>,
}

/// What the frontend reads. Separate from [`SettingsV1`] so the persisted shape
/// and the presented shape can move independently.
#[derive(Debug, Clone, Serialize)]
pub struct SettingsSnapshot {
    pub overlay: crate::overlay::OverlayPreferences,
    /// The budget actually in force, after the environment override.
    pub storage_budget_bytes: u64,
    /// True when an environment variable is deciding the budget, in which case
    /// the product must not offer to change it.
    pub storage_budget_from_environment: bool,
    pub min_storage_budget_bytes: u64,
    pub max_storage_budget_bytes: u64,
    pub default_storage_budget_bytes: u64,
    pub fh6_first_detected_unix_ms: Option<u64>,
    pub f1_first_detected_unix_ms: Option<u64>,
    /// Set when the settings file could not be read or written. The product
    /// still works; this says that a change may not survive a restart.
    pub last_error: Option<String>,
    pub path: String,
}

pub struct SettingsStore {
    path: PathBuf,
    state: Mutex<SettingsV1>,
    last_error: Mutex<Option<String>>,
    write_lock: Mutex<()>,
    /// Captured once at construction. Reading the environment repeatedly would
    /// let the answer change under a running application.
    environment_budget: Option<u64>,
    default_budget: u64,
}

impl SettingsStore {
    /// Reads `directory/settings.json`, falling back to defaults for anything
    /// it cannot use. Never fails: there is no settings problem worth refusing
    /// to start over.
    pub fn load(directory: &Path, default_budget: u64) -> Self {
        let path = directory.join(SETTINGS_FILE_NAME);
        let (state, last_error) = match fs::read(&path) {
            // No file yet is the normal first-run case, not an error.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                (SettingsV1::default(), None)
            }
            Err(error) => (
                SettingsV1::default(),
                Some(format!("Could not read settings: {error}")),
            ),
            Ok(bytes) => match serde_json::from_slice::<SettingsV1>(&bytes) {
                Ok(settings) => (settings, None),
                Err(error) => (
                    SettingsV1::default(),
                    Some(format!(
                        "Settings file could not be read and defaults are in use: {error}"
                    )),
                ),
            },
        };
        let environment_budget = match std::env::var("RACELAB_STORAGE_BUDGET_BYTES") {
            Ok(value) => value.trim().parse().ok(),
            Err(_) => None,
        };
        Self {
            path,
            state: Mutex::new(state),
            last_error: Mutex::new(last_error),
            write_lock: Mutex::new(()),
            environment_budget,
            default_budget,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn overlay(&self) -> crate::overlay::OverlayPreferences {
        lock(&self.state).overlay.clone()
    }

    pub fn set_overlay(
        &self,
        preferences: crate::overlay::OverlayPreferences,
    ) -> Result<(), String> {
        preferences.validate()?;
        lock(&self.state).overlay = preferences;
        self.persist();
        match lock(&self.last_error).clone() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// The budget in force: environment first, then the stored value, then the
    /// built-in default.
    pub fn storage_budget_bytes(&self) -> u64 {
        self.environment_budget.unwrap_or_else(|| {
            lock(&self.state)
                .storage_budget_bytes
                .unwrap_or(self.default_budget)
        })
    }

    pub fn storage_budget_from_environment(&self) -> bool {
        self.environment_budget.is_some()
    }

    /// Records that FH6 has been seen, once. Returns true only on the write
    /// that actually changed something, so the caller can log a single line
    /// rather than one per telemetry tick.
    pub fn mark_fh6_detected(&self, unix_ms: u64) -> bool {
        {
            let mut state = lock(&self.state);
            if state.fh6_first_detected_unix_ms.is_some() {
                return false;
            }
            state.fh6_first_detected_unix_ms = Some(unix_ms);
        }
        self.persist();
        true
    }

    pub fn fh6_first_detected_unix_ms(&self) -> Option<u64> {
        lock(&self.state).fh6_first_detected_unix_ms
    }

    /// Records that F1 25 has been seen, once. Same contract as
    /// `mark_fh6_detected`.
    pub fn mark_f1_detected(&self, unix_ms: u64) -> bool {
        {
            let mut state = lock(&self.state);
            if state.f1_first_detected_unix_ms.is_some() {
                return false;
            }
            state.f1_first_detected_unix_ms = Some(unix_ms);
        }
        self.persist();
        true
    }

    pub fn f1_first_detected_unix_ms(&self) -> Option<u64> {
        lock(&self.state).f1_first_detected_unix_ms
    }

    /// True until RaceLab has received telemetry from *any* supported game at
    /// least once on this installation. This is what first-run guidance keys
    /// off, and it is deliberately *not* "no sessions recorded": a user who
    /// deletes their sessions has still configured their game.
    pub fn is_first_run(&self) -> bool {
        let state = lock(&self.state);
        state.fh6_first_detected_unix_ms.is_none() && state.f1_first_detected_unix_ms.is_none()
    }

    /// Change the budget. `0` disables deletion; anything else must be within
    /// the documented bounds. Refused rather than clamped, so a mistaken value
    /// is visible instead of silently becoming a different one.
    pub fn set_storage_budget_bytes(&self, budget: u64) -> Result<(), String> {
        if self.storage_budget_from_environment() {
            return Err(
                "The storage budget is set by RACELAB_STORAGE_BUDGET_BYTES and cannot be changed here."
                    .into(),
            );
        }
        if budget != 0 && !(MIN_STORAGE_BUDGET_BYTES..=MAX_STORAGE_BUDGET_BYTES).contains(&budget) {
            return Err(format!(
                "The storage budget must be 0 to keep everything, or between {} and {} GB.",
                MIN_STORAGE_BUDGET_BYTES / (1024 * 1024 * 1024),
                MAX_STORAGE_BUDGET_BYTES / (1024 * 1024 * 1024)
            ));
        }
        lock(&self.state).storage_budget_bytes = Some(budget);
        self.persist();
        match lock(&self.last_error).clone() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    pub fn snapshot(&self) -> SettingsSnapshot {
        SettingsSnapshot {
            overlay: self.overlay(),
            storage_budget_bytes: self.storage_budget_bytes(),
            storage_budget_from_environment: self.storage_budget_from_environment(),
            min_storage_budget_bytes: MIN_STORAGE_BUDGET_BYTES,
            max_storage_budget_bytes: MAX_STORAGE_BUDGET_BYTES,
            default_storage_budget_bytes: self.default_budget,
            fh6_first_detected_unix_ms: self.fh6_first_detected_unix_ms(),
            f1_first_detected_unix_ms: self.f1_first_detected_unix_ms(),
            last_error: lock(&self.last_error).clone(),
            path: self.path.to_string_lossy().into_owned(),
        }
    }

    /// Temporary file, then rename. The in-memory state is already updated, so
    /// a failure here means the change is in force for this run and will be
    /// lost on the next one — which is what `last_error` says.
    fn persist(&self) {
        // Overlay movement and first detection can save concurrently. Serialize
        // the complete atomic write so neither can race on settings.json.tmp.
        let _write = lock(&self.write_lock);
        let mut settings = lock(&self.state).clone();
        settings.schema_version = SETTINGS_SCHEMA_VERSION;
        let outcome = self.write(&settings);
        *lock(&self.last_error) = outcome.err();
    }

    fn write(&self, settings: &SettingsV1) -> Result<(), String> {
        let directory = self
            .path
            .parent()
            .ok_or_else(|| "Settings path has no directory".to_string())?;
        fs::create_dir_all(directory)
            .map_err(|error| format!("Could not create the settings directory: {error}"))?;
        let bytes = serde_json::to_vec_pretty(settings)
            .map_err(|error| format!("Could not encode settings: {error}"))?;
        let temporary = self.path.with_extension("json.tmp");
        {
            let mut file = fs::File::create(&temporary)
                .map_err(|error| format!("Could not write settings: {error}"))?;
            file.write_all(&bytes)
                .map_err(|error| format!("Could not write settings: {error}"))?;
            file.sync_all()
                .map_err(|error| format!("Could not flush settings: {error}"))?;
        }
        fs::rename(&temporary, &self.path).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            format!("Could not save settings: {error}")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(directory: &Path) -> SettingsStore {
        SettingsStore::load(directory, 8 * 1024 * 1024 * 1024)
    }

    #[test]
    fn a_missing_settings_file_is_not_an_error() {
        let directory =
            std::env::temp_dir().join(format!("racelab-settings-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        let settings = store(&directory);
        assert_eq!(settings.snapshot().last_error, None);
        assert_eq!(settings.storage_budget_bytes(), 8 * 1024 * 1024 * 1024);
        assert!(settings.is_first_run());
    }

    #[test]
    fn a_malformed_settings_file_falls_back_to_defaults_and_says_so() {
        let directory =
            std::env::temp_dir().join(format!("racelab-settings-bad-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join(SETTINGS_FILE_NAME), b"{ not json").unwrap();
        let settings = store(&directory);
        assert!(settings.snapshot().last_error.is_some());
        assert_eq!(settings.storage_budget_bytes(), 8 * 1024 * 1024 * 1024);
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn a_budget_outside_the_documented_bounds_is_refused_not_clamped() {
        let directory =
            std::env::temp_dir().join(format!("racelab-settings-bounds-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        let settings = store(&directory);
        assert!(settings.set_storage_budget_bytes(1024).is_err());
        assert_eq!(settings.storage_budget_bytes(), 8 * 1024 * 1024 * 1024);
        // Zero is a documented value, not an out-of-range one.
        assert!(settings.set_storage_budget_bytes(0).is_ok());
        assert_eq!(settings.storage_budget_bytes(), 0);
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn a_v1_1_settings_file_reads_unchanged_and_is_not_first_run() {
        let directory =
            std::env::temp_dir().join(format!("racelab-settings-v11-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        // Exactly what V1.1 writes.
        let v11 = b"{\n  \"schema_version\": 1,\n  \"storage_budget_bytes\": 10737418240,\n  \"fh6_first_detected_unix_ms\": 1700000000000\n}";
        fs::write(directory.join(SETTINGS_FILE_NAME), v11).unwrap();
        let settings = store(&directory);
        assert_eq!(settings.snapshot().last_error, None);
        assert!(!settings.is_first_run());
        assert_eq!(settings.f1_first_detected_unix_ms(), None);
        assert_eq!(settings.storage_budget_bytes(), 10 * 1024 * 1024 * 1024);
        // Seeing F1 25 later records it without disturbing the FH6 record.
        assert!(settings.mark_f1_detected(1_800_000_000_000));
        let reloaded = store(&directory);
        assert_eq!(
            reloaded.fh6_first_detected_unix_ms(),
            Some(1_700_000_000_000)
        );
        assert_eq!(
            reloaded.f1_first_detected_unix_ms(),
            Some(1_800_000_000_000)
        );
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn f1_alone_completes_first_run() {
        let directory =
            std::env::temp_dir().join(format!("racelab-settings-f1-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        let settings = store(&directory);
        assert!(settings.is_first_run());
        assert!(settings.mark_f1_detected(1_800_000_000_000));
        assert!(!settings.mark_f1_detected(1_800_000_000_001));
        assert!(!settings.is_first_run());
        assert!(!store(&directory).is_first_run());
        // A file written now still has no field V1.1 cannot read.
        let written = fs::read_to_string(directory.join(SETTINGS_FILE_NAME)).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&written).unwrap();
        assert_eq!(parsed["schema_version"], 1);
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn first_detection_is_recorded_once_and_survives_a_reload() {
        let directory =
            std::env::temp_dir().join(format!("racelab-settings-first-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        let settings = store(&directory);
        assert!(settings.is_first_run());
        assert!(settings.mark_fh6_detected(1_700_000_000_000));
        assert!(!settings.mark_fh6_detected(1_700_000_001_000));
        assert!(!settings.is_first_run());
        let reloaded = store(&directory);
        assert!(!reloaded.is_first_run());
        assert_eq!(
            reloaded.fh6_first_detected_unix_ms(),
            Some(1_700_000_000_000)
        );
        let _ = fs::remove_dir_all(&directory);
    }
}
