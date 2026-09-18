//! Bounded, drop-newest handoff. Only the writer/lifecycle threads touch disk.
use crate::{
    capture_format::{self, CaptureEnd, CaptureHeader, RawPacket},
    packet::{CapturedPacket, PacketSink},
};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{self, BufWriter, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex, MutexGuard,
    },
    thread::{self, JoinHandle},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

pub const WRITER_QUEUE_CAPACITY: usize = 4096;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct PacketTimestamp {
    pub capture_at_us: u64,
    pub listener_at_us: u64,
    pub received_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CaptureSnapshot {
    pub revision: u64,
    /// idle, recording, stopping, complete, or error.
    pub status: String,
    pub accepting_packets: bool,
    pub label: String,
    pub directory: String,
    pub file_path: Option<String>,
    pub started_at_ms: Option<u64>,
    pub duration_us: u64,
    /// Fully written records (buffered until successful Stop Capture).
    pub captured_packets: u64,
    pub dropped_capture_frames: u64,
    pub queue_capacity: usize,
    pub packet_sizes: BTreeMap<usize, u64>,
    pub first_packet_timestamp: Option<PacketTimestamp>,
    pub last_packet_timestamp: Option<PacketTimestamp>,
    pub first_packet_hex_preview: Option<String>,
    pub last_packet_hex_preview: Option<String>,
    pub last_error: Option<String>,
}

impl CaptureSnapshot {
    fn empty(directory: &Path, capacity: usize) -> Self {
        Self {
            revision: 0,
            status: "idle".into(),
            accepting_packets: false,
            label: String::new(),
            directory: directory.to_string_lossy().into_owned(),
            file_path: None,
            started_at_ms: None,
            duration_us: 0,
            captured_packets: 0,
            dropped_capture_frames: 0,
            queue_capacity: capacity,
            packet_sizes: BTreeMap::new(),
            first_packet_timestamp: None,
            last_packet_timestamp: None,
            first_packet_hex_preview: None,
            last_packet_hex_preview: None,
            last_error: None,
        }
    }

    pub fn record(&mut self, packet: &RawPacket) {
        self.captured_packets += 1;
        *self.packet_sizes.entry(packet.bytes.len()).or_default() += 1;
        let timestamp = PacketTimestamp {
            capture_at_us: packet.capture_at_us,
            listener_at_us: packet.listener_at_us,
            received_at_ms: packet.received_at_ms,
        };
        let preview = packet
            .bytes
            .iter()
            .take(32)
            .map(|byte| format!("{byte:02X}"))
            .collect::<Vec<_>>()
            .join(" ");
        if self.first_packet_timestamp.is_none() {
            self.first_packet_timestamp = Some(timestamp.clone());
            self.first_packet_hex_preview = Some(preview.clone());
        }
        self.last_packet_timestamp = Some(timestamp);
        self.last_packet_hex_preview = Some(preview);
    }
}

struct Session {
    started: Instant,
    ended_us: AtomicU64,
    dropped: AtomicU64,
}

struct Admission {
    sender: SyncSender<RawPacket>,
    session: Arc<Session>,
}

struct View {
    snapshot: CaptureSnapshot,
    session: Option<Arc<Session>>,
}

pub struct RawCaptureSink {
    directory: PathBuf,
    capacity: usize,
    // This lock ONLY protects bounded in-memory admission and try_send. Neither
    // disk I/O, writer joins, nor the summary lock may be held under it.
    admission: Mutex<Option<Admission>>,
    // Never acquired by on_packet; serializes start/stop including disk work.
    worker: Mutex<Option<JoinHandle<()>>>,
    view: Arc<Mutex<View>>,
}

impl RawCaptureSink {
    pub fn new(directory: PathBuf) -> Self {
        Self::with_capacity(directory, WRITER_QUEUE_CAPACITY)
    }

    pub fn with_capacity(directory: PathBuf, capacity: usize) -> Self {
        Self {
            view: Arc::new(Mutex::new(View {
                snapshot: CaptureSnapshot::empty(&directory, capacity),
                session: None,
            })),
            directory,
            capacity,
            admission: Mutex::new(None),
            worker: Mutex::new(None),
        }
    }

    pub fn start(&self, label: &str) -> Result<CaptureSnapshot, String> {
        let mut worker = lock(&self.worker);
        if worker.is_some() {
            return Err("Stop the current capture before starting another".into());
        }
        let label = label.trim();
        if label.is_empty() || label.len() > capture_format::MAX_LABEL_BYTES {
            return Err("Enter a capture label of 1–256 UTF-8 bytes".into());
        }
        if self.capacity == 0 {
            return Err("Capture queue capacity must be positive".into());
        }
        // Prepare everything before admission opens. User labels never become paths.
        let prepared = (|| -> io::Result<_> {
            fs::create_dir_all(&self.directory)?;
            let started_at_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(io::Error::other)?
                .as_millis() as u64;
            let mut random = [0; 16];
            getrandom::fill(&mut random).map_err(|error| io::Error::other(error.to_string()))?;
            let id = random
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>();
            let path = self.directory.join(format!("{started_at_ms}-{id}.rlcap"));
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)?;
            let mut writer = BufWriter::new(file);
            capture_format::write_header(
                &mut writer,
                &CaptureHeader {
                    label: label.into(),
                    started_at_ms,
                },
            )?;
            writer.flush()?;
            Ok((path, writer, started_at_ms))
        })()
        .map_err(|error| format!("Could not prepare capture: {error}"))?;
        let (path, writer, started_at_ms) = prepared;
        let session = Arc::new(Session {
            started: Instant::now(),
            ended_us: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
        });
        {
            let mut view = lock(&self.view);
            let revision = view.snapshot.revision;
            view.snapshot = CaptureSnapshot {
                revision,
                status: "recording".into(),
                accepting_packets: true,
                label: label.into(),
                file_path: Some(path.to_string_lossy().into_owned()),
                started_at_ms: Some(started_at_ms),
                ..CaptureSnapshot::empty(&self.directory, self.capacity)
            };
            view.session = Some(Arc::clone(&session));
        }
        let (sender, receiver) = mpsc::sync_channel(self.capacity);
        let view = Arc::clone(&self.view);
        let writer_session = Arc::clone(&session);
        let thread = thread::Builder::new()
            .name("raw-capture-writer".into())
            .spawn(move || finish_writer(writer, receiver, writer_session, view, path))
            .map_err(|error| {
                let message = format!("Could not start capture writer: {error}");
                let mut view = lock(&self.view);
                view.snapshot.status = "error".into();
                view.snapshot.accepting_packets = false;
                view.snapshot.last_error = Some(message.clone());
                message
            })?;
        *worker = Some(thread);
        *lock(&self.admission) = Some(Admission { sender, session });
        Ok(self.snapshot())
    }

    pub fn stop(&self) -> Result<CaptureSnapshot, String> {
        let mut worker = lock(&self.worker);
        // Taking admission is the Stop boundary. An in-flight callback finishes
        // before this point; subsequent callbacks cannot enqueue into this session.
        let admission = {
            let mut gate = lock(&self.admission);
            let active = gate.take();
            if let Some(active) = &active {
                active.session.ended_us.store(
                    active.session.started.elapsed().as_micros() as u64,
                    Ordering::Release,
                );
            }
            active
        };
        if admission.is_some() {
            let mut view = lock(&self.view);
            view.snapshot.accepting_packets = false;
            if view.snapshot.status == "recording" {
                view.snapshot.status = "stopping".into();
            }
        }
        drop(admission); // disconnects channel; writer drains every accepted frame
        if let Some(thread) = worker.take() {
            if thread.join().is_err() {
                let mut view = lock(&self.view);
                view.snapshot.status = "error".into();
                view.snapshot.last_error =
                    Some("Capture writer exited unexpectedly; file is incomplete".into());
            }
        }
        let snapshot = self.snapshot();
        match &snapshot.last_error {
            Some(error) => Err(error.clone()),
            None => Ok(snapshot),
        }
    }

    pub fn snapshot(&self) -> CaptureSnapshot {
        let mut view = lock(&self.view);
        let timing = view.session.as_ref().map(|session| {
            (
                if view.snapshot.accepting_packets {
                    session.started.elapsed().as_micros() as u64
                } else {
                    session.ended_us.load(Ordering::Acquire)
                },
                session.dropped.load(Ordering::Relaxed),
            )
        });
        if let Some((duration, dropped)) = timing {
            view.snapshot.duration_us = duration;
            view.snapshot.dropped_capture_frames = dropped;
        }
        view.snapshot.revision += 1;
        view.snapshot.clone()
    }
}

