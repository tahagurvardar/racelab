//! Packet 10, Car Damage. `PacketCarDamageData` (1041 bytes): header (29),
//! then `CarDamageData[22]` (46 bytes each).
//!
//! Every value is a measurement as sent: percentages stay percentages, and
//! the two fault indicators and two engine states stay raw. Nothing here
//! judges a value as good or bad. With "Your Telemetry" restricted, the game
//! sends zeros for other players' cars; the player's own car is always sent.
use super::{
    accepted_as, player_index, reader::Reader, DecodeError, PacketHeader, PacketKind, Wheels,
    HEADER_SIZE, MAX_CARS,
};
use serde::{Deserialize, Serialize};

pub const CAR_SIZE: usize = 46;

/// `CarDamageData`, field for field. Percentages unless stated otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CarDamage {
    pub tyres_wear_percent: Wheels<f32>,
    pub tyres_damage_percent: Wheels<u8>,
    pub brakes_damage_percent: Wheels<u8>,
    pub tyre_blisters_percent: Wheels<u8>,
    pub front_left_wing_damage_percent: u8,
    pub front_right_wing_damage_percent: u8,
    pub rear_wing_damage_percent: u8,
    pub floor_damage_percent: u8,
    pub diffuser_damage_percent: u8,
    pub sidepod_damage_percent: u8,
    /// "Indicator for DRS fault, 0 = OK, 1 = fault". Raw.
    pub drs_fault: u8,
    /// "Indicator for ERS fault, 0 = OK, 1 = fault". Raw.
    pub ers_fault: u8,
    pub gear_box_damage_percent: u8,
    pub engine_damage_percent: u8,
    pub engine_mguh_wear_percent: u8,
    pub engine_es_wear_percent: u8,
    pub engine_ce_wear_percent: u8,
    pub engine_ice_wear_percent: u8,
    pub engine_mguk_wear_percent: u8,
    pub engine_tc_wear_percent: u8,
    /// "Engine blown, 0 = OK, 1 = fault". Raw.
    pub engine_blown: u8,
    /// "Engine seized, 0 = OK, 1 = fault". Raw.
    pub engine_seized: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct CarDamagePacket {
    /// `None` when `playerCarIndex` is not a valid car index.
    pub player: Option<CarDamage>,
}

pub fn car(bytes: &[u8], index: usize) -> CarDamage {
    debug_assert!(index < MAX_CARS);
    let mut r = Reader::new(bytes, HEADER_SIZE + index * CAR_SIZE);
    let car = CarDamage {
        tyres_wear_percent: r.wheels(Reader::f32),
        tyres_damage_percent: r.wheels(Reader::u8),
        brakes_damage_percent: r.wheels(Reader::u8),
        tyre_blisters_percent: r.wheels(Reader::u8),
        front_left_wing_damage_percent: r.u8(),
        front_right_wing_damage_percent: r.u8(),
        rear_wing_damage_percent: r.u8(),
        floor_damage_percent: r.u8(),
        diffuser_damage_percent: r.u8(),
        sidepod_damage_percent: r.u8(),
        drs_fault: r.u8(),
        ers_fault: r.u8(),
        gear_box_damage_percent: r.u8(),
        engine_damage_percent: r.u8(),
        engine_mguh_wear_percent: r.u8(),
        engine_es_wear_percent: r.u8(),
        engine_ce_wear_percent: r.u8(),
        engine_ice_wear_percent: r.u8(),
        engine_mguk_wear_percent: r.u8(),
        engine_tc_wear_percent: r.u8(),
        engine_blown: r.u8(),
        engine_seized: r.u8(),
    };
    debug_assert_eq!(r.position(), HEADER_SIZE + (index + 1) * CAR_SIZE);
    car
}

pub fn decode(bytes: &[u8]) -> Result<(PacketHeader, CarDamagePacket), DecodeError> {
    let header = accepted_as(bytes, PacketKind::CarDamage)?;
    Ok((
        header,
        CarDamagePacket {
            player: player_index(&header).map(|index| car(bytes, index)),
        },
    ))
}
