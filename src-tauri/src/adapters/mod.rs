//! Game adapters. Each game owns its byte layout here and nothing else does.
//!
//! The boundary is deliberately per game, not one generic trait:
//!
//! - `fh6` decodes into canonical `telemetry::TelemetryFrame` and is driven by
//!   `protocol::ProtocolDetector` on the FH6 listener. Unchanged since V1.1.
//! - `f1_25` (V2.0 Phase A) classifies headers and packet sizes only. It has
//!   its own listener and its own evidence sink (`f1_evidence`), produces no
//!   canonical frame, and is never seen by the detector, the hub, the
//!   recorder or analysis.
//!
//! A future game gets its own module and its own port. Games never share a
//! socket, so one game's traffic cannot be misclassified as another's.
pub mod f1_25;
pub mod fh6;
