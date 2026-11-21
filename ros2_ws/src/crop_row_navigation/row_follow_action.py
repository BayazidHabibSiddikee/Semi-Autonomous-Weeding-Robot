"""
ROS 2 Jazzy Action Server: FollowCropRow

Implements closed-loop single-row following with real-time weed-to-base_link
distance calculation and precision treatment positioning:
  1. Real `rclpy.action.ActionServer` on `/follow_crop_row` with explicit
     `goal_callback`, `handle_accepted_callback`, `cancel_callback`, and
     `execute_callback` bound directly to goal completion (`succeed`),
     cancellation (`canceled`), and fault/E-stop abort (`abort`) cycles.
  2. Real-time metric weed localization in `base_link` (`WeedBaseDistanceEstimator`):
     projects detected weed pixel coordinates into the rover's `base_link` frame
     (ROS REP-103: +X forward, +Y left, +Z up) using (in priority order):
       a) Calibrated 3x3 pixel-to-ground homography + camera-to-base extrinsic offset
       b) Live RGB-D depth reading (MaixSense ToF) + camera intrinsics + pitch/yaw/offset
       c) Flat-ground pinhole ray-plane intersection using camera height, pitch, yaw & FOV
     Applies real-time odometry latency compensation `(vx_mps, wz_rad_s, detection_age_s)`
     so `x_base_m`, `y_base_m`, `distance_from_base_m`, and actuator alignment offsets
     `(dx_to_actuator_m, dy_to_actuator_m)` remain accurate while the rover is moving.
  3. Precision treatment positioning (`TreatmentPositioningController`):
     dynamically modulates row-following velocity based on each weed's real-time
     distance to `base_link` and the mounted treatment actuator:
       - `CRUISE`: normal row-following speed
       - `APPROACH_SLOWDOWN`: proportional deceleration as a weed nears the actuator
       - `TREATMENT_ALIGNED_HOLD`: zero-velocity stationary stop when aligned within
         longitudinal & lateral treatment tolerances, publishing `/crop_row/treatment_target_base`
  4. Publishes `/cmd_vel_nav` (always filtered through Nav2 Collision Monitor ->
     `/cmd_vel_safe` before ESP32), `/crop_row/nearest_weed_base` (`PointStamped` in
     `base_link`), `/crop_row/treatment_target_base` (`PointStamped` in `base_link`),
     and `/crop_row/weed_base_distances` (JSON telemetry).
  5. Halts immediately (zero velocity) on row end, goal cancellation, stale frames,
     or hardware E-stop.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import json
import math
import os
import threading
import time
from typing import Any, Callable

try:
    import rclpy
    from rclpy.node import Node
    from rclpy.action import ActionServer, GoalResponse, CancelResponse
    from rclpy.callback_groups import ReentrantCallbackGroup
    from rclpy.executors import MultiThreadedExecutor
    from geometry_msgs.msg import PointStamped, Twist
    from nav_msgs.msg import Odometry
    from sensor_msgs.msg import Image
    from std_msgs.msg import Bool, String
    from cv_bridge import CvBridge
    ROS2_AVAILABLE = True
except ImportError:
    ROS2_AVAILABLE = False

try:
    from tf2_ros import Buffer as Tf2Buffer, TransformListener as Tf2TransformListener  # type: ignore[import-not-found]
    TF2_AVAILABLE = True
except ImportError:
    Tf2Buffer = None  # type: ignore[assignment]
    Tf2TransformListener = None  # type: ignore[assignment]
    TF2_AVAILABLE = False

try:
    from crop_row_navigation.action import FollowCropRow as RowFollowActionType  # type: ignore[import-not-found]
    CUSTOM_ACTION_AVAILABLE = True
except ImportError:
    RowFollowActionType = None
    CUSTOM_ACTION_AVAILABLE = False
    if ROS2_AVAILABLE:
        try:
            from nav2_msgs.action import FollowWaypoints as RowFollowActionType  # type: ignore[import-not-found]
        except ImportError:
            RowFollowActionType = None

try:
    from .row_detector import CropRowDetector
    from .row_tracker import CropRowTracker
    from .row_controller import CropRowController
except ImportError:  # pragma: no cover - allows direct module import in unit tests
    CropRowDetector = None  # type: ignore[assignment]
    CropRowTracker = None  # type: ignore[assignment]
    CropRowController = None  # type: ignore[assignment]


@dataclass
class WeedBaseMeasurement:
    """Real-time metric weed position expressed in the rover's `base_link` frame."""

    class_name: str
    confidence: float
    u_px: float
    v_px: float
    x_base_m: float                # +X forward from base_link origin (m), latency-compensated
    y_base_m: float                # +Y left of base_link origin (ROS REP-103, m)
    distance_from_base_m: float    # Euclidean ground distance hypot(x_base_m, y_base_m)
    bearing_rad: float             # atan2(y_base_m, x_base_m) relative to base_link heading
    dx_to_actuator_m: float        # Forward travel remaining to align weed under actuator (m)
    dy_to_actuator_m: float        # Lateral offset from treatment actuator center (m)
    distance_to_actuator_m: float  # Euclidean ground distance from actuator origin (m)
    latency_compensated_s: float   # Detection age compensated via live odometry velocity (s)
    method: str                    # 'homography' | 'rgbd_depth' | 'pinhole_ground'
    in_treatment_reach: bool
    ready_for_treatment: bool

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class TreatmentPositioningDecision:
    """Velocity modulation & alignment state derived from real-time base_link weed distances."""

    mode: str                      # 'CRUISE' | 'APPROACH_SLOWDOWN' | 'TREATMENT_ALIGNED_HOLD'
    linear_x_mps: float
    angular_z_rad_s: float
    aligned_for_treatment: bool
    target_weed: WeedBaseMeasurement | None = None


