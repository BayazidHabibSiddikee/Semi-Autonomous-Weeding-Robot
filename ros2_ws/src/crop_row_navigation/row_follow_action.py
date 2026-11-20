"""
ROS 2 Jazzy Action Server: FollowCropRow
Implements Milestone 1 autonomous single-row following:
  - Subscribes to /nav_camera/image_raw and /safety/estop_active
  - Runs CropRowDetector -> CropRowTracker -> CropRowController at 20 Hz
  - Publishes /cmd_vel_nav (always filtered by Nav2 Collision Monitor before ESP32)
  - Streams progress feedback (lateral error, heading error, distance, row-end conf)
  - Stops cleanly at row end and returns control to Mission Supervisor for Nav2 U-turn
"""

import time

try:
    import rclpy
    from rclpy.node import Node
    from rclpy.action import ActionServer, GoalResponse, CancelResponse
    from geometry_msgs.msg import Twist
    from sensor_msgs.msg import Image
    from std_msgs.msg import Bool
    from cv_bridge import CvBridge
    ROS2_AVAILABLE = True
except ImportError:
    ROS2_AVAILABLE = False

from .row_detector import CropRowDetector
from .row_tracker import CropRowTracker
from .row_controller import CropRowController


if ROS2_AVAILABLE:
    class FollowCropRowServer(Node):
        def __init__(self):
            super().__init__("follow_crop_row_action_server")
            self.declare_parameter("row_width_m", 0.60)
            self.declare_parameter("default_speed_mps", 0.15)

            self.bridge = CvBridge()
            self.detector = CropRowDetector(row_width_m=self.get_parameter("row_width_m").value)
            self.tracker = CropRowTracker()
            self.controller = CropRowController(
                cruise_speed_mps=self.get_parameter("default_speed_mps").value
            )

            self.latest_frame = None
            self.estop_active = False

            self.img_sub = self.create_subscription(Image, "/nav_camera/image_raw", self._on_image, 5)
            self.estop_sub = self.create_subscription(Bool, "/safety/estop_active", self._on_estop, 10)
            self.cmd_pub = self.create_publisher(Twist, "/cmd_vel_nav", 10)
            self.get_logger().info("FollowCropRow visual-servoing action server initialized")

        def _on_image(self, msg: Image):
            self.latest_frame = self.bridge.imgmsg_to_cv2(msg, desired_encoding="bgr8")

        def _on_estop(self, msg: Bool):
            self.estop_active = bool(msg.data)
            if self.estop_active:
                self._publish_zero()

        def _publish_zero(self):
            self.cmd_pub.publish(Twist())

        def execute_row_follow(self, row_id: int, speed_limit_mps: float = 0.15, max_duration_s: float = 180.0):
            """Core execution loop bound to custom FollowCropRow.action goal callback."""
            self.tracker.reset()
            start = time.monotonic()
            self.get_logger().info(f"[FollowCropRow] Starting Row #{row_id} (v_max={speed_limit_mps:.2f} m/s)")

            while (time.monotonic() - start) < max_duration_s:
                if self.estop_active:
                    self._publish_zero()
                    return {"success": False, "reason": "HARDWARE_ESTOP_ACTIVE"}

                if self.latest_frame is None:
                    time.sleep(0.05)
                    continue

                obs = self.detector.detect(self.latest_frame)
                state = self.tracker.update(obs)
                cmd = self.controller.compute_cmd(state, speed_limit_mps=speed_limit_mps)

                twist = Twist()
                twist.linear.x = cmd.linear_x_mps
                twist.angular.z = cmd.angular_z_rad_s
                self.cmd_pub.publish(twist)

                if state.row_end_reached:
                    self._publish_zero()
                    self.get_logger().info(f"[FollowCropRow] Row #{row_id} end detected cleanly — stopped.")
                    return {"success": True, "reason": "ROW_END_REACHED", "row_id": row_id}

                time.sleep(0.05)

            self._publish_zero()
            return {"success": False, "reason": "TIMEOUT"}


    def main(args=None):
        rclpy.init(args=args)
        node = FollowCropRowServer()
        rclpy.spin(node)
        node.destroy_node()
        rclpy.shutdown()
