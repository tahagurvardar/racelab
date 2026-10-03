//! Packet 8, Final Classification. `PacketFinalClassificationData` (1042
//! bytes): header (29), `m_numCars` (uint8), `FinalClassificationData[22]`
//! (46 bytes each).
//!
//! "Once at the end of a race." Not observed from the installed game yet: the
//! Phase A/B acceptance ran in Time Trial. The layout and size are from the
//! specification and are tested against synthetic packets only.
use super::{
    accepted_as,
    codes::{ActualTyreCompound, ResultReason, ResultStatus, VisualTyreCompound},
    player_index,
    reader::Reader,
    DecodeError, PacketHeader, PacketKind, HEADER_SIZE, MAX_CARS,
};
use serde::Serialize;

pub const CAR_SIZE: usize = 46;
pub const CARS_OFFSET: usize = HEADER_SIZE + 1;
pub const MAX_STINTS: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct ClassifiedStint {
    pub actual_compound: ActualTyreCompound,
    pub visual_compound: VisualTyreCompound,
    /// "The lap number stints end on".
    pub end_lap: u8,
}

/// `FinalClassificationData`, field for field.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Classification {
    pub position: u8,
    pub num_laps: u8,
    pub grid_position: u8,
    pub points: u8,
    pub num_pit_stops: u8,
    pub result_status: ResultStatus,
    pub result_reason: ResultReason,
    pub best_lap_time_ms: u32,
    /// "Total race time in seconds without penalties".
    pub total_race_time_s: f64,
    /// "Total penalties accumulated in seconds".
    pub penalties_time_s: u8,
    pub num_penalties: u8,
    pub num_tyre_stints: u8,
    /// The first `min(num_tyre_stints, 8)` stints.
    pub tyre_stints: Vec<ClassifiedStint>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FinalClassificationPacket {
    pub num_cars: u8,
    /// `None` when `playerCarIndex` is not a valid car index.
    pub player: Option<Classification>,
}

pub fn car(bytes: &[u8], index: usize) -> Classification {
    debug_assert!(index < MAX_CARS);
    let mut r = Reader::new(bytes, CARS_OFFSET + index * CAR_SIZE);
    let position = r.u8();
    let num_laps = r.u8();
    let grid_position = r.u8();
    let points = r.u8();
    let num_pit_stops = r.u8();
    let result_status = ResultStatus::from_raw(r.u8());
    let result_reason = ResultReason::from_raw(r.u8());
    let best_lap_time_ms = r.u32();
    let total_race_time_s = r.f64();
    let penalties_time_s = r.u8();
    let num_penalties = r.u8();
    let num_tyre_stints = r.u8();
    let actual: [u8; MAX_STINTS] = r.bytes();
    let visual: [u8; MAX_STINTS] = r.bytes();
    let end: [u8; MAX_STINTS] = r.bytes();
    debug_assert_eq!(r.position(), CARS_OFFSET + (index + 1) * CAR_SIZE);
    let tyre_stints = (0..usize::from(num_tyre_stints).min(MAX_STINTS))
        .map(|stint| ClassifiedStint {
            actual_compound: ActualTyreCompound::from_raw(actual[stint]),
            visual_compound: VisualTyreCompound::from_raw(visual[stint]),
            end_lap: end[stint],
        })
        .collect();
    Classification {
        position,
        num_laps,
        grid_position,
        points,
        num_pit_stops,
        result_status,
        result_reason,
        best_lap_time_ms,
        total_race_time_s,
        penalties_time_s,
        num_penalties,
        num_tyre_stints,
        tyre_stints,
    }
}

pub fn decode(bytes: &[u8]) -> Result<(PacketHeader, FinalClassificationPacket), DecodeError> {
    let header = accepted_as(bytes, PacketKind::FinalClassification)?;
    Ok((
        header,
        FinalClassificationPacket {
            num_cars: bytes[HEADER_SIZE],
            player: player_index(&header).map(|index| car(bytes, index)),
        },
    ))
}
