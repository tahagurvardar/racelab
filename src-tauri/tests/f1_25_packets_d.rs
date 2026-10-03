//! F1 25 Phase D: decoders for packets 1, 3, 4, 8, 10, 11, 12, 14 and 15.
//!
//! Every datagram here is SYNTHETIC, written in specification order by
//! `f1_synthetic`, which knows nothing of the decoders' offsets. The pinned
//! binaries in `fixtures/f1_25/synthetic/` are the same writers' output and
//! are kept apart from the real captured fixtures.
mod f1_synthetic;

use f1_synthetic::*;
use racelab_lib::adapters::f1_25::{
    car_damage, classify,
    codes::*,
    event::{self, EventDetails},
    final_classification, lap_positions, participants, session, session_history, time_trial,
    tyre_sets, Classification, DecodeError, PacketKind, Rejection,
};
use std::{fs, path::PathBuf};

const UID: u64 = 0x5359_4E54_4845_5421; // "!TEHTNYS" little endian: synthetic
const PLAYER: u8 = 4;

fn h(frame: u32) -> Head {
    Head::new(0, UID, frame, PLAYER)
}

fn accepted(bytes: &[u8], kind: PacketKind) {
    match classify(bytes) {
        Classification::Accepted { kind: k, .. } => assert_eq!(k, kind),
        other => panic!("not accepted: {other:?}"),
    }
}

// ---------------------------------------------------------------- session

#[test]
fn session_decodes_every_context_field_and_only_the_counted_array_prefixes() {
    let bytes = session(h(10), SessionSpec::default());
    accepted(&bytes, PacketKind::Session);
    let (header, s) = session::decode(&bytes).unwrap();
    assert_eq!(header.session_uid, UID);
    assert_eq!(s.weather, Weather::LightCloud);
    assert_eq!(s.track_temperature_c, 31);
    assert_eq!(s.air_temperature_c, 24);
    assert_eq!(s.total_laps, 5);
    assert_eq!(s.track_length_m, 5412);
    assert_eq!(s.session_type, SessionType::Race);
    assert_eq!(s.track_id, TrackId::Silverstone);
    assert_eq!(s.formula, Formula::F1Modern);
    assert_eq!(s.session_time_left_s, 3540);
    assert_eq!(s.session_duration_s, 3600);
    assert_eq!(s.pit_speed_limit_kmh, 80);
    assert_eq!(s.is_spectating, 0);
    assert_eq!(s.spectator_car_index, 11);
    assert_eq!(s.num_marshal_zones, 3);
    assert_eq!(s.marshal_zones.len(), 3);
    assert_eq!(s.marshal_zones[2].zone_flag, FiaFlag::Green);
    assert_eq!(s.safety_car_status, SafetyCarStatus::NoSafetyCar);
    assert_eq!(s.network_game, NetworkGame::Offline);
    assert_eq!(s.weather_forecast_samples.len(), 2);
    assert_eq!(s.weather_forecast_samples[1].time_offset_min, 5);
    assert_eq!(s.weather_forecast_samples[1].rain_percentage, 1);
    assert_eq!(s.ai_difficulty, 95);
    assert_eq!(s.session_link_identifier, 0xC3);
    assert_eq!(s.pit_stop_rejoin_position, 9);
    assert_eq!(s.gearbox_assist, 3);
    assert_eq!(s.game_mode, GameMode::GrandPrix23);
    assert_eq!(s.rule_set, RuleSet::Race);
    assert_eq!(s.time_of_day_min, 845);
    assert_eq!(s.num_virtual_safety_car_periods, 2);
    // The 24 settings bytes are written as index % 3: the last two (indices
    // 22 and 23) are the licence level fields.
    assert_eq!(s.equal_car_performance, 0);
    assert_eq!(s.recovery_mode, 1);
    assert_eq!(s.affects_licence_level_solo, 22 % 3);
    assert_eq!(s.affects_licence_level_mp, 23 % 3);
    assert_eq!(
        s.weekend_structure,
        vec![SessionType::Practice1, SessionType::Practice2]
    );
    assert_eq!(s.sector2_lap_distance_start_m, 1800.5);
    assert_eq!(s.sector3_lap_distance_start_m, 3600.25);
}

