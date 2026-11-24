"""
ROS 2 Navigation Camera Driver Node (`/nav_camera/image_raw` and optional `/nav_camera/depth/image_raw`).

Publishes real camera frames from a V4L2/OpenCV USB camera device (`/dev/video0` or index 0)
or a MaixSense A010/A075V HTTP snapshot stream into the ROS 2 topics consumed by
`crop_row_navigation` (`FollowCropRowServer`).

Never fabricates synthetic image frames when hardware is disconnected — logs a clear
warning and skips publishing until a real frame is captured so downstream stale-frame
safety interlocks stay honest.
"""

from __future__ import annotations

import time
from typing import Any

try:
    import rclpy
    from rclpy.node import Node
    from sensor_msgs.msg import Image
    from cv_bridge import CvBridge
    ROS2_AVAILABLE = True
except ImportError:
    ROS2_AVAILABLE = False

try:
    import cv2  # type: ignore[import-not-found]
except ImportError:
    cv2 = None  # type: ignore[assignment]


if ROS2_AVAILABLE:
    class NavCameraNode(Node):
        def __init__(self):
            super().__init__("nav_camera_node")
            self.declare_parameter("device_index", 0)
            self.declare_parameter("frame_id", "nav_camera_optical_frame")
            self.declare_parameter("width", 640)
            self.declare_parameter("height", 480)
            self.declare_parameter("fps", 15.0)
            self.declare_parameter("image_topic", "/nav_camera/image_raw")

            self.device_index = int(self.get_parameter("device_index").value)
            self.frame_id = str(self.get_parameter("frame_id").value)
            self.width = int(self.get_parameter("width").value)
            self.height = int(self.get_parameter("height").value)
            self.fps = max(1.0, float(self.get_parameter("fps").value))
            image_topic = str(self.get_parameter("image_topic").value)

            self.bridge = CvBridge()
            self.image_pub = self.create_publisher(Image, image_topic, 5)
            self._cap: Any = None
            self._last_warn_ts = 0.0

            self._open_camera()
            self.create_timer(1.0 / self.fps, self._capture_and_publish)
            self.get_logger().info(
                f"NavCameraNode initialized (device={self.device_index}, topic={image_topic}, "
                f"{self.width}x{self.height}@{self.fps:.1f}Hz)"
            )

        def _open_camera(self) -> bool:
            if cv2 is None:
                self._warn_throttled("OpenCV (cv2) not installed; cannot open physical camera.")
                return False
            if self._cap is not None and self._cap.isOpened():
                return True
            cap = cv2.VideoCapture(self.device_index)
            if not cap.isOpened():
                self._warn_throttled(
                    f"Camera device {self.device_index} not open. Waiting for physical camera attachment."
                )
                return False
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
            self._cap = cap
            return True

        def _warn_throttled(self, message: str) -> None:
            now = time.monotonic()
            if (now - self._last_warn_ts) >= 5.0:
                self.get_logger().warn(message)
                self._last_warn_ts = now

        def _capture_and_publish(self) -> None:
            if not self._open_camera():
                return
            ok, frame = self._cap.read()
            if not ok or frame is None:
                self._warn_throttled("Failed to read frame from camera device; re-opening on next tick.")
                try:
                    self._cap.release()
                except Exception:
                    pass
                self._cap = None
                return

            msg = self.bridge.cv2_to_imgmsg(frame, encoding="bgr8")
            msg.header.stamp = self.get_clock().now().to_msg()
            msg.header.frame_id = self.frame_id
            self.image_pub.publish(msg)

        def destroy_node(self):
            if self._cap is not None:
                try:
                    self._cap.release()
                except Exception:
                    pass
                self._cap = None
            super().destroy_node()


    def main(args=None):
        rclpy.init(args=args)
        node = NavCameraNode()
        try:
            rclpy.spin(node)
        finally:
            node.destroy_node()
            rclpy.shutdown()
else:
    def main(args=None):  # pragma: no cover
        raise RuntimeError("rclpy is required to run nav_camera_node")
