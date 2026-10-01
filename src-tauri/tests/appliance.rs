use racelab_lib::{
    adapters::fh6,
    appliance::{Appliance, DEFAULT_FH6_PORT},
    capture_format::CaptureReader,
    live_telemetry::{ConnectionConfig, ConnectionState as C, Health, LiveTelemetrySink},
    packet::{CapturedPacket, PacketSink},
    protocol::{PacketClassification as P, ProtocolDetector},
    session::SessionState as S,
    telemetry::TelemetryFrame,
    telemetry_hub::TelemetryHub,
};
use std::{
    fs::File,
    io::BufReader,
    net::{SocketAddr, UdpSocket},
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Default)]
struct Counter(AtomicU64);
impl PacketSink for Counter {
    fn on_packet(&self, _: &CapturedPacket<'_>) {
        self.0.fetch_add(1, Ordering::Relaxed);
    }
}
fn packet(time: u32, active: bool) -> Vec<u8> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fh6/sample-01.rlcap");
    let mut reader = CaptureReader::new(BufReader::new(File::open(path).unwrap())).unwrap();
    while let Some(mut packet) = reader.next_packet().unwrap() {
        if packet.bytes[0] == 1 {
            packet.bytes[0..4].copy_from_slice(&i32::from(active).to_le_bytes());
            packet.bytes[4..8].copy_from_slice(&time.to_le_bytes());
            packet.bytes[212..216].copy_from_slice(&123_i32.to_le_bytes());
            return packet.bytes;
        }
    }
    panic!("missing active fixture")
}
fn source() -> SocketAddr {
    "127.0.0.1:5200".parse().unwrap()
}
fn live() -> LiveTelemetrySink {
    let live = LiveTelemetrySink::with_config(
        Arc::new(Counter::default()),
        ConnectionConfig {
            silence_ms: 100,
            grace_ms: 500,
            ring_capacity: 8,
            ..Default::default()
        },
        "test".into(),
    )
    .unwrap();
    live.begin_start_at(0);
    live.listener_ready_at(0);
    live
}
fn send(live: &LiveTelemetrySink, time: u64, active: bool) {
    let bytes = packet(time as u32, active);
    live.on_packet_at(
        &CapturedPacket {
            bytes: &bytes,
            source: source(),
            received_at_ms: 1_800_000_000_000 + time,
            captured_at_us: time * 1000,
        },
        time,
    );
}
fn lock(live: &LiveTelemetrySink, from: u64, active: bool) {
    for n in 0..5 {
        send(live, from + n * 16, active);
    }
}

