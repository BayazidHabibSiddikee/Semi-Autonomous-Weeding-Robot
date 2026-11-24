"""
Visual-Servoing Crop-Row Steering Controller (Stanley + Curvature Slowdown).
Converts filtered lateral error (e_y) and heading error (e_psi) into bounded
differential-drive Twist commands (linear_x, angular_z) sent to Nav2 Collision
Monitor (/cmd_vel_nav -> /cmd_vel_safe).
"""

import math
from dataclasses import dataclass
from .row_tracker import TrackedRowState


@dataclass
class SteeringCommand:
    linear_x_mps: float
    angular_z_rad_s: float
    reason: str


class CropRowController:
    def __init__(
        self,
        cruise_speed_mps: float = 0.15,
        min_speed_mps: float = 0.06,
        stanley_gain_k: float = 1.6,
        heading_gain_kp: float = 1.25,
        max_angular_z: float = 0.65,
        max_safe_lateral_error_m: float = 0.18,
    ):
        self.cruise_speed_mps = cruise_speed_mps
        self.min_speed_mps = min_speed_mps
        self.stanley_gain_k = stanley_gain_k
        self.heading_gain_kp = heading_gain_kp
        self.max_angular_z = max_angular_z
        self.max_safe_lateral_error_m = max_safe_lateral_error_m

    def compute_cmd(self, state: TrackedRowState, speed_limit_mps: float | None = None) -> SteeringCommand:
        if state.row_end_reached:
            return SteeringCommand(0.0, 0.0, "ROW_END_STOP")

        if not state.tracking_locked:
            return SteeringCommand(0.0, 0.0, "TRACKING_LOST_HOLD")

        if abs(state.lateral_error_m) > self.max_safe_lateral_error_m:
            # Stop forward travel and gently steer back toward row centerline to protect crops
            recovery_wz = max(
                -self.max_angular_z * 0.5,
                min(self.max_angular_z * 0.5, -math.copysign(0.25, state.lateral_error_m)),
            )
            return SteeringCommand(0.0, recovery_wz, "CROP_GUARD_RECOVERY")

        v_cap = min(self.cruise_speed_mps, speed_limit_mps) if speed_limit_mps else self.cruise_speed_mps

        # Stanley visual-servoing law:
        # omega = -kp_yaw * e_psi - atan2(k * e_y, v + 0.05)
        cross_track_term = math.atan2(self.stanley_gain_k * state.lateral_error_m, v_cap + 0.05)
        raw_wz = -(self.heading_gain_kp * state.heading_error_rad + cross_track_term)
        wz = max(-self.max_angular_z, min(self.max_angular_z, raw_wz))

        # Reduce forward speed proportionally during larger heading/lateral corrections
        turn_ratio = abs(wz) / self.max_angular_z
        vx = max(self.min_speed_mps, v_cap * (1.0 - 0.55 * turn_ratio))

        return SteeringCommand(vx, wz, "FOLLOWING_ROW")
