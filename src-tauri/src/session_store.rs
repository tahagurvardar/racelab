//! Manifest-only session catalogue. Listing and details never open, decode or
//! stream `frames.rlframes`; the frame stream stays a backend-internal format.
use crate::session_format::{self, SessionManifestV1};
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
