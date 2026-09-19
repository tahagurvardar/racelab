pub mod adapters;
pub mod appliance;
pub mod capture;
pub mod capture_format;
pub mod fh6_validation;
pub mod ingress;
pub mod live_telemetry;
pub mod packet;
pub mod protocol;
pub mod session;
pub mod telemetry;
pub mod telemetry_hub;

use appliance::{Appliance, DEFAULT_FH6_PORT};
use capture::{CaptureSnapshot, RawCaptureSink};
use ingress::StatsSnapshot;
use live_telemetry::{ConnectionConfig, LiveSnapshot};
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
            app.manage(Arc::clone(&capture));
            app.manage(Arc::clone(&appliance));
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
            get_live_telemetry
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
        }
    });
}
