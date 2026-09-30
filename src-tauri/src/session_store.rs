//! Manifest-only session catalogue. Listing and details never open, decode or
//! stream `frames.rlframes`; the frame stream stays a backend-internal format.
use crate::{
    analysis::{
        self, AnalysisReadError, SessionAnalysisV1, ANALYSIS_FILE_NAME, ANALYSIS_SCHEMA_VERSION,
    },
    analysis_job::{JobRecord, JobState},
    session_format::{self, SessionManifestV1},
};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};

pub const DEFAULT_RECENT_LIMIT: usize = 20;
pub const MAX_RECENT_LIMIT: usize = 100;
/// Bounds a single listing's directory work regardless of how many sessions
/// have accumulated on disk.
pub const MAX_SCANNED_DIRECTORIES: usize = 2000;

#[derive(Debug, Clone, Serialize)]
pub struct RecentSessions {
    pub sessions: Vec<SessionManifestV1>,
    /// Sessions skipped because their manifest is missing or unreadable. One
    /// corrupt session never removes the others from the list.
    pub unreadable: u64,
    pub directory: String,
    pub limit: usize,
}

fn manifest_directories(root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        // Only a real session identifier is a session. This excludes foreign
        // folders and, specifically, the transient marker a retention deletion
        // renames a directory to: a session half-way through being deleted must
        // never appear in a listing.
        .filter(|path| {
            path.file_name()
                .map(|name| session_format::is_safe_session_id(&name.to_string_lossy()))
                .unwrap_or(false)
        })
        .take(MAX_SCANNED_DIRECTORIES)
        .collect()
}

/// Newest first by session start. Directory name breaks ties deterministically
/// so listings do not depend on filesystem enumeration order.
pub fn list_recent_sessions(root: &Path, limit: Option<usize>) -> RecentSessions {
    let limit = limit
        .unwrap_or(DEFAULT_RECENT_LIMIT)
        .clamp(1, MAX_RECENT_LIMIT);
    let mut sessions = Vec::new();
    let mut unreadable = 0;
    for directory in manifest_directories(root) {
        match session_format::read_manifest(&directory) {
            Ok(manifest) => sessions.push(manifest),
            Err(_) => unreadable += 1,
        }
    }
    sessions.sort_by(|a, b| {
        b.started_at_unix_ms
            .cmp(&a.started_at_unix_ms)
            .then_with(|| b.session_id.cmp(&a.session_id))
    });
    sessions.truncate(limit);
    RecentSessions {
        sessions,
        unreadable,
        directory: root.to_string_lossy().into_owned(),
        limit,
    }
}

pub fn get_session(root: &Path, session_id: &str) -> Result<SessionManifestV1, String> {
    if !session_format::is_safe_session_id(session_id) {
        return Err("Unknown session".into());
    }
    session_format::read_manifest(&root.join(session_id))
        .map_err(|error| format!("Could not read session {session_id}: {error}"))
}

/// Why a session's analysis is or is not being shown.
///
/// Every state is distinct because every one of them is a different statement
/// to a user, and collapsing any two of them tells a lie:
///
/// - "no analysis has run" is not "analysis ran and found nothing";
/// - "waiting behind another session" is not "being analyzed", which is why a
///   session that sat in a queue for a minute can say so;
/// - "analysis failed" is not "no analysis exists", and a failure that
///   presented itself as an absence would be a silent one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisAvailability {
    /// A readable analysis of a supported schema.
    Available,
    /// Requested and waiting for the analysis worker.
    Queued,
    /// Being analyzed right now.
    Analyzing,
    /// No analysis file and no job. Historical sessions are never analyzed on
    /// startup, so this is the normal state for a recording made before V0.9.
    NotAnalyzed,
    /// An analysis was attempted and did not produce a readable result: the job
    /// failed, the queue refused it, or the file on disk cannot be read.
    Failed,
    /// The file was written by an analysis schema this build does not support.
    /// The recording is unaffected and the analysis can be regenerated.
    UnsupportedSchema,
}

/// The analysis half of a session's details. Carries the analysis itself only
/// in the `Available` state; every other state carries an explanation instead
/// of an empty analysis.
#[derive(Debug, Clone, Serialize)]
pub struct SessionAnalysisState {
    pub session_id: String,
    pub state: AnalysisAvailability,
    pub analysis: Option<SessionAnalysisV1>,
    /// The schema version found on disk, when one could be read at all.
    pub analysis_schema_version: Option<u32>,
    pub supported_analysis_schema_version: u32,
    pub message: Option<String>,
    pub file: String,
    /// Bounded job diagnostics. Present while a job is in flight, and for a
    /// job that finished during this run of RaceLab.
    ///
    /// These are deliberately *product* numbers rather than internals: how long
    /// the session waited, how long the analysis took, and — when it failed —
    /// why. A queue wait is a normal, explicable thing, and the only way it
    /// stops looking like a hung application is to say what it is.
    pub queued_ms: Option<u64>,
    pub analysis_duration_ms: Option<u64>,
    pub failure_reason: Option<String>,
    /// True when re-running the analysis is a sensible thing to offer. Never
    /// true while a job is in flight and never true for a session with no
    /// safely readable frames.
    pub can_reanalyze: bool,
}