#[test]
fn session_codes_outside_the_specification_stay_raw() {
    let bytes = session(
        h(10),
        SessionSpec {
            session_type: 99,
            track_id: 50,
            weather: 9,
            formula: 5,
            game_mode: 200,
            rule_set: 7,
            safety_car_status: 8,
            ..SessionSpec::default()
        },
    );
    let (_, s) = session::decode(&bytes).unwrap();
    assert_eq!(s.session_type, SessionType::Unknown(99));
    assert_eq!(s.session_type.label(), None);
    assert_eq!(s.track_id, TrackId::Unknown(50));
    assert_eq!(s.weather, Weather::Unknown(9));
    // 5 was "Supercars" in older formats; F1 25 does not name it.
    assert_eq!(s.formula, Formula::Unknown(5));
    assert_eq!(s.game_mode, GameMode::Unknown(200));
    assert_eq!(s.rule_set, RuleSet::Unknown(7));
    assert_eq!(s.safety_car_status, SafetyCarStatus::Unknown(8));
    // The specification's own "unknown" track and session are named values.
    let named = session(
        h(10),
        SessionSpec {
            session_type: 0,
            track_id: -1,
            ..SessionSpec::default()
        },
    );
    let (_, s) = session::decode(&named).unwrap();
    assert_eq!(s.session_type, SessionType::UnknownSession);
    assert_eq!(s.track_id, TrackId::UnknownTrack);
}

#[test]
fn counts_larger_than_their_arrays_are_bounded_by_the_array() {
    let bytes = session(
        h(10),
        SessionSpec {
            num_marshal_zones: 200,
            num_forecast: 255,
            num_weekend: 99,
            ..SessionSpec::default()
        },
    );
    let (_, s) = session::decode(&bytes).unwrap();
    assert_eq!(s.marshal_zones.len(), 21);
    assert_eq!(s.weather_forecast_samples.len(), 64);
    assert_eq!(s.weekend_structure.len(), 12);
}

// ------------------------------------------------------------------ event

fn decode_event(code: &[u8; 4], details: &[u8]) -> (String, EventDetails) {
    let bytes = event(h(20), code, details);
    accepted(&bytes, PacketKind::Event);
    let (_, packet) = event::decode(&bytes).unwrap();
    (packet.code_text(), packet.details)
}

#[test]
fn every_documented_event_code_decodes_its_own_union_member() {
    assert_eq!(decode_event(b"SSTA", &[]).1, EventDetails::SessionStarted);
    assert_eq!(decode_event(b"SEND", &[]).1, EventDetails::SessionEnded);
    let mut fastest = vec![7];
    fastest.extend_from_slice(&88.5f32.to_le_bytes());
    assert_eq!(
        decode_event(b"FTLP", &fastest).1,
        EventDetails::FastestLap {
            vehicle_idx: 7,
            lap_time_s: 88.5
        }
    );
    assert_eq!(
        decode_event(b"RTMT", &[3, 8]).1,
        EventDetails::Retirement {
            vehicle_idx: 3,
            reason: ResultReason::MechanicalFailure
        }
    );
    assert_eq!(decode_event(b"DRSE", &[]).1, EventDetails::DrsEnabled);
    assert_eq!(
        decode_event(b"DRSD", &[1]).1,
        EventDetails::DrsDisabled {
            reason: DrsDisabledReason::SafetyCarDeployed
        }
    );
    assert_eq!(
        decode_event(b"TMPT", &[9]).1,
        EventDetails::TeamMateInPits { vehicle_idx: 9 }
    );
    assert_eq!(decode_event(b"CHQF", &[]).1, EventDetails::ChequeredFlag);
    assert_eq!(
        decode_event(b"RCWN", &[2]).1,
        EventDetails::RaceWinner { vehicle_idx: 2 }
    );
    assert_eq!(
        decode_event(b"STLG", &[4]).1,
        EventDetails::StartLights { num_lights: 4 }
    );
    assert_eq!(decode_event(b"LGOT", &[]).1, EventDetails::LightsOut);
    assert_eq!(
        decode_event(b"DTSV", &[5]).1,
        EventDetails::DriveThroughServed { vehicle_idx: 5 }
    );
    let mut stop_go = vec![6];
    stop_go.extend_from_slice(&10.25f32.to_le_bytes());
    assert_eq!(
        decode_event(b"SGSV", &stop_go).1,
        EventDetails::StopGoServed {
            vehicle_idx: 6,
            stop_time_s: 10.25
        }
    );
    let mut flashback = 4321u32.to_le_bytes().to_vec();
    flashback.extend_from_slice(&216.0f32.to_le_bytes());
    assert_eq!(
        decode_event(b"FLBK", &flashback).1,
        EventDetails::Flashback {
            flashback_frame_identifier: 4321,
            flashback_session_time: 216.0
        }
    );
    assert_eq!(
        decode_event(b"BUTN", &0x0010_0001u32.to_le_bytes()).1,
        EventDetails::Buttons {
            button_status: 0x0010_0001
        }
    );
    assert_eq!(decode_event(b"RDFL", &[]).1, EventDetails::RedFlag);
    assert_eq!(
        decode_event(b"OVTK", &[1, 2]).1,
        EventDetails::Overtake {
            overtaking_vehicle_idx: 1,
            being_overtaken_vehicle_idx: 2
        }
    );
    assert_eq!(
        decode_event(b"SCAR", &[2, 3]).1,
        EventDetails::SafetyCar {
            safety_car_type: SafetyCarStatus::Virtual,
            event_type: SafetyCarEventType::ResumeRace
        }
    );
    assert_eq!(
        decode_event(b"COLL", &[4, 11]).1,
        EventDetails::Collision {
            vehicle1_idx: 4,
            vehicle2_idx: 11
        }
    );
}

