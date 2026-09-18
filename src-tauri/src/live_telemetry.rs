//! Fan out through PacketSink. Capture is called first and preserves every raw
//! datagram regardless of adapter rejection. All adapter work is bounded in memory.
use crate::{
    adapters::fh6::{self, Issue, TimestampEvent, TimestampValidator},
    packet::{CapturedPacket, PacketSink},
    telemetry::TelemetryFrame,
};
use serde::Serialize;
use std::{
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Default, Serialize)]
pub struct LiveSnapshot {
    pub revision: u64,
    pub valid_packets: u64,
    pub invalid_packets: u64,
    pub stale: bool,
    pub frame: Option<TelemetryFrame>,
    pub issues: Vec<Issue>,
}
#[derive(Default)]
struct State {
    snapshot: LiveSnapshot,
    clock: TimestampValidator,
    source: Option<SocketAddr>,
    updated: Option<Instant>,
}
pub struct LiveTelemetrySink {
    capture: Arc<dyn PacketSink>,
    state: Mutex<State>,
}
impl LiveTelemetrySink {
    pub fn new(capture: Arc<dyn PacketSink>) -> Self {
        Self {
            capture,
            state: Mutex::new(State::default()),
        }
    }
    /// Called at explicit listener lifecycle boundaries, outside ingress.
    pub fn reset(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let revision = state.snapshot.revision;
        *state = State::default();
        state.snapshot.revision = revision;
    }
    pub fn snapshot(&self) -> LiveSnapshot {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.snapshot.revision += 1;
        let mut snapshot = state.snapshot.clone();
        snapshot.stale = state
            .updated
            .is_none_or(|t| t.elapsed() > Duration::from_secs(2));
        if snapshot.stale {
            snapshot.frame = None;
        }
        snapshot
    }
}
impl PacketSink for LiveTelemetrySink {
    fn on_packet(&self, packet: &CapturedPacket<'_>) {
        self.capture.on_packet(packet);
        let result = fh6::decode(packet.bytes);
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.updated = Some(Instant::now());
        let mut issues;
        let mut frame = None;
        match result {
            Err(errors) => issues = errors,
            Ok(decoded) => {
                issues = fh6::physical_issues(&decoded.frame);
                if state.source.is_some_and(|source| source != packet.source) {
                    issues.push(Issue::new(
                        "source",
                        0,
                        "Live source changed; stop/restart listener to select a new stream",
                    ));
                } else {
                    state.source = Some(packet.source);
                    if state
                        .clock
                        .observe(decoded.fh6.timestamp_ms, decoded.frame.active, false)
                        == TimestampEvent::Regression
                    {
                        issues.push(Issue::new(
                            "timestamp_ms",
                            4,
                            "Unexplained game timestamp regression",
                        ));
                    }
                }
                if issues.is_empty() {
                    frame = Some(decoded.frame);
                }
            }
        }
        if issues.is_empty() {
            state.snapshot.valid_packets += 1;
        } else {
            state.snapshot.invalid_packets += 1;
        }
        state.snapshot.frame = frame;
        state.snapshot.issues = issues;
    }
}