class WeedBaseDistanceEstimator:
    """
    Computes the real-time physical distance of every detected weed relative to the
    rover's `base_link` coordinate system (ROS REP-103: +X forward, +Y left, +Z up)
    and relative to the mounted weeding actuator origin in `base_link`.

    Supports three measurement modes (highest accuracy first):
      1. Calibrated 3x3 pixel-to-ground homography (in mm or m) + base_link mount offset
      2. Live RGB-D depth reading at (u_px, v_px) + camera intrinsics & mount pitch/yaw
      3. Flat-ground pinhole ray-plane intersection using camera height, pitch, yaw & FOV

    Applies real-time odometry motion compensation (`detection_age_s`, `linear_vx_mps`,
    `angular_wz_rad_s`) to correct for camera/inference pipeline latency while moving.
    """

    def __init__(
        self,
        *,
        camera_offset_x_m: float = 0.22,
        camera_offset_y_m: float = 0.0,
        camera_height_m: float = 0.42,
        camera_pitch_deg: float = 35.0,
        camera_yaw_deg: float = 0.0,
        fov_h_deg: float = 68.0,
        fov_v_deg: float = 52.0,
        image_width_px: int = 640,
        image_height_px: int = 480,
        homography_matrix: list[list[float]] | None = None,
        homography_units: str = "mm",
        actuator_offset_x_m: float = 0.25,
        actuator_offset_y_m: float = 0.0,
        treatment_reach_min_m: float = 0.15,
        treatment_reach_max_m: float = 0.85,
        treatment_stop_tolerance_m: float = 0.04,
        treatment_lateral_tolerance_m: float = 0.14,
    ):
        self.camera_offset_x_m = float(camera_offset_x_m)
        self.camera_offset_y_m = float(camera_offset_y_m)
        self.camera_height_m = max(0.05, float(camera_height_m))
        self.camera_pitch_rad = math.radians(max(5.0, min(89.0, float(camera_pitch_deg))))
        self.camera_yaw_rad = math.radians(max(-45.0, min(45.0, float(camera_yaw_deg))))
        self.fov_h_rad = math.radians(max(10.0, min(140.0, float(fov_h_deg))))
        self.fov_v_rad = math.radians(max(10.0, min(120.0, float(fov_v_deg))))
        self.image_width_px = max(16, int(image_width_px))
        self.image_height_px = max(16, int(image_height_px))
        self.homography_matrix = homography_matrix
        self.homography_units = homography_units
        self.actuator_offset_x_m = float(actuator_offset_x_m)
        self.actuator_offset_y_m = float(actuator_offset_y_m)
        self.treatment_reach_min_m = float(treatment_reach_min_m)
        self.treatment_reach_max_m = float(treatment_reach_max_m)
        self.treatment_stop_tolerance_m = max(0.005, float(treatment_stop_tolerance_m))
        self.treatment_lateral_tolerance_m = max(0.01, float(treatment_lateral_tolerance_m))

    def _apply_camera_yaw_and_offset(self, x_cam_m: float, y_cam_m: float) -> tuple[float, float]:
        if abs(self.camera_yaw_rad) > 1e-6:
            cy = math.cos(self.camera_yaw_rad)
            sy = math.sin(self.camera_yaw_rad)
            xr = x_cam_m * cy - y_cam_m * sy
            yr = x_cam_m * sy + y_cam_m * cy
        else:
            xr, yr = x_cam_m, y_cam_m
        return self.camera_offset_x_m + xr, self.camera_offset_y_m + yr

    def _project_via_homography(self, u_px: float, v_px: float) -> tuple[float, float] | None:
        H = self.homography_matrix
        if H is None or len(H) != 3 or any(len(r) != 3 for r in H):
            return None
        w = H[2][0] * u_px + H[2][1] * v_px + H[2][2]
        if abs(w) < 1e-9:
            return None
        # TargetExecutionManager convention: col 0 -> lateral (right +), col 1 -> forward ahead of camera
        lat_val = (H[0][0] * u_px + H[0][1] * v_px + H[0][2]) / w
        fwd_val = (H[1][0] * u_px + H[1][1] * v_px + H[1][2]) / w
        scale = 0.001 if self.homography_units == "mm" else 1.0
        # ROS REP-103: +Y is left, so negate right-positive lateral value
        return self._apply_camera_yaw_and_offset(fwd_val * scale, -lat_val * scale)

    def _project_via_depth(
        self,
        u_px: float,
        v_px: float,
        depth_m: float,
        img_w: int,
        img_h: int,
    ) -> tuple[float, float] | None:
        if not (math.isfinite(depth_m) and 0.08 <= depth_m <= 6.0):
            return None
        fx = (img_w * 0.5) / math.tan(self.fov_h_rad * 0.5)
        fy = (img_h * 0.5) / math.tan(self.fov_v_rad * 0.5)
        cx = img_w * 0.5
        cy = img_h * 0.5

        # Camera optical frame: +Z forward along optical axis, +X right, +Y down
        x_opt = ((u_px - cx) / fx) * depth_m
        y_opt = ((v_px - cy) / fy) * depth_m
        z_opt = depth_m

        # Rotate optical frame (pitched down by camera_pitch_rad) into horizontal base_link plane
        cp = math.cos(self.camera_pitch_rad)
        sp = math.sin(self.camera_pitch_rad)
        x_cam_ground = z_opt * cp - y_opt * sp
        y_cam_ground = -x_opt  # +Y left in base_link

        return self._apply_camera_yaw_and_offset(x_cam_ground, y_cam_ground)

    def _project_via_pinhole_ground(
        self,
        u_px: float,
        v_px: float,
        img_w: int,
        img_h: int,
    ) -> tuple[float, float] | None:
        fx = (img_w * 0.5) / math.tan(self.fov_h_rad * 0.5)
        fy = (img_h * 0.5) / math.tan(self.fov_v_rad * 0.5)
        cx = img_w * 0.5
        cy = img_h * 0.5

        # Normalized ray in camera optical frame (+X right, +Y down, +Z forward)
        rx = (u_px - cx) / fx
        ry = (v_px - cy) / fy
        rz = 1.0

        # Transform ray direction into horizontal camera frame (+X forward, +Y left, +Z up)
        cp = math.cos(self.camera_pitch_rad)
        sp = math.sin(self.camera_pitch_rad)
        dir_x = rz * cp - ry * sp
        dir_y = -rx
        dir_z = -(rz * sp + ry * cp)

        # Ray must point downward toward the ground plane (z = 0) from camera_height_m
        if dir_z >= -1e-4:
            return None

        t = -self.camera_height_m / dir_z
        if t <= 0.0 or t > 10.0:
            return None

        return self._apply_camera_yaw_and_offset(dir_x * t, dir_y * t)

    @staticmethod
    def _compensate_motion(
        x_base_m: float,
        y_base_m: float,
        *,
        detection_age_s: float = 0.0,
        linear_vx_mps: float = 0.0,
        angular_wz_rad_s: float = 0.0,
    ) -> tuple[float, float, float]:
        """
        Propagate a ground weed coordinate captured `detection_age_s` ago from the
        past `base_link(t - dt)` into the live `base_link(t)` using rover velocity.
        """
        dt = max(0.0, min(0.5, float(detection_age_s)))
        if dt <= 1e-6 or (abs(linear_vx_mps) <= 1e-6 and abs(angular_wz_rad_s) <= 1e-6):
            return x_base_m, y_base_m, 0.0

        dx = float(linear_vx_mps) * dt
        dtheta = float(angular_wz_rad_s) * dt
        x_shift = x_base_m - dx
        y_shift = y_base_m
        c = math.cos(-dtheta)
        s = math.sin(-dtheta)
        x_rt = x_shift * c - y_shift * s
        y_rt = x_shift * s + y_shift * c
        return x_rt, y_rt, dt

    def measure_weed(
        self,
        *,
        u_px: float,
        v_px: float,
        class_name: str = "weed_other",
        confidence: float = 1.0,
        depth_m: float | None = None,
        image_width_px: int | None = None,
        image_height_px: int | None = None,
        detection_age_s: float = 0.0,
        linear_vx_mps: float = 0.0,
        angular_wz_rad_s: float = 0.0,
    ) -> WeedBaseMeasurement | None:
        """
        Compute real-time metric position and distance of a weed relative to `base_link`
        and the treatment actuator origin. Returns None if pixel ray points above the
        horizon or coordinates are invalid.
        """
        if not (math.isfinite(u_px) and math.isfinite(v_px)):
            return None
        img_w = max(16, int(image_width_px or self.image_width_px))
        img_h = max(16, int(image_height_px or self.image_height_px))

        projected: tuple[float, float] | None = None
        method = "pinhole_ground"

        if self.homography_matrix is not None:
            projected = self._project_via_homography(u_px, v_px)
            if projected is not None:
                method = "homography"

        if projected is None and depth_m is not None:
            projected = self._project_via_depth(u_px, v_px, float(depth_m), img_w, img_h)
            if projected is not None:
                method = "rgbd_depth"

        if projected is None:
            projected = self._project_via_pinhole_ground(u_px, v_px, img_w, img_h)
            method = "pinhole_ground"

        if projected is None:
            return None

        x_base_m, y_base_m, comp_dt = self._compensate_motion(
            projected[0],
            projected[1],
            detection_age_s=detection_age_s,
            linear_vx_mps=linear_vx_mps,
            angular_wz_rad_s=angular_wz_rad_s,
        )

        dist_m = math.hypot(x_base_m, y_base_m)
        bearing = math.atan2(y_base_m, x_base_m)
        dx_act = x_base_m - self.actuator_offset_x_m
        dy_act = y_base_m - self.actuator_offset_y_m
        dist_act = math.hypot(dx_act, dy_act)

        in_reach = self.treatment_reach_min_m <= dist_m <= self.treatment_reach_max_m and x_base_m >= 0.0
        ready = (
            abs(dx_act) <= self.treatment_stop_tolerance_m
            and abs(dy_act) <= self.treatment_lateral_tolerance_m
        )

        return WeedBaseMeasurement(
            class_name=str(class_name),
            confidence=round(float(confidence), 3),
            u_px=round(float(u_px), 1),
            v_px=round(float(v_px), 1),
            x_base_m=round(x_base_m, 4),
            y_base_m=round(y_base_m, 4),
            distance_from_base_m=round(dist_m, 4),
            bearing_rad=round(bearing, 4),
            dx_to_actuator_m=round(dx_act, 4),
            dy_to_actuator_m=round(dy_act, 4),
            distance_to_actuator_m=round(dist_act, 4),
            latency_compensated_s=round(comp_dt, 4),
            method=method,
            in_treatment_reach=in_reach,
            ready_for_treatment=ready,
        )

    def measure_batch(
        self,
        detections: list[dict[str, Any]],
        *,
        image_width_px: int | None = None,
        image_height_px: int | None = None,
        depth_lookup_fn: Callable[[float, float], float | None] | None = None,
        detection_age_s: float = 0.0,
        linear_vx_mps: float = 0.0,
        angular_wz_rad_s: float = 0.0,
    ) -> list[WeedBaseMeasurement]:
        """Measure all weed detections relative to `base_link`, sorted nearest-first."""
        results: list[WeedBaseMeasurement] = []
        for det in detections:
            cname = str(det.get("class_name", "weed_other")).strip().lower()
            if cname.startswith("crop_"):
                continue  # Never measure protected crops as weed targets
            try:
                u_px = float(det["u_px"])
                v_px = float(det["v_px"])
            except (KeyError, TypeError, ValueError):
                continue
            conf = float(det.get("confidence", 1.0))
            depth_val = det.get("depth_m")
            if depth_val is None and depth_lookup_fn is not None:
                depth_val = depth_lookup_fn(u_px, v_px)
            m = self.measure_weed(
                u_px=u_px,
                v_px=v_px,
                class_name=cname,
                confidence=conf,
                depth_m=float(depth_val) if depth_val is not None else None,
                image_width_px=image_width_px,
                image_height_px=image_height_px,
                detection_age_s=detection_age_s,
                linear_vx_mps=linear_vx_mps,
                angular_wz_rad_s=angular_wz_rad_s,
            )
            if m is not None:
                results.append(m)
        results.sort(key=lambda item: item.distance_from_base_m)
        return results


