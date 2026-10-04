//! Interrupted-session recovery.
//!
//! Every test here starts from a recording that RaceLab never finished, because
//! that is the only way these paths are ever reached in production. The
//! scenarios are the real ones: a crash, a forced kill, a Windows shutdown, a
//! manifest checkpoint that is minutes behind the frame stream, and a frame
//! file that stops part-way through a record.
//!
//! Two things are asserted over and over, because they are the whole contract:
//! **the frame stream is never written**, and **an incomplete recording never
//! presents itself as complete**.
use racelab_lib::{
    analysis::AnalysisConfigV1,
    analysis_job,
    session_format::{
        self, FrameStreamEnd, FrameStreamHeader, RecordedFrame, RecoveryOutcome, RecoveryRecordV1,
        SessionManifestV1, SessionStatus, FRAME_FILE_NAME, FRAME_FORMAT_VERSION,
        TELEMETRY_FRAME_SCHEMA_VERSION,
    },
    session_recovery::{self, apply_recovery, scan_frame_stream},
    session_store,
    telemetry::{Controls, Engine, TelemetryFrame, Vector3},
};
use std::{
    fs,
    path::{Path, PathBuf},
};

mod scratch;
use scratch::Scratch;

fn scratch(name: &str) -> Scratch {
    Scratch::new(&format!("recovery-{name}"))
}

fn frame(active: bool, speed: f32) -> TelemetryFrame {
    TelemetryFrame {
        active,
        game: Some("fh6".into()),
        vehicle_id: Some("3520".into()),
        engine: Engine {
            rpm: Some(3_000.0),
            idle_rpm: Some(800.0),
            max_rpm: Some(7_000.0),
            ..Engine::default()
        },
        speed_mps: Some(speed),
        velocity: Some(Vector3 {
            x: speed,
            y: 0.0,
            z: 0.0,
        }),
        controls: Controls {
            throttle: Some(0.5),
            brake: Some(0.0),
            ..Controls::default()
        },
        ..TelemetryFrame::default()
    }
}

fn records(count: u64) -> Vec<RecordedFrame> {
    (0..count)
        .map(|index| RecordedFrame {
            sequence: index,
            monotonic_ms: index * 16,
            // Every fourth frame is inactive, so active/inactive counts are
            // distinguishable rather than both equal to the total.
            frame: frame(index % 4 != 0, 20.0 + index as f32 * 0.1),
        })
        .collect()
}

/// A frame stream as bytes, with the footer under the caller's control.
fn stream(session_id: &str, records: &[RecordedFrame], footer: bool) -> Vec<u8> {
    let mut bytes = Vec::new();
    session_format::write_stream_header(
        &mut bytes,
        &FrameStreamHeader {
            frame_format_version: FRAME_FORMAT_VERSION,
            telemetry_frame_schema_version: TELEMETRY_FRAME_SCHEMA_VERSION,
            session_id: session_id.into(),
            started_at_unix_ms: 1_800_000_000_000,
        },
    )
    .unwrap();
    for record in records {
        session_format::write_frame(
            &mut bytes,
            record.sequence,
            record.monotonic_ms,
            &record.frame,
        )
        .unwrap();
    }
    if footer {
        session_format::write_stream_end(
            &mut bytes,
            &FrameStreamEnd {
                frame_count: records.len() as u64,
                duration_us: 0,
                recorder_dropped_frames: 0,
            },
        )
        .unwrap();
    }
    bytes
}

/// A session directory exactly as a crashed process leaves one: the frame
/// stream holds whatever reached the disk, and the manifest holds the last
/// checkpoint, which can be far behind it.
fn crashed_session(
    root: &Path,
    id: &str,
    bytes: Vec<u8>,
    status: SessionStatus,
    checkpointed_frames: u64,
) -> PathBuf {
    let directory = root.join(id);
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join(FRAME_FILE_NAME), bytes).unwrap();
    let mut manifest = SessionManifestV1::new(id.into(), Some(1_800_000_000_000));
    manifest.status = status;
    manifest.frame_count = checkpointed_frames;
    manifest.active_frame_count = checkpointed_frames;
    session_format::write_manifest_atomically(&directory, &manifest).unwrap();
    directory
}

