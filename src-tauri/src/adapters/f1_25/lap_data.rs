//! Packet 2, Lap Data. `PacketLapData` (1285 bytes): header (29),
//! `LapData[22]` (57 bytes each), then `m_timeTrialPBCarIdx` (uint8) and
//! `m_timeTrialRivalCarIdx` (uint8).
//!
//! Values are decoded exactly as sent. Nothing is smoothed, clamped or
//! "corrected": if the game sends an implausible value in some mode, that is
//! the value RaceLab reports.
use super::{
    accepted_as,
    codes::{DriverStatus, LapValidity, PitLaneTimer, PitStatus, ResultStatus, Sector},
    player_index,
    reader::Reader,
    DecodeError, PacketHeader, PacketKind, HEADER_SIZE, MAX_CARS,
};
use serde::Serialize;

pub const CAR_SIZE: usize = 57;
pub const PACKET_FIELDS_OFFSET: usize = HEADER_SIZE + MAX_CARS * CAR_SIZE;

/// A time sent as a minutes part and a milliseconds part. `total_ms` is
/// `minutes_part * 60000 + ms_part`: exact integer arithmetic on the two wire
/// values, nothing more.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct SplitTime {
    pub ms_part: u16,
    pub minutes_part: u8,
    pub total_ms: u32,
}

impl SplitTime {
    fn read(r: &mut Reader<'_>) -> Self {
        let ms_part = r.u16();
        let minutes_part = r.u8();
        Self {
            ms_part,
            minutes_part,
            total_ms: u32::from(minutes_part) * 60_000 + u32::from(ms_part),
        }
    }
}

/// `LapData`, field for field.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct LapData {
    pub last_lap_time_ms: u32,
    pub current_lap_time_ms: u32,
    pub sector1_time: SplitTime,
    pub sector2_time: SplitTime,
    pub delta_to_car_in_front: SplitTime,
    pub delta_to_race_leader: SplitTime,
    /// Metres. "Could be negative if line hasn't been crossed yet."
    pub lap_distance_m: f32,
    /// Metres. "Could be negative if line hasn't been crossed yet."
    pub total_distance_m: f32,
    /// Seconds.
    pub safety_car_delta_s: f32,
    pub car_position: u8,
    pub current_lap_num: u8,
    pub pit_status: PitStatus,
    pub num_pit_stops: u8,
    pub sector: Sector,
    pub current_lap_invalid: LapValidity,
    /// "Accumulated time penalties in seconds to be added".
    pub penalties_s: u8,
    pub total_warnings: u8,
    pub corner_cutting_warnings: u8,
    pub num_unserved_drive_through_pens: u8,
    pub num_unserved_stop_go_pens: u8,
    pub grid_position: u8,
    pub driver_status: DriverStatus,
    pub result_status: ResultStatus,
    pub pit_lane_timer_active: PitLaneTimer,
    /// "If active, the current time spent in the pit lane in ms".
    pub pit_lane_time_in_lane_ms: u16,
    pub pit_stop_timer_ms: u16,
    /// "Whether the car should serve a penalty at this stop". The
    /// specification does not say which value means yes, so this stays raw.
    pub pit_stop_should_serve_pen: u8,
    /// km/h.
    pub speed_trap_fastest_speed_kmh: f32,
    /// "Lap no the fastest speed was achieved, 255 = not set".
    pub speed_trap_fastest_lap: u8,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct LapDataPacket {
    /// `None` when `playerCarIndex` is not a valid car index.
    pub player: Option<LapData>,
    /// "Index of Personal Best car in time trial (255 if invalid)".
    pub time_trial_pb_car_idx: u8,
    /// "Index of Rival car in time trial (255 if invalid)".
    pub time_trial_rival_car_idx: u8,
}

pub(crate) fn car(bytes: &[u8], index: usize) -> LapData {
    debug_assert!(index < MAX_CARS);
    let mut r = Reader::new(bytes, HEADER_SIZE + index * CAR_SIZE);
    let car = LapData {
        last_lap_time_ms: r.u32(),
        current_lap_time_ms: r.u32(),
        sector1_time: SplitTime::read(&mut r),
        sector2_time: SplitTime::read(&mut r),
        delta_to_car_in_front: SplitTime::read(&mut r),
        delta_to_race_leader: SplitTime::read(&mut r),
        lap_distance_m: r.f32(),
        total_distance_m: r.f32(),
        safety_car_delta_s: r.f32(),
        car_position: r.u8(),
        current_lap_num: r.u8(),
        pit_status: PitStatus::from_raw(r.u8()),
        num_pit_stops: r.u8(),
        sector: Sector::from_raw(r.u8()),
        current_lap_invalid: LapValidity::from_raw(r.u8()),
        penalties_s: r.u8(),
        total_warnings: r.u8(),
        corner_cutting_warnings: r.u8(),
        num_unserved_drive_through_pens: r.u8(),
        num_unserved_stop_go_pens: r.u8(),
        grid_position: r.u8(),
        driver_status: DriverStatus::from_raw(r.u8()),
        result_status: ResultStatus::from_raw(r.u8()),
        pit_lane_timer_active: PitLaneTimer::from_raw(r.u8()),
        pit_lane_time_in_lane_ms: r.u16(),
        pit_stop_timer_ms: r.u16(),
        pit_stop_should_serve_pen: r.u8(),
        speed_trap_fastest_speed_kmh: r.f32(),
        speed_trap_fastest_lap: r.u8(),
    };
    debug_assert_eq!(r.position(), HEADER_SIZE + (index + 1) * CAR_SIZE);
    car
}

pub fn decode(bytes: &[u8]) -> Result<(PacketHeader, LapDataPacket), DecodeError> {
    let header = accepted_as(bytes, PacketKind::LapData)?;
    let mut r = Reader::new(bytes, PACKET_FIELDS_OFFSET);
    let packet = LapDataPacket {
        player: player_index(&header).map(|index| car(bytes, index)),
        time_trial_pb_car_idx: r.u8(),
        time_trial_rival_car_idx: r.u8(),
    };
    debug_assert_eq!(r.position(), bytes.len());
    Ok((header, packet))
}
