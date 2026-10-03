//! F1 25 Phase A: header parsing, packet classification and the evidence
//! listener. Fixtures are built from the specification's packed little-endian
//! `PacketHeader` with the verified datagram sizes; every payload byte after
//! the header is zero, because nothing past the header is interpreted.
use racelab_lib::{
    adapters::f1_25::{
        self, classify, offset, parse_header, Classification, PacketKind, Rejection, SizeEvidence,
    },
    appliance::Appliance,
    f1_evidence::{F1Evidence, F1EvidenceService},
    ingress::LISTEN_ADDRESS,
    live_telemetry::ConnectionConfig,
    packet::{CapturedPacket, PacketSink},
};
use std::{
    net::UdpSocket,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

/// Sizes observed live from the user's F1 25 (UDP Format 2025, 20 Hz).
const OBSERVED_LIVE: [(u8, usize); 11] = [
    (0, 1349),
    (1, 753),
    (2, 1285),
    (3, 45),
    (5, 1133),
    (6, 1352),
    (7, 1239),
    (10, 1041),
    (11, 1460),
    (12, 231),
    (13, 273),
];

/// Sizes stated by "Data Output from F1 25 Game" v3 for every packet ID.
const SPECIFICATION: [(u8, &str, usize); 16] = [
    (0, "Motion", 1349),
    (1, "Session", 753),
    (2, "Lap Data", 1285),
    (3, "Event", 45),
    (4, "Participants", 1284),
    (5, "Car Setups", 1133),
    (6, "Car Telemetry", 1352),
    (7, "Car Status", 1239),
    (8, "Final Classification", 1042),
    (9, "Lobby Info", 954),
    (10, "Car Damage", 1041),
    (11, "Session History", 1460),
    (12, "Tyre Sets", 231),
    (13, "Motion Ex", 273),
    (14, "Time Trial", 101),
    (15, "Lap Positions", 1131),
];

struct Header {
    packet_format: u16,
    game_year: u8,
    major: u8,
    minor: u8,
    packet_version: u8,
    packet_id: u8,
    session_uid: u64,
    session_time: f32,
    frame: u32,
    overall_frame: u32,
    player: u8,
    secondary: u8,
}

impl Header {
    fn new(packet_id: u8) -> Self {
        Self {
            packet_format: 2025,
            game_year: 25,
            major: 1,
            minor: 9,
            packet_version: 1,
            packet_id,
            session_uid: 0x8000_0000_0000_0001,
            session_time: 12.5,
            frame: 250,
            overall_frame: 260,
            player: 0,
            secondary: 255,
        }
    }

    /// Writes the 29-byte header field by field, in specification order,
    /// independently of the parser's own offset table.
    fn datagram(&self, size: usize) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(size.max(29));
        bytes.extend_from_slice(&self.packet_format.to_le_bytes());
        bytes.push(self.game_year);
        bytes.push(self.major);
        bytes.push(self.minor);
        bytes.push(self.packet_version);
        bytes.push(self.packet_id);
        bytes.extend_from_slice(&self.session_uid.to_le_bytes());
        bytes.extend_from_slice(&self.session_time.to_le_bytes());
        bytes.extend_from_slice(&self.frame.to_le_bytes());
        bytes.extend_from_slice(&self.overall_frame.to_le_bytes());
        bytes.push(self.player);
        bytes.push(self.secondary);
        assert_eq!(bytes.len(), 29);
        bytes.resize(size, 0);
        bytes
    }
}

fn valid(id: u8) -> Vec<u8> {
    Header::new(id).datagram(PacketKind::from_id(id).unwrap().expected_size())
}

fn rejection(bytes: &[u8]) -> Rejection {
    match classify(bytes) {
        Classification::Rejected { rejection, .. } => rejection,
        accepted => panic!("expected a rejection, got {accepted:?}"),
    }
}

// ------------------------------------------------------------------ header

