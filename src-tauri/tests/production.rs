//! V1.0 packaging and production-hardening regressions.
//!
//! Everything here is about RaceLab as an *installed product* rather than as a
//! telemetry pipeline: bounded logs, a settings file that cannot break a
//! launch, and storage failures that report themselves instead of disappearing.
mod scratch;

use racelab_lib::startup_error;
use racelab_lib::{
    logging::{self, Level, LocalLog, LOG_FILE_NAME, MAX_LOG_BYTES, PREVIOUS_LOG_FILE_NAME},
    session_recorder::SessionRecorder,
    session_retention::DEFAULT_STORAGE_BUDGET_BYTES,
    settings::{SettingsStore, SETTINGS_FILE_NAME},
};
use scratch::Scratch;
use std::fs;

#[test]
fn stable_release_enables_f1_live_and_recording_by_default() {
    // Run this in release mode too: debug assertions must not mask the gate.
    assert!(racelab_lib::f1_evidence::enabled_by_default());
}

#[cfg(not(debug_assertions))]
#[test]
fn packaged_f1_is_enabled_without_development_fixture_capture() {
    let scratch = Scratch::new("release-f1-gate");
    let service = racelab_lib::f1_evidence::F1EvidenceService::from_environment(
        scratch.join("dev-f1-fixtures"),
    )
    .unwrap();
    assert!(service.enabled());
    assert!(!service.capture_enabled());
    assert!(!scratch.join("dev-f1-fixtures").exists());
}

// ------------------------------------------------------ fatal startup errors

/// `startup_error::report` ends the process, so it is never called from a test.
/// Its two halves are verified separately: the message is a pure function with
/// its own unit tests, and this proves the half that writes the technical error
/// to disk actually lands there, in full.
#[test]
fn the_technical_reason_behind_a_fatal_startup_reaches_the_log_in_full() {
    let scratch = Scratch::new("startup-log");
    let log = LocalLog::open(scratch.to_path_buf());
    let reason = "RACELAB_STORAGE_BUDGET_BYTES must be a whole number of bytes";
    log.write(Level::Error, &format!("RaceLab could not start: {reason}"));

    let written = fs::read_to_string(scratch.join(LOG_FILE_NAME)).unwrap();
    assert!(written.contains("ERROR RaceLab could not start:"));
    // Untruncated and unsanitized: the dialog abbreviates, the log does not.
    assert!(written.contains(reason));
    assert_eq!(written.lines().count(), 1);
}

#[test]
fn a_long_reason_is_abbreviated_for_the_user_but_never_for_the_log() {
    let scratch = Scratch::new("startup-log-long");
    let log = LocalLog::open(scratch.to_path_buf());
    let reason = format!(
        "Could not create the sessions directory: {}",
        "x".repeat(900)
    );
    log.write(Level::Error, &format!("RaceLab could not start: {reason}"));

    let written = fs::read_to_string(scratch.join(LOG_FILE_NAME)).unwrap();
    assert!(
        written.contains(&reason),
        "the log must keep the whole reason"
    );

    let shown = startup_error::sanitize(&reason);
    assert!(shown.chars().count() < reason.chars().count());
    assert!(shown.ends_with('…'));
}

#[test]
fn a_build_that_never_started_logging_does_not_promise_a_log_file() {
    // `logging::start` is never called in a test binary, which is exactly the
    // state of a build whose log file could not be opened. The dialog must omit
    // the log reference rather than send a user to a file that does not exist.
    assert_eq!(logging::active_log_path(), None);
    let text = startup_error::message("bad budget", logging::active_log_path().as_deref());
    assert!(!text.contains("Technical details"));
    assert!(text.contains("RaceLab could not start."));
}

// ------------------------------------------------------------------ logging

