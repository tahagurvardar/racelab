//! The transport/consumer boundary. Consumers need no knowledge of UDP internals.
use std::net::SocketAddr;

/// Borrowed for the duration of `PacketSink::on_packet`; copy only if retaining it.
#[derive(Debug)]
pub struct CapturedPacket<'a> {
    pub bytes: &'a [u8],
    pub source: SocketAddr,
    /// Unix wall-clock milliseconds, for display/logging only.
    pub received_at_ms: u64,
    /// Monotonic microseconds since this listener session started.
    pub captured_at_us: u64,
}

/// Called synchronously on the receive thread, after authoritative statistics
/// have been updated and their lock released. Implementations must return promptly,
/// must not call listener lifecycle methods, and must not perform blocking I/O.
/// Expensive consumers must hand off through their own bounded queue with an
/// explicit overflow policy. A composite sink can fan out to multiple adapters.
/// Sink panics detach that sink for the session and surface through `last_error`.
pub trait PacketSink: Send + Sync {
    fn on_packet(&self, packet: &CapturedPacket<'_>);
}
