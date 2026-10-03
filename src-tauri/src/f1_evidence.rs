//! F1 25 evidence: a second loopback listener whose only consumer counts
//! what arrives (Phase A) and keeps the latest player packets for decoding
//! (Phase B, `f1_live`). Nothing here records a session, builds a
//! `TelemetryFrame` or reaches the FH6 pipeline.
//!
//! Bounded by construction: one fixed slot per packet ID 0..=15, scalar
//! counters for everything else (an unknown ID, however many distinct values
//! arrive, increments one counter), one copy of the latest accepted header,
//! and four fixed datagram slots in `F1Live`. Raw bytes leave this module
//! only through the development fixture capture, never to the UI.
use crate::{
    adapters::f1_25::{self, Classification, PacketHeader, PacketKind, Rejection, SizeEvidence},
    f1_capture::{self, CaptureManifest, CaptureStatus, FixtureCapture},
    f1_live::{F1Live, F1LiveSnapshot, RawLatest, RecordingView},
    ingress::{Listener, ReceiveBuffer},
    packet::{CapturedPacket, PacketSink},
};
use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

/// F1 25 is "detected" while an accepted packet arrived this recently. At the
/// 20 Hz rate configured in-game, that is forty missed packets.
pub const DETECTION_WINDOW: Duration = Duration::from_secs(2);
const RATE_WINDOW: Duration = Duration::from_secs(1);
/// `1`/`true` enables F1 25 support (listener, Live and recording), `0`/
/// `false` disables it. Unset, it follows `F1_ENABLED_IN_RELEASE` in a
/// release build and is on in a debug build, so an installed build does not
/// claim port 20777 from another F1 tool the user already runs.
pub const ENABLE_ENV: &str = "RACELAB_F1_EVIDENCE";
/// **The F1 25 release switch.** The one place that decides whether a release
/// build supports F1 25 by default. Phase D ships recording behind it; the
/// release stage decides when it flips. Recording has no switch of its own:
/// it runs exactly when the F1 25 listener does.
pub const F1_ENABLED_IN_RELEASE: bool = false;

/// Whether this build supports F1 25 when `RACELAB_F1_EVIDENCE` is unset.
pub const fn enabled_by_default() -> bool {
    cfg!(debug_assertions) || F1_ENABLED_IN_RELEASE
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

#[derive(Debug, Default, Clone, Copy)]
struct KindCounters {
    accepted: u64,
    accepted_bytes: u64,
    size_mismatches: u64,
    unsupported_versions: u64,
    /// Size of the latest datagram attributed to this ID, accepted or not.
    last_observed_size: Option<usize>,
    last_accepted_unix_ms: Option<u64>,
    window: u64,
    rate_hz: f64,
}

/// Evidence state. Pure: the caller supplies the clock, so tests drive time.
#[derive(Debug)]
pub struct F1Evidence {
    kinds: [KindCounters; 16],
    datagrams: u64,
    accepted: u64,
    truncated: u64,
    wrong_packet_format: u64,
    wrong_game_year: u64,
    unknown_packet_id: u64,
    unsupported_version: u64,
    size_mismatch: u64,
    last_rejection: Option<Rejection>,
    /// Only ever taken from an accepted packet.
    current: Option<PacketHeader>,
    session_uid_changes: u64,
    last_accepted_at: Option<Instant>,
    last_accepted_unix_ms: Option<u64>,
    rate_since: Instant,
    live: F1Live,
}

/// The header as shown to diagnostics. `session_uid` is a decimal string
/// because a `uint64` does not survive a JavaScript number.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct HeaderView {
    pub packet_format: u16,
    pub game_year: u8,
    pub game_major_version: u8,
    pub game_minor_version: u8,
    pub packet_version: u8,
    pub packet_id: u8,
    pub session_uid: String,
    pub session_time: f32,
    pub frame_identifier: u32,
    pub overall_frame_identifier: u32,
    pub player_car_index: u8,
    pub secondary_player_car_index: u8,
}

