//! F1 25 UDP, Phase A: the common `PacketHeader` and packet-size
//! classification only. No payload byte beyond the header is read.
//!
//! Protocol authority: "Data Output from F1 25 Game" v3 (EA, 2025). That
//! document states every value is little endian and every structure packed,
//! defines the 29-byte header below, numbers packet types 0..=15, gives one
//! fixed size per packet type, and says every packet type's version "starts
//! from 1".
//!
//! Live evidence: eleven of the sixteen sizes were also observed on the
//! user's installed game with UDP Format 2025 (header `packetFormat=2025`,
//! `gameYear=25`, `packetVersion=1`). The remaining five are taken from the
//! specification alone and are labelled as such (`SizeEvidence::SpecOnly`).
//!
//! This module is the only place in RaceLab that knows an F1 byte offset. It
//! produces no `TelemetryFrame`: F1 data is not canonical telemetry yet.
use serde::Serialize;

/// The port F1 25 sends to by default, and the one the user configured.
pub const DEFAULT_PORT: u16 = 20777;
/// `m_packetFormat` for UDP Format "2025". F1 25 can also emit the 2024 and
/// 2023 formats; those are rejected here, not reinterpreted.
pub const PACKET_FORMAT: u16 = 2025;
pub const GAME_YEAR: u8 = 25;
/// "Version of this packet type, all start from 1." The only version any
/// packet type has been observed at, and the only one the sizes below
/// describe.
pub const SUPPORTED_PACKET_VERSION: u8 = 1;
pub const HEADER_SIZE: usize = 29;

/// Header field offsets, from the packed little-endian `PacketHeader`.
pub mod offset {
    pub const PACKET_FORMAT: usize = 0; // uint16
    pub const GAME_YEAR: usize = 2; // uint8
    pub const GAME_MAJOR_VERSION: usize = 3; // uint8
    pub const GAME_MINOR_VERSION: usize = 4; // uint8
    pub const PACKET_VERSION: usize = 5; // uint8
    pub const PACKET_ID: usize = 6; // uint8
    pub const SESSION_UID: usize = 7; // uint64
    pub const SESSION_TIME: usize = 15; // float
    pub const FRAME_IDENTIFIER: usize = 19; // uint32
    pub const OVERALL_FRAME_IDENTIFIER: usize = 23; // uint32
    pub const PLAYER_CAR_INDEX: usize = 27; // uint8
    pub const SECONDARY_PLAYER_CAR_INDEX: usize = 28; // uint8
}

/// Where a packet type's expected size comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SizeEvidence {
    /// The specification's size, also observed from the installed game.
    SpecAndLive,
    /// The specification's size; not yet observed from the installed game.
    SpecOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PacketKind {
    Motion,
    Session,
    LapData,
    Event,
    Participants,
    CarSetups,
    CarTelemetry,
    CarStatus,
    FinalClassification,
    LobbyInfo,
    CarDamage,
    SessionHistory,
    TyreSets,
    MotionEx,
    TimeTrial,
    LapPositions,
}

impl PacketKind {
    /// Indexed by packet ID.
    pub const ALL: [PacketKind; 16] = [
        PacketKind::Motion,
        PacketKind::Session,
        PacketKind::LapData,
        PacketKind::Event,
        PacketKind::Participants,
        PacketKind::CarSetups,
        PacketKind::CarTelemetry,
        PacketKind::CarStatus,
        PacketKind::FinalClassification,
        PacketKind::LobbyInfo,
        PacketKind::CarDamage,
        PacketKind::SessionHistory,
        PacketKind::TyreSets,
        PacketKind::MotionEx,
        PacketKind::TimeTrial,
        PacketKind::LapPositions,
    ];

    pub fn from_id(id: u8) -> Option<Self> {
        Self::ALL.get(usize::from(id)).copied()
    }

    pub fn id(self) -> u8 {
        self as u8
    }