// --------------------------------------------------------- classification

/// A manifest still marked `recording` at startup belongs to a process that
/// never finished. It becomes interrupted, loses any summary, and is marked as
/// awaiting a scan — never completed.
#[test]
fn a_recording_manifest_is_reclassified_as_interrupted_and_awaits_a_scan() {
    let root = scratch("classify");
    crashed_session(
        &root,
        "crash-1",
        stream("crash-1", &records(10), false),
        SessionStatus::Recording,
        3,
    );

    let reclassified = session_recovery::classify_interrupted_sessions(&root).unwrap();

    assert_eq!(reclassified, 1);
    let manifest = session_store::get_session(&root, "crash-1").unwrap();
    assert_eq!(manifest.status, SessionStatus::Interrupted);
    assert!(manifest.summary.is_none());
    assert_eq!(
        manifest.completion_reason.as_deref(),
        Some("interrupted_racelab_did_not_finalize")
    );
    assert_eq!(
        manifest.recovery.as_ref().map(|r| r.outcome),
        Some(RecoveryOutcome::Pending)
    );
    // Nothing has read the frames yet, so nothing claims to know them.
    assert!(!manifest.has_analyzable_coverage());
}

/// A completed session is never touched by classification, whatever else is in
/// the directory. Recovery is for recordings that were interrupted.
#[test]
fn a_completed_session_is_never_reclassified() {
    let root = scratch("classify-completed");
    let directory = crashed_session(
        &root,
        "done-1",
        stream("done-1", &records(10), true),
        SessionStatus::Completed,
        10,
    );
    let before = fs::read(directory.join("manifest.json")).unwrap();

    assert_eq!(
        session_recovery::classify_interrupted_sessions(&root).unwrap(),
        0
    );
    assert_eq!(before, fs::read(directory.join("manifest.json")).unwrap());
}

/// A session whose manifest cannot be parsed never blocks the others.
#[test]
fn an_unreadable_manifest_does_not_stop_classification() {
    let root = scratch("classify-unreadable");
    let broken = root.join("broken-1");
    fs::create_dir_all(&broken).unwrap();
    fs::write(broken.join("manifest.json"), b"{{{ not json").unwrap();
    crashed_session(
        &root,
        "crash-2",
        stream("crash-2", &records(5), false),
        SessionStatus::Recording,
        0,
    );

    assert_eq!(
        session_recovery::classify_interrupted_sessions(&root).unwrap(),
        1
    );
    assert_eq!(
        session_store::get_session(&root, "crash-2").unwrap().status,
        SessionStatus::Interrupted
    );
}

/// Classification runs before anything else and must never fail on a sessions
/// directory that does not exist yet.
#[test]
fn a_missing_sessions_directory_is_not_an_error() {
    let root = scratch("classify-missing");
    let absent = root.join("never-created");
    assert_eq!(
        session_recovery::classify_interrupted_sessions(&absent).unwrap(),
        0
    );
}

// ------------------------------------------------------------- the scan

/// A stream with its footer intact reads completely, even though the session
/// was interrupted. A crash between finalizing the frame stream and finalizing
/// the manifest produces exactly this.
#[test]
fn a_footered_stream_recovers_completely() {
    let root = scratch("scan-complete");
    let directory = crashed_session(
        &root,
        "crash-3",
        stream("crash-3", &records(40), true),
        SessionStatus::Interrupted,
        0,
    );

    let recovery = scan_frame_stream(&directory);

    assert_eq!(recovery.outcome, RecoveryOutcome::Complete);
    assert_eq!(recovery.readable_frame_count, 40);
    assert_eq!(recovery.readable_active_frame_count, 30);
    assert!(recovery.frame_stream_complete);
    assert!(recovery.scanned_at_unix_ms.is_some());
}

