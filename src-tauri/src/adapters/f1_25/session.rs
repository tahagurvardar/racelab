//! Packet 1, Session. `PacketSessionData` (753 bytes): header (29), session
//! scalars, `MarshalZone[21]` (5 bytes each), `WeatherForecastSample[64]`
//! (8 bytes each), assist and rule settings, `m_weekendStructure[12]`, and the
//! two sector start distances.
//!
//! Every field is decoded in specification order so the byte total is checked
//! by construction, but only the counted prefix of each array is returned:
//! "number of marshal zones to follow", "number of weather samples to follow"
//! and "number of session in following array". The rest of each fixed array
//! is padding as far as the specification says, and is never exposed.
use super::{
    accepted_as,
    codes::{
        FiaFlag, Formula, GameMode, NetworkGame, RuleSet, SafetyCarStatus, SessionType, TrackId,
        Weather,
    },
    reader::Reader,
    DecodeError, PacketHeader, PacketKind, HEADER_SIZE,
};
use serde::Serialize;

pub const MAX_MARSHAL_ZONES: usize = 21;
pub const MAX_FORECAST_SAMPLES: usize = 64;
pub const MAX_WEEKEND_SESSIONS: usize = 12;

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct MarshalZone {
    /// "Fraction (0..1) of way through the lap the marshal zone starts".
    pub zone_start: f32,
    pub zone_flag: FiaFlag,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct WeatherForecastSample {
    pub session_type: SessionType,
    /// "Time in minutes the forecast is for".
    pub time_offset_min: u8,
    pub weather: Weather,
    /// Celsius.
    pub track_temperature_c: i8,
    /// "0 = up, 1 = down, 2 = no change". Kept raw: the field is int8 and the
    /// three values are not used anywhere RaceLab decides anything.
    pub track_temperature_change: i8,
    /// Celsius.
    pub air_temperature_c: i8,
    pub air_temperature_change: i8,
    /// "Percentage chance of rain (0-100)".
    pub rain_percentage: u8,
}

/// `PacketSessionData`, field for field. Settings fields whose meaning is a
/// short documented list are kept raw: they describe menu choices, and
/// nothing in RaceLab branches on them.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SessionPacket {
    pub weather: Weather,
    pub track_temperature_c: i8,
    pub air_temperature_c: i8,
    /// "Total number of laps in this race".
    pub total_laps: u8,
    /// Metres.
    pub track_length_m: u16,
    pub session_type: SessionType,
    pub track_id: TrackId,
    pub formula: Formula,
    /// Seconds.
    pub session_time_left_s: u16,
    /// Seconds.
    pub session_duration_s: u16,
    /// Kilometres per hour.
    pub pit_speed_limit_kmh: u8,
    /// "Whether the game is paused – network game only". Raw.
    pub game_paused: u8,
    /// "Whether the player is spectating". Raw.
    pub is_spectating: u8,
    pub spectator_car_index: u8,
    pub sli_pro_native_support: u8,
    pub num_marshal_zones: u8,
    /// The first `min(num_marshal_zones, 21)` zones.
    pub marshal_zones: Vec<MarshalZone>,
    pub safety_car_status: SafetyCarStatus,
    pub network_game: NetworkGame,
    pub num_weather_forecast_samples: u8,
    /// The first `min(num_weather_forecast_samples, 64)` samples.
    pub weather_forecast_samples: Vec<WeatherForecastSample>,
    /// "0 = Perfect, 1 = Approximate". Raw.
    pub forecast_accuracy: u8,
    /// "AI Difficulty rating – 0-110".
    pub ai_difficulty: u8,
    pub season_link_identifier: u32,
    pub weekend_link_identifier: u32,
    pub session_link_identifier: u32,
    pub pit_stop_window_ideal_lap: u8,
    pub pit_stop_window_latest_lap: u8,
    pub pit_stop_rejoin_position: u8,
    pub steering_assist: u8,
    pub braking_assist: u8,
    pub gearbox_assist: u8,
    pub pit_assist: u8,
    pub pit_release_assist: u8,
    pub ers_assist: u8,
    pub drs_assist: u8,
    pub dynamic_racing_line: u8,
    pub dynamic_racing_line_type: u8,
    pub game_mode: GameMode,
    pub rule_set: RuleSet,
    /// "Local time of day - minutes since midnight".
    pub time_of_day_min: u32,
    pub session_length: u8,
    pub speed_units_lead_player: u8,
    pub temperature_units_lead_player: u8,
    pub speed_units_secondary_player: u8,
    pub temperature_units_secondary_player: u8,
    pub num_safety_car_periods: u8,
    pub num_virtual_safety_car_periods: u8,
    pub num_red_flag_periods: u8,
    pub equal_car_performance: u8,
    pub recovery_mode: u8,
    pub flashback_limit: u8,
    pub surface_type: u8,
    pub low_fuel_mode: u8,
    pub race_starts: u8,
    pub tyre_temperature: u8,
    pub pit_lane_tyre_sim: u8,
    pub car_damage: u8,
    pub car_damage_rate: u8,
    pub collisions: u8,
    pub collisions_off_for_first_lap_only: u8,
    pub mp_unsafe_pit_release: u8,
    pub mp_off_for_griefing: u8,
    pub corner_cutting_stringency: u8,
    pub parc_ferme_rules: u8,
    pub pit_stop_experience: u8,
    pub safety_car: u8,
    pub safety_car_experience: u8,
    pub formation_lap: u8,
    pub formation_lap_experience: u8,
    pub red_flags: u8,
    pub affects_licence_level_solo: u8,
    pub affects_licence_level_mp: u8,
    pub num_sessions_in_weekend: u8,
    /// The first `min(num_sessions_in_weekend, 12)` session types.
    pub weekend_structure: Vec<SessionType>,
    /// Metres around the track.
    pub sector2_lap_distance_start_m: f32,
    /// Metres around the track.
    pub sector3_lap_distance_start_m: f32,
}

