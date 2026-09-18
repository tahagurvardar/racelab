use serde::Serialize;
use std::{
    io::ErrorKind,
    net::UdpSocket,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State};

const MAX_UDP_PACKET_SIZE: usize = 65_535;
const PREVIEW_BYTES: usize = 32;

#[derive(Debug, Serialize, Clone)]
struct PacketEvent {
    received_at_ms: u64,
    size: usize,
    source: String,
    preview_hex: String,
}

#[derive(Debug, Serialize, Clone)]
struct ListenerError {
    message: String,
}

struct ListenerState {
    running: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Default for ListenerState {
    fn default() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            worker: Mutex::new(None),
        }
    }
}

#[tauri::command]
fn start_udp_listener(
    app: AppHandle,
    state: State<'_, ListenerState>,
    port: u16,
) -> Result<(), String> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("UDP listener is already running".to_string());
    }

    let socket = UdpSocket::bind(("0.0.0.0", port)).map_err(|error| {
        state.running.store(false, Ordering::SeqCst);
        format!("Could not bind UDP port {port}: {error}")
    })?;

    socket
        .set_read_timeout(Some(Duration::from_millis(250)))
        .map_err(|error| {
            state.running.store(false, Ordering::SeqCst);
            format!("Could not configure UDP socket: {error}")
        })?;

    let running = Arc::clone(&state.running);
    let worker = thread::spawn(move || {
        let mut buffer = vec![0_u8; MAX_UDP_PACKET_SIZE];

        while running.load(Ordering::SeqCst) {
            match socket.recv_from(&mut buffer) {
                Ok((size, source)) => {
                    let received_at_ms = SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;

                    let preview_hex = buffer[..size.min(PREVIEW_BYTES)]
                        .iter()
                        .map(|byte| format!("{byte:02X}"))
                        .collect::<Vec<_>>()
                        .join(" ");

                    let _ = app.emit(
                        "telemetry://packet",
                        PacketEvent {
                            received_at_ms,
                            size,
                            source: source.to_string(),
                            preview_hex,
                        },
                    );
                }
                Err(error) if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
                Err(error) => {
                    let _ = app.emit(
                        "telemetry://error",
                        ListenerError {
                            message: format!("UDP receive error: {error}"),
                        },
                    );
                    break;
                }
            }
        }

        running.store(false, Ordering::SeqCst);
    });

    *state
        .worker
        .lock()
        .map_err(|_| "UDP worker lock is poisoned".to_string())? = Some(worker);

    Ok(())
}

#[tauri::command]
fn stop_udp_listener(state: State<'_, ListenerState>) -> Result<(), String> {
    state.running.store(false, Ordering::SeqCst);

    if let Some(worker) = state
        .worker
        .lock()
        .map_err(|_| "UDP worker lock is poisoned".to_string())?
        .take()
    {
        worker
            .join()
            .map_err(|_| "UDP worker thread exited unexpectedly".to_string())?;
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ListenerState::default())
        .invoke_handler(tauri::generate_handler![start_udp_listener, stop_udp_listener])
        .run(tauri::generate_context!())
        .expect("error while running RaceLab");
}
