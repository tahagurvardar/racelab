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
    session_retention::SessionProtection,
};
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
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

/// How many finished jobs the ledger remembers. In-flight jobs are additionally
/// bounded by the queue itself, so total memory is bounded whatever happens.
/// Finished records exist so a *failure* survives long enough to be read by the
/// UI; a success is already represented by `analysis.json` on disk.
pub const JOB_LEDGER_CAPACITY: usize = 64;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

/// Where one session's analysis job is in its life.
///
/// `Queued` and `Analyzing` are kept apart deliberately. V0.9 collapsed both
/// into one "pending" state, which meant a session waiting behind a long
/// analysis was indistinguishable from one being analyzed, and a user watching
/// a session sit at "in progress" for a minute had no way to tell whether
/// anything was wrong. They are different facts and the product states both.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Analyzing,
    Succeeded,
    Failed,
}

impl JobState {
    /// A job holding a session open. Retention must not delete one of these,
    /// and the session's analysis state is "coming" rather than "absent".
    pub fn in_flight(self) -> bool {
        matches!(self, Self::Queued | Self::Analyzing)
    }
}

/// Bounded per-session diagnostics. Every duration here is a wall-clock
/// measurement of this process, never anything read off a file.
#[derive(Debug, Clone, Serialize)]
pub struct JobRecord {
    pub session_id: String,
    pub state: JobState,
    pub requested_at_unix_ms: u64,
    /// When the worker picked the job up. `None` while still queued.
    pub started_at_unix_ms: Option<u64>,
    pub finished_at_unix_ms: Option<u64>,
    /// Time spent waiting for the worker. Measured live while queued, so a
    /// session that has been waiting thirty seconds says thirty seconds.
    pub queued_ms: u64,
    /// Time spent analyzing, excluding the wait. `None` until the job ends.
    pub analysis_duration_ms: Option<u64>,
    /// Present only for `Failed`, and written for a reader rather than a log.
    pub failure_reason: Option<String>,
}

impl JobRecord {
    /// A job that has been accepted into the queue and not yet started.
    /// Public so a test can state the job state it is exercising directly,
    /// rather than racing a real worker to observe one.
    pub fn queued(session_id: &str, requested_at_unix_ms: u64) -> Self {
        Self {
            session_id: session_id.to_string(),
            state: JobState::Queued,
            requested_at_unix_ms,
            started_at_unix_ms: None,
            finished_at_unix_ms: None,
            queued_ms: 0,
            analysis_duration_ms: None,
            failure_reason: None,
        }
    }

    /// A job the worker has picked up.
    pub fn analyzing(session_id: &str, requested_at_unix_ms: u64, queued_ms: u64) -> Self {
        Self {
            state: JobState::Analyzing,
            started_at_unix_ms: Some(requested_at_unix_ms.saturating_add(queued_ms)),
            queued_ms,
            ..Self::queued(session_id, requested_at_unix_ms)
        }
    }

    /// A job that ran and did not produce an analysis.
    pub fn failed(session_id: &str, reason: &str) -> Self {
        Self {
            state: JobState::Failed,
            finished_at_unix_ms: Some(0),
            analysis_duration_ms: Some(0),
            failure_reason: Some(reason.to_string()),
            ..Self::queued(session_id, 0)
        }
    }

    /// A queued job's wait is still growing, so it is reported as of now.
    fn observed(mut self, now: u64) -> Self {
        if self.state == JobState::Queued {
            self.queued_ms = now.saturating_sub(self.requested_at_unix_ms);
        }
        self
    }
}

/// Bounded map of session id to job record, with the oldest *finished* record
/// evicted first. An in-flight record is never evicted: losing one would make
/// a running analysis look as though it had never been requested.
#[derive(Default)]
struct Ledger {
    records: HashMap<String, JobRecord>,
    /// Finished session ids, oldest first.
    finished: VecDeque<String>,
}

impl Ledger {
    fn insert_queued(&mut self, session_id: &str, requested_at_unix_ms: u64) {
        self.records.insert(
            session_id.to_string(),
            JobRecord::queued(session_id, requested_at_unix_ms),
        );
        // A re-request replaces a previous terminal record for the same id.
        self.finished.retain(|id| id != session_id);
    }