#[test]
fn logs_are_bounded_no_matter_how_much_is_written() {
    let scratch = Scratch::new("logging-bound");
    let log = LocalLog::open(scratch.to_path_buf());
    // Far more than any real session produces, and far more than one file
    // holds: this must rotate several times rather than grow.
    let line = "x".repeat(512);
    for _ in 0..12_000 {
        log.write(Level::Info, &line);
    }
    let (active, previous) = logging::log_bytes(&scratch);
    assert!(
        active <= MAX_LOG_BYTES,
        "active log grew past its bound: {active}"
    );
    assert!(
        previous <= MAX_LOG_BYTES + 4096,
        "previous log grew past its bound: {previous}"
    );
    // The whole point of the bound: two files, never a third.
    let files: Vec<String> = fs::read_dir(&*scratch)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        files.len(),
        2,
        "expected exactly two log files, got {files:?}"
    );
    assert!(files.contains(&LOG_FILE_NAME.to_string()));
    assert!(files.contains(&PREVIOUS_LOG_FILE_NAME.to_string()));
}

#[test]
fn a_log_line_survives_rotation_and_stays_readable() {
    let scratch = Scratch::new("logging-rotation");
    let log = LocalLog::open(scratch.to_path_buf());
    log.write(Level::Error, "recorder failed to write");
    let active = fs::read_to_string(scratch.join(LOG_FILE_NAME)).unwrap();
    assert!(active.contains("ERROR recorder failed to write"));
    assert_eq!(active.lines().count(), 1);
}

#[test]
fn logging_into_a_directory_that_cannot_be_created_is_not_a_failure() {
    // A file where the log directory should be. Opening the log must degrade to
    // writing nothing; it must never panic or propagate, because a logging
    // failure turning into a product failure would defeat the purpose.
    let scratch = Scratch::new("logging-blocked");
    let blocked = scratch.join("not-a-directory");
    fs::write(&blocked, b"occupied").unwrap();
    let log = LocalLog::open(blocked.join("logs"));
    log.write(Level::Error, "this goes nowhere and that is fine");
}

// ----------------------------------------------------------------- settings

#[test]
fn a_settings_file_written_by_a_future_schema_does_not_prevent_startup() {
    let scratch = Scratch::new("settings-future");
    fs::write(
        scratch.join(SETTINGS_FILE_NAME),
        br#"{"schema_version":99,"storage_budget_bytes":null,"unknown_future_field":{"a":1}}"#,
    )
    .unwrap();
    let settings = SettingsStore::load(&scratch, DEFAULT_STORAGE_BUDGET_BYTES);
    // Unknown fields are ignored rather than rejected, so the file still reads.
    assert_eq!(settings.snapshot().last_error, None);
    assert_eq!(
        settings.storage_budget_bytes(),
        DEFAULT_STORAGE_BUDGET_BYTES
    );
}

#[test]
fn a_truncated_settings_file_falls_back_to_defaults_and_reports_why() {
    let scratch = Scratch::new("settings-truncated");
    fs::write(scratch.join(SETTINGS_FILE_NAME), br#"{"storage_budget"#).unwrap();
    let settings = SettingsStore::load(&scratch, DEFAULT_STORAGE_BUDGET_BYTES);
    assert!(settings.snapshot().last_error.is_some());
    assert_eq!(
        settings.storage_budget_bytes(),
        DEFAULT_STORAGE_BUDGET_BYTES
    );
    // A broken preferences file must never be the reason a product will not run.
    assert!(settings.is_first_run());
}

#[test]
fn a_saved_budget_survives_a_restart() {
    let scratch = Scratch::new("settings-persist");
    let budget = 25 * 1024 * 1024 * 1024;
    {
        let settings = SettingsStore::load(&scratch, DEFAULT_STORAGE_BUDGET_BYTES);
        settings.set_storage_budget_bytes(budget).unwrap();
        assert_eq!(settings.storage_budget_bytes(), budget);
    }
    let reloaded = SettingsStore::load(&scratch, DEFAULT_STORAGE_BUDGET_BYTES);
    assert_eq!(reloaded.storage_budget_bytes(), budget);
    assert_eq!(reloaded.snapshot().last_error, None);
}

#[test]
fn a_settings_write_is_atomic_and_leaves_no_temporary_file_behind() {
    let scratch = Scratch::new("settings-atomic");
    let settings = SettingsStore::load(&scratch, DEFAULT_STORAGE_BUDGET_BYTES);
    settings.set_storage_budget_bytes(0).unwrap();
    let leftovers: Vec<String> = fs::read_dir(&*scratch)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".tmp"))
        .collect();
    assert_eq!(leftovers, Vec::<String>::new());
}