/// A stream with no footer is the ordinary shape of a crashed recording. Every
/// frame it holds is intact and is recovered; the stream is reported incomplete.
#[test]
fn a_footerless_stream_recovers_every_frame_it_holds() {
    let root = scratch("scan-footerless");
    let directory = crashed_session(
        &root,
        "crash-4",
        stream("crash-4", &records(40), false),
        SessionStatus::Interrupted,
        0,
    );

    let recovery = scan_frame_stream(&directory);

    assert_eq!(recovery.outcome, RecoveryOutcome::Truncated);
    assert_eq!(recovery.readable_frame_count, 40);
    assert!(!recovery.frame_stream_complete);
    assert!(
        recovery.detail.is_some(),
        "the reader is told what happened"
    );
}

/// A file that stops part-way through a record — a process killed between two
/// writes — keeps every complete record before the cut.
#[test]
fn a_stream_cut_mid_record_keeps_every_complete_frame_before_the_cut() {
    let root = scratch("scan-truncated");
    let whole = stream("crash-5", &records(40), false);
    let complete = scan_frame_stream(&crashed_session(
        &scratch("scan-truncated-reference"),
        "crash-5",
        whole.clone(),
        SessionStatus::Interrupted,
        0,
    ))
    .readable_frame_count;
    // Cut well inside the final record.
    let cut = whole[..whole.len() - 30].to_vec();
    let directory = crashed_session(&root, "crash-5", cut, SessionStatus::Interrupted, 0);

    let recovery = scan_frame_stream(&directory);

    assert_eq!(recovery.outcome, RecoveryOutcome::Truncated);
    assert_eq!(
        recovery.readable_frame_count,
        complete - 1,
        "exactly the cut record is lost"
    );
    assert!(!recovery.frame_stream_complete);
}

/// Damage in the middle of a file is not an ending. It is reported as damage,
/// and only the records before it are claimed.
#[test]
fn a_damaged_record_stops_the_scan_and_is_reported_as_damage() {
    let root = scratch("scan-damaged");
    let mut bytes = stream("crash-6", &records(4), false);
    // A record whose length is fully present and whose payload cannot decode.
    bytes.push(1);
    bytes.extend_from_slice(&8_u32.to_le_bytes());
    bytes.extend_from_slice(&[0xC1; 8]);
    bytes.extend_from_slice(&stream("crash-6", &records(4), false)[40..]);
    let directory = crashed_session(&root, "crash-6", bytes, SessionStatus::Interrupted, 0);

    let recovery = scan_frame_stream(&directory);

    assert_eq!(recovery.outcome, RecoveryOutcome::Damaged);
    assert_eq!(recovery.readable_frame_count, 4);
    assert!(recovery.detail.is_some());
}

/// A missing or unopenable frame stream is its own outcome, and claims nothing.
#[test]
fn a_missing_frame_stream_recovers_nothing_and_says_so() {
    let root = scratch("scan-missing");
    let directory = root.join("crash-7");
    fs::create_dir_all(&directory).unwrap();

    let recovery = scan_frame_stream(&directory);

    assert_eq!(recovery.outcome, RecoveryOutcome::Unreadable);
    assert_eq!(recovery.readable_frame_count, 0);
    assert!(!recovery.outcome.has_readable_coverage());
}

/// A frame stream whose header is not RLFRAMES at all is unreadable, and the
/// scan says so instead of failing.
#[test]
fn a_garbage_frame_stream_does_not_crash_the_scan() {
    let root = scratch("scan-garbage");
    let directory = crashed_session(
        &root,
        "crash-8",
        vec![0xAB; 4096],
        SessionStatus::Interrupted,
        0,
    );

    let recovery = scan_frame_stream(&directory);

    assert_eq!(recovery.outcome, RecoveryOutcome::Unreadable);
    assert_eq!(recovery.readable_frame_count, 0);
}

// ----------------------------------------------------- applying the scan

