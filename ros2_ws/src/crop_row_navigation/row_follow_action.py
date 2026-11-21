"""
ROS 2 Jazzy Action Server: FollowCropRow
Implements Milestone 1 autonomous single-row following:
  - Instantiates a real rclpy `ActionServer` on `/follow_crop_row` with explicit
    goal_callback, cancel_callback, and execute_callback
  - Subscribes to /nav_camera/image_raw and /safety/estop_active
  - Runs CropRowDetector -> CropRowTracker -> CropRowController at 20 Hz
  - Publishes /cmd_vel_nav (always filtered by Nav2 Collision Monitor -> /cmd_vel_safe before ESP32)
  - Streams progress feedback (lateral error, heading error, row-end confidence)
  - Stops cleanly on row end, goal cancellation, or hardware E-stop
"""

from __future__ import annotations

import threading
import time
from typing import Any

try:
    import rclpy
    from rclpy.node import Node
    from rclpy.action import ActionServer, GoalResponse, CancelResponse
    from rclpy.callback_groups import ReentrantCallbackGroup
    from rclpy.executors import MultiThreadedExecutor
    from geometry_msgs.msg import Twist
    from sensor_msgs.msg import Image
    from std_msgs.msg import Bool, String
    from cv_bridge import CvBridge
    ROS2_AVAILABLE = True
except ImportError:
    ROS2_AVAILABLE = False

try:
    # Prefer generated custom FollowCropRow action if built via rosidl
    from crop_row_navigation.action import FollowCropRow as RowFollowActionType  # type: ignore[import-not-found]
    CUSTOM_ACTION_AVAILABLE = True
except ImportError:
    RowFollowActionType = None
    CUSTOM_ACTION_AVAILABLE = False
    if ROS2_AVAILABLE:
        try:
            # Standard Nav2 action fallback so the ActionServer always registers cleanly in Jazzy
            from nav2_msgs.action import FollowWaypoints as RowFollowActionType  # type: ignore[import-not-found]
        except ImportError:
            RowFollowActionType = None

from .row_detector import CropRowDetector
from .row_tracker import CropRowTracker
from .row_controller import CropRowController