pub fn decode(bytes: &[u8]) -> Result<(PacketHeader, SessionPacket), DecodeError> {
    let header = accepted_as(bytes, PacketKind::Session)?;
    let mut r = Reader::new(bytes, HEADER_SIZE);
    let weather = Weather::from_raw(r.u8());
    let track_temperature_c = r.i8();
    let air_temperature_c = r.i8();
    let total_laps = r.u8();
    let track_length_m = r.u16();
    let session_type = SessionType::from_raw(r.u8());
    let track_id = TrackId::from_raw(r.i8());
    let formula = Formula::from_raw(r.u8());
    let session_time_left_s = r.u16();
    let session_duration_s = r.u16();
    let pit_speed_limit_kmh = r.u8();
    let game_paused = r.u8();
    let is_spectating = r.u8();
    let spectator_car_index = r.u8();
    let sli_pro_native_support = r.u8();
    let num_marshal_zones = r.u8();
    let mut marshal_zones = Vec::new();
    for index in 0..MAX_MARSHAL_ZONES {
        let zone = MarshalZone {
            zone_start: r.f32(),
            zone_flag: FiaFlag::from_raw(r.i8()),
        };
        if index < usize::from(num_marshal_zones) {
            marshal_zones.push(zone);
        }
    }
    let safety_car_status = SafetyCarStatus::from_raw(r.u8());
    let network_game = NetworkGame::from_raw(r.u8());
    let num_weather_forecast_samples = r.u8();
    let mut weather_forecast_samples = Vec::new();
    for index in 0..MAX_FORECAST_SAMPLES {
        let sample = WeatherForecastSample {
            session_type: SessionType::from_raw(r.u8()),
            time_offset_min: r.u8(),
            weather: Weather::from_raw(r.u8()),
            track_temperature_c: r.i8(),
            track_temperature_change: r.i8(),
            air_temperature_c: r.i8(),
            air_temperature_change: r.i8(),
            rain_percentage: r.u8(),
        };
        if index < usize::from(num_weather_forecast_samples) {
            weather_forecast_samples.push(sample);
        }
    }
    let mut packet = SessionPacket {
        weather,
        track_temperature_c,
        air_temperature_c,
        total_laps,
        track_length_m,
        session_type,
        track_id,
        formula,
        session_time_left_s,
        session_duration_s,
        pit_speed_limit_kmh,
        game_paused,
        is_spectating,
        spectator_car_index,
        sli_pro_native_support,
        num_marshal_zones,
        marshal_zones,
        safety_car_status,
        network_game,
        num_weather_forecast_samples,
        weather_forecast_samples,
        forecast_accuracy: r.u8(),
        ai_difficulty: r.u8(),
        season_link_identifier: r.u32(),
        weekend_link_identifier: r.u32(),
        session_link_identifier: r.u32(),
        pit_stop_window_ideal_lap: r.u8(),
        pit_stop_window_latest_lap: r.u8(),
        pit_stop_rejoin_position: r.u8(),
        steering_assist: r.u8(),
        braking_assist: r.u8(),
        gearbox_assist: r.u8(),
        pit_assist: r.u8(),
        pit_release_assist: r.u8(),
        ers_assist: r.u8(),
        drs_assist: r.u8(),
        dynamic_racing_line: r.u8(),
        dynamic_racing_line_type: r.u8(),
        game_mode: GameMode::from_raw(r.u8()),
        rule_set: RuleSet::from_raw(r.u8()),
        time_of_day_min: r.u32(),
        session_length: r.u8(),
        speed_units_lead_player: r.u8(),
        temperature_units_lead_player: r.u8(),
        speed_units_secondary_player: r.u8(),
        temperature_units_secondary_player: r.u8(),
        num_safety_car_periods: r.u8(),
        num_virtual_safety_car_periods: r.u8(),
        num_red_flag_periods: r.u8(),
        equal_car_performance: r.u8(),
        recovery_mode: r.u8(),
        flashback_limit: r.u8(),
        surface_type: r.u8(),
        low_fuel_mode: r.u8(),
        race_starts: r.u8(),
        tyre_temperature: r.u8(),
        pit_lane_tyre_sim: r.u8(),
        car_damage: r.u8(),
        car_damage_rate: r.u8(),
        collisions: r.u8(),
        collisions_off_for_first_lap_only: r.u8(),
        mp_unsafe_pit_release: r.u8(),
        mp_off_for_griefing: r.u8(),
        corner_cutting_stringency: r.u8(),
        parc_ferme_rules: r.u8(),
        pit_stop_experience: r.u8(),
        safety_car: r.u8(),
        safety_car_experience: r.u8(),
        formation_lap: r.u8(),
        formation_lap_experience: r.u8(),
        red_flags: r.u8(),
        affects_licence_level_solo: r.u8(),
        affects_licence_level_mp: r.u8(),
        num_sessions_in_weekend: r.u8(),
        weekend_structure: Vec::new(),
        sector2_lap_distance_start_m: 0.0,
        sector3_lap_distance_start_m: 0.0,
    };
    let weekend: [u8; MAX_WEEKEND_SESSIONS] = r.bytes();
    packet.weekend_structure = weekend
        .iter()
        .take(usize::from(packet.num_sessions_in_weekend))
        .map(|&raw| SessionType::from_raw(raw))
        .collect();
    packet.sector2_lap_distance_start_m = r.f32();
    packet.sector3_lap_distance_start_m = r.f32();
    debug_assert_eq!(r.position(), bytes.len());
    Ok((header, packet))
}