/// The case that actually exists on disk: a manifest that says zero frames
/// beside a frame stream holding thousands.
///
/// This is not hypothetical. Recordings made before the recorder checkpointed
/// its manifest were left exactly like this by a crash, and reading only the
/// manifest reports a session that captured nothing.
#[test]
fn a_checkpointed_manifest_is_raised_to_what_the_stream_actually_holds() {
    let root = scratch("apply-behind");
    let directory = crashed_session(
        &root,
        "crash-9",
        stream("crash-9", &records(40), false),
        SessionStatus::Interrupted,
        0,
    );
    let frames_before = fs::read(directory.join(FRAME_FILE_NAME)).unwrap();

    let mut manifest = session_format::read_manifest(&directory).unwrap();
    let recovered = apply_recovery(&mut manifest, scan_frame_stream(&directory));

    assert_eq!(recovered, 40);
    assert_eq!(manifest.frame_count, 40);
    assert_eq!(manifest.active_frame_count, 30);
    assert_eq!(manifest.inactive_frame_count, 10);
    assert!(manifest.duration_us > 0);
    // Still interrupted, still without a summary.
    assert_eq!(manifest.status, SessionStatus::Interrupted);
    assert!(manifest.summary.is_none());
    // And the recording itself is untouched.
    assert_eq!(
        frames_before,
        fs::read(directory.join(FRAME_FILE_NAME)).unwrap()
    );
}

/// Recovery can only ever raise a count. A manifest that already reports more
/// than the scan could read keeps its own number, and the disagreement stays
/// visible rather than being quietly resolved downwards.
#[test]
fn recovery_never_lowers_a_count_it_cannot_verify() {
    let root = scratch("apply-never-lower");
    let directory = crashed_session(
        &root,
        "crash-10",
        stream("crash-10", &records(4), false),
        SessionStatus::Interrupted,
        1_000,
    );

    let mut manifest = session_format::read_manifest(&directory).unwrap();
    let recovered = apply_recovery(&mut manifest, scan_frame_stream(&directory));

    assert_eq!(recovered, 0);
    assert_eq!(manifest.frame_count, 1_000, "the claim is left standing");
    assert_eq!(
        manifest.recovery.as_ref().unwrap().readable_frame_count,
        4,
        "and the truth is recorded beside it"
    );
}

/// An interrupted session never gains a summary, however much of it recovered.
#[test]
fn recovery_never_produces_a_summary() {
    let root = scratch("apply-no-summary");
    let directory = crashed_session(
        &root,
        "crash-11",
        stream("crash-11", &records(40), true),
        SessionStatus::Interrupted,
        0,
    );

    let mut manifest = session_format::read_manifest(&directory).unwrap();
    apply_recovery(&mut manifest, scan_frame_stream(&directory));

    assert!(manifest.summary.is_none());
    assert_eq!(manifest.status, SessionStatus::Interrupted);
}

// ------------------------------------------------------ analysis gating

/// Analysis is allowed only once a scan has established readable coverage.
/// Before that, the session has not been inspected and analyzing it would be
/// guessing about its contents.
#[test]
fn analysis_is_refused_until_recovery_has_established_coverage() {
    let root = scratch("gate-pending");
    let directory = crashed_session(
        &root,
        "crash-12",
        stream("crash-12", &records(40), false),
        SessionStatus::Interrupted,
        0,
    );
    let mut manifest = session_format::read_manifest(&directory).unwrap();
    manifest.recovery = Some(RecoveryRecordV1::pending());
    session_format::write_manifest_atomically(&directory, &manifest).unwrap();

    let refused = analysis_job::analyze_one(&root, "crash-12", AnalysisConfigV1::default());
    assert!(
        refused.is_err(),
        "a session nothing has read is not analyzed"
    );
    assert!(!directory.join("analysis.json").exists());

    // After the scan, the same session analyzes normally.
    let mut manifest = session_format::read_manifest(&directory).unwrap();
    apply_recovery(&mut manifest, scan_frame_stream(&directory));
    session_format::write_manifest_atomically(&directory, &manifest).unwrap();

    analysis_job::analyze_one(&root, "crash-12", AnalysisConfigV1::default())
        .expect("recovered coverage is analyzable");
    let analysis = racelab_lib::analysis::read_analysis(&directory).unwrap();
    assert_eq!(analysis.data_quality.frames_read, 40);
    // The analysis is honest about the recording it came from.
    assert!(!analysis.data_quality.frame_stream_complete);
}

