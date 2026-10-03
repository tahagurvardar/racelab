//! F1 25 latest-value aggregation, V2.0 Phase B, extended in Phase D.
//!
//! Holds the latest accepted datagram of each family RaceLab decodes for one
//! `(sessionUID, playerCarIndex)` and nothing else: fixed-size slots, no
//! history, no allocation on the receive thread. Decoding happens when a
//! snapshot is read (the Live view and diagnostics poll at a few hertz, the
//! recorder at 10 Hz), not per datagram.
//!
//! Families arrive independently and are never presented as one frame: each
//! carries its own frame identifiers, session time and age.
//!
//! Rules, all explicit:
//! - A datagram whose `overallFrameIdentifier` is lower than the one already
//!   held for its family is out of order and is dropped (counted). The
//!   specification says that identifier "doesn't go back after flashbacks".
//! - A new `sessionUID` clears every slot. A new `playerCarIndex` within the
//!   same session clears every slot too, since every family held here is
//!   player data or player context. Each is counted separately.
//! - A late straggler from a previous session is indistinguishable from a
//!   new session and clears the slots; the next current packet clears them
//!   again. That transient is accepted rather than guessed around.
//! - Session History and Tyre Sets are sent "cycling through cars". Only the
//!   packet whose own `m_carIdx` is the player's car is held.
//! - Lap Positions sends up to two packets with different `m_lapStart`; one
//!   slot is held per 50-lap page.
//! - Events are not latest-value data. They go into a fixed ring of
//!   `EVENT_RING` slots with a sequence number; a reader asks for everything
//!   after its own cursor and is told how many it missed if the ring wrapped.
//!   Events are not cleared by a session change: each keeps its own header,
//!   and the reader attributes it by `sessionUID`.
use crate::adapters::f1_25::{
    car_status::{self, CarStatusPacket},
    car_telemetry::{self, CarTelemetryPacket},
    lap_data::{self, LapDataPacket},
    lap_positions,
    motion_ex::{self, MotionExPacket},
    session_history, tyre_sets, PacketHeader, PacketKind, MAX_CARS,
};
use serde::Serialize;
use std::time::Instant;

/// The largest held family, Session History.
pub const SLOT_BYTES: usize = 1460;
/// The four Phase B families shown live, in slot order.
pub const FAMILIES: [PacketKind; 4] = [
    PacketKind::CarTelemetry,
    PacketKind::CarStatus,
    PacketKind::LapData,
    PacketKind::MotionEx,
];
/// Phase D: the context families the recorder reads. Lap Positions is held
/// separately, per page.
pub const CONTEXT_FAMILIES: [PacketKind; 7] = [
    PacketKind::Session,
    PacketKind::Participants,
    PacketKind::FinalClassification,
    PacketKind::CarDamage,
    PacketKind::SessionHistory,
    PacketKind::TyreSets,
    PacketKind::TimeTrial,
];
const SLOTS: usize = FAMILIES.len() + CONTEXT_FAMILIES.len();
/// `m_lapStart` is a uint8, so at most six 50-lap pages exist.
pub const LAP_POSITION_PAGES: usize = 6;
/// Events held for a reader. At the recorder's 10 Hz read rate this is far
/// more than any session produces between two reads.
pub const EVENT_RING: usize = 256;
pub const EVENT_BYTES: usize = 45;

fn slot_index(kind: PacketKind) -> Option<usize> {
    FAMILIES
        .iter()
        .chain(CONTEXT_FAMILIES.iter())
        .position(|&family| family == kind)
}

#[derive(Clone)]
struct Slot {
    bytes: [u8; SLOT_BYTES],
    len: usize,
    header: PacketHeader,
    at: Instant,
    unix_ms: u64,
}

impl Slot {
    fn fill(
        slot: &mut Option<Slot>,
        header: &PacketHeader,
        bytes: &[u8],
        now: Instant,
        unix_ms: u64,
    ) {
        let held = slot.get_or_insert_with(|| Slot {
            bytes: [0; SLOT_BYTES],
            len: 0,
            header: *header,
            at: now,
            unix_ms,
        });
        held.bytes[..bytes.len()].copy_from_slice(bytes);
        held.len = bytes.len();
        held.header = *header;
        held.at = now;
        held.unix_ms = unix_ms;
    }
}

#[derive(Clone, Copy)]
struct EventSlot {
    sequence: u64,
    bytes: [u8; EVENT_BYTES],
    header: PacketHeader,
    at: Instant,
    unix_ms: u64,
}

/// A held datagram, copied out for fixture capture. Never sent to the UI.
#[derive(Debug, Clone)]
pub struct RawLatest {
    pub kind: PacketKind,
    pub bytes: Vec<u8>,
    pub header: PacketHeader,
    pub age_ms: u64,
}

/// A held datagram with its arrival time, for the recorder.
#[derive(Debug, Clone)]
pub struct HeldPacket {
    pub kind: PacketKind,
    pub bytes: Vec<u8>,
    pub header: PacketHeader,
    pub age_ms: u64,
    pub received_unix_ms: u64,
}

