//! Bounded production logging.
//!
//! RaceLab is a desktop product a user installs and runs without a terminal.
//! When something goes wrong after the fact — a session that did not record, an
//! analysis that never appeared, a launch that failed — there has to be
//! something to read. Before V1.0 the only channel was `eprintln!`, which in a
//! packaged build with no console goes nowhere at all.
//!
//! Four properties are structural rather than best-effort:
//!
//! 1. **Bounded on disk.** One active file and one previous file, each capped
//!    at [`MAX_LOG_BYTES`]. Total log footprint can therefore never exceed
//!    twice that, whatever happens. Rotation is checked on every write against
//!    a byte counter this module maintains, so growth cannot outrun it.
//! 2. **Never on the telemetry path.** Nothing in ingestion, the hub, the
//!    recorder's writer thread or the analysis worker's inner loop logs a
//!    frame. This module exists for lifecycle and failure events, which occur
//!    at most a handful of times per session. Logging a per-frame event would
//!    both defeat the size bound and put a file write behind a mutex on a path
//!    that must never block, so the API deliberately offers no way to do it.
//! 3. **No telemetry contents, ever.** No packet bytes, no frame values, no
//!    capture dumps. A log line names *what failed*, not what was being driven.
//!    Session identifiers and file paths are recorded because a support reader
//!    needs them to find the session; nothing describing the driving is.
//! 4. **A logging failure is never a product failure.** Every disk operation
//!    here discards its error. If the log file cannot be opened or written —
//!    a full disk, a read-only directory — RaceLab continues exactly as it
//!    would have. The one thing this module must never do is become a new way
//!    for the application to fail.
use std::{
    fmt,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

/// Rotation threshold for the active file. Roughly a few thousand lifecycle
/// lines, which is far more than one play session produces and still small
/// enough that a user can open it.
pub const MAX_LOG_BYTES: u64 = 1024 * 1024;

pub const LOG_FILE_NAME: &str = "racelab.log";
pub const PREVIOUS_LOG_FILE_NAME: &str = "racelab.previous.log";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Info,
    Warn,
    Error,
}

impl fmt::Display for Level {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Info => "INFO",
            Self::Warn => "WARN",
            Self::Error => "ERROR",
        })
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or_default()
}

struct Sink {
    directory: PathBuf,
    file: Option<File>,
    /// Bytes in the active file. Maintained here rather than stat-ed per write
    /// so the size bound costs nothing.
    written: u64,
}

impl Sink {
    fn open(directory: PathBuf) -> Self {
        let mut sink = Self {
            directory,
            file: None,
            written: 0,
        };
        sink.reopen();
        sink
    }

    /// Opens the active file, appending to it if it already exists. A failure
    /// leaves `file` as `None`, which makes every later write a no-op rather
    /// than an error anyone has to handle.
    fn reopen(&mut self) {
        if fs::create_dir_all(&self.directory).is_err() {
            self.file = None;
            return;
        }
        let path = self.directory.join(LOG_FILE_NAME);
        self.written = fs::metadata(&path).map(|data| data.len()).unwrap_or(0);
        self.file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok();
    }

    /// Replaces the previous file with the active one and starts a new active
    /// file. A rotation that fails is not retried in a loop: the next write
    /// simply finds the same oversized file and tries again, which cannot make
    /// anything worse.
    fn rotate(&mut self) {
        self.file = None;
        let active = self.directory.join(LOG_FILE_NAME);
        let previous = self.directory.join(PREVIOUS_LOG_FILE_NAME);
        let _ = fs::remove_file(&previous);
        let _ = fs::rename(&active, &previous);
        self.reopen();
    }

    fn write(&mut self, line: &str) {
        if self.written >= MAX_LOG_BYTES {
            self.rotate();
        }
        let Some(file) = self.file.as_mut() else {
            return;
        };
        // A failed write is discarded deliberately: see the module header.
        if file.write_all(line.as_bytes()).is_ok() {
            self.written = self.written.saturating_add(line.len() as u64);
        }
    }
}

/// Process-wide log. `OnceLock` rather than a lazily created file so that a
/// build which never calls `start` — every test binary, and any future headless
/// tool — writes nothing at all and touches no directory.
static SINK: OnceLock<Mutex<Sink>> = OnceLock::new();

/// Begin logging into `directory`. Called once, from application setup, with
/// the resolved application data directory. Calling it a second time is
/// ignored, so a test cannot redirect a running application's log.
pub fn start(directory: PathBuf) {
    let _ = SINK.set(Mutex::new(Sink::open(directory)));
}

