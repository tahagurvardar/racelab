//! Manifest-only session catalogue. Listing and details never open, decode or
//! stream `frames.rlframes`; the frame stream stays a backend-internal format.
use crate::{
    analysis::{
        self, AnalysisReadError, SessionAnalysisV1, ANALYSIS_FILE_NAME, ANALYSIS_SCHEMA_VERSION,
    },
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

/// Why a session's analysis is or is not being shown. Every non-available
/// state is distinct, because "no analysis has run" and "analysis ran and
/// found nothing" are different statements and the UI must never conflate them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AnalysisAvailability {
    /// A readable analysis of a supported schema.
    Available,
    /// Queued or running right now.
    Pending,
    /// No analysis file. Historical sessions are never analyzed on startup, so
    /// this is the normal state for a recording made before V0.9.
    Absent,
    /// The file exists but could not be parsed.
    Corrupt,
    /// The file was written by an analysis schema this build does not support.
    Unsupported,
    /// The file exists but could not be opened.
    Error,
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
}

/// Read one session's analysis. Isolated from the manifest entirely: a corrupt,
/// unsupported or missing analysis is reported as its own state and can never
/// make a session unreadable, unlistable or un-openable.
pub fn get_session_analysis(
    root: &Path,
    session_id: &str,
    pending: bool,
) -> Result<SessionAnalysisState, String> {
    if !session_format::is_safe_session_id(session_id) {
        return Err("Unknown session".into());
    }
    let directory = root.join(session_id);
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
    };
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
        // An analysis that has been requested but has not finished yet is
        // pending, not absent. Reporting it as absent would invite the reader
        // to conclude the session held nothing worth reporting.
        Err(AnalysisReadError::Absent) if pending => state(
            AnalysisAvailability::Pending,
            None,
            None,
            Some("This session is being analyzed.".into()),
        ),
        Err(error @ AnalysisReadError::Absent) => state(
            AnalysisAvailability::Absent,
            None,
            None,
            Some(error.to_string()),
        ),
        Err(error @ AnalysisReadError::Corrupt(_)) => state(
            AnalysisAvailability::Corrupt,
            None,
            None,
            Some(error.to_string()),
        ),
        Err(AnalysisReadError::Unsupported(version)) => state(
            AnalysisAvailability::Unsupported,
            None,
            Some(version),
            Some(AnalysisReadError::Unsupported(version).to_string()),
        ),
        Err(error @ AnalysisReadError::Io(_)) => state(
            AnalysisAvailability::Error,
            None,
            None,
            Some(error.to_string()),
        ),
    })
}