class TreatmentPositioningController:
    """
    Uses real-time weed coordinates in `base_link` to smoothly decelerate the rover
    during final approach and bring the weeding actuator to an exact stationary stop
    directly over the target weed without overshooting.
    """

    def __init__(
        self,
        *,
        approach_slowdown_distance_m: float = 0.45,
        approach_min_speed_mps: float = 0.04,
        stop_tolerance_m: float = 0.04,
        lateral_corridor_m: float = 0.14,
        enabled: bool = True,
    ):
        self.approach_slowdown_distance_m = max(0.08, float(approach_slowdown_distance_m))
        self.approach_min_speed_mps = max(0.015, float(approach_min_speed_mps))
        self.stop_tolerance_m = max(0.005, float(stop_tolerance_m))
        self.lateral_corridor_m = max(0.02, float(lateral_corridor_m))
        self.enabled = bool(enabled)

    def select_actionable_weed(
        self,
        measurements: list[WeedBaseMeasurement],
    ) -> WeedBaseMeasurement | None:
        """
        Pick the closest weed that is still ahead of (or inside) the actuator's
        treatment alignment zone and within the lateral treatment corridor.
        Weeds already passed behind the actuator (`dx_to_actuator_m < -stop_tolerance_m`)
        are ignored so the rover continues forward cleanly.
        """
        candidates = [
            m
            for m in measurements
            if m.dx_to_actuator_m >= -self.stop_tolerance_m
            and abs(m.dy_to_actuator_m) <= self.lateral_corridor_m
        ]
        if not candidates:
            return None
        candidates.sort(key=lambda item: abs(item.dx_to_actuator_m))
        return candidates[0]

    def modulate_command(
        self,
        nominal_vx_mps: float,
        nominal_wz_rad_s: float,
        measurements: list[WeedBaseMeasurement],
    ) -> TreatmentPositioningDecision:
        if not self.enabled or not measurements or nominal_vx_mps <= 0.0:
            return TreatmentPositioningDecision(
                mode="CRUISE",
                linear_x_mps=float(nominal_vx_mps),
                angular_z_rad_s=float(nominal_wz_rad_s),
                aligned_for_treatment=False,
                target_weed=measurements[0] if measurements else None,
            )

        target = self.select_actionable_weed(measurements)
        if target is None:
            return TreatmentPositioningDecision(
                mode="CRUISE",
                linear_x_mps=float(nominal_vx_mps),
                angular_z_rad_s=float(nominal_wz_rad_s),
                aligned_for_treatment=False,
                target_weed=None,
            )

        # Target is directly aligned with the actuator in base_link -> full stationary stop
        if target.ready_for_treatment or abs(target.dx_to_actuator_m) <= self.stop_tolerance_m:
            return TreatmentPositioningDecision(
                mode="TREATMENT_ALIGNED_HOLD",
                linear_x_mps=0.0,
                angular_z_rad_s=0.0,
                aligned_for_treatment=True,
                target_weed=target,
            )

        # Target is entering approach zone ahead of actuator -> proportional ramp-down
        if target.dx_to_actuator_m <= self.approach_slowdown_distance_m:
            span = max(1e-6, self.approach_slowdown_distance_m - self.stop_tolerance_m)
            frac = max(0.0, min(1.0, (target.dx_to_actuator_m - self.stop_tolerance_m) / span))
            approach_vx = self.approach_min_speed_mps + frac * max(
                0.0, float(nominal_vx_mps) - self.approach_min_speed_mps
            )
            return TreatmentPositioningDecision(
                mode="APPROACH_SLOWDOWN",
                linear_x_mps=round(min(float(nominal_vx_mps), approach_vx), 4),
                angular_z_rad_s=float(nominal_wz_rad_s),
                aligned_for_treatment=False,
                target_weed=target,
            )

        return TreatmentPositioningDecision(
            mode="CRUISE",
            linear_x_mps=float(nominal_vx_mps),
            angular_z_rad_s=float(nominal_wz_rad_s),
            aligned_for_treatment=False,
            target_weed=target,
        )


