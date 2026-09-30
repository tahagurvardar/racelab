//! Analysis job product state.
//!
//! V0.9 exposed one "pending" state, which meant a session waiting behind a
//! long analysis looked exactly like one being analyzed, and a session whose
//! analysis had *failed* looked exactly like one that had never been analyzed
//! at all. Those are four different things to tell a user and this is where
//! they are kept apart.
//!
//! The state mapping is tested against hand-built job records rather than
//! against a racing worker, so each state is asserted exactly and none of these
//! tests can flake. The live-runner tests below then assert the invariants that
//! must hold whatever the timing is.
use racelab_lib::{
    analysis::{AnalysisConfigV1, ANALYSIS_FILE_NAME, ANALYSIS_SCHEMA_VERSION},
    analysis_job::{self, AnalysisRunner, JobRecord, JobState},
    session_format::{
        self, FrameStreamEnd, FrameStreamHeader, RecordedFrame, SessionManifestV1, SessionStatus,
        FRAME_FORMAT_VERSION, TELEMETRY_FRAME_SCHEMA_VERSION,
    },
    session_store::{self, AnalysisAvailability},
    telemetry::{Controls, Engine, TelemetryFrame, Vector3},
};
use std::{
    fs,
    path::Path,
    time::{Duration, Instant},
};

mod scratch;
use scratch::Scratch;

fn scratch(name: &str) -> Scratch {
    Scratch::new(&format!("jobs-{name}"))
}

fn record(index: u64) -> RecordedFrame {
    RecordedFrame {
        sequence: index,
        monotonic_ms: index * 16,
        frame: TelemetryFrame {
            active: true,
            game: Some("fh6".into()),
            vehicle_id: Some("3520".into()),
            engine: Engine {
                rpm: Some(3_000.0),
                idle_rpm: Some(800.0),
                max_rpm: Some(7_000.0),
                ..Engine::default()
            },
            speed_mps: Some(30.0),
            velocity: Some(Vector3 {
                x: 30.0,
                y: 0.0,
                z: 0.0,
            }),
            controls: Controls {
                throttle: Some(1.0),
                brake: Some(0.0),
                ..Controls::default()
            },
            ..TelemetryFrame::default()
        },
    }
}

fn session(root: &Path, id: &str, frames: u64) {
    let directory = root.join(id);
    fs::create_dir_all(&directory).unwrap();
    let mut writer = session_format::FrameStreamWriter::create(
        &directory,
        &FrameStreamHeader {
            frame_format_version: FRAME_FORMAT_VERSION,
            telemetry_frame_schema_version: TELEMETRY_FRAME_SCHEMA_VERSION,
            session_id: id.into(),
            started_at_unix_ms: 1_800_000_000_000,
        },
    )
    .unwrap();
    for index in 0..frames {
        let record = record(index);
        writer
            .write(record.sequence, record.monotonic_ms, &record.frame)
            .unwrap();
    }
    writer
        .finish(&FrameStreamEnd {
            frame_count: frames,
            duration_us: frames * 16_000,
            recorder_dropped_frames: 0,
        })
        .unwrap();
    let mut manifest = SessionManifestV1::new(id.into(), Some(1_800_000_000_000));
    manifest.status = SessionStatus::Completed;
    manifest.frame_count = frames;
    manifest.active_frame_count = frames;
    session_format::write_manifest_atomically(&directory, &manifest).unwrap();
}

fn state(root: &Path, id: &str, job: Option<JobRecord>) -> session_store::SessionAnalysisState {
    session_store::get_session_analysis(root, id, job).unwrap()
}

// ------------------------------------------------- the six product states

/// A completed session nothing has ever asked to analyze is "not analyzed".
///
/// It is emphatically not "analysis found nothing": a recording made before
/// V0.9 has no analysis because none was ever run, and presenting that as an
/// empty result would invite the reader to conclude they drove badly.
#[test]
fn a_session_with_no_analysis_and_no_job_reports_not_analyzed() {
    let root = scratch("not-analyzed");
    session(&root, "s-1", 8);

    let state = state(&root, "s-1", None);

    assert_eq!(state.state, AnalysisAvailability::NotAnalyzed);
    assert!(state.analysis.is_none());
    assert!(state.message.is_some());
    assert!(
        state.can_reanalyze,
        "it is completed, so it can be analyzed"
    );
}

