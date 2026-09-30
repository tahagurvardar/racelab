//! Bounded session storage.
//!
//! A normalized recording costs roughly 3 MB per second of driving, so an hour
//! of play is about 1 GB. Without a bound, RaceLab fills the user's disk and
//! the only thing that stops it is the disk being full — at which point the
//! recording that fails is the one being made right now. A retention budget is
//! therefore not housekeeping; it is what keeps the *current* session
//! recordable.
//!
//! The policy is deliberately the simplest one that can be stated exactly:
//!
//! > When the sessions directory exceeds its budget, RaceLab deletes whole
//! > sessions, oldest first by start time, until it is under budget again. It
//! > never deletes the session being recorded, a session waiting for or
//! > undergoing analysis, or a session it cannot identify.
//!
//! Four properties are structural rather than best-effort:
//!
//! 1. **Ingestion never waits.** Every byte of directory work happens on this
//!    module's own thread. The UDP path, the hub and the recorder's writer
//!    thread never call into it; they only ever hand it a wakeup through a
//!    one-slot channel that cannot block.
//! 2. **Protection is checked at the moment of deletion**, not when the sweep
//!    was planned, so a session that starts recording mid-sweep is safe.
//! 3. **Nothing unidentifiable is deleted.** A directory whose manifest cannot
//!    be read has no established age, so oldest-first cannot order it and it is
//!    never chosen. Its bytes are still counted and reported, so a corrupt
//!    session holding the budget down is visible rather than mysterious.
//! 4. **Deletion is not silent.** Every deleted session is counted, the bytes
//!    reclaimed are counted, and failures are counted and reported.
//!
//! A deletion is made in two steps: the directory is first renamed to a name
//! that is not a valid session identifier, and only then removed. The rename is
//! atomic, so a session is never observable in a half-deleted state where its
//! manifest survives its frames. A leftover marker directory — a rename that
//! succeeded followed by a removal that did not, which on Windows means a file
//! someone else still has open — is retried by the next sweep.
use crate::session_format::{self, SessionStatus};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, RecvTimeoutError},
        Arc, Mutex, MutexGuard,
    },
    thread::{self, JoinHandle},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

/// Default budget. Chosen as roughly eight hours of continuous recording at the
/// measured ~3 MB/s, which is far more driving than a session's worth of
/// review needs while still being a small fraction of a modern disk.
pub const DEFAULT_STORAGE_BUDGET_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// Suffix marking a directory that is being deleted. It contains a `.`, so
/// `is_safe_session_id` rejects it and no listing can ever mistake it for a
/// session.
const DELETING_SUFFIX: &str = ".rl-deleting";

/// Bounds one sweep's directory work, matching `session_store`.
pub const MAX_SCANNED_DIRECTORIES: usize = 2000;

/// Zero disables retention entirely: nothing is ever deleted and usage is still
/// measured and reported.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct RetentionPolicy {
    pub budget_bytes: u64,
}

impl Default for RetentionPolicy {
    fn default() -> Self {
        Self {
            budget_bytes: DEFAULT_STORAGE_BUDGET_BYTES,
        }
    }
}

impl RetentionPolicy {
    /// `RACELAB_STORAGE_BUDGET_BYTES` overrides the default; `0` disables
    /// deletion. An unparseable value is an error rather than a silent default,
    /// because silently ignoring a storage setting is how a disk fills up.
    pub fn from_environment() -> Result<Self, String> {
        match std::env::var("RACELAB_STORAGE_BUDGET_BYTES") {
            Err(_) => Ok(Self::default()),
            Ok(value) => value
                .trim()
                .parse()
                .map(|budget_bytes| Self { budget_bytes })
                .map_err(|_| "RACELAB_STORAGE_BUDGET_BYTES must be a whole number of bytes".into()),
        }
    }

    pub fn enabled(&self) -> bool {
        self.budget_bytes > 0
    }
}

