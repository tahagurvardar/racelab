//! End-to-end synthetic UDP -> frozen Listener -> RawCaptureSink -> disk/replay.
use racelab_lib::{
    capture::RawCaptureSink,
    capture_format::{replay, CaptureReader},
    ingress::{Listener, ReceiveBuffer},
    packet::{CapturedPacket, PacketSink},
};
use std::{
    fs::{self, File},
    io::BufReader,
    net::UdpSocket,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

#[test]
fn synthetic_60_hz_udp_capture_without_loss() {
    let mut id = [0; 16];
    getrandom::fill(&mut id).unwrap();
    let directory = std::env::temp_dir().join(format!("racelab-60hz-{:x?}", id));
    let sink = Arc::new(RawCaptureSink::new(directory.clone()));
    let listener = Listener::new(ReceiveBuffer::default(), Some(sink.clone()));
    let port = listener.start(0).unwrap().bound_port.unwrap();
    let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
    sender.connect(("127.0.0.1", port)).unwrap();
    let source = sender.local_addr().unwrap();
    sink.start("synthetic-60hz-324-byte").unwrap();
    let started = Instant::now();
    let count = 600_u32;
    let mut expected = Vec::new();
    for n in 0..count {
        let deadline = started + Duration::from_secs_f64(n as f64 / 60.0);
        thread::sleep(deadline.saturating_duration_since(Instant::now()));
        let mut bytes = vec![(n % 256) as u8; 324];
        bytes[..4].copy_from_slice(&n.to_le_bytes()); // Synthetic sequence, NOT an FH6 field.
        assert_eq!(sender.send(&bytes).unwrap(), bytes.len());
        expected.push(bytes);
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while sink.snapshot().captured_packets < count as u64 {
        assert!(
            Instant::now() < deadline,
            "Timed out: {:?}",
            sink.snapshot()
        );
        thread::sleep(Duration::from_millis(5));
    }
    let summary = sink.stop().unwrap();
    let stats = listener.stop().unwrap();
    assert_eq!(stats.total_packets, count as u64);
    assert_eq!(stats.receive_errors, 0);
    assert_eq!(summary.captured_packets, count as u64);
    assert_eq!(summary.dropped_capture_frames, 0);
    assert_eq!(summary.packet_sizes.get(&324), Some(&(count as u64)));
    let path = summary.file_path.as_ref().unwrap();
    let mut reader = CaptureReader::new(BufReader::new(File::open(path).unwrap())).unwrap();
    let mut actual = Vec::new();
    let mut last_time = 0;
    while let Some(packet) = reader.next_packet().unwrap() {
        assert!(packet.capture_at_us >= last_time);
        last_time = packet.capture_at_us;
        assert_eq!(packet.source, source);
        actual.push(packet.bytes);
    }
    assert_eq!(actual, expected);
    struct Collector(Mutex<Vec<Vec<u8>>>);
    impl PacketSink for Collector {
        fn on_packet(&self, packet: &CapturedPacket<'_>) {
            self.0.lock().unwrap().push(packet.bytes.to_vec());
        }
    }
    let replayed = Collector(Mutex::new(Vec::new()));
    replay(BufReader::new(File::open(path).unwrap()), &replayed).unwrap();
    assert_eq!(*replayed.0.lock().unwrap(), expected);
    println!("60 Hz: {count}/{count} packets, 324 bytes each, 0 capture drops, 0 receive errors, exact replay; {:.3}s", started.elapsed().as_secs_f64());
    drop(reader);
    drop(listener);
    drop(sink);
    fs::remove_dir_all(directory).unwrap();
}