/// A session still being recorded is never analyzed: its frame file is open and
/// growing, so any analysis of it would describe a moment already gone.
#[test]
fn a_session_still_recording_is_never_analyzed() {
    let root = scratch("gate-recording");
    crashed_session(
        &root,
        "live-1",
        stream("live-1", &records(40), false),
        SessionStatus::Recording,
        10,
    );

    let refused = analysis_job::analyze_one(&root, "live-1", AnalysisConfigV1::default())
        .expect_err("a live recording is not analyzable");
    assert!(refused.contains("still being recorded"), "{refused}");
}

/// A session with no readable frames at all is never analyzed, and never
/// offered a re-analysis, because there is nothing for one to read.
#[test]
fn a_session_with_no_readable_frames_is_never_analyzed() {
    let root = scratch("gate-empty");
    let directory = crashed_session(
        &root,
        "crash-13",
        vec![0xAB; 512],
        SessionStatus::Interrupted,
        0,
    );
    let mut manifest = session_format::read_manifest(&directory).unwrap();
    apply_recovery(&mut manifest, scan_frame_stream(&directory));
    session_format::write_manifest_atomically(&directory, &manifest).unwrap();

    assert!(!manifest.has_analyzable_coverage());
    assert!(analysis_job::analyze_one(&root, "crash-13", AnalysisConfigV1::default()).is_err());
    let state = session_store::get_session_analysis(&root, "crash-13", None).unwrap();
    assert!(!state.can_reanalyze);
}

// ------------------------------------------------------- the whole service