impl PacketSink for RawCaptureSink {
    fn on_packet(&self, packet: &CapturedPacket<'_>) {
        let gate = lock(&self.admission);
        if let Some(active) = gate.as_ref() {
            if packet.bytes.len() > capture_format::MAX_PACKET_BYTES {
                active.session.dropped.fetch_add(1, Ordering::Relaxed);
                return;
            }
            let owned = RawPacket {
                capture_at_us: active.session.started.elapsed().as_micros() as u64,
                listener_at_us: packet.captured_at_us,
                received_at_ms: packet.received_at_ms,
                source: packet.source,
                bytes: packet.bytes.to_vec(),
            };
            // Full OR disconnected: drop newest, never wait for writer/disk.
            if active.sender.try_send(owned).is_err() {
                active.session.dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
    }
}

impl Drop for RawCaptureSink {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn write_records<W: Write>(
    writer: &mut W,
    receiver: Receiver<RawPacket>,
    session: &Session,
    view: &Mutex<View>,
) -> io::Result<()> {
    while let Ok(packet) = receiver.recv() {
        if let Err(error) = capture_format::write_packet(writer, &packet) {
            // Keep consuming/counting rejected frames until Stop closes admission;
            // dropping a still-connected receiver could lose an uncounted queue tail.
            session.dropped.fetch_add(1, Ordering::Relaxed);
            {
                let mut view = lock(view);
                view.snapshot.status = "error".into();
                view.snapshot.last_error = Some(format!(
                    "Capture write failed; stop and record again: {error}"
                ));
            }
            for _ in receiver {
                session.dropped.fetch_add(1, Ordering::Relaxed);
            }
            return Err(error);
        }
        // Formatting and summary work belong to this worker; release the lock
        // before the next write so UI queries never wait on disk either.
        lock(view).snapshot.record(&packet);
    }
    Ok(())
}

fn finish_writer(
    mut writer: BufWriter<File>,
    receiver: Receiver<RawPacket>,
    session: Arc<Session>,
    view: Arc<Mutex<View>>,
    path: PathBuf,
) {
    let result = (|| -> io::Result<()> {
        write_records(&mut writer, receiver, &session, &view)?;
        let mut summary = lock(&view).snapshot.clone();
        summary.duration_us = session.ended_us.load(Ordering::Acquire);
        summary.dropped_capture_frames = session.dropped.load(Ordering::Relaxed);
        capture_format::write_end(
            &mut writer,
            &CaptureEnd {
                duration_us: summary.duration_us,
                dropped_capture_frames: summary.dropped_capture_frames,
                captured_packets: summary.captured_packets,
            },
        )?;
        writer.flush()?;
        writer.get_ref().sync_all()?;
        summary.status = "complete".into();
        let mut sidecar = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(path.with_extension("summary.json"))?;
        serde_json::to_writer_pretty(&mut sidecar, &summary)?;
        sidecar.write_all(b"\n")?;
        sidecar.sync_all()?;
        Ok(())
    })();
    let mut state = lock(&view);
    match result {
        Ok(()) => state.snapshot.status = "complete".into(),
        Err(error) => {
            state.snapshot.status = "error".into();
            state.snapshot.last_error = Some(format!(
                "Capture storage failed; file may be incomplete: {error}"
            ));
        }
    }
}

#[cfg(test)]
mod tests;
