//! Bounded session storage.
//!
//! Retention deletes recorded telemetry, which makes it the most dangerous code
//! in RaceLab. These tests exist to pin down exactly what it is allowed to
//! touch, and every one of them is written from the user's side of the
//! guarantee: the session I am recording survives, the session being analyzed
//! survives, the oldest goes first, and nothing disappears without being
//! counted.
use racelab_lib::{
    session_format::{self, SessionManifestV1, SessionStatus},
    session_retention::{
        sweep, RetentionPolicy, RetentionStatus, SessionProtection, DEFAULT_STORAGE_BUDGET_BYTES,
    },
};
use std::{
    fs,
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

mod scratch;
use scratch::Scratch;

fn scratch(name: &str) -> Scratch {
    Scratch::new(&format!("retention-{name}"))
}

/// Pads a session directory so that it occupies **exactly** `total_bytes`,
/// manifest included.
///
/// Retention measures whole directories, so a test that sized only the frame
/// stream would be asserting against the wrong number and would drift every
/// time the manifest gained a field. Padding to an exact total keeps every
/// budget in these tests arithmetic a reader can check by hand.
fn pad_to(directory: &Path, total_bytes: usize) {
    let manifest_bytes = fs::metadata(directory.join("manifest.json"))
        .map(|meta| meta.len() as usize)
        .unwrap_or(0);
    assert!(
        total_bytes > manifest_bytes,
        "asked for a {total_bytes}-byte session, but its manifest alone is {manifest_bytes} bytes"
    );
    fs::write(
        directory.join("frames.rlframes"),
        vec![0_u8; total_bytes - manifest_bytes],
    )
    .unwrap();
    assert_eq!(directory_bytes(directory), total_bytes as u64);
}

fn directory_bytes(directory: &Path) -> u64 {
    fs::read_dir(directory)
        .unwrap()
        .flatten()
        .filter_map(|entry| entry.metadata().ok())
        .map(|metadata| metadata.len())
        .sum()
}

/// A completed session directory occupying exactly `total_bytes`.
fn session(root: &Path, id: &str, started_at_unix_ms: u64, total_bytes: usize) {
    let directory = root.join(id);
    fs::create_dir_all(&directory).unwrap();
    let mut manifest = SessionManifestV1::new(id.into(), Some(started_at_unix_ms));
    manifest.status = SessionStatus::Completed;
    session_format::write_manifest_atomically(&directory, &manifest).unwrap();
    pad_to(&directory, total_bytes);
}

/// A session whose manifest cannot be parsed, and therefore whose age cannot be
/// established.
fn unreadable_session(root: &Path, id: &str, total_bytes: usize) {
    let directory = root.join(id);
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("manifest.json"), b"{ not json").unwrap();
    pad_to(&directory, total_bytes);
}

fn present(root: &Path, id: &str) -> bool {
    root.join(id).is_dir()
}