#[test]
fn penalty_and_speed_trap_details_match_the_specification() {
    let (code, details) = decode_event(b"PENA", &penalty_details(4, 17, PLAYER, 255, 5, 3, 0));
    assert_eq!(code, "PENA");
    assert_eq!(
        details,
        EventDetails::Penalty {
            penalty_type: PenaltyType::TimePenalty,
            infringement_type: InfringementType::PitLaneSpeeding,
            vehicle_idx: PLAYER,
            other_vehicle_idx: 255,
            time_s: 5,
            lap_num: 3,
            places_gained: 0
        }
    );
    let (_, trap) = decode_event(
        b"SPTP",
        &speed_trap_details(PLAYER, 321.5, 1, 1, PLAYER, 321.5),
    );
    assert_eq!(
        trap,
        EventDetails::SpeedTrap {
            vehicle_idx: PLAYER,
            speed_kmh: 321.5,
            is_overall_fastest_in_session: 1,
            is_driver_fastest_in_session: 1,
            fastest_vehicle_idx_in_session: PLAYER,
            fastest_speed_in_session_kmh: 321.5
        }
    );
    // Codes beyond the appendices stay raw inside a known event.
    let (_, future) = decode_event(b"PENA", &penalty_details(18, 55, 1, 2, 0, 0, 0));
    assert_eq!(
        future,
        EventDetails::Penalty {
            penalty_type: PenaltyType::Unknown(18),
            infringement_type: InfringementType::Unknown(55),
            vehicle_idx: 1,
            other_vehicle_idx: 2,
            time_s: 0,
            lap_num: 0,
            places_gained: 0
        }
    );
}

#[test]
fn an_unknown_event_code_keeps_its_bytes_and_reads_no_details() {
    let bytes = event(h(20), b"ZZZZ", &[1, 2, 3, 4]);
    let (_, packet) = event::decode(&bytes).unwrap();
    assert_eq!(&packet.code, b"ZZZZ");
    assert_eq!(packet.details, EventDetails::Unknown);
    let odd = event(h(20), &[0, 1, 0xff, 7], &[]);
    let (_, packet) = event::decode(&odd).unwrap();
    assert_eq!(packet.code_text(), "0001ff07");
}

// ------------------------------------------------------------ participants

fn cars() -> [ParticipantSpec; 22] {
    std::array::from_fn(|car| participant_for(car as u8))
}

#[test]
fn participants_decode_the_player_slot_by_header_index() {
    let mut cars = cars();
    cars[usize::from(PLAYER)].name = "Private Gamertag".into();
    cars[usize::from(PLAYER)].team_id = 8;
    let bytes = participants(h(1), 20, &cars);
    accepted(&bytes, PacketKind::Participants);
    let (_, p) = participants::decode(&bytes).unwrap();
    assert_eq!(p.num_active_cars, 20);
    let player = p.player.unwrap();
    assert_eq!(player.team_id, TeamId::McLaren);
    assert_eq!(player.race_number, 10 + PLAYER);
    assert_eq!(player.driver_id, 100 + PLAYER);
    assert_eq!(player.network_id, 200 + PLAYER);
    assert_eq!(player.name, "Private Gamertag");
    assert_eq!(player.tech_level, 1234);
    assert_eq!(player.livery_colours.len(), 2);
    assert_eq!(player.livery_colours[1].green, 11);
    // Spectating: no player at all, never slot 0.
    let spectating = participants(Head::new(0, UID, 1, 255), 20, &cars);
    assert!(participants::decode(&spectating)
        .unwrap()
        .1
        .player
        .is_none());
    // Every slot decodes at its own offset.
    for car in 0..22 {
        assert_eq!(participants::car(&bytes, car).race_number, 10 + car as u8);
    }
}

