//! Automatic normalized session recording. Ingestion enqueues into a bounded,
//! drop-newest queue; every byte of disk I/O happens on this module's own
//! writer thread. No `Start Recording` control exists: `SessionEngine`
//! lifecycle events alone open, continue and finalize a recording.
use crate::{
    session::Session,
    session_format::{
        self, FrameStreamEnd, FrameStreamHeader, FrameStreamWriter, SessionManifestV1,
        SessionStatus, FRAME_FILE_NAME, FRAME_FORMAT_VERSION, TELEMETRY_FRAME_SCHEMA_VERSION,
    },
    session_summary::SummaryAccumulator,
    telemetry::TelemetryFrame,
    telemetry_hub::SessionRecorderHook,
};
use serde::Serialize;
use std::{
    fs,
    io::{self},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, SyncSender},
        Arc, Mutex, MutexGuard,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// Frame slots. At 75 Hz this is roughly 55 seconds of buffered telemetry, far
/// beyond any plausible disk stall, while bounding queue memory to a few MiB.
pub const RECORDER_QUEUE_CAPACITY: usize = 4096;
/// Lifecycle slots reserved beyond the frame capacity. Frame admission is gated
/// on the frame counter alone, so a saturated frame queue can never starve a
/// session start or completion out of the channel.
pub const CONTROL_RESERVE: usize = 64;
/// While recording, the manifest is rewritten on this *elapsed-time* cadence so
/// a session lost to a crash still reports approximately how much it had
/// captured. The writer tracks its own deadline rather than relying on an idle
/// receive: continuous 60-75 Hz traffic keeps a receive timeout permanently
/// reset, which would otherwise mean checkpoints never happen during exactly
/// the sessions they exist for.
pub const CHECKPOINT_INTERVAL: Duration = Duration::from_secs(5);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or_default()
}

#[derive(Debug, Clone, Serialize)]
pub struct RecorderStatus {
    pub revision: u64,
    /// idle, recording or error.
    pub status: String,
    pub recording: bool,
    pub sessions_directory: String,
    pub session_id: Option<String>,
    pub session_directory: Option<String>,
    pub game: Option<String>,
    pub vehicle_id: Option<String>,
    pub started_at_unix_ms: Option<u64>,
    pub duration_ms: u64,
    pub frames_written: u64,
    pub active_frames: u64,
    pub inactive_frames: u64,
    pub queued_frames: usize,
    /// Drops belonging to the current (or most recent) recording only. This is
    /// what the user-facing loss warning reads: a drop in one session must not
    /// keep a later clean session looking lossy.
    pub recorder_dropped_frames: u64,
    /// Process-lifetime diagnostic total. Never drives the user-facing warning.
    pub lifetime_dropped_frames: u64,
    pub queue_capacity: usize,
    pub last_completed_session_id: Option<String>,
    pub completed_sessions: u64,
    pub last_error: Option<String>,
}

impl RecorderStatus {
    fn idle(root: &Path) -> Self {
        Self {
            revision: 0,
            status: "idle".into(),
            recording: false,
            sessions_directory: root.to_string_lossy().into_owned(),
            session_id: None,
            session_directory: None,
            game: None,
            vehicle_id: None,
            started_at_unix_ms: None,
            duration_ms: 0,
            frames_written: 0,
            active_frames: 0,
            inactive_frames: 0,
            queued_frames: 0,
            recorder_dropped_frames: 0,
            lifetime_dropped_frames: 0,
            queue_capacity: RECORDER_QUEUE_CAPACITY,
            last_completed_session_id: None,
            completed_sessions: 0,
            last_error: None,
        }
    }
}

enum Command {
    Started {
        session: Box<Session>,
        /// Sampled before admission opens, so frames dropped while the writer
        /// is still creating the directory belong to this session's count.
        dropped_at_start: u64,
    },
    Frame {
        sequence: u64,
        monotonic_ms: u64,
        frame: Arc<TelemetryFrame>,
    },
    Completed(Box<Session>),
    Shutdown,
}

/// Shared counters. `queued` is decremented by the writer, so the frame queue
/// depth is visible without inspecting the channel.
struct Admission {
    session_id: Arc<str>,
    sender: SyncSender<Command>,
    queued: Arc<AtomicUsize>,
    dropped: Arc<AtomicU64>,
    session_dropped: Arc<AtomicU64>,
}

struct Shared {
    status: Mutex<RecorderStatus>,
    queued: Arc<AtomicUsize>,
    /// Monotonic process-lifetime total. The writer derives a session's own
    /// count from it by difference, which stays correct even when a completion
    /// is finalized after the next session has already started.
    dropped: Arc<AtomicU64>,
    /// Reset to zero when a session starts; read directly by `status()`.
    session_dropped: Arc<AtomicU64>,
}