#[test]
fn header_layout_matches_the_specification() {
    assert_eq!(f1_25::HEADER_SIZE, 29);
    assert_eq!(offset::PACKET_FORMAT, 0);
    assert_eq!(offset::GAME_YEAR, 2);
    assert_eq!(offset::GAME_MAJOR_VERSION, 3);
    assert_eq!(offset::GAME_MINOR_VERSION, 4);
    assert_eq!(offset::PACKET_VERSION, 5);
    assert_eq!(offset::PACKET_ID, 6);
    assert_eq!(offset::SESSION_UID, 7);
    assert_eq!(offset::SESSION_TIME, 15);
    assert_eq!(offset::FRAME_IDENTIFIER, 19);
    assert_eq!(offset::OVERALL_FRAME_IDENTIFIER, 23);
    assert_eq!(offset::PLAYER_CAR_INDEX, 27);
    assert_eq!(offset::SECONDARY_PLAYER_CAR_INDEX, 28);
}

#[test]
fn valid_2025_header_parses_every_field_little_endian() {
    let mut header = Header::new(6);
    header.major = 1;
    header.minor = 17;
    header.frame = 0x0102_0304;
    header.overall_frame = 0xA1B2_C3D4;
    let bytes = header.datagram(1352);
    // Little endian on the wire, independently of the parser.
    assert_eq!(&bytes[0..2], &[0xE9, 0x07]);
    assert_eq!(&bytes[19..23], &[0x04, 0x03, 0x02, 0x01]);
    let parsed = parse_header(&bytes).unwrap();
    assert_eq!(parsed.packet_format, 2025);
    assert_eq!(parsed.game_year, 25);
    assert_eq!(parsed.game_major_version, 1);
    assert_eq!(parsed.game_minor_version, 17);
    assert_eq!(parsed.packet_version, 1);
    assert_eq!(parsed.packet_id, 6);
    assert_eq!(parsed.session_time, 12.5);
    assert_eq!(parsed.frame_identifier, 0x0102_0304);
    assert_eq!(parsed.overall_frame_identifier, 0xA1B2_C3D4);
    assert_eq!(parsed.secondary_player_car_index, 255);
    assert!(matches!(
        classify(&bytes),
        Classification::Accepted {
            kind: PacketKind::CarTelemetry,
            ..
        }
    ));
}

#[test]
fn session_uid_is_a_full_u64() {
    for uid in [0, 1, 0x0123_4567_89AB_CDEF, u64::MAX, (1 << 53) + 1] {
        let mut header = Header::new(1);
        header.session_uid = uid;
        let parsed = parse_header(&header.datagram(753)).unwrap();
        assert_eq!(parsed.session_uid, uid);
    }
    // Precision above 2^53 survives to diagnostics as a decimal string.
    let mut evidence = F1Evidence::new(Instant::now());
    let mut header = Header::new(1);
    header.session_uid = (1 << 53) + 1;
    evidence.observe(&header.datagram(753), Instant::now(), 0);
    let shown = evidence.snapshot(Instant::now()).header.unwrap();
    assert_eq!(shown.session_uid, "9007199254740993");
}

#[test]
fn player_car_indices_are_parsed() {
    for (player, secondary) in [(0, 255), (19, 255), (21, 3), (255, 255)] {
        let mut header = Header::new(2);
        header.player = player;
        header.secondary = secondary;
        let parsed = parse_header(&header.datagram(1285)).unwrap();
        assert_eq!(parsed.player_car_index, player);
        assert_eq!(parsed.secondary_player_car_index, secondary);
    }
}

#[test]
fn truncated_headers_are_malformed_at_every_length() {
    let full = valid(0);
    for length in 0..29 {
        assert!(parse_header(&full[..length]).is_none());
        assert_eq!(
            rejection(&full[..length]),
            Rejection::Truncated { size: length }
        );
    }
    // Exactly a header parses, but no F1 25 packet is header-only.
    let header_only = &full[..29];
    assert!(parse_header(header_only).is_some());
    assert_eq!(
        rejection(header_only),
        Rejection::SizeMismatch {
            kind: PacketKind::Motion,
            expected: 1349,
            observed: 29
        }
    );
}

#[test]
fn wrong_packet_format_is_rejected_including_older_f1_formats() {
    for format in [2024, 2023, 0, 2026, u16::MAX] {
        let mut header = Header::new(0);
        header.packet_format = format;
        assert_eq!(
            rejection(&header.datagram(1349)),
            Rejection::WrongPacketFormat { found: format }
        );
    }
}

