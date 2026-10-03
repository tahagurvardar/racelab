//! Interrupted-session recovery.
//!
//! A recording that ends because RaceLab stopped — a crash, a forced kill, a
//! Windows shutdown — leaves two artefacts that disagree. `frames.rlframes` is
//! append-only and holds every record that reached the disk. `manifest.json`
//! holds whatever the last five-second checkpoint wrote, which can be minutes
//! behind, and in a recording made before checkpointing existed it can say
//! `frame_count: 0` beside a frame file of tens of megabytes.
//!
//! Recovery reconciles the two by **reading the frame stream and reporting what
//! is there**. Three rules are structural:
//!
//! 1. **`frames.rlframes` is never written.** Not repaired, not truncated, not
//!    re-encoded. The recorded telemetry is the evidence and it stays
//!    byte-identical.
//! 2. **An incomplete recording is never presented as complete.** The status
//!    stays `interrupted` forever, no summary is ever synthesized, and the
//!    recovery record says exactly where the readable data stopped and why.
//! 3. **Nothing valid is rewritten.** A completed session is never touched. An
//!    interrupted session is scanned once; a manifest that already carries a
//!    finished recovery record is left alone.
//!
//! Scanning happens on this module's own worker thread. A 1 GB frame stream
//! takes seconds to read, and startup — let alone UDP ingestion — must not wait
//! for it. The synchronous half of startup only rewrites a `recording` status
//! to `interrupted`, which is a manifest-sized operation.
use crate::{
    f1_session,
    session_format::{
        self, FrameStreamReader, RecoveryOutcome, RecoveryRecordV1, SessionManifestV1,
        SessionStatus, FRAME_FILE_NAME,
    },
};
use serde::Serialize;
use std::{
    fs::{self, File},
    io::{self, BufReader},
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

/// Bounds one startup sweep's directory work, matching `session_store`.
pub const MAX_SCANNED_DIRECTORIES: usize = 2000;

#[derive(Debug, Clone, Default, Serialize)]
pub struct RecoveryStatus {
    /// Sessions whose manifest still said `recording` at startup and were
    /// reclassified as interrupted.
    pub reclassified: u64,
    /// Interrupted sessions waiting for, or currently undergoing, a scan.
    pub pending: u64,
    pub scanned: u64,
    pub complete: u64,
    pub truncated: u64,
    pub damaged: u64,
    pub unreadable: u64,
    /// Frames recovered beyond what the interrupted manifests claimed. This is
    /// the number that says what recovery was worth.
    pub recovered_frames: u64,
    pub running: bool,
    pub last_session_id: Option<String>,
    pub last_error: Option<String>,
    /// F1 25 sessions (V2.0 Phase D), counted apart: their files are
    /// different and so is what "recovered" means for them.
    pub f1: F1RecoveryCounts,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct F1RecoveryCounts {
    pub reclassified: u64,
    pub pending: u64,
    pub scanned: u64,
    pub complete: u64,
    pub truncated: u64,
    pub damaged: u64,
    pub unreadable: u64,
}

/// Reads one session's frame stream and reports what is readable. Never writes.
///
/// The scan is streaming and bounded to one record of memory, so a frame file
/// of any size costs the same.
pub fn scan_frame_stream(directory: &Path) -> RecoveryRecordV1 {
    let mut record = RecoveryRecordV1::pending();
    record.scanned_at_unix_ms = Some(unix_ms());
    let path = directory.join(FRAME_FILE_NAME);
    let total_bytes = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(error) => {
            record.outcome = RecoveryOutcome::Unreadable;
            record.detail = Some(format!("The frame stream could not be opened: {error}"));
            record.unreadable_tail_bytes = total_bytes;
            return record;
        }
    };
    let mut reader = match FrameStreamReader::new(BufReader::new(file)) {
        Ok(reader) => reader,
        Err(error) => {
            record.outcome = RecoveryOutcome::Unreadable;
            record.detail = Some(format!("The frame stream header is unreadable: {error}"));
            record.unreadable_tail_bytes = total_bytes;
            return record;
        }
    };
    let mut first_ms: Option<u64> = None;
    let mut last_ms: u64 = 0;
    let mut damage: Option<String> = None;
    loop {
        match reader.next_frame_lossy() {
            Ok(Some(frame)) => {
                record.readable_frame_count += 1;
                if frame.frame.active {
                    record.readable_active_frame_count += 1;
                }
                first_ms.get_or_insert(frame.monotonic_ms);
                last_ms = frame.monotonic_ms;
            }
            Ok(None) => break,
            // Damage in the middle of the file, as opposed to a file that
            // stops. Everything already counted stays counted.
            Err(error) => {
                damage = Some(error.to_string());
                break;
            }
        }
    }
    record.readable_duration_us = first_ms
        .map(|first| last_ms.saturating_sub(first).saturating_mul(1000))
        .unwrap_or_default();
    record.frame_stream_complete = reader.end.is_some();
    record.outcome = match (&damage, reader.end.is_some(), reader.truncated_tail) {
        (Some(_), _, _) => RecoveryOutcome::Damaged,
        (None, true, _) => RecoveryOutcome::Complete,
        // No footer is the ordinary shape of a crashed recording, whether or
        // not the final record happened to land on a record boundary.
        (None, false, _) => RecoveryOutcome::Truncated,
    };
    record.detail = damage.or_else(|| match record.outcome {
        RecoveryOutcome::Truncated if reader.truncated_tail => Some(
            "The recording stops part-way through its final frame; every earlier frame is intact."
                .into(),
        ),
        RecoveryOutcome::Truncated => Some(
            "The recording has no end marker, so RaceLab did not finish it; every frame it holds is intact."
                .into(),
        ),
        _ => None,
    });
    record
}

/// Applies a completed scan to a manifest, in memory.
///
/// The counts a crashed manifest carries are a *checkpoint*, and a checkpoint
/// can only ever under-report. Raising them to what the file actually holds is
/// therefore never a loss of information, and it is guarded so it can only ever
/// raise: a manifest that already reports more than the scan could read keeps
/// its own number, and the disagreement stays visible in the recovery record.
///
/// `status` is never changed. An interrupted session stays interrupted and
/// never gains a summary, whatever the scan found.
pub fn apply_recovery(manifest: &mut SessionManifestV1, recovery: RecoveryRecordV1) -> u64 {
    let recovered = recovery
        .readable_frame_count
        .saturating_sub(manifest.frame_count);
    if recovery.readable_frame_count > manifest.frame_count {
        manifest.frame_count = recovery.readable_frame_count;
        manifest.active_frame_count = recovery.readable_active_frame_count;
        manifest.inactive_frame_count = recovery
            .readable_frame_count
            .saturating_sub(recovery.readable_active_frame_count);
    }
    if recovery.readable_duration_us > manifest.duration_us {
        manifest.duration_us = recovery.readable_duration_us;
        if let Some(started) = manifest.started_at_unix_ms {
            manifest.ended_at_unix_ms =
                Some(started.saturating_add(recovery.readable_duration_us / 1000));
        }
    }
    // Incomplete data never presents itself as a finished session.
    manifest.summary = None;
    manifest.recovery = Some(recovery);
    recovered
}

/// Synchronous startup pass. Manifest-sized work only: a session still marked
/// `recording` belongs to a process that never finished, so it is reclassified
/// as interrupted and marked as awaiting a scan.
///
/// This replaces `session_recorder::classify_interrupted_sessions`, adding the
/// pending recovery marker. It deliberately does not read a single frame.
pub fn classify_interrupted_sessions(root: &Path) -> Result<u64, String> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(format!("Could not read the sessions directory: {error}")),
    };
    let mut reclassified = 0;
    for entry in entries.flatten().take(MAX_SCANNED_DIRECTORIES) {
        let directory = entry.path();
        if !directory.is_dir() {
            continue;
        }
        let Ok(mut manifest) = session_format::read_manifest(&directory) else {
            continue; // One unreadable session must never block the others.
        };
        if manifest.status != SessionStatus::Recording {
            continue;
        }
        manifest.status = SessionStatus::Interrupted;
        manifest.summary = None;
        manifest.completion_reason = Some("interrupted_racelab_did_not_finalize".into());
        if manifest.ended_at_unix_ms.is_none() {
            manifest.ended_at_unix_ms = manifest
                .started_at_unix_ms
                .map(|started| started.saturating_add(manifest.duration_us / 1000));
        }
        manifest.recovery = Some(RecoveryRecordV1::pending());
        if session_format::write_manifest_atomically(&directory, &manifest).is_ok() {
            reclassified += 1;
        }
    }
    Ok(reclassified)
}

