"""
ROS 2 Ultrasonic-to-LaserScan Bridge Node (`/scan`).

Converts front/left/right ultrasonic range readings (published as `sensor_msgs/Range`
or polled from ESP32 telemetry on `/rover/ultrasonic_range_m`) into a `sensor_msgs/LaserScan`
on `/scan` so Nav2 Collision Monitor and the local costmap always have a live obstacle
observation source even before a 2D LiDAR is installed.

Fail-safe behavior:
  - If ultrasonic readings become stale beyond `stale_timeout_s`, publishes an empty
    (inf) scan only if configured, or stops publishing `/scan` so Collision Monitor's
    source timeout watchdog triggers cleanly.
"""

from __future__ import annotations

import math
import time

try:
    import rclpy
    from rclpy.node import Node
    from sensor_msgs.msg import LaserScan, Range
    from std_msgs.msg import Float32
    ROS2_AVAILABLE = True
except ImportError:
    ROS2_AVAILABLE = False


def build_ultrasonic_scan_ranges(
    *,
    front_range_m: float | None,
    left_range_m: float | None = None,
    right_range_m: float | None = None,
    num_beams: int = 36,
    angle_min_rad: float = -math.pi / 3.0,
    angle_max_rad: float = math.pi / 3.0,
    range_min_m: float = 0.05,
    range_max_m: float = 4.0,
) -> list[float]:
    """
    Project discrete ultrasonic cone measurements into a compact LaserScan array
    covering [angle_min_rad, angle_max_rad]. Unobserved beams remain +inf.
    """
    n = max(3, int(num_beams))
    ranges = [float("inf")] * n
    step = (angle_max_rad - angle_min_rad) / max(1, n - 1)

    def _stamp_cone(center_rad: float, half_fov_rad: float, dist_m: float | None) -> None:
        if dist_m is None or not math.isfinite(dist_m):
            return
        if dist_m < range_min_m or dist_m > range_max_m:
            return
        for i in range(n):
            ang = angle_min_rad + i * step
            if abs(ang - center_rad) <= half_fov_rad:
                ranges[i] = min(ranges[i], float(dist_m))

    _stamp_cone(0.0, math.radians(15.0), front_range_m)
    _stamp_cone(math.radians(40.0), math.radians(15.0), left_range_m)
    _stamp_cone(math.radians(-40.0), math.radians(15.0), right_range_m)
    return ranges


if ROS2_AVAILABLE:
    class UltrasonicScanNode(Node):
        def __init__(self):
            super().__init__("ultrasonic_scan_node")
            self.declare_parameter("frame_id", "ultrasonic_link")
            self.declare_parameter("scan_topic", "/scan")
            self.declare_parameter("publish_rate_hz", 10.0)
            self.declare_parameter("stale_timeout_s", 1.0)
            self.declare_parameter("range_min_m", 0.05)
            self.declare_parameter("range_max_m", 4.0)

            self.frame_id = str(self.get_parameter("frame_id").value)
            scan_topic = str(self.get_parameter("scan_topic").value)
            rate_hz = max(1.0, float(self.get_parameter("publish_rate_hz").value))
            self.stale_timeout_s = float(self.get_parameter("stale_timeout_s").value)
            self.range_min_m = float(self.get_parameter("range_min_m").value)
            self.range_max_m = float(self.get_parameter("range_max_m").value)

            self._front_m: float | None = None
            self._left_m: float | None = None
            self._right_m: float | None = None
            self._last_rx_ts: float = 0.0

            self.create_subscription(Range, "/ultrasonic/front", self._on_front_range, 10)
            self.create_subscription(Range, "/ultrasonic/left", self._on_left_range, 10)
            self.create_subscription(Range, "/ultrasonic/right", self._on_right_range, 10)
            self.create_subscription(Float32, "/rover/ultrasonic_front_m", self._on_front_float, 10)

            self.scan_pub = self.create_publisher(LaserScan, scan_topic, 10)
            self.create_timer(1.0 / rate_hz, self._publish_scan)
            self.get_logger().info(
                f"UltrasonicScanNode publishing LaserScan on '{scan_topic}' (frame={self.frame_id})"
            )

        def _on_front_range(self, msg: Range):
            self._front_m = float(msg.range)
            self._last_rx_ts = time.monotonic()

        def _on_left_range(self, msg: Range):
            self._left_m = float(msg.range)
            self._last_rx_ts = time.monotonic()

        def _on_right_range(self, msg: Range):
            self._right_m = float(msg.range)
            self._last_rx_ts = time.monotonic()

        def _on_front_float(self, msg: Float32):
            self._front_m = float(msg.data)
            self._last_rx_ts = time.monotonic()

        def _publish_scan(self):
            if self._last_rx_ts <= 0.0 or (time.monotonic() - self._last_rx_ts) > self.stale_timeout_s:
                # Do not fabricate scans when no live ultrasonic data is arriving
                return

            angle_min = -math.pi / 3.0
            angle_max = math.pi / 3.0
            num_beams = 36
            scan = LaserScan()
            scan.header.stamp = self.get_clock().now().to_msg()
            scan.header.frame_id = self.frame_id
            scan.angle_min = angle_min
            scan.angle_max = angle_max
            scan.angle_increment = (angle_max - angle_min) / (num_beams - 1)
            scan.range_min = self.range_min_m
            scan.range_max = self.range_max_m
            scan.ranges = build_ultrasonic_scan_ranges(
                front_range_m=self._front_m,
                left_range_m=self._left_m,
                right_range_m=self._right_m,
                num_beams=num_beams,
                angle_min_rad=angle_min,
                angle_max_rad=angle_max,
                range_min_m=self.range_min_m,
                range_max_m=self.range_max_m,
            )
            self.scan_pub.publish(scan)


    def main(args=None):
        rclpy.init(args=args)
        node = UltrasonicScanNode()
        try:
            rclpy.spin(node)
        finally:
            node.destroy_node()
            rclpy.shutdown()
else:
    def main(args=None):  # pragma: no cover
        raise RuntimeError("rclpy is required to run ultrasonic_scan_node")