fn ids(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(root)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// A protection guard a test drives directly.
struct Guard(Mutex<Vec<String>>, &'static str);

impl Guard {
    fn new(ids: &[&str], reason: &'static str) -> Arc<Self> {
        Arc::new(Self(
            Mutex::new(ids.iter().map(|id| id.to_string()).collect()),
            reason,
        ))
    }
}

impl SessionProtection for Guard {
    fn is_protected(&self, session_id: &str) -> bool {
        self.0.lock().unwrap().iter().any(|id| id == session_id)
    }

    fn protection_reason(&self) -> &'static str {
        self.1
    }
}

fn run(root: &Path, budget: u64, guards: &[Arc<dyn SessionProtection>]) -> RetentionStatus {
    let mut status = RetentionStatus::default();
    sweep(
        root,
        RetentionPolicy {
            budget_bytes: budget,
        },
        guards,
        &mut status,
    );
    status
}

// ------------------------------------------------------------ oldest first

/// Sessions are deleted strictly oldest first by start time, and only as many
/// as the budget requires. Deleting the newest, or deleting more than needed,
/// would both be data loss the user never asked for.
#[test]
fn retention_deletes_oldest_first_and_stops_at_the_budget() {
    let root = scratch("oldest-first");
    session(&root, "a-1", 1_000, 4_000);
    session(&root, "a-2", 2_000, 4_000);
    session(&root, "a-3", 3_000, 4_000);
    session(&root, "a-4", 4_000, 4_000);

    // 16,000 bytes on disk, budget 9,000: the two oldest must go, no more.
    let status = run(&root, 9_000, &[]);

    assert_eq!(ids(&root), vec!["a-3".to_string(), "a-4".to_string()]);
    assert_eq!(status.deleted_sessions, 2);
    assert_eq!(status.reclaimed_bytes, 8_000);
    assert_eq!(status.used_bytes, 8_000);
    assert!(!status.over_budget);
    assert_eq!(status.last_deleted_session_id.as_deref(), Some("a-2"));
}

/// The tie-break is the session identifier, so two sessions that started in the
/// same millisecond are still ordered the same way on every machine and every
/// run. Without it the order would come from the filesystem.
#[test]
fn sessions_that_start_together_are_ordered_deterministically() {
    for _ in 0..3 {
        let root = scratch("tie-break");
        session(&root, "same-3", 5_000, 4_000);
        session(&root, "same-1", 5_000, 4_000);
        session(&root, "same-2", 5_000, 4_000);

        run(&root, 4_000, &[]);
        assert_eq!(ids(&root), vec!["same-3".to_string()]);
    }
}

/// Nothing is deleted while the directory is inside its budget.
#[test]
fn a_directory_inside_its_budget_is_untouched() {
    let root = scratch("within-budget");
    session(&root, "b-1", 1_000, 2_000);
    session(&root, "b-2", 2_000, 2_000);

    let status = run(&root, 10_000, &[]);

    assert_eq!(ids(&root).len(), 2);
    assert_eq!(status.deleted_sessions, 0);
    assert_eq!(status.used_bytes, 4_000);
    assert_eq!(status.retained_sessions, 2);
}

/// A zero budget disables deletion entirely. Usage is still measured, because a
/// user who turned retention off still deserves to be told how much disk the
/// recordings are using.
#[test]
fn a_zero_budget_disables_deletion_but_still_reports_usage() {
    let root = scratch("disabled");
    session(&root, "c-1", 1_000, 5_000);
    session(&root, "c-2", 2_000, 5_000);

    let status = run(&root, 0, &[]);

    assert_eq!(ids(&root).len(), 2);
    assert_eq!(status.deleted_sessions, 0);
    assert!(!status.enabled);
    assert_eq!(status.used_bytes, 10_000);
    assert!(!status.over_budget, "a disabled budget is never exceeded");
}

// -------------------------------------------------------------- protection

/// The session being recorded is never deleted, however old it is. This is the
/// one guarantee that matters most: retention exists to keep recording
/// possible, so deleting the recording in progress would defeat its purpose.
#[test]
fn the_session_being_recorded_is_never_deleted() {
    let root = scratch("active-session");
    // The oldest session by a wide margin, and by far the largest.
    session(&root, "live-1", 1, 4_000);
    session(&root, "old-1", 1_000, 2_000);
    session(&root, "old-2", 2_000, 2_000);

    let guard: Arc<dyn SessionProtection> = Guard::new(&["live-1"], "being recorded");
    let status = run(&root, 1_000, &[guard]);

    assert!(present(&root, "live-1"), "the active session must survive");
    assert!(!present(&root, "old-1"));
    assert!(!present(&root, "old-2"));
    assert_eq!(status.protected_sessions, 1);
    // Still over budget, and saying so rather than deleting the live session.
    assert!(status.over_budget);
}

/// A manifest that still says `recording` protects its session even with no
/// guard attached. A crashed process leaves exactly this, and the session is
/// only safe to delete once something has established what it contains.
#[test]
fn a_manifest_still_marked_recording_protects_itself() {
    let root = scratch("recording-manifest");
    let directory = root.join("open-1");
    fs::create_dir_all(&directory).unwrap();
    // `new` leaves the status at `recording`.
    let manifest = SessionManifestV1::new("open-1".into(), Some(1));
    session_format::write_manifest_atomically(&directory, &manifest).unwrap();
    pad_to(&directory, 4_000);
    session(&root, "done-1", 9_000, 2_000);

    let status = run(&root, 1_000, &[]);

    assert!(present(&root, "open-1"));
    assert!(!present(&root, "done-1"));
    assert_eq!(status.protected_sessions, 1);
}

/// A session queued for analysis, or being analyzed, survives its turn. The
/// analyzer reads the frame stream, so deleting one mid-analysis would turn a
/// storage decision into a corrupted read.
#[test]
fn a_session_queued_for_analysis_is_never_deleted() {
    let root = scratch("analyzer-protection");
    session(&root, "queued-1", 1_000, 4_000);
    session(&root, "plain-1", 2_000, 2_000);

    let guard: Arc<dyn SessionProtection> = Guard::new(&["queued-1"], "queued for analysis");
    let status = run(&root, 1_000, &[guard]);

    assert!(present(&root, "queued-1"));
    assert!(!present(&root, "plain-1"));
    assert_eq!(status.protected_sessions, 1);
}

/// Protection is asked for at the moment of deletion, not when the sweep was
/// planned. A session that starts recording while a sweep is already walking
/// the directory is therefore still safe.
#[test]
fn protection_is_consulted_at_the_moment_of_deletion() {
    struct LateGuard {
        asked: AtomicU64,
    }
    impl SessionProtection for LateGuard {
        fn is_protected(&self, session_id: &str) -> bool {
            // Becomes protected only once the sweep has already started and
            // asked about something else first.
            self.asked.fetch_add(1, Ordering::SeqCst);
            session_id == "late-2"
        }
        fn protection_reason(&self) -> &'static str {
            "became active mid-sweep"
        }
    }

    let root = scratch("late-protection");
    session(&root, "late-1", 1_000, 2_000);
    session(&root, "late-2", 2_000, 2_000);
    session(&root, "late-3", 3_000, 2_000);

    let guard = Arc::new(LateGuard {
        asked: AtomicU64::new(0),
    });
    let status = run(
        &root,
        2_000,
        &[Arc::clone(&guard) as Arc<dyn SessionProtection>],
    );

    assert!(!present(&root, "late-1"));
    assert!(present(&root, "late-2"), "protected during the sweep");
    assert!(!present(&root, "late-3"));
    assert_eq!(status.protected_sessions, 1);
    assert!(guard.asked.load(Ordering::SeqCst) >= 2);
}

