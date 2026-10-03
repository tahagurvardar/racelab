//! Packet 12, Tyre Sets. `PacketTyreSetsData` (231 bytes): header (29),
//! `m_carIdx` (uint8), `TyreSetData[20]` (10 bytes each, "13 (dry) + 7
//! (wet)"), `m_fittedIdx` (uint8).
//!
//! Like Session History, each packet is for one car, cycled through. No
//! value here is judged: wear is a percentage and life is laps, as sent.
use super::{
    accepted_as,
    codes::{ActualTyreCompound, SessionType, VisualTyreCompound},
    reader::Reader,
    DecodeError, PacketHeader, PacketKind, HEADER_SIZE,
};
use serde::Serialize;

pub const SETS: usize = 20;
pub const SET_SIZE: usize = 10;
pub const CAR_INDEX_OFFSET: usize = HEADER_SIZE;

/// `TyreSetData`, field for field.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct TyreSet {
    pub actual_compound: ActualTyreCompound,
    pub visual_compound: VisualTyreCompound,
    /// "Tyre wear (percentage)".
    pub wear_percent: u8,
    /// "Whether this set is currently available". Raw.
    pub available: u8,
    /// "Recommended session for tyre set, see appendix".
    pub recommended_session: SessionType,
    /// "Laps left in this tyre set".
    pub life_span_laps: u8,
    /// "Max number of laps recommended for this compound".
    pub usable_life_laps: u8,
    /// "Lap delta time in milliseconds compared to fitted set".
    pub lap_delta_time_ms: i16,
    /// "Whether the set is fitted or not". Raw.
    pub fitted: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TyreSetsPacket {
    pub car_idx: u8,
    /// All twenty sets, in packet order.
    pub sets: Vec<TyreSet>,
    /// "Index into array of fitted tyre".
    pub fitted_idx: u8,
}

pub fn decode(bytes: &[u8]) -> Result<(PacketHeader, TyreSetsPacket), DecodeError> {
    let header = accepted_as(bytes, PacketKind::TyreSets)?;
    let mut r = Reader::new(bytes, HEADER_SIZE);
    let car_idx = r.u8();
    let sets = (0..SETS)
        .map(|_| TyreSet {
            actual_compound: ActualTyreCompound::from_raw(r.u8()),
            visual_compound: VisualTyreCompound::from_raw(r.u8()),
            wear_percent: r.u8(),
            available: r.u8(),
            recommended_session: SessionType::from_raw(r.u8()),
            life_span_laps: r.u8(),
            usable_life_laps: r.u8(),
            lap_delta_time_ms: r.i16(),
            fitted: r.u8(),
        })
        .collect();
    let fitted_idx = r.u8();
    debug_assert_eq!(r.position(), bytes.len());
    Ok((
        header,
        TyreSetsPacket {
            car_idx,
            sets,
            fitted_idx,
        },
    ))
}
