pub mod ingress;
pub mod packet;

use ingress::{Listener, StatsSnapshot};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::{Emitter, Manager, State};

#[tauri::command]
async fn start_udp_listener(
    state: State<'_, Arc<Listener>>,
    port: u16,
) -> Result<StatsSnapshot, String> {
    let listener = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || listener.start(port))
        .await
        .map_err(|error| format!("Listener task failed: {error}"))?
}

#[tauri::command]
async fn stop_udp_listener(state: State<'_, Arc<Listener>>) -> Result<StatsSnapshot, String> {
    let listener = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || listener.stop())
        .await
        .map_err(|error| format!("Listener task failed: {error}"))?
}

#[tauri::command]
fn get_telemetry_stats(state: State<'_, Arc<Listener>>) -> StatsSnapshot {
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
        .manage(Arc::new(Listener::default()))
        .setup(|app| {
            let handle = app.handle().clone();
            let listener = Arc::clone(app.state::<Arc<Listener>>().inner());
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
            get_telemetry_stats
        ])
        .build(tauri::generate_context!())
        .expect("error while building RaceLab");

    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            handle.state::<Publisher>().stop();
            if let Err(error) = handle.state::<Arc<Listener>>().stop() {
                eprintln!("Could not stop UDP listener: {error}");
            }
        }
    });
}