impl Shared {
    fn update(&self, edit: impl FnOnce(&mut RecorderStatus)) {
        let mut status = lock(&self.status);
        edit(&mut status);
        status.revision += 1;
    }
}

pub struct SessionRecorder {
    root: PathBuf,
    capacity: usize,
    /// Guards bounded in-memory admission only. Never held across disk I/O.
    admission: Mutex<Option<Admission>>,
    sender: SyncSender<Command>,
    worker: Mutex<Option<JoinHandle<()>>>,
    shared: Arc<Shared>,
}

impl SessionRecorder {
    pub fn new(root: PathBuf) -> Result<Arc<Self>, String> {
        Self::with_capacity(root, RECORDER_QUEUE_CAPACITY)
    }

    pub fn with_capacity(root: PathBuf, capacity: usize) -> Result<Arc<Self>, String> {
        Self::with_settings(root, capacity, CHECKPOINT_INTERVAL)
    }

    /// `checkpoint_interval` is configurable so tests can exercise the real
    /// elapsed-time checkpoint path without waiting the production cadence.
    pub fn with_settings(
        root: PathBuf,
        capacity: usize,
        checkpoint_interval: Duration,
    ) -> Result<Arc<Self>, String> {
        if capacity == 0 {
            return Err("Recorder queue capacity must be positive".into());
        }
        if checkpoint_interval.is_zero() {
            return Err("Recorder checkpoint interval must be positive".into());
        }
        fs::create_dir_all(&root)
            .map_err(|error| format!("Could not create the sessions directory: {error}"))?;
        // Startup classification runs before any listing or new recording can
        // observe a stale `recording` manifest left behind by a crash.
        let interrupted = classify_interrupted_sessions(&root);
        let queued = Arc::new(AtomicUsize::new(0));
        let dropped = Arc::new(AtomicU64::new(0));
        let session_dropped = Arc::new(AtomicU64::new(0));
        let shared = Arc::new(Shared {
            status: Mutex::new(RecorderStatus::idle(&root)),
            queued: Arc::clone(&queued),
            dropped: Arc::clone(&dropped),
            session_dropped: Arc::clone(&session_dropped),
        });
        if let Err(error) = &interrupted {
            shared.update(|status| status.last_error = Some(error.clone()));
        }
        let (sender, receiver) = mpsc::sync_channel(capacity + CONTROL_RESERVE);
        let writer_root = root.clone();
        let writer_shared = Arc::clone(&shared);
        let worker = thread::Builder::new()
            .name("session-recorder-writer".into())
            .spawn(move || run_writer(writer_root, receiver, writer_shared, checkpoint_interval))
            .map_err(|error| format!("Could not start the session writer: {error}"))?;
        Ok(Arc::new(Self {
            root,
            capacity,
            admission: Mutex::new(None),
            sender,
            worker: Mutex::new(Some(worker)),
            shared,
        }))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn status(&self) -> RecorderStatus {
        let mut status = lock(&self.shared.status);
        status.queued_frames = self.shared.queued.load(Ordering::Acquire);
        // Per-session, so a clean session after a lossy one reports zero.
        status.recorder_dropped_frames = self.shared.session_dropped.load(Ordering::Relaxed);
        status.lifetime_dropped_frames = self.shared.dropped.load(Ordering::Relaxed);
        status.queue_capacity = self.capacity;
        status.revision += 1;
        status.clone()
    }

    /// Lifecycle commands use the reserved slots. Losing one would strand a
    /// session, so a failure is recorded as a recorder error rather than
    /// silently ignored.
    fn control(&self, command: Command, what: &str) {
        if self.sender.try_send(command).is_err() {
            self.shared.update(|status| {
                status.status = "error".into();
                status.last_error = Some(format!(
                    "Session recorder could not enqueue {what}; the writer is unavailable"
                ));
            });
        }
    }

    pub fn shutdown(&self) {
        let _ = lock(&self.admission).take();
        let _ = self.sender.try_send(Command::Shutdown);
        if let Some(worker) = lock(&self.worker).take() {
            let _ = worker.join();
        }
    }
}

impl Drop for SessionRecorder {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl SessionRecorderHook for SessionRecorder {
    fn session_started(&self, session: &Session) {
        if !session_format::is_safe_session_id(&session.id) {
            self.shared.update(|status| {
                status.status = "error".into();
                status.last_error =
                    Some("Session identifier is not usable as a directory name".into());
            });
            return;
        }
        let dropped_at_start = self.shared.dropped.load(Ordering::Relaxed);
        // A new session starts clean: the user-facing loss warning must not
        // carry a previous session's drops into this one.
        self.shared.session_dropped.store(0, Ordering::Relaxed);
        *lock(&self.admission) = Some(Admission {
            session_id: session.id.as_str().into(),
            sender: self.sender.clone(),
            queued: Arc::clone(&self.shared.queued),
            dropped: Arc::clone(&self.shared.dropped),
            session_dropped: Arc::clone(&self.shared.session_dropped),
        });
        self.control(
            Command::Started {
                session: Box::new(session.clone()),
                dropped_at_start,
            },
            "a session start",
        );
    }

