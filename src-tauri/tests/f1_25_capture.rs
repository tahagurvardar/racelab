//! F1 25 Phase B: the development fixture capture path and its hard bounds.
mod scratch;

use racelab_lib::{
    adapters::f1_25::{parse_header, PacketKind},
    f1_capture::{
        validate_label, FixtureCapture, MAX_PACKET_AGE_MS, MAX_SNAPSHOTS_PER_RUN,
        MAX_SNAPSHOT_DIRECTORIES,
    },
    f1_evidence::F1EvidenceService,
    f1_live::{RawLatest, FAMILIES},
    ingress::LISTEN_ADDRESS,
};
use scratch::Scratch;
use std::{fs, net::UdpSocket, thread, time::Duration};

/// A header-valid datagram of the exact size; the payload is irrelevant to
/// capture, which writes bytes verbatim.
fn datagram(kind: PacketKind, uid: u64, player: u8) -> Vec<u8> {
    let mut b = vec![0u8; kind.expected_size()];
    b[0..2].copy_from_slice(&2025u16.to_le_bytes());
    b[2] = 25;
    b[5] = 1;
    b[6] = kind.id();
    b[7..15].copy_from_slice(&uid.to_le_bytes());
    b[27] = player;
    b[28] = 255;
    for (i, byte) in b.iter_mut().enumerate().skip(29) {
        *byte = (i % 251) as u8;
    }
    b
}

fn raw(kind: PacketKind, age_ms: u64) -> RawLatest {
    let bytes = datagram(kind, 7, 0);
    RawLatest {
        kind,
        header: parse_header(&bytes).unwrap(),
        bytes,
        age_ms,
    }
}

fn full_set() -> Vec<RawLatest> {
    FAMILIES.iter().map(|&k| raw(k, 10)).collect()
}

fn snapshots(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    fs::read_dir(dir)
        .map(|it| it.filter_map(Result::ok).map(|e| e.path()).collect())
        .unwrap_or_default()
}

#[test]
fn labels_cannot_name_a_path() {
    for good in ["stationary", "high-speed", "braking-2"] {
        assert!(validate_label(good).is_ok(), "{good}");
    }
    for bad in [
        "",
        "-x",
        "../x",
        "a/b",
        "a\\b",
        "Braking",
        "a b",
        "x.bin",
        &"a".repeat(33),
    ] {
        assert!(validate_label(bad).is_err(), "{bad}");
    }
}

#[test]
fn one_snapshot_is_exactly_four_verbatim_files_and_a_manifest() {
    let dir = Scratch::new("f1-capture-ok");
    let capture = FixtureCapture::new(dir.join("fixtures"));
    let packets = full_set();
    let manifest = capture.write("driving", packets.clone(), 1_000).unwrap();
    let target = dir.join("fixtures").join("1000-driving");
    assert_eq!(manifest.directory, target.display().to_string());
    let mut files: Vec<String> = fs::read_dir(&target)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    files.sort();
    assert_eq!(
        files,
        [
            "id02-lap-data.bin",
            "id06-car-telemetry.bin",
            "id07-car-status.bin",
            "id13-motion-ex.bin",
            "manifest.json"
        ]
    );
    for packet in &packets {
        let entry = manifest
            .packets
            .iter()
            .find(|p| p.packet_id == packet.kind.id())
            .unwrap();
        assert_eq!(fs::read(target.join(&entry.file)).unwrap(), packet.bytes);
        assert_eq!(entry.size, packet.kind.expected_size());
    }
    // No partial directory is left behind.
    assert_eq!(snapshots(&dir.join("fixtures")).len(), 1);
    let status = capture.status();
    assert_eq!(status.snapshots_taken, 1);
    assert_eq!(status.last.unwrap().label, "driving");
}

