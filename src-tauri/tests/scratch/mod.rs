//! Self-cleaning scratch directories.
//!
//! The V0.10 suites write real files, and some of them write a lot: one run of
//! `session_scale` produces about 360 MB of frame streams. A scratch directory
//! that is only removed on *creation* therefore leaves its data behind after
//! every run, and the temporary directory grows without bound until the disk
//! runs out — which is exactly the failure mode the retention work exists to
//! prevent, so it would be a poor thing for the tests proving it to cause.
//!
//! This guard removes its directory when the test finishes, with one deliberate
//! exception: **a panicking test keeps its directory**, so a failure can still
//! be investigated afterwards. That is the useful half of leaving files behind,
//! without the unbounded growth.
use std::{
    fs,
    ops::Deref,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

/// Distinguishes directories within one process, so tests running in parallel
/// under the same name never collide.
static UNIQUE: AtomicU64 = AtomicU64::new(0);

pub struct Scratch {
    path: PathBuf,
}

impl Scratch {
    /// A fresh, empty directory named after the test using it.
    pub fn new(name: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "racelab-{name}-{}-{}",
            std::process::id(),
            UNIQUE.fetch_add(1, Ordering::SeqCst)
        ));
        // Removed first as well as last: a previous run killed before its guard
        // ran must not leak state into this one.
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("could not create a scratch directory");
        Self { path }
    }
}

/// Lets a `Scratch` be used anywhere a `&Path` is wanted, including `join`.
impl Deref for Scratch {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.path
    }
}

impl AsRef<Path> for Scratch {
    fn as_ref(&self) -> &Path {
        &self.path
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        if std::thread::panicking() {
            // The test failed. Its files are evidence now.
            eprintln!(
                "scratch directory kept for inspection: {}",
                self.path.display()
            );
            return;
        }
        // Best effort: a file another thread still holds open is not worth
        // failing a passing test over, and the next run removes it.
        let _ = fs::remove_dir_all(&self.path);
    }
}
