//! Sequence-verified Windows loopback matrix; all synthetic decoding lives in support/.
mod support;

#[cfg(windows)]
mod windows_load {
    use super::support::SequenceObserver;
    use racelab_lib::ingress::{Listener, ReceiveBuffer};
    use std::{
        fs,
        path::Path,
        process::Command,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        thread,
        time::{Duration, Instant},
    };

    fn run_case(label: &str, hz: u32, receive_buffer: ReceiveBuffer) -> bool {
        const COUNT: u32 = 1000;
        let case_started = Instant::now();
        let evidence = Path::new(env!("CARGO_MANIFEST_DIR")).join("../docs/v0.2.2-load");
        fs::create_dir_all(&evidence).unwrap();
        let audit_path = evidence.join(format!("{label}-sends.tsv"));
        let observer = Arc::new(SequenceObserver::new(COUNT as usize));
        let listener = Arc::new(Listener::new(receive_buffer, Some(observer.clone())));
        let initial = listener.start(0).unwrap();
        let port = initial.bound_port.unwrap();
        println!(
            "BEGIN {label} hz={hz} requested={receive_buffer:?} winsock_readback={:?}",
            initial.receive_buffer_bytes
        );
        let done = Arc::new(AtomicBool::new(false));
        let sampling_listener = listener.clone();
        let sampling_done = done.clone();
        let sampler = thread::spawn(move || {
            thread::sleep(Duration::from_secs(2));
            let mut samples = 0;
            let mut peak_rate = 0.0_f64;
            while !sampling_done.load(Ordering::Acquire) {
                peak_rate = peak_rate.max(sampling_listener.snapshot().packets_per_second);
                samples += 1;
                thread::sleep(Duration::from_millis(250));
            }
            (samples, peak_rate)
        });
        let sender_script =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/send-test-udp.ps1");
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(sender_script)
            .args([
                "-Port",
                &port.to_string(),
                "-Count",
                &COUNT.to_string(),
                "-Hz",
                &hz.to_string(),
                "-PayloadBytes",
                "128",
                "-DiagnosticPath",
            ])
            .arg(&audit_path)
            .output()
            .expect("PowerShell sender must launch");
        let deadline = Instant::now() + Duration::from_secs(3);
        while listener.snapshot().total_packets < COUNT as u64 && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        thread::sleep(Duration::from_millis(2200));
        done.store(true, Ordering::Release);
        let (samples, peak_rate) = sampler.join().unwrap();
        let idle = listener.snapshot();
        // Joining the worker guarantees the final sink callback has completed.
        let final_stats = listener.stop().unwrap();
        let report = observer.report(COUNT);
        let elapsed = case_started.elapsed().as_secs_f64();
        let observations = observer.observations();
        let first = observations.first().and_then(|p| p.sequence);
        let last = observations.last().and_then(|p| p.sequence);
        let audit = fs::read_to_string(&audit_path).unwrap();
        let rows: Vec<_> = audit.lines().skip(1).collect();
        let sent = rows
            .iter()
            .filter(|row| {
                let fields: Vec<_> = row.split('\t').collect();
                fields.len() >= 5 && fields[3] == "128" && fields[4] == "True"
            })
            .count();
        let verified_sends = rows.len() == COUNT as usize
            && sent == COUNT as usize
            && rows.iter().enumerate().all(|(i, row)| {
                row.split('\t').next().and_then(|s| s.parse::<usize>().ok()) == Some(i + 1)
            });
        fs::write(evidence.join(format!("{label}-sender.txt")), &output.stdout).unwrap();
        fs::write(
            evidence.join(format!("{label}-received.tsv")),
            format!(
                "seq\tcapture_us\n{}",
                observations
                    .iter()
                    .map(|p| format!("{:?}\t{}\n", p.sequence, p.monotonic_us))
                    .collect::<String>()
            ),
        )
        .unwrap();
        println!(
            "SENDER {label}: {}",
            String::from_utf8_lossy(&output.stdout).trim()
        );
        println!("RESULT {label} hz={hz} sent={sent} first={first:?} last={last:?} elapsed_seconds={elapsed:.6} packets={} bytes={} receive_errors={} samples={samples} peak_pps={peak_rate:.2} idle_pps={:.1} {}",
            final_stats.total_packets, final_stats.total_bytes, final_stats.receive_errors, idle.packets_per_second, report.diagnostics());
        let passed = output.status.success()
            && verified_sends
            && first == Some(1)
            && last == Some(COUNT)
            && final_stats.total_packets == COUNT as u64
            && final_stats.total_bytes == COUNT as u64 * 128
            && final_stats.receive_errors == 0
            && final_stats.last_error.is_none()
            && final_stats.last_packet_size == Some(128)
            && idle.packets_per_second == 0.0
            && report.complete(COUNT)
            && report.tail.last() == Some(&COUNT);
        if !passed {
            eprintln!(
                "FAILED {label}: {} sender_stderr={} stats={final_stats:?}",
                report.diagnostics(),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        passed
    }

    #[test]
    #[ignore = "14 paced runs of 1000 packets; approximately 13 minutes"]
    fn sequence_verified_hardening_matrix() {
        let mut failures = Vec::new();
        // Only receive-loop behavior changes: every run keeps the current 4 MiB request.
        for (hz, runs) in [(10, 5), (20, 3), (60, 3), (120, 3)] {
            for run in 1..=runs {
                let label = format!("{hz}hz-4mib-run{run}");
                if !run_case(&label, hz, ReceiveBuffer::default()) {
                    failures.push(label);
                }
            }
        }
        assert!(
            failures.is_empty(),
            "Sequence-verified load cases failed: {failures:?}; exact missing ranges printed above"
        );
    }
}