#[test]
fn incomplete_stale_or_mixed_sets_write_nothing() {
    let dir = Scratch::new("f1-capture-refuse");
    let out = dir.join("fixtures");
    let capture = FixtureCapture::new(out.clone());

    let mut missing = full_set();
    missing.retain(|p| p.kind != PacketKind::MotionEx);
    let error = capture.write("x", missing, 1).unwrap_err();
    assert!(error.contains("Motion Ex"), "{error}");

    let mut stale = full_set();
    stale[1].age_ms = MAX_PACKET_AGE_MS + 1;
    assert!(capture.write("x", stale, 2).unwrap_err().contains("old"));

    let mut mixed = full_set();
    let bytes = datagram(PacketKind::LapData, 8, 0);
    mixed[2] = RawLatest {
        kind: PacketKind::LapData,
        header: parse_header(&bytes).unwrap(),
        bytes,
        age_ms: 0,
    };
    assert!(capture.write("x", mixed, 3).is_err());

    assert!(capture.write("../escape", full_set(), 4).is_err());
    assert!(snapshots(&out).is_empty());
    assert_eq!(capture.status().snapshots_taken, 0);
    assert!(capture.status().last_error.is_some());
}

#[test]
fn snapshots_per_run_are_capped() {
    let dir = Scratch::new("f1-capture-run-cap");
    let capture = FixtureCapture::new(dir.join("fixtures"));
    for i in 0..MAX_SNAPSHOTS_PER_RUN {
        capture
            .write("s", full_set(), u64::from(i))
            .unwrap_or_else(|e| panic!("{i}: {e}"));
    }
    let error = capture.write("s", full_set(), 999).unwrap_err();
    assert!(error.contains("already captured"), "{error}");
    assert_eq!(
        snapshots(&dir.join("fixtures")).len(),
        MAX_SNAPSHOTS_PER_RUN as usize
    );
}

#[test]
fn the_capture_directory_is_capped_across_runs() {
    let dir = Scratch::new("f1-capture-dir-cap");
    let out = dir.join("fixtures");
    for i in 0..MAX_SNAPSHOT_DIRECTORIES {
        fs::create_dir_all(out.join(format!("old-{i}"))).unwrap();
    }
    let capture = FixtureCapture::new(out.clone());
    let error = capture.write("s", full_set(), 1).unwrap_err();
    assert!(error.contains("limit"), "{error}");
    assert_eq!(snapshots(&out).len(), MAX_SNAPSHOT_DIRECTORIES);
}

#[test]
fn service_refuses_capture_unless_enabled() {
    let service = F1EvidenceService::new(true, 0);
    assert!(!service.capture_enabled());
    assert!(service.capture_fixtures("x", 0).is_err());
    assert!(service.status().capture.is_none());
}

#[test]
fn service_captures_the_latest_live_packets_over_udp() {
    let dir = Scratch::new("f1-capture-live");
    let service = F1EvidenceService::new(true, 0).with_capture(dir.join("fixtures"));
    service.start().unwrap();
    let port = service.status().bound_port.unwrap();
    let sender = UdpSocket::bind((LISTEN_ADDRESS, 0)).unwrap();
    // Before every family has arrived, capture refuses.
    sender
        .send_to(
            &datagram(PacketKind::CarTelemetry, 9, 3),
            (LISTEN_ADDRESS, port),
        )
        .unwrap();
    thread::sleep(Duration::from_millis(100));
    assert!(service.capture_fixtures("early", 0).is_err());
    for kind in FAMILIES {
        sender
            .send_to(&datagram(kind, 9, 3), (LISTEN_ADDRESS, port))
            .unwrap();
    }
    thread::sleep(Duration::from_millis(100));
    assert!(service.capture_fixtures("x", 15_001).is_err());
    let manifest = service.capture_fixtures("stationary", 0).unwrap();
    assert_eq!(manifest.packets.len(), 4);
    assert!(manifest.packets.iter().all(|p| p.player_car_index == 3));
    let status = service.status();
    let json = serde_json::to_string(&status).unwrap();
    // The UI gets the manifest, never bytes.
    assert!(!json.contains("\"bytes\""), "{json}");
    assert_eq!(status.capture.unwrap().snapshots_taken, 1);
    service.stop().unwrap();
}