if ROS2_AVAILABLE:
    class FollowCropRowServer(Node):
        def __init__(self):
            super().__init__("follow_crop_row_action_server")
            self.declare_parameter("row_width_m", 0.60)
            self.declare_parameter("default_speed_mps", 0.15)
            self.declare_parameter("action_name", "/follow_crop_row")
            self.declare_parameter("max_duration_s", 180.0)

            self._cb_group = ReentrantCallbackGroup()
            self._goal_lock = threading.Lock()
            self._active_goal_handle = None

            self.bridge = CvBridge()
            self.detector = CropRowDetector(row_width_m=float(self.get_parameter("row_width_m").value))
            self.tracker = CropRowTracker()
            self.controller = CropRowController(
                cruise_speed_mps=float(self.get_parameter("default_speed_mps").value)
            )

            self.latest_frame = None
            self.latest_frame_ts = 0.0
            self.estop_active = False

            self.img_sub = self.create_subscription(
                Image, "/nav_camera/image_raw", self._on_image, 5, callback_group=self._cb_group
            )
            self.estop_sub = self.create_subscription(
                Bool, "/safety/estop_active", self._on_estop, 10, callback_group=self._cb_group
            )
            self.cmd_pub = self.create_publisher(Twist, "/cmd_vel_nav", 10)
            self.status_pub = self.create_publisher(String, "/crop_row/action_status", 10)

            self._action_server = None
            action_name = str(self.get_parameter("action_name").value)
            if RowFollowActionType is not None:
                self._action_server = ActionServer(
                    self,
                    RowFollowActionType,
                    action_name,
                    execute_callback=self._execute_goal_callback,
                    goal_callback=self._goal_callback,
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

        def _on_image(self, msg: Image):
            self.latest_frame = self.bridge.imgmsg_to_cv2(msg, desired_encoding="bgr8")
            self.latest_frame_ts = time.monotonic()

        def _on_estop(self, msg: Bool):
            self.estop_active = bool(msg.data)
            if self.estop_active:
                self._publish_zero()

        def _publish_zero(self):
            self.cmd_pub.publish(Twist())

        def _publish_status(self, text: str):
            msg = String()
            msg.data = text
            self.status_pub.publish(msg)

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

        def _cancel_callback(self, _goal_handle: Any):
            self.get_logger().info("[FollowCropRow] Cancel request accepted — commanding zero velocity")
            self._publish_zero()
            return CancelResponse.ACCEPT

        def _execute_goal_callback(self, goal_handle: Any):
            with self._goal_lock:
                self._active_goal_handle = goal_handle

            req = goal_handle.request
            row_id = int(getattr(req, "row_id", 1))
            default_speed = float(self.get_parameter("default_speed_mps").value)
            speed_limit = float(getattr(req, "speed_limit_mps", default_speed) or default_speed)
            max_duration = float(
                getattr(req, "max_duration_s", float(self.get_parameter("max_duration_s").value))
                or float(self.get_parameter("max_duration_s").value)
            )

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

            result = RowFollowActionType.Result()
            if outcome["reason"] == "CANCELED":
                goal_handle.canceled()
            elif outcome["success"]:
                goal_handle.succeed()
            else:
                goal_handle.abort()

            if CUSTOM_ACTION_AVAILABLE:
                result.success = bool(outcome["success"])
                result.reason = str(outcome["reason"])
                result.row_id = int(outcome.get("row_id", row_id))
                result.distance_traveled_m = float(outcome.get("distance_traveled_m", 0.0))
            return result

        def execute_row_follow(
            self,
            row_id: int,
            speed_limit_mps: float = 0.15,
            max_duration_s: float = 180.0,
            goal_handle: Any = None,
        ) -> dict[str, Any]:
            """Core 20 Hz closed-loop visual row-following execution loop."""
            self.tracker.reset()
            start = time.monotonic()
            distance_m = 0.0
            last_tick = start
            self.get_logger().info(f"[FollowCropRow] Starting Row #{row_id} (v_max={speed_limit_mps:.2f} m/s)")
            self._publish_status(f"ACTIVE:ROW_{row_id}")

            while (time.monotonic() - start) < max_duration_s:
                if goal_handle is not None and goal_handle.is_cancel_requested:
                    self._publish_zero()
                    self._publish_status(f"CANCELED:ROW_{row_id}")
                    return {
                        "success": False,
                        "reason": "CANCELED",
                        "row_id": row_id,
                        "distance_traveled_m": round(distance_m, 3),
                    }

                if self.estop_active:
                    self._publish_zero()
                    self._publish_status("ABORTED:HARDWARE_ESTOP_ACTIVE")
                    return {
                        "success": False,
                        "reason": "HARDWARE_ESTOP_ACTIVE",
                        "row_id": row_id,
                        "distance_traveled_m": round(distance_m, 3),
                    }

                now = time.monotonic()
                if self.latest_frame is None or (now - self.latest_frame_ts) > 0.5:
                    self._publish_zero()
                    time.sleep(0.05)
                    last_tick = time.monotonic()
                    continue

                obs = self.detector.detect(self.latest_frame)
                state = self.tracker.update(obs)
                cmd = self.controller.compute_cmd(state, speed_limit_mps=speed_limit_mps)

                twist = Twist()
                twist.linear.x = float(cmd.linear_x_mps)
                twist.angular.z = float(cmd.angular_z_rad_s)
                self.cmd_pub.publish(twist)

                dt = max(0.0, now - last_tick)
                last_tick = now
                distance_m += abs(twist.linear.x) * dt

                if goal_handle is not None and RowFollowActionType is not None:
                    fb = RowFollowActionType.Feedback()
                    if CUSTOM_ACTION_AVAILABLE:
                        fb.lateral_error_m = float(getattr(state, "lateral_error_m", 0.0))
                        fb.heading_error_rad = float(getattr(state, "heading_error_rad", 0.0))
                        fb.row_end_confidence = float(getattr(state, "row_end_confidence", 0.0))
                        fb.elapsed_s = float(now - start)
                    goal_handle.publish_feedback(fb)

                if state.row_end_reached:
                    self._publish_zero()
                    self._publish_status(f"SUCCEEDED:ROW_{row_id}_END")
                    self.get_logger().info(f"[FollowCropRow] Row #{row_id} end detected cleanly — stopped.")
                    return {
                        "success": True,
                        "reason": "ROW_END_REACHED",
                        "row_id": row_id,
                        "distance_traveled_m": round(distance_m, 3),
                    }

                time.sleep(0.05)

            self._publish_zero()
            self._publish_status(f"ABORTED:TIMEOUT_ROW_{row_id}")
            return {
                "success": False,
                "reason": "TIMEOUT",
                "row_id": row_id,
                "distance_traveled_m": round(distance_m, 3),
            }


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
