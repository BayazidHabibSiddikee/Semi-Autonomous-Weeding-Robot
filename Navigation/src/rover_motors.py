"""
Closed-Loop Differential-Drive Motor Controller over Shared ESP32Bridge.
Fixes:
  - NAV-01: Uses real wheel-encoder displacement via FieldLocalizer (no duration*10 guesses).
  - NAV-02: Uses IMU + encoder fused heading for closed-loop rotations (no blind heading+=deg).
  - NAV-06: Accepts a single shared ESP32Bridge instance instead of opening /dev/ttyUSB0 twice.
"""

import math
import time
from typing import Callable

from localizer import FieldLocalizer, normalize_angle_deg


class RoverMotors:
    """Closed-loop differential drive controller sharing one ESP32Bridge."""

    def __init__(
        self,
        esp32_bridge,
        localizer: FieldLocalizer,
        imu_heading_fn: Callable[[], float | None] | None = None,
        wheel_radius_cm: float = 3.5,
        wheel_separation_cm: float = 17.4,
        skid_multiplier: float = 1.18,
        cruise_linear_cms: float = 15.0,
        turn_angular_deg_s: float = 35.0,
        heading_tolerance_deg: float = 2.5,
        control_dt_s: float = 0.02,
        step_physics_fn: Callable[[float], None] | None = None,
    ):
        if esp32_bridge is None:
            raise ValueError("RoverMotors requires a shared ESP32Bridge instance (NAV-06).")
        self.bridge = esp32_bridge
        self.localizer = localizer
        self.imu_heading_fn = imu_heading_fn
        self.wheel_radius_cm = wheel_radius_cm
        self.eff_sep_cm = wheel_separation_cm * skid_multiplier
        self.cruise_linear_cms = cruise_linear_cms
        self.turn_angular_deg_s = turn_angular_deg_s
        self.heading_tolerance_deg = heading_tolerance_deg
        self.control_dt_s = control_dt_s
        self._step_physics_fn = step_physics_fn

    def _twist_to_wheel_rad_s(self, linear_cms: float, angular_deg_s: float) -> tuple[float, float]:
        omega_rad_s = math.radians(angular_deg_s)
        v_left = linear_cms - (omega_rad_s * self.eff_sep_cm / 2.0)
        v_right = linear_cms + (omega_rad_s * self.eff_sep_cm / 2.0)
        return v_left / self.wheel_radius_cm, v_right / self.wheel_radius_cm

    def _sync_localizer(self) -> tuple[bool, str]:
        """Read encoder telemetry from shared ESP32Bridge and update FieldLocalizer."""
        telem = self.bridge.read_telemetry()
        if not telem.valid:
            self.stop()
            return False, "TELEMETRY_INVALID"
        if not telem.estop_ok:
            self.stop()
            return False, "HARDWARE_ESTOP_ACTIVE"
        imu_deg = self.imu_heading_fn() if self.imu_heading_fn else None
        self.localizer.update(telem.left_ticks, telem.right_ticks, imu_heading_deg=imu_deg)
        return True, "OK"

    def set_velocity(self, linear_cms: float, angular_deg_s: float) -> tuple[bool, str]:
        wl, wr = self._twist_to_wheel_rad_s(linear_cms, angular_deg_s)
        return self.bridge.send_velocity(wl, wr)

    def move_distance(
        self,
        target_cm: float,
        target_heading_deg: float | None = None,
        linear_cms: float | None = None,
        abort_check_fn: Callable[[], tuple[bool, str]] | None = None,
        max_ticks: int = 400,
    ) -> tuple[bool, float, str]:
        """
        Closed-loop linear travel using wheel encoders + IMU heading hold (NAV-01, NAV-02).
        Returns (success, actual_distance_cm, reason).
        """
        speed = abs(linear_cms if linear_cms is not None else self.cruise_linear_cms)
        direction = 1.0 if target_cm >= 0.0 else -1.0
        goal_dist = abs(target_cm)

        ok, reason = self._sync_localizer()
        if not ok:
            return False, 0.0, reason

        start_pose = self.localizer.get_pose()
        hold_heading = start_pose.heading_deg if target_heading_deg is None else target_heading_deg
        traveled = 0.0

        for _ in range(max_ticks):
            if abort_check_fn is not None:
                safe, abort_reason = abort_check_fn()
                if not safe:
                    self.stop()
                    return False, traveled, abort_reason

            pose = self.localizer.get_pose()
            traveled = math.hypot(pose.x_cm - start_pose.x_cm, pose.y_cm - start_pose.y_cm)
            if traveled >= goal_dist - 0.4:
                self.stop()
                return True, traveled, "DISTANCE_REACHED"

            # Proportional heading hold during straight travel
            yaw_err = normalize_angle_deg(hold_heading - pose.heading_deg)
            wz = max(-25.0, min(25.0, yaw_err * 1.4))
            remaining = max(0.0, goal_dist - traveled)
            v_cmd = direction * min(speed, max(5.0, remaining * 1.8))

            sent_ok, resp = self.set_velocity(v_cmd, wz)
            if not sent_ok:
                self.stop()
                return False, traveled, resp

            if self._step_physics_fn:
                self._step_physics_fn(self.control_dt_s)
            else:
                time.sleep(self.control_dt_s)

            ok, reason = self._sync_localizer()
            if not ok:
                return False, traveled, reason

        self.stop()
        return False, traveled, "MOVE_TIMEOUT"

    def rotate_to_heading(
        self,
        target_heading_deg: float,
        abort_check_fn: Callable[[], tuple[bool, str]] | None = None,
        max_ticks: int = 350,
    ) -> tuple[bool, str]:
        """Closed-loop rotation using fused IMU + encoder heading (NAV-02)."""
        ok, reason = self._sync_localizer()
        if not ok:
            return False, reason

        for _ in range(max_ticks):
            if abort_check_fn is not None:
                safe, abort_reason = abort_check_fn()
                if not safe:
                    self.stop()
                    return False, abort_reason

            pose = self.localizer.get_pose()
            err = normalize_angle_deg(target_heading_deg - pose.heading_deg)
            if abs(err) <= self.heading_tolerance_deg:
                self.stop()
                return True, "HEADING_REACHED"

            wz = max(-self.turn_angular_deg_s, min(self.turn_angular_deg_s, err * 1.8))
            if abs(wz) < 8.0:
                wz = math.copysign(8.0, err)

            sent_ok, resp = self.set_velocity(0.0, wz)
            if not sent_ok:
                self.stop()
                return False, resp

            if self._step_physics_fn:
                self._step_physics_fn(self.control_dt_s)
            else:
                time.sleep(self.control_dt_s)

            ok, reason = self._sync_localizer()
            if not ok:
                return False, reason

        self.stop()
        return False, "ROTATE_TIMEOUT"

    def rotate_by(self, delta_deg: float, abort_check_fn=None) -> tuple[bool, str]:
        pose = self.localizer.get_pose()
        target = normalize_angle_deg(pose.heading_deg + delta_deg)
        return self.rotate_to_heading(target, abort_check_fn=abort_check_fn)

    def stop(self):
        self.bridge.send_stop()

    def emergency_stop(self):
        self.bridge.send_stop()

    def get_position(self) -> tuple[float, float, float]:
        p = self.localizer.get_pose()
        return p.x_cm, p.y_cm, p.heading_deg


def create_rover(esp32_bridge, localizer: FieldLocalizer, config: dict, imu_heading_fn=None, step_physics_fn=None) -> RoverMotors:
    """Factory creating closed-loop RoverMotors over a single shared ESP32Bridge."""
    geo = config["rover"]["geometry"]
    mot = config["rover"]["motor"]
    imu = config["rover"]["imu"]
    return RoverMotors(
        esp32_bridge=esp32_bridge,
        localizer=localizer,
        imu_heading_fn=imu_heading_fn,
        wheel_radius_cm=geo["wheel_radius_cm"],
        wheel_separation_cm=geo["wheel_separation_cm"],
        skid_multiplier=geo["skid_steer_multiplier"],
        cruise_linear_cms=mot["cruise_linear_cms"],
        turn_angular_deg_s=mot["turn_angular_deg_s"],
        heading_tolerance_deg=imu["heading_tolerance_deg"],
        step_physics_fn=step_physics_fn,
    )