/// A session waiting for the worker says it is waiting, and says how long it
/// has been waiting. That number is what stops a queue looking like a hang.
#[test]
fn a_queued_session_reports_queued_with_its_wait() {
    let root = scratch("queued");
    session(&root, "s-2", 8);
    let requested = 1_000_000;
    let mut job = JobRecord::queued("s-2", requested);
    job.queued_ms = 4_200;

    let state = state(&root, "s-2", Some(job));

    assert_eq!(state.state, AnalysisAvailability::Queued);
    assert_eq!(state.queued_ms, Some(4_200));
    assert!(state.analysis_duration_ms.is_none());
    assert!(!state.can_reanalyze, "it is already on its way");
}

/// A session being analyzed is distinguishable from one that is merely queued.
#[test]
fn an_analyzing_session_reports_analyzing_and_not_queued() {
    let root = scratch("analyzing");
    session(&root, "s-3", 8);

    let state = state(&root, "s-3", Some(JobRecord::analyzing("s-3", 1_000, 250)));

    assert_eq!(state.state, AnalysisAvailability::Analyzing);
    assert_eq!(state.queued_ms, Some(250));
    assert!(!state.can_reanalyze);
}

/// A failed job explains itself. The failure must never be reported as an
/// absence: a silent failure is the one outcome this model exists to prevent.
#[test]
fn a_failed_job_reports_failed_with_a_reason() {
    let root = scratch("failed");
    session(&root, "s-4", 8);

    let state = state(
        &root,
        "s-4",
        Some(JobRecord::failed(
            "s-4",
            "Could not analyze the frame stream",
        )),
    );

    assert_eq!(state.state, AnalysisAvailability::Failed);
    assert_eq!(
        state.failure_reason.as_deref(),
        Some("Could not analyze the frame stream")
    );
    assert!(state.can_reanalyze, "a failure is exactly what to retry");
}

/// A readable analysis of a supported schema is available, with its own
/// recorded timings carried through from the document.
#[test]
fn an_analyzed_session_reports_available() {
    let root = scratch("available");
    session(&root, "s-5", 32);
    analysis_job::analyze_one(&root, "s-5", AnalysisConfigV1::default()).unwrap();

    let state = state(&root, "s-5", None);

    assert_eq!(state.state, AnalysisAvailability::Available);
    let analysis = state.analysis.expect("the document is carried");
    assert_eq!(analysis.schema_version, ANALYSIS_SCHEMA_VERSION);
    assert_eq!(state.analysis_schema_version, Some(ANALYSIS_SCHEMA_VERSION));
    assert!(state.can_reanalyze);
}

