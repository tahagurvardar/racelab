//! Packet 7, Car Status. `PacketCarStatusData` (1239 bytes): header (29),
//! then `CarStatusData[22]` (55 bytes each). No packet-level fields.
use super::{
    accepted_as,
    codes::{
        ActualTyreCompound, AntiLockBrakes, DrsAllowed, ErsDeployMode, FiaFlag, FuelMix,
        PitLimiter, TractionControl, VisualTyreCompound,
    },
    player_index,
    reader::Reader,
    DecodeError, PacketHeader, PacketKind, HEADER_SIZE, MAX_CARS,
};
use serde::Serialize;

pub const CAR_SIZE: usize = 55;

/// `CarStatusData`, field for field. Units are stated only where the
/// specification states one.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct CarStatus {
    pub traction_control: TractionControl,
    pub anti_lock_brakes: AntiLockBrakes,
    pub fuel_mix: FuelMix,
    /// `m_frontBrakeBias`, percentage.
    pub front_brake_bias_percent: u8,
    pub pit_limiter_status: PitLimiter,
    /// `m_fuelInTank`: "Current fuel mass". The specification gives no unit.
    pub fuel_in_tank: f32,
    /// `m_fuelCapacity`. No unit given.
    pub fuel_capacity: f32,
    /// `m_fuelRemainingLaps`: "Fuel remaining in terms of laps (value on MFD)".
    pub fuel_remaining_laps: f32,
    /// `m_maxRPM`: "Cars max RPM, point of rev limiter".
    pub max_rpm: u16,
    pub idle_rpm: u16,
    pub max_gears: u8,
    pub drs_allowed: DrsAllowed,
    /// `m_drsActivationDistance`: "0 = DRS not available, non-zero - DRS will
    /// be available in [X] metres".
    pub drs_activation_distance_m: u16,
    pub actual_tyre_compound: ActualTyreCompound,
    pub visual_tyre_compound: VisualTyreCompound,
    /// "Age in laps of the current set of tyres".
    pub tyres_age_laps: u8,
    pub vehicle_fia_flags: FiaFlag,
    /// Watts.
    pub engine_power_ice_w: f32,
    /// Watts.
    pub engine_power_mguk_w: f32,
    /// Joules.
    pub ers_store_energy_j: f32,
    pub ers_deploy_mode: ErsDeployMode,
    /// "ERS energy harvested this lap by MGU-K". No unit given.
    pub ers_harvested_this_lap_mguk: f32,
    /// "ERS energy harvested this lap by MGU-H". No unit given.
    pub ers_harvested_this_lap_mguh: f32,
    /// "ERS energy deployed this lap". No unit given.
    pub ers_deployed_this_lap: f32,
    /// "Whether the car is paused in a network game". The specification does
    /// not say which value means paused, so this stays raw.
    pub network_paused: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct CarStatusPacket {
    /// `None` when `playerCarIndex` is not a valid car index.
    pub player: Option<CarStatus>,
}

pub(crate) fn car(bytes: &[u8], index: usize) -> CarStatus {
    debug_assert!(index < MAX_CARS);
    let mut r = Reader::new(bytes, HEADER_SIZE + index * CAR_SIZE);
    let car = CarStatus {
        traction_control: TractionControl::from_raw(r.u8()),
        anti_lock_brakes: AntiLockBrakes::from_raw(r.u8()),
        fuel_mix: FuelMix::from_raw(r.u8()),
        front_brake_bias_percent: r.u8(),
        pit_limiter_status: PitLimiter::from_raw(r.u8()),
        fuel_in_tank: r.f32(),
        fuel_capacity: r.f32(),
        fuel_remaining_laps: r.f32(),
        max_rpm: r.u16(),
        idle_rpm: r.u16(),
        max_gears: r.u8(),
        drs_allowed: DrsAllowed::from_raw(r.u8()),
        drs_activation_distance_m: r.u16(),
        actual_tyre_compound: ActualTyreCompound::from_raw(r.u8()),
        visual_tyre_compound: VisualTyreCompound::from_raw(r.u8()),
        tyres_age_laps: r.u8(),
        vehicle_fia_flags: FiaFlag::from_raw(r.i8()),
        engine_power_ice_w: r.f32(),
        engine_power_mguk_w: r.f32(),
        ers_store_energy_j: r.f32(),
        ers_deploy_mode: ErsDeployMode::from_raw(r.u8()),
        ers_harvested_this_lap_mguk: r.f32(),
        ers_harvested_this_lap_mguh: r.f32(),
        ers_deployed_this_lap: r.f32(),
        network_paused: r.u8(),
    };
    debug_assert_eq!(r.position(), HEADER_SIZE + (index + 1) * CAR_SIZE);
    car
}

pub fn decode(bytes: &[u8]) -> Result<(PacketHeader, CarStatusPacket), DecodeError> {
    let header = accepted_as(bytes, PacketKind::CarStatus)?;
    Ok((
        header,
        CarStatusPacket {
            player: player_index(&header).map(|index| car(bytes, index)),
        },
    ))
}