/// Read one session's analysis. Isolated from the manifest entirely: a failed,
/// unsupported or missing analysis is reported as its own state and can never
/// make a session unreadable, unlistable or un-openable.
///
/// `job` is this process's record of the session's analysis job, if it has one.
/// It is the only thing that can distinguish "queued" from "being analyzed"
/// from "was attempted and failed", none of which is visible on disk.
///
/// The job and the file are combined in a fixed precedence, and the order is
/// the whole point:
///
/// 1. An **in-flight** job wins over anything on disk. A session being
///    re-analyzed shows that it is being re-analyzed, rather than showing a
///    previous result as though it were current.
/// 2. Otherwise a **readable** analysis wins. A job that failed after a
///    previous analysis succeeded leaves the previous one intact and readable,
///    which is exactly what the atomic write guarantees.
/// 3. Otherwise a **failed** job explains the absence.
pub fn get_session_analysis(
    root: &Path,
    session_id: &str,
    job: Option<JobRecord>,
) -> Result<SessionAnalysisState, String> {
    if !session_format::is_safe_session_id(session_id) {
        return Err("Unknown session".into());
    }
    let directory = root.join(session_id);
    // Whether the recording itself can be analyzed at all. A session with no
    // safely readable frames is never offered a re-analysis, because there is
    // nothing for one to read.
    let analyzable = session_format::read_manifest(&directory)
        .map(|manifest| manifest.has_analyzable_coverage())
        .unwrap_or(false);
    let in_flight = job.as_ref().is_some_and(|record| record.state.in_flight());
    let state = |state: AnalysisAvailability,
                 analysis: Option<SessionAnalysisV1>,
                 version: Option<u32>,
                 message: Option<String>| SessionAnalysisState {
        session_id: session_id.to_string(),
        state,
        analysis,
        analysis_schema_version: version,
        supported_analysis_schema_version: ANALYSIS_SCHEMA_VERSION,
        message,
        file: ANALYSIS_FILE_NAME.into(),
        queued_ms: job.as_ref().map(|record| record.queued_ms),
        analysis_duration_ms: job.as_ref().and_then(|record| record.analysis_duration_ms),
        failure_reason: job
            .as_ref()
            .and_then(|record| record.failure_reason.clone()),
        can_reanalyze: analyzable && !in_flight,
    };

    // 1. An in-flight job describes the session better than any file does.
    if let Some(record) = job.as_ref().filter(|record| record.state.in_flight()) {
        return Ok(match record.state {
            JobState::Queued => state(
                AnalysisAvailability::Queued,
                None,
                None,
                Some(
                    "This session is waiting to be analyzed. Sessions are analyzed one at a time, in the order they finished."
                        .into(),
                ),
            ),
            _ => state(
                AnalysisAvailability::Analyzing,
                None,
                None,
                Some("This session is being analyzed.".into()),
            ),
        });
    }

    // 2. Then whatever is on disk.
    Ok(match analysis::read_analysis(&directory) {
        Ok(analysis) => {
            let version = analysis.schema_version;
            state(
                AnalysisAvailability::Available,
                Some(analysis),
                Some(version),
                None,
            )
        }
        Err(AnalysisReadError::Unsupported(version)) => state(
            AnalysisAvailability::UnsupportedSchema,
            None,
            Some(version),
            Some(AnalysisReadError::Unsupported(version).to_string()),
        ),
        // A file that exists but cannot be read is a failure, not an absence.
        Err(error @ (AnalysisReadError::Corrupt(_) | AnalysisReadError::Io(_))) => state(
            AnalysisAvailability::Failed,
            None,
            None,
            Some(error.to_string()),
        ),
        // 3. No file. A remembered failure explains why; otherwise nothing has
        // ever been attempted, which is its own honest state.
        Err(error @ AnalysisReadError::Absent) => match job.as_ref().map(|record| record.state) {
            Some(JobState::Failed) => state(
                AnalysisAvailability::Failed,
                None,
                None,
                Some(
                    job.as_ref()
                        .and_then(|record| record.failure_reason.clone())
                        .unwrap_or_else(|| "The analysis did not complete.".into()),
                ),
            ),
            _ => state(
                AnalysisAvailability::NotAnalyzed,
                None,
                None,
                Some(error.to_string()),
            ),
        },
    })
}