/// Which interrupted sessions still need a scan, oldest first.
///
/// A session whose recovery record is already finished is not rescanned: the
/// frame stream cannot change, so the answer cannot either.
fn sessions_awaiting_scan(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut pending: Vec<(u64, PathBuf)> = entries
        .flatten()
        .take(MAX_SCANNED_DIRECTORIES)
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .filter_map(|path| {
            let manifest = session_format::read_manifest(&path).ok()?;
            if manifest.status != SessionStatus::Interrupted {
                return None;
            }
            match &manifest.recovery {
                Some(recovery) if recovery.outcome != RecoveryOutcome::Pending => None,
                _ => Some((manifest.started_at_unix_ms.unwrap_or(0), path)),
            }
        })
        .collect();
    pending.sort();
    pending.into_iter().map(|(_, path)| path).collect()
}

/// Owns the recovery worker thread.
pub struct RecoveryService {
    root: PathBuf,
    status: Arc<Mutex<RecoveryStatus>>,
    stop: Arc<AtomicBool>,
    wake: mpsc::SyncSender<()>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl RecoveryService {
    /// Runs the synchronous reclassification immediately, then starts the
    /// worker that scans frame streams in the background.
    pub fn start(root: PathBuf) -> Result<Arc<Self>, String> {
        let mut status = RecoveryStatus::default();
        match classify_interrupted_sessions(&root) {
            Ok(reclassified) => status.reclassified = reclassified,
            Err(error) => status.last_error = Some(error),
        }
        match f1_session::classify_interrupted_sessions(&root) {
            Ok(reclassified) => status.f1.reclassified = reclassified,
            Err(error) => status.last_error = Some(error),
        }
        let status = Arc::new(Mutex::new(status));
        let stop = Arc::new(AtomicBool::new(false));
        // One slot: a second request while one is queued is the same request.
        let (wake, wakeups) = mpsc::sync_channel(1);
        let worker_root = root.clone();
        let worker_status = Arc::clone(&status);
        let worker_stop = Arc::clone(&stop);
        let worker = thread::Builder::new()
            .name("session-recovery".into())
            .spawn(move || loop {
                if worker_stop.load(Ordering::Acquire) {
                    return;
                }
                run_sweep(&worker_root, &worker_status, &worker_stop);
                match wakeups.recv_timeout(Duration::from_secs(3600)) {
                    Ok(()) => {}
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            })
            .map_err(|error| format!("Could not start session recovery: {error}"))?;
        Ok(Arc::new(Self {
            root,
            status,
            stop,
            wake,
            worker: Mutex::new(Some(worker)),
        }))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn status(&self) -> RecoveryStatus {
        lock(&self.status).clone()
    }

    /// Ask for another sweep. Never blocks and never fails: a request that
    /// finds the single slot full is already represented by the queued one.
    pub fn request_sweep(&self) {
        let _ = self.wake.try_send(());
    }

    /// Stops after the frame currently being read. A 1 GB scan must not hold
    /// application exit open, so the worker checks the flag between records.
    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::Release);
        let _ = self.wake.try_send(());
        if let Some(worker) = lock(&self.worker).take() {
            let _ = worker.join();
        }
    }
}

impl Drop for RecoveryService {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn run_sweep(root: &Path, status: &Arc<Mutex<RecoveryStatus>>, stop: &Arc<AtomicBool>) {
    let pending = sessions_awaiting_scan(root);
    {
        let mut status = lock(status);
        status.pending = pending.len() as u64;
        status.running = !pending.is_empty();
    }
    for directory in pending {
        if stop.load(Ordering::Acquire) {
            break;
        }
        let Ok(mut manifest) = session_format::read_manifest(&directory) else {
            // Disappeared or became unreadable between the listing and now.
            let mut status = lock(status);
            status.pending = status.pending.saturating_sub(1);
            continue;
        };
        let recovery = scan_frame_stream(&directory);
        let outcome = recovery.outcome;
        let recovered = apply_recovery(&mut manifest, recovery);
        let written = session_format::write_manifest_atomically(&directory, &manifest);
        let mut status = lock(status);
        status.pending = status.pending.saturating_sub(1);
        status.last_session_id = Some(manifest.session_id.clone());
        match written {
            Ok(()) => {
                status.scanned += 1;
                status.recovered_frames += recovered;
                match outcome {
                    RecoveryOutcome::Complete => status.complete += 1,
                    RecoveryOutcome::Truncated => status.truncated += 1,
                    RecoveryOutcome::Damaged => status.damaged += 1,
                    RecoveryOutcome::Unreadable => status.unreadable += 1,
                    RecoveryOutcome::Pending => {}
                }
            }
            // The scan is still correct; only recording it failed. It will be
            // retried on the next sweep because the manifest still says pending.
            Err(error) => {
                status.last_error = Some(format!(
                    "Could not record recovery for {}: {error}",
                    manifest.session_id
                ));
            }
        }
    }
    run_f1_sweep(root, status, stop);
    lock(status).running = false;
}

/// F1 25's half of a sweep: each pending interrupted F1 session is scanned
/// once and its finding recorded. Files are read, never repaired.
fn run_f1_sweep(root: &Path, status: &Arc<Mutex<RecoveryStatus>>, stop: &Arc<AtomicBool>) {
    let pending = f1_session::sessions_awaiting_scan(root);
    lock(status).f1.pending = pending.len() as u64;
    for directory in pending {
        if stop.load(Ordering::Acquire) {
            break;
        }
        let outcome = f1_session::recover_session(&directory);
        let mut status = lock(status);
        status.f1.pending = status.f1.pending.saturating_sub(1);
        match outcome {
            Ok(outcome) => {
                status.f1.scanned += 1;
                match outcome {
                    RecoveryOutcome::Complete => status.f1.complete += 1,
                    RecoveryOutcome::Truncated => status.f1.truncated += 1,
                    RecoveryOutcome::Damaged => status.f1.damaged += 1,
                    RecoveryOutcome::Unreadable => status.f1.unreadable += 1,
                    RecoveryOutcome::Pending => {}
                }
            }
            Err(error) => {
                status.last_error = Some(format!(
                    "Could not record recovery for {}: {error}",
                    directory.display()
                ));
            }
        }
    }
}