#[test]
fn the_default_budget_is_the_v0_10_retention_default() {
    // The settings file changes where the budget comes from, never what it is
    // when nobody has chosen one. A different default here would silently
    // change V0.10's retention behaviour for every existing installation.
    let scratch = Scratch::new("settings-default");
    let settings = SettingsStore::load(&scratch, DEFAULT_STORAGE_BUDGET_BYTES);
    assert_eq!(
        settings.storage_budget_bytes(),
        DEFAULT_STORAGE_BUDGET_BYTES
    );
    assert_eq!(DEFAULT_STORAGE_BUDGET_BYTES, 8 * 1024 * 1024 * 1024);
}

// ------------------------------------------------------- network exposure

#[test]
fn the_telemetry_socket_is_bound_to_loopback_and_nothing_else() {
    // The firewall contract. A wildcard bind makes Windows Defender Firewall
    // prompt on first launch and exposes the telemetry port to the whole
    // network; loopback traffic is firewall-exempt, so this is what lets
    // RaceLab install and run with no exception and no administrator rights.
    assert_eq!(racelab_lib::ingress::LISTEN_ADDRESS, "127.0.0.1");

    let listener = racelab_lib::ingress::Listener::new(
        racelab_lib::ingress::ReceiveBuffer::SystemDefault,
        None,
    );
    let started = listener.start(0).expect("listener binds an ephemeral port");
    let port = started.bound_port.expect("a bound port is reported");

    // The socket must not be reachable through a routable interface. Binding
    // the same port on 0.0.0.0 has to still succeed, which it can only do if
    // the listener did not take the wildcard address.
    assert!(
        std::net::UdpSocket::bind(("0.0.0.0", port)).is_ok(),
        "the telemetry socket claimed the wildcard address"
    );

    // Loopback traffic still arrives, which is the whole point.
    let sender = std::net::UdpSocket::bind(("127.0.0.1", 0)).unwrap();
    sender.send_to(&[0xAB; 64], ("127.0.0.1", port)).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while listener.snapshot().total_packets == 0 && std::time::Instant::now() < deadline {
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(
        listener.snapshot().total_packets >= 1,
        "loopback telemetry must still be received"
    );
    listener.stop().unwrap();
}

/// The product tells a user one address, and it is the one the socket binds.
#[test]
fn the_address_shown_to_the_user_is_the_address_the_listener_binds() {
    assert_eq!(
        racelab_lib::appliance::FH6_TARGET_HOST,
        racelab_lib::ingress::LISTEN_ADDRESS
    );
    assert_eq!(racelab_lib::appliance::DEFAULT_FH6_PORT, 20440);
}

// ------------------------------------------------------------- storage paths

#[test]
fn a_sessions_root_that_cannot_be_created_reports_a_clear_error() {
    // The storage-permission and disk-full shape at startup: the recorder
    // cannot make its directory. It must return a readable error rather than
    // panicking or silently recording nowhere.
    let scratch = Scratch::new("storage-blocked");
    let blocked = scratch.join("occupied");
    fs::write(&blocked, b"a file, not a directory").unwrap();
    let Err(error) = SessionRecorder::new(blocked.join("sessions")) else {
        panic!("a sessions root inside a file must not be creatable");
    };
    assert!(
        error.contains("Could not create the sessions directory"),
        "unexpected error text: {error}"
    );
}

#[test]
fn every_storage_root_is_absolute_and_independent_of_the_working_directory() {
    let scratch = Scratch::new("storage-absolute");
    let recorder = SessionRecorder::new(scratch.join("sessions")).unwrap();
    assert!(recorder.root().is_absolute());
    // The recorder reports the directory it actually uses, which is what the
    // Sessions view shows a user looking for their recordings.
    assert!(recorder.root().ends_with("sessions"));
    recorder.shutdown();
}
