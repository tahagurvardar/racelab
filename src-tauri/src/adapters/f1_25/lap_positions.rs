//! Packet 15, Lap Positions. `PacketLapPositionsData` (1131 bytes): header
//! (29), `m_numLaps` (uint8), `m_lapStart` (uint8), then
//! `m_positionForVehicleIdx[50][22]` (uint8).
//!
//! "The lap positions data indicates which position each car was on at the
//! start of each lap ... only a maximum of 50 laps will be transmitted in a
//! packet. If more than 50 laps have occurred then two packets will be
//! transmitted, with different m_lapStart parameters." `m_lapStart` is "the
//! lap where the data starts, 0 indexed". A position of 0 means "no record".
use super::{
    accepted_as, reader::Reader, DecodeError, PacketHeader, PacketKind, HEADER_SIZE, MAX_CARS,
};
use serde::Serialize;

pub const MAX_LAPS: usize = 50;
pub const POSITIONS_OFFSET: usize = HEADER_SIZE + 2;

/// One row: the position of one car at the start of one lap.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct LapPosition {
    /// 0-indexed lap, as the packet counts: `m_lapStart` plus the row.
    pub lap_index: u16,
    /// 0 is the specification's "no record" and is never emitted here.
    pub position: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LapPositionsPacket {
    pub num_laps: u8,
    pub lap_start: u8,
    /// The player's column for the first `min(num_laps, 50)` rows, records
    /// only. Empty when `playerCarIndex` is not a valid car index.
    pub player: Vec<LapPosition>,
}

/// One car's column. Other cars' columns are not read by RaceLab.
pub fn column(bytes: &[u8], car: usize, num_laps: u8, lap_start: u8) -> Vec<LapPosition> {
    debug_assert!(car < MAX_CARS);
    (0..usize::from(num_laps).min(MAX_LAPS))
        .filter_map(|row| {
            let position = bytes[POSITIONS_OFFSET + row * MAX_CARS + car];
            (position != 0).then_some(LapPosition {
                lap_index: u16::from(lap_start) + row as u16,
                position,
            })
        })
        .collect()
}

pub fn decode(bytes: &[u8]) -> Result<(PacketHeader, LapPositionsPacket), DecodeError> {
    let header = accepted_as(bytes, PacketKind::LapPositions)?;
    let mut r = Reader::new(bytes, HEADER_SIZE);
    let num_laps = r.u8();
    let lap_start = r.u8();
    let player = super::player_index(&header)
        .map(|car| column(bytes, car, num_laps, lap_start))
        .unwrap_or_default();
    Ok((
        header,
        LapPositionsPacket {
            num_laps,
            lap_start,
            player,
        },
    ))
}
