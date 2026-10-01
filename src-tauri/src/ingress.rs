//! Game-agnostic UDP transport. No Tauri, React, or game schema dependencies.
use crate::packet::{CapturedPacket, PacketSink};
use serde::Serialize;
use socket2::SockRef;
use std::{
    io::ErrorKind,
    net::{SocketAddr, UdpSocket},
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// The address the telemetry socket binds.
///
/// Loopback, not `0.0.0.0`, and this is a security decision rather than a
/// stylistic one. A wildcard bind accepts datagrams from every network
/// interface, which has two consequences an installed product should not have:
/// Windows Defender Firewall prompts the user on first launch, and any machine
/// on the same network can push traffic into the telemetry pipeline. Loopback
/// traffic is exempt from the Windows firewall, so binding here means RaceLab
/// needs no firewall exception, no administrator rights and no prompt.
///
/// The cost is stated plainly: RaceLab receives telemetry only from a game
/// running on the same PC. Telemetry sent from a console or a second machine
/// is no longer received. That matches the product RaceLab is — FH6 Data Out
/// pointed at `127.0.0.1:20440` on the same Windows PC.
pub const LISTEN_ADDRESS: &str = "127.0.0.1";

const MAX_DATAGRAM_BYTES: usize = 65_535;
const PREVIEW_BYTES: usize = 32;
const RECEIVE_BUFFER_BYTES: usize = 4 * 1024 * 1024;
const WAKE_NONCE_BYTES: usize = 32;

#[derive(Debug, Clone, Copy)]
pub enum ReceiveBuffer {
    /// Leave SO_RCVBUF untouched, for comparison with platform defaults.
    SystemDefault,
    /// A requested socket option, not a guarantee of kernel queue capacity.
    Requested(usize),
}

impl Default for ReceiveBuffer {
    fn default() -> Self {
        Self::Requested(RECEIVE_BUFFER_BYTES)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct StatsSnapshot {
    pub revision: u64,
    pub session_id: u64,
    pub running: bool,
    pub bound_port: Option<u16>,
    pub receive_buffer_bytes: Option<usize>,
    pub total_packets: u64,
    pub packets_per_second: f64,
    pub total_bytes: u64,
    pub last_packet_size: Option<usize>,
    pub last_source: Option<String>,
    pub last_packet_timestamp_ms: Option<u64>,
    pub last_packet_monotonic_us: Option<u64>,
    pub preview_hex: String,
    pub receive_errors: u64,
    pub last_error: Option<String>,
}

struct Statistics {
    revision: u64,
    session_id: u64,
    running: bool,
    bound_port: Option<u16>,
    receive_buffer_bytes: Option<usize>,
    total_packets: u64,
    total_bytes: u64,
    latest_raw_packet: Vec<u8>,
    last_source: Option<SocketAddr>,
    last_packet_timestamp_ms: Option<u64>,
    last_packet_monotonic_us: Option<u64>,
    receive_errors: u64,
    last_error: Option<String>,
    rate_since: Instant,
    rate_packets: u64,
    packets_per_second: f64,
}

impl Default for Statistics {
    fn default() -> Self {
        Self {
            revision: 0,
            session_id: 0,
            running: false,
            bound_port: None,
            receive_buffer_bytes: None,
            total_packets: 0,
            total_bytes: 0,
            latest_raw_packet: Vec::with_capacity(MAX_DATAGRAM_BYTES),
            last_source: None,
            last_packet_timestamp_ms: None,
            last_packet_monotonic_us: None,
            receive_errors: 0,
            last_error: None,
            rate_since: Instant::now(),
            rate_packets: 0,
            packets_per_second: 0.0,
        }
    }
}

impl Statistics {
    // One-second sampling windows measured with a monotonic clock. Both the
    // receiver and snapshot publisher advance this, including during silence.
    fn refresh_rate(&mut self, now: Instant) {
        let elapsed = now.duration_since(self.rate_since);
        if elapsed >= Duration::from_secs(1) {
            self.packets_per_second = self.rate_packets as f64 / elapsed.as_secs_f64();
            self.rate_packets = 0;
            self.rate_since = now;
        }
    }

    fn record(&mut self, packet: &CapturedPacket<'_>, now: Instant) {
        self.refresh_rate(now);
        self.total_packets += 1;
        self.total_bytes += packet.bytes.len() as u64;
        self.rate_packets += 1;
        self.latest_raw_packet.clear();
        self.latest_raw_packet.extend_from_slice(packet.bytes);
        self.last_source = Some(packet.source);
        self.last_packet_timestamp_ms = Some(packet.received_at_ms);
        self.last_packet_monotonic_us = Some(packet.captured_at_us);
    }

    fn receive_failed(&mut self, error: impl std::fmt::Display) {
        self.receive_errors += 1;
        self.last_error = Some(format!("UDP receive error: {error}"));
        self.stopped();
    }

    fn stopped(&mut self) {
        self.running = false;
        self.bound_port = None;
        self.receive_buffer_bytes = None;
        self.packets_per_second = 0.0;
        self.rate_packets = 0;
    }
}

// Only short in-memory operations use this lock; no I/O or callbacks occur here.
// Recover poison to avoid a secondary panic when reporting worker failures.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

struct Worker {
    stop: Arc<AtomicBool>,
    wake_socket: UdpSocket,
    wake_nonce: [u8; WAKE_NONCE_BYTES],
    thread: JoinHandle<()>,
}

pub struct Listener {
    statistics: Arc<Mutex<Statistics>>,
    // Held across bind/join to serialize overlapping start/stop requests.
    worker: Mutex<Option<Worker>>,
    receive_buffer: ReceiveBuffer,
    sink: Option<Arc<dyn PacketSink>>,
}

impl Default for Listener {
    fn default() -> Self {
        Self::new(ReceiveBuffer::default(), None)
    }
}

impl Listener {
    pub fn new(receive_buffer: ReceiveBuffer, sink: Option<Arc<dyn PacketSink>>) -> Self {
        Self {
            statistics: Arc::default(),
            worker: Mutex::new(None),
            receive_buffer,
            sink,
        }
    }

    pub fn start(&self, port: u16) -> Result<StatsSnapshot, String> {
        let mut worker = lock(&self.worker);
        {
            let stats = lock(&self.statistics);
            if stats.running {
                if stats.bound_port == Some(port) || port == 0 {
                    drop(stats);
                    return Ok(self.snapshot());
                }
                return Err("Stop the listener before changing its UDP port".into());
            }
        }
        self.join_worker(&mut worker)?;
        let socket = (|| {
            let socket = UdpSocket::bind((LISTEN_ADDRESS, port))?;
            // Absorb scheduler stalls/bursts instead of relying on small OS defaults.
            if let ReceiveBuffer::Requested(bytes) = self.receive_buffer {
                if bytes == 0 || bytes > i32::MAX as usize {
                    return Err(std::io::Error::new(
                        ErrorKind::InvalidInput,
                        "Receive buffer request must be 1..=i32::MAX bytes",
                    ));
                }
                SockRef::from(&socket).set_recv_buffer_size(bytes)?;
            }
            // Fresh sockets block indefinitely by default. Never set SO_RCVTIMEO.
            Ok::<_, std::io::Error>(socket)
        })()
        .map_err(|error| {
            self.lifecycle_error(format!("Could not open UDP port {port}: {error}"))
        })?;
        let bound_port = socket
            .local_addr()
            .map_err(|error| self.lifecycle_error(format!("Could not read UDP address: {error}")))?
            .port();
        let receive_buffer_bytes = SockRef::from(&socket).recv_buffer_size().map_err(|error| {
            self.lifecycle_error(format!("Could not read UDP receive buffer size: {error}"))
        })?;
        let mut wake_nonce = [0; WAKE_NONCE_BYTES];
        getrandom::fill(&mut wake_nonce).map_err(|error| {
            self.lifecycle_error(format!("Could not generate UDP wake nonce: {error}"))
        })?;
        let (wake_socket, wake_source) = (|| {
            // Reserve a private source endpoint for the entire session. Match both
            // this endpoint and the random nonce before classifying control traffic.
            let wake = UdpSocket::bind(("127.0.0.1", 0))?;
            wake.connect(("127.0.0.1", bound_port))?;
            wake.set_nonblocking(true)?;
            let source = wake.local_addr()?;
            Ok::<_, std::io::Error>((wake, source))
        })()
        .map_err(|error| {
            self.lifecycle_error(format!("Could not prepare UDP wake socket: {error}"))
        })?;
        let session_started = Instant::now();
        {
            let mut stats = lock(&self.statistics);
            *stats = Statistics {
                revision: stats.revision,
                session_id: stats.session_id + 1,
                running: true,
                bound_port: Some(bound_port),
                receive_buffer_bytes: Some(receive_buffer_bytes),
                rate_since: session_started,
                ..Statistics::default()
            };
        }
        let stop = Arc::new(AtomicBool::new(false));
        let worker_stop = Arc::clone(&stop);
        let statistics = Arc::clone(&self.statistics);
        let mut sink = self.sink.clone();
        let thread = thread::Builder::new()
            .name("udp-ingress".into())
            .spawn(move || {
                let mut buffer = vec![0; MAX_DATAGRAM_BYTES];
                while !worker_stop.load(Ordering::Acquire) {
                    match socket.recv_from(&mut buffer) {
                        Ok((size, source)) => {
                            // Control traffic never updates counters or reaches a sink,
                            // even if a wake is received before stop is requested.
                            if source == wake_source && buffer[..size] == wake_nonce {
                                continue;
                            }
                            // Any queued traffic also releases a pending stop. Do not
                            // require the wake to get ahead of an existing receive queue.
                            if worker_stop.load(Ordering::Acquire) {
                                break;
                            }
                            // Capture before waiting for stats or invoking any consumer.
                            let captured_at_us = session_started.elapsed().as_micros() as u64;
                            let timestamp_ms = SystemTime::now()
                                .duration_since(UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis() as u64;
                            let packet = CapturedPacket {
                                bytes: &buffer[..size],
                                source,
                                received_at_ms: timestamp_ms,
                                captured_at_us,
                            };
                            lock(&statistics).record(&packet, Instant::now());
                            if let Some(consumer) = &sink {
                                if catch_unwind(AssertUnwindSafe(|| consumer.on_packet(&packet)))
                                    .is_err()
                                {
                                    lock(&statistics).last_error = Some(
                                        "Packet sink panicked and was detached for this session"
                                            .into(),
                                    );
                                    sink = None;
                                }
                            }
                        }
                        Err(error) if error.kind() == ErrorKind::Interrupted => {}
                        Err(error) => {
                            lock(&statistics).receive_failed(error);
                            return;
                        }
                    }
                }
                drop(socket);
                lock(&statistics).stopped();
            })
            .map_err(|error| {
                self.lifecycle_error(format!("Could not start UDP worker: {error}"))
            })?;
        *worker = Some(Worker {
            stop,
            wake_socket,
            wake_nonce,
            thread,
        });
        Ok(self.snapshot())
    }

    pub fn stop(&self) -> Result<StatsSnapshot, String> {
        let mut worker = lock(&self.worker);
        self.join_worker(&mut worker)?;
        lock(&self.statistics).stopped();
        Ok(self.snapshot())
    }

    fn join_worker(&self, worker: &mut Option<Worker>) -> Result<(), String> {
        if let Some(active) = worker.as_ref() {
            active.stop.store(true, Ordering::Release);
            if !active.thread.is_finished() {
                let wake_result = active
                    .wake_socket
                    .send(&active.wake_nonce)
                    .and_then(|sent| {
                        if sent == WAKE_NONCE_BYTES {
                            Ok(())
                        } else {
                            Err(std::io::Error::new(
                                ErrorKind::WriteZero,
                                "Incomplete UDP wake send",
                            ))
                        }
                    });
                if let Err(error) = wake_result {
                    // Keep ownership for a retry; never join a possibly blocked
                    // receiver after a failed wake, or falsely report it as stopped.
                    let message = format!("Could not wake UDP listener for stop: {error}");
                    lock(&self.statistics).last_error = Some(message.clone());
                    return Err(message);
                }
            }
            worker
                .take()
                .expect("worker is present")
                .thread
                .join()
                .map_err(|_| self.lifecycle_error("UDP worker exited unexpectedly".into()))?;
        }
        Ok(())
    }

    fn lifecycle_error(&self, message: String) -> String {
        let mut stats = lock(&self.statistics);
        stats.stopped();
        stats.last_error = Some(message.clone());
        message
    }

    pub fn snapshot(&self) -> StatsSnapshot {
        let mut stats = lock(&self.statistics);
        if stats.running {
            stats.refresh_rate(Instant::now());
        }
        stats.revision += 1;
        let preview =
            stats.latest_raw_packet[..stats.latest_raw_packet.len().min(PREVIEW_BYTES)].to_vec();
        let source = stats.last_source;
        let mut snapshot = StatsSnapshot {
            revision: stats.revision,
            session_id: stats.session_id,
            running: stats.running,
            bound_port: stats.bound_port,
            receive_buffer_bytes: stats.receive_buffer_bytes,
            total_packets: stats.total_packets,
            packets_per_second: stats.packets_per_second,
            total_bytes: stats.total_bytes,
            last_packet_size: stats.last_source.map(|_| stats.latest_raw_packet.len()),
            last_source: None,
            last_packet_timestamp_ms: stats.last_packet_timestamp_ms,
            last_packet_monotonic_us: stats.last_packet_monotonic_us,
            preview_hex: String::new(),
            receive_errors: stats.receive_errors,
            last_error: stats.last_error.clone(),
        };
        drop(stats);
        snapshot.last_source = source.map(|source| source.to_string());
        snapshot.preview_hex = preview
            .iter()
            .map(|byte| format!("{byte:02X}"))
            .collect::<Vec<_>>()
            .join(" ");
        snapshot
    }
}

impl Drop for Listener {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wait_for_packets(listener: &Listener, count: u64) -> StatsSnapshot {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let stats = listener.snapshot();
            if stats.total_packets >= count {
                return stats;
            }
            assert!(Instant::now() < deadline, "Timed out: {stats:?}");
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn idle_stop_wakes_promptly_across_repeated_sessions() {
        let (finished, completion) = std::sync::mpsc::sync_channel(1);
        thread::spawn(move || {
            let listener = Listener::default();
            let mut previous_nonce = None;
            for _ in 0..20 {
                let start = listener.start(0).unwrap();
                let port = start.bound_port.unwrap();
                let nonce = lock(&listener.worker).as_ref().unwrap().wake_nonce;
                assert_ne!(previous_nonce, Some(nonce));
                previous_nonce = Some(nonce);
                // Test-only delay gives the otherwise idle worker time to block.
                thread::sleep(Duration::from_millis(20));
                let before_stop = Instant::now();
                let stopped = listener.stop().unwrap();
                let elapsed = before_stop.elapsed();
                assert!(!stopped.running);
                assert_eq!(stopped.total_packets, 0);
                assert_eq!(stopped.total_bytes, 0);
                assert_eq!(stopped.receive_errors, 0);
                assert_eq!(stopped.last_packet_size, None);
                assert!(listener.stop().is_ok());
                assert!(UdpSocket::bind((LISTEN_ADDRESS, port)).is_ok());
                finished.send(elapsed).unwrap();
            }
        });
        let mut longest = Duration::ZERO;
        for _ in 0..20 {
            // The watchdog applies to each cycle, not total startup/scheduling
            // time across all twenty sessions. Stop latency has its own bound.
            let elapsed = completion
                .recv_timeout(Duration::from_secs(5))
                .expect("idle stop/restart must not hang on blocking recv_from");
            assert!(
                elapsed < Duration::from_millis(500),
                "idle stop took {elapsed:?}"
            );
            longest = longest.max(elapsed);
        }
        println!("20 idle stop/restart cycles: longest stop={longest:?}");
    }

    #[test]
    fn private_wake_is_filtered_before_stats_and_sinks() {
        #[derive(Default)]
        struct RecordingSink(Mutex<Vec<Vec<u8>>>);
        impl PacketSink for RecordingSink {
            fn on_packet(&self, packet: &CapturedPacket<'_>) {
                lock(&self.0).push(packet.bytes.to_vec());
            }
        }
        let sink = Arc::new(RecordingSink::default());
        let listener = Listener::new(ReceiveBuffer::default(), Some(sink.clone()));
        let port = listener.start(0).unwrap().bound_port.unwrap();
        let (nonce, source) = {
            let worker = lock(&listener.worker);
            let worker = worker.as_ref().unwrap();
            // Valid control traffic is ignored even without the stop flag.
            for _ in 0..3 {
                worker.wake_socket.send(&worker.wake_nonce).unwrap();
            }
            // Wrong nonce from the right source must still be ordinary telemetry.
            worker.wake_socket.send(b"ordinary").unwrap();
            (worker.wake_nonce, worker.wake_socket.local_addr().unwrap())
        };
        let first = wait_for_packets(&listener, 1);
        assert_eq!(first.total_packets, 1);
        assert_eq!(first.total_bytes, 8);
        assert_eq!(first.last_source, Some(source.to_string()));
        // Even the exact nonce from a different endpoint is not private control.
        let other = UdpSocket::bind("127.0.0.1:0").unwrap();
        other.send_to(&nonce, ("127.0.0.1", port)).unwrap();
        wait_for_packets(&listener, 2);
        let stopped = listener.stop().unwrap();
        assert_eq!(stopped.total_packets, 2);
        assert_eq!(stopped.total_bytes, 8 + WAKE_NONCE_BYTES as u64);
        assert_eq!(stopped.receive_errors, 0);
        assert_eq!(*lock(&sink.0), vec![b"ordinary".to_vec(), nonce.to_vec()]);

        listener.start(port).unwrap();
        {
            let worker = lock(&listener.worker);
            let worker = worker.as_ref().unwrap();
            assert_ne!(worker.wake_nonce, nonce);
            // An old session nonce is not a control packet in the new session.
            worker.wake_socket.send(&nonce).unwrap();
        }
        wait_for_packets(&listener, 1);
        let restarted = listener.stop().unwrap();
        assert_eq!(restarted.total_packets, 1);
        assert_eq!(restarted.total_bytes, WAKE_NONCE_BYTES as u64);
        assert_eq!(lock(&sink.0).len(), 3);
    }

    #[test]
    fn rate_uses_elapsed_monotonic_time_and_decays_when_idle() {
        let mut stats = Statistics::default();
        let start = stats.rate_since;
        let source = "127.0.0.1:1234".parse().unwrap();
        for _ in 0..120 {
            stats.record(
                &CapturedPacket {
                    bytes: &[1, 2],
                    source,
                    received_at_ms: 42,
                    captured_at_us: 0,
                },
                start,
            );
        }
        stats.refresh_rate(start + Duration::from_secs(2));
        assert_eq!(stats.packets_per_second, 60.0);
        assert_eq!(stats.total_packets, 120);
        assert_eq!(stats.total_bytes, 240);
        stats.refresh_rate(start + Duration::from_secs(3));
        assert_eq!(stats.packets_per_second, 0.0);
    }

    #[test]
    fn receive_failure_is_counted_and_stops_session() {
        let mut stats = Statistics {
            running: true,
            bound_port: Some(5300),
            ..Statistics::default()
        };
        stats.receive_failed("injected receive failure");
        assert_eq!(stats.receive_errors, 1);
        assert!(!stats.running);
        assert_eq!(stats.bound_port, None);
        assert_eq!(
            stats.last_error.as_deref(),
            Some("UDP receive error: injected receive failure")
        );
    }

    #[test]
    fn bind_failure_surfaces_and_next_start_recovers() {
        // Occupied on the address the listener actually binds. A wildcard
        // holder would no longer conflict: since the listener took loopback,
        // `0.0.0.0:P` and `127.0.0.1:P` can coexist on Windows, and using one
        // here would silently stop testing bind failure at all.
        let occupied = UdpSocket::bind((LISTEN_ADDRESS, 0)).unwrap();
        let listener = Listener::default();
        assert!(listener
            .start(occupied.local_addr().unwrap().port())
            .is_err());
        let failed = listener.snapshot();
        assert!(!failed.running);
        assert!(failed.last_error.is_some());
        assert_eq!(failed.receive_errors, 0);
        assert!(listener.start(0).unwrap().last_error.is_none());
        listener.stop().unwrap();
    }

    #[test]
    fn stop_restart_is_idempotent_and_resets_all_session_fields() {
        let listener = Listener::default();
        listener.stop().unwrap();
        let started = listener.start(0).unwrap();
        let port = started.bound_port.unwrap();
        let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
        sender.send_to(&[0xAB; 100], ("127.0.0.1", port)).unwrap();
        let first = wait_for_packets(&listener, 1);
        assert_eq!(first.preview_hex, vec!["AB"; 32].join(" "));
        assert_eq!(
            first.last_source,
            Some(sender.local_addr().unwrap().to_string())
        );
        assert!(first.last_packet_timestamp_ms.is_some());
        assert_eq!(
            lock(&listener.statistics).latest_raw_packet,
            vec![0xAB; 100]
        );
        assert_eq!(listener.start(port).unwrap().total_packets, 1);
        let other_port = if port == 65535 { port - 1 } else { port + 1 };
        assert!(listener.start(other_port).is_err());
        assert!(listener.snapshot().running);
        let stopped = listener.stop().unwrap();
        assert!(!stopped.running);
        assert_eq!(stopped.total_packets, 1);
        assert_eq!(stopped.total_bytes, 100);
        assert_eq!(stopped.packets_per_second, 0.0);
        assert_eq!(listener.stop().unwrap().total_packets, 1);
        let restarted = listener.start(port).unwrap();
        assert_eq!(restarted.session_id, started.session_id + 1);
        assert!(restarted.revision > stopped.revision);
        assert_eq!(restarted.total_packets, 0);
        assert_eq!(restarted.total_bytes, 0);
        assert_eq!(restarted.last_source, None);
        assert_eq!(restarted.last_packet_size, None);
        assert_eq!(restarted.last_packet_timestamp_ms, None);
        assert_eq!(restarted.last_packet_monotonic_us, None);
        assert_eq!(restarted.receive_errors, 0);
        assert_eq!(restarted.last_error, None);
        assert!(restarted.preview_hex.is_empty());
        sender.send_to(&[], ("127.0.0.1", port)).unwrap();
        let empty = wait_for_packets(&listener, 1);
        assert_eq!(empty.last_packet_size, Some(0));
        assert_eq!(empty.total_bytes, 0);
        listener.stop().unwrap();
    }

    #[test]
    fn full_size_datagram_is_retained_without_truncation() {
        let listener = Listener::default();
        let port = listener.start(0).unwrap().bound_port.unwrap();
        let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
        sender
            .send_to(&vec![0xCD; 65_507], ("127.0.0.1", port))
            .unwrap();
        let stats = wait_for_packets(&listener, 1);
        assert_eq!(stats.total_bytes, 65_507);
        assert_eq!(stats.last_packet_size, Some(65_507));
        assert_eq!(stats.preview_hex.len(), 95);
        assert_eq!(lock(&listener.statistics).latest_raw_packet.len(), 65_507);
    }

    #[test]
    fn burst_is_counted_without_any_snapshot_consumer() {
        let listener = Listener::default();
        let port = listener.start(0).unwrap().bound_port.unwrap();
        let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
        for _ in 0..1000 {
            sender.send_to(&[0xAB; 128], ("127.0.0.1", port)).unwrap();
        }
        let stats = wait_for_packets(&listener, 1000);
        assert_eq!(stats.total_packets, 1000);
        assert_eq!(stats.total_bytes, 128_000);
        assert_eq!(stats.receive_errors, 0);
    }

    #[test]
    fn concurrent_lifecycle_requests_leave_no_orphan_socket() {
        let listener = Arc::new(Listener::default());
        let port = listener.start(0).unwrap().bound_port.unwrap();
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let listener = Arc::clone(&listener);
                thread::spawn(move || {
                    for _ in 0..4 {
                        listener.start(port).unwrap();
                        listener.stop().unwrap();
                    }
                })
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        listener.stop().unwrap();
        assert!(UdpSocket::bind((LISTEN_ADDRESS, port)).is_ok());
    }

    #[test]
    fn restart_on_a_different_port_resets_the_session_and_releases_old_port() {
        let reserved = UdpSocket::bind("0.0.0.0:0").unwrap();
        let other_port = reserved.local_addr().unwrap().port();
        let listener = Listener::default();
        let first = listener.start(0).unwrap();
        let first_port = first.bound_port.unwrap();
        assert_ne!(first_port, other_port);
        let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
        sender.send_to(b"old", ("127.0.0.1", first_port)).unwrap();
        wait_for_packets(&listener, 1);
        listener.stop().unwrap();
        let _old_port = UdpSocket::bind((LISTEN_ADDRESS, first_port)).unwrap();
        drop(reserved);
        let second = listener.start(other_port).unwrap();
        assert_eq!(second.bound_port, Some(other_port));
        assert_eq!(second.session_id, first.session_id + 1);
        assert_eq!(second.total_packets, 0);
        assert_eq!(second.last_packet_monotonic_us, None);
        sender.send_to(b"new", ("127.0.0.1", other_port)).unwrap();
        let final_stats = wait_for_packets(&listener, 1);
        assert_eq!(final_stats.total_bytes, 3);
        assert_eq!(final_stats.preview_hex, "6E 65 77");
        assert!(final_stats.last_packet_monotonic_us.is_some());
    }

    #[derive(Default)]
    struct TimingSink {
        listener: Mutex<std::sync::Weak<Listener>>,
        // Bounded by the test's finite 1000-packet input.
        times_and_counts: Mutex<Vec<(u64, u64)>>,
    }

    impl PacketSink for TimingSink {
        fn on_packet(&self, packet: &CapturedPacket<'_>) {
            // A snapshot here verifies that the statistics mutex is not held by
            // transport while invoking the consumer, and counts update first.
            let listener = lock(&self.listener).upgrade().unwrap();
            let count = listener.snapshot().total_packets;
            lock(&self.times_and_counts).push((packet.captured_at_us, count));
        }
    }

    #[test]
    fn snapshot_contention_preserves_packets_and_monotonic_capture_times() {
        let sink = Arc::new(TimingSink::default());
        let listener = Arc::new(Listener::new(ReceiveBuffer::default(), Some(sink.clone())));
        *lock(&sink.listener) = Arc::downgrade(&listener);
        let port = listener.start(0).unwrap().bound_port.unwrap();
        let finished = Arc::new(AtomicBool::new(false));
        let readers: Vec<_> = (0..4)
            .map(|_| {
                let listener = listener.clone();
                let finished = finished.clone();
                thread::spawn(move || {
                    while !finished.load(Ordering::Acquire) {
                        listener.snapshot();
                        thread::yield_now();
                    }
                })
            })
            .collect();
        let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
        for _ in 0..1000 {
            sender.send_to(b"raw", ("127.0.0.1", port)).unwrap();
            thread::sleep(Duration::from_millis(1));
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while listener.snapshot().total_packets < 1000 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        finished.store(true, Ordering::Release);
        for reader in readers {
            reader.join().unwrap();
        }
        let stats = listener.stop().unwrap();
        let observations = lock(&sink.times_and_counts);
        assert_eq!(stats.total_packets, 1000);
        assert_eq!(observations.len(), 1000);
        assert!(observations.windows(2).all(|pair| pair[0].0 <= pair[1].0));
        assert!(observations
            .iter()
            .enumerate()
            .all(|(index, (_, count))| *count == index as u64 + 1));
        assert_eq!(
            stats.last_packet_monotonic_us,
            Some(observations.last().unwrap().0)
        );
    }

    #[test]
    fn sink_panic_is_reported_and_does_not_stop_authoritative_counting() {
        struct PanickingSink(std::sync::atomic::AtomicUsize);
        impl PacketSink for PanickingSink {
            fn on_packet(&self, _: &CapturedPacket<'_>) {
                self.0.fetch_add(1, Ordering::Relaxed);
                panic!("injected consumer failure");
            }
        }
        let sink = Arc::new(PanickingSink(std::sync::atomic::AtomicUsize::new(0)));
        let listener = Listener::new(ReceiveBuffer::default(), Some(sink.clone()));
        let port = listener.start(0).unwrap().bound_port.unwrap();
        let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
        for _ in 0..2 {
            sender.send_to(b"raw", ("127.0.0.1", port)).unwrap();
        }
        wait_for_packets(&listener, 2);
        let stats = listener.stop().unwrap();
        assert_eq!(sink.0.load(Ordering::Relaxed), 1);
        assert_eq!(stats.total_packets, 2);
        assert_eq!(stats.receive_errors, 0);
        assert!(stats.last_error.unwrap().contains("Packet sink panicked"));
        assert_eq!(listener.start(port).unwrap().last_error, None);
    }
}
