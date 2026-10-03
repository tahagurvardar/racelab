//! One lightweight window and one bounded latest-state worker. No networking,
//! recording, history, main-webview events, or telemetry-rate publication.
use crate::{
    appliance::Appliance,
    f1_evidence::{F1EvidenceService, F1LiveStatus},
    overlay::{self, Display, OverlayPolicy, OverlayPreferences},
    settings::SettingsStore,
};
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, MutexGuard,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tauri::{LogicalSize, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Clone, Serialize)]
pub struct OverlayStatus {
    pub preferences: OverlayPreferences,
    pub editing: bool,
    pub visible: bool,
    pub error: Option<String>,
}
#[derive(Clone, Serialize)]
pub struct OverlayFrame {
    pub state: OverlayStatus,
    pub f1: Option<F1LiveStatus>,
    pub fh6_active: bool,
    /// Ages from the cached sample must advance even during slow IPC.
    pub sample_age_ms: u64,
}
struct Inner {
    preferences: OverlayPreferences,
    policy: OverlayPolicy,
    error: Option<String>,
    sample: Option<F1LiveStatus>,
    sampled: Instant,
    fh6_active: bool,
    geometry_dirty: Option<Instant>,
}
pub struct OverlayService {
    inner: Arc<Mutex<Inner>>,
    settings: Arc<SettingsStore>,
    saves: Arc<Mutex<()>>,
    stop: mpsc::SyncSender<()>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl OverlayService {
    pub fn start(
        app: &tauri::AppHandle,
        settings: Arc<SettingsStore>,
        f1: Arc<F1EvidenceService>,
        appliance: Arc<Appliance>,
    ) -> Result<Self, String> {
        let preferences = settings.overlay();
        let inner = Arc::new(Mutex::new(Inner {
            preferences,
            policy: OverlayPolicy::default(),
            error: None,
            sample: None,
            sampled: Instant::now(),
            fh6_active: false,
            geometry_dirty: None,
        }));
        // Hidden and unfocused from creation, never owned by main (owned
        // windows would disappear when their owner is minimized).
        let window = create_window(app)?;
        configure_mode(&window, false, false)?;
        let event_inner = Arc::clone(&inner);
        let event_window = window.clone();
        window.on_window_event(move |event| {
            if matches!(
                event,
                tauri::WindowEvent::Moved(_)
                    | tauri::WindowEvent::Resized(_)
                    | tauri::WindowEvent::ScaleFactorChanged { .. }
            ) {
                let mut i = lock(&event_inner);
                // Only user editing saves geometry. Programmatic DPI/recovery
                // changes never feed back into preferences or create jitter.
                if i.policy.editing {
                    if let (Ok(pos), Ok(size), Ok(dpi)) = (
                        event_window.outer_position(),
                        event_window.inner_size(),
                        event_window.scale_factor(),
                    ) {
                        let mut p = i.preferences.clone();
                        p.x = Some(pos.x);
                        p.y = Some(pos.y);
                        p.width = (f64::from(size.width) / dpi / p.scale).clamp(360.0, 880.0);
                        p.height = (f64::from(size.height) / dpi / p.scale).clamp(210.0, 600.0);
                        if p != i.preferences {
                            i.preferences = p;
                            i.geometry_dirty = Some(Instant::now());
                        }
                    }
                }
            }
        });
        let (stop, receiver) = mpsc::sync_channel(1);
        let shared = Arc::clone(&inner);
        let store = Arc::clone(&settings);
        let saves = Arc::new(Mutex::new(()));
        let worker_saves = Arc::clone(&saves);
        let handle = app.clone();
        let pending = Arc::new(AtomicBool::new(false));
        let worker = thread::Builder::new()
            .name("overlay-latest".into())
            .spawn(move || {
                let applied: Arc<Mutex<Option<(OverlayPreferences, bool, bool)>>> =
                    Arc::new(Mutex::new(None));
                let mut last_recovery = Instant::now() - Duration::from_secs(2);
                loop {
                    let sample = f1.live_status(); // same compact latest API as main
                    let fh6 = appliance.live.snapshot();
                    let fh6_active = fh6.protocol.as_deref() == Some("fh6")
                        && !fh6.stale
                        && fh6.frame.as_ref().is_some_and(|f| f.active);
                    let age = if sample.enabled && sample.listening && sample.live.player_available
                    {
                        sample
                            .live
                            .car_telemetry
                            .as_ref()
                            .filter(|t| t.value.player.is_some())
                            .map(|t| t.age_ms)
                    } else {
                        None
                    };
                    let persist = {
                        let mut i = lock(&shared);
                        let enabled = i.preferences.enabled;
                        i.policy.update(enabled, age, fh6_active);
                        i.sample = Some(sample);
                        i.sampled = Instant::now();
                        i.fh6_active = fh6_active;
                        if i.geometry_dirty
                            .is_some_and(|t| t.elapsed() >= Duration::from_millis(500))
                        {
                            i.geometry_dirty = None;
                            Some(i.preferences.clone())
                        } else {
                            None
                        }
                    };
                    if persist.is_some() {
                        let _save = lock(&worker_saves);
                        let p = lock(&shared).preferences.clone();
                        if let Err(e) = store.set_overlay(p) {
                            lock(&shared).error = Some(e);
                        }
                    }
                    let recover = last_recovery.elapsed() >= Duration::from_secs(1);
                    if !pending.swap(true, Ordering::AcqRel) {
                        if recover {
                            last_recovery = Instant::now();
                        }
                        let inner = Arc::clone(&shared);
                        let pending_job = Arc::clone(&pending);
                        let applied_job = Arc::clone(&applied);
                        let w = window.clone();
                        let dispatched = handle.run_on_main_thread(move || {
                            let (p, edit, show) = {
                                let i = lock(&inner);
                                (i.preferences.clone(), i.policy.editing, i.policy.visible)
                            };
                            let key = (p.clone(), edit, show);
                            let previous = lock(&applied_job).clone();
                            let outcome = (|| -> Result<(), String> {
                                let geometry_changed =
                                    previous.as_ref().is_none_or(|(old, was_edit, _)| {
                                        if edit && *was_edit {
                                            old.scale != p.scale
                                        } else {
                                            old != &p
                                        }
                                    });
                                if geometry_changed || (recover && !edit) {
                                    place(&w, &p)?;
                                }
                                #[cfg(windows)]
                                let repair = recover
                                    && !crate::overlay_windows::probe(&w)?.matches_mode(edit);
                                #[cfg(not(windows))]
                                let repair = false;
                                if previous.as_ref() != Some(&key) || repair {
                                    configure_mode(&w, edit, show)?;
                                }
                                Ok(())
                            })();
                            if let Err(e) = outcome {
                                // Fail closed: an unverified input window must never
                                // remain over a game. Retry later and report to main.
                                let _ = w.hide();
                                lock(&inner).error = Some(e);
                                lock(&applied_job).take();
                            } else {
                                *lock(&applied_job) = Some(key);
                            }
                            pending_job.store(false, Ordering::Release);
                        });
                        if let Err(e) = dispatched {
                            pending.store(false, Ordering::Release);
                            lock(&shared).error = Some(e.to_string());
                        }
                    }
                    if !matches!(
                        receiver.recv_timeout(Duration::from_millis(overlay::UPDATE_MS)),
                        Err(mpsc::RecvTimeoutError::Timeout)
                    ) {
                        break;
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(Self {
            inner,
            settings,
            saves,
            stop,
            worker: Mutex::new(Some(worker)),
        })
    }

    pub fn frame(&self) -> OverlayFrame {
        let i = lock(&self.inner);
        OverlayFrame {
            state: OverlayStatus {
                preferences: i.preferences.clone(),
                editing: i.policy.editing,
                visible: i.policy.visible && i.error.is_none(),
                error: i.error.clone(),
            },
            f1: i.sample.clone(),
            fh6_active: i.fh6_active,
            sample_age_ms: i.sampled.elapsed().as_millis() as u64,
        }
    }
    pub fn status(&self) -> OverlayStatus {
        self.frame().state
    }
    /// Main-only command: patch user controls without overwriting a movement
    /// saved concurrently by the native window.
    pub fn configure(
        &self,
        enabled: bool,
        scale: f64,
        opacity: f64,
        editing: bool,
    ) -> Result<OverlayStatus, String> {
        let _save = lock(&self.saves);
        let p = {
            let mut i = lock(&self.inner);
            let mut p = i.preferences.clone();
            p.enabled = enabled;
            p.scale = scale;
            p.opacity = opacity;
            p.validate()?;
            i.preferences = p.clone();
            i.policy.editing = editing && enabled;
            i.error = None;
            p
        };
        self.settings.set_overlay(p)?;
        Ok(self.status())
    }
    pub fn stop(&self) {
        lock(&self.inner).policy.stop();
        let _ = self.stop.try_send(());
        if let Some(w) = lock(&self.worker).take() {
            let _ = w.join();
        }
        let p = lock(&self.inner).preferences.clone();
        if let Err(e) = self.settings.set_overlay(p) {
            crate::logging::warn(e);
        }
    }
}

fn place(w: &WebviewWindow, p: &OverlayPreferences) -> Result<(), String> {
    let mut monitors = w.available_monitors().map_err(|e| e.to_string())?;
    if let Some(primary) = w.primary_monitor().map_err(|e| e.to_string())? {
        monitors.sort_by_key(|m| m.position() != primary.position());
    }
    let displays: Vec<_> = monitors
        .iter()
        .map(|m| Display {
            x: m.position().x,
            y: m.position().y,
            width: m.size().width,
            height: m.size().height,
            dpi: m.scale_factor(),
        })
        .collect();
    let p = overlay::recover(p, &displays);
    if let Some((x, y)) = p.x.zip(p.y) {
        if w.outer_position().map_err(|e| e.to_string())? != PhysicalPosition::new(x, y) {
            w.set_position(PhysicalPosition::new(x, y))
                .map_err(|e| e.to_string())?;
        }
    }
    let desired = LogicalSize::new(p.width * p.scale, p.height * p.scale);
    let actual = w.inner_size().map_err(|e| e.to_string())?;
    let expected = desired.to_physical::<u32>(w.scale_factor().map_err(|e| e.to_string())?);
    if actual != expected {
        w.set_min_size(Some(LogicalSize::new(
            360.0_f64.min(p.width) * p.scale,
            210.0_f64.min(p.height) * p.scale,
        )))
        .map_err(|e| e.to_string())?;
        w.set_max_size(Some(LogicalSize::new(880.0 * p.scale, 600.0 * p.scale)))
            .map_err(|e| e.to_string())?;
        w.set_size(desired).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn configure_mode(w: &WebviewWindow, edit: bool, show: bool) -> Result<(), String> {
    w.set_focusable(edit).map_err(|e| e.to_string())?;
    w.set_ignore_cursor_events(!edit)
        .map_err(|e| e.to_string())?;
    w.set_resizable(edit).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        crate::overlay_windows::apply(w, edit, show)?;
    }
    #[cfg(not(windows))]
    {
        if show { w.show() } else { w.hide() }.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Shared by production and the real-WebView2 Windows integration helper.
pub fn create_window(app: &tauri::AppHandle) -> Result<WebviewWindow, String> {
    WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("overlay.html".into()))
        .title("RaceLab Overlay")
        .inner_size(440.0, 210.0)
        .min_inner_size(360.0, 210.0)
        .max_inner_size(880.0, 600.0)
        .visible(false)
        .focused(false)
        .focusable(false)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .closable(false)
        .build()
        .map_err(|e| e.to_string())
}