    /// The specification's packet name.
    pub fn name(self) -> &'static str {
        match self {
            PacketKind::Motion => "Motion",
            PacketKind::Session => "Session",
            PacketKind::LapData => "Lap Data",
            PacketKind::Event => "Event",
            PacketKind::Participants => "Participants",
            PacketKind::CarSetups => "Car Setups",
            PacketKind::CarTelemetry => "Car Telemetry",
            PacketKind::CarStatus => "Car Status",
            PacketKind::FinalClassification => "Final Classification",
            PacketKind::LobbyInfo => "Lobby Info",
            PacketKind::CarDamage => "Car Damage",
            PacketKind::SessionHistory => "Session History",
            PacketKind::TyreSets => "Tyre Sets",
            PacketKind::MotionEx => "Motion Ex",
            PacketKind::TimeTrial => "Time Trial",
            PacketKind::LapPositions => "Lap Positions",
        }
    }

    /// The exact datagram size, header included, for packet version 1 of
    /// UDP Format 2025. Every F1 25 packet type is fixed-size.
    pub fn expected_size(self) -> usize {
        match self {
            PacketKind::Motion => 1349,
            PacketKind::Session => 753,
            PacketKind::LapData => 1285,
            PacketKind::Event => 45,
            PacketKind::Participants => 1284,
            PacketKind::CarSetups => 1133,
            PacketKind::CarTelemetry => 1352,
            PacketKind::CarStatus => 1239,
            PacketKind::FinalClassification => 1042,
            PacketKind::LobbyInfo => 954,
            PacketKind::CarDamage => 1041,
            PacketKind::SessionHistory => 1460,
            PacketKind::TyreSets => 231,
            PacketKind::MotionEx => 273,
            PacketKind::TimeTrial => 101,
            PacketKind::LapPositions => 1131,
        }
    }

    pub fn size_evidence(self) -> SizeEvidence {
        match self {
            PacketKind::Participants
            | PacketKind::FinalClassification
            | PacketKind::LobbyInfo
            | PacketKind::TimeTrial
            | PacketKind::LapPositions => SizeEvidence::SpecOnly,
            _ => SizeEvidence::SpecAndLive,
        }
    }
}

/// The common header, decoded exactly as the specification types it.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct PacketHeader {
    pub packet_format: u16,
    pub game_year: u8,
    pub game_major_version: u8,
    pub game_minor_version: u8,
    pub packet_version: u8,
    pub packet_id: u8,
    pub session_uid: u64,
    pub session_time: f32,
    pub frame_identifier: u32,
    pub overall_frame_identifier: u32,
    pub player_car_index: u8,
    /// 255 when there is no second player.
    pub secondary_player_car_index: u8,
}

fn array<const N: usize>(bytes: &[u8], at: usize) -> [u8; N] {
    bytes[at..at + N]
        .try_into()
        .expect("length checked by caller")
}

/// `None` when the datagram is shorter than a header. Reads nothing past
/// byte 28.
pub fn parse_header(bytes: &[u8]) -> Option<PacketHeader> {
    if bytes.len() < HEADER_SIZE {
        return None;
    }
    Some(PacketHeader {
        packet_format: u16::from_le_bytes(array(bytes, offset::PACKET_FORMAT)),
        game_year: bytes[offset::GAME_YEAR],
        game_major_version: bytes[offset::GAME_MAJOR_VERSION],
        game_minor_version: bytes[offset::GAME_MINOR_VERSION],
        packet_version: bytes[offset::PACKET_VERSION],
        packet_id: bytes[offset::PACKET_ID],
        session_uid: u64::from_le_bytes(array(bytes, offset::SESSION_UID)),
        session_time: f32::from_le_bytes(array(bytes, offset::SESSION_TIME)),
        frame_identifier: u32::from_le_bytes(array(bytes, offset::FRAME_IDENTIFIER)),
        overall_frame_identifier: u32::from_le_bytes(array(
            bytes,
            offset::OVERALL_FRAME_IDENTIFIER,
        )),
        player_car_index: bytes[offset::PLAYER_CAR_INDEX],
        secondary_player_car_index: bytes[offset::SECONDARY_PLAYER_CAR_INDEX],
    })
}