/// A session RaceLab must not delete, whatever its age.
///
/// Implemented by the recorder (the session being written) and the analyzer
/// (sessions queued or being analyzed). Called on the retention thread for each
/// deletion candidate, so an implementation must be cheap and must not block.
pub trait SessionProtection: Send + Sync {
    fn is_protected(&self, session_id: &str) -> bool;
    /// For reporting only.
    fn protection_reason(&self) -> &'static str;
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct RetentionStatus {
    pub budget_bytes: u64,
    pub enabled: bool,
    /// Total bytes under the sessions directory at the last sweep.
    pub used_bytes: u64,
    pub over_budget: bool,
    pub retained_sessions: u64,
    /// Sessions skipped by the last sweep because they were being recorded,
    /// queued for analysis or being analyzed.
    pub protected_sessions: u64,
    /// Directories whose manifest could not be read. Counted toward
    /// `used_bytes`, never deleted, because their age cannot be established.
    pub unidentifiable_sessions: u64,
    pub unidentifiable_bytes: u64,
    /// Lifetime totals for this process.
    pub deleted_sessions: u64,
    pub reclaimed_bytes: u64,
    pub failed_deletions: u64,
    pub sweeps: u64,
    pub last_sweep_unix_ms: Option<u64>,
    pub last_deleted_session_id: Option<String>,
    pub last_error: Option<String>,
}

/// One candidate, with everything the sweep needs to order and judge it.
#[derive(Debug, Clone)]
struct Candidate {
    session_id: String,
    directory: PathBuf,
    bytes: u64,
    /// Sort key. `None` for a session whose manifest could not be read, which
    /// is exactly why such a session is never a deletion candidate.
    started_at_unix_ms: Option<u64>,
    recording: bool,
}

/// Bytes held by one session directory. A file that vanishes or cannot be
/// stat-ed between the listing and the sum contributes nothing rather than
/// failing the sweep.
fn directory_bytes(directory: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(directory) else {
        return 0;
    };
    entries
        .flatten()
        .filter_map(|entry| entry.metadata().ok())
        .map(|metadata| if metadata.is_dir() { 0 } else { metadata.len() })
        .sum()
}

/// Everything under the sessions root, with leftover deletion markers removed
/// first so a previously blocked deletion is retried.
fn survey(root: &Path) -> Vec<Candidate> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut candidates = Vec::new();
    for entry in entries.flatten().take(MAX_SCANNED_DIRECTORIES) {
        let directory = entry.path();
        if !directory.is_dir() {
            continue;
        }
        let name = directory
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        if name.ends_with(DELETING_SUFFIX) {
            // A deletion that was interrupted or blocked last time.
            let _ = fs::remove_dir_all(&directory);
            continue;
        }
        // Only a real session identifier is ever treated as a session. A
        // foreign folder is left completely alone, not scanned and not deleted.
        if !session_format::is_safe_session_id(&name) {
            continue;
        }
        let manifest = session_format::read_manifest(&directory).ok();
        candidates.push(Candidate {
            session_id: name,
            bytes: directory_bytes(&directory),
            started_at_unix_ms: manifest.as_ref().and_then(|m| m.started_at_unix_ms),
            recording: manifest
                .as_ref()
                .is_some_and(|m| m.status == SessionStatus::Recording),
            directory,
        });
    }
    // Oldest first, with the identifier breaking ties so the order never
    // depends on filesystem enumeration.
    candidates.sort_by(|a, b| {
        a.started_at_unix_ms
            .cmp(&b.started_at_unix_ms)
            .then_with(|| a.session_id.cmp(&b.session_id))
    });
    candidates
}

/// Rename out of the way, then remove. The rename is what makes a deletion
/// atomic from a reader's point of view.
fn delete_session(directory: &Path) -> Result<(), String> {
    let marker = directory.with_file_name(format!(
        "{}{DELETING_SUFFIX}",
        directory
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default()
    ));
    fs::rename(directory, &marker).map_err(|error| error.to_string())?;
    fs::remove_dir_all(&marker).map_err(|error| error.to_string())
}

