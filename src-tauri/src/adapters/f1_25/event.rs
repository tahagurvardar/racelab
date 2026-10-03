//! Packet 3, Event. `PacketEventData` (45 bytes): header (29),
//! `m_eventStringCode[4]`, then the 12-byte `EventDataDetails` union.
//!
//! "The event details packet is different for each type of event. Make sure
//! only the correct type is interpreted." Only the union member belonging to
//! the received code is read; every other byte of the union is ignored. A
//! code the specification does not list is kept as its four raw bytes and its
//! details are not interpreted at all.
use super::{
    accepted_as,
    codes::{
        DrsDisabledReason, InfringementType, PenaltyType, ResultReason, SafetyCarEventType,
        SafetyCarStatus,
    },
    reader::Reader,
    DecodeError, PacketHeader, PacketKind, HEADER_SIZE,
};
use serde::Serialize;

pub const DETAILS_OFFSET: usize = HEADER_SIZE + 4;
pub const DETAILS_SIZE: usize = 12;

/// One decoded event. Vehicle indices are the packet's own and are not
/// resolved to anybody here.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EventDetails {
    /// "SSTA"
    SessionStarted,
    /// "SEND"
    SessionEnded,
    /// "FTLP". `lap_time_s`: "Lap time is in seconds".
    FastestLap { vehicle_idx: u8, lap_time_s: f32 },
    /// "RTMT"
    Retirement {
        vehicle_idx: u8,
        reason: ResultReason,
    },
    /// "DRSE"
    DrsEnabled,
    /// "DRSD"
    DrsDisabled { reason: DrsDisabledReason },
    /// "TMPT"
    TeamMateInPits { vehicle_idx: u8 },
    /// "CHQF"
    ChequeredFlag,
    /// "RCWN"
    RaceWinner { vehicle_idx: u8 },
    /// "PENA". `time_s`: "Time gained, or time spent doing action in
    /// seconds".
    Penalty {
        penalty_type: PenaltyType,
        infringement_type: InfringementType,
        vehicle_idx: u8,
        other_vehicle_idx: u8,
        time_s: u8,
        lap_num: u8,
        places_gained: u8,
    },
    /// "SPTP". Speeds in kilometres per hour. The two flags are "= 1,
    /// otherwise 0" in the specification and stay raw.
    SpeedTrap {
        vehicle_idx: u8,
        speed_kmh: f32,
        is_overall_fastest_in_session: u8,
        is_driver_fastest_in_session: u8,
        fastest_vehicle_idx_in_session: u8,
        fastest_speed_in_session_kmh: f32,
    },
    /// "STLG"
    StartLights { num_lights: u8 },
    /// "LGOT"
    LightsOut,
    /// "DTSV"
    DriveThroughServed { vehicle_idx: u8 },
    /// "SGSV". `stop_time_s`: "Time spent serving stop go in seconds".
    StopGoServed { vehicle_idx: u8, stop_time_s: f32 },
    /// "FLBK"
    Flashback {
        flashback_frame_identifier: u32,
        flashback_session_time: f32,
    },
    /// "BUTN": bit flags, appendix "Button flags".
    Buttons { button_status: u32 },
    /// "RDFL"
    RedFlag,
    /// "OVTK"
    Overtake {
        overtaking_vehicle_idx: u8,
        being_overtaken_vehicle_idx: u8,
    },
    /// "SCAR"
    SafetyCar {
        safety_car_type: SafetyCarStatus,
        event_type: SafetyCarEventType,
    },
    /// "COLL"
    Collision { vehicle1_idx: u8, vehicle2_idx: u8 },
    /// A code the specification does not list. Its details are not read.
    Unknown,
}

