pub mod adapters;
pub mod analysis;
pub mod analysis_engine;
pub mod analysis_job;
pub mod appliance;
pub mod capture;
pub mod capture_format;
pub mod fh6_validation;
pub mod ingress;
pub mod live_telemetry;
pub mod packet;
pub mod protocol;
pub mod session;
pub mod session_format;
pub mod session_recorder;
pub mod session_recovery;
pub mod session_retention;
pub mod session_store;
pub mod session_summary;
pub mod telemetry;
pub mod telemetry_hub;
pub mod telemetry_v1;

use analysis::AnalysisConfigV1;
use analysis_job::{AnalysisRunner, AnalysisRunnerStatus};
use appliance::{Appliance, DEFAULT_FH6_PORT};
use capture::{CaptureSnapshot, RawCaptureSink};
use ingress::StatsSnapshot;
use live_telemetry::{ConnectionConfig, LiveSnapshot};
use serde::Serialize;
use session_format::SessionManifestV1;
use session_recorder::{CompletionFanout, RecorderStatus, SessionCompletionHook, SessionRecorder};
use session_recovery::{RecoveryService, RecoveryStatus};
use session_retention::{RetentionPolicy, RetentionService, RetentionStatus, SessionProtection};
use session_store::{RecentSessions, SessionAnalysisState};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::{Emitter, Manager, State};

#[tauri::command]
async fn start_udp_listener(
    state: State<'_, Arc<Appliance>>,
    port: u16,
) -> Result<StatsSnapshot, String> {
    let appliance = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || appliance.start(port))
        .await
        .map_err(|error| format!("Listener task failed: {error}"))?
}

#[tauri::command]
async fn stop_udp_listener(state: State<'_, Arc<Appliance>>) -> Result<StatsSnapshot, String> {
    let appliance = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || appliance.stop())
        .await
        .map_err(|error| format!("Listener task failed: {error}"))?
}

#[tauri::command]
fn get_telemetry_stats(state: State<'_, Arc<Appliance>>) -> StatsSnapshot {
    state.listener.snapshot()
}

#[tauri::command]
async fn start_capture(
    state: State<'_, Arc<RawCaptureSink>>,
    label: String,
) -> Result<CaptureSnapshot, String> {
    let capture = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || capture.start(&label))
        .await
        .map_err(|error| format!("Capture task failed: {error}"))?
}

#[tauri::command]
async fn stop_capture(state: State<'_, Arc<RawCaptureSink>>) -> Result<CaptureSnapshot, String> {
    let capture = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || capture.stop())
        .await
        .map_err(|error| format!("Capture task failed: {error}"))?
}

#[tauri::command]
fn get_capture_stats(state: State<'_, Arc<RawCaptureSink>>) -> CaptureSnapshot {
    state.snapshot()
}

#[tauri::command]
fn get_live_telemetry(state: State<'_, Arc<Appliance>>) -> LiveSnapshot {
    state.live.snapshot()
}

#[tauri::command]
fn get_recorder_status(state: State<'_, Arc<SessionRecorder>>) -> RecorderStatus {
    state.status()
}

/// Manifest metadata only. The frame stream is never decoded here.
#[tauri::command]
async fn list_recent_sessions(
    state: State<'_, Arc<SessionRecorder>>,
    limit: Option<usize>,
) -> Result<RecentSessions, String> {
    let recorder = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        session_store::list_recent_sessions(recorder.root(), limit)
    })
    .await
    .map_err(|error| format!("Session listing failed: {error}"))
}

#[tauri::command]
async fn get_session(
    state: State<'_, Arc<SessionRecorder>>,
    session_id: String,
) -> Result<SessionManifestV1, String> {
    let recorder = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        session_store::get_session(recorder.root(), &session_id)
    })
    .await
    .map_err(|error| format!("Session read failed: {error}"))?
}

/// Derived analysis for one session. The frame stream is still never exposed:
/// this returns the analysis document alone, already reduced to events and
/// segments in the backend.
#[tauri::command]
async fn get_session_analysis(
    recorder: State<'_, Arc<SessionRecorder>>,
    analyzer: State<'_, Arc<AnalysisRunner>>,
    session_id: String,
) -> Result<SessionAnalysisState, String> {
    let recorder = Arc::clone(recorder.inner());
    let analyzer = Arc::clone(analyzer.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let job = analyzer.job(&session_id);
        session_store::get_session_analysis(recorder.root(), &session_id, job)
    })
    .await
    .map_err(|error| format!("Session analysis read failed: {error}"))?
}

