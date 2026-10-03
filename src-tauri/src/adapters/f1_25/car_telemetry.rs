//! Packet 6, Car Telemetry. `PacketCarTelemetryData` (1352 bytes):
//! header (29), `CarTelemetryData[22]` (60 bytes each), then
//! `m_mfdPanelIndex` (uint8), `m_mfdPanelIndexSecondaryPlayer` (uint8),
//! `m_suggestedGear` (int8).
use super::{
    accepted_as,
    codes::{Drs, Gear, MfdPanel, SuggestedGear, SurfaceType},
    player_index,
    reader::Reader,
    DecodeError, PacketHeader, PacketKind, Wheels, HEADER_SIZE, MAX_CARS,
};
use serde::Serialize;

pub const CAR_SIZE: usize = 60;
pub const PACKET_FIELDS_OFFSET: usize = HEADER_SIZE + MAX_CARS * CAR_SIZE;

/// `CarTelemetryData`, field for field. Units are the specification's.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct CarTelemetry {
    /// `m_speed`, kilometres per hour.
    pub speed_kmh: u16,
    /// `m_throttle`, 0.0 to 1.0.
    pub throttle: f32,
    /// `m_steer`, -1.0 (full lock left) to 1.0 (full lock right).
    pub steer: f32,
    /// `m_brake`, 0.0 to 1.0.
    pub brake: f32,
    /// `m_clutch`, 0 to 100.
    pub clutch: u8,
    pub gear: Gear,
    pub engine_rpm: u16,
    pub drs: Drs,
    /// `m_revLightsPercent`, percentage.
    pub rev_lights_percent: u8,
    /// `m_revLightsBitValue`: bit 0 = leftmost LED, bit 14 = rightmost LED.
    pub rev_lights_bit_value: u16,
    /// Celsius.
    pub brakes_temperature_c: Wheels<u16>,
    /// Celsius.
    pub tyres_surface_temperature_c: Wheels<u8>,
    /// Celsius.
    pub tyres_inner_temperature_c: Wheels<u8>,
    /// Celsius.
    pub engine_temperature_c: u16,
    /// PSI.
    pub tyres_pressure_psi: Wheels<f32>,
    pub surface_type: Wheels<SurfaceType>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct CarTelemetryPacket {
    /// `None` when `playerCarIndex` is not a valid car index.
    pub player: Option<CarTelemetry>,
    pub mfd_panel_index: MfdPanel,
    pub mfd_panel_index_secondary_player: MfdPanel,
    pub suggested_gear: SuggestedGear,
}

/// Decodes car `index` (< 22) of an accepted Car Telemetry datagram.
pub(crate) fn car(bytes: &[u8], index: usize) -> CarTelemetry {
    debug_assert!(index < MAX_CARS);
    let mut r = Reader::new(bytes, HEADER_SIZE + index * CAR_SIZE);
    let car = CarTelemetry {
        speed_kmh: r.u16(),
        throttle: r.f32(),
        steer: r.f32(),
        brake: r.f32(),
        clutch: r.u8(),
        gear: Gear::from_raw(r.i8()),
        engine_rpm: r.u16(),
        drs: Drs::from_raw(r.u8()),
        rev_lights_percent: r.u8(),
        rev_lights_bit_value: r.u16(),
        brakes_temperature_c: r.wheels(Reader::u16),
        tyres_surface_temperature_c: r.wheels(Reader::u8),
        tyres_inner_temperature_c: r.wheels(Reader::u8),
        engine_temperature_c: r.u16(),
        tyres_pressure_psi: r.wheels(Reader::f32),
        surface_type: r.wheels(|r| SurfaceType::from_raw(r.u8())),
    };
    debug_assert_eq!(r.position(), HEADER_SIZE + (index + 1) * CAR_SIZE);
    car
}

pub fn decode(bytes: &[u8]) -> Result<(PacketHeader, CarTelemetryPacket), DecodeError> {
    let header = accepted_as(bytes, PacketKind::CarTelemetry)?;
    let mut r = Reader::new(bytes, PACKET_FIELDS_OFFSET);
    let packet = CarTelemetryPacket {
        player: player_index(&header).map(|index| car(bytes, index)),
        mfd_panel_index: MfdPanel::from_raw(r.u8()),
        mfd_panel_index_secondary_player: MfdPanel::from_raw(r.u8()),
        suggested_gear: SuggestedGear::from_raw(r.i8()),
    };
    debug_assert_eq!(r.position(), bytes.len());
    Ok((header, packet))
}