impl From<PacketHeader> for HeaderView {
    fn from(h: PacketHeader) -> Self {
        Self {
            packet_format: h.packet_format,
            game_year: h.game_year,
            game_major_version: h.game_major_version,
            game_minor_version: h.game_minor_version,
            packet_version: h.packet_version,
            packet_id: h.packet_id,
            session_uid: h.session_uid.to_string(),
            session_time: h.session_time,
            frame_identifier: h.frame_identifier,
            overall_frame_identifier: h.overall_frame_identifier,
            player_car_index: h.player_car_index,
            secondary_player_car_index: h.secondary_player_car_index,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct KindSnapshot {
    pub id: u8,
    pub kind: PacketKind,
    pub name: &'static str,
    pub expected_size: usize,
    pub size_evidence: SizeEvidence,
    pub accepted: u64,
    pub accepted_bytes: u64,
    /// Accepted packets per second over the last completed one-second window.
    pub rate_hz: f64,
    pub size_mismatches: u64,
    pub unsupported_versions: u64,
    pub last_observed_size: Option<usize>,
    pub last_accepted_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct F1EvidenceSnapshot {
    pub detected: bool,
    pub last_accepted_age_ms: Option<u64>,
    pub last_accepted_unix_ms: Option<u64>,
    /// The latest accepted header. Never taken from a rejected datagram.
    pub header: Option<HeaderView>,
    pub session_uid_changes: u64,
    pub datagrams: u64,
    pub accepted: u64,
    pub truncated: u64,
    pub wrong_packet_format: u64,
    pub wrong_game_year: u64,
    pub unknown_packet_id: u64,
    pub unsupported_version: u64,
    pub size_mismatch: u64,
    pub last_rejection: Option<Rejection>,
    /// Always sixteen entries, in packet-ID order.
    pub kinds: Vec<KindSnapshot>,
}

impl F1Evidence {
    pub fn new(now: Instant) -> Self {
        Self {
            kinds: [KindCounters::default(); 16],
            datagrams: 0,
            accepted: 0,
            truncated: 0,
            wrong_packet_format: 0,
            wrong_game_year: 0,
            unknown_packet_id: 0,
            unsupported_version: 0,
            size_mismatch: 0,
            last_rejection: None,
            current: None,
            session_uid_changes: 0,
            last_accepted_at: None,
            last_accepted_unix_ms: None,
            rate_since: now,
            live: F1Live::default(),
        }
    }

    pub fn live(&self, now: Instant) -> F1LiveSnapshot {
        self.live.snapshot(now)
    }

    /// Age of the latest accepted datagram of any packet type, or `None`.
    pub fn last_accepted_age_ms(&self, now: Instant) -> Option<u64> {
        self.last_accepted_at
            .map(|at| now.saturating_duration_since(at).as_millis() as u64)
    }

    pub fn raw_latest(&self, now: Instant) -> Vec<RawLatest> {
        self.live.raw_latest(now)
    }

    /// The recorder's read, with the age of the latest accepted datagram of
    /// any type.
    pub fn recording_view(&self, now: Instant, cursor: u64) -> (Option<u64>, RecordingView) {
        (
            self.last_accepted_age_ms(now),
            self.live.recording_view(now, cursor),
        )
    }

    // Same one-second monotonic windows as the transport's own rate, shared by
    // all sixteen IDs, advanced by both arrivals and snapshots.
    fn refresh_rates(&mut self, now: Instant) {
        let elapsed = now.saturating_duration_since(self.rate_since);
        if elapsed >= RATE_WINDOW {
            let seconds = elapsed.as_secs_f64();
            for kind in &mut self.kinds {
                kind.rate_hz = kind.window as f64 / seconds;
                kind.window = 0;
            }
            self.rate_since = now;
        }
    }

    pub fn observe(&mut self, bytes: &[u8], now: Instant, unix_ms: u64) -> Classification {
        self.refresh_rates(now);
        self.datagrams = self.datagrams.saturating_add(1);
        let classification = f1_25::classify(bytes);
        match classification {
            Classification::Accepted { kind, header } => {
                let slot = &mut self.kinds[usize::from(kind.id())];
                slot.accepted = slot.accepted.saturating_add(1);
                slot.accepted_bytes = slot.accepted_bytes.saturating_add(bytes.len() as u64);
                slot.last_observed_size = Some(bytes.len());
                slot.last_accepted_unix_ms = Some(unix_ms);
                slot.window = slot.window.saturating_add(1);
                self.accepted = self.accepted.saturating_add(1);
                if self
                    .current
                    .is_some_and(|previous| previous.session_uid != header.session_uid)
                {
                    self.session_uid_changes = self.session_uid_changes.saturating_add(1);
                }
                self.current = Some(header);
                self.last_accepted_at = Some(now);
                self.last_accepted_unix_ms = Some(unix_ms);
                self.live.observe(kind, &header, bytes, now, unix_ms);
            }
            Classification::Rejected { rejection, .. } => {
                let counter = match rejection {
                    Rejection::Truncated { .. } => &mut self.truncated,
                    Rejection::WrongPacketFormat { .. } => &mut self.wrong_packet_format,
                    Rejection::WrongGameYear { .. } => &mut self.wrong_game_year,
                    Rejection::UnknownPacketId { .. } => &mut self.unknown_packet_id,
                    Rejection::UnsupportedPacketVersion { kind, .. } => {
                        let slot = &mut self.kinds[usize::from(kind.id())];
                        slot.unsupported_versions = slot.unsupported_versions.saturating_add(1);
                        slot.last_observed_size = Some(bytes.len());
                        &mut self.unsupported_version
                    }
                    Rejection::SizeMismatch { kind, .. } => {
                        let slot = &mut self.kinds[usize::from(kind.id())];
                        slot.size_mismatches = slot.size_mismatches.saturating_add(1);
                        slot.last_observed_size = Some(bytes.len());
                        &mut self.size_mismatch
                    }
                };
                *counter = counter.saturating_add(1);
                self.last_rejection = Some(rejection);
            }
        }
        classification
    }

    pub fn snapshot(&mut self, now: Instant) -> F1EvidenceSnapshot {
        self.refresh_rates(now);
        let age = self
            .last_accepted_at
            .map(|at| now.saturating_duration_since(at));
        F1EvidenceSnapshot {
            detected: age.is_some_and(|age| age <= DETECTION_WINDOW),
            last_accepted_age_ms: age.map(|age| age.as_millis() as u64),
            last_accepted_unix_ms: self.last_accepted_unix_ms,
            header: self.current.map(HeaderView::from),
            session_uid_changes: self.session_uid_changes,
            datagrams: self.datagrams,
            accepted: self.accepted,
            truncated: self.truncated,
            wrong_packet_format: self.wrong_packet_format,
            wrong_game_year: self.wrong_game_year,
            unknown_packet_id: self.unknown_packet_id,
            unsupported_version: self.unsupported_version,
            size_mismatch: self.size_mismatch,
            last_rejection: self.last_rejection,
            kinds: PacketKind::ALL
                .iter()
                .map(|&kind| {
                    let slot = &self.kinds[usize::from(kind.id())];
                    KindSnapshot {
                        id: kind.id(),
                        kind,
                        name: kind.name(),
                        expected_size: kind.expected_size(),
                        size_evidence: kind.size_evidence(),
                        accepted: slot.accepted,
                        accepted_bytes: slot.accepted_bytes,
                        rate_hz: slot.rate_hz,
                        size_mismatches: slot.size_mismatches,
                        unsupported_versions: slot.unsupported_versions,
                        last_observed_size: slot.last_observed_size,
                        last_accepted_unix_ms: slot.last_accepted_unix_ms,
                    }
                })
                .collect(),
        }
    }
}

/// The listener's consumer. One short mutex section per datagram: classify a
/// 29-byte header, bump fixed counters, and for the four decoded families
/// copy the datagram into its fixed slot. No allocation, I/O or callback.
pub struct F1EvidenceSink {
    evidence: Mutex<F1Evidence>,
}

impl Default for F1EvidenceSink {
    fn default() -> Self {
        Self {
            evidence: Mutex::new(F1Evidence::new(Instant::now())),
        }
    }
}

impl F1EvidenceSink {
    pub fn reset(&self) {
        *lock(&self.evidence) = F1Evidence::new(Instant::now());
    }
    pub fn snapshot(&self) -> F1EvidenceSnapshot {
        lock(&self.evidence).snapshot(Instant::now())
    }
    /// Counters and decoded player values read under one lock, so they
    /// describe the same instant.
    pub fn read(&self) -> (F1EvidenceSnapshot, F1LiveSnapshot) {
        let now = Instant::now();
        let mut evidence = lock(&self.evidence);
        (evidence.snapshot(now), evidence.live(now))
    }
    /// Decoded player values and the age of the latest accepted datagram,
    /// without the per-ID counters: what the Live view reads, several times a
    /// second.
    pub fn read_live(&self) -> (Option<u64>, F1LiveSnapshot) {
        let now = Instant::now();
        let evidence = lock(&self.evidence);
        (evidence.last_accepted_age_ms(now), evidence.live(now))
    }
    pub fn raw_latest(&self) -> Vec<RawLatest> {
        lock(&self.evidence).raw_latest(Instant::now())
    }
    /// One short lock: copies held bytes out for the recorder, which decodes
    /// them on its own thread.
    pub fn recording_view(&self, cursor: u64) -> (Option<u64>, RecordingView) {
        lock(&self.evidence).recording_view(Instant::now(), cursor)
    }
}

impl PacketSink for F1EvidenceSink {
    fn on_packet(&self, packet: &CapturedPacket<'_>) {
        lock(&self.evidence).observe(packet.bytes, Instant::now(), packet.received_at_ms);
    }
}

/// Listener state without the transport's hex preview: diagnostics shows
/// counts and sizes, never payload bytes.
#[derive(Debug, Clone, Serialize)]
pub struct F1EvidenceStatus {
    pub enabled: bool,
    pub configured_port: u16,
    pub listening: bool,
    pub bound_port: Option<u16>,
    pub transport_datagrams: u64,
    pub receive_errors: u64,
    pub listener_error: Option<String>,
    pub evidence: F1EvidenceSnapshot,
    /// Decoded player values, per packet family, with their own freshness.
    pub live: F1LiveSnapshot,
    /// Present only when development fixture capture is enabled.
    pub capture: Option<CaptureStatus>,
}

/// What the product Live view polls (`get_f1_live`).
#[derive(Debug, Clone, Serialize)]
pub struct F1LiveStatus {
    pub enabled: bool,
    pub configured_port: u16,
    pub listening: bool,
    pub bound_port: Option<u16>,
    pub listener_error: Option<String>,
    /// Age of the latest accepted datagram of any type: whether F1 25 is
    /// sending at all, independent of which families are fresh.
    pub last_accepted_age_ms: Option<u64>,
    pub live: F1LiveSnapshot,
}

pub struct F1EvidenceService {
    enabled: bool,
    port: u16,
    listener: Listener,
    sink: Arc<F1EvidenceSink>,
    capture: Option<FixtureCapture>,
}

impl F1EvidenceService {
    pub fn new(enabled: bool, port: u16) -> Self {
        let sink = Arc::new(F1EvidenceSink::default());
        Self {
            enabled,
            port,
            listener: Listener::new(ReceiveBuffer::default(), Some(sink.clone())),
            sink,
            capture: None,
        }
    }

    /// Enables development fixture capture into `directory`.
    pub fn with_capture(mut self, directory: PathBuf) -> Self {
        self.capture = Some(FixtureCapture::new(directory));
        self
    }

    /// Reads `RACELAB_F1_EVIDENCE`. An unrecognised value is an error rather
    /// than a silent default, like every other RaceLab environment setting.
    /// `RACELAB_F1_CAPTURE` is read here too; capture needs evidence enabled.
    pub fn from_environment(capture_directory: PathBuf) -> Result<Self, String> {
        let enabled = match std::env::var(ENABLE_ENV) {
            Err(_) => enabled_by_default(),
            Ok(value) => match value.trim() {
                "1" | "true" => true,
                "0" | "false" => false,
                _ => return Err(format!("{ENABLE_ENV} must be 1, 0, true or false")),
            },
        };
        let service = Self::new(enabled, f1_25::DEFAULT_PORT);
        Ok(if enabled && f1_capture::enabled_from_environment()? {
            service.with_capture(capture_directory)
        } else {
            service
        })
    }

    pub fn capture_enabled(&self) -> bool {
        self.capture.is_some()
    }

    /// One development fixture snapshot, after `delay_ms` (so the request
    /// can be made before braking or reaching top speed). Blocks the calling
    /// thread for the delay; never touches the receive thread.
    pub fn capture_fixtures(&self, label: &str, delay_ms: u64) -> Result<CaptureManifest, String> {
        let capture = self
            .capture
            .as_ref()
            .ok_or("F1 fixture capture is not enabled (RACELAB_F1_CAPTURE=1, debug build)")?;
        f1_capture::validate_label(label)?;
        if delay_ms > f1_capture::MAX_DELAY_MS {
            return Err(format!(
                "Delay must be at most {} ms",
                f1_capture::MAX_DELAY_MS
            ));
        }
        std::thread::sleep(Duration::from_millis(delay_ms));
        let unix_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        capture.write(label, self.sink.raw_latest(), unix_ms)
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// The recorder's read. Never called on the receive thread.
    pub fn recording_view(&self, cursor: u64) -> (Option<u64>, RecordingView) {
        self.sink.recording_view(cursor)
    }

    /// Whether F1 25 is sending right now, by the detection window.
    pub fn detected(&self) -> bool {
        self.sink
            .read_live()
            .0
            .is_some_and(|age| age <= DETECTION_WINDOW.as_millis() as u64)
    }

    /// Binds loopback only, through the same transport as FH6. A bind failure
    /// (another F1 tool on 20777) is reported in `status`, never fatal, and
    /// leaves FH6 untouched. Does nothing when disabled.
    pub fn start(&self) -> Result<(), String> {
        if !self.enabled {
            return Ok(());
        }
        if self.listener.snapshot().running {
            return Ok(());
        }
        self.sink.reset();
        self.listener.start(self.port).map(|_| ())
    }

    pub fn stop(&self) -> Result<(), String> {
        self.listener.stop().map(|_| ())
    }

    /// The product Live view's read: listener state, how recently any F1
    /// packet was accepted, and the decoded player values per family. No
    /// counters, sizes, header identifiers or capture state.
    pub fn live_status(&self) -> F1LiveStatus {
        let transport = self.listener.snapshot();
        let (last_accepted_age_ms, live) = self.sink.read_live();
        F1LiveStatus {
            enabled: self.enabled,
            configured_port: self.port,
            listening: transport.running,
            bound_port: transport.bound_port,
            listener_error: transport.last_error,
            last_accepted_age_ms,
            live,
        }
    }

    pub fn status(&self) -> F1EvidenceStatus {
        let transport = self.listener.snapshot();
        let (evidence, live) = self.sink.read();
        F1EvidenceStatus {
            enabled: self.enabled,
            configured_port: self.port,
            listening: transport.running,
            bound_port: transport.bound_port,
            transport_datagrams: transport.total_packets,
            receive_errors: transport.receive_errors,
            listener_error: transport.last_error,
            evidence,
            live,
            capture: self.capture.as_ref().map(FixtureCapture::status),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn datagram(id: u8, size: usize) -> Vec<u8> {
        let mut bytes = vec![0; size];
        bytes[0..2].copy_from_slice(&2025u16.to_le_bytes());
        bytes[2] = 25;
        bytes[5] = 1;
        bytes[6] = id;
        bytes
    }

    #[test]
    fn counters_saturate_instead_of_wrapping() {
        let start = Instant::now();
        let mut evidence = F1Evidence::new(start);
        evidence.datagrams = u64::MAX;
        evidence.accepted = u64::MAX;
        evidence.kinds[6].accepted = u64::MAX;
        evidence.kinds[6].accepted_bytes = u64::MAX - 1;
        evidence.truncated = u64::MAX;
        evidence.observe(&datagram(6, 1352), start, 0);
        evidence.observe(&[0; 3], start, 0);
        let snapshot = evidence.snapshot(start);
        assert_eq!(snapshot.datagrams, u64::MAX);
        assert_eq!(snapshot.accepted, u64::MAX);
        assert_eq!(snapshot.kinds[6].accepted, u64::MAX);
        assert_eq!(snapshot.kinds[6].accepted_bytes, u64::MAX);
        assert_eq!(snapshot.truncated, u64::MAX);
    }

    #[test]
    fn rates_are_per_kind_and_decay_when_idle() {
        let start = Instant::now();
        let mut evidence = F1Evidence::new(start);
        for i in 0..40 {
            let at = start + Duration::from_millis(i * 50);
            evidence.observe(&datagram(0, 1349), at, 0);
            if i % 10 == 0 {
                evidence.observe(&datagram(1, 753), at, 0);
            }
        }
        let snapshot = evidence.snapshot(start + Duration::from_secs(2));
        // 50 ms spacing is the in-game 20 Hz; every tenth is 2 Hz.
        assert_eq!(snapshot.kinds[0].rate_hz, 20.0);
        assert_eq!(snapshot.kinds[1].rate_hz, 2.0);
        assert_eq!(snapshot.kinds[2].rate_hz, 0.0);
        let idle = evidence.snapshot(start + Duration::from_secs(10));
        assert!(idle.kinds.iter().all(|kind| kind.rate_hz == 0.0));
        assert!(!idle.detected);
    }

    #[test]
    fn detection_follows_the_window() {
        let start = Instant::now();
        let mut evidence = F1Evidence::new(start);
        assert!(!evidence.snapshot(start).detected);
        evidence.observe(&datagram(3, 45), start, 7);
        assert!(evidence.snapshot(start + DETECTION_WINDOW).detected);
        let late = evidence.snapshot(start + DETECTION_WINDOW + Duration::from_millis(1));
        assert!(!late.detected);
        assert_eq!(late.last_accepted_unix_ms, Some(7));
        // Rejected traffic never counts as detection.
        let mut rejected = F1Evidence::new(start);
        rejected.observe(&datagram(3, 46), start, 0);
        rejected.observe(&[0; 324], start, 0);
        assert!(!rejected.snapshot(start).detected);
    }
}
