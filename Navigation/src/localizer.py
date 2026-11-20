"""
Continuous Field Localizer: Wheel Encoder Odometry + IMU Heading Fusion + Landmark Reset.
Fixes NAV-01 (wheel encoder displacement), NAV-02 (IMU heading measurement),
NAV-03 (continuous pose on BEV field map), and NAV-10 (slip detection & explicit
re-localization after wheel slip or manual movement).
"""

import math
from dataclasses import dataclass


def normalize_angle_deg(deg: float) -> float:
    return ((deg + 180.0) % 360.0) - 180.0


@dataclass
class Pose2D:
    x_cm: float
    y_cm: float
    heading_deg: float
    slip_residual_cm: float = 0.0
    localized: bool = True


class FieldLocalizer:
    """
    Fuses:
      1. Differential-drive quadrature wheel encoders (local linear displacement)
      2. 9-DOF IMU yaw/gyro (true physical heading, eliminating blind turn error)
      3. Periodic ArUco / field-landmark / downward crop-row corrections
    """

    def __init__(
        self,
        wheel_radius_cm: float = 3.5,
        wheel_separation_cm: float = 17.4,
        skid_multiplier: float = 1.18,
        ticks_per_rev: float = 17280.0,
        imu_weight: float = 0.85,
        max_slip_residual_cm: float = 18.0,
    ):
        self.wheel_radius_cm = wheel_radius_cm
        self.eff_separation_cm = wheel_separation_cm * skid_multiplier
        self.cm_per_tick = (2.0 * math.pi * wheel_radius_cm) / ticks_per_rev
        self.imu_weight = max(0.0, min(1.0, imu_weight))
        self.max_slip_residual_cm = max_slip_residual_cm

        self.x_cm = 0.0
        self.y_cm = 0.0
        self.heading_deg = 0.0

        self._prev_l_ticks: int | None = None
        self._prev_r_ticks: int | None = None
        self._prev_imu_deg: float | None = None
        self.slip_residual_cm = 0.0
        self.localized = True

    def reset_pose(self, x_cm: float, y_cm: float, heading_deg: float, left_ticks: int | None = None, right_ticks: int | None = None):
        """Explicit re-localization from start datum, ArUco marker, or operator fix (NAV-10)."""
        self.x_cm = float(x_cm)
        self.y_cm = float(y_cm)
        self.heading_deg = normalize_angle_deg(heading_deg)
        if left_ticks is not None:
            self._prev_l_ticks = left_ticks
        if right_ticks is not None:
            self._prev_r_ticks = right_ticks
        self._prev_imu_deg = None
        self.slip_residual_cm = 0.0
        self.localized = True

    def update(self, left_ticks: int, right_ticks: int, imu_heading_deg: float | None = None) -> Pose2D:
        """Integrate encoder ticks and fuse IMU heading delta."""
        if self._prev_l_ticks is None or self._prev_r_ticks is None:
            self._prev_l_ticks = left_ticks
            self._prev_r_ticks = right_ticks
            if imu_heading_deg is not None:
                self._prev_imu_deg = imu_heading_deg
                self.heading_deg = normalize_angle_deg(imu_heading_deg)
            return self.get_pose()

        dl_cm = (left_ticks - self._prev_l_ticks) * self.cm_per_tick
        dr_cm = (right_ticks - self._prev_r_ticks) * self.cm_per_tick
        self._prev_l_ticks = left_ticks
        self._prev_r_ticks = right_ticks

        ds_cm = 0.5 * (dl_cm + dr_cm)
        dtheta_enc_deg = math.degrees((dr_cm - dl_cm) / self.eff_separation_cm)

        if imu_heading_deg is not None:
            if self._prev_imu_deg is None:
                dtheta_imu_deg = dtheta_enc_deg
            else:
                dtheta_imu_deg = normalize_angle_deg(imu_heading_deg - self._prev_imu_deg)
            self._prev_imu_deg = imu_heading_deg

            # Detect wheel slip when encoder yaw diverges sharply from IMU yaw
            yaw_discrepancy_deg = abs(normalize_angle_deg(dtheta_imu_deg - dtheta_enc_deg))
            self.slip_residual_cm += math.radians(yaw_discrepancy_deg) * (self.eff_separation_cm * 0.5)
            dtheta_deg = (1.0 - self.imu_weight) * dtheta_enc_deg + self.imu_weight * dtheta_imu_deg
        else:
            dtheta_deg = dtheta_enc_deg

        # RK2 midpoint pose integration
        mid_rad = math.radians(self.heading_deg + 0.5 * dtheta_deg)
        self.x_cm += ds_cm * math.cos(mid_rad)
        self.y_cm += ds_cm * math.sin(mid_rad)
        self.heading_deg = normalize_angle_deg(self.heading_deg + dtheta_deg)

        if self.slip_residual_cm > self.max_slip_residual_cm:
            self.localized = False

        return self.get_pose()

    def apply_landmark_correction(self, x_obs_cm: float, y_obs_cm: float, heading_obs_deg: float | None = None, gain: float = 0.7):
        """Apply ArUco marker or downward crop-row visual correction (NAV-03, NAV-10)."""
        self.x_cm += gain * (x_obs_cm - self.x_cm)
        self.y_cm += gain * (y_obs_cm - self.y_cm)
        if heading_obs_deg is not None:
            err = normalize_angle_deg(heading_obs_deg - self.heading_deg)
            self.heading_deg = normalize_angle_deg(self.heading_deg + gain * err)
        self.slip_residual_cm = max(0.0, self.slip_residual_cm * (1.0 - gain))
        self.localized = True

    def get_pose(self) -> Pose2D:
        return Pose2D(
            x_cm=self.x_cm,
            y_cm=self.y_cm,
            heading_deg=self.heading_deg,
            slip_residual_cm=self.slip_residual_cm,
            localized=self.localized,
        )
