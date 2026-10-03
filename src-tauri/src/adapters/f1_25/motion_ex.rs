//! Packet 13, Motion Ex. `PacketMotionExData` (273 bytes): header (29), then
//! sixty-one floats of "extra player car ONLY data". There is no per-car
//! array, so `playerCarIndex` does not select anything here; RaceLab still
//! reports the packet as unavailable when that index is invalid, because the
//! specification does not say whose car the data describes when there is no
//! valid player (e.g. spectating).
use super::{
    accepted_as, player_index, reader::Reader, DecodeError, PacketHeader, PacketKind, Wheels,
    HEADER_SIZE,
};
use serde::Serialize;

/// Field for field. Units are given only where the specification gives
/// them; every wheel array is RL, RR, FL, FR on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct MotionEx {
    pub suspension_position: Wheels<f32>,
    pub suspension_velocity: Wheels<f32>,
    pub suspension_acceleration: Wheels<f32>,
    /// "Speed of each wheel". No unit given.
    pub wheel_speed: Wheels<f32>,
    pub wheel_slip_ratio: Wheels<f32>,
    pub wheel_slip_angle: Wheels<f32>,
    pub wheel_lat_force: Wheels<f32>,
    pub wheel_long_force: Wheels<f32>,
    /// "Height of centre of gravity above ground". No unit given.
    pub height_of_cog_above_ground: f32,
    /// Metres per second, local space.
    pub local_velocity_mps: Vector,
    /// Radians per second.
    pub angular_velocity_rad_s: Vector,
    /// Radians per second per second.
    pub angular_acceleration_rad_s2: Vector,
    /// Radians.
    pub front_wheels_angle_rad: f32,
    pub wheel_vert_force: Wheels<f32>,
    /// "Front plank edge height above road surface". No unit given.
    pub front_aero_height: f32,
    /// "Rear plank edge height above road surface". No unit given.
    pub rear_aero_height: f32,
    /// "Roll angle of the front suspension". No unit given.
    pub front_roll_angle: f32,
    /// "Roll angle of the rear suspension". No unit given.
    pub rear_roll_angle: f32,
    /// Radians, relative to the direction of motion.
    pub chassis_yaw_rad: f32,
    /// Radians, relative to the direction of motion.
    pub chassis_pitch_rad: f32,
    /// Radians.
    pub wheel_camber_rad: Wheels<f32>,
    /// Radians: "difference between active camber and dynamic camber".
    pub wheel_camber_gain_rad: Wheels<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct Vector {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct MotionExPacket {
    /// `None` when `playerCarIndex` is not a valid car index.
    pub player: Option<MotionEx>,
}

pub(crate) fn fields(bytes: &[u8]) -> MotionEx {
    let mut r = Reader::new(bytes, HEADER_SIZE);
    let wheels = |r: &mut Reader<'_>| r.wheels(Reader::f32);
    let vector = |r: &mut Reader<'_>| Vector {
        x: r.f32(),
        y: r.f32(),
        z: r.f32(),
    };
    let motion = MotionEx {
        suspension_position: wheels(&mut r),
        suspension_velocity: wheels(&mut r),
        suspension_acceleration: wheels(&mut r),
        wheel_speed: wheels(&mut r),
        wheel_slip_ratio: wheels(&mut r),
        wheel_slip_angle: wheels(&mut r),
        wheel_lat_force: wheels(&mut r),
        wheel_long_force: wheels(&mut r),
        height_of_cog_above_ground: r.f32(),
        local_velocity_mps: vector(&mut r),
        angular_velocity_rad_s: vector(&mut r),
        angular_acceleration_rad_s2: vector(&mut r),
        front_wheels_angle_rad: r.f32(),
        wheel_vert_force: wheels(&mut r),
        front_aero_height: r.f32(),
        rear_aero_height: r.f32(),
        front_roll_angle: r.f32(),
        rear_roll_angle: r.f32(),
        chassis_yaw_rad: r.f32(),
        chassis_pitch_rad: r.f32(),
        wheel_camber_rad: wheels(&mut r),
        wheel_camber_gain_rad: wheels(&mut r),
    };
    debug_assert_eq!(r.position(), bytes.len());
    motion
}

pub fn decode(bytes: &[u8]) -> Result<(PacketHeader, MotionExPacket), DecodeError> {
    let header = accepted_as(bytes, PacketKind::MotionEx)?;
    Ok((
        header,
        MotionExPacket {
            player: player_index(&header).map(|_| fields(bytes)),
        },
    ))
}