#[test]
fn wrong_game_year_is_rejected() {
    for year in [24, 26, 0, 255] {
        let mut header = Header::new(0);
        header.game_year = year;
        assert_eq!(
            rejection(&header.datagram(1349)),
            Rejection::WrongGameYear { found: year }
        );
    }
}

#[test]
fn unsupported_packet_version_is_rejected_for_every_kind() {
    for kind in PacketKind::ALL {
        for version in [0, 2, 255] {
            let mut header = Header::new(kind.id());
            header.packet_version = version;
            assert_eq!(
                rejection(&header.datagram(kind.expected_size())),
                Rejection::UnsupportedPacketVersion {
                    kind,
                    found: version
                }
            );
        }
    }
}

#[test]
fn unknown_packet_ids_are_rejected() {
    for id in 16..=255u8 {
        assert_eq!(
            rejection(&Header::new(id).datagram(1349)),
            Rejection::UnknownPacketId { found: id }
        );
    }
}

// ----------------------------------------------------------- classification

#[test]
fn every_packet_id_classifies_by_official_name_and_size() {
    for (id, name, size) in SPECIFICATION {
        let kind = PacketKind::from_id(id).unwrap();
        assert_eq!(kind.id(), id);
        assert_eq!(kind.name(), name);
        assert_eq!(kind.expected_size(), size);
        match classify(&valid(id)) {
            Classification::Accepted {
                kind: classified,
                header,
            } => {
                assert_eq!(classified, kind);
                assert_eq!(header.packet_id, id);
            }
            rejected => panic!("ID {id} rejected: {rejected:?}"),
        }
    }
    assert_eq!(PacketKind::from_id(16), None);
}

#[test]
fn verified_live_sizes_are_accepted_and_labelled_as_live() {
    for (id, size) in OBSERVED_LIVE {
        let kind = PacketKind::from_id(id).unwrap();
        assert_eq!(kind.expected_size(), size, "ID {id}");
        assert_eq!(kind.size_evidence(), SizeEvidence::SpecAndLive, "ID {id}");
        assert!(matches!(
            classify(&Header::new(id).datagram(size)),
            Classification::Accepted { .. }
        ));
    }
    // Everything not observed live must say so.
    let live: Vec<u8> = OBSERVED_LIVE.iter().map(|(id, _)| *id).collect();
    for kind in PacketKind::ALL {
        if !live.contains(&kind.id()) {
            assert_eq!(kind.size_evidence(), SizeEvidence::SpecOnly, "{kind:?}");
        }
    }
}

#[test]
fn size_mismatch_is_rejected_one_byte_either_side() {
    for kind in PacketKind::ALL {
        let expected = kind.expected_size();
        for observed in [expected - 1, expected + 1] {
            assert_eq!(
                rejection(&Header::new(kind.id()).datagram(observed)),
                Rejection::SizeMismatch {
                    kind,
                    expected,
                    observed
                }
            );
        }
    }
    // The F1 24 Participants size, sent with a 2025 header.
    assert_eq!(
        rejection(&Header::new(4).datagram(1350)),
        Rejection::SizeMismatch {
            kind: PacketKind::Participants,
            expected: 1284,
            observed: 1350
        }
    );
}

#[test]
fn an_fh6_datagram_is_never_an_f1_packet() {
    let bytes = vec![0u8; 324];
    assert_eq!(rejection(&bytes), Rejection::WrongPacketFormat { found: 0 });
}

// ---------------------------------------------------------------- evidence