/// An analysis written by a schema this build cannot read is its own state, and
/// says the recording is unaffected.
#[test]
fn an_analysis_from_an_unknown_schema_reports_unsupported_schema() {
    let root = scratch("unsupported");
    session(&root, "s-6", 8);
    fs::write(
        root.join("s-6").join(ANALYSIS_FILE_NAME),
        format!(r#"{{"schema_version": {}}}"#, ANALYSIS_SCHEMA_VERSION + 7),
    )
    .unwrap();

    let state = state(&root, "s-6", None);

    assert_eq!(state.state, AnalysisAvailability::UnsupportedSchema);
    assert_eq!(
        state.analysis_schema_version,
        Some(ANALYSIS_SCHEMA_VERSION + 7)
    );
    assert!(state.can_reanalyze, "it can be regenerated from the frames");
}

/// An analysis file that exists but cannot be parsed is a failure, not an
/// absence, and the recording stays readable either way.
#[test]
fn an_unparseable_analysis_reports_failed() {
    let root = scratch("corrupt-analysis");
    session(&root, "s-7", 8);
    fs::write(root.join("s-7").join(ANALYSIS_FILE_NAME), b"{ truncated").unwrap();

    let state = state(&root, "s-7", None);

    assert_eq!(state.state, AnalysisAvailability::Failed);
    assert!(state.message.is_some());
    assert_eq!(
        session_store::get_session(&root, "s-7").unwrap().status,
        SessionStatus::Completed
    );
}

// ----------------------------------------------------------- precedence

/// An in-flight job outranks whatever is on disk: a session being re-analyzed
/// says so, rather than showing a previous result as though it were current.
#[test]
fn an_in_flight_job_outranks_a_previous_analysis() {
    let root = scratch("precedence-inflight");
    session(&root, "s-8", 32);
    analysis_job::analyze_one(&root, "s-8", AnalysisConfigV1::default()).unwrap();

    let state = state(&root, "s-8", Some(JobRecord::analyzing("s-8", 0, 0)));

    assert_eq!(state.state, AnalysisAvailability::Analyzing);
    assert!(
        state.analysis.is_none(),
        "a stale document is not shown as current"
    );
}

/// A failed re-analysis leaves the previous analysis readable and current. The
/// atomic write guarantees this, and the state model must not hide it.
#[test]
fn a_failed_job_does_not_hide_a_previous_successful_analysis() {
    let root = scratch("precedence-failed");
    session(&root, "s-9", 32);
    analysis_job::analyze_one(&root, "s-9", AnalysisConfigV1::default()).unwrap();

    let state = state(&root, "s-9", Some(JobRecord::failed("s-9", "disk error")));

    assert_eq!(state.state, AnalysisAvailability::Available);
    assert!(state.analysis.is_some());
    // The failure is still reported alongside, rather than being erased.
    assert_eq!(state.failure_reason.as_deref(), Some("disk error"));
}

// -------------------------------------------------------- the live runner

/// Whatever the timing, a session that has been requested is **never** reported
/// as "not analyzed". That is the invariant the six-state model exists for, and
/// it is the one a race could actually break.
#[test]
fn a_requested_session_is_never_reported_as_not_analyzed() {
    let root = scratch("never-absent");
    for index in 0..6 {
        session(&root, &format!("live-{index}"), 400);
    }
    let analyzer = AnalysisRunner::new(root.to_path_buf(), AnalysisConfigV1::default()).unwrap();
    for index in 0..6 {
        assert!(analyzer.request(&format!("live-{index}")));
    }

    let mut seen_in_flight = false;
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let mut all_done = true;
        for index in 0..6 {
            let id = format!("live-{index}");
            let state = state(&root, &id, analyzer.job(&id));
            assert_ne!(
                state.state,
                AnalysisAvailability::NotAnalyzed,
                "{id} was requested but reported as never analyzed"
            );
            match state.state {
                AnalysisAvailability::Queued | AnalysisAvailability::Analyzing => {
                    seen_in_flight = true;
                    all_done = false;
                }
                AnalysisAvailability::Available => {}
                other => panic!("{id} reached {other:?}"),
            }
        }
        if all_done {
            break;
        }
        assert!(Instant::now() < deadline, "analysis never finished");
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(seen_in_flight, "the in-flight states were never observable");
    analyzer.shutdown();
}

/// Queue wait and analysis time are separate numbers and are never summed. A
/// short session finishing behind a long one waited; it was not slow.
#[test]
fn queue_wait_and_analysis_time_are_reported_separately() {
    let root = scratch("timings");
    session(&root, "big-1", 6_000);
    session(&root, "small-1", 32);
    let analyzer = AnalysisRunner::new(root.to_path_buf(), AnalysisConfigV1::default()).unwrap();
    assert!(analyzer.request("big-1"));
    assert!(analyzer.request("small-1"));

    let deadline = Instant::now() + Duration::from_secs(60);
    while analyzer.status().analyzed_sessions < 2 {
        assert!(Instant::now() < deadline, "{:?}", analyzer.status());
        std::thread::sleep(Duration::from_millis(5));
    }
    analyzer.shutdown();

    // The small session's own analysis recorded both numbers independently.
    let analysis = racelab_lib::analysis::read_analysis(&root.join("small-1")).unwrap();
    assert!(analysis.queued_ms.is_some());
    assert!(analysis.requested_at_unix_ms.is_some());
    // The queue wait is not folded into the analysis duration.
    assert!(
        analysis.analysis_duration_ms < analysis.queued_ms.unwrap() + 10_000,
        "analysis duration {} must not absorb the queue wait {:?}",
        analysis.analysis_duration_ms,
        analysis.queued_ms
    );
}

/// A request refused because the queue was full is recorded as a failure with a
/// reason, not erased. A session that silently never gets analyzed is exactly
/// the outcome the ledger exists to prevent.
#[test]
fn a_request_refused_by_a_full_queue_is_remembered_as_a_failure() {
    let root = scratch("queue-full");
    let total = analysis_job::ANALYSIS_QUEUE_CAPACITY * 6;
    session(&root, "block-1", 6_000);
    for index in 0..total {
        session(&root, &format!("bulk-{index}"), 8);
    }
    let analyzer = AnalysisRunner::new(root.to_path_buf(), AnalysisConfigV1::default()).unwrap();
    // Occupy the worker so the queue can actually fill.
    assert!(analyzer.request("block-1"));

    let mut refused = Vec::new();
    for index in 0..total {
        let id = format!("bulk-{index}");
        if !analyzer.request(&id) {
            refused.push(id);
        }
    }
    assert!(
        !refused.is_empty(),
        "the queue must be bounded; nothing was refused"
    );
    // Every refusal is readable as a failure with an explanation.
    for id in &refused {
        let state = state(&root, id, analyzer.job(id));
        assert_eq!(
            state.state,
            AnalysisAvailability::Failed,
            "{id} was refused but does not say so"
        );
        assert!(state.failure_reason.is_some());
    }
    assert!(analyzer.status().rejected_requests >= refused.len() as u64);
    analyzer.shutdown();
}

// ------------------------------------------------------------ reanalysis

/// Re-analysis replaces `analysis.json` and touches nothing else. The frame
/// stream and the manifest are byte-identical afterwards.
#[test]
fn reanalysis_replaces_only_the_analysis_document() {
    let root = scratch("reanalyze");
    session(&root, "again-1", 64);
    let directory = root.join("again-1");
    analysis_job::analyze_one(&root, "again-1", AnalysisConfigV1::default()).unwrap();

    let frames_before = fs::read(directory.join("frames.rlframes")).unwrap();
    let manifest_before = fs::read(directory.join("manifest.json")).unwrap();
    let first = fs::read(directory.join(ANALYSIS_FILE_NAME)).unwrap();

    // A different configuration, so the replacement is observable.
    let config = AnalysisConfigV1 {
        full_throttle_enter: 0.10,
        ..AnalysisConfigV1::default()
    };
    analysis_job::analyze_one(&root, "again-1", config).unwrap();

    assert_eq!(
        frames_before,
        fs::read(directory.join("frames.rlframes")).unwrap(),
        "frames.rlframes must never be written"
    );
    assert_eq!(
        manifest_before,
        fs::read(directory.join("manifest.json")).unwrap(),
        "manifest.json must never be written"
    );
    let second = fs::read(directory.join(ANALYSIS_FILE_NAME)).unwrap();
    assert_ne!(first, second, "the analysis was not replaced");
    assert!(!directory.join("analysis.json.tmp").exists());
    let replaced = racelab_lib::analysis::read_analysis(&directory).unwrap();
    assert_eq!(replaced.config.full_throttle_enter, 0.10);
}

/// An analysis this build cannot read is regenerated from the persisted frame
/// stream, which is the whole reason the frame stream is kept.
#[test]
fn an_unsupported_analysis_can_be_regenerated_from_the_frames() {
    let root = scratch("regenerate");
    session(&root, "old-1", 64);
    let directory = root.join("old-1");
    fs::write(
        directory.join(ANALYSIS_FILE_NAME),
        br#"{"schema_version": 1, "whatever": true}"#,
    )
    .unwrap();
    assert_eq!(
        state(&root, "old-1", None).state,
        AnalysisAvailability::UnsupportedSchema
    );

    analysis_job::analyze_one(&root, "old-1", AnalysisConfigV1::default()).unwrap();

    let state = state(&root, "old-1", None);
    assert_eq!(state.state, AnalysisAvailability::Available);
    assert_eq!(state.analysis_schema_version, Some(ANALYSIS_SCHEMA_VERSION));
}

/// A re-analysis of a session already queued is refused rather than queued
/// twice, so one session can never occupy two queue slots.
#[test]
fn a_session_cannot_be_queued_twice() {
    let root = scratch("no-double-queue");
    session(&root, "dup-1", 4_000);
    let analyzer = AnalysisRunner::new(root.to_path_buf(), AnalysisConfigV1::default()).unwrap();

    assert!(analyzer.request("dup-1"));
    assert!(
        !analyzer.request("dup-1"),
        "the second request is the first"
    );
    assert!(analyzer.status().rejected_requests >= 1);
    analyzer.shutdown();
}

/// A failed job is not in flight, so the session can be retried. This is what
/// makes the failed state actionable rather than terminal.
#[test]
fn a_failed_job_can_be_requested_again() {
    let root = scratch("retry-after-failure");
    // No session on disk yet: the first attempt is guaranteed to fail.
    let analyzer = AnalysisRunner::new(root.to_path_buf(), AnalysisConfigV1::default()).unwrap();
    assert!(analyzer.request("late-1"));
    let deadline = Instant::now() + Duration::from_secs(20);
    while analyzer.status().failed_sessions == 0 {
        assert!(Instant::now() < deadline, "the failure never landed");
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        analyzer.job("late-1").map(|job| job.state),
        Some(JobState::Failed)
    );

    // The session appears, and the retry is accepted and succeeds.
    session(&root, "late-1", 32);
    assert!(analyzer.request("late-1"), "a failed job must be retryable");
    let deadline = Instant::now() + Duration::from_secs(20);
    while analyzer.status().analyzed_sessions == 0 {
        assert!(Instant::now() < deadline, "the retry never completed");
        std::thread::sleep(Duration::from_millis(5));
    }
    analyzer.shutdown();
    assert_eq!(
        state(&root, "late-1", None).state,
        AnalysisAvailability::Available
    );
}

/// A failure in one session never affects another. The analyzer keeps going.
#[test]
fn one_failing_session_does_not_stop_the_others() {
    let root = scratch("failure-isolation");
    session(&root, "ok-1", 32);
    session(&root, "ok-2", 32);
    // A session directory with no frame stream at all.
    fs::create_dir_all(root.join("bad-1")).unwrap();
    let mut manifest = SessionManifestV1::new("bad-1".into(), Some(1));
    manifest.status = SessionStatus::Completed;
    session_format::write_manifest_atomically(&root.join("bad-1"), &manifest).unwrap();

    let analyzer = AnalysisRunner::new(root.to_path_buf(), AnalysisConfigV1::default()).unwrap();
    for id in ["ok-1", "bad-1", "ok-2"] {
        assert!(analyzer.request(id));
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    while analyzer.status().analyzed_sessions < 2 {
        assert!(Instant::now() < deadline, "{:?}", analyzer.status());
        std::thread::sleep(Duration::from_millis(5));
    }
    analyzer.shutdown();

    assert_eq!(analyzer.status().failed_sessions, 1);
    for id in ["ok-1", "ok-2"] {
        assert_eq!(
            state(&root, id, None).state,
            AnalysisAvailability::Available,
            "{id} was affected by an unrelated failure"
        );
    }
    // And the failing session is still a perfectly good recording.
    assert_eq!(
        session_store::get_session(&root, "bad-1").unwrap().status,
        SessionStatus::Completed
    );
}