#[derive(Debug, Clone)]
pub struct HeldEvent {
    pub sequence: u64,
    pub bytes: Vec<u8>,
    pub header: PacketHeader,
    pub age_ms: u64,
    pub received_unix_ms: u64,
}

/// Everything the recorder reads in one lock: every held slot, and the
/// events after its cursor. Built on the reader's thread.
#[derive(Debug, Clone, Default)]
pub struct RecordingView {
    pub key: Option<(u64, u8)>,
    pub packets: Vec<HeldPacket>,
    pub events: Vec<HeldEvent>,
    /// Events the ring overwrote before this reader saw them.
    pub events_missed: u64,
    /// The cursor to pass next time.
    pub next_event_sequence: u64,
    pub out_of_order_dropped: u64,
    pub session_resets: u64,
    pub player_resets: u64,
}

impl RecordingView {
    pub fn packet(&self, kind: PacketKind) -> Option<&HeldPacket> {
        self.packets.iter().find(|packet| packet.kind == kind)
    }
}

pub struct F1Live {
    key: Option<(u64, u8)>,
    slots: [Option<Slot>; SLOTS],
    lap_position_pages: [Option<Slot>; LAP_POSITION_PAGES],
    events: [Option<EventSlot>; EVENT_RING],
    next_event_sequence: u64,
    session_resets: u64,
    player_resets: u64,
    out_of_order_dropped: u64,
}

impl Default for F1Live {
    fn default() -> Self {
        Self {
            key: None,
            slots: Default::default(),
            lap_position_pages: Default::default(),
            events: [None; EVENT_RING],
            next_event_sequence: 0,
            session_resets: 0,
            player_resets: 0,
            out_of_order_dropped: 0,
        }
    }
}

/// Summarised: the slots are raw datagrams and are never printed.
impl std::fmt::Debug for F1Live {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("F1Live")
            .field("key", &self.key)
            .field(
                "held",
                &self.slots.iter().map(Option::is_some).collect::<Vec<_>>(),
            )
            .field("next_event_sequence", &self.next_event_sequence)
            .field("session_resets", &self.session_resets)
            .field("player_resets", &self.player_resets)
            .field("out_of_order_dropped", &self.out_of_order_dropped)
            .finish()
    }
}

/// One family's latest value with its own provenance and freshness.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Fresh<P> {
    pub packet_id: u8,
    pub frame_identifier: u32,
    pub overall_frame_identifier: u32,
    pub session_time: f32,
    pub received_unix_ms: u64,
    pub age_ms: u64,
    pub value: P,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct F1LiveSnapshot {
    /// Decimal string: a uint64 does not survive a JavaScript number.
    pub session_uid: Option<String>,
    pub player_car_index: Option<u8>,
    /// False when `playerCarIndex` is not a valid car index; every family's
    /// `player` is then absent.
    pub player_available: bool,
    pub session_resets: u64,
    pub player_resets: u64,
    pub out_of_order_dropped: u64,
    pub car_telemetry: Option<Fresh<CarTelemetryPacket>>,
    pub car_status: Option<Fresh<CarStatusPacket>>,
    pub lap_data: Option<Fresh<LapDataPacket>>,
    pub motion_ex: Option<Fresh<MotionExPacket>>,
}

fn age(now: Instant, at: Instant) -> u64 {
    now.saturating_duration_since(at).as_millis() as u64
}

impl F1Live {
    /// Called for every **accepted** datagram, of any packet type: any of them
    /// can announce a new session or player index.
    pub fn observe(
        &mut self,
        kind: PacketKind,
        header: &PacketHeader,
        bytes: &[u8],
        now: Instant,
        unix_ms: u64,
    ) {
        let key = (header.session_uid, header.player_car_index);
        match self.key {
            Some((uid, _)) if uid != key.0 => {
                self.clear();
                self.session_resets = self.session_resets.saturating_add(1);
            }
            Some((_, player)) if player != key.1 => {
                self.clear();
                self.player_resets = self.player_resets.saturating_add(1);
            }
            _ => {}
        }
        self.key = Some(key);
        if bytes.len() > SLOT_BYTES {
            // Unreachable for an accepted packet; refuse rather than truncate.
            return;
        }
        if kind == PacketKind::Event {
            self.push_event(header, bytes, now, unix_ms);
            return;
        }
        // "Cycling through cars": hold the player's car only.
        let per_car_index = match kind {
            PacketKind::SessionHistory => Some(session_history::CAR_INDEX_OFFSET),
            PacketKind::TyreSets => Some(tyre_sets::CAR_INDEX_OFFSET),
            _ => None,
        };
        if let Some(offset) = per_car_index {
            if usize::from(header.player_car_index) >= MAX_CARS
                || bytes[offset] != header.player_car_index
            {
                return;
            }
        }
        let slot = if kind == PacketKind::LapPositions {
            let page =
                usize::from(bytes[lap_positions::POSITIONS_OFFSET - 1]) / lap_positions::MAX_LAPS;
            &mut self.lap_position_pages[page.min(LAP_POSITION_PAGES - 1)]
        } else {
            let Some(index) = slot_index(kind) else {
                return;
            };
            &mut self.slots[index]
        };
        if let Some(held) = slot.as_ref() {
            if header.overall_frame_identifier < held.header.overall_frame_identifier {
                self.out_of_order_dropped = self.out_of_order_dropped.saturating_add(1);
                return;
            }
        }
        Slot::fill(slot, header, bytes, now, unix_ms);
    }