/// Every protected session is still counted, so a budget that cannot be met
/// because everything is protected reports itself instead of looking like a
/// retention failure.
#[test]
fn a_fully_protected_directory_reports_over_budget_rather_than_deleting() {
    let root = scratch("all-protected");
    session(&root, "p-1", 1_000, 4_000);
    session(&root, "p-2", 2_000, 4_000);

    let guard: Arc<dyn SessionProtection> = Guard::new(&["p-1", "p-2"], "protected");
    let status = run(&root, 1_000, &[guard]);

    assert_eq!(ids(&root).len(), 2);
    assert_eq!(status.deleted_sessions, 0);
    assert_eq!(status.protected_sessions, 2);
    assert!(status.over_budget);
}

// ---------------------------------------------------- corrupt and foreign

/// A session whose manifest cannot be read has no established start time, so
/// oldest-first cannot honestly place it and it is never chosen for deletion.
/// Its bytes are still counted and reported separately, so a corrupt session
/// holding the budget down is visible rather than mysterious.
#[test]
fn a_session_with_an_unreadable_manifest_is_counted_but_never_deleted() {
    let root = scratch("unreadable-manifest");
    unreadable_session(&root, "broken-1", 4_000);
    session(&root, "good-1", 9_000, 2_000);

    let status = run(&root, 1_000, &[]);

    assert!(
        present(&root, "broken-1"),
        "an unidentifiable session stays"
    );
    assert!(!present(&root, "good-1"));
    assert_eq!(status.unidentifiable_sessions, 1);
    assert_eq!(status.unidentifiable_bytes, 4_000);
    assert!(status.over_budget);
    assert_eq!(status.used_bytes, 4_000);
}

/// A missing frame file is not an error. A session directory that lost its
/// contents still deletes cleanly and still counts.
#[test]
fn a_session_missing_its_frame_file_is_handled_without_failing() {
    let root = scratch("missing-frames");
    let directory = root.join("empty-1");
    fs::create_dir_all(&directory).unwrap();
    let mut manifest = SessionManifestV1::new("empty-1".into(), Some(1_000));
    manifest.status = SessionStatus::Completed;
    session_format::write_manifest_atomically(&directory, &manifest).unwrap();
    session(&root, "full-1", 2_000, 4_000);

    let status = run(&root, 1_000, &[]);

    assert!(!present(&root, "empty-1"));
    assert_eq!(status.failed_deletions, 0);
    assert!(status.last_error.is_none(), "{:?}", status.last_error);
}

