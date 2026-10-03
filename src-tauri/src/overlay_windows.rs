//! The only overlay HWND code. Constants come from Windows SDK bindings.
//! WS_EX_LAYERED + WS_EX_TRANSPARENT passes mouse events through a layered
//! window (Microsoft Window Features / Layered Windows). NOACTIVATE and
//! TOOLWINDOW protect focus and taskbar/Alt+Tab. Never call SetForegroundWindow.
use serde::Serialize;
use windows_sys::Win32::{
    Foundation::{GetLastError, SetLastError, HWND, POINT, RECT},
    UI::WindowsAndMessaging::*,
};

#[derive(Debug, Serialize)]
pub struct NativeProbe {
    pub topmost: bool,
    pub tool_window: bool,
    pub no_activate: bool,
    pub layered: bool,
    pub click_through: bool,
    pub app_window: bool,
    pub decorated: bool,
    pub foreground: bool,
}

impl NativeProbe {
    pub fn matches_mode(&self, editing: bool) -> bool {
        self.topmost
            && self.tool_window
            && self.layered
            && !self.app_window
            && !self.decorated
            && self.no_activate != editing
            && self.click_through != editing
    }
}

pub fn probe(window: &tauri::WebviewWindow) -> Result<NativeProbe, String> {
    Ok(probe_hwnd(window.hwnd().map_err(|e| e.to_string())?.0 as _))
}

/// Practical hit-test check without synthesizing clicks into another app.
pub fn hit_test_passes_through(window: &tauri::WebviewWindow) -> Result<bool, String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as _;
    // SAFETY: live Tauri HWND. WindowFromPoint queries Windows' routing; no
    // messages, input synthesis or foreign process access are involved.
    unsafe {
        let mut rect: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let hit = WindowFromPoint(POINT {
            x: rect.left + (rect.right - rect.left) / 2,
            y: rect.top + (rect.bottom - rect.top) / 2,
        });
        Ok(hit != hwnd && IsChild(hwnd, hit) == 0)
    }
}

pub fn apply(
    window: &tauri::WebviewWindow,
    editing: bool,
    visible: bool,
) -> Result<NativeProbe, String> {
    apply_hwnd(
        window.hwnd().map_err(|e| e.to_string())?.0 as _,
        editing,
        visible,
    )
}

fn probe_hwnd(hwnd: HWND) -> NativeProbe {
    // SAFETY: caller supplies a live HWND obtained from Tauri (or test fixture).
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE) as u32;
        NativeProbe {
            topmost: ex & WS_EX_TOPMOST != 0,
            tool_window: ex & WS_EX_TOOLWINDOW != 0,
            no_activate: ex & WS_EX_NOACTIVATE != 0,
            layered: ex & WS_EX_LAYERED != 0,
            click_through: ex & WS_EX_TRANSPARENT != 0,
            app_window: ex & WS_EX_APPWINDOW != 0,
            decorated: style & WS_CAPTION != 0,
            foreground: GetForegroundWindow() == hwnd,
        }
    }
}

fn apply_hwnd(hwnd: HWND, editing: bool, visible: bool) -> Result<NativeProbe, String> {
    // SAFETY: executed on this HWND's event-loop thread. Preserves unrelated
    // style bits; errors surface through OverlayStatus instead of panicking.
    unsafe {
        // Tao retains caption bits for its custom non-client handling even
        // with decorations(false). Clear them explicitly for this small HUD.
        let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        SetLastError(0);
        if SetWindowLongPtrW(hwnd, GWL_STYLE, style & !(WS_CAPTION as isize)) == 0
            && GetLastError() != 0
        {
            return Err(format!(
                "Could not remove overlay frame: {}",
                std::io::Error::last_os_error()
            ));
        }
        let mut ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32;
        ex = (ex | WS_EX_TOOLWINDOW | WS_EX_LAYERED) & !WS_EX_APPWINDOW;
        if editing {
            ex &= !(WS_EX_NOACTIVATE | WS_EX_TRANSPARENT);
        } else {
            ex |= WS_EX_NOACTIVATE | WS_EX_TRANSPARENT;
        }
        SetLastError(0);
        if SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex as isize) == 0 && GetLastError() != 0 {
            return Err(format!(
                "Could not apply overlay styles: {}",
                std::io::Error::last_os_error()
            ));
        }
        // Microsoft requires a layered window to initialize its compositing
        // attributes before it can paint. WebView2 supplies transparent pixels;
        // CSS controls the user opacity, so native global alpha stays at 255.
        if SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA) == 0 {
            return Err(format!(
                "Could not initialize overlay transparency: {}",
                std::io::Error::last_os_error()
            ));
        }
        let visibility = if visible {
            SWP_SHOWWINDOW
        } else {
            SWP_HIDEWINDOW
        };
        if SetWindowPos(
            hwnd,
            HWND_TOPMOST,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED | visibility,
        ) == 0
        {
            return Err(format!(
                "Could not position overlay: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    let p = probe_hwnd(hwnd);
    if !p.matches_mode(editing) {
        return Err(format!("Overlay native styles failed verification: {p:?}"));
    }
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_hwnd_play_edit_play_and_no_activation_on_show() {
        // Real Windows window; no game and no guessed constants. Separate
        // Tauri webview validation is available via the integration helper.
        unsafe {
            // Match the production builder's initially topmost, unfocused
            // top-level window, with the normal Windows window procedure.
            let class: Vec<u16> = "RaceLabOverlayNativeTest\0".encode_utf16().collect();
            let window_class = WNDCLASSW {
                lpfnWndProc: Some(DefWindowProcW),
                lpszClassName: class.as_ptr(),
                ..std::mem::zeroed()
            };
            assert_ne!(RegisterClassW(&window_class), 0);
            let hwnd = CreateWindowExW(
                WS_EX_TOPMOST,
                class.as_ptr(),
                class.as_ptr(),
                WS_POPUP,
                20,
                20,
                440,
                210,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            );
            assert!(!hwnd.is_null());
            let foreground = GetForegroundWindow();
            let p = apply_hwnd(hwnd, false, true).unwrap();
            assert!(p.click_through && p.no_activate);
            assert_eq!(GetForegroundWindow(), foreground);
            // Exercise the controller's periodic repair if Windows changes
            // the effective z-order after creation (for example on DPI change).
            assert_ne!(
                SetWindowPos(
                    hwnd,
                    HWND_NOTOPMOST,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                ),
                0
            );
            assert!(!probe_hwnd(hwnd).topmost);
            assert!(apply_hwnd(hwnd, false, true).unwrap().topmost);
            let p = apply_hwnd(hwnd, true, true).unwrap();
            assert!(!p.click_through && !p.no_activate);
            let p = apply_hwnd(hwnd, false, true).unwrap();
            assert!(p.click_through && p.no_activate);
            assert_eq!(GetForegroundWindow(), foreground);
            apply_hwnd(hwnd, false, false).unwrap();
            assert_eq!(IsWindowVisible(hwnd), 0);
            DestroyWindow(hwnd);
            assert_ne!(UnregisterClassW(class.as_ptr(), std::ptr::null_mut()), 0);
        }
    }
}
