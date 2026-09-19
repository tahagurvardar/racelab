//! Application lifecycle; deliberately outside the frozen UDP implementation.
use crate::{
    ingress::{Listener, ReceiveBuffer, StatsSnapshot},
    live_telemetry::{ConnectionConfig, LiveTelemetrySink},
    packet::PacketSink,
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

pub const DEFAULT_FH6_PORT: u16 = 20440;
pub struct Appliance {
    pub listener: Arc<Listener>,
    pub live: Arc<LiveTelemetrySink>,
    lifecycle: Mutex<()>,
    requested: AtomicBool,
    startup_port: u16,
}
impl Appliance {
    pub fn new(
        capture: Arc<dyn PacketSink>,
        config: ConnectionConfig,
        startup_port: u16,
    ) -> Result<Self, String> {
        let mut id = [0; 16];
        getrandom::fill(&mut id).map_err(|e| e.to_string())?;
        let instance_id = id.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let live = Arc::new(LiveTelemetrySink::with_config(
            capture,
            config,
            instance_id,
        )?);
        let listener = Arc::new(Listener::new(ReceiveBuffer::default(), Some(live.clone())));
        Ok(Self {
            listener,
            live,
            lifecycle: Mutex::new(()),
            requested: AtomicBool::new(true),
            startup_port,
        })
    }
    /// Run by the app's background supervisor, not by the UI/setup thread.
    pub fn automatic_start(&self) -> Result<StatsSnapshot, String> {
        let _guard = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        if !self.requested.load(Ordering::Acquire) || self.listener.snapshot().running {
            return Ok(self.listener.snapshot());
        }
        self.start_inner(self.startup_port)
    }
    pub fn start(&self, port: u16) -> Result<StatsSnapshot, String> {
        self.requested.store(true, Ordering::Release);
        let _guard = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        if self.listener.snapshot().running {
            return self.listener.start(port);
        }
        self.start_inner(port)
    }
    fn start_inner(&self, port: u16) -> Result<StatsSnapshot, String> {
        self.live.begin_start();
        match self.listener.start(port) {
            Ok(stats) => {
                self.live.listener_ready();
                Ok(stats)
            }
            Err(error) => {
                self.live.transport_failed(error.clone());
                Err(error)
            }
        }
    }
    pub fn stop(&self) -> Result<StatsSnapshot, String> {
        self.requested.store(false, Ordering::Release);
        let _guard = self.lifecycle.lock().unwrap_or_else(|e| e.into_inner());
        let stats = self.listener.stop()?;
        self.live.stop();
        Ok(stats)
    }
    pub fn tick(&self) {
        // Skip observation during bind/join; a stale transport snapshot must not
        // overwrite an in-progress lifecycle transition. Never wait on disk/UI.
        if let Ok(_guard) = self.lifecycle.try_lock() {
            self.live.observe_transport(&self.listener.snapshot());
        }
        let _ = self.live.snapshot();
    }
}
