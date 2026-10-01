//! The one thing RaceLab says when it cannot start at all.
//!
//! A packaged build is a GUI-subsystem binary with no console, so a failure
//! before the window exists has nowhere to print. Through V0.10 that meant a
//! fatal startup error — an unusable data directory, a sessions root that
//! cannot be created, a malformed `RACELAB_STORAGE_BUDGET_BYTES` — showed the
//! user nothing whatsoever: they double-clicked RaceLab and no window ever
//! appeared. That is the worst possible failure, because it is indistinguishable
//! from the application not being installed.
//!
//! This module is deliberately the smallest thing that fixes it:
//!
//! - **One native message box, no framework.** `MessageBoxW` from `user32`,
//!   which every Windows install already has and which the MSVC toolchain
//!   already links. No dialog plugin, no new crate, no settings surface.
//! - **It runs only on the fatal startup path.** Nothing else in RaceLab calls
//!   it. Background and runtime failures keep using the connection, recorder,
//!   analysis and storage states they already have; this is for the case where
//!   none of those exist yet because the UI never started.
//! - **The technical error is logged, the user gets a sentence.** The log keeps
//!   the original message in full. The dialog gets a sanitized, length-capped
//!   reason and a pointer to the log, and never a stack trace or a `Debug`
//!   rendering.
//! - **It exits non-zero.** Startup failed, so the process fails, and it says
//!   so to whatever launched it.
use crate::logging;
use std::path::Path;

/// Longest reason shown to a user. Past this the dialog stops being a sentence
/// and starts being a wall of text nobody reads, and the full message is in the
/// log anyway.
pub const MAX_REASON_CHARS: usize = 300;

pub const TITLE: &str = "RaceLab";

/// Collapse a technical error into one readable line.
///
/// Three things happen here, each for a reason:
///
/// 1. **Newlines and tabs become spaces.** A multi-line error — and anything
///    carrying a backtrace — would otherwise render as a wall in the dialog.
///    Flattening it also means the value cannot forge a second log record.
/// 2. **Runs of whitespace collapse.** Flattening a multi-line message
///    otherwise leaves long gaps where the line breaks were.
/// 3. **The result is truncated at a character boundary** and marked with an
///    ellipsis, so a pathological error cannot produce an unbounded dialog.
pub fn sanitize(reason: &str) -> String {
    let flattened: String = reason
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let collapsed = flattened.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= MAX_REASON_CHARS {
        return collapsed;
    }
    let kept: String = collapsed.chars().take(MAX_REASON_CHARS).collect();
    format!("{kept}…")
}

/// The exact text a user reads. Pure, so it is tested without opening a window.
///
/// Two promises are made in it deliberately. It says recordings are untouched,
/// because a user whose application will not start reasonably fears for their
/// data and a fatal startup failure happens before anything is written. And it
/// names the log file, but only when there is one — `log_path` is `None` when
/// logging itself could not open a file, and pointing at a file that does not
/// exist would be worse than saying nothing.
pub fn message(reason: &str, log_path: Option<&Path>) -> String {
    let mut text = String::from("RaceLab could not start.\n\n");
    text.push_str(&sanitize(reason));
    text.push_str("\n\nYour recordings have not been changed.");
    if let Some(path) = log_path {
        text.push_str("\n\nTechnical details are in:\n");
        text.push_str(&path.to_string_lossy());
    }
    text
}

/// Log the real error, show the user one message, and fail.
///
/// Never returns. The exit code is 1 rather than a panic so that whatever
/// launched RaceLab — a shortcut, a script, a test — sees an honest failure
/// instead of a panic message that a GUI build cannot print anywhere.
pub fn report(reason: &str) -> ! {
    // The log keeps the original, untruncated and unsanitized.
    logging::error(format!("RaceLab could not start: {reason}"));
    let text = message(reason, logging::active_log_path().as_deref());
    // A debug build has a console, so the technical detail is worth printing
    // there as well. A release build prints to nobody and does not try.
    #[cfg(debug_assertions)]
    eprintln!("RaceLab could not start: {reason}");
    show(TITLE, &text);
    std::process::exit(1);
}