/// Storage retention and interrupted-session recovery, as one reading.
///
/// Both are background housekeeping a user never starts, and both change what
/// a user sees in the sessions list, so both are reported rather than hidden.
#[derive(Debug, Clone, Serialize)]
pub struct StorageStatus {
    pub retention: RetentionStatus,
    pub recovery: RecoveryStatus,
}

#[tauri::command]
fn get_storage_status(
    retention: State<'_, Arc<RetentionService>>,
    recovery: State<'_, Arc<RecoveryService>>,
) -> StorageStatus {
    StorageStatus {
        retention: retention.status(),
        recovery: recovery.status(),
    }
}

/// Recovery affordance, not a driving control.
///
/// The product flow stays automatic: a session is analyzed when it completes
/// and nothing asks a user to press anything. This exists for the two states
/// where the automatic path has already been tried and did not produce a
/// readable result — a failed analysis and one written by a schema this build
/// cannot read — and for re-analyzing an old recording after a threshold
/// change without replaying a drive.
///
/// It is bounded by the same queue as every other job, refuses a session that
/// is not safely readable, and cannot touch `frames.rlframes` or
/// `manifest.json`: the only file an analysis run ever writes is
/// `analysis.json`, and it writes it atomically, so a failed re-analysis
/// leaves the previous analysis exactly where it was.
#[tauri::command]
async fn reanalyze_session(
    recorder: State<'_, Arc<SessionRecorder>>,
    analyzer: State<'_, Arc<AnalysisRunner>>,
    session_id: String,
) -> Result<AnalysisRunnerStatus, String> {
    if !session_format::is_safe_session_id(&session_id) {
        return Err("Unknown session".into());
    }
    let recorder = Arc::clone(recorder.inner());
    let analyzer = Arc::clone(analyzer.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let directory = recorder.root().join(&session_id);
        let manifest = session_format::read_manifest(&directory)
            .map_err(|error| format!("Could not read session {session_id}: {error}"))?;
        if !manifest.has_analyzable_coverage() {
            return Err(
                "This session has no safely readable frames, so it cannot be analyzed.".to_string(),
            );
        }
        if !analyzer.request(&session_id) {
            return Err(analyzer
                .status()
                .last_error
                .unwrap_or_else(|| "This session is already queued for analysis.".into()));
        }
        Ok(analyzer.status())
    })
    .await
    .map_err(|error| format!("Reanalysis request failed: {error}"))?
}

#[tauri::command]
fn get_analysis_status(analyzer: State<'_, Arc<AnalysisRunner>>) -> AnalysisRunnerStatus {
    analyzer.status()
}

