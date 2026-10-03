//! Real WebView2 integration, isolated temporary settings and ephemeral UDP.
//! Run with Vite on :1420: cargo run --example overlay-window-check
//! Replays reviewed datagrams (unchanged bytes), never attaches to a game.
#[cfg(windows)]
fn main() {
    use racelab_lib::{
        appliance::Appliance,
        capture::RawCaptureSink,
        f1_evidence::F1EvidenceService,
        live_telemetry::ConnectionConfig,
        overlay_window::{OverlayFrame, OverlayService},
        settings::SettingsStore,
    };
    use std::{
        net::UdpSocket,
        sync::{Arc, Mutex},
        thread,
        time::Duration,
    };
    use tauri::{Manager, State};

    struct Check {
        overlay: Arc<OverlayService>,
        f1: Arc<F1EvidenceService>,
        root: std::path::PathBuf,
        result: Mutex<Option<serde_json::Value>>,
        paint: Mutex<Option<serde_json::Value>>,
    }
    #[tauri::command]
    fn get_overlay_frame(state: State<'_, Check>) -> OverlayFrame {
        state.overlay.frame()
    }
    #[tauri::command]
    fn report_overlay_paint(state: State<'_, Check>, payload: serde_json::Value) {
        *state.paint.lock().unwrap() = Some(payload);
    }

    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    let app = tauri::Builder::default().invoke_handler(tauri::generate_handler![get_overlay_frame, report_overlay_paint])
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External("about:blank".parse().unwrap()))
                .title("RaceLab overlay verification").focused(false).inner_size(500.0, 400.0).build()?;
            let root = std::env::temp_dir().join(format!("racelab-overlay-check-{}", std::process::id()));
            let settings = Arc::new(SettingsStore::load(&root, 0));
            let f1 = Arc::new(F1EvidenceService::new(true, 0));
            f1.start()?;
            let port = f1.live_status().bound_port.ok_or("No F1 test port")?;
            let appliance = Arc::new(Appliance::new(Arc::new(RawCaptureSink::new(root.join("captures"))), ConnectionConfig::default(), 0)?);
            let overlay = Arc::new(OverlayService::start(app.handle(), settings, Arc::clone(&f1), appliance)?);
            overlay.configure(true, 1.0, 0.9, false)?;
            app.manage(Check { overlay, f1, root, result: Mutex::new(None), paint: Mutex::new(None) });
            let handle = app.handle().clone();
            thread::spawn(move || {
                let outcome = (|| -> Result<serde_json::Value, String> {
                    let socket = UdpSocket::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
                    let packets: [&[u8];3] = [include_bytes!("../tests/fixtures/f1_25/high-speed/id06-car-telemetry.bin"),
                        include_bytes!("../tests/fixtures/f1_25/high-speed/id07-car-status.bin"),
                        include_bytes!("../tests/fixtures/f1_25/high-speed/id02-lap-data.bin")];
                    let (replay_stop, replay_receiver) = std::sync::mpsc::channel::<()>();
                    let replay = thread::spawn(move || -> Result<(), String> {
                        loop {
                            for bytes in packets { socket.send_to(bytes, ("127.0.0.1", port)).map_err(|e| e.to_string())?; }
                            if !matches!(replay_receiver.recv_timeout(Duration::from_millis(50)), Err(std::sync::mpsc::RecvTimeoutError::Timeout)) { break; }
                        }
                        Ok(())
                    });
                    thread::sleep(Duration::from_millis(900));
                    let state = handle.state::<Check>();
                    if !state.overlay.status().visible { return Err(format!("Fresh auto-show failed: {:?}", state.overlay.status().error)); }
                    let window = handle.get_webview_window("overlay").ok_or("Missing overlay")?;
                    if !window.is_visible().map_err(|e| e.to_string())? { return Err("Native auto-show failed".into()); }
                    let play = racelab_lib::overlay_windows::probe(&window)?;
                    if play.foreground || !play.click_through || !play.no_activate { return Err(format!("Unsafe play: {play:?}")); }
                    if !racelab_lib::overlay_windows::hit_test_passes_through(&window)? { return Err("Windows hit testing still targets the overlay".into()); }
                    window.eval(r#"window.__TAURI_INTERNALS__.invoke('report_overlay_paint', {payload: {
                        text: document.body.innerText,
                        transparent_background: getComputedStyle(document.body).backgroundColor === 'rgba(0, 0, 0, 0)',
                        no_scroll: document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight,
                        visible: !document.querySelector('.telemetry-overlay')?.hidden
                    }})"#).map_err(|e| e.to_string())?;
                    thread::sleep(Duration::from_millis(100));
                    let paint = state.paint.lock().unwrap().clone().ok_or("WebView2 did not report painted content")?;
                    if paint["transparent_background"] != true || paint["visible"] != true || paint["no_scroll"] != true
                        || !paint["text"].as_str().unwrap_or_default().contains("292") { return Err(format!("WebView2 paint failed: {paint}")); }
                    let main = handle.get_webview_window("main").ok_or("Missing main")?;
                    main.minimize().map_err(|e| e.to_string())?;
                    thread::sleep(Duration::from_millis(150));
                    if !window.is_visible().map_err(|e| e.to_string())? { return Err("Main minimize hid overlay".into()); }
                    state.overlay.configure(true, 1.25, 0.75, true)?;
                    thread::sleep(Duration::from_millis(300));
                    let edit = racelab_lib::overlay_windows::probe(&window)?;
                    if edit.click_through || edit.no_activate || !window.is_resizable().map_err(|e| e.to_string())? { return Err(format!("Edit failed: {edit:?}")); }
                    window.set_position(tauri::PhysicalPosition::new(140, 120)).map_err(|e| e.to_string())?;
                    window.set_size(tauri::LogicalSize::new(600.0, 280.0)).map_err(|e| e.to_string())?;
                    thread::sleep(Duration::from_millis(750));
                    let saved = SettingsStore::load(&state.root, 0).overlay();
                    if saved.x != Some(140) || saved.y != Some(120) || (saved.width - 480.0).abs() > 1.0
                        || (saved.height - 224.0).abs() > 1.0 || saved.scale != 1.25 || saved.opacity != 0.75 {
                        return Err(format!("Native movement/resize did not persist: {saved:?}"));
                    }
                    state.overlay.configure(true, 1.25, 0.75, false)?;
                    thread::sleep(Duration::from_millis(300));
                    let restored = racelab_lib::overlay_windows::probe(&window)?;
                    if !restored.click_through || !restored.no_activate || restored.foreground { return Err("Play restoration failed".into()); }
                    // No more packets: wait through the established family cutoff.
                    drop(replay_stop);
                    replay.join().map_err(|_| "Replay thread failed")??;
                    thread::sleep(Duration::from_millis(3200));
                    if state.overlay.status().visible || window.is_visible().map_err(|e| e.to_string())? { return Err("Sustained silence did not hide overlay".into()); }
                    state.overlay.configure(false, 1.25, 0.75, false)?;
                    Ok(serde_json::json!({ "passed": true, "play": play, "edit": edit, "restored_play": restored,
                        "native_hit_test_passes_through": true, "webview_paint": paint, "process_id": std::process::id(),
                        "native_move_resize_persisted": true, "reloaded_preferences": saved,
                        "auto_show": true, "main_minimized_keeps_overlay": true, "silence_hides": true,
                        "settings_isolated": true, "one_existing_f1_listener": true, "recorders_created": 0 }))
                })();
                let result = outcome.unwrap_or_else(|e| serde_json::json!({"passed":false,"error":e}));
                *handle.state::<Check>().result.lock().unwrap() = Some(result);
                let exit_handle = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    // Exercise the same main-close event as the product.
                    if let Some(main) = exit_handle.get_webview_window("main") { let _ = main.close(); }
                });
            });
            Ok(())
        }).build(context).expect("Build integration app");
    app.run(|handle, event| {
        if matches!(&event, tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::CloseRequested { .. }, .. } if label == "main") { handle.exit(0); }
        if matches!(event, tauri::RunEvent::Exit) {
            let state = handle.state::<Check>();
            state.overlay.stop(); let _ = state.f1.stop();
            let result = state.result.lock().unwrap().take().unwrap_or(serde_json::json!({"passed":false,"error":"Closed before check finished"}));
            println!("{}", serde_json::to_string_pretty(&result).unwrap());
            if let Ok(path) = std::env::var("RACELAB_OVERLAY_CHECK_REPORT") { let _ = std::fs::write(path, serde_json::to_vec_pretty(&result).unwrap()); }
            let _ = std::fs::remove_dir_all(&state.root);
            if result["passed"] != true { std::process::exit(1); }
        }
    });
}
#[cfg(not(windows))]
fn main() {
    eprintln!("This integration helper requires Windows and WebView2");
}
