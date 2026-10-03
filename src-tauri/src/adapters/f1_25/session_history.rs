//! Packet 11, Session History. `PacketSessionHistoryData` (1460 bytes):
//! header (29), seven uint8 fields, `LapHistoryData[100]` (14 bytes each),
//! `TyreStintHistoryData[8]` (3 bytes each).
//!
//! "Each packet relates to a specific vehicle and is sent every 1/20 s, and
//! the vehicle being sent is cycled through." The car is `m_carIdx`, not the
//! header's player index: callers decide whether the car is the player.
use super::{
    accepted_as,
    codes::{ActualTyreCompound, VisualTyreCompound},
    lap_data::SplitTime,
    reader::Reader,
    DecodeError, PacketHeader, PacketKind, HEADER_SIZE,
};
use serde::Serialize;

pub const MAX_LAPS: usize = 100;
pub const MAX_STINTS: usize = 8;
pub const LAP_SIZE: usize = 14;
pub const STINT_SIZE: usize = 3;
pub const LAPS_OFFSET: usize = HEADER_SIZE + 7;
pub const STINTS_OFFSET: usize = LAPS_OFFSET + MAX_LAPS * LAP_SIZE;
/// The byte holding `m_carIdx`, readable without decoding the rest.
pub const CAR_INDEX_OFFSET: usize = HEADER_SIZE;

/// `m_lapValidBitFlags`: "0x01 bit set-lap valid, 0x02 bit set-sector 1
/// valid, 0x04 bit set-sector 2 valid, 0x08 bit set-sector 3 valid".
pub mod valid_bits {
    pub const LAP: u8 = 0x01;
    pub const SECTOR1: u8 = 0x02;
    pub const SECTOR2: u8 = 0x04;
    pub const SECTOR3: u8 = 0x08;
}

/// `LapHistoryData`, field for field. Validity is the raw bit field plus the
/// four documented bits read out; undocumented bits are kept in the raw value.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct LapHistory {
    pub lap_time_ms: u32,
    pub sector1: SplitTime,
    pub sector2: SplitTime,
    pub sector3: SplitTime,
    pub lap_valid_bit_flags: u8,
    pub lap_valid: bool,
    pub sector1_valid: bool,
    pub sector2_valid: bool,
    pub sector3_valid: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct TyreStintHistory {
    /// "Lap the tyre usage ends on (255 of current tyre)".
    pub end_lap: u8,
    pub actual_compound: ActualTyreCompound,
    pub visual_compound: VisualTyreCompound,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SessionHistoryPacket {
    pub car_idx: u8,
    /// "Num laps in the data (including current partial lap)".
    pub num_laps: u8,
    pub num_tyre_stints: u8,
    pub best_lap_time_lap_num: u8,
    pub best_sector1_lap_num: u8,
    pub best_sector2_lap_num: u8,
    pub best_sector3_lap_num: u8,
    /// The first `min(num_laps, 100)` entries, index 0 being lap 1.
    pub laps: Vec<LapHistory>,
    /// The first `min(num_tyre_stints, 8)` entries.
    pub tyre_stints: Vec<TyreStintHistory>,
}

fn split(r: &mut Reader<'_>) -> SplitTime {
    let ms_part = r.u16();
    let minutes_part = r.u8();
    SplitTime {
        ms_part,
        minutes_part,
        total_ms: u32::from(minutes_part) * 60_000 + u32::from(ms_part),
    }
}

fn lap(r: &mut Reader<'_>) -> LapHistory {
    let lap_time_ms = r.u32();
    let sector1 = split(r);
    let sector2 = split(r);
    let sector3 = split(r);
    let flags = r.u8();
    LapHistory {
        lap_time_ms,
        sector1,
        sector2,
        sector3,
        lap_valid_bit_flags: flags,
        lap_valid: flags & valid_bits::LAP != 0,
        sector1_valid: flags & valid_bits::SECTOR1 != 0,
        sector2_valid: flags & valid_bits::SECTOR2 != 0,
        sector3_valid: flags & valid_bits::SECTOR3 != 0,
    }
}

pub fn decode(bytes: &[u8]) -> Result<(PacketHeader, SessionHistoryPacket), DecodeError> {
    let header = accepted_as(bytes, PacketKind::SessionHistory)?;
    let mut r = Reader::new(bytes, HEADER_SIZE);
    let car_idx = r.u8();
    let num_laps = r.u8();
    let num_tyre_stints = r.u8();
    let best_lap_time_lap_num = r.u8();
    let best_sector1_lap_num = r.u8();
    let best_sector2_lap_num = r.u8();
    let best_sector3_lap_num = r.u8();
    let laps = (0..MAX_LAPS)
        .map(|_| lap(&mut r))
        .take(usize::from(num_laps).min(MAX_LAPS))
        .collect::<Vec<_>>();
    // `take` stops the iterator early, so reposition explicitly.
    let mut r = Reader::new(bytes, STINTS_OFFSET);
    let tyre_stints = (0..MAX_STINTS)
        .map(|_| TyreStintHistory {
            end_lap: r.u8(),
            actual_compound: ActualTyreCompound::from_raw(r.u8()),
            visual_compound: VisualTyreCompound::from_raw(r.u8()),
        })
        .collect::<Vec<_>>();
    debug_assert_eq!(r.position(), bytes.len());
    Ok((
        header,
        SessionHistoryPacket {
            car_idx,
            num_laps,
            num_tyre_stints,
            best_lap_time_lap_num,
            best_sector1_lap_num,
            best_sector2_lap_num,
            best_sector3_lap_num,
            laps,
            tyre_stints: tyre_stints
                .into_iter()
                .take(usize::from(num_tyre_stints).min(MAX_STINTS))
                .collect(),
        },
    ))
}