def run_row_follow_cycle(
    *,
    row_id: int,
    speed_limit_mps: float,
    max_duration_s: float,
    goal_handle: Any,
    get_estop_fn: Callable[[], bool],
    get_frame_fn: Callable[[], tuple[Any, float]],
    detect_fn: Callable[[Any], Any],
    track_update_fn: Callable[[Any], Any],
    track_reset_fn: Callable[[], None],
    compute_cmd_fn: Callable[[Any, float], Any],
    publish_cmd_fn: Callable[[float, float], None],
    publish_zero_fn: Callable[[], None],
    publish_status_fn: Callable[[str], None],
    measure_weeds_fn: Callable[[], list[WeedBaseMeasurement]] | None = None,
    publish_weeds_fn: Callable[[list[WeedBaseMeasurement]], None] | None = None,
    publish_treatment_target_fn: Callable[[WeedBaseMeasurement], None] | None = None,
    on_treatment_aligned_fn: Callable[[WeedBaseMeasurement], None] | None = None,
    positioning_controller: TreatmentPositioningController | None = None,
    publish_feedback_fn: Callable[[Any, dict[str, Any]], None] | None = None,
    get_odom_distance_fn: Callable[[], float | None] | None = None,
    tick_sleep_s: float = 0.05,
    stale_frame_timeout_s: float = 0.5,
) -> dict[str, Any]:
    """
    Core closed-loop row-following cycle bound directly to a ROS 2 GoalHandle lifecycle.
    Computes real-time weed distances relative to `base_link` on every control tick,
    modulates approach velocity for precision treatment positioning, and enforces
    zero-velocity holds on alignment, cancellation, row end, or hardware E-stop.
    """
    track_reset_fn()
    start = time.monotonic()
    last_tick = start
    start_odom = get_odom_distance_fn() if get_odom_distance_fn else None
    integrated_dist_m = 0.0
    total_weeds_measured = 0
    nearest_weed_dist_m = -1.0
    treatment_alignments_count = 0
    pos_ctrl = positioning_controller or TreatmentPositioningController()

    publish_status_fn(f"ACTIVE:ROW_{row_id}")

    def _current_distance() -> float:
        if get_odom_distance_fn is not None and start_odom is not None:
            cur = get_odom_distance_fn()
            if cur is not None and cur >= start_odom:
                return round(cur - start_odom, 3)
        return round(integrated_dist_m, 3)

    while (time.monotonic() - start) < max_duration_s:
        if goal_handle is not None and getattr(goal_handle, "is_cancel_requested", False):
            publish_zero_fn()
            publish_status_fn(f"CANCELED:ROW_{row_id}")
            return {
                "success": False,
                "reason": "CANCELED",
                "row_id": row_id,
                "distance_traveled_m": _current_distance(),
                "weeds_measured_count": total_weeds_measured,
                "nearest_weed_distance_from_base_m": nearest_weed_dist_m,
                "treatment_alignments_count": treatment_alignments_count,
            }

        if get_estop_fn():
            publish_zero_fn()
            publish_status_fn("ABORTED:HARDWARE_ESTOP_ACTIVE")
            return {
                "success": False,
                "reason": "HARDWARE_ESTOP_ACTIVE",
                "row_id": row_id,
                "distance_traveled_m": _current_distance(),
                "weeds_measured_count": total_weeds_measured,
                "nearest_weed_distance_from_base_m": nearest_weed_dist_m,
                "treatment_alignments_count": treatment_alignments_count,
            }

        now = time.monotonic()
        frame, frame_ts = get_frame_fn()
        if frame is None or (now - frame_ts) > stale_frame_timeout_s:
            publish_zero_fn()
            if tick_sleep_s > 0:
                time.sleep(tick_sleep_s)
            last_tick = time.monotonic()
            continue

        obs = detect_fn(frame)
        state = track_update_fn(obs)
        cmd = compute_cmd_fn(state, speed_limit_mps)

        nominal_vx = float(getattr(cmd, "linear_x_mps", 0.0))
        nominal_wz = float(getattr(cmd, "angular_z_rad_s", 0.0))

        # Measure detected weeds relative to base_link in real time BEFORE publishing velocity
        weed_measurements: list[WeedBaseMeasurement] = []
        if measure_weeds_fn is not None:
            weed_measurements = measure_weeds_fn()
            if weed_measurements:
                total_weeds_measured = max(total_weeds_measured, len(weed_measurements))
                cur_nearest = weed_measurements[0].distance_from_base_m
                if nearest_weed_dist_m < 0.0 or cur_nearest < nearest_weed_dist_m:
                    nearest_weed_dist_m = cur_nearest
            if publish_weeds_fn is not None:
                publish_weeds_fn(weed_measurements)

        # Modulate navigation command for precision treatment positioning relative to base_link
        decision = pos_ctrl.modulate_command(nominal_vx, nominal_wz, weed_measurements)
        vx = decision.linear_x_mps
        wz = decision.angular_z_rad_s

        if decision.aligned_for_treatment and decision.target_weed is not None:
            publish_zero_fn()
            treatment_alignments_count += 1
            publish_status_fn(f"TREATMENT_ALIGNED:ROW_{row_id}")
            if publish_treatment_target_fn is not None:
                publish_treatment_target_fn(decision.target_weed)
            if on_treatment_aligned_fn is not None:
                on_treatment_aligned_fn(decision.target_weed)
        else:
            publish_cmd_fn(vx, wz)

        dt = max(0.0, now - last_tick)
        last_tick = now
        integrated_dist_m += abs(vx) * dt

        nearest = decision.target_weed or (weed_measurements[0] if weed_measurements else None)
        if goal_handle is not None and publish_feedback_fn is not None:
            publish_feedback_fn(
                goal_handle,
                {
                    "lateral_error_m": float(getattr(state, "lateral_error_m", 0.0)),
                    "heading_error_rad": float(getattr(state, "heading_error_rad", 0.0)),
                    "row_end_confidence": float(getattr(state, "row_end_confidence", 0.0)),
                    "elapsed_s": float(now - start),
                    "nearest_weed_distance_from_base_m": nearest.distance_from_base_m if nearest else -1.0,
                    "nearest_weed_x_base_m": nearest.x_base_m if nearest else 0.0,
                    "nearest_weed_y_base_m": nearest.y_base_m if nearest else 0.0,
                    "nearest_weed_dx_to_actuator_m": nearest.dx_to_actuator_m if nearest else -1.0,
                    "weeds_measured_count": len(weed_measurements),
                    "treatment_aligned": bool(decision.aligned_for_treatment),
                    "positioning_mode": decision.mode,
                },
            )

        if bool(getattr(state, "row_end_reached", False)):
            publish_zero_fn()
            publish_status_fn(f"SUCCEEDED:ROW_{row_id}_END")
            return {
                "success": True,
                "reason": "ROW_END_REACHED",
                "row_id": row_id,
                "distance_traveled_m": _current_distance(),
                "weeds_measured_count": total_weeds_measured,
                "nearest_weed_distance_from_base_m": nearest_weed_dist_m,
                "treatment_alignments_count": treatment_alignments_count,
            }

        if tick_sleep_s > 0:
            time.sleep(tick_sleep_s)

    publish_zero_fn()
    publish_status_fn(f"ABORTED:TIMEOUT_ROW_{row_id}")
    return {
        "success": False,
        "reason": "TIMEOUT",
        "row_id": row_id,
        "distance_traveled_m": _current_distance(),
        "weeds_measured_count": total_weeds_measured,
        "nearest_weed_distance_from_base_m": nearest_weed_dist_m,
        "treatment_alignments_count": treatment_alignments_count,
    }