// ----------------------------------------------------- final classification

#[test]
fn final_classification_decodes_the_player_row_with_its_stints() {
    let rows: [ClassificationSpec; 22] = std::array::from_fn(|car| classification_for(car as u8));
    let bytes = final_classification(h(900), 20, &rows);
    accepted(&bytes, PacketKind::FinalClassification);
    let (_, fc) = final_classification::decode(&bytes).unwrap();
    assert_eq!(fc.num_cars, 20);
    let player = fc.player.unwrap();
    assert_eq!(player.position, PLAYER + 1);
    assert_eq!(player.grid_position, 22 - PLAYER);
    assert_eq!(player.points, 10 - PLAYER);
    assert_eq!(player.result_status, ResultStatus::Finished);
    assert_eq!(player.result_reason, ResultReason::Finished);
    assert_eq!(player.best_lap_time_ms, 90_400);
    assert_eq!(player.total_race_time_s, 459.125);
    assert_eq!(player.num_tyre_stints, 2);
    assert_eq!(player.tyre_stints.len(), 2);
    assert_eq!(
        player.tyre_stints[0].actual_compound,
        ActualTyreCompound::C5
    );
    assert_eq!(
        player.tyre_stints[1].visual_compound,
        VisualTyreCompound::Medium
    );
    assert_eq!(player.tyre_stints[1].end_lap, 5);
    let mut odd = rows.clone();
    odd[usize::from(PLAYER)].result_reason = 11;
    let (_, fc) = final_classification::decode(&final_classification(h(900), 20, &odd)).unwrap();
    assert_eq!(fc.player.unwrap().result_reason, ResultReason::Unknown(11));
}

// --------------------------------------------------------------- car damage

#[test]
fn car_damage_decodes_measurements_in_wire_wheel_order() {
    let bytes = car_damage(h(30), |car| car * 2);
    accepted(&bytes, PacketKind::CarDamage);
    let (_, d) = car_damage::decode(&bytes).unwrap();
    let d = d.player.unwrap();
    let s = PLAYER * 2;
    assert_eq!(d.tyres_wear_percent.rear_left, f32::from(s));
    assert_eq!(d.tyres_wear_percent.front_right, f32::from(s) + 0.75);
    assert_eq!(d.tyres_damage_percent.front_left, s + 2);
    assert_eq!(d.brakes_damage_percent.rear_right, s + 11);
    assert_eq!(d.tyre_blisters_percent.front_right, s + 23);
    assert_eq!(d.front_left_wing_damage_percent, s + 30);
    assert_eq!(d.sidepod_damage_percent, s + 35);
    assert_eq!(d.drs_fault, 0);
    assert_eq!(d.ers_fault, 1);
    assert_eq!(d.gear_box_damage_percent, s + 40);
    assert_eq!(d.engine_damage_percent, s + 41);
    assert_eq!(d.engine_mguh_wear_percent, s + 50);
    assert_eq!(d.engine_tc_wear_percent, s + 55);
    assert_eq!(d.engine_blown, 0);
    assert_eq!(d.engine_seized, 0);
}

// ---------------------------------------------------------- session history

