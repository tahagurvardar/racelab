//! Extensible protocol registry and bounded, source-specific detection.
use crate::{
    adapters::fh6::{self, Issue},
    telemetry::{Engine, TelemetryFrame, Vector3},
};
use std::net::SocketAddr;

pub trait ProtocolAdapter: Send + Sync {
    fn id(&self) -> &'static str;
    fn decode(&self, bytes: &[u8], probing: bool) -> Result<TelemetryFrame, Vec<Issue>>;
}
pub struct Fh6Adapter;
impl ProtocolAdapter for Fh6Adapter {
    fn id(&self) -> &'static str {
        "fh6"
    }
    fn decode(&self, bytes: &[u8], probing: bool) -> Result<TelemetryFrame, Vec<Issue>> {
        let decoded = fh6::decode(bytes)?;
        let mut check = decoded.frame.clone();
        if probing && !check.active {
            // Inactive canonical fields are null. Probe original values instead;
            // zero-filled 324-byte packets must never identify a game.
            let f = |offset| decoded.fh6.float_fields[&offset];
            check.active = true;
            check.speed_mps = Some(f(256));
            check.velocity = Some(Vector3 {
                x: f(32),
                y: f(36),
                z: f(40),
            });
            check.engine = Engine {
                rpm: Some(f(16)),
                idle_rpm: Some(f(12)),
                max_rpm: Some(f(8)),
                // Detection rests on motion and RPM plausibility alone; the
                // probe deliberately adds no field the validator does not use.
                ..Engine::default()
            };
        }
        let issues = fh6::physical_issues(&check);
        if issues.is_empty() {
            Ok(decoded.frame)
        } else {
            Err(issues)
        }
    }
}

