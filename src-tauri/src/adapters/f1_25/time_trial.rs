//! Packet 14, Time Trial. `PacketTimeTrialData` (101 bytes): header (29),
//! then three `TimeTrialDataSet` (24 bytes each): the player's session best,
//! the personal best, and the rival.
//!
//! The three sets stay separate everywhere in RaceLab. The personal best and
//! rival are ghosts: the real fixtures show their cars at speeds the player
//! never drove (see `tests/fixtures/f1_25/README.md`), so nothing about them
//! is ever merged into, or presented as, the player's own telemetry.
use super::{
    accepted_as, codes::TeamId, reader::Reader, DecodeError, PacketHeader, PacketKind, HEADER_SIZE,
};
use serde::Serialize;

pub const SET_SIZE: usize = 24;

/// `TimeTrialDataSet`, field for field. The assist and setup fields are
/// documented as "0 = ..., 1 = ..." pairs and stay raw.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct TimeTrialSet {
    pub car_idx: u8,
    pub team_id: TeamId,
    pub lap_time_ms: u32,
    pub sector1_time_ms: u32,
    pub sector2_time_ms: u32,
    pub sector3_time_ms: u32,
    pub traction_control: u8,
    pub gearbox_assist: u8,
    pub anti_lock_brakes: u8,
    pub equal_car_performance: u8,
    pub custom_setup: u8,
    /// "0 = invalid, 1 = valid". Raw.
    pub valid: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct TimeTrialPacket {
    pub player_session_best: TimeTrialSet,
    pub personal_best: TimeTrialSet,
    pub rival: TimeTrialSet,
}

fn set(r: &mut Reader<'_>) -> TimeTrialSet {
    TimeTrialSet {
        car_idx: r.u8(),
        team_id: TeamId::from_raw(r.u8()),
        lap_time_ms: r.u32(),
        sector1_time_ms: r.u32(),
        sector2_time_ms: r.u32(),
        sector3_time_ms: r.u32(),
        traction_control: r.u8(),
        gearbox_assist: r.u8(),
        anti_lock_brakes: r.u8(),
        equal_car_performance: r.u8(),
        custom_setup: r.u8(),
        valid: r.u8(),
    }
}

pub fn decode(bytes: &[u8]) -> Result<(PacketHeader, TimeTrialPacket), DecodeError> {
    let header = accepted_as(bytes, PacketKind::TimeTrial)?;
    let mut r = Reader::new(bytes, HEADER_SIZE);
    let packet = TimeTrialPacket {
        player_session_best: set(&mut r),
        personal_best: set(&mut r),
        rival: set(&mut r),
    };
    debug_assert_eq!(r.position(), bytes.len());
    Ok((header, packet))
}
