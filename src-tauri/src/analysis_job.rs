//! Background analysis jobs.
//!
//! Analysis is the last step of a session's life and it must never be on the
//! path of anything that is. Four properties are structural rather than
//! best-effort:
//!
//! 1. **UDP ingestion never waits.** Ingestion hands frames to the recorder
//!    through the existing bounded, drop-newest queue and never touches this
//!    module at all.
//! 2. **The recorder never waits.** The completion notification is a
//!    `try_send` on a bounded queue, issued by the writer thread *after* the
//!    session's manifest and frame stream are already final on disk.
//! 3. **The queue is bounded.** `ANALYSIS_QUEUE_CAPACITY` jobs; a request that
//!    does not fit is counted and refused, never buffered without limit and
//!    never allowed to block the caller.
//! 4. **Failure is inert.** A job that fails writes nothing — the atomic write
//!    means a partial file never appears — records the error in this module's
//!    own status, and leaves the completed session exactly as it was.
//!
//! Nothing here runs at startup: RaceLab does not analyze historical sessions
//! on launch. An old session is analyzed only if something explicitly asks.
use crate::{
    analysis::{self, AnalysisConfigV1},
    analysis_engine,
    session_format::is_safe_session_id,
    session_recorder::SessionCompletionHook,
};
use serde::Serialize;
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex, MutexGuard,
    },
    thread::{self, JoinHandle},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

/// Queue slots. A session takes well under a second to analyze, so anything
/// deeper than this would only be hiding a real problem.
pub const ANALYSIS_QUEUE_CAPACITY: usize = 8;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct AnalysisRunnerStatus {
    /// Requested and not yet finished, including the one being analyzed.
    pub pending: usize,
    pub queue_capacity: usize,
    pub analyzed_sessions: u64,
    pub failed_sessions: u64,
    /// Requests refused because the queue was full, or because the session was
    /// already queued. Counted so a silent drop is impossible.
    pub rejected_requests: u64,
    pub last_session_id: Option<String>,
    /// Wall time the last analysis spent *analyzing*, excluding queue wait.
    pub last_duration_ms: Option<u64>,
    /// Wall time the last analysis spent *waiting* to start. One worker runs
    /// jobs in order, so a short session finishing behind a long one waits for
    /// it. That is the queue working as designed, and reporting it separately
    /// is what stops it looking like a slow analyzer.
    pub last_queued_ms: Option<u64>,
    /// Longest queue wait this process has seen.
    pub max_queued_ms: u64,
    pub last_error: Option<String>,
}

/// The only message the worker takes. There is deliberately no shutdown
/// *message*: shutting down drops the sender instead, so the worker always
/// drains whatever is already queued and then sees the channel disconnect. A
/// shutdown signal that had to fit through a bounded queue could not be
/// delivered when that queue was full, which would hang the join.
struct Job {
    session_id: String,
    /// When the completed session was handed to the runner.
    requested_at_unix_ms: u64,
}

struct Shared {
    root: PathBuf,
    config: AnalysisConfigV1,
    /// Bounded by the queue capacity plus the one in flight.
    pending: Mutex<HashSet<String>>,
    status: Mutex<AnalysisRunnerStatus>,
}

impl Shared {
    /// Edits the status counters only. It deliberately does **not** read
    /// `pending`: some callers already hold that lock, and a `Mutex` is not
    /// reentrant. `pending` is filled in by `status()`, which holds neither
    /// lock when it starts.
    fn update(&self, edit: impl FnOnce(&mut AnalysisRunnerStatus)) {
        let mut status = lock(&self.status);
        edit(&mut status);
        status.queue_capacity = ANALYSIS_QUEUE_CAPACITY;
    }
}

