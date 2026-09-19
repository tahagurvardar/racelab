//! Deterministic session lifecycle. All times are supplied monotonic milliseconds.
use crate::telemetry::TelemetryFrame;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SessionState {
    Active,
    Grace,
    Completed,
}

#[derive(Debug, Clone, Serialize)]
pub struct Session {
    pub id: String,
    pub started_at: Option<u64>,
    pub duration_ms: u64,
    pub game: Option<String>,
    pub vehicle_id: Option<String>,
    pub state: SessionState,
    pub ended_reason: Option<String>,
    pub grace_remaining_ms: Option<u64>,
    #[serde(skip)]
    started_ms: u64,
    #[serde(skip)]
    grace_since_ms: Option<u64>,
}

pub struct SessionEngine {
    current: Option<Session>,
    next_id: u64,
    instance_id: String,
    pub grace_ms: u64,
    pub silence_ms: u64,
    last_active_ms: Option<u64>,
}
impl SessionEngine {
    pub fn new(instance_id: String, grace_ms: u64, silence_ms: u64) -> Self {
        Self {
            current: None,
            next_id: 0,
            instance_id,
            grace_ms,
            silence_ms,
            last_active_ms: None,
        }
    }
    pub fn observe(&mut self, frame: &TelemetryFrame, now: u64, wall: Option<u64>) {
        self.tick(now);
        if !frame.active {
            self.enter_grace(now);
            return;
        }
        let changed = self.current.as_ref().is_some_and(|s| {
            s.state != SessionState::Completed
                && (s.game != frame.game
                    || (s.vehicle_id.is_some()
                        && frame.vehicle_id.is_some()
                        && s.vehicle_id != frame.vehicle_id))
        });
        if changed {
            self.finish(now, "vehicle_or_game_changed");
        }
        if self
            .current
            .as_ref()
            .is_none_or(|s| s.state == SessionState::Completed)
        {
            self.next_id += 1;
            self.current = Some(Session {
                id: format!("{}-{}", self.instance_id, self.next_id),
                started_at: wall,
                duration_ms: 0,
                game: frame.game.clone(),
                vehicle_id: frame.vehicle_id.clone(),
                state: SessionState::Active,
                ended_reason: None,
                grace_remaining_ms: None,
                started_ms: now,
                grace_since_ms: None,
            });
        }
        if let Some(session) = &mut self.current {
            session.state = SessionState::Active;
            session.grace_since_ms = None;
            session.grace_remaining_ms = None;
            if session.vehicle_id.is_none() {
                session.vehicle_id = frame.vehicle_id.clone();
            }
            session.duration_ms = now.saturating_sub(session.started_ms);
        }
        self.last_active_ms = Some(now);
    }
    fn enter_grace(&mut self, since: u64) {
        if let Some(s) = &mut self.current {
            if s.state == SessionState::Active {
                s.state = SessionState::Grace;
                s.grace_since_ms = Some(since);
                s.grace_remaining_ms = Some(self.grace_ms);
            }
        }
    }
    pub fn tick(&mut self, now: u64) {
        if let Some(last) = self.last_active_ms {
            if now.saturating_sub(last) >= self.silence_ms {
                self.enter_grace(last + self.silence_ms);
            }
        }
        if let Some(s) = &mut self.current {
            if s.state != SessionState::Completed {
                s.duration_ms = now.saturating_sub(s.started_ms);
            }
            if let Some(since) = s.grace_since_ms {
                let deadline = since.saturating_add(self.grace_ms);
                if now >= deadline {
                    self.finish(deadline, "grace_expired");
                } else {
                    s.grace_remaining_ms = Some(deadline - now);
                }
            }
        }
    }
    pub fn finish(&mut self, now: u64, reason: &str) {
        if let Some(s) = &mut self.current {
            if s.state != SessionState::Completed {
                s.duration_ms = now.saturating_sub(s.started_ms);
                s.state = SessionState::Completed;
                s.ended_reason = Some(reason.into());
                s.grace_since_ms = None;
                s.grace_remaining_ms = None;
            }
        }
        self.last_active_ms = None;
    }
    pub fn snapshot(&self) -> Option<Session> {
        self.current.clone()
    }
}