#[derive(Default, Clone)]
struct Clock {
    previous: Option<(u32, u64, bool)>,
    advanced_at: Option<u64>,
}
impl Clock {
    fn observe(&mut self, frame: &TelemetryFrame, now: u64) -> Result<bool, Vec<Issue>> {
        let ts = frame
            .game_timestamp_ms
            .and_then(|v| u32::try_from(v).ok())
            .ok_or_else(|| {
                vec![Issue::new(
                    "timestamp_ms",
                    4,
                    "Missing/unsupported timestamp",
                )]
            })?;
        let mut progressed = false;
        if let Some((last, at, active)) = self.previous {
            let reset = frame.active != active && ts < last;
            let wrap = last >= u32::MAX - 60_000 && ts <= 60_000;
            if ts < last && !reset && !wrap {
                return Err(vec![Issue::new(
                    "timestamp_ms",
                    4,
                    "Unexplained timestamp regression",
                )]);
            }
            let delta = if reset {
                0
            } else {
                u64::from(ts.wrapping_sub(last))
            };
            if delta > now.saturating_sub(at) + 2000 {
                return Err(vec![Issue::new(
                    "timestamp_ms",
                    4,
                    "Game timestamp advanced implausibly relative to receive clock",
                )]);
            }
            progressed = ts != last;
            if frame.active != active {
                self.advanced_at = Some(now);
            }
            if frame.active
                && !progressed
                && self
                    .advanced_at
                    .is_some_and(|t| now.saturating_sub(t) > 2500)
            {
                return Err(vec![Issue::new(
                    "timestamp_ms",
                    4,
                    "Game timestamp has stopped advancing",
                )]);
            }
        }
        if progressed || self.advanced_at.is_none() {
            self.advanced_at = Some(now);
        }
        self.previous = Some((ts, now, frame.active));
        Ok(progressed)
    }
}
struct Candidate {
    source: SocketAddr,
    adapter: usize,
    consecutive: usize,
    advances: usize,
    clock: Clock,
}
/// Packet validity is separate from the evidence required to identify a stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PacketClassification {
    ValidActiveFh6,
    ValidInactiveFh6,
    InvalidFh6,
    UnknownProtocol,
}
pub struct Detection {
    pub classification: PacketClassification,
    pub frame: Option<TelemetryFrame>,
    pub issues: Vec<Issue>,
    pub newly_locked: bool,
}
pub struct ProtocolDetector {
    adapters: Vec<Box<dyn ProtocolAdapter>>,
    candidate: Option<Candidate>,
    locked: bool,
    threshold: usize,
    bad_streak: u64,
}
impl ProtocolDetector {
    pub fn new(threshold: usize) -> Result<Self, String> {
        Self::with_adapters(threshold, vec![Box::new(Fh6Adapter)])
    }
    pub fn with_adapters(
        threshold: usize,
        adapters: Vec<Box<dyn ProtocolAdapter>>,
    ) -> Result<Self, String> {
        if !(3..=100).contains(&threshold) || adapters.is_empty() || adapters.len() > 8 {
            return Err("Detection needs 3..100 frames and 1..8 registered adapters".into());
        }
        Ok(Self {
            adapters,
            candidate: None,
            locked: false,
            threshold,
            bad_streak: 0,
        })
    }
    pub fn reset(&mut self) {
        self.candidate = None;
        self.locked = false;
        self.bad_streak = 0;
    }
    pub fn protocol(&self) -> Option<&'static str> {
        self.candidate
            .as_ref()
            .filter(|_| self.locked)
            .map(|c| self.adapters[c.adapter].id())
    }
    pub fn confidence(&self) -> f64 {
        if self.locked {
            1.0 / (1.0 + self.bad_streak as f64)
        } else {
            self.candidate.as_ref().map_or(0.0, |c| {
                (c.consecutive as f64 / self.threshold as f64).min(0.99)
            })
        }
    }
    pub fn ingest(&mut self, bytes: &[u8], source: SocketAddr, now: u64) -> Detection {
        if self.locked && self.candidate.as_ref().is_some_and(|c| c.source != source) {
            return Detection {
                classification: PacketClassification::UnknownProtocol,
                frame: None,
                issues: Vec::new(),
                newly_locked: false,
            };
        }
        let indices: Vec<usize> = if let Some(c) = &self.candidate {
            if self.locked {
                vec![c.adapter]
            } else {
                (0..self.adapters.len()).collect()
            }
        } else {
            (0..self.adapters.len()).collect()
        };
        let mut errors = vec![Issue::new("protocol", 0, "No supported protocol matched")];
        for adapter in indices {
            let frame = match self.adapters[adapter].decode(bytes, false) {
                Ok(frame) => frame,
                Err(e) => {
                    errors = e;
                    continue;
                }
            };
            let classification = match (self.adapters[adapter].id(), frame.active) {
                ("fh6", true) => PacketClassification::ValidActiveFh6,
                ("fh6", false) => PacketClassification::ValidInactiveFh6,
                _ => PacketClassification::UnknownProtocol,
            };
            // Inactive data can be structurally valid without offering enough
            // engine/motion evidence to identify a game. Do not report that as
            // malformed telemetry or allow zero-filled traffic to obtain a lock.
            if !self.locked && !frame.active && self.adapters[adapter].decode(bytes, true).is_err()
            {
                self.candidate = None;
                return Detection {
                    classification,
                    frame: None,
                    issues: Vec::new(),
                    newly_locked: false,
                };
            }
            let same = self
                .candidate
                .as_ref()
                .is_some_and(|c| c.source == source && c.adapter == adapter);
            if !same {
                self.candidate = Some(Candidate {
                    source,
                    adapter,
                    consecutive: 0,
                    advances: 0,
                    clock: Clock::default(),
                });
            }
            let candidate = self.candidate.as_mut().unwrap();
            // Menus/loading carry no canonical dynamics. Their game clock is
            // not an active-driving clock: retain it raw, but do not enforce
            // continuity across this inactive interval. Probe clocks remain
            // strict so inactive packets alone cannot bypass identification.
            let clock_result = if self.locked && !frame.active {
                candidate.clock = Clock::default();
                Ok(false)
            } else {
                candidate.clock.observe(&frame, now)
            };
            let advanced = match clock_result {
                Ok(v) => v,
                Err(e) => {
                    if !self.locked && !frame.active {
                        self.candidate = None;
                        return Detection {
                            classification,
                            frame: None,
                            issues: Vec::new(),
                            newly_locked: false,
                        };
                    }
                    errors = e;
                    break;
                }
            };
            candidate.consecutive += 1;
            if advanced {
                candidate.advances += 1;
            }
            self.bad_streak = 0;
            let newly_locked =
                !self.locked && candidate.consecutive >= self.threshold && candidate.advances >= 2;
            if newly_locked {
                self.locked = true;
            }
            return Detection {
                classification,
                frame: self.locked.then_some(frame),
                issues: Vec::new(),
                newly_locked,
            };
        }
        let classification = if self.protocol() == Some("fh6") {
            PacketClassification::InvalidFh6
        } else {
            PacketClassification::UnknownProtocol
        };
        self.bad_streak += 1;
        if !self.locked {
            self.candidate = None;
        }
        Detection {
            classification,
            frame: None,
            issues: if classification == PacketClassification::InvalidFh6 {
                errors
            } else {
                Vec::new()
            },
            newly_locked: false,
        }
    }
}