#[test]
fn session_history_decodes_laps_sectors_flags_stints_and_references() {
    let laps = [
        history_lap(91_234, 0x0f),
        history_lap(92_500, 0x0b), // sector 2 invalid
        history_lap(0, 0x01),      // the current partial lap
    ];
    let bytes = session_history(
        h(40),
        PLAYER,
        &laps,
        &[(2, 16, 16), (255, 17, 17)],
        (1, 1, 2, 1),
    );
    accepted(&bytes, PacketKind::SessionHistory);
    let (_, history) = session_history::decode(&bytes).unwrap();
    assert_eq!(history.car_idx, PLAYER);
    assert_eq!(history.num_laps, 3);
    assert_eq!(history.laps.len(), 3);
    let first = history.laps[0];
    assert_eq!(first.lap_time_ms, 91_234);
    assert_eq!(first.sector1.total_ms, 30_100);
    assert_eq!(first.sector2.total_ms, 31_200);
    assert_eq!(first.sector3.total_ms, 91_234 - 61_300);
    assert!(first.lap_valid && first.sector1_valid && first.sector2_valid && first.sector3_valid);
    let second = history.laps[1];
    assert_eq!(second.lap_valid_bit_flags, 0x0b);
    assert!(
        second.lap_valid && second.sector1_valid && !second.sector2_valid && second.sector3_valid
    );
    assert_eq!(history.best_lap_time_lap_num, 1);
    assert_eq!(history.best_sector2_lap_num, 2);
    assert_eq!(history.tyre_stints.len(), 2);
    assert_eq!(history.tyre_stints[1].end_lap, 255);
    assert_eq!(
        history.tyre_stints[1].actual_compound,
        ActualTyreCompound::C4
    );
    // Minutes parts count.
    let long = HistoryLap {
        lap_ms: 125_000,
        s1: (5_000, 1),
        s2: (0, 0),
        s3: (0, 0),
        flags: 0,
    };
    let (_, history) =
        session_history::decode(&session_history(h(41), PLAYER, &[long], &[], (0, 0, 0, 0)))
            .unwrap();
    assert_eq!(history.laps[0].sector1.total_ms, 65_000);
    assert!(!history.laps[0].lap_valid);
}

// --------------------------------------------------------------- tyre sets

#[test]
fn tyre_sets_decode_all_twenty_sets_and_the_fitted_index() {
    let bytes = tyre_sets(h(50), PLAYER, 3);
    accepted(&bytes, PacketKind::TyreSets);
    let (_, sets) = tyre_sets::decode(&bytes).unwrap();
    assert_eq!(sets.car_idx, PLAYER);
    assert_eq!(sets.sets.len(), 20);
    assert_eq!(sets.fitted_idx, 3);
    let fitted = sets.sets[3];
    assert_eq!(fitted.fitted, 1);
    assert_eq!(fitted.actual_compound, ActualTyreCompound::C5);
    assert_eq!(fitted.wear_percent, 9);
    assert_eq!(fitted.life_span_laps, 17);
    assert_eq!(fitted.lap_delta_time_ms, 0);
    assert_eq!(fitted.recommended_session, SessionType::Practice3);
    let wet = sets.sets[19];
    assert_eq!(wet.visual_compound, VisualTyreCompound::Inter);
    assert_eq!(wet.lap_delta_time_ms, -1600);
}

// --------------------------------------------------------------- time trial

#[test]
fn time_trial_keeps_player_personal_best_and_rival_apart() {
    let bytes = time_trial(
        h(60),
        [
            TimeTrialSpec {
                car: 0,
                team: 8,
                lap_ms: 88_000,
                sectors: [28_000, 30_000, 30_000],
                valid: 1,
            },
            TimeTrialSpec {
                car: 1,
                team: 2,
                lap_ms: 87_500,
                sectors: [27_900, 29_800, 29_800],
                valid: 1,
            },
            TimeTrialSpec {
                car: 7,
                team: 1,
                lap_ms: 86_000,
                sectors: [27_000, 29_500, 29_500],
                valid: 0,
            },
        ],
    );
    accepted(&bytes, PacketKind::TimeTrial);
    let (_, tt) = time_trial::decode(&bytes).unwrap();
    assert_eq!(tt.player_session_best.car_idx, 0);
    assert_eq!(tt.player_session_best.team_id, TeamId::McLaren);
    assert_eq!(tt.player_session_best.lap_time_ms, 88_000);
    assert_eq!(tt.personal_best.car_idx, 1);
    assert_eq!(tt.personal_best.sector2_time_ms, 29_800);
    assert_eq!(tt.rival.car_idx, 7);
    assert_eq!(tt.rival.valid, 0);
    assert_eq!(tt.rival.traction_control, 1);
    assert_eq!(tt.rival.custom_setup, 1);
}

// ------------------------------------------------------------ lap positions