impl EventDetails {
    /// Vehicle indices the event names, in the order the packet gives them.
    pub fn vehicles(&self) -> Vec<u8> {
        match *self {
            Self::FastestLap { vehicle_idx, .. }
            | Self::Retirement { vehicle_idx, .. }
            | Self::TeamMateInPits { vehicle_idx }
            | Self::RaceWinner { vehicle_idx }
            | Self::SpeedTrap { vehicle_idx, .. }
            | Self::DriveThroughServed { vehicle_idx }
            | Self::StopGoServed { vehicle_idx, .. } => vec![vehicle_idx],
            Self::Penalty {
                vehicle_idx,
                other_vehicle_idx,
                ..
            } => vec![vehicle_idx, other_vehicle_idx],
            Self::Overtake {
                overtaking_vehicle_idx,
                being_overtaken_vehicle_idx,
            } => vec![overtaking_vehicle_idx, being_overtaken_vehicle_idx],
            Self::Collision {
                vehicle1_idx,
                vehicle2_idx,
            } => vec![vehicle1_idx, vehicle2_idx],
            _ => Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct EventPacket {
    /// `m_eventStringCode`, exactly as sent.
    pub code: [u8; 4],
    pub details: EventDetails,
}

impl EventPacket {
    /// The four code bytes as text when they are printable ASCII, which every
    /// documented code is; otherwise their hexadecimal form.
    pub fn code_text(&self) -> String {
        code_text(self.code)
    }
}

pub fn code_text(code: [u8; 4]) -> String {
    if code.iter().all(|b| b.is_ascii_graphic()) {
        code.iter().map(|&b| char::from(b)).collect()
    } else {
        code.iter().map(|b| format!("{b:02x}")).collect()
    }
}

pub fn decode(bytes: &[u8]) -> Result<(PacketHeader, EventPacket), DecodeError> {
    let header = accepted_as(bytes, PacketKind::Event)?;
    let mut r = Reader::new(bytes, HEADER_SIZE);
    let code: [u8; 4] = r.bytes();
    let details: [u8; DETAILS_SIZE] = r.bytes();
    debug_assert_eq!(r.position(), bytes.len());
    Ok((
        header,
        EventPacket {
            code,
            details: decode_details(code, details),
        },
    ))
}

/// The union member belonging to `code`, read from the 12 detail bytes.
/// Shared by the live path and by stored events, which keep these bytes.
pub fn decode_details(code: [u8; 4], details: [u8; DETAILS_SIZE]) -> EventDetails {
    let mut r = Reader::new(&details, 0);
    match &code {
        b"SSTA" => EventDetails::SessionStarted,
        b"SEND" => EventDetails::SessionEnded,
        b"FTLP" => EventDetails::FastestLap {
            vehicle_idx: r.u8(),
            lap_time_s: r.f32(),
        },
        b"RTMT" => EventDetails::Retirement {
            vehicle_idx: r.u8(),
            reason: ResultReason::from_raw(r.u8()),
        },
        b"DRSE" => EventDetails::DrsEnabled,
        b"DRSD" => EventDetails::DrsDisabled {
            reason: DrsDisabledReason::from_raw(r.u8()),
        },
        b"TMPT" => EventDetails::TeamMateInPits {
            vehicle_idx: r.u8(),
        },
        b"CHQF" => EventDetails::ChequeredFlag,
        b"RCWN" => EventDetails::RaceWinner {
            vehicle_idx: r.u8(),
        },
        b"PENA" => EventDetails::Penalty {
            penalty_type: PenaltyType::from_raw(r.u8()),
            infringement_type: InfringementType::from_raw(r.u8()),
            vehicle_idx: r.u8(),
            other_vehicle_idx: r.u8(),
            time_s: r.u8(),
            lap_num: r.u8(),
            places_gained: r.u8(),
        },
        b"SPTP" => EventDetails::SpeedTrap {
            vehicle_idx: r.u8(),
            speed_kmh: r.f32(),
            is_overall_fastest_in_session: r.u8(),
            is_driver_fastest_in_session: r.u8(),
            fastest_vehicle_idx_in_session: r.u8(),
            fastest_speed_in_session_kmh: r.f32(),
        },
        b"STLG" => EventDetails::StartLights { num_lights: r.u8() },
        b"LGOT" => EventDetails::LightsOut,
        b"DTSV" => EventDetails::DriveThroughServed {
            vehicle_idx: r.u8(),
        },
        b"SGSV" => EventDetails::StopGoServed {
            vehicle_idx: r.u8(),
            stop_time_s: r.f32(),
        },
        b"FLBK" => EventDetails::Flashback {
            flashback_frame_identifier: r.u32(),
            flashback_session_time: r.f32(),
        },
        b"BUTN" => EventDetails::Buttons {
            button_status: r.u32(),
        },
        b"RDFL" => EventDetails::RedFlag,
        b"OVTK" => EventDetails::Overtake {
            overtaking_vehicle_idx: r.u8(),
            being_overtaken_vehicle_idx: r.u8(),
        },
        b"SCAR" => EventDetails::SafetyCar {
            safety_car_type: SafetyCarStatus::from_raw(r.u8()),
            event_type: SafetyCarEventType::from_raw(r.u8()),
        },
        b"COLL" => EventDetails::Collision {
            vehicle1_idx: r.u8(),
            vehicle2_idx: r.u8(),
        },
        _ => EventDetails::Unknown,
    }
}