struct Publisher {
    stop: mpsc::SyncSender<()>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Publisher {
    fn stop(&self) {
        let _ = self.stop.try_send(());
        if let Some(worker) = self.worker.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = worker.join();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let capture = Arc::new(RawCaptureSink::new(
                app.path().app_local_data_dir()?.join("captures"),
            ));
            let mut config = ConnectionConfig::default();
            if let Ok(value) = std::env::var("RACELAB_SESSION_GRACE_MS") {
                config.grace_ms = value.parse().map_err(|_| {
                    std::io::Error::other("RACELAB_SESSION_GRACE_MS must be an integer")
                })?;
            }
            let appliance = Arc::new(
                Appliance::new(capture.clone(), config, DEFAULT_FH6_PORT)
                    .map_err(std::io::Error::other)?,
            );
            // Recording is automatic: attaching the recorder is the only wiring
            // step. Sessions still start and end solely through SessionEngine.
            let recorder = SessionRecorder::new(app.path().app_local_data_dir()?.join("sessions"))
                .map_err(std::io::Error::other)?;
            appliance
                .live
                .hub
                .attach_recorder(Arc::clone(&recorder) as Arc<_>)
                .map_err(std::io::Error::other)?;
            // Analysis is automatic and additive: the runner observes a
            // finished recording and does its work on its own thread. Nothing
            // in ingestion, the hub or the recorder waits for it, and a session
            // records identically whether or not this succeeded.
            let analyzer =
                AnalysisRunner::new(recorder.root().to_path_buf(), AnalysisConfigV1::default())
                    .map_err(std::io::Error::other)?;
            // Interrupted-session recovery. The synchronous half — turning a
            // stale `recording` manifest into `interrupted` — already ran
            // inside the recorder's constructor above, before any new session
            // could be opened. This starts the background half that reads the
            // frame streams, which must never hold up launch.
            let recovery = RecoveryService::start(recorder.root().to_path_buf())
                .map_err(std::io::Error::other)?;
            // Bounded storage. Retention deletes whole sessions oldest-first
            // when the budget is exceeded, and asks these two guards before
            // every deletion, so the session being recorded and any session
            // queued for or undergoing analysis are never candidates.
            let protection: Vec<Arc<dyn SessionProtection>> = vec![
                Arc::clone(&recorder) as Arc<_>,
                Arc::clone(&analyzer) as Arc<_>,
            ];
            let retention = RetentionService::start(
                recorder.root().to_path_buf(),
                RetentionPolicy::from_environment().map_err(std::io::Error::other)?,
                protection,
            )
            .map_err(std::io::Error::other)?;
            // A finished analysis releases the session it was protecting, so
            // the budget is worth reconsidering. This is the only thing that
            // lets retention converge when the oldest sessions are the ones
            // still queued.
            analyzer
                .attach_observer(Arc::clone(&retention) as Arc<_>)
                .map_err(std::io::Error::other)?;
            // One hook, two observers, in order: analysis is queued first so a
            // just-finished session is protected before retention can consider
            // deleting anything. Both calls are bounded `try_send`s.
            let completion = CompletionFanout::new(vec![
                Arc::clone(&analyzer) as Arc<dyn SessionCompletionHook>,
                Arc::clone(&retention) as Arc<dyn SessionCompletionHook>,
            ]);
            recorder
                .attach_completion_hook(completion)
                .map_err(std::io::Error::other)?;
            app.manage(Arc::clone(&capture));
            app.manage(Arc::clone(&appliance));
            app.manage(Arc::clone(&recorder));
            app.manage(Arc::clone(&analyzer));
            app.manage(Arc::clone(&recovery));
            app.manage(Arc::clone(&retention));
            let handle = app.handle().clone();
            let (stop, receiver) = mpsc::sync_channel(1);
            let worker = thread::Builder::new()
                .name("telemetry-publisher".into())
                .spawn(move || {
                    // Bind errors are stored in live connection state, not a panic.
                    let _ = appliance.automatic_start();
                    let mut publication = std::time::Instant::now();
                    while matches!(
                        receiver.recv_timeout(Duration::from_millis(50)),
                        Err(mpsc::RecvTimeoutError::Timeout)
                    ) {
                        appliance.tick();
                        if publication.elapsed() < Duration::from_millis(250) {
                            continue;
                        }
                        publication = std::time::Instant::now();
                        // Legacy engineering counters/capture remain 4 Hz. Live UI
                        // pulls one latest snapshot at a time; no frame event queue.
                        if let Err(error) =
                            handle.emit("telemetry://stats", appliance.listener.snapshot())
                        {
                            eprintln!("Could not publish telemetry statistics: {error}");
                        }
                        if let Err(error) = handle.emit("capture://stats", capture.snapshot()) {
                            eprintln!("Could not publish capture statistics: {error}");
                        }
                    }
                })?;
            app.manage(Publisher {
                stop,
                worker: Mutex::new(Some(worker)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            start_udp_listener,
            stop_udp_listener,
            get_telemetry_stats,
            start_capture,
            stop_capture,
            get_capture_stats,
            get_live_telemetry,
            get_recorder_status,
            list_recent_sessions,
            get_session,
            get_session_analysis,
            get_analysis_status,
            get_storage_status,
            reanalyze_session
        ])
        .build(tauri::generate_context!())
        .expect("error while building RaceLab");

    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            handle.state::<Publisher>().stop();
            if let Err(error) = handle.state::<Arc<Appliance>>().stop() {
                eprintln!("Could not stop UDP listener: {error}");
            }
            if let Err(error) = handle.state::<Arc<RawCaptureSink>>().stop() {
                eprintln!("Could not finish raw capture: {error}");
            }
            // Appliance stop already completed any open session; this drains
            // and finalizes the writer before the process exits.
            handle.state::<Arc<SessionRecorder>>().shutdown();
            // Drained last, so an analysis queued by that final completion
            // still runs. Recording was already durable before this point.
            handle.state::<Arc<AnalysisRunner>>().shutdown();
            // Housekeeping is stopped after the work it observes, and neither
            // can hold exit open: a recovery scan stops between records and a
            // retention sweep stops between sessions. Neither owns anything a
            // recording depends on, so stopping them last can lose nothing.
            handle.state::<Arc<RecoveryService>>().shutdown();
            handle.state::<Arc<RetentionService>>().shutdown();
        }
    });
}