#[test]
fn lap_positions_read_the_player_column_and_skip_no_record() {
    let bytes = lap_positions(h(70), 4, 50, |row, car| {
        if row < 3 {
            (car + row) as u8 + 1
        } else {
            0
        }
    });
    accepted(&bytes, PacketKind::LapPositions);
    let (_, positions) = lap_positions::decode(&bytes).unwrap();
    assert_eq!(positions.num_laps, 4);
    assert_eq!(positions.lap_start, 50);
    // Row 3 has no record (0) and is left out, not reported as position 0.
    assert_eq!(
        positions.player,
        vec![
            lap_positions::LapPosition {
                lap_index: 50,
                position: PLAYER + 1
            },
            lap_positions::LapPosition {
                lap_index: 51,
                position: PLAYER + 2
            },
            lap_positions::LapPosition {
                lap_index: 52,
                position: PLAYER + 3
            },
        ]
    );
    // num_laps beyond 50 is bounded by the array.
    let full = lap_positions(h(71), 255, 0, |_, _| 1);
    assert_eq!(lap_positions::decode(&full).unwrap().1.player.len(), 50);
}

// ------------------------------------------------------- shared rejections

type Decoder = Box<dyn Fn(&[u8]) -> Option<DecodeError>>;

#[test]
fn truncated_or_mis_sized_packets_are_refused_by_every_new_decoder() {
    let cases: Vec<(Vec<u8>, Decoder)> = vec![
        (
            session(h(1), SessionSpec::default()),
            Box::new(|b| session::decode(b).err()),
        ),
        (
            event(h(1), b"SSTA", &[]),
            Box::new(|b| event::decode(b).err()),
        ),
        (
            participants(h(1), 1, &cars()),
            Box::new(|b| participants::decode(b).err()),
        ),
        (
            final_classification(
                h(1),
                1,
                &std::array::from_fn(|c| classification_for(c as u8)),
            ),
            Box::new(|b| final_classification::decode(b).err()),
        ),
        (
            car_damage(h(1), |c| c),
            Box::new(|b| car_damage::decode(b).err()),
        ),
        (
            session_history(h(1), PLAYER, &[], &[], (0, 0, 0, 0)),
            Box::new(|b| session_history::decode(b).err()),
        ),
        (
            tyre_sets(h(1), PLAYER, 0),
            Box::new(|b| tyre_sets::decode(b).err()),
        ),
        (
            time_trial(
                h(1),
                [TimeTrialSpec {
                    car: 0,
                    team: 0,
                    lap_ms: 0,
                    sectors: [0; 3],
                    valid: 0,
                }; 3],
            ),
            Box::new(|b| time_trial::decode(b).err()),
        ),
        (
            lap_positions(h(1), 0, 0, |_, _| 0),
            Box::new(|b| lap_positions::decode(b).err()),
        ),
    ];
    for (bytes, decode) in cases {
        let size = bytes.len();
        assert_eq!(
            decode(&bytes),
            None,
            "a well-formed packet of {size} bytes must decode"
        );
        assert!(matches!(
            decode(&bytes[..size - 1]),
            Some(DecodeError::Rejected {
                rejection: Rejection::SizeMismatch { .. }
            })
        ));
        assert!(matches!(
            decode(&bytes[..20]),
            Some(DecodeError::Rejected {
                rejection: Rejection::Truncated { size: 20 }
            })
        ));
        let mut longer = bytes.clone();
        longer.push(0);
        assert!(decode(&longer).is_some());
    }
    // A packet of one type is never decoded as another.
    let tyres = tyre_sets(h(1), PLAYER, 0);
    assert_eq!(
        session::decode(&tyres).err(),
        Some(DecodeError::WrongPacket {
            expected: PacketKind::Session,
            found: PacketKind::TyreSets
        })
    );
}

// ------------------------------------------------------- pinned fixtures

fn synthetic_directory() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/f1_25/synthetic")
}