/// Why a datagram is not an F1 25 / Format 2025 packet RaceLab can vouch for.
/// Checked in this order; the first failure is reported.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "reason", rename_all = "snake_case")]
pub enum Rejection {
    /// Shorter than the 29-byte header.
    Truncated {
        size: usize,
    },
    /// Not Format 2025 — e.g. the game set to UDP Format 2024 or 2023, or not
    /// F1 traffic at all.
    WrongPacketFormat {
        found: u16,
    },
    WrongGameYear {
        found: u8,
    },
    UnknownPacketId {
        found: u8,
    },
    UnsupportedPacketVersion {
        kind: PacketKind,
        found: u8,
    },
    SizeMismatch {
        kind: PacketKind,
        expected: usize,
        observed: usize,
    },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Classification {
    Accepted {
        kind: PacketKind,
        header: PacketHeader,
    },
    Rejected {
        /// Present whenever the datagram was long enough to hold one. It is
        /// not trustworthy: it is kept for counting, never for display as
        /// "current" values.
        header: Option<PacketHeader>,
        rejection: Rejection,
    },
}

pub fn classify(bytes: &[u8]) -> Classification {
    let Some(header) = parse_header(bytes) else {
        return Classification::Rejected {
            header: None,
            rejection: Rejection::Truncated { size: bytes.len() },
        };
    };
    let rejected = |rejection| Classification::Rejected {
        header: Some(header),
        rejection,
    };
    if header.packet_format != PACKET_FORMAT {
        return rejected(Rejection::WrongPacketFormat {
            found: header.packet_format,
        });
    }
    if header.game_year != GAME_YEAR {
        return rejected(Rejection::WrongGameYear {
            found: header.game_year,
        });
    }
    let Some(kind) = PacketKind::from_id(header.packet_id) else {
        return rejected(Rejection::UnknownPacketId {
            found: header.packet_id,
        });
    };
    if header.packet_version != SUPPORTED_PACKET_VERSION {
        return rejected(Rejection::UnsupportedPacketVersion {
            kind,
            found: header.packet_version,
        });
    }
    if bytes.len() != kind.expected_size() {
        return rejected(Rejection::SizeMismatch {
            kind,
            expected: kind.expected_size(),
            observed: bytes.len(),
        });
    }
    Classification::Accepted { kind, header }
}

// --------------------------------------------------------------------------
// Phase B: typed payload decoding
// --------------------------------------------------------------------------

pub mod car_status;
pub mod car_telemetry;
pub mod codes;
pub mod lap_data;
pub mod motion_ex;
mod reader;

// Phase D: the session, result and history families recording needs.
pub mod car_damage;
pub mod event;
pub mod final_classification;
pub mod lap_positions;
pub mod participants;
pub mod session;
pub mod session_history;
pub mod time_trial;
pub mod tyre_sets;

/// "The maximum number of cars in the data structures is 22."
pub const MAX_CARS: usize = 22;

/// The player's slot in a per-car array, or `None` when `playerCarIndex` is
/// not a valid index (255 and other out-of-range values, e.g. spectating).
/// Never falls back to index 0.
pub fn player_index(header: &PacketHeader) -> Option<usize> {
    let index = usize::from(header.player_car_index);
    (index < MAX_CARS).then_some(index)
}

/// Every F1 25 wheel array is "in the following order: 0 Rear Left (RL),
/// 1 Rear Right (RR), 2 Front Left (FL), 3 Front Right (FR)". This is not the
/// FH6 order; corners are named here so nothing downstream indexes a wheel.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, serde::Deserialize)]
pub struct Wheels<T> {
    pub rear_left: T,
    pub rear_right: T,
    pub front_left: T,
    pub front_right: T,
}

impl<T: Copy> Wheels<T> {
    /// `source` in wire order: RL, RR, FL, FR.
    pub fn from_wire(source: [T; 4]) -> Self {
        Self {
            rear_left: source[0],
            rear_right: source[1],
            front_left: source[2],
            front_right: source[3],
        }
    }
}

/// Why a payload was not decoded. Decoding only ever runs on a datagram the
/// Phase A classifier accepts as exactly the requested packet type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "reason", rename_all = "snake_case")]
pub enum DecodeError {
    Rejected {
        rejection: Rejection,
    },
    WrongPacket {
        expected: PacketKind,
        found: PacketKind,
    },
}

pub(crate) fn accepted_as(bytes: &[u8], expected: PacketKind) -> Result<PacketHeader, DecodeError> {
    match classify(bytes) {
        Classification::Accepted { kind, header } if kind == expected => Ok(header),
        Classification::Accepted { kind, .. } => Err(DecodeError::WrongPacket {
            expected,
            found: kind,
        }),
        Classification::Rejected { rejection, .. } => Err(DecodeError::Rejected { rejection }),
    }
}
