use super::*;
use crate::capture_format::{replay, CaptureReader};
use std::{
    io::{BufReader, Cursor},
    sync::mpsc,
    time::Duration,
};

struct TempDir(PathBuf);
impl TempDir {
    fn new() -> Self {
        let mut id = [0; 16];
        getrandom::fill(&mut id).unwrap();
        let path = std::env::temp_dir().join(format!("racelab-capture-test-{:x?}", id));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn sink(&self) -> RawCaptureSink {
        RawCaptureSink::new(self.0.clone())
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn send(sink: &dyn PacketSink, bytes: &[u8], time: u64) {
    sink.on_packet(&CapturedPacket {
        bytes,
        source: "127.0.0.1:5200".parse().unwrap(),
        received_at_ms: 1_800_000_000_000 + time / 1000,
        captured_at_us: time,
    });
}

fn packets(summary: &CaptureSnapshot) -> Vec<RawPacket> {
    let mut reader = CaptureReader::new(BufReader::new(
        File::open(summary.file_path.as_ref().unwrap()).unwrap(),
    ))
    .unwrap();
    assert_eq!(reader.header.label, summary.label);
    let mut packets = Vec::new();
    while let Some(packet) = reader.next_packet().unwrap() {
        packets.push(packet);
    }
    let end = reader.end.unwrap();
    assert_eq!(end.captured_packets, summary.captured_packets);
    assert_eq!(end.dropped_capture_frames, summary.dropped_capture_frames);
    assert_eq!(end.duration_us, summary.duration_us);
    packets
}

#[test]
fn exact_raw_byte_round_trip_and_summary() {
    let directory = TempDir::new();
    let sink = directory.sink();
    sink.start("FH6 / raw bytes Ω").unwrap();
    let payloads = [
        vec![],
        (0..=255).collect(),
        vec![0, 255, 0, 128, 13, 10],
        vec![0xAB; 65_535],
    ];
    for (i, bytes) in payloads.iter().enumerate() {
        send(&sink, bytes, i as u64 * 16_667);
    }
    let summary = sink.stop().unwrap();
    let recorded = packets(&summary);
    for (i, (packet, expected)) in recorded.iter().zip(&payloads).enumerate() {
        assert_eq!(&packet.bytes, expected);
        assert_eq!(packet.source, "127.0.0.1:5200".parse().unwrap());
        assert_eq!(packet.listener_at_us, i as u64 * 16_667);
        assert_eq!(
            packet.received_at_ms,
            1_800_000_000_000 + i as u64 * 16_667 / 1000
        );
    }
    assert_eq!(recorded.len(), 4);
    assert_eq!(summary.status, "complete");
    assert_eq!(
        summary.packet_sizes,
        BTreeMap::from([(0, 1), (6, 1), (256, 1), (65_535, 1)])
    );
    assert_eq!(summary.first_packet_hex_preview.as_deref(), Some(""));
    assert_eq!(
        summary.last_packet_hex_preview.unwrap().split(' ').count(),
        32
    );
    let sidecar: serde_json::Value = serde_json::from_reader(
        File::open(Path::new(summary.file_path.as_ref().unwrap()).with_extension("summary.json"))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(sidecar["captured_packets"], 4);
    assert_eq!(sidecar["status"], "complete");
}

#[test]
fn timestamp_ordering_uses_capture_clock_across_listener_restart_and_wall_clock_regression() {
    let directory = TempDir::new();
    let sink = directory.sink();
    sink.start("clocks").unwrap();
    send(&sink, &[1], 500_000);
    thread::sleep(Duration::from_millis(2));
    send(&sink, &[2], 0);
    let summary = sink.stop().unwrap();
    let recorded = packets(&summary);
    assert!(recorded[0].capture_at_us < recorded[1].capture_at_us);
    assert!(recorded[0].listener_at_us > recorded[1].listener_at_us);
    assert!(recorded[0].received_at_ms > recorded[1].received_at_ms);
    assert!(summary.duration_us >= recorded[1].capture_at_us);
}

#[test]
fn capture_start_stop_restart_and_empty_capture() {
    let directory = TempDir::new();
    let sink = directory.sink();
    assert_eq!(sink.stop().unwrap().status, "idle");
    assert!(sink.start("   ").is_err());
    let first = sink.start("one").unwrap();
    assert!(sink.start("duplicate").is_err());
    assert_eq!(sink.stop().unwrap().captured_packets, 0);
    assert_eq!(sink.stop().unwrap().status, "complete");
    let second = sink.start("two").unwrap();
    assert_ne!(first.file_path, second.file_path);
    send(&sink, &[2], 0);
    assert_eq!(packets(&sink.stop().unwrap()).len(), 1);
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 4);
}

#[test]
fn packets_before_start_are_not_recorded() {
    let directory = TempDir::new();
    let sink = directory.sink();
    send(&sink, b"before", 0);
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 0);
    sink.start("boundary").unwrap();
    send(&sink, b"inside", 1);
    let recorded = packets(&sink.stop().unwrap());
    assert_eq!(recorded.len(), 1);
    assert_eq!(recorded[0].bytes, b"inside");
}

#[test]
fn packets_after_stop_are_not_recorded() {
    let directory = TempDir::new();
    let sink = directory.sink();
    sink.start("boundary").unwrap();
    send(&sink, b"inside", 0);
    let summary = sink.stop().unwrap();
    let before = fs::read(summary.file_path.as_ref().unwrap()).unwrap();
    send(&sink, b"after", 1);
    assert_eq!(before, fs::read(summary.file_path.unwrap()).unwrap());
    assert_eq!(sink.snapshot().captured_packets, 1);
}

struct BlockedWriter {
    entered: mpsc::Sender<()>,
    release: Receiver<()>,
    bytes: Vec<u8>,
    blocked: bool,
}
impl Write for BlockedWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if !self.blocked {
            self.blocked = true;
            self.entered.send(()).unwrap();
            self.release.recv_timeout(Duration::from_secs(5)).unwrap();
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn bounded_queue_overflow_never_waits_for_blocked_disk_and_accounts_every_drop() {
    let directory = TempDir::new();
    let sink = Arc::new(RawCaptureSink::with_capacity(directory.0.clone(), 2));
    let session = Arc::new(Session {
        started: Instant::now(),
        ended_us: AtomicU64::new(0),
        dropped: AtomicU64::new(0),
    });
    let (sender, receiver) = mpsc::sync_channel(2);
    *lock(&sink.admission) = Some(Admission {
        sender,
        session: session.clone(),
    });
    lock(&sink.view).session = Some(session.clone());
    let (entered, ready) = mpsc::channel();
    let (release, blocked) = mpsc::channel();
    let view = sink.view.clone();
    let writer_session = session.clone();
    let writer = thread::spawn(move || {
        let mut writer = BlockedWriter {
            entered,
            release: blocked,
            bytes: Vec::new(),
            blocked: false,
        };
        write_records(&mut writer, receiver, &writer_session, &view).unwrap();
    });
    send(sink.as_ref(), &[0], 0);
    ready.recv_timeout(Duration::from_secs(3)).unwrap();
    let producer_sink = sink.clone();
    let (finished, completion) = mpsc::channel();
    let producer = thread::spawn(move || {
        for n in 1..=12 {
            send(producer_sink.as_ref(), &[n], n as u64);
        }
        finished.send(()).unwrap();
    });
    let prompt = completion.recv_timeout(Duration::from_secs(2));
    // Release the writer even if the assertion would fail, avoiding a hung test.
    release.send(()).unwrap();
    assert!(prompt.is_ok(), "Ingress waited on blocked writer");
    producer.join().unwrap();
    assert_eq!(sink.snapshot().dropped_capture_frames, 10);
    drop(lock(&sink.admission).take());
    writer.join().unwrap();
    assert_eq!(sink.snapshot().captured_packets, 3);
}

#[test]
fn stop_drains_admitted_frames_and_persists_queue_overflow_in_footer_and_summary() {
    let directory = TempDir::new();
    let sink = RawCaptureSink::with_capacity(directory.0.clone(), 2);
    let path = directory.0.join("overflow.rlcap");
    let mut writer = BufWriter::new(File::create(&path).unwrap());
    capture_format::write_header(
        &mut writer,
        &CaptureHeader {
            label: "overflow".into(),
            started_at_ms: 0,
        },
    )
    .unwrap();
    let session = Arc::new(Session {
        started: Instant::now(),
        ended_us: AtomicU64::new(0),
        dropped: AtomicU64::new(0),
    });
    let (sender, receiver) = mpsc::sync_channel(2);
    *lock(&sink.admission) = Some(Admission {
        sender,
        session: session.clone(),
    });
    {
        let mut view = lock(&sink.view);
        view.session = Some(session.clone());
        view.snapshot.label = "overflow".into();
        view.snapshot.status = "recording".into();
        view.snapshot.accepting_packets = true;
        view.snapshot.file_path = Some(path.to_string_lossy().into_owned());
    }
    // Deterministically fill the queue before scheduling the real file writer.
    for n in 0..7 {
        send(&sink, &[n], n as u64);
    }
    let view = sink.view.clone();
    *lock(&sink.worker) = Some(thread::spawn(move || {
        finish_writer(writer, receiver, session, view, path)
    }));
    let summary = sink.stop().unwrap();
    assert_eq!(summary.captured_packets, 2);
    assert_eq!(summary.dropped_capture_frames, 5);
    assert!(!summary.accepting_packets);
    let recorded = packets(&summary);
    assert_eq!(
        recorded.iter().map(|p| p.bytes.clone()).collect::<Vec<_>>(),
        vec![vec![0], vec![1]]
    );
    let sidecar: serde_json::Value = serde_json::from_reader(
        File::open(Path::new(summary.file_path.as_ref().unwrap()).with_extension("summary.json"))
            .unwrap(),
    )
    .unwrap();
    assert_eq!(sidecar["dropped_capture_frames"], 5);
    sink.start("next").unwrap();
    assert_eq!(sink.stop().unwrap().dropped_capture_frames, 0);
}

#[test]
fn replay_produces_exact_packet_bytes_and_metadata_in_order() {
    type ReplayedPacket = (Vec<u8>, std::net::SocketAddr, u64, u64);
    struct Collector(Mutex<Vec<ReplayedPacket>>);
    impl PacketSink for Collector {
        fn on_packet(&self, p: &CapturedPacket<'_>) {
            lock(&self.0).push((
                p.bytes.to_vec(),
                p.source,
                p.received_at_ms,
                p.captured_at_us,
            ));
        }
    }
    let directory = TempDir::new();
    let sink = directory.sink();
    sink.start("replay").unwrap();
    for n in 0..100 {
        send(&sink, &[n, 0, 255, n], n as u64 * 16_667);
    }
    let summary = sink.stop().unwrap();
    let expected = packets(&summary);
    let collector = Collector(Mutex::new(Vec::new()));
    let end = replay(
        BufReader::new(File::open(summary.file_path.unwrap()).unwrap()),
        &collector,
    )
    .unwrap();
    assert_eq!(end.captured_packets, 100);
    let actual = lock(&collector.0);
    assert_eq!(actual.len(), expected.len());
    for (actual, expected) in actual.iter().zip(expected) {
        assert_eq!(
            actual,
            &(
                expected.bytes,
                expected.source,
                expected.received_at_ms,
                expected.capture_at_us
            )
        );
    }
}

#[test]
fn format_preserves_ipv6_and_rejects_truncation_bad_lengths_ordering_and_footer() {
    let mut bytes = Vec::new();
    capture_format::write_header(
        &mut bytes,
        &CaptureHeader {
            label: "v6".into(),
            started_at_ms: 123,
        },
    )
    .unwrap();
    let record_offset = bytes.len();
    let packet = RawPacket {
        capture_at_us: 8,
        listener_at_us: 99,
        received_at_ms: 123,
        source: std::net::SocketAddrV6::new("fe80::1".parse().unwrap(), 5200, 17, 3).into(),
        bytes: vec![0, 255],
    };
    capture_format::write_packet(&mut bytes, &packet).unwrap();
    capture_format::write_end(
        &mut bytes,
        &CaptureEnd {
            duration_us: 9,
            dropped_capture_frames: 2,
            captured_packets: 1,
        },
    )
    .unwrap();
    let mut reader = CaptureReader::new(Cursor::new(&bytes)).unwrap();
    assert_eq!(reader.next_packet().unwrap(), Some(packet.clone()));
    assert!(reader.next_packet().unwrap().is_none());
    fn valid(bytes: &[u8]) -> bool {
        let Ok(mut reader) = CaptureReader::new(Cursor::new(bytes)) else {
            return false;
        };
        loop {
            match reader.next_packet() {
                Ok(Some(_)) => {}
                Ok(None) => return true,
                Err(_) => return false,
            }
        }
    }
    for len in 0..bytes.len() {
        assert!(!valid(&bytes[..len]), "Accepted truncated length {len}");
    }
    let mut corrupt = bytes.clone();
    corrupt[8] = 2;
    assert!(!valid(&corrupt));
    corrupt = bytes.clone();
    corrupt[record_offset + 52..record_offset + 56].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(!valid(&corrupt));
    corrupt = bytes.clone();
    corrupt.push(0);
    assert!(!valid(&corrupt));
    corrupt = bytes[..bytes.len() - 25].to_vec();
    capture_format::write_packet(
        &mut corrupt,
        &RawPacket {
            capture_at_us: 7,
            ..packet
        },
    )
    .unwrap();
    assert!(!valid(&corrupt));
    corrupt = bytes;
    let last = corrupt.len() - 8;
    corrupt[last..].copy_from_slice(&2_u64.to_le_bytes());
    assert!(!valid(&corrupt));
}

#[test]
fn storage_setup_failure_is_reported_without_opening_admission() {
    let directory = TempDir::new();
    let path = directory.0.join("file");
    fs::write(&path, b"not a directory").unwrap();
    let sink = RawCaptureSink::new(path);
    assert!(sink
        .start("failure")
        .unwrap_err()
        .contains("Could not prepare capture"));
    send(&sink, b"not admitted", 0);
    assert_eq!(sink.snapshot().captured_packets, 0);
}

#[test]
fn writer_failure_surfaces_and_counts_unwritten_frames() {
    struct Fail;
    impl Write for Fail {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::other("injected disk full"))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let directory = TempDir::new();
    let sink = directory.sink();
    let session = Session {
        started: Instant::now(),
        ended_us: AtomicU64::new(0),
        dropped: AtomicU64::new(0),
    };
    let (sender, receiver) = mpsc::sync_channel(3);
    for _ in 0..3 {
        sender
            .try_send(RawPacket {
                capture_at_us: 0,
                listener_at_us: 0,
                received_at_ms: 0,
                source: "127.0.0.1:1".parse().unwrap(),
                bytes: vec![1],
            })
            .unwrap();
    }
    drop(sender);
    assert!(write_records(&mut Fail, receiver, &session, &sink.view).is_err());
    assert_eq!(session.dropped.load(Ordering::Relaxed), 3);
    assert_eq!(sink.snapshot().captured_packets, 0);
    assert!(sink
        .snapshot()
        .last_error
        .unwrap()
        .contains("injected disk full"));
}