#[test]
fn evidence_counts_by_kind_and_rejection_reason() {
    let now = Instant::now();
    let mut evidence = F1Evidence::new(now);
    for (id, size) in OBSERVED_LIVE {
        evidence.observe(&Header::new(id).datagram(size), now, 1_000);
    }
    evidence.observe(&valid(6), now, 2_000);
    evidence.observe(&[0; 10], now, 0);
    let mut old = Header::new(6);
    old.packet_format = 2024;
    evidence.observe(&old.datagram(1352), now, 0);
    let mut year = Header::new(6);
    year.game_year = 24;
    evidence.observe(&year.datagram(1352), now, 0);
    evidence.observe(&Header::new(99).datagram(64), now, 0);
    let mut version = Header::new(6);
    version.packet_version = 2;
    evidence.observe(&version.datagram(1352), now, 0);
    evidence.observe(&Header::new(6).datagram(1351), now, 0);

    let snapshot = evidence.snapshot(now);
    assert!(snapshot.detected);
    assert_eq!(snapshot.datagrams, 18);
    assert_eq!(snapshot.accepted, 12);
    assert_eq!(snapshot.truncated, 1);
    assert_eq!(snapshot.wrong_packet_format, 1);
    assert_eq!(snapshot.wrong_game_year, 1);
    assert_eq!(snapshot.unknown_packet_id, 1);
    assert_eq!(snapshot.unsupported_version, 1);
    assert_eq!(snapshot.size_mismatch, 1);
    assert_eq!(
        snapshot.last_rejection,
        Some(Rejection::SizeMismatch {
            kind: PacketKind::CarTelemetry,
            expected: 1352,
            observed: 1351
        })
    );
    let telemetry = &snapshot.kinds[6];
    assert_eq!(telemetry.name, "Car Telemetry");
    assert_eq!(telemetry.accepted, 2);
    assert_eq!(telemetry.accepted_bytes, 2 * 1352);
    assert_eq!(telemetry.size_mismatches, 1);
    assert_eq!(telemetry.unsupported_versions, 1);
    assert_eq!(telemetry.last_observed_size, Some(1351));
    assert_eq!(telemetry.last_accepted_unix_ms, Some(2_000));
    assert_eq!(snapshot.kinds[4].accepted, 0);
    assert_eq!(snapshot.kinds[4].last_observed_size, None);
    // Current header comes from the latest accepted packet only.
    let header = snapshot.header.unwrap();
    assert_eq!(header.packet_id, 6);
    assert_eq!(header.packet_format, 2025);
}

#[test]
fn rejected_datagrams_never_replace_the_current_header() {
    let now = Instant::now();
    let mut evidence = F1Evidence::new(now);
    let mut good = Header::new(0);
    good.player = 7;
    good.session_uid = 42;
    evidence.observe(&good.datagram(1349), now, 0);
    let mut bad = Header::new(0);
    bad.player = 3;
    bad.session_uid = 43;
    evidence.observe(&bad.datagram(1000), now, 0);
    bad.packet_format = 2024;
    evidence.observe(&bad.datagram(1349), now, 0);
    let snapshot = evidence.snapshot(now);
    let header = snapshot.header.unwrap();
    assert_eq!(header.player_car_index, 7);
    assert_eq!(header.session_uid, "42");
    assert_eq!(snapshot.session_uid_changes, 0);

    let mut next = Header::new(1);
    next.session_uid = 43;
    evidence.observe(&next.datagram(753), now, 0);
    assert_eq!(evidence.snapshot(now).session_uid_changes, 1);
}

#[test]
fn evidence_stays_bounded_under_hostile_traffic() {
    let now = Instant::now();
    let mut evidence = F1Evidence::new(now);
    let baseline = std::mem::size_of_val(&evidence);
    // Every unknown ID at many sizes, and every known ID at every wrong size
    // up to its expected one: tens of thousands of distinct datagrams.
    for id in 16..=255u8 {
        for size in [29, 64, 1349, 2000] {
            evidence.observe(&Header::new(id).datagram(size), now, 0);
        }
    }
    for kind in PacketKind::ALL {
        for size in 0..kind.expected_size() + 64 {
            evidence.observe(&Header::new(kind.id()).datagram(size), now, 0);
        }
    }
    let snapshot = evidence.snapshot(now);
    assert_eq!(snapshot.kinds.len(), 16);
    assert_eq!(snapshot.unknown_packet_id, 240 * 4);
    assert_eq!(snapshot.accepted, 16);
    assert_eq!(std::mem::size_of_val(&evidence), baseline);
    // The diagnostics document is the same size whatever arrived.
    let serialized = serde_json::to_string(&snapshot).unwrap();
    assert!(serialized.len() < 8 * 1024, "{} bytes", serialized.len());
}

// ------------------------------------------------------- live UDP listener

