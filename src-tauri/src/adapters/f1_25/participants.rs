//! Packet 4, Participants. `PacketParticipantsData` (1284 bytes): header (29),
//! `m_numActiveCars` (uint8), then `ParticipantData[22]` (57 bytes each).
//!
//! Privacy: this packet carries names ("the Steam Id on PC, or the LAN name")
//! and network identifiers. The decoder reads them because they are
//! documented fields, and nothing else in RaceLab keeps them: the recorder
//! copies out the player's team, race number and AI flag and drops the rest
//! (`f1_session::ParticipantContext`). No name or network id is persisted.
use super::{
    accepted_as, codes::TeamId, player_index, reader::Reader, DecodeError, PacketHeader,
    PacketKind, HEADER_SIZE, MAX_CARS,
};
use serde::Serialize;

pub const CAR_SIZE: usize = 57;
pub const CARS_OFFSET: usize = HEADER_SIZE + 1;
pub const NAME_BYTES: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct LiveryColour {
    pub red: u8,
    pub green: u8,
    pub blue: u8,
}

/// `ParticipantData`, field for field.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Participant {
    /// "Whether the vehicle is AI (1) or Human (0) controlled". Raw.
    pub ai_controlled: u8,
    /// "Driver id - see appendix, 255 if network human". Raw.
    pub driver_id: u8,
    /// "Network id – unique identifier for network players". Never persisted.
    pub network_id: u8,
    pub team_id: TeamId,
    /// "My team flag – 1 = My Team, 0 = otherwise". Raw.
    pub my_team: u8,
    pub race_number: u8,
    /// Appendix "Nationality IDs". Raw.
    pub nationality: u8,
    /// UTF-8 up to the first NUL, lossily decoded. Never persisted.
    pub name: String,
    /// "The player's UDP setting, 0 = restricted, 1 = public". Raw.
    pub your_telemetry: u8,
    /// "0 = off, 1 = on". Raw.
    pub show_online_names: u8,
    /// "F1 World tech level".
    pub tech_level: u16,
    /// "1 = Steam, 3 = PlayStation, 4 = Xbox, 6 = Origin, 255 = unknown". Raw.
    pub platform: u8,
    pub num_colours: u8,
    /// The first `min(num_colours, 4)` colours.
    pub livery_colours: Vec<LiveryColour>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ParticipantsPacket {
    /// "Number of active cars in the data – should match number of cars on
    /// HUD".
    pub num_active_cars: u8,
    /// `None` when `playerCarIndex` is not a valid car index.
    pub player: Option<Participant>,
}

pub fn car(bytes: &[u8], index: usize) -> Participant {
    debug_assert!(index < MAX_CARS);
    let mut r = Reader::new(bytes, CARS_OFFSET + index * CAR_SIZE);
    let ai_controlled = r.u8();
    let driver_id = r.u8();
    let network_id = r.u8();
    let team_id = TeamId::from_raw(r.u8());
    let my_team = r.u8();
    let race_number = r.u8();
    let nationality = r.u8();
    let raw_name: [u8; NAME_BYTES] = r.bytes();
    let end = raw_name.iter().position(|&b| b == 0).unwrap_or(NAME_BYTES);
    let name = String::from_utf8_lossy(&raw_name[..end]).into_owned();
    let your_telemetry = r.u8();
    let show_online_names = r.u8();
    let tech_level = r.u16();
    let platform = r.u8();
    let num_colours = r.u8();
    let mut livery_colours = Vec::new();
    for index in 0..4 {
        let colour = LiveryColour {
            red: r.u8(),
            green: r.u8(),
            blue: r.u8(),
        };
        if index < usize::from(num_colours) {
            livery_colours.push(colour);
        }
    }
    debug_assert_eq!(r.position(), CARS_OFFSET + (index + 1) * CAR_SIZE);
    Participant {
        ai_controlled,
        driver_id,
        network_id,
        team_id,
        my_team,
        race_number,
        nationality,
        name,
        your_telemetry,
        show_online_names,
        tech_level,
        platform,
        num_colours,
        livery_colours,
    }
}

pub fn decode(bytes: &[u8]) -> Result<(PacketHeader, ParticipantsPacket), DecodeError> {
    let header = accepted_as(bytes, PacketKind::Participants)?;
    Ok((
        header,
        ParticipantsPacket {
            num_active_cars: bytes[HEADER_SIZE],
            player: player_index(&header).map(|index| car(bytes, index)),
        },
    ))
}