    fn push_event(&mut self, header: &PacketHeader, bytes: &[u8], now: Instant, unix_ms: u64) {
        if bytes.len() != EVENT_BYTES {
            return;
        }
        let sequence = self.next_event_sequence;
        let mut held = [0; EVENT_BYTES];
        held.copy_from_slice(bytes);
        self.events[(sequence % EVENT_RING as u64) as usize] = Some(EventSlot {
            sequence,
            bytes: held,
            header: *header,
            at: now,
            unix_ms,
        });
        self.next_event_sequence = sequence.saturating_add(1);
    }

    fn clear(&mut self) {
        self.slots = Default::default();
        self.lap_position_pages = Default::default();
    }

    fn fresh<P>(
        &self,
        kind: PacketKind,
        now: Instant,
        decode: impl Fn(&[u8]) -> Option<P>,
    ) -> Option<Fresh<P>> {
        let slot = self.slots[slot_index(kind)?].as_ref()?;
        Some(Fresh {
            packet_id: kind.id(),
            frame_identifier: slot.header.frame_identifier,
            overall_frame_identifier: slot.header.overall_frame_identifier,
            session_time: slot.header.session_time,
            received_unix_ms: slot.unix_ms,
            age_ms: age(now, slot.at),
            value: decode(&slot.bytes[..slot.len])?,
        })
    }

    pub fn snapshot(&self, now: Instant) -> F1LiveSnapshot {
        F1LiveSnapshot {
            session_uid: self.key.map(|(uid, _)| uid.to_string()),
            player_car_index: self.key.map(|(_, player)| player),
            player_available: self
                .key
                .is_some_and(|(_, player)| usize::from(player) < MAX_CARS),
            session_resets: self.session_resets,
            player_resets: self.player_resets,
            out_of_order_dropped: self.out_of_order_dropped,
            car_telemetry: self.fresh(PacketKind::CarTelemetry, now, |b| {
                car_telemetry::decode(b).ok().map(|(_, p)| p)
            }),
            car_status: self.fresh(PacketKind::CarStatus, now, |b| {
                car_status::decode(b).ok().map(|(_, p)| p)
            }),
            lap_data: self.fresh(PacketKind::LapData, now, |b| {
                lap_data::decode(b).ok().map(|(_, p)| p)
            }),
            motion_ex: self.fresh(PacketKind::MotionEx, now, |b| {
                motion_ex::decode(b).ok().map(|(_, p)| p)
            }),
        }
    }

    /// Copies of the four Phase B datagrams, for development fixture capture
    /// only.
    pub fn raw_latest(&self, now: Instant) -> Vec<RawLatest> {
        FAMILIES
            .iter()
            .zip(&self.slots)
            .filter_map(|(&kind, slot)| {
                let slot = slot.as_ref()?;
                Some(RawLatest {
                    kind,
                    bytes: slot.bytes[..slot.len].to_vec(),
                    header: slot.header,
                    age_ms: age(now, slot.at),
                })
            })
            .collect()
    }

    /// The recorder's read: every held slot, and the events numbered
    /// `cursor` onwards. Copies bytes only; decoding is the caller's.
    pub fn recording_view(&self, now: Instant, cursor: u64) -> RecordingView {
        let held = |kind: PacketKind, slot: &Slot| HeldPacket {
            kind,
            bytes: slot.bytes[..slot.len].to_vec(),
            header: slot.header,
            age_ms: age(now, slot.at),
            received_unix_ms: slot.unix_ms,
        };
        let mut packets: Vec<HeldPacket> = FAMILIES
            .iter()
            .chain(CONTEXT_FAMILIES.iter())
            .zip(&self.slots)
            .filter_map(|(&kind, slot)| slot.as_ref().map(|slot| held(kind, slot)))
            .collect();
        packets.extend(
            self.lap_position_pages
                .iter()
                .flatten()
                .map(|slot| held(PacketKind::LapPositions, slot)),
        );
        let oldest = self.next_event_sequence.saturating_sub(EVENT_RING as u64);
        let start = cursor.max(oldest);
        let events = (start..self.next_event_sequence)
            .filter_map(|sequence| {
                let slot = self.events[(sequence % EVENT_RING as u64) as usize]?;
                (slot.sequence == sequence).then(|| HeldEvent {
                    sequence,
                    bytes: slot.bytes.to_vec(),
                    header: slot.header,
                    age_ms: age(now, slot.at),
                    received_unix_ms: slot.unix_ms,
                })
            })
            .collect();
        RecordingView {
            key: self.key,
            packets,
            events,
            events_missed: oldest.saturating_sub(cursor),
            next_event_sequence: self.next_event_sequence,
            out_of_order_dropped: self.out_of_order_dropped,
            session_resets: self.session_resets,
            player_resets: self.player_resets,
        }
    }
}