fn wait_for<T>(mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(Instant::now() < deadline, "timed out");
        thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn service_receives_classifies_and_exposes_no_payload() {
    let service = F1EvidenceService::new(true, 0);
    service.start().unwrap();
    let status = service.status();
    assert!(status.enabled && status.listening);
    let port = status.bound_port.unwrap();
    let sender = UdpSocket::bind((LISTEN_ADDRESS, 0)).unwrap();
    for (id, size) in OBSERVED_LIVE {
        // A distinctive payload byte that must never reach diagnostics.
        let mut bytes = Header::new(id).datagram(size);
        bytes[29..].fill(0xAB);
        sender.send_to(&bytes, (LISTEN_ADDRESS, port)).unwrap();
    }
    sender.send_to(&[1, 2, 3], (LISTEN_ADDRESS, port)).unwrap();
    let status = wait_for(|| {
        let status = service.status();
        (status.evidence.datagrams == 12).then_some(status)
    });
    assert_eq!(status.transport_datagrams, 12);
    assert_eq!(status.evidence.accepted, 11);
    assert_eq!(status.evidence.truncated, 1);
    assert!(status.evidence.detected);
    let json = serde_json::to_string(&status).unwrap();
    assert!(!json.contains("preview"), "{json}");
    assert!(!json.to_ascii_lowercase().contains("abab"), "{json}");
    assert!(!json.contains("171,171"), "{json}");

    // Restart starts a fresh evidence session.
    service.stop().unwrap();
    assert!(!service.status().listening);
    service.start().unwrap();
    assert_eq!(service.status().evidence.datagrams, 0);
    service.stop().unwrap();
}

#[test]
fn disabled_service_binds_nothing() {
    let service = F1EvidenceService::new(false, 0);
    service.start().unwrap();
    let status = service.status();
    assert!(!status.enabled);
    assert!(!status.listening);
    assert_eq!(status.bound_port, None);
}

#[test]
fn bind_conflict_is_reported_not_fatal() {
    let occupied = UdpSocket::bind((LISTEN_ADDRESS, 0)).unwrap();
    let service = F1EvidenceService::new(true, occupied.local_addr().unwrap().port());
    assert!(service.start().is_err());
    let status = service.status();
    assert!(!status.listening);
    assert!(status
        .listener_error
        .unwrap()
        .contains("Could not open UDP port"));
}

#[derive(Default)]
struct Counter(AtomicU64);
impl PacketSink for Counter {
    fn on_packet(&self, _: &CapturedPacket<'_>) {
        self.0.fetch_add(1, Ordering::Relaxed);
    }
}

/// FH6 and F1 run side by side on separate sockets. Traffic to one is never
/// seen by the other, and F1 traffic never reaches FH6 detection or capture.
#[test]
fn fh6_and_f1_listeners_are_independent() {
    let capture = Arc::new(Counter::default());
    let fh6 = Appliance::new(capture.clone(), ConnectionConfig::default(), 0).unwrap();
    let fh6_port = fh6.start(0).unwrap().bound_port.unwrap();
    let f1 = F1EvidenceService::new(true, 0);
    f1.start().unwrap();
    let f1_port = f1.status().bound_port.unwrap();
    assert_ne!(fh6_port, f1_port);

    let sender = UdpSocket::bind((LISTEN_ADDRESS, 0)).unwrap();
    for _ in 0..20 {
        sender
            .send_to(&valid(6), (LISTEN_ADDRESS, f1_port))
            .unwrap();
    }
    for _ in 0..5 {
        sender
            .send_to(&[0u8; 324], (LISTEN_ADDRESS, fh6_port))
            .unwrap();
    }
    wait_for(|| (f1.status().evidence.datagrams == 20).then_some(()));
    wait_for(|| (fh6.listener.snapshot().total_packets == 5).then_some(()));
    thread::sleep(Duration::from_millis(50));
    assert_eq!(f1.status().evidence.datagrams, 20);
    assert_eq!(f1.status().evidence.accepted, 20);
    assert_eq!(fh6.listener.snapshot().total_packets, 5);
    assert_eq!(capture.0.load(Ordering::Relaxed), 5);
    assert!(!fh6.live.protocol_detected());

    // Stopping F1 leaves FH6 listening, and the reverse.
    f1.stop().unwrap();
    assert!(fh6.listener.snapshot().running);
    f1.start().unwrap();
    fh6.stop().unwrap();
    assert!(f1.status().listening);
    f1.stop().unwrap();
}
