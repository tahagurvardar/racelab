pub mod adapters;
pub mod capture;
pub mod capture_format;
pub mod fh6_validation;
pub mod ingress;
pub mod live_telemetry;
pub mod packet;
pub mod telemetry;

use capture::{CaptureSnapshot, RawCaptureSink};
use ingress::{Listener, ReceiveBuffer, StatsSnapshot};
use live_telemetry::{LiveSnapshot, LiveTelemetrySink};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::{Emitter, Manager, State};

// Serialize adapter resets with command-level listener transitions. This lock
// is never used by PacketSink or by the frozen Listener implementation.
#[derive(Default)]
struct ListenerCommands(Mutex<()>);

#[tauri::command]
async fn start_udp_listener(
    state: State<'_, Arc<Listener>>,
    live: State<'_, Arc<LiveTelemetrySink>>,
    commands: State<'_, Arc<ListenerCommands>>,
    port: u16,
) -> Result<StatsSnapshot, String> {
    let listener = Arc::clone(state.inner());
    let live = Arc::clone(live.inner());
    let commands = Arc::clone(commands.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = commands.0.lock().unwrap_or_else(|e| e.into_inner());
        if !listener.snapshot().running {
            live.reset();
        }
        listener.start(port)
    })
    .await
    .map_err(|error| format!("Listener task failed: {error}"))?
}

#[tauri::command]
async fn stop_udp_listener(
    state: State<'_, Arc<Listener>>,
    live: State<'_, Arc<LiveTelemetrySink>>,
    commands: State<'_, Arc<ListenerCommands>>,
) -> Result<StatsSnapshot, String> {
    let listener = Arc::clone(state.inner());
    let live = Arc::clone(live.inner());
    let commands = Arc::clone(commands.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = commands.0.lock().unwrap_or_else(|e| e.into_inner());
        let result = listener.stop()?;
        live.reset();
        Ok(result)
    })
    .await
    .map_err(|error| format!("Listener task failed: {error}"))?
}

#[tauri::command]
fn get_telemetry_stats(state: State<'_, Arc<Listener>>) -> StatsSnapshot {
    state.snapshot()
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
fn get_live_telemetry(state: State<'_, Arc<LiveTelemetrySink>>) -> LiveSnapshot {
    state.snapshot()
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
        .manage(Arc::new(ListenerCommands::default()))
        .setup(|app| {
            let capture = Arc::new(RawCaptureSink::new(
                app.path().app_local_data_dir()?.join("captures"),
            ));
            let live = Arc::new(LiveTelemetrySink::new(capture.clone()));
            let listener = Arc::new(Listener::new(ReceiveBuffer::default(), Some(live.clone())));
            app.manage(Arc::clone(&capture));
            app.manage(Arc::clone(&live));
            app.manage(Arc::clone(&listener));
            let handle = app.handle().clone();
            let (stop, receiver) = mpsc::sync_channel(1);
            let worker = thread::Builder::new()
                .name("telemetry-publisher".into())
                .spawn(move || {
                    while matches!(
                        receiver.recv_timeout(Duration::from_millis(250)),
                        Err(mpsc::RecvTimeoutError::Timeout)
                    ) {
                        // Snapshot lock is released before serialization or event delivery.
                        if let Err(error) = handle.emit("telemetry://stats", listener.snapshot()) {
                            eprintln!("Could not publish telemetry statistics: {error}");
                        }
                        if let Err(error) = handle.emit("capture://stats", capture.snapshot()) {
                            eprintln!("Could not publish capture statistics: {error}");
                        }
                        if let Err(error) = handle.emit("telemetry://frame", live.snapshot()) {
                            eprintln!("Could not publish live telemetry: {error}");
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
            if let Err(error) = handle.state::<Arc<Listener>>().stop() {
                eprintln!("Could not stop UDP listener: {error}");
            }
            if let Err(error) = handle.state::<Arc<RawCaptureSink>>().stop() {
                eprintln!("Could not finish raw capture: {error}");
            }
        }
    });
}