def finalize_goal_handle(goal_handle: Any, outcome: dict[str, Any]) -> str:
    """Apply the terminal ROS 2 Action goal state transition cleanly."""
    reason = str(outcome.get("reason", ""))
    if reason == "CANCELED":
        goal_handle.canceled()
        return "CANCELED"
    if bool(outcome.get("success", False)):
        goal_handle.succeed()
        return "SUCCEEDED"
    goal_handle.abort()
    return "ABORTED"


def load_homography_from_file(path: str) -> list[list[float]] | None:
    """Load a calibrated 3x3 pixel-to-ground homography matrix from JSON if present."""
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        matrix = data.get("homography_matrix", data) if isinstance(data, dict) else data
        if (
            isinstance(matrix, list)
            and len(matrix) == 3
            and all(isinstance(row, list) and len(row) == 3 for row in matrix)
        ):
            return [[float(v) for v in row] for row in matrix]
    except Exception:
        return None
    return None


if ROS2_AVAILABLE:
    class FollowCropRowServer(Node):
        def __init__(self):
            super().__init__("follow_crop_row_action_server")
            self.declare_parameter("row_width_m", 0.60)
            self.declare_parameter("default_speed_mps", 0.15)
            self.declare_parameter("action_name", "/follow_crop_row")
            self.declare_parameter("max_duration_s", 180.0)
            self.declare_parameter("base_frame_id", "base_link")
            self.declare_parameter("camera_frame_id", "nav_camera_link")
            self.declare_parameter("camera_offset_x_m", 0.22)
            self.declare_parameter("camera_offset_y_m", 0.0)
            self.declare_parameter("camera_height_m", 0.42)
            self.declare_parameter("camera_pitch_deg", 35.0)
            self.declare_parameter("camera_yaw_deg", 0.0)
            self.declare_parameter("camera_fov_h_deg", 68.0)
            self.declare_parameter("camera_fov_v_deg", 52.0)
            self.declare_parameter("homography_file", "")
            self.declare_parameter("actuator_offset_x_m", 0.25)
            self.declare_parameter("actuator_offset_y_m", 0.0)
            self.declare_parameter("approach_slowdown_distance_m", 0.45)
            self.declare_parameter("approach_min_speed_mps", 0.04)
            self.declare_parameter("treatment_stop_tolerance_m", 0.04)
            self.declare_parameter("treatment_lateral_tolerance_m", 0.14)
            self.declare_parameter("enable_treatment_positioning", True)

            self._cb_group = ReentrantCallbackGroup()
            self._goal_lock = threading.Lock()
            self._active_goal_handle = None

            self.base_frame_id = str(self.get_parameter("base_frame_id").value)
            self.camera_frame_id = str(self.get_parameter("camera_frame_id").value)
            homography_matrix = load_homography_from_file(
                str(self.get_parameter("homography_file").value)
            )

            self.bridge = CvBridge()
            self.detector = CropRowDetector(row_width_m=float(self.get_parameter("row_width_m").value))
            self.tracker = CropRowTracker()
            self.controller = CropRowController(
                cruise_speed_mps=float(self.get_parameter("default_speed_mps").value)
            )
            self.weed_estimator = WeedBaseDistanceEstimator(
                camera_offset_x_m=float(self.get_parameter("camera_offset_x_m").value),
                camera_offset_y_m=float(self.get_parameter("camera_offset_y_m").value),
                camera_height_m=float(self.get_parameter("camera_height_m").value),
                camera_pitch_deg=float(self.get_parameter("camera_pitch_deg").value),
                camera_yaw_deg=float(self.get_parameter("camera_yaw_deg").value),
                fov_h_deg=float(self.get_parameter("camera_fov_h_deg").value),
                fov_v_deg=float(self.get_parameter("camera_fov_v_deg").value),
                homography_matrix=homography_matrix,
                actuator_offset_x_m=float(self.get_parameter("actuator_offset_x_m").value),
                actuator_offset_y_m=float(self.get_parameter("actuator_offset_y_m").value),
                treatment_stop_tolerance_m=float(self.get_parameter("treatment_stop_tolerance_m").value),
                treatment_lateral_tolerance_m=float(self.get_parameter("treatment_lateral_tolerance_m").value),
            )
            self.positioning_controller = TreatmentPositioningController(
                approach_slowdown_distance_m=float(self.get_parameter("approach_slowdown_distance_m").value),
                approach_min_speed_mps=float(self.get_parameter("approach_min_speed_mps").value),
                stop_tolerance_m=float(self.get_parameter("treatment_stop_tolerance_m").value),
                lateral_corridor_m=float(self.get_parameter("treatment_lateral_tolerance_m").value),
                enabled=bool(self.get_parameter("enable_treatment_positioning").value),
            )

            self._tf_buffer = Tf2Buffer() if TF2_AVAILABLE else None
            self._tf_listener = Tf2TransformListener(self._tf_buffer, self) if self._tf_buffer else None

            self.latest_frame = None
            self.latest_frame_ts = 0.0
            self.latest_depth_frame = None
            self.latest_depth_ts = 0.0
            self.latest_weed_detections: list[dict[str, Any]] = []
            self.latest_weed_det_ts = 0.0
            self.estop_active = False

            self._odom_prev_xy: tuple[float, float] | None = None
            self._odom_total_dist_m: float = 0.0
            self._odom_vx_mps: float = 0.0
            self._odom_wz_rad_s: float = 0.0

            self.img_sub = self.create_subscription(
                Image, "/nav_camera/image_raw", self._on_image, 5, callback_group=self._cb_group
            )
            self.depth_sub = self.create_subscription(
                Image, "/nav_camera/depth/image_raw", self._on_depth_image, 5, callback_group=self._cb_group
            )
            self.weed_det_sub = self.create_subscription(
                String, "/weed_detector/detections", self._on_weed_detections, 10, callback_group=self._cb_group
            )
            self.odom_sub = self.create_subscription(
                Odometry, "/odom", self._on_odom, 10, callback_group=self._cb_group
            )
            self.estop_sub = self.create_subscription(
                Bool, "/safety/estop_active", self._on_estop, 10, callback_group=self._cb_group
            )

            self.cmd_pub = self.create_publisher(Twist, "/cmd_vel_nav", 10)
            self.status_pub = self.create_publisher(String, "/crop_row/action_status", 10)
            self.weed_dist_pub = self.create_publisher(String, "/crop_row/weed_base_distances", 10)
            self.nearest_weed_pub = self.create_publisher(PointStamped, "/crop_row/nearest_weed_base", 10)
            self.treatment_target_pub = self.create_publisher(
                PointStamped, "/crop_row/treatment_target_base", 10
            )

            self._action_server = None
            action_name = str(self.get_parameter("action_name").value)
            if RowFollowActionType is not None:
                self._action_server = ActionServer(
                    self,
                    RowFollowActionType,
                    action_name,
                    execute_callback=self._execute_goal_callback,
                    goal_callback=self._goal_callback,
                    handle_accepted_callback=self._handle_accepted_callback,
                    cancel_callback=self._cancel_callback,
                    callback_group=self._cb_group,
                )
                self.get_logger().info(
                    f"FollowCropRow ActionServer active on '{action_name}' "
                    f"({'custom FollowCropRow' if CUSTOM_ACTION_AVAILABLE else 'nav2_msgs/FollowWaypoints fallback'})"
                )
            else:
                self.get_logger().error(
                    "No ROS 2 action interface available (install nav2_msgs or build FollowCropRow.action)"
                )

        def _refresh_camera_extrinsics_from_tf(self):
            """Update camera-to-base_link translation from live TF2 tree if published."""
            if self._tf_buffer is None:
                return
            try:
                tf_msg = self._tf_buffer.lookup_transform(
                    self.base_frame_id, self.camera_frame_id, rclpy.time.Time()
                )
                t = tf_msg.transform.translation
                self.weed_estimator.camera_offset_x_m = float(t.x)
                self.weed_estimator.camera_offset_y_m = float(t.y)
                if float(t.z) > 0.05:
                    self.weed_estimator.camera_height_m = float(t.z)
            except Exception:
                pass  # Retain static ROS parameter extrinsics when TF2 transform is not yet broadcast

        def _on_image(self, msg: Image):
            frame = self.bridge.imgmsg_to_cv2(msg, desired_encoding="bgr8")
            self.latest_frame = frame
            self.latest_frame_ts = time.monotonic()
            if frame is not None and hasattr(frame, "shape"):
                self.weed_estimator.image_height_px = int(frame.shape[0])
                self.weed_estimator.image_width_px = int(frame.shape[1])

        def _on_depth_image(self, msg: Image):
            try:
                self.latest_depth_frame = self.bridge.imgmsg_to_cv2(msg, desired_encoding="passthrough")
                self.latest_depth_ts = time.monotonic()
            except Exception:
                self.latest_depth_frame = None

        def _on_weed_detections(self, msg: String):
            try:
                parsed = json.loads(msg.data)
                if isinstance(parsed, dict) and isinstance(parsed.get("detections"), list):
                    self.latest_weed_detections = parsed["detections"]
                elif isinstance(parsed, list):
                    self.latest_weed_detections = parsed
                else:
                    return
                self.latest_weed_det_ts = time.monotonic()
            except Exception:
                pass

        def _on_odom(self, msg: Odometry):
            x = float(msg.pose.pose.position.x)
            y = float(msg.pose.pose.position.y)
            if self._odom_prev_xy is not None:
                step = math.hypot(x - self._odom_prev_xy[0], y - self._odom_prev_xy[1])
                if step < 1.0:
                    self._odom_total_dist_m += step
            self._odom_prev_xy = (x, y)
            self._odom_vx_mps = float(msg.twist.twist.linear.x)
            self._odom_wz_rad_s = float(msg.twist.twist.angular.z)

        def _on_estop(self, msg: Bool):
            self.estop_active = bool(msg.data)
            if self.estop_active:
                self._publish_zero()

        def _publish_cmd(self, linear_x: float, angular_z: float):
            twist = Twist()
            twist.linear.x = float(linear_x)
            twist.angular.z = float(angular_z)
            self.cmd_pub.publish(twist)

        def _publish_zero(self):
            self.cmd_pub.publish(Twist())

        def _publish_status(self, text: str):
            msg = String()
            msg.data = text
            self.status_pub.publish(msg)

        def _lookup_depth_m(self, u_px: float, v_px: float) -> float | None:
            depth = self.latest_depth_frame
            if depth is None or (time.monotonic() - self.latest_depth_ts) > 0.6:
                return None
            h, w = depth.shape[:2]
            xi = max(0, min(w - 1, int(round(u_px))))
            yi = max(0, min(h - 1, int(round(v_px))))
            val = float(depth[yi, xi])
            if not math.isfinite(val) or val <= 0.0:
                return None
            # Convert uint16 millimeters (e.g. MaixSense 16-bit ToF depth) to meters
            return val * 0.001 if val > 20.0 else val

        def _measure_current_weeds_from_base(self) -> list[WeedBaseMeasurement]:
            dets = self.latest_weed_detections
            age_s = time.monotonic() - self.latest_weed_det_ts
            if not dets or age_s > 0.6:
                return []
            self._refresh_camera_extrinsics_from_tf()
            return self.weed_estimator.measure_batch(
                dets,
                depth_lookup_fn=self._lookup_depth_m,
                detection_age_s=age_s,
                linear_vx_mps=self._odom_vx_mps,
                angular_wz_rad_s=self._odom_wz_rad_s,
            )

        def _publish_point_in_base(self, publisher: Any, weed: WeedBaseMeasurement):
            pt = PointStamped()
            pt.header.stamp = self.get_clock().now().to_msg()
            pt.header.frame_id = self.base_frame_id
            pt.point.x = float(weed.x_base_m)
            pt.point.y = float(weed.y_base_m)
            pt.point.z = 0.0
            publisher.publish(pt)

        def _publish_weed_measurements(self, measurements: list[WeedBaseMeasurement]):
            payload = {
                "frame_id": self.base_frame_id,
                "actuator_offset_base_m": [
                    self.weed_estimator.actuator_offset_x_m,
                    self.weed_estimator.actuator_offset_y_m,
                ],
                "count": len(measurements),
                "nearest_distance_from_base_m": measurements[0].distance_from_base_m if measurements else -1.0,
                "weeds": [m.to_dict() for m in measurements],
            }
            s_msg = String()
            s_msg.data = json.dumps(payload)
            self.weed_dist_pub.publish(s_msg)

            if measurements:
                self._publish_point_in_base(self.nearest_weed_pub, measurements[0])

        def _publish_treatment_target(self, target: WeedBaseMeasurement):
            self._publish_point_in_base(self.treatment_target_pub, target)

        def _goal_callback(self, goal_request: Any):
            if self.estop_active:
                self.get_logger().warn("[FollowCropRow] Rejecting goal: HARDWARE_ESTOP_ACTIVE")
                return GoalResponse.REJECT
            with self._goal_lock:
                if self._active_goal_handle is not None and self._active_goal_handle.is_active:
                    self.get_logger().warn("[FollowCropRow] Rejecting goal: another row-follow goal is active")
                    return GoalResponse.REJECT
            self.get_logger().info("[FollowCropRow] Goal accepted")
            return GoalResponse.ACCEPT

        def _handle_accepted_callback(self, goal_handle: Any):
            with self._goal_lock:
                self._active_goal_handle = goal_handle
            goal_handle.execute()

        def _cancel_callback(self, _goal_handle: Any):
            self.get_logger().info("[FollowCropRow] Cancel request accepted — commanding zero velocity")
            self._publish_zero()
            return CancelResponse.ACCEPT

        def _publish_action_feedback(self, goal_handle: Any, fb_dict: dict[str, Any]):
            if RowFollowActionType is None:
                return
            fb = RowFollowActionType.Feedback()
            if CUSTOM_ACTION_AVAILABLE:
                fb.lateral_error_m = float(fb_dict["lateral_error_m"])
                fb.heading_error_rad = float(fb_dict["heading_error_rad"])
                fb.row_end_confidence = float(fb_dict["row_end_confidence"])
                fb.elapsed_s = float(fb_dict["elapsed_s"])
                fb.nearest_weed_distance_from_base_m = float(fb_dict["nearest_weed_distance_from_base_m"])
                fb.nearest_weed_x_base_m = float(fb_dict["nearest_weed_x_base_m"])
                fb.nearest_weed_y_base_m = float(fb_dict["nearest_weed_y_base_m"])
                fb.nearest_weed_dx_to_actuator_m = float(fb_dict["nearest_weed_dx_to_actuator_m"])
                fb.weeds_measured_count = int(fb_dict["weeds_measured_count"])
                fb.treatment_aligned = bool(fb_dict["treatment_aligned"])
                fb.positioning_mode = str(fb_dict["positioning_mode"])
            goal_handle.publish_feedback(fb)

        def _execute_goal_callback(self, goal_handle: Any):
            req = goal_handle.request
            row_id = int(getattr(req, "row_id", 1))
            default_speed = float(self.get_parameter("default_speed_mps").value)
            speed_limit = float(getattr(req, "speed_limit_mps", default_speed) or default_speed)
            default_max_dur = float(self.get_parameter("max_duration_s").value)
            max_duration = float(getattr(req, "max_duration_s", default_max_dur) or default_max_dur)

            try:
                outcome = self.execute_row_follow(
                    row_id=row_id,
                    speed_limit_mps=speed_limit,
                    max_duration_s=max_duration,
                    goal_handle=goal_handle,
                )
            finally:
                self._publish_zero()
                with self._goal_lock:
                    if self._active_goal_handle is goal_handle:
                        self._active_goal_handle = None

            finalize_goal_handle(goal_handle, outcome)

            result = RowFollowActionType.Result()
            if CUSTOM_ACTION_AVAILABLE:
                result.success = bool(outcome["success"])
                result.reason = str(outcome["reason"])
                result.row_id = int(outcome.get("row_id", row_id))
                result.distance_traveled_m = float(outcome.get("distance_traveled_m", 0.0))
                result.weeds_measured_count = int(outcome.get("weeds_measured_count", 0))
                result.nearest_weed_distance_from_base_m = float(
                    outcome.get("nearest_weed_distance_from_base_m", -1.0)
                )
                result.treatment_alignments_count = int(
                    outcome.get("treatment_alignments_count", 0)
                )
            return result

        def execute_row_follow(
            self,
            row_id: int,
            speed_limit_mps: float = 0.15,
            max_duration_s: float = 180.0,
            goal_handle: Any = None,
        ) -> dict[str, Any]:
            """Closed-loop 20 Hz visual row following with real-time `base_link` weed positioning."""
            self.get_logger().info(f"[FollowCropRow] Starting Row #{row_id} (v_max={speed_limit_mps:.2f} m/s)")
            return run_row_follow_cycle(
                row_id=row_id,
                speed_limit_mps=speed_limit_mps,
                max_duration_s=max_duration_s,
                goal_handle=goal_handle,
                get_estop_fn=lambda: self.estop_active,
                get_frame_fn=lambda: (self.latest_frame, self.latest_frame_ts),
                detect_fn=self.detector.detect,
                track_update_fn=self.tracker.update,
                track_reset_fn=self.tracker.reset,
                compute_cmd_fn=lambda st, vcap: self.controller.compute_cmd(st, speed_limit_mps=vcap),
                publish_cmd_fn=self._publish_cmd,
                publish_zero_fn=self._publish_zero,
                publish_status_fn=self._publish_status,
                measure_weeds_fn=self._measure_current_weeds_from_base,
                publish_weeds_fn=self._publish_weed_measurements,
                publish_treatment_target_fn=self._publish_treatment_target,
                positioning_controller=self.positioning_controller,
                publish_feedback_fn=self._publish_action_feedback,
                get_odom_distance_fn=lambda: self._odom_total_dist_m if self._odom_prev_xy is not None else None,
            )


    def main(args=None):
        rclpy.init(args=args)
        node = FollowCropRowServer()
        executor = MultiThreadedExecutor(num_threads=4)
        executor.add_node(node)
        try:
            executor.spin()
        finally:
            node._publish_zero()
            node.destroy_node()
            rclpy.shutdown()