    fn remove(&mut self, session_id: &str) {
        self.records.remove(session_id);
        self.finished.retain(|id| id != session_id);
    }

    fn edit(&mut self, session_id: &str, edit: impl FnOnce(&mut JobRecord)) {
        if let Some(record) = self.records.get_mut(session_id) {
            edit(record);
        }
    }

    fn finish(&mut self, session_id: &str) {
        self.finished.push_back(session_id.to_string());
        while self.finished.len() > JOB_LEDGER_CAPACITY {
            if let Some(oldest) = self.finished.pop_front() {
                self.records.remove(&oldest);
            }
        }
    }

    fn in_flight(&self) -> usize {
        self.records
            .values()
            .filter(|record| record.state.in_flight())
            .count()
    }
}

/// Told when a job finishes, whatever its outcome.
///
/// The one implementation is retention: a finished analysis releases a session
/// it was protecting, so the storage budget can be reconsidered. The call runs
/// on the analysis worker thread and must return immediately.
pub trait AnalysisJobObserver: Send + Sync {
    fn job_finished(&self, session_id: &str, state: JobState);
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
    /// In-flight entries are bounded by the queue capacity plus the one being
    /// analyzed; finished entries by `JOB_LEDGER_CAPACITY`.
    ledger: Mutex<Ledger>,
    status: Mutex<AnalysisRunnerStatus>,
    observer: Mutex<Option<Arc<dyn AnalysisJobObserver>>>,
}

impl Shared {
    /// Edits the status counters only. It deliberately does **not** read
    /// `ledger`: some callers already hold that lock, and a `Mutex` is not
    /// reentrant. The pending count is filled in by `status()`, which holds
    /// neither lock when it starts.
    fn update(&self, edit: impl FnOnce(&mut AnalysisRunnerStatus)) {
        let mut status = lock(&self.status);
        edit(&mut status);
        status.queue_capacity = ANALYSIS_QUEUE_CAPACITY;
    }