/// End to end, on a directory holding every case at once: the service
/// classifies, scans and records, and one damaged session never stops the rest.
#[test]
fn the_recovery_service_scans_every_interrupted_session_once() {
    let root = scratch("service");
    crashed_session(
        &root,
        "svc-1",
        stream("svc-1", &records(40), false),
        SessionStatus::Recording,
        0,
    );
    crashed_session(
        &root,
        "svc-2",
        stream("svc-2", &records(20), true),
        SessionStatus::Recording,
        0,
    );
    crashed_session(&root, "svc-3", vec![0x00; 64], SessionStatus::Recording, 0);
    let completed = crashed_session(
        &root,
        "svc-4",
        stream("svc-4", &records(10), true),
        SessionStatus::Completed,
        10,
    );
    let completed_before = fs::read(completed.join("manifest.json")).unwrap();

    let service = session_recovery::RecoveryService::start(root.to_path_buf()).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while service.status().scanned < 3 {
        assert!(
            std::time::Instant::now() < deadline,
            "recovery never finished: {:?}",
            service.status()
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    let status = service.status();
    service.shutdown();

    assert_eq!(status.reclassified, 3);
    assert_eq!(status.scanned, 3);
    assert_eq!(status.truncated, 1);
    assert_eq!(status.complete, 1);
    assert_eq!(status.unreadable, 1);
    assert_eq!(status.recovered_frames, 60);
    // The completed session was never touched.
    assert_eq!(
        completed_before,
        fs::read(completed.join("manifest.json")).unwrap()
    );
    // And every interrupted one now carries a finished recovery record.
    for id in ["svc-1", "svc-2", "svc-3"] {
        let manifest = session_store::get_session(&root, id).unwrap();
        assert_eq!(manifest.status, SessionStatus::Interrupted);
        assert_ne!(
            manifest.recovery.as_ref().unwrap().outcome,
            RecoveryOutcome::Pending,
            "{id} was never scanned"
        );
    }
}

/// A second run does not rescan what the first one already established: the
/// frame stream cannot change, so the answer cannot either.
#[test]
fn a_finished_recovery_record_is_not_rescanned() {
    let root = scratch("service-idempotent");
    crashed_session(
        &root,
        "again-1",
        stream("again-1", &records(20), false),
        SessionStatus::Recording,
        0,
    );

    let first = session_recovery::RecoveryService::start(root.to_path_buf()).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while first.status().scanned < 1 {
        assert!(std::time::Instant::now() < deadline, "never scanned");
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    first.shutdown();
    let after_first = fs::read(root.join("again-1").join("manifest.json")).unwrap();

    let second = session_recovery::RecoveryService::start(root.to_path_buf()).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(300));
    let status = second.status();
    second.shutdown();

    assert_eq!(status.reclassified, 0);
    assert_eq!(status.scanned, 0, "nothing was rescanned");
    assert_eq!(
        after_first,
        fs::read(root.join("again-1").join("manifest.json")).unwrap(),
        "and the manifest was not rewritten"
    );
}

// ------------------------------------------------------- real recordings

/// Recovery against **real interrupted recordings**, on a copy.
///
/// Ignored by default because it needs a sessions directory that actually
/// contains crashed recordings, which only a machine that has run RaceLab does.
/// It is the only test here whose input RaceLab did not synthesize, and it is
/// how the V0.10 recovery numbers in `docs/V0.10-VALIDATION.md` were produced.
///
/// It copies every interrupted session to a scratch directory first. The
/// originals are opened read-only and are never written, because a test must not
/// be able to damage the evidence corpus.
///
/// ```powershell
/// $env:RACELAB_REAL_SESSIONS = "$env:LOCALAPPDATA\com.tahagurvardar.racelab\sessions"
/// cargo test --release --manifest-path src-tauri/Cargo.toml --test session_recovery -- --ignored --nocapture
/// ```
#[test]
#[ignore = "needs RACELAB_REAL_SESSIONS pointing at a real sessions directory"]
fn real_interrupted_recordings_recover_their_frames() {
    let Ok(source) = std::env::var("RACELAB_REAL_SESSIONS") else {
        panic!("set RACELAB_REAL_SESSIONS to a sessions directory");
    };
    let source = PathBuf::from(source);
    let root = scratch("real");

    // Copy only the interrupted sessions, and only their files.
    let mut copied = Vec::new();
    for entry in fs::read_dir(&source).unwrap().flatten() {
        let directory = entry.path();
        if !directory.is_dir() {
            continue;
        }
        let Ok(manifest) = session_format::read_manifest(&directory) else {
            continue;
        };
        if manifest.status != SessionStatus::Interrupted {
            continue;
        }
        let target = root.join(&manifest.session_id);
        fs::create_dir_all(&target).unwrap();
        for file in fs::read_dir(&directory).unwrap().flatten() {
            if file.path().is_file() {
                fs::copy(file.path(), target.join(file.file_name())).unwrap();
            }
        }
        // Finished recovery records are intentionally not rescanned. Reset
        // only the scratch copy so this test also exercises real recordings
        // that the installed app has already recovered. Never edit the source.
        let mut pending = manifest.clone();
        pending.recovery = None;
        session_format::write_manifest_atomically(&target, &pending).unwrap();
        copied.push((manifest.session_id, manifest.frame_count));
    }
    assert!(
        !copied.is_empty(),
        "no interrupted sessions found in {}",
        source.display()
    );
    println!(
        "copied {} interrupted session(s) from {}",
        copied.len(),
        source.display()
    );

    let service = session_recovery::RecoveryService::start(root.to_path_buf()).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(600);
    while service.status().scanned < copied.len() as u64 {
        assert!(
            std::time::Instant::now() < deadline,
            "recovery did not finish: {:?}",
            service.status()
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let status = service.status();
    service.shutdown();

    println!(
        "scanned {} | complete {} | truncated {} | damaged {} | unreadable {} | frames recovered {}",
        status.scanned,
        status.complete,
        status.truncated,
        status.damaged,
        status.unreadable,
        status.recovered_frames
    );
    for (id, claimed) in &copied {
        let manifest = session_store::get_session(&root, id).unwrap();
        let recovery = manifest.recovery.as_ref().expect("a recovery record");
        println!(
            "  {id}: manifest claimed {claimed} frames, {} readable ({}), {:.1}s",
            recovery.readable_frame_count,
            recovery.outcome.as_str(),
            recovery.readable_duration_us as f64 / 1e6,
        );
        // The invariants, on real data: still interrupted, still no summary.
        assert_eq!(manifest.status, SessionStatus::Interrupted);
        assert!(manifest.summary.is_none());
        assert_ne!(recovery.outcome, RecoveryOutcome::Pending);
    }
}