    fn session_completed(&self, session: &Session) {
        // Any open admission is closed here; the writer finalizes whatever
        // recording it holds, so a completion can never be stranded.
        let Some(admission) = lock(&self.admission).take() else {
            return;
        };
        if *admission.session_id != *session.id {
            // Ordered dispatch makes this impossible; surfacing it keeps a
            // future lifecycle change from silently mismatching recordings.
            self.shared.update(|status| {
                status.status = "error".into();
                status.last_error = Some(format!(
                    "Recorder completed {} while recording {}",
                    session.id, admission.session_id
                ));
            });
        }
        self.control(
            Command::Completed(Box::new(session.clone())),
            "a session completion",
        );
    }

    fn record_frame(&self, sequence: u64, monotonic_ms: u64, frame: &Arc<TelemetryFrame>) {
        let gate = lock(&self.admission);
        let Some(admission) = gate.as_ref() else {
            return;
        };
        // Bounded admission: never wait for the writer, never touch disk.
        if admission.queued.load(Ordering::Acquire) >= self.capacity {
            admission.dropped.fetch_add(1, Ordering::Relaxed);
            admission.session_dropped.fetch_add(1, Ordering::Relaxed);
            return;
        }
        admission.queued.fetch_add(1, Ordering::AcqRel);
        if admission
            .sender
            .try_send(Command::Frame {
                sequence,
                monotonic_ms,
                frame: Arc::clone(frame),
            })
            .is_err()
        {
            admission.queued.fetch_sub(1, Ordering::AcqRel);
            admission.dropped.fetch_add(1, Ordering::Relaxed);
            admission.session_dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// One open recording. Owned exclusively by the writer thread.
struct OpenSession {
    id: String,
    directory: PathBuf,
    writer: Option<FrameStreamWriter>,
    manifest: SessionManifestV1,
    summary: SummaryAccumulator,
    dropped_at_start: u64,
    write_error: Option<String>,
    monotonic_span_ms: Option<(u64, u64)>,
    dirty: bool,
}

fn run_writer(
    root: PathBuf,
    receiver: Receiver<Command>,
    shared: Arc<Shared>,
    checkpoint_interval: Duration,
) {
    let mut open: Option<OpenSession> = None;
    // Checkpointing is driven by this deadline, never by an idle receive. Under
    // continuous telemetry every `recv_timeout` returns `Ok` long before it
    // expires, so a timeout-only checkpoint would never fire while recording.
    let mut due = Instant::now() + checkpoint_interval;
    loop {
        match receiver.recv_timeout(due.saturating_duration_since(Instant::now())) {
            Ok(Command::Started {
                session,
                dropped_at_start,
            }) => {
                finalize(&mut open, &shared, None);
                open = start_session(&root, &session, dropped_at_start, &shared);
            }
            Ok(Command::Frame {
                sequence,
                monotonic_ms,
                frame,
            }) => {
                shared.queued.fetch_sub(1, Ordering::AcqRel);
                if let Some(session) = &mut open {
                    write_frame(session, sequence, monotonic_ms, &frame, &shared);
                }
            }
            Ok(Command::Completed(session)) => {
                finalize(&mut open, &shared, Some(&session));
            }
            Ok(Command::Shutdown) | Err(RecvTimeoutError::Disconnected) => {
                finalize(&mut open, &shared, None);
                return;
            }
            Err(RecvTimeoutError::Timeout) => {}
        }
        if Instant::now() >= due {
            checkpoint(&mut open, &shared);
            due = Instant::now() + checkpoint_interval;
        }
    }
}

fn start_session(
    root: &Path,
    session: &Session,
    dropped_at_start: u64,
    shared: &Arc<Shared>,
) -> Option<OpenSession> {
    let directory = root.join(&session.id);
    let started_at_unix_ms = session.started_at.unwrap_or_else(unix_ms);
    let prepared = (|| -> io::Result<(FrameStreamWriter, SessionManifestV1)> {
        fs::create_dir_all(&directory)?;
        let writer = FrameStreamWriter::create(
            &directory,
            &FrameStreamHeader {
                frame_format_version: FRAME_FORMAT_VERSION,
                telemetry_frame_schema_version: TELEMETRY_FRAME_SCHEMA_VERSION,
                session_id: session.id.clone(),
                started_at_unix_ms,
            },
        )?;
        let mut manifest = SessionManifestV1::new(session.id.clone(), Some(started_at_unix_ms));
        manifest.game = session.game.clone();
        manifest.protocol = session.game.clone();
        manifest.vehicle_id = session.vehicle_id.clone();
        session_format::write_manifest_atomically(&directory, &manifest)?;
        Ok((writer, manifest))
    })();
    match prepared {
        Ok((writer, manifest)) => {
            shared.update(|status| {
                status.status = "recording".into();
                status.recording = true;
                status.session_id = Some(session.id.clone());
                status.session_directory = Some(directory.to_string_lossy().into_owned());
                status.game = session.game.clone();
                status.vehicle_id = session.vehicle_id.clone();
                status.started_at_unix_ms = Some(started_at_unix_ms);
                status.duration_ms = 0;
                status.frames_written = 0;
                status.active_frames = 0;
                status.inactive_frames = 0;
                status.last_error = None;
            });
            Some(OpenSession {
                id: session.id.clone(),
                directory,
                writer: Some(writer),
                manifest,
                summary: SummaryAccumulator::default(),
                dropped_at_start,
                write_error: None,
                monotonic_span_ms: None,
                dirty: false,
            })
        }
        Err(error) => {
            shared.update(|status| {
                status.status = "error".into();
                status.recording = false;
                status.session_id = Some(session.id.clone());
                status.last_error = Some(format!("Could not open the session recording: {error}"));
            });
            None
        }
    }
}

fn write_frame(
    session: &mut OpenSession,
    sequence: u64,
    monotonic_ms: u64,
    frame: &TelemetryFrame,
    shared: &Arc<Shared>,
) {
    let Some(writer) = session.writer.as_mut() else {
        return;
    };
    if let Err(error) = writer.write(sequence, monotonic_ms, frame) {
        // Keep the session open and keep draining: the completion command still
        // has to finalize an honest, clearly incomplete manifest.
        let message = format!("Session frame write failed: {error}");
        session.write_error = Some(message.clone());
        session.writer = None;
        shared.update(|status| {
            status.status = "error".into();
            status.last_error = Some(message);
        });
        return;
    }
    session.manifest.frame_count += 1;
    if frame.active {
        session.manifest.active_frame_count += 1;
    } else {
        session.manifest.inactive_frame_count += 1;
    }
    // `SessionEngine` may not have identified the vehicle yet when the session
    // started, so a checkpointed (and therefore an interrupted) manifest picks
    // it up from the stream. Finalization still overwrites this from the
    // authoritative completed session.
    if session.manifest.vehicle_id.is_none() {
        session.manifest.vehicle_id = frame.vehicle_id.clone();
    }
    if session.manifest.game.is_none() {
        session.manifest.game = frame.game.clone();
        session.manifest.protocol = frame.game.clone();
    }
    session.summary.observe(frame, monotonic_ms);
    session.monotonic_span_ms = Some(match session.monotonic_span_ms {
        Some((first, _)) => (first, monotonic_ms),
        None => (monotonic_ms, monotonic_ms),
    });
    session.dirty = true;
    let frames = session.manifest.frame_count;
    let active = session.manifest.active_frame_count;
    let inactive = session.manifest.inactive_frame_count;
    // Live elapsed duration from the same monotonic frame span the manifest
    // uses. No wall clock, no disk read and no extra timer: the writer already
    // owns this value on every frame.
    let elapsed_ms = observed_duration_ms(session);
    let vehicle = session.manifest.vehicle_id.clone();
    shared.update(|status| {
        status.frames_written = frames;
        status.active_frames = active;
        status.inactive_frames = inactive;
        status.duration_ms = elapsed_ms;
        if status.vehicle_id.is_none() {
            status.vehicle_id = vehicle;
        }
    });
}

/// Monotonic frame span; the only duration available when `SessionEngine`
/// never reported a completion for this recording.
fn observed_duration_ms(session: &OpenSession) -> u64 {
    session
        .monotonic_span_ms
        .map(|(first, last)| last.saturating_sub(first))
        .unwrap_or_default()
}

fn observed_duration_us(session: &OpenSession) -> u64 {
    observed_duration_ms(session).saturating_mul(1000)
}

fn dropped_for(session: &OpenSession, shared: &Arc<Shared>) -> u64 {
    shared
        .dropped
        .load(Ordering::Relaxed)
        .saturating_sub(session.dropped_at_start)
}

/// Elapsed-time `recording` manifest refresh, driven by the writer's own
/// deadline rather than by an idle queue, so it runs during continuous
/// telemetry. The frame file is flushed first so a checkpointed count never
/// exceeds what is durable on disk. A session lost to a crash keeps these
/// counts: startup reclassification preserves them and only changes the status.
fn checkpoint(open: &mut Option<OpenSession>, shared: &Arc<Shared>) {
    let Some(session) = open.as_mut() else {
        return;
    };
    if !session.dirty {
        return;
    }
    session.dirty = false;
    if let Some(writer) = session.writer.as_mut() {
        if writer.flush().is_err() {
            return;
        }
    }
    session.manifest.recorder_dropped_frames = dropped_for(session, shared);
    session.manifest.duration_us = observed_duration_us(session);
    let _ = session_format::write_manifest_atomically(&session.directory, &session.manifest);
}

fn finalize(open: &mut Option<OpenSession>, shared: &Arc<Shared>, completed: Option<&Session>) {
    let Some(mut session) = open.take() else {
        return;
    };
    let dropped = dropped_for(&session, shared);
    session.manifest.recorder_dropped_frames = dropped;
    let mut error = session.write_error.clone();
    let duration_us = completed
        .map(|s| s.duration_ms.saturating_mul(1000))
        .unwrap_or_else(|| observed_duration_us(&session));
    session.manifest.duration_us = duration_us;
    if let Some(writer) = session.writer.take() {
        if let Err(failure) = writer.finish(&FrameStreamEnd {
            frame_count: session.manifest.frame_count,
            duration_us,
            recorder_dropped_frames: dropped,
        }) {
            error.get_or_insert(format!("Could not finalize the frame stream: {failure}"));
        }
    }
    match completed {
        // An interrupted recording never receives a summary: incomplete data
        // must not be presented as a finished session.
        Some(session_state) if error.is_none() => {
            session.manifest.status = SessionStatus::Completed;
            session.manifest.completion_reason = session_state.ended_reason.clone();
            session.manifest.game = session_state.game.clone();
            session.manifest.protocol = session_state.game.clone();
            session.manifest.vehicle_id = session_state.vehicle_id.clone();
            session.manifest.ended_at_unix_ms = session
                .manifest
                .started_at_unix_ms
                .map(|started| started.saturating_add(session_state.duration_ms));
            session.manifest.summary = Some(session.summary.finish(
                duration_us,
                dropped,
                error.is_none(),
            ));
        }
        _ => {
            session.manifest.status = SessionStatus::Interrupted;
            // Reached only with a write/finalize failure, or with no completion
            // from `SessionEngine` at all (recorder shutdown mid-session).
            session.manifest.completion_reason = Some(match &error {
                Some(_) => "recorder_write_error".to_string(),
                None => "recorder_stopped_before_completion".to_string(),
            });
            session.manifest.ended_at_unix_ms = Some(unix_ms());
        }
    }
    session.manifest.frame_file = FRAME_FILE_NAME.into();
    if let Err(failure) =
        session_format::write_manifest_atomically(&session.directory, &session.manifest)
    {
        error.get_or_insert(format!(
            "Could not finalize the session manifest: {failure}"
        ));
    }
    let id = session.id.clone();
    let completed_ok = session.manifest.status == SessionStatus::Completed;
    shared.update(|status| {
        status.recording = false;
        status.session_id = None;
        status.session_directory = None;
        status.queued_frames = 0;
        status.duration_ms = duration_us / 1000;
        status.last_completed_session_id = Some(id);
        if completed_ok {
            status.completed_sessions += 1;
        }
        match &error {
            Some(message) => {
                status.status = "error".into();
                status.last_error = Some(message.clone());
            }
            None => status.status = "idle".into(),
        }
    });
}

/// A manifest still marked `recording` at startup belongs to a session this
/// process never finished. It is reclassified as interrupted, never completed,
/// and never gains a summary.
pub fn classify_interrupted_sessions(root: &Path) -> Result<u64, String> {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(format!("Could not read the sessions directory: {error}")),
    };
    let mut reclassified = 0;
    for entry in entries.flatten() {
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
        if session_format::write_manifest_atomically(&directory, &manifest).is_ok() {
            reclassified += 1;
        }
    }
    Ok(reclassified)
}