/// One modal, always-on-top message box.
///
/// `MessageBoxW` is used directly rather than through a dialog plugin: this has
/// to work when the application failed to build, which is precisely when no
/// plugin, window or event loop is available to route a dialog through.
/// `user32` is already linked by every Windows GUI binary, so this adds no
/// dependency.
#[cfg(windows)]
fn show(title: &str, text: &str) {
    const MB_ICONERROR: u32 = 0x0000_0010;
    /// These two matter more than usual: there is no application window for
    /// this dialog to belong to, so without them it can open behind whatever
    /// the user was looking at and be missed entirely — which is the failure
    /// this module exists to stop.
    const MB_SETFOREGROUND: u32 = 0x0001_0000;
    const MB_TOPMOST: u32 = 0x0004_0000;

    /// `MB_OK` is zero and so contributes nothing: a single OK button is the
    /// default, and it is what this dialog wants. There is nothing for a user
    /// to decide here, so there is nothing to offer them but acknowledgement.
    const STYLE: u32 = MB_ICONERROR | MB_SETFOREGROUND | MB_TOPMOST;

    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            hwnd: *mut std::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            style: u32,
        ) -> i32;
    }

    // Null-terminated UTF-16, as the wide API requires. Interior nulls are
    // stripped rather than trusted: one would silently truncate the message.
    fn wide(value: &str) -> Vec<u16> {
        value
            .encode_utf16()
            .filter(|unit| *unit != 0)
            .chain(std::iter::once(0))
            .collect()
    }

    let text = wide(text);
    let caption = wide(title);
    // Safety: both pointers are null-terminated UTF-16 buffers that outlive the
    // call, and a null owner window is valid for an ownerless message box.
    unsafe {
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), caption.as_ptr(), STYLE);
    }
}

/// RaceLab is a Windows product; this keeps the module compiling elsewhere so
/// the pure parts above stay testable on any host.
#[cfg(not(windows))]
fn show(title: &str, text: &str) {
    eprintln!("{title}: {text}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn a_reason_is_flattened_to_one_line() {
        let text = message("first line\nsecond line\r\nthird", None);
        // The reason contributes no line breaks of its own; only the message's
        // own paragraph breaks remain.
        assert!(text.contains("first line second line third"));
    }

    #[test]
    fn a_stack_trace_shaped_reason_is_not_shown_as_one() {
        let reason = "could not start\n\
             stack backtrace:\n   \
             0: racelab_lib::run\n             \
             at ./src/lib.rs:402:9\n   \
             1: core::ops::function::FnOnce::call_once";
        let shown = sanitize(reason);
        assert!(!shown.contains('\n'));
        // Whitespace runs are collapsed, so indented frames cannot render as a
        // trace even before truncation.
        assert!(!shown.contains("   "));
    }

    #[test]
    fn a_pathological_reason_cannot_produce_an_unbounded_dialog() {
        let shown = sanitize(&"error ".repeat(500));
        assert_eq!(shown.chars().count(), MAX_REASON_CHARS + 1);
        assert!(shown.ends_with('…'));
    }

    #[test]
    fn a_short_reason_is_shown_verbatim_and_not_truncated() {
        let reason = "RACELAB_STORAGE_BUDGET_BYTES must be a whole number of bytes";
        assert_eq!(sanitize(reason), reason);
        assert!(!sanitize(reason).contains('…'));
    }

    #[test]
    fn the_message_names_the_log_file_only_when_there_is_one() {
        let path = PathBuf::from("C:/logs/racelab.log");
        let with = message("bad budget", Some(&path));
        assert!(with.contains("Technical details are in:"));
        assert!(with.contains("racelab.log"));

        // Logging could not open a file: promising one would be a lie.
        let without = message("bad budget", None);
        assert!(!without.contains("Technical details"));
        assert!(!without.contains("racelab.log"));
    }

    #[test]
    fn the_message_says_what_a_user_actually_needs_to_know() {
        let text = message(
            "Could not create the sessions directory: access denied",
            None,
        );
        assert!(text.starts_with("RaceLab could not start."));
        assert!(text.contains("Could not create the sessions directory: access denied"));
        // A user whose application will not open fears for their recordings.
        assert!(text.contains("Your recordings have not been changed."));
    }

    #[test]
    fn the_user_message_never_carries_debug_formatting() {
        // `{:?}` on an io::Error looks like `Custom { kind: Other, error: "…" }`.
        // Flattening keeps it on one line; what matters is that the dialog is
        // built from `Display` at the call site, so this only guards the shape.
        let text = message("Custom { kind: Other, error: \"boom\" }", None);
        assert_eq!(text.lines().filter(|line| line.contains("boom")).count(), 1);
        assert!(!text.contains("stack backtrace"));
        assert!(!text.contains("panicked at"));
    }
}
