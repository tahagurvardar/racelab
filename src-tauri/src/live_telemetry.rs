//! Automatic connection supervision around the frozen PacketSink boundary.
use crate::{
    adapters::fh6::Issue,
    ingress::StatsSnapshot,
    packet::{CapturedPacket, PacketSink},
    protocol::{PacketClassification, ProtocolDetector},
    session::{Session, SessionState},
    telemetry::TelemetryFrame,
    telemetry_hub::{HubStats, TelemetryHub},
};
use serde::Serialize;
use std::{
    sync::{Arc, Mutex},
    time::Instant,
};

#[derive(Debug, Clone)]
pub struct ConnectionConfig {
    pub detection_frames: usize,
    pub silence_ms: u64,
    pub grace_ms: u64,
    pub ring_capacity: usize,
}
impl Default for ConnectionConfig {
    fn default() -> Self {
        Self {
            detection_frames: 5,
            silence_ms: 1500,
            grace_ms: 10_000,
            ring_capacity: 512,
        }
    }
}
impl ConnectionConfig {
    pub fn validate(&self) -> Result<(), String> {
        if !(3..=100).contains(&self.detection_frames)
            || !(1..=60_000).contains(&self.silence_ms)
            || !(1..=120_000).contains(&self.grace_ms)
            || !(1..=8192).contains(&self.ring_capacity)
        {
            return Err("Invalid detection, silence, grace or ring configuration".into());
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ConnectionState {
    Starting,
    Listening,
    Probing,
    ConnectedIdle,
    SessionActive,
    Grace,
    Disconnected,
    Degraded,
    Error,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Health {
    Good,
    Degraded,
    Lost,
}
#[derive(Debug, Clone, Serialize)]
pub struct LiveSnapshot {
    pub revision: u64,
    pub connection: ConnectionState,
    pub health: Health,
    pub protocol: Option<String>,
    pub protocol_confidence: f64,
    pub valid_packets: u64,
    pub invalid_packets: u64,
    pub valid_active_fh6: u64,
    pub valid_inactive_fh6: u64,
    pub invalid_fh6: u64,
    pub unknown_protocol: u64,
    pub input_packet_hz: f64,
    pub valid_frame_hz: f64,
    pub last_packet_age_ms: Option<u64>,
    pub last_valid_frame_age_ms: Option<u64>,
    pub receive_errors: u64,
    pub stale: bool,
    pub frame: Option<Arc<TelemetryFrame>>,
    pub issues: Vec<Issue>,
    pub transport_error: Option<String>,
    pub session: Option<Session>,
    pub hub: HubStats,
    pub grace_period_ms: u64,
}
#[derive(Default)]
struct Rate {
    since: u64,
    count: u64,
    hz: f64,
}
impl Rate {
    fn tick(&mut self, now: u64) {
        let elapsed = now.saturating_sub(self.since);
        if elapsed >= 1000 {
            self.hz = self.count as f64 * 1000.0 / elapsed as f64;
            self.count = 0;
            self.since = now;
        }
    }
    fn record(&mut self, now: u64) {
        self.tick(now);
        self.count += 1;
    }
}
struct State {
    revision: u64,
    connection: ConnectionState,
    running: bool,
    ready: bool,
    detector: ProtocolDetector,
    valid_packets: u64,
    invalid_packets: u64,
    valid_active_fh6: u64,
    valid_inactive_fh6: u64,
    unknown_protocol: u64,
    last_packet: Option<u64>,
    last_valid: Option<u64>,
    last_invalid: Option<u64>,
    input_rate: Rate,
    valid_rate: Rate,
    receive_errors: u64,
    transport_error: Option<String>,
    issues: Vec<Issue>,
    now: u64,
}
pub struct LiveTelemetrySink {
    capture: Arc<dyn PacketSink>,
    pub hub: Arc<TelemetryHub>,
    state: Mutex<State>,
    config: ConnectionConfig,
    started: Instant,
}
impl LiveTelemetrySink {
    pub fn new(capture: Arc<dyn PacketSink>) -> Self {
        Self::with_config(capture, ConnectionConfig::default(), "local".into())
            .expect("valid default configuration")
    }
    pub fn with_config(
        capture: Arc<dyn PacketSink>,
        config: ConnectionConfig,
        instance_id: String,
    ) -> Result<Self, String> {
        config.validate()?;
        let hub = Arc::new(TelemetryHub::new(
            config.ring_capacity,
            instance_id,
            config.grace_ms,
            config.silence_ms,
        )?);
        let detector = ProtocolDetector::new(config.detection_frames)?;
        Ok(Self {
            capture,
            hub,
            config,
            started: Instant::now(),
            state: Mutex::new(State {
                revision: 0,
                connection: ConnectionState::Starting,
                running: false,
                ready: false,
                detector,
                valid_packets: 0,
                invalid_packets: 0,
                valid_active_fh6: 0,
                valid_inactive_fh6: 0,
                unknown_protocol: 0,
                last_packet: None,
                last_valid: None,
                last_invalid: None,
                input_rate: Rate::default(),
                valid_rate: Rate::default(),
                receive_errors: 0,
                transport_error: None,
                issues: Vec::new(),
                now: 0,
            }),
        })
    }
    pub fn now_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }
    pub fn begin_start(&self) {
        self.begin_start_at(self.now_ms());
    }
    pub fn begin_start_at(&self, now: u64) {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        s.now = s.now.max(now);
        self.hub.finish_session(s.now, "listener_restarted");
        s.detector.reset();
        s.connection = ConnectionState::Starting;
        s.running = true;
        s.ready = false;
        s.last_packet = None;
        s.last_valid = None;
        s.last_invalid = None;
        s.issues.clear();
        s.transport_error = None;
        s.receive_errors = 0;
        s.valid_packets = 0;
        s.invalid_packets = 0;
        s.valid_active_fh6 = 0;
        s.valid_inactive_fh6 = 0;
        s.unknown_protocol = 0;
        s.input_rate = Rate {
            since: s.now,
            ..Rate::default()
        };
        s.valid_rate = Rate {
            since: s.now,
            ..Rate::default()
        };
    }
    pub fn listener_ready(&self) {
        self.listener_ready_at(self.now_ms());
    }
    pub fn listener_ready_at(&self, now: u64) {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        s.ready = true;
        s.running = true;
        self.advance(&mut s, now);
    }
    pub fn stop(&self) {
        self.stop_at(self.now_ms());
    }
    pub fn stop_at(&self, now: u64) {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        s.running = false;
        s.ready = true;
        s.detector.reset();
        s.connection = ConnectionState::Disconnected;
        self.hub.finish_session(now, "listener_stopped");
    }
    pub fn transport_failed(&self, message: String) {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        s.running = false;
        s.ready = true;
        s.transport_error = Some(message);
        s.connection = ConnectionState::Error;
        self.hub.finish_session(self.now_ms(), "transport_error");
    }
    pub fn observe_transport(&self, stats: &StatsSnapshot) {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        s.receive_errors = stats.receive_errors;
        if s.ready && !stats.running && s.running {
            s.running = false;
            s.transport_error = Some(
                stats
                    .last_error
                    .clone()
                    .unwrap_or_else(|| "UDP listener stopped unexpectedly".into()),
            );
            s.connection = ConnectionState::Error;
            self.hub.finish_session(self.now_ms(), "transport_error");
        } else if stats.running && stats.last_error.is_some() {
            s.transport_error = stats.last_error.clone();
        }
    }
    pub fn on_packet_at(&self, packet: &CapturedPacket<'_>, now: u64) {
        self.capture.on_packet(packet);
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        self.advance(&mut s, now);
        if !s.running {
            return;
        }
        s.ready = true;
        let now = s.now;
        s.input_rate.record(now);
        s.last_packet = Some(now);
        let result = s.detector.ingest(packet.bytes, packet.source, now);
        // Unrelated traffic must neither invalidate nor clear the last FH6
        // validation result used by the latest-value display.
        if result.classification != PacketClassification::UnknownProtocol {
            s.issues = result.issues;
        }
        match result.classification {
            PacketClassification::ValidActiveFh6 => s.valid_active_fh6 += 1,
            PacketClassification::ValidInactiveFh6 => s.valid_inactive_fh6 += 1,
            PacketClassification::InvalidFh6 => {
                s.invalid_packets += 1;
                s.last_invalid = Some(now);
            }
            PacketClassification::UnknownProtocol => s.unknown_protocol += 1,
        }
        if result.newly_locked {
            s.connection = ConnectionState::ConnectedIdle;
        }
        if let Some(frame) = result.frame {
            s.valid_packets += 1;
            s.valid_rate.record(now);
            s.last_valid = Some(now);
            self.hub.publish(frame, now, Some(packet.received_at_ms));
        }
        self.advance(&mut s, now);
    }
    fn recent_fault(&self, s: &State) -> bool {
        s.last_invalid
            .is_some_and(|t| s.now.saturating_sub(t) < 2000)
            || self
                .hub
                .stats()
                .last_drop_ms
                .is_some_and(|t| s.now.saturating_sub(t) < 2000)
            || s.transport_error.is_some()
    }
    fn advance(&self, s: &mut State, now: u64) {
        s.now = s.now.max(now);
        let now = s.now;
        s.input_rate.tick(now);
        s.valid_rate.tick(now);
        self.hub.tick(now);
        if !s.running {
            s.connection = if s.transport_error.is_some() {
                ConnectionState::Error
            } else if !s.ready {
                ConnectionState::Starting
            } else {
                ConnectionState::Disconnected
            };
            return;
        }
        if !s.ready {
            s.connection = ConnectionState::Starting;
            return;
        }
        let session = self.hub.session();
        let fresh = s
            .last_valid
            .is_some_and(|t| now.saturating_sub(t) < self.config.silence_ms);
        let grace = session
            .as_ref()
            .is_some_and(|session| session.state == SessionState::Grace);
        if s.detector.protocol().is_some() && !fresh && !grace {
            s.detector.reset();
            s.connection = ConnectionState::Disconnected;
        }
        s.connection = if s.detector.protocol().is_none() {
            if s.last_packet.is_none() {
                ConnectionState::Listening
            } else if s
                .last_packet
                .is_some_and(|t| now.saturating_sub(t) < self.config.silence_ms)
            {
                ConnectionState::Probing
            } else {
                ConnectionState::Disconnected
            }
        } else if grace {
            ConnectionState::Grace
        } else if self.recent_fault(s) {
            ConnectionState::Degraded
        } else if session
            .as_ref()
            .is_some_and(|v| v.state == SessionState::Active)
        {
            ConnectionState::SessionActive
        } else {
            ConnectionState::ConnectedIdle
        };
    }
    pub fn snapshot(&self) -> LiveSnapshot {
        self.snapshot_at(self.now_ms())
    }
    pub fn snapshot_at(&self, now: u64) -> LiveSnapshot {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        self.advance(&mut s, now);
        s.revision += 1;
        let fresh = s.running
            && s.detector.protocol().is_some()
            && s.last_valid
                .is_some_and(|t| s.now.saturating_sub(t) < self.config.silence_ms);
        let health = if !s.running || s.detector.protocol().is_none() {
            Health::Lost
        } else if !fresh || self.recent_fault(&s) {
            Health::Degraded
        } else {
            Health::Good
        };
        let frame = if fresh && s.issues.is_empty() {
            self.hub.latest().map(|f| f.frame.clone())
        } else {
            None
        };
        LiveSnapshot {
            revision: s.revision,
            connection: s.connection,
            health,
            protocol: s.detector.protocol().map(str::to_owned),
            protocol_confidence: s.detector.confidence(),
            valid_packets: s.valid_packets,
            invalid_packets: s.invalid_packets,
            valid_active_fh6: s.valid_active_fh6,
            valid_inactive_fh6: s.valid_inactive_fh6,
            invalid_fh6: s.invalid_packets,
            unknown_protocol: s.unknown_protocol,
            input_packet_hz: s.input_rate.hz,
            valid_frame_hz: s.valid_rate.hz,
            last_packet_age_ms: s.last_packet.map(|t| s.now.saturating_sub(t)),
            last_valid_frame_age_ms: s.last_valid.map(|t| s.now.saturating_sub(t)),
            receive_errors: s.receive_errors,
            stale: !fresh,
            frame,
            issues: s.issues.clone(),
            transport_error: s.transport_error.clone(),
            session: self.hub.session(),
            hub: self.hub.stats(),
            grace_period_ms: self.config.grace_ms,
        }
    }
}
impl PacketSink for LiveTelemetrySink {
    fn on_packet(&self, packet: &CapturedPacket<'_>) {
        self.on_packet_at(packet, self.now_ms());
    }
}
