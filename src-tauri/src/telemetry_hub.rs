//! Game-independent, bounded in-memory distribution. No subscriber code runs here.
use crate::{
    session::{Session, SessionEngine, SessionEvent, SessionState},
    telemetry::TelemetryFrame,
};
use serde::Serialize;
use std::{
    collections::VecDeque,
    sync::{
        mpsc::{self, Receiver, SyncSender, TrySendError},
        Arc, Mutex, OnceLock,
    },
};

/// Persistence boundary. Implementations must return promptly and must never
/// touch disk, block, or call back into the hub: every method below runs on the
/// ingestion or lifecycle thread. Frames belong to the recorder's own currently
/// started session, which the two lifecycle calls delimit.
pub trait SessionRecorderHook: Send + Sync {
    fn session_started(&self, session: &Session);
    fn session_completed(&self, session: &Session);
    fn record_frame(&self, sequence: u64, monotonic_ms: u64, frame: &Arc<TelemetryFrame>);
}

#[derive(Debug, Serialize)]
pub struct HubFrame {
    pub sequence: u64,
    pub received_monotonic_ms: u64,
    pub frame: Arc<TelemetryFrame>,
}
#[derive(Debug, Clone, Serialize)]
pub struct HubStats {
    pub published: u64,
    pub recent_frames: usize,
    pub ring_capacity: usize,
    pub ring_evictions: u64,
    pub subscribers: usize,
    pub subscriber_drops: u64,
    pub last_drop_ms: Option<u64>,
}
struct Inner {
    recent: VecDeque<Arc<HubFrame>>,
    subscribers: Vec<SyncSender<Arc<HubFrame>>>,
    stats: HubStats,
    session: SessionEngine,
}
pub struct TelemetryHub {
    inner: Mutex<Inner>,
    recorder: OnceLock<Arc<dyn SessionRecorderHook>>,
}
impl TelemetryHub {
    pub fn new(
        capacity: usize,
        instance_id: String,
        grace_ms: u64,
        silence_ms: u64,
    ) -> Result<Self, String> {
        if !(1..=8192).contains(&capacity) {
            return Err("Ring capacity must be 1..8192".into());
        }
        Ok(Self {
            recorder: OnceLock::new(),
            inner: Mutex::new(Inner {
                recent: VecDeque::with_capacity(capacity),
                subscribers: Vec::new(),
                stats: HubStats {
                    published: 0,
                    recent_frames: 0,
                    ring_capacity: capacity,
                    ring_evictions: 0,
                    subscribers: 0,
                    subscriber_drops: 0,
                    last_drop_ms: None,
                },
                session: SessionEngine::new(instance_id, grace_ms, silence_ms),
            }),
        })
    }
    /// Attach the persistent recorder once, before telemetry starts flowing.
    pub fn attach_recorder(&self, recorder: Arc<dyn SessionRecorderHook>) -> Result<(), String> {
        self.recorder
            .set(recorder)
            .map_err(|_| "A session recorder is already attached".to_string())
    }
    /// Lifecycle notifications and frame hand-off run with no hub lock held, so
    /// no recorder work can ever serialize behind telemetry distribution.
    fn dispatch(&self, events: Vec<SessionEvent>) {
        let Some(recorder) = self.recorder.get() else {
            return;
        };
        for event in events {
            match event {
                SessionEvent::Started(session) => recorder.session_started(&session),
                SessionEvent::Completed(session) => recorder.session_completed(&session),
            }
        }
    }
    pub fn publish(&self, frame: TelemetryFrame, now: u64, wall: Option<u64>) {
        let (frame, events, recording) = {
            let mut s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            s.session.observe(&frame, now, wall);
            let events = s.session.take_events();
            let recording = s
                .session
                .state()
                .is_some_and(|state| state != SessionState::Completed);
            s.stats.published += 1;
            let frame = Arc::new(HubFrame {
                sequence: s.stats.published,
                received_monotonic_ms: now,
                frame: Arc::new(frame),
            });
            if s.recent.len() == s.stats.ring_capacity {
                s.recent.pop_front();
                s.stats.ring_evictions += 1;
            }
            s.recent.push_back(frame.clone());
            let mut drops = 0;
            s.subscribers
                .retain(|sender| match sender.try_send(frame.clone()) {
                    Ok(()) => true,
                    Err(TrySendError::Full(_)) => {
                        drops += 1;
                        true
                    }
                    Err(TrySendError::Disconnected(_)) => false,
                });
            if drops > 0 {
                s.stats.subscriber_drops += drops;
                s.stats.last_drop_ms = Some(now);
            }
            (frame, events, recording)
        };
        self.dispatch(events);
        if recording {
            if let Some(recorder) = self.recorder.get() {
                recorder.record_frame(frame.sequence, frame.received_monotonic_ms, &frame.frame);
            }
        }
    }
    pub fn subscribe(&self, capacity: usize) -> Result<Receiver<Arc<HubFrame>>, String> {
        let mut s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if !(1..=4096).contains(&capacity) || s.subscribers.len() >= 16 {
            return Err("Subscribers: max 16, queue capacity 1..4096".into());
        }
        let (sender, receiver) = mpsc::sync_channel(capacity);
        s.subscribers.push(sender);
        Ok(receiver)
    }
    pub fn latest(&self) -> Option<Arc<HubFrame>> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .recent
            .back()
            .cloned()
    }
    /// Arc handles only; callers process the copy after the short lock is released.
    pub fn recent(&self) -> Vec<Arc<HubFrame>> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .recent
            .iter()
            .cloned()
            .collect()
    }
    pub fn tick(&self, now: u64) {
        let events = {
            let mut s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            s.session.tick(now);
            s.session.take_events()
        };
        self.dispatch(events);
    }
    pub fn finish_session(&self, now: u64, reason: &str) {
        let events = {
            let mut s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            s.session.finish(now, reason);
            s.session.take_events()
        };
        self.dispatch(events);
    }
    pub fn session(&self) -> Option<Session> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .session
            .snapshot()
    }
    pub fn stats(&self) -> HubStats {
        let s = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut stats = s.stats.clone();
        stats.recent_frames = s.recent.len();
        stats.subscribers = s.subscribers.len();
        stats
    }
}