/// One deterministic pass. Pure with respect to its inputs apart from the
/// deletions it makes, which is what lets tests drive it directly.
pub fn sweep(
    root: &Path,
    policy: RetentionPolicy,
    protection: &[Arc<dyn SessionProtection>],
    status: &mut RetentionStatus,
) {
    let candidates = survey(root);
    let mut used: u64 = candidates.iter().map(|candidate| candidate.bytes).sum();

    status.budget_bytes = policy.budget_bytes;
    status.enabled = policy.enabled();
    status.retained_sessions = candidates.len() as u64;
    status.unidentifiable_sessions = candidates
        .iter()
        .filter(|candidate| candidate.started_at_unix_ms.is_none())
        .count() as u64;
    status.unidentifiable_bytes = candidates
        .iter()
        .filter(|candidate| candidate.started_at_unix_ms.is_none())
        .map(|candidate| candidate.bytes)
        .sum();
    status.protected_sessions = 0;
    status.sweeps += 1;
    status.last_sweep_unix_ms = Some(unix_ms());

    if !policy.enabled() {
        status.used_bytes = used;
        status.over_budget = false;
        return;
    }

    for candidate in &candidates {
        if used <= policy.budget_bytes {
            break;
        }
        // A session whose manifest cannot be read has no established start
        // time, so oldest-first cannot honestly place it. It is never chosen.
        if candidate.started_at_unix_ms.is_none() {
            continue;
        }
        // Checked here, not at survey time, so a session that started
        // recording during this sweep is still safe.
        if candidate.recording
            || protection
                .iter()
                .any(|guard| guard.is_protected(&candidate.session_id))
        {
            status.protected_sessions += 1;
            continue;
        }
        match delete_session(&candidate.directory) {
            Ok(()) => {
                used = used.saturating_sub(candidate.bytes);
                status.deleted_sessions += 1;
                status.reclaimed_bytes = status.reclaimed_bytes.saturating_add(candidate.bytes);
                status.retained_sessions = status.retained_sessions.saturating_sub(1);
                status.last_deleted_session_id = Some(candidate.session_id.clone());
            }
            // A locked or vanished directory is skipped, not retried in a
            // loop. The next sweep tries again.
            Err(error) => {
                status.failed_deletions += 1;
                status.last_error = Some(format!(
                    "Could not delete session {}: {error}",
                    candidate.session_id
                ));
            }
        }
    }
    status.used_bytes = used;
    status.over_budget = used > policy.budget_bytes;
}

/// Owns the retention worker thread.
pub struct RetentionService {
    root: PathBuf,
    policy: RetentionPolicy,
    status: Arc<Mutex<RetentionStatus>>,
    stop: Arc<AtomicBool>,
    wake: mpsc::SyncSender<()>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl RetentionService {
    pub fn start(
        root: PathBuf,
        policy: RetentionPolicy,
        protection: Vec<Arc<dyn SessionProtection>>,
    ) -> Result<Arc<Self>, String> {
        let status = Arc::new(Mutex::new(RetentionStatus {
            budget_bytes: policy.budget_bytes,
            enabled: policy.enabled(),
            ..RetentionStatus::default()
        }));
        let stop = Arc::new(AtomicBool::new(false));
        // One slot. Several completions arriving together are one sweep.
        let (wake, wakeups) = mpsc::sync_channel(1);
        let worker_root = root.clone();
        let worker_status = Arc::clone(&status);
        let worker_stop = Arc::clone(&stop);
        let worker = thread::Builder::new()
            .name("session-retention".into())
            .spawn(move || loop {
                if worker_stop.load(Ordering::Acquire) {
                    return;
                }
                {
                    let mut status = lock(&worker_status);
                    sweep(&worker_root, policy, &protection, &mut status);
                }
                match wakeups.recv_timeout(Duration::from_secs(3600)) {
                    Ok(()) | Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            })
            .map_err(|error| format!("Could not start session retention: {error}"))?;
        Ok(Arc::new(Self {
            root,
            policy,
            status,
            stop,
            wake,
            worker: Mutex::new(Some(worker)),
        }))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn policy(&self) -> RetentionPolicy {
        self.policy
    }

    pub fn status(&self) -> RetentionStatus {
        lock(&self.status).clone()
    }

    /// Ask for a sweep. Never blocks: this is called from a session-completion
    /// path that must return immediately.
    pub fn request_sweep(&self) {
        let _ = self.wake.try_send(());
    }

    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.wake.try_send(());
        if let Some(worker) = lock(&self.worker).take() {
            let _ = worker.join();
        }
    }
}

impl Drop for RetentionService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// A finished recording is new bytes on disk, so it is the natural moment to
/// reconsider the budget. This runs on the recorder's writer thread and does
/// exactly one non-blocking `try_send`, as that thread's contract requires.
impl crate::session_recorder::SessionCompletionHook for RetentionService {
    fn session_completed(&self, _session_id: &str, _directory: &Path) {
        self.request_sweep();
    }
}

/// A finished analysis releases a protected session. Without this, a budget
/// that is held down by the oldest sessions all being queued for analysis
/// would stay over budget until the next recording ended.
impl crate::analysis_job::AnalysisJobObserver for RetentionService {
    fn job_finished(&self, _session_id: &str, _state: crate::analysis_job::JobState) {
        self.request_sweep();
    }
}
