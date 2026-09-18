//! Isolate duration/lifecycle explanations without changing product receive settings.
mod support;

#[cfg(windows)]
mod diagnosis {
    use super::support::SequenceObserver;
    use racelab_lib::{
        ingress::{Listener, ReceiveBuffer},
        packet::{CapturedPacket, PacketSink},
    };
    use std::{
        fs,
        path::Path,
        process::{Command, Stdio},
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        },
        thread,
        time::{Duration, Instant},
    };

    #[link(name = "kernel32")]
    extern "system" {
        fn QueryPerformanceCounter(value: *mut i64) -> i32;
        fn QueryPerformanceFrequency(value: *mut i64) -> i32;
    }
    fn ticks() -> i64 {
        let mut value = 0;
        // Valid writable pointer; Windows QPC shares a clock with .NET Stopwatch.
        assert_ne!(unsafe { QueryPerformanceCounter(&mut value) }, 0);
        value
    }
    fn frequency() -> i64 {
        let mut value = 0;
        assert_ne!(unsafe { QueryPerformanceFrequency(&mut value) }, 0);
        value
    }

    struct Trace {
        sequences: SequenceObserver,
        callback_ticks: Mutex<Vec<i64>>,
        limit: usize,
    }
    impl Trace {
        fn new(count: u32) -> Self {
            Self {
                sequences: SequenceObserver::new(count as usize),
                callback_ticks: Mutex::new(Vec::with_capacity(count as usize * 2)),
                limit: count as usize * 2,
            }
        }
    }
    impl PacketSink for Trace {
        fn on_packet(&self, packet: &CapturedPacket<'_>) {
            let now = ticks();
            self.sequences.on_packet(packet);
            let mut times = self.callback_ticks.lock().unwrap();
            if times.len() < self.limit {
                times.push(now);
            }
        }
    }

    fn run_case(root: &Path, hz: u32, count: u32, buffer: ReceiveBuffer, label: &str) -> bool {
        let mut events = vec![("case_start", ticks())];
        let observer = Arc::new(Trace::new(count));
        let listener = Arc::new(Listener::new(buffer, Some(observer.clone())));
        events.push(("receiver_start_requested", ticks()));
        let initial = listener.start(0).unwrap();
        events.push(("receiver_ready", ticks()));
        let port = initial.bound_port.unwrap();
        println!("DIAG_BEGIN {label} count={count} hz={hz} buffer={buffer:?} winsock_readback={:?} qpc_frequency={}", initial.receive_buffer_bytes, frequency());
        let done = Arc::new(AtomicBool::new(false));
        let sampler_listener = listener.clone();
        let sampler_done = done.clone();
        let sampler = thread::spawn(move || {
            let mut samples = Vec::with_capacity(1024);
            thread::sleep(Duration::from_secs(2));
            while !sampler_done.load(Ordering::Acquire) {
                let sample = sampler_listener.snapshot();
                if samples.len() < 1024 {
                    samples.push((ticks(), sample.running, sample.total_packets));
                }
                thread::sleep(Duration::from_millis(250));
            }
            samples
        });
        let sends_path = root.join(format!("{label}-sends.tsv"));
        let sender = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/send-test-udp.ps1");
        events.push(("child_spawn_requested", ticks()));
        let child = Command::new("powershell.exe")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(sender)
            .args([
                "-Port",
                &port.to_string(),
                "-Count",
                &count.to_string(),
                "-Hz",
                &hz.to_string(),
                "-PayloadBytes",
                "128",
                "-DiagnosticPath",
            ])
            .arg(&sends_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        events.push(("child_spawn_returned", ticks()));
        // Intentionally no timeout or watchdog: this waits for the actual child exit.
        let output = child.wait_with_output().unwrap();
        events.push(("child_exit_observed", ticks()));
        events.push(("stats_wait_started", ticks()));
        let deadline = Instant::now() + Duration::from_secs(3);
        while listener.snapshot().total_packets < count as u64 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        events.push(("stats_wait_finished", ticks()));
        thread::sleep(Duration::from_millis(2200));
        events.push(("sampler_stop_requested", ticks()));
        done.store(true, Ordering::Release);
        let samples = sampler.join().unwrap();
        events.push(("sampler_joined", ticks()));
        let before_stop = listener.snapshot();
        events.push(("test_teardown_requested", ticks()));
        let stats = listener.stop().unwrap();
        events.push(("receiver_joined_socket_closed", ticks()));
        let report = observer.sequences.report(count);
        let observations = observer.sequences.observations();
        let receive_ticks = observer.callback_ticks.lock().unwrap();
        assert_eq!(observations.len(), receive_ticks.len());
        let first = observations.first().and_then(|value| value.sequence);
        let last = observations.last().and_then(|value| value.sequence);
        let send_audit = fs::read_to_string(&sends_path).unwrap();
        let send_rows: Vec<_> = send_audit.lines().skip(1).collect();
        let send_successes = send_rows
            .iter()
            .filter(|row| {
                let fields: Vec<_> = row.split('\t').collect();
                fields.len() >= 5 && fields[3] == "128" && fields[4] == "True"
            })
            .count();
        let every_send_verified = send_rows.len() == count as usize
            && send_successes == count as usize
            && send_rows.iter().enumerate().all(|(index, row)| {
                row.split('\t').next().and_then(|v| v.parse::<usize>().ok()) == Some(index + 1)
            });
        let alive = before_stop.running && samples.iter().all(|sample| sample.1);
        events.push(("test_teardown_finished", ticks()));
        let event_text = format!(
            "event\tticks\n{}",
            events
                .iter()
                .map(|(name, at)| format!("{name}\t{at}\n"))
                .collect::<String>()
        );
        fs::write(root.join(format!("{label}-lifecycle.tsv")), &event_text).unwrap();
        let packets_text = format!(
            "seq\tcapture_us\tcallback_ticks\n{}",
            observations
                .iter()
                .zip(receive_ticks.iter())
                .map(|(packet, at)| format!(
                    "{}\t{}\t{at}\n",
                    packet
                        .sequence
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "malformed".into()),
                    packet.monotonic_us
                ))
                .collect::<String>()
        );
        fs::write(root.join(format!("{label}-received.tsv")), packets_text).unwrap();
        fs::write(
            root.join(format!("{label}-snapshots.tsv")),
            format!(
                "ticks\trunning\tpackets\n{}",
                samples
                    .iter()
                    .map(|(at, running, packets)| format!("{at}\t{running}\t{packets}\n"))
                    .collect::<String>()
            ),
        )
        .unwrap();
        fs::write(root.join(format!("{label}-sender.txt")), &output.stdout).unwrap();
        println!(
            "SENDER {label}: {}",
            String::from_utf8_lossy(&output.stdout).trim()
        );
        println!("LIFECYCLE {label}: {events:?}");
        println!("DIAG_RESULT {label} sent_success={send_successes}/{} receiver_count={} first={first:?} last={last:?} receiver_alive_until_teardown={alive} {}", send_rows.len(), stats.total_packets, report.diagnostics());
        let passed = output.status.success()
            && every_send_verified
            && alive
            && report.complete(count)
            && last == Some(count)
            && stats.total_packets == count as u64
            && stats.total_bytes == count as u64 * 128
            && stats.receive_errors == 0
            && stats.last_error.is_none();
        if !passed {
            eprintln!(
                "DIAG_FAILED {label} {} sender_stderr={}",
                report.diagnostics(),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        passed
    }

    #[test]
    #[ignore = "duration diagnosis: approximately nine minutes"]
    fn duration_matrix() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/udp-diagnosis");
        fs::create_dir_all(&root).unwrap();
        let mut failed = Vec::new();
        for count in [100, 300, 600, 1000] {
            for (name, buffer) in [
                ("default", ReceiveBuffer::SystemDefault),
                ("4mib", ReceiveBuffer::default()),
            ] {
                let label = format!("10hz-{count}-{name}");
                if !run_case(&root, 10, count, buffer, &label) {
                    failed.push(label);
                }
            }
        }
        for hz in [20, 60] {
            let label = format!("{hz}hz-1000-4mib");
            if !run_case(&root, hz, 1000, ReceiveBuffer::default(), &label) {
                failed.push(label);
            }
        }
        assert!(failed.is_empty(), "Duration matrix failed cases: {failed:?}; full send/receive/lifecycle audit files retained");
    }

    /// A test-only receiver control: same socket API as production, but no app,
    /// stats publisher, child process, or long-run deadline. SO_RCVBUF is untouched.
    /// Replay measured send spacing to distinguish receive timeout from duration.
    #[test]
    #[ignore = "requires duration matrix traces; three 30-second receiver controls"]
    fn replay_receiver_timeout_control() {
        use std::net::UdpSocket;
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/udp-diagnosis");
        let source = fs::read_to_string(root.join("10hz-1000-default-sends.tsv")).unwrap();
        let schedule: Vec<i64> = source
            .lines()
            .skip(1)
            .take(300)
            .map(|line| line.split('\t').nth(1).unwrap().parse().unwrap())
            .collect();
        assert_eq!(schedule.len(), 300);
        let tick_frequency = frequency();
        for (run, timeout_ms) in [100, 250, 100].into_iter().enumerate() {
            let label = format!("replay-{}-timeout{timeout_ms}ms", run + 1);
            let socket = UdpSocket::bind("0.0.0.0:0").unwrap();
            let port = socket.local_addr().unwrap().port();
            let buffer_readback = socket2::SockRef::from(&socket).recv_buffer_size().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_millis(timeout_ms)))
                .unwrap();
            let finished = Arc::new(AtomicBool::new(false));
            let worker_finished = finished.clone();
            let observer = Arc::new(SequenceObserver::new(300));
            let worker_observer = observer.clone();
            let (ready_sender, ready_receiver) = std::sync::mpsc::sync_channel(1);
            let worker = thread::spawn(move || {
                let start = Instant::now();
                let worker_start_ticks = ticks();
                let mut bytes = vec![0; 65_535];
                let mut calls = Vec::with_capacity(1024);
                ready_sender.send(()).unwrap();
                while !worker_finished.load(Ordering::Acquire) {
                    let before = ticks();
                    let result = socket.recv_from(&mut bytes);
                    let after = ticks();
                    match result {
                        Ok((size, source)) => {
                            let text = std::str::from_utf8(&bytes[..size]).unwrap();
                            let seq = text
                                .strip_prefix("RACELAB_TEST|seq=")
                                .unwrap()
                                .split('|')
                                .next()
                                .unwrap();
                            calls.push(format!("{before}\t{after}\tok\t{seq}\t\n"));
                            worker_observer.on_packet(&CapturedPacket {
                                bytes: &bytes[..size],
                                source,
                                received_at_ms: 0,
                                captured_at_us: start.elapsed().as_micros() as u64,
                            });
                        }
                        Err(error) => {
                            calls.push(format!(
                                "{before}\t{after}\t{:?}\t\t{:?}\n",
                                error.kind(),
                                error.raw_os_error()
                            ));
                            if !matches!(
                                error.kind(),
                                std::io::ErrorKind::TimedOut
                                    | std::io::ErrorKind::WouldBlock
                                    | std::io::ErrorKind::Interrupted
                            ) {
                                break;
                            }
                        }
                    }
                    assert!(
                        calls.len() < 1024,
                        "Bounded diagnostic call trace exhausted"
                    );
                }
                (worker_start_ticks, ticks(), calls)
            });
            ready_receiver.recv().unwrap();
            thread::sleep(Duration::from_millis(20));
            let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
            let sender_start = ticks();
            let pacing_start = Instant::now();
            let mut sends = String::from("seq\tbefore_ticks\tafter_ticks\tbytes\tsuccess\terror\n");
            for (index, target) in schedule.iter().enumerate() {
                let offset =
                    Duration::from_secs_f64((*target - schedule[0]) as f64 / tick_frequency as f64);
                while pacing_start.elapsed() < offset {
                    let remaining = offset.saturating_sub(pacing_start.elapsed());
                    if remaining > Duration::from_millis(2) {
                        thread::sleep(remaining - Duration::from_millis(1));
                    } else {
                        std::hint::spin_loop();
                    }
                }
                let mut bytes = format!("RACELAB_TEST|seq={}|utc=0", index + 1).into_bytes();
                bytes.resize(128, b'.');
                let before = ticks();
                let written = sender.send_to(&bytes, ("127.0.0.1", port)).unwrap();
                let after = ticks();
                sends.push_str(&format!(
                    "{}\t{before}\t{after}\t{written}\t{}\t\n",
                    index + 1,
                    written == 128
                ));
                assert_eq!(written, 128);
            }
            let sender_end = ticks();
            thread::sleep(Duration::from_millis(1500));
            let teardown = ticks();
            finished.store(true, Ordering::Release);
            let (receiver_start, receiver_end, calls) = worker.join().unwrap();
            let joined = ticks();
            let report = observer.report(300);
            fs::write(root.join(format!("{label}-sends.tsv")), sends).unwrap();
            fs::write(
                root.join(format!("{label}-recv-calls.tsv")),
                format!(
                    "before_ticks\tafter_ticks\tresult\tseq\tos_error\n{}",
                    calls.concat()
                ),
            )
            .unwrap();
            println!("REPLAY_RESULT {label} qpc_frequency={tick_frequency} buffer_readback={buffer_readback} receiver_start={receiver_start} sender_start={sender_start} sender_end={sender_end} teardown={teardown} receiver_end={receiver_end} joined={joined} {}", report.diagnostics());
            // This diagnostic records loss rather than aborting the A/B/A sequence.
        }
    }
}