/// Owns the analysis worker thread. One thread, one bounded queue.
pub struct AnalysisRunner {
    /// Taken on shutdown. Dropping the last sender is what stops the worker.
    sender: Mutex<Option<SyncSender<Job>>>,
    shared: Arc<Shared>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl AnalysisRunner {
    pub fn new(root: PathBuf, config: AnalysisConfigV1) -> Result<Arc<Self>, String> {
        let shared = Arc::new(Shared {
            root,
            config,
            pending: Mutex::new(HashSet::new()),
            status: Mutex::new(AnalysisRunnerStatus {
                queue_capacity: ANALYSIS_QUEUE_CAPACITY,
                ..AnalysisRunnerStatus::default()
            }),
        });
        let (sender, receiver) = mpsc::sync_channel(ANALYSIS_QUEUE_CAPACITY);
        let worker_shared = Arc::clone(&shared);
        let worker = thread::Builder::new()
            .name("session-analysis".into())
            .spawn(move || run_worker(receiver, worker_shared))
            .map_err(|error| format!("Could not start the session analyzer: {error}"))?;
        Ok(Arc::new(Self {
            sender: Mutex::new(Some(sender)),
            shared,
            worker: Mutex::new(Some(worker)),
        }))
    }

    pub fn config(&self) -> AnalysisConfigV1 {
        self.shared.config
    }

    pub fn status(&self) -> AnalysisRunnerStatus {
        let mut status = lock(&self.shared.status).clone();
        status.pending = lock(&self.shared.pending).len();
        status.queue_capacity = ANALYSIS_QUEUE_CAPACITY;
        status
    }

    /// Is this session queued or currently being analyzed? The UI uses this to
    /// show a genuine "pending" state instead of pretending an analysis that
    /// has not run yet found nothing.
    pub fn is_pending(&self, session_id: &str) -> bool {
        lock(&self.shared.pending).contains(session_id)
    }

    /// Queue a session. **Never blocks and never fails loudly**: a full queue
    /// or a duplicate request is counted and refused, because nothing about
    /// analysis may interfere with recording.
    pub fn request(&self, session_id: &str) -> bool {
        if !is_safe_session_id(session_id) {
            self.shared.update(|status| {
                status.rejected_requests += 1;
                status.last_error = Some("Session identifier is not usable".into());
            });
            return false;
        }
        {
            let mut pending = lock(&self.shared.pending);
            if pending.contains(session_id) {
                self.shared.update(|status| status.rejected_requests += 1);
                return false;
            }
            pending.insert(session_id.to_string());
        }
        let job = Job {
            session_id: session_id.to_string(),
            requested_at_unix_ms: unix_ms(),
        };
        let queued = lock(&self.sender)
            .as_ref()
            .is_some_and(|sender| sender.try_send(job).is_ok());
        if !queued {
            lock(&self.shared.pending).remove(session_id);
            self.shared.update(|status| {
                status.rejected_requests += 1;
                status.last_error = Some(format!(
                    "The analysis queue is full; session {session_id} was not analyzed"
                ));
            });
            return false;
        }
        true
    }

    /// Drops the sender, then joins. Everything already queued still runs;
    /// the worker stops when the channel disconnects, which it always does.
    pub fn shutdown(&self) {
        let _ = lock(&self.sender).take();
        if let Some(worker) = lock(&self.worker).take() {
            let _ = worker.join();
        }
    }
}

impl Drop for AnalysisRunner {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// The recorder's completion notification. This runs on the recorder's writer
/// thread, so it does exactly one bounded `try_send` and returns.
impl SessionCompletionHook for AnalysisRunner {
    fn session_completed(&self, session_id: &str, _directory: &Path) {
        self.request(session_id);
    }
}

fn run_worker(receiver: Receiver<Job>, shared: Arc<Shared>) {
    while let Ok(job) = receiver.recv() {
        let Job {
            session_id,
            requested_at_unix_ms,
        } = job;
        let started = Instant::now();
        // Queue wait, measured before any work begins. The two numbers answer
        // different questions and must never be summed into one.
        let queued_ms = unix_ms().saturating_sub(requested_at_unix_ms);
        let outcome = analyze_with_timing(
            &shared.root,
            &session_id,
            shared.config,
            Some(JobTiming {
                requested_at_unix_ms,
                queued_ms,
            }),
        );
        let elapsed_ms = started.elapsed().as_millis() as u64;
        lock(&shared.pending).remove(&session_id);
        match outcome {
            Ok(()) => shared.update(|status| {
                status.analyzed_sessions += 1;
                status.last_session_id = Some(session_id.clone());
                status.last_duration_ms = Some(elapsed_ms);
                status.last_queued_ms = Some(queued_ms);
                status.max_queued_ms = status.max_queued_ms.max(queued_ms);
                status.last_error = None;
            }),
            Err(message) => {
                // Observable, and nothing more: the session stays completed and
                // no analysis file was written.
                eprintln!("Session analysis failed for {session_id}: {message}");
                shared.update(|status| {
                    status.failed_sessions += 1;
                    status.last_session_id = Some(session_id.clone());
                    status.last_duration_ms = Some(elapsed_ms);
                    status.last_queued_ms = Some(queued_ms);
                    status.max_queued_ms = status.max_queued_ms.max(queued_ms);
                    status.last_error = Some(message);
                });
            }
        }
    }
}

/// How long a job waited before it ran. Recorded in the analysis document so a
/// long gap between a session ending and its analysis appearing can be read as
/// what it is — a queue observation — without re-deriving it from file times.
#[derive(Debug, Clone, Copy)]
pub struct JobTiming {
    pub requested_at_unix_ms: u64,
    pub queued_ms: u64,
}

/// Analyze one session directory and write its analysis atomically. Used by
/// the worker and directly by tests; it never touches the manifest or the
/// frame stream.
pub fn analyze_one(root: &Path, session_id: &str, config: AnalysisConfigV1) -> Result<(), String> {
    analyze_with_timing(root, session_id, config, None)
}

fn analyze_with_timing(
    root: &Path,
    session_id: &str,
    config: AnalysisConfigV1,
    timing: Option<JobTiming>,
) -> Result<(), String> {
    if !is_safe_session_id(session_id) {
        return Err("Session identifier is not usable".into());
    }
    let directory = root.join(session_id);
    let mut analysis = analysis_engine::analyze_session_directory(&directory, config)
        .map_err(|error| format!("Could not analyze the frame stream: {error}"))?;
    if let Some(timing) = timing {
        analysis.requested_at_unix_ms = Some(timing.requested_at_unix_ms);
        analysis.queued_ms = Some(timing.queued_ms);
    }
    analysis::write_analysis_atomically(&directory, &analysis)
        .map_err(|error| format!("Could not write the analysis: {error}"))
}