#[test]
fn automatic_startup_binds_without_a_user_start_command_and_detects_real_udp() {
    assert_eq!(DEFAULT_FH6_PORT, 20440);
    let appliance = Arc::new(
        Appliance::new(Arc::new(Counter::default()), ConnectionConfig::default(), 0).unwrap(),
    );
    assert_eq!(appliance.live.snapshot().connection, C::Starting);
    let startup = appliance.clone();
    let stats = thread::spawn(move || startup.automatic_start())
        .join()
        .unwrap()
        .unwrap();
    assert!(stats.running);
    assert_eq!(appliance.live.snapshot().connection, C::Listening);
    let sender = UdpSocket::bind("127.0.0.1:0").unwrap();
    let destination = ("127.0.0.1", stats.bound_port.unwrap());
    for n in 0..5 {
        sender.send_to(&packet(n * 16, true), destination).unwrap();
        thread::sleep(Duration::from_millis(5));
    }
    let until = Instant::now() + Duration::from_secs(3);
    while appliance.live.snapshot().protocol.is_none() {
        assert!(Instant::now() < until);
        thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(appliance.live.snapshot().connection, C::SessionActive);
    appliance.stop().unwrap();
    // A late automatic startup must respect an explicit diagnostics Stop.
    assert!(!appliance.automatic_start().unwrap().running);
}
#[test]
fn bind_failure_is_error_and_diagnostic_retry_recovers() {
    // Occupied on the address the listener binds. A wildcard holder no longer
    // conflicts with the loopback bind, so using one would stop this testing
    // bind failure at all.
    let occupied = UdpSocket::bind((racelab_lib::ingress::LISTEN_ADDRESS, 0)).unwrap();
    let appliance = Appliance::new(
        Arc::new(Counter::default()),
        ConnectionConfig::default(),
        occupied.local_addr().unwrap().port(),
    )
    .unwrap();
    assert!(appliance.automatic_start().is_err());
    assert_eq!(appliance.live.snapshot().connection, C::Error);
    assert_eq!(appliance.live.snapshot().health, Health::Lost);
    appliance.start(0).unwrap();
    assert_eq!(appliance.live.snapshot().connection, C::Listening);
    appliance.stop().unwrap();
}
#[test]
fn detection_requires_consecutive_invariant_valid_progressing_frames_from_one_source() {
    let mut detector = ProtocolDetector::new(5).unwrap();
    for n in 0..4 {
        let result = detector.ingest(&packet(n * 16, true), source(), u64::from(n * 16));
        assert!(result.frame.is_none());
        assert!(detector.protocol().is_none());
    }
    assert!(detector.confidence() < 1.0);
    assert!(detector.ingest(&[0; 324], source(), 65).frame.is_none());
    assert_eq!(detector.confidence(), 0.0);
    for n in 0..5 {
        let result = detector.ingest(&packet(80 + n * 16, true), source(), u64::from(80 + n * 16));
        assert_eq!(result.frame.is_some(), n == 4);
    }
    assert_eq!(detector.protocol(), Some("fh6"));
    assert_eq!(detector.confidence(), 1.0);
    let foreign = "127.0.0.1:9000".parse().unwrap();
    assert!(detector
        .ingest(&packet(160, true), foreign, 160)
        .frame
        .is_none());
    assert_eq!(detector.protocol(), Some("fh6"));
    assert!(detector
        .ingest(&packet(176, true), source(), 176)
        .frame
        .is_some());
}
#[test]
fn random_324_bytes_zero_filled_and_frozen_timestamps_do_not_identify_fh6() {
    let mut detector = ProtocolDetector::new(5).unwrap();
    let mut seed = 42_u32;
    for n in 0..1000 {
        let mut bytes = [0; 324];
        for b in &mut bytes {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            *b = (seed >> 24) as u8;
        }
        assert!(detector.ingest(&bytes, source(), n).frame.is_none());
        assert!(detector.protocol().is_none());
    }
    for n in 0..20 {
        assert!(detector
            .ingest(&[0; 324], source(), 1000 + n)
            .frame
            .is_none());
    }
    for n in 0..20 {
        assert!(detector
            .ingest(&packet(0, true), source(), 1100 + n)
            .frame
            .is_none());
    }
    assert!(detector.protocol().is_none());
}
#[test]
fn plausible_timestamp_checks_reject_regression_large_jump_and_stalled_clock() {
    let mut detector = ProtocolDetector::new(5).unwrap();
    for n in 0..5 {
        detector.ingest(&packet(100 + n * 16, true), source(), u64::from(n * 16));
    }
    assert!(!detector
        .ingest(&packet(1, true), source(), 80)
        .issues
        .is_empty());
    assert!(!detector
        .ingest(&packet(1_000_000, true), source(), 96)
        .issues
        .is_empty());
    assert!(!detector
        .ingest(&packet(164, true), source(), 3000)
        .issues
        .is_empty());
}

#[test]
fn a_locked_inactive_stream_may_pause_its_game_clock_and_resume() {
    let mut detector = ProtocolDetector::new(5).unwrap();
    for n in 0..5 {
        detector.ingest(&packet(n * 16, false), source(), u64::from(n * 16));
    }
    assert_eq!(detector.protocol(), Some("fh6"));
    assert!(detector
        .ingest(&packet(64, false), source(), 10_000)
        .frame
        .is_some());
    assert!(detector
        .ingest(&packet(64, true), source(), 10_100)
        .frame
        .is_some());
}
#[test]
fn idle_detection_active_session_and_inactive_null_contract() {
    let live = live();
    assert_eq!(live.snapshot_at(0).connection, C::Listening);
    send(&live, 0, false);
    assert_eq!(live.snapshot_at(0).connection, C::Probing);
    for n in 1..5 {
        send(&live, n * 16, false);
    }
    let idle = live.snapshot_at(64);
    assert_eq!(idle.connection, C::ConnectedIdle);
    assert!(idle.session.is_none());
    let f = idle.frame.unwrap();
    assert!(f.speed_mps.is_none());
    assert!(f.engine.rpm.is_none());
    assert!(f.controls.throttle.is_none());
    assert!(f.gear.is_none());
    let json = serde_json::to_value(&*f).unwrap();
    assert!(json["speed_mps"].is_null());
    assert!(json["controls"]["steering"].is_null());
    assert!(json["sourceSpecific"]["fh6"]["float_fields"]["16"].is_number());
    send(&live, 80, true);
    let active = live.snapshot_at(80);
    assert_eq!(active.connection, C::SessionActive);
    let session = active.session.unwrap();
    assert_eq!(session.state, S::Active);
    assert_eq!(session.started_at, Some(1_800_000_000_080));
    assert_eq!(session.game.as_deref(), Some("fh6"));
    assert_eq!(session.vehicle_id.as_deref(), Some("123"));
}
#[test]
fn short_silence_and_inactive_frames_recover_the_same_session() {
    let live = live();
    lock(&live, 0, true);
    let id = live.snapshot_at(64).session.unwrap().id;
    let grace = live.snapshot_at(164);
    assert_eq!(grace.connection, C::Grace);
    assert_eq!(grace.health, Health::Degraded);
    assert_eq!(grace.session.unwrap().grace_remaining_ms, Some(500));
    send(&live, 663, true);
    let resumed = live.snapshot_at(663);
    assert_eq!(resumed.connection, C::SessionActive);
    assert_eq!(resumed.session.unwrap().id, id);
    send(&live, 680, false);
    assert_eq!(live.snapshot_at(680).session.unwrap().state, S::Grace);
    send(&live, 700, true);
    assert_eq!(live.snapshot_at(700).session.unwrap().id, id);
}
#[test]
fn grace_deadline_does_not_slide_and_expiry_selects_idle_or_disconnected() {
    let live = live();
    lock(&live, 0, true);
    let id = live.snapshot_at(64).session.unwrap().id;
    send(&live, 80, false);
    for at in [160, 240, 320, 400, 480, 560, 579] {
        send(&live, at, false);
    }
    let idle = live.snapshot_at(580);
    assert_eq!(idle.connection, C::ConnectedIdle);
    let completed = idle.session.unwrap();
    assert_eq!(completed.state, S::Completed);
    assert_eq!(completed.duration_ms, 516);
    send(&live, 596, true);
    assert_ne!(live.snapshot_at(596).session.unwrap().id, id);
    let final_state = live.snapshot_at(1196);
    assert_eq!(final_state.connection, C::Disconnected);
    assert_eq!(final_state.health, Health::Lost);
    assert!(final_state.protocol.is_none());
    assert_eq!(final_state.session.unwrap().state, S::Completed);
    lock(&live, 1200, true);
    assert_eq!(live.snapshot_at(1264).connection, C::SessionActive);
}
#[test]
fn vehicle_change_creates_a_new_session_and_unknown_vehicle_does_not_fake_zero_id() {
    let live = live();
    lock(&live, 0, true);
    let id = live.snapshot_at(64).session.unwrap().id;
    let mut p = packet(80, true);
    p[212..216].copy_from_slice(&456_i32.to_le_bytes());
    live.on_packet_at(
        &CapturedPacket {
            bytes: &p,
            source: source(),
            received_at_ms: 80,
            captured_at_us: 80_000,
        },
        80,
    );
    let next = live.snapshot_at(80).session.unwrap();
    assert_ne!(next.id, id);
    assert_eq!(next.vehicle_id.as_deref(), Some("456"));
    p[212..216].fill(0);
    assert!(fh6::decode(&p).unwrap().frame.vehicle_id.is_none());
}
#[test]
fn ring_subscriber_slots_and_slow_subscriber_memory_are_bounded() {
    let hub = Arc::new(TelemetryHub::new(8, "test".into(), 500, 100).unwrap());
    let subscriber = hub.subscribe(1).unwrap();
    let (done, finished) = std::sync::mpsc::channel();
    let writer = hub.clone();
    let producer = thread::spawn(move || {
        for n in 0..10_000 {
            writer.publish(TelemetryFrame::default(), n, None);
        }
        done.send(()).unwrap();
    });
    finished
        .recv_timeout(Duration::from_secs(3))
        .expect("slow subscriber blocked ingestion");
    producer.join().unwrap();
    let stats = hub.stats();
    assert_eq!(stats.published, 10_000);
    assert_eq!(stats.recent_frames, 8);
    assert_eq!(stats.ring_evictions, 9992);
    assert_eq!(stats.subscriber_drops, 9999);
    assert_eq!(subscriber.recv().unwrap().sequence, 1);
    assert_eq!(hub.latest().unwrap().sequence, 10_000);
    assert_eq!(hub.recent().first().unwrap().sequence, 9993);
    let mut subscribers = vec![subscriber];
    for _ in 1..16 {
        subscribers.push(hub.subscribe(1).unwrap());
    }
    assert!(hub.subscribe(1).is_err());
    assert!(hub.subscribe(0).is_err());
    assert!(hub.subscribe(4097).is_err());
    drop(subscribers);
    hub.publish(TelemetryFrame::default(), 10_001, None);
    assert_eq!(hub.stats().subscribers, 0);
}
#[test]
fn latest_value_ui_reads_skip_history_and_health_has_no_expected_hz_assumption() {
    let capture = Arc::new(Counter::default());
    let live = LiveTelemetrySink::with_config(
        capture.clone(),
        ConnectionConfig {
            silence_ms: 5000,
            ring_capacity: 16,
            ..Default::default()
        },
        "test".into(),
    )
    .unwrap();
    live.begin_start_at(0);
    live.listener_ready_at(0);
    lock(&live, 0, true);
    let first = live.snapshot_at(64);
    assert_eq!(first.health, Health::Good);
    live.on_packet_at(
        &CapturedPacket {
            bytes: &[0; 323],
            source: source(),
            received_at_ms: 80,
            captured_at_us: 80_000,
        },
        80,
    );
    assert_eq!(live.snapshot_at(80).connection, C::Degraded);
    for at in [96, 496, 896, 1296, 1696, 2096] {
        send(&live, at, true);
    }
    let latest = live.snapshot_at(2096);
    assert_eq!(latest.frame.unwrap().game_timestamp_ms, Some(2096));
    assert_eq!(latest.health, Health::Good);
    assert_eq!(latest.connection, C::SessionActive);
    assert!(latest.revision > first.revision);
    assert!(latest.input_packet_hz > 0.0);
    assert!(latest.valid_frame_hz > 0.0);
    assert_eq!(capture.0.load(Ordering::Relaxed), 12);
    assert_eq!(live.hub.latest().unwrap().sequence, 7); // first four packets are probes
    let subscriber = live.hub.subscribe(1).unwrap();
    send(&live, 2112, true);
    send(&live, 2128, true);
    assert_eq!(live.snapshot_at(2128).health, Health::Degraded);
    assert_eq!(live.snapshot_at(2128).hub.subscriber_drops, 1);
    drop(subscriber);
    live.stop_at(2144);
    assert_eq!(live.snapshot_at(2144).health, Health::Lost);
    assert!(live.snapshot_at(2144).frame.is_none());
}
#[test]
fn normalization_preserves_real_zero_and_rejects_invalid_configuration() {
    let mut p = packet(0, true);
    p[315] = 0;
    p[316] = 255;
    p[317] = 128;
    p[318] = 64;
    p[320] = 129;
    let f = fh6::decode(&p).unwrap().frame;
    assert_eq!(f.controls.throttle, Some(0.0));
    assert_eq!(f.controls.brake, Some(1.0));
    assert_eq!(f.controls.steering, Some(-1.0));
    assert_eq!(f.controls.clutch, Some(128.0 / 255.0));
    assert_eq!(f.controls.handbrake, Some(64.0 / 255.0));
    assert!(ConnectionConfig {
        grace_ms: 0,
        ..Default::default()
    }
    .validate()
    .is_err());
    assert!(ConnectionConfig {
        ring_capacity: 0,
        ..Default::default()
    }
    .validate()
    .is_err());
}

#[test]
fn inactive_probe_classification_is_not_a_protocol_lock_or_rejection() {
    let live = live();
    // Structurally valid inactive packets with no engine identity evidence.
    for at in 0..20 {
        live.on_packet_at(
            &CapturedPacket {
                bytes: &[0; 324],
                source: source(),
                received_at_ms: at,
                captured_at_us: at * 1000,
            },
            at,
        );
    }
    let s = live.snapshot_at(19);
    assert_eq!(s.valid_inactive_fh6, 20);
    assert_eq!(s.invalid_fh6, 0);
    assert_eq!(s.invalid_packets, 0);
    assert_eq!(s.unknown_protocol, 0);
    assert_eq!(s.protocol, None);
    assert_eq!(s.protocol_confidence, 0.0);
    assert_eq!(s.connection, C::Probing);
    assert!(s.issues.is_empty());
    assert!(s.session.is_none());
    assert_eq!(s.hub.published, 0);
    // Inactive probe clock discontinuities also mean insufficient evidence,
    // not invalid canonical dynamics. Five progressing frames still lock.
    let mut detector = ProtocolDetector::new(5).unwrap();
    for (at, ts) in [(0, 1000), (16, 0), (32, 1000), (48, 0)] {
        let result = detector.ingest(&packet(ts, false), source(), at);
        assert_eq!(result.classification, P::ValidInactiveFh6);
        assert!(result.issues.is_empty());
        assert!(result.frame.is_none());
    }
    lock(&live, 32, true);
    let s = live.snapshot_at(96);
    assert_eq!(s.valid_active_fh6, 5);
    assert_eq!(s.valid_inactive_fh6, 20);
    assert_eq!(s.protocol.as_deref(), Some("fh6"));
}

#[test]
fn menus_loading_clock_changes_do_not_reject_valid_inactive_or_extend_grace() {
    let live = live();
    lock(&live, 0, true);
    let id = live.snapshot_at(64).session.unwrap().id;
    // Use raw zero values and repeated regression/forward jumps. Inactive
    // canonical values are unavailable; these are not active physics failures.
    for (at, ts) in [(80, 0_u32), (160, 1_000_000), (240, 1), (320, 0)] {
        let mut bytes = [0; 324];
        bytes[4..8].copy_from_slice(&ts.to_le_bytes());
        live.on_packet_at(
            &CapturedPacket {
                bytes: &bytes,
                source: source(),
                received_at_ms: at,
                captured_at_us: at * 1000,
            },
            at,
        );
        let s = live.snapshot_at(at);
        assert_eq!(s.connection, C::Grace);
        assert_eq!(s.health, Health::Good);
        assert_eq!(s.protocol_confidence, 1.0);
        assert_eq!(s.invalid_fh6, 0);
        assert!(s.issues.is_empty());
        assert!(s.frame.unwrap().engine.rpm.is_none());
        assert_eq!(s.session.unwrap().id, id);
    }
    assert_eq!(live.snapshot_at(320).valid_inactive_fh6, 4);
    send(&live, 336, true);
    assert_eq!(live.snapshot_at(336).session.unwrap().id, id);
    send(&live, 352, false);
    for at in [432, 512, 592, 672, 752, 832] {
        send(&live, at, false);
    }
    let s = live.snapshot_at(852);
    assert_eq!(s.connection, C::ConnectedIdle);
    assert_eq!(s.session.unwrap().state, S::Completed);
    assert_eq!(s.invalid_fh6, 0);
    assert_eq!(s.valid_active_fh6, 6);
    assert_eq!(s.valid_inactive_fh6, 11);
}

#[test]
fn invalid_fh6_and_unknown_traffic_are_distinct_and_counters_reset_on_restart() {
    let capture = Arc::new(Counter::default());
    let live = LiveTelemetrySink::new(capture.clone());
    live.begin_start_at(0);
    let feed = |bytes: &[u8], from, at| {
        live.on_packet_at(
            &CapturedPacket {
                bytes,
                source: from,
                received_at_ms: at,
                captured_at_us: at * 1000,
            },
            at,
        );
    };
    feed(&[0xAA; 324], source(), 0);
    feed(b"unrelated UDP", source(), 1);
    lock(&live, 16, true);
    let confidence = live.snapshot_at(80).protocol_confidence;
    feed(&packet(96, true), "127.0.0.1:9999".parse().unwrap(), 96);
    assert_eq!(live.snapshot_at(96).protocol_confidence, confidence);
    assert_eq!(live.snapshot_at(96).health, Health::Good);
    assert!(live.snapshot_at(96).frame.unwrap().active);
    // Non-finite inactive values and invalid steering remain errors even in menus.
    let mut nonfinite = packet(112, false);
    nonfinite[16..20].copy_from_slice(&f32::NAN.to_le_bytes());
    feed(&nonfinite, source(), 112);
    let mut steering = packet(128, false);
    steering[320] = 128;
    feed(&steering, source(), 128);
    feed(&[0; 323], source(), 144);
    let mut bad_physics = packet(160, true);
    bad_physics[256..260].copy_from_slice(&10000_f32.to_le_bytes());
    feed(&bad_physics, source(), 160);
    let s = live.snapshot_at(160);
    assert_eq!(s.valid_active_fh6, 5);
    assert_eq!(s.valid_inactive_fh6, 0);
    assert_eq!(s.invalid_fh6, 4);
    assert_eq!(s.invalid_packets, s.invalid_fh6);
    assert_eq!(s.unknown_protocol, 3);
    assert_eq!(s.connection, C::Degraded);
    assert!(!s.issues.is_empty());
    assert_eq!(capture.0.load(Ordering::Relaxed), 12);
    assert_eq!(
        s.valid_active_fh6 + s.valid_inactive_fh6 + s.invalid_fh6 + s.unknown_protocol,
        12
    );
    feed(b"foreign", "127.0.0.1:9999".parse().unwrap(), 161);
    let foreign = live.snapshot_at(161);
    assert_eq!(foreign.unknown_protocol, 4);
    assert_eq!(foreign.issues, s.issues);
    assert!(foreign.frame.is_none());
    live.stop_at(162);
    live.begin_start_at(163);
    let s = live.snapshot_at(163);
    assert_eq!(
        s.valid_active_fh6 + s.valid_inactive_fh6 + s.invalid_fh6 + s.unknown_protocol,
        0
    );
}

// ------------------------------------------------- V0.6 automatic recording

fn recorder_root(name: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "racelab-v06-appliance-{}-{name}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    root
}

/// The real FH6 path: detection, classification and session lifecycle are
/// unchanged, and recording happens with no user action anywhere.
#[test]
fn real_fh6_telemetry_records_automatically_without_changing_classification() {
    use racelab_lib::{
        session_format::SessionStatus, session_recorder::SessionRecorder, session_store,
        telemetry_hub::SessionRecorderHook,
    };
    let root = recorder_root("fh6");
    let recorder = SessionRecorder::new(root.clone()).unwrap();
    let live = live();
    live.hub
        .attach_recorder(Arc::clone(&recorder) as Arc<dyn SessionRecorderHook>)
        .unwrap();
    lock(&live, 0, true);
    let snapshot = live.snapshot_at(80);
    assert_eq!(snapshot.protocol.as_deref(), Some("fh6"));
    assert_eq!(snapshot.connection, C::SessionActive);
    let id = snapshot.session.as_ref().unwrap().id.clone();
    assert_eq!(snapshot.session.as_ref().unwrap().state, S::Active);
    for n in 5..40 {
        send(&live, n * 16, true);
    }
    // Short menu interruption: same session, same recording.
    send(&live, 700, false);
    live.snapshot_at(750);
    assert_eq!(live.snapshot_at(760).session.unwrap().id, id);
    send(&live, 800, true);
    assert_eq!(live.snapshot_at(810).session.unwrap().state, S::Active);
    // Long menu: grace expires and the session completes.
    send(&live, 900, false);
    let after = live.snapshot_at(2000);
    assert_eq!(after.session.as_ref().unwrap().state, S::Completed);
    let until = Instant::now() + Duration::from_secs(10);
    while !session_store::get_session(&root, &id)
        .is_ok_and(|m| m.status != SessionStatus::Recording)
    {
        assert!(Instant::now() < until, "recorder never finalized {id}");
        thread::sleep(Duration::from_millis(5));
    }
    let manifest = session_store::get_session(&root, &id).unwrap();
    assert_eq!(manifest.status, SessionStatus::Completed);
    assert_eq!(manifest.session_id, id);
    assert_eq!(manifest.game.as_deref(), Some("fh6"));
    assert_eq!(manifest.vehicle_id.as_deref(), Some("123"));
    assert_eq!(manifest.recorder_dropped_frames, 0);
    assert!(manifest.active_frame_count > 0 && manifest.inactive_frame_count > 0);
    assert_eq!(
        manifest.frame_count,
        manifest.active_frame_count + manifest.inactive_frame_count
    );
    assert!(manifest.summary.is_some());
    // V0.5.1 classification is untouched by recording.
    assert_eq!(after.valid_active_fh6, 41);
    assert_eq!(after.valid_inactive_fh6, 2);
    assert_eq!(after.invalid_fh6, 0);
    assert_eq!(after.unknown_protocol, 0);
    assert_eq!(after.hub.subscriber_drops, 0);
    assert_eq!(
        session_store::list_recent_sessions(&root, None)
            .sessions
            .len(),
        1
    );
    recorder.shutdown();
}