/// The fixture set: one synthetic datagram per Phase D packet type, from the
/// writers above with fixed values.
fn synthetic_fixtures() -> Vec<(&'static str, Vec<u8>)> {
    let head = |frame| Head::new(0, u64::from_le_bytes(*b"SYNTHET!"), frame, 0);
    vec![
        ("id01-session.bin", session(head(1), SessionSpec::default())),
        (
            "id03-event-penalty.bin",
            event(head(2), b"PENA", &penalty_details(4, 17, 0, 255, 5, 3, 0)),
        ),
        (
            "id03-event-speed-trap.bin",
            event(
                head(3),
                b"SPTP",
                &speed_trap_details(0, 318.25, 1, 1, 0, 318.25),
            ),
        ),
        (
            "id04-participants.bin",
            participants(
                head(4),
                20,
                &std::array::from_fn(|c| participant_for(c as u8)),
            ),
        ),
        (
            "id08-final-classification.bin",
            final_classification(
                head(5),
                20,
                &std::array::from_fn(|c| classification_for(c as u8)),
            ),
        ),
        ("id10-car-damage.bin", car_damage(head(6), |car| car)),
        (
            "id11-session-history.bin",
            session_history(
                head(7),
                0,
                &[
                    history_lap(91_234, 0x0f),
                    history_lap(92_500, 0x0b),
                    history_lap(0, 0x01),
                ],
                &[(2, 16, 16), (255, 17, 17)],
                (1, 1, 2, 1),
            ),
        ),
        ("id12-tyre-sets.bin", tyre_sets(head(8), 0, 3)),
        (
            "id14-time-trial.bin",
            time_trial(
                head(9),
                [
                    TimeTrialSpec {
                        car: 0,
                        team: 8,
                        lap_ms: 88_000,
                        sectors: [28_000, 30_000, 30_000],
                        valid: 1,
                    },
                    TimeTrialSpec {
                        car: 1,
                        team: 2,
                        lap_ms: 87_500,
                        sectors: [27_900, 29_800, 29_800],
                        valid: 1,
                    },
                    TimeTrialSpec {
                        car: 7,
                        team: 1,
                        lap_ms: 86_000,
                        sectors: [27_000, 29_500, 29_500],
                        valid: 0,
                    },
                ],
            ),
        ),
        (
            "id15-lap-positions.bin",
            lap_positions(head(10), 3, 0, |row, car| ((car + row) % 22) as u8 + 1),
        ),
    ]
}

/// The checked-in synthetic binaries are byte-for-byte the writers' output,
/// each is its specification size and is accepted by the Phase A
/// classifier. `RACELAB_WRITE_SYNTHETIC_FIXTURES=1` regenerates them.
#[test]
fn pinned_synthetic_fixtures_match_their_specification_writers() {
    let directory = synthetic_directory();
    let regenerate = std::env::var("RACELAB_WRITE_SYNTHETIC_FIXTURES").is_ok_and(|v| v == "1");
    if regenerate {
        fs::create_dir_all(&directory).unwrap();
    }
    for (name, bytes) in synthetic_fixtures() {
        let id = name[2..4].parse::<u8>().unwrap();
        assert_eq!(bytes.len(), spec_size(id), "{name}");
        match classify(&bytes) {
            Classification::Accepted { kind, header } => {
                assert_eq!(kind.id(), id, "{name}");
                assert_eq!(&header.session_uid.to_le_bytes(), b"SYNTHET!", "{name}");
            }
            other => panic!("{name}: {other:?}"),
        }
        let path = directory.join(name);
        if regenerate {
            fs::write(&path, &bytes).unwrap();
        }
        let pinned = fs::read(&path).unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(pinned, bytes, "{name} differs from its writer");
    }
    // Synthetic and real fixtures never share a directory.
    let real = directory.parent().unwrap();
    for entry in fs::read_dir(real).unwrap().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        assert!(
            !name.ends_with(".bin"),
            "a fixture outside a labelled folder: {name}"
        );
    }
}

#[test]
fn pinned_synthetic_fixtures_decode_their_documented_values() {
    let read = |name: &str| fs::read(synthetic_directory().join(name)).unwrap();
    let (_, s) = session::decode(&read("id01-session.bin")).unwrap();
    assert_eq!(s.track_id, TrackId::Silverstone);
    assert_eq!(s.session_type, SessionType::Race);
    let (_, e) = event::decode(&read("id03-event-penalty.bin")).unwrap();
    assert!(matches!(
        e.details,
        EventDetails::Penalty {
            infringement_type: InfringementType::PitLaneSpeeding,
            ..
        }
    ));
    let (_, fc) = final_classification::decode(&read("id08-final-classification.bin")).unwrap();
    assert_eq!(fc.player.unwrap().position, 1);
    let (_, history) = session_history::decode(&read("id11-session-history.bin")).unwrap();
    assert_eq!(history.laps[1].lap_time_ms, 92_500);
    let (_, tt) = time_trial::decode(&read("id14-time-trial.bin")).unwrap();
    assert_eq!(tt.rival.lap_time_ms, 86_000);
}