/// One line. Silently does nothing before `start`, which is what keeps this
/// callable from library code used by tests and examples.
pub fn log(level: Level, message: impl AsRef<str>) {
    let Some(sink) = SINK.get() else {
        return;
    };
    lock(sink).write(&format_line(unix_ms(), level, message.as_ref()));
}

pub fn info(message: impl AsRef<str>) {
    log(Level::Info, message);
}

pub fn warn(message: impl AsRef<str>) {
    log(Level::Warn, message);
}

pub fn error(message: impl AsRef<str>) {
    log(Level::Error, message);
}

/// The exact on-disk line format, factored out so a test can assert it without
/// a global sink: `<unix-ms> LEVEL message`, one line, newline-terminated.
/// Embedded newlines are replaced so one logged error can never forge a second
/// log record.
pub fn format_line(unix_ms: u64, level: Level, message: &str) -> String {
    let message: String = message
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    format!("{unix_ms} {level} {message}\n")
}

/// Where the logs live, for a support reader and for the Diagnostics view.
pub fn directory() -> Option<PathBuf> {
    SINK.get().map(|sink| lock(sink).directory.clone())
}

/// The active log file, but only when it is genuinely being written.
///
/// `directory` reports where logging *intends* to write, which is still useful
/// for diagnostics. This reports where a reader will actually find something,
/// and returns `None` when the file could not be opened at all. The startup
/// error dialog uses this rather than `directory`, because telling a user to
/// read a file that was never created would be worse than saying nothing.
pub fn active_log_path() -> Option<PathBuf> {
    let sink = SINK.get()?;
    let sink = lock(sink);
    sink.file
        .as_ref()
        .map(|_| sink.directory.join(LOG_FILE_NAME))
}

/// Route Rust panics into the log before the process dies.
///
/// A panic in a background thread is otherwise completely invisible in a
/// packaged build: the thread disappears, the window stays open, and whatever
/// that thread was responsible for silently stops happening. This does not
/// catch or suppress anything — the default behaviour still runs — it only
/// makes the panic readable afterwards.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("unnamed").to_string();
        let location = info
            .location()
            .map(|location| format!("{}:{}", location.file(), location.line()))
            .unwrap_or_else(|| "unknown location".into());
        error(format!(
            "Panic in thread '{name}' at {location}: {}",
            panic_message(info)
        ));
        previous(info);
    }));
}

fn panic_message(info: &std::panic::PanicHookInfo<'_>) -> String {
    let payload = info.payload();
    if let Some(message) = payload.downcast_ref::<&str>() {
        (*message).to_string()
    } else if let Some(message) = payload.downcast_ref::<String>() {
        message.clone()
    } else {
        "non-string panic payload".into()
    }
}

/// A directory's log sizes, for the size-bound test and for reporting.
pub fn log_bytes(directory: &Path) -> (u64, u64) {
    let size = |name: &str| {
        fs::metadata(directory.join(name))
            .map(|data| data.len())
            .unwrap_or(0)
    };
    (size(LOG_FILE_NAME), size(PREVIOUS_LOG_FILE_NAME))
}

/// A sink bound to one directory, for tests. The production path uses the
/// process-wide sink installed by [`start`]; this exists so a test can exercise
/// rotation and the size bound without a global.
pub struct LocalLog(Mutex<Sink>);

impl LocalLog {
    pub fn open(directory: PathBuf) -> Self {
        Self(Mutex::new(Sink::open(directory)))
    }

    pub fn write(&self, level: Level, message: &str) {
        lock(&self.0).write(&format_line(unix_ms(), level, message));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_carries_its_timestamp_level_and_message() {
        assert_eq!(
            format_line(1_700_000_000_000, Level::Warn, "listener stopped"),
            "1700000000000 WARN listener stopped\n"
        );
    }

    #[test]
    fn a_multi_line_message_cannot_forge_a_second_record() {
        let line = format_line(1, Level::Error, "first\nsecond\r\nthird");
        assert_eq!(line.matches('\n').count(), 1);
        assert!(line.ends_with("first second  third\n"));
    }

    #[test]
    fn logging_without_start_writes_nothing_and_does_not_panic() {
        // `SINK` is never set in unit tests, so these are all no-ops. The point
        // of the assertion is that library code may log unconditionally.
        info("ignored");
        warn("ignored");
        error("ignored");
        assert!(directory().is_none());
    }
}