    fn notify(&self, session_id: &str, state: JobState) {
        let observer = lock(&self.observer).clone();
        if let Some(observer) = observer {
            observer.job_finished(session_id, state);
        }
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
            ledger: Mutex::new(Ledger::default()),
            status: Mutex::new(AnalysisRunnerStatus {
                queue_capacity: ANALYSIS_QUEUE_CAPACITY,
                ..AnalysisRunnerStatus::default()
            }),
            observer: Mutex::new(None),
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

    /// Attach the post-job observer once, before telemetry starts flowing.
    pub fn attach_observer(&self, observer: Arc<dyn AnalysisJobObserver>) -> Result<(), String> {
        let mut slot = lock(&self.shared.observer);
        if slot.is_some() {
            return Err("An analysis job observer is already attached".into());
        }
        *slot = Some(observer);
        Ok(())
    }

    pub fn status(&self) -> AnalysisRunnerStatus {
        let mut status = lock(&self.shared.status).clone();
        status.pending = lock(&self.shared.ledger).in_flight();
        status.queue_capacity = ANALYSIS_QUEUE_CAPACITY;
        status
    }

    /// This session's job, if this process still remembers one.
    ///
    /// `None` is not "never analyzed": a session analyzed by an earlier run of
    /// RaceLab has its result on disk and no ledger entry here. The two are
    /// combined in `session_store::get_session_analysis`, which is the only
    /// place that decides what a session's analysis state actually is.
    pub fn job(&self, session_id: &str) -> Option<JobRecord> {
        lock(&self.shared.ledger)
            .records
            .get(session_id)
            .cloned()
            .map(|record| record.observed(unix_ms()))
    }

    /// Is this session queued or currently being analyzed?
    pub fn is_pending(&self, session_id: &str) -> bool {
        lock(&self.shared.ledger)
            .records
            .get(session_id)
            .is_some_and(|record| record.state.in_flight())
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
        let requested_at_unix_ms = unix_ms();
        {
            let mut ledger = lock(&self.shared.ledger);
            // Already queued or running: the second request is the first one.
            if ledger
                .records
                .get(session_id)
                .is_some_and(|record| record.state.in_flight())
            {
                self.shared.update(|status| status.rejected_requests += 1);
                return false;
            }
            ledger.insert_queued(session_id, requested_at_unix_ms);
        }
        let job = Job {
            session_id: session_id.to_string(),
            requested_at_unix_ms,
        };
        let queued = lock(&self.sender)
            .as_ref()
            .is_some_and(|sender| sender.try_send(job).is_ok());
        if !queued {
            // The refusal is recorded as a failed job rather than erased, so a
            // session refused by a full queue reports *why* it has no analysis
            // instead of looking as though nothing was ever attempted.
            let mut ledger = lock(&self.shared.ledger);
            ledger.edit(session_id, |record| {
                record.state = JobState::Failed;
                record.finished_at_unix_ms = Some(unix_ms());
                record.failure_reason = Some(
                    "The analysis queue was full when this session finished, so it was not analyzed."
                        .into(),
                );
            });
            ledger.finish(session_id);
            drop(ledger);
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

    /// Forget this session's job record. Used when a session is deleted, so a
    /// stale record can never describe something that is no longer on disk.
    pub fn forget(&self, session_id: &str) {
        lock(&self.shared.ledger).remove(session_id);
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

/// A session queued for analysis, or being analyzed, must survive long enough
/// to be analyzed. Retention asks this before every deletion.
impl SessionProtection for AnalysisRunner {
    fn is_protected(&self, session_id: &str) -> bool {
        self.is_pending(session_id)
    }

    fn protection_reason(&self) -> &'static str {
        "queued for or undergoing analysis"
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
        let started_at_unix_ms = unix_ms();
        let queued_ms = started_at_unix_ms.saturating_sub(requested_at_unix_ms);
        // Visible before the work starts, so a session being analyzed says so
        // rather than continuing to claim it is waiting in a queue.
        lock(&shared.ledger).edit(&session_id, |record| {
            record.state = JobState::Analyzing;
            record.started_at_unix_ms = Some(started_at_unix_ms);
            record.queued_ms = queued_ms;
        });
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
        let state = if outcome.is_ok() {
            JobState::Succeeded
        } else {
            JobState::Failed
        };
        {
            let mut ledger = lock(&shared.ledger);
            let failure = outcome.as_ref().err().cloned();
            ledger.edit(&session_id, |record| {
                record.state = state;
                record.finished_at_unix_ms = Some(unix_ms());
                record.analysis_duration_ms = Some(elapsed_ms);
                record.failure_reason = failure;
            });
            ledger.finish(&session_id);
        }
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
        // Last, and outside every lock: the session is no longer in flight, so
        // whatever was holding it open may now let go.
        shared.notify(&session_id, state);
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
    // Only a session whose frames are safe to read is read.
    //
    // A completed session always qualifies. An interrupted one qualifies only
    // once a recovery scan has established that it holds a readable prefix, and
    // a session still being recorded never qualifies: its frame file is open
    // and growing, so any analysis of it would describe a moment that has
    // already passed.
    let manifest = crate::session_format::read_manifest(&directory)
        .map_err(|error| format!("Could not read the session manifest: {error}"))?;
    if !manifest.has_analyzable_coverage() {
        return Err(match manifest.status {
            crate::session_format::SessionStatus::Recording => {
                "This session is still being recorded and cannot be analyzed yet.".into()
            }
            _ => "This session has no safely readable frames to analyze.".to_string(),
        });
    }
    let mut analysis = analysis_engine::analyze_session_directory(&directory, config)
        .map_err(|error| format!("Could not analyze the frame stream: {error}"))?;
    if let Some(timing) = timing {
        analysis.requested_at_unix_ms = Some(timing.requested_at_unix_ms);
        analysis.queued_ms = Some(timing.queued_ms);
    }
    analysis::write_analysis_atomically(&directory, &analysis)
        .map_err(|error| format!("Could not write the analysis: {error}"))
}