/// A folder that is not a session identifier is not a session. It is neither
/// counted nor deleted, whatever it contains.
#[test]
fn a_foreign_folder_is_left_completely_alone() {
    let root = scratch("foreign-folder");
    fs::create_dir_all(root.join("my notes")).unwrap();
    fs::write(root.join("my notes").join("keep.txt"), vec![0_u8; 9_000]).unwrap();
    session(&root, "s-1", 1_000, 4_000);

    let status = run(&root, 1_000, &[]);

    assert!(root.join("my notes").join("keep.txt").is_file());
    assert!(!present(&root, "s-1"));
    // Only the real session was ever counted.
    assert_eq!(status.reclaimed_bytes, 4_000);
    assert_eq!(status.used_bytes, 0);
}

/// A directory left behind by a deletion that was interrupted is finished off
/// by the next sweep, and is never mistaken for a session in the meantime.
#[test]
fn a_leftover_deletion_marker_is_cleaned_up_and_never_listed() {
    let root = scratch("leftover-marker");
    let marker = root.join("ghost-1.rl-deleting");
    fs::create_dir_all(&marker).unwrap();
    let mut manifest = SessionManifestV1::new("ghost-1".into(), Some(1));
    manifest.status = SessionStatus::Completed;
    session_format::write_manifest_atomically(&marker, &manifest).unwrap();
    pad_to(&marker, 4_000);
    session(&root, "keep-1", 9_000, 2_000);

    // A generous budget, so nothing would be deleted for storage reasons.
    let status = run(&root, DEFAULT_STORAGE_BUDGET_BYTES, &[]);

    assert!(!marker.exists(), "the marker must be removed");
    assert!(present(&root, "keep-1"));
    // The marker's bytes were never counted as a retained session.
    assert_eq!(status.retained_sessions, 1);
    assert_eq!(status.used_bytes, 2_000);
    // And it never appeared in the normal session listing either.
    let listed = racelab_lib::session_store::list_recent_sessions(&root, None);
    assert_eq!(listed.sessions.len(), 1);
    assert_eq!(listed.sessions[0].session_id, "keep-1");
}

// --------------------------------------------------------------- reporting

/// Repeated sweeps are idempotent: once under budget, nothing further is
/// deleted however many times retention runs.
#[test]
fn a_second_sweep_deletes_nothing_further() {
    let root = scratch("idempotent");
    session(&root, "r-1", 1_000, 2_000);
    session(&root, "r-2", 2_000, 2_000);
    session(&root, "r-3", 3_000, 2_000);

    let mut status = RetentionStatus::default();
    let policy = RetentionPolicy {
        budget_bytes: 5_000,
    };
    sweep(&root, policy, &[], &mut status);
    let after_first = status.deleted_sessions;
    sweep(&root, policy, &[], &mut status);

    assert_eq!(after_first, 1);
    assert_eq!(
        status.deleted_sessions, 1,
        "the second sweep deleted nothing"
    );
    assert_eq!(status.sweeps, 2);
    assert_eq!(ids(&root).len(), 2);
}

/// Lifetime totals accumulate across sweeps, so nothing is ever deleted without
/// appearing in a number a user can read.
#[test]
fn deletions_accumulate_into_reportable_totals() {
    let root = scratch("totals");
    session(&root, "t-1", 1_000, 2_000);
    session(&root, "t-2", 2_000, 2_000);
    let mut status = RetentionStatus::default();

    sweep(
        &root,
        RetentionPolicy {
            budget_bytes: 3_000,
        },
        &[],
        &mut status,
    );
    session(&root, "t-3", 3_000, 2_000);
    sweep(
        &root,
        RetentionPolicy {
            budget_bytes: 1_000,
        },
        &[],
        &mut status,
    );

    assert_eq!(status.deleted_sessions, 3);
    assert_eq!(status.reclaimed_bytes, 6_000);
    assert!(status.last_sweep_unix_ms.is_some());
}

/// The default budget is large enough to be a safety net rather than a policy a
/// user trips over in normal play.
#[test]
fn the_default_budget_is_bounded_and_documented() {
    assert_eq!(DEFAULT_STORAGE_BUDGET_BYTES, 8 * 1024 * 1024 * 1024);
    assert!(RetentionPolicy::default().enabled());
    assert!(!RetentionPolicy { budget_bytes: 0 }.enabled());
}
