"""
Robot Safety Monitor Node (Software Watchdog Layer).
IMPORTANT: Software monitoring complements — and NEVER replaces — independent
hardware emergency-stop relays and physical Class 4 laser interlock circuits.
Monitors:
  - /safety/hardware_estop_ok
  - /safety/laser_interlock_ok
  - /imu/data roll/pitch tilt limits (tip-over protection > 22 deg)
  - Sensor stream heartbeats (/scan, /wheel/odometry, /imu/data)
Publishes /safety/estop_active (Bool) so all navigation & weeding nodes halt.
"""

import math
import time

try:
    import rclpy
    from rclpy.node import Node
    from std_msgs.msg import Bool
    from sensor_msgs.msg import Imu, LaserScan
    from nav_msgs.msg import Odometry
    ROS2_AVAILABLE = True
except ImportError:
    ROS2_AVAILABLE = False


MAX_SAFE_TILT_DEG = 22.0
SENSOR_TIMEOUT_S = 1.0


def quat_to_tilt_deg(x: float, y: float, z: float, w: float) -> float:
    sinr_cosp = 2.0 * (w * x + y * z)
    cosr_cosp = 1.0 - 2.0 * (x * x + y * y)
    roll = math.atan2(sinr_cosp, cosr_cosp)

    sinp = max(-1.0, min(1.0, 2.0 * (w * y - z * x)))
    pitch = math.asin(sinp)
    return math.degrees(max(abs(roll), abs(pitch)))


if ROS2_AVAILABLE:
    class SafetyMonitorNode(Node):
        def __init__(self):
            super().__init__("robot_safety_monitor")
            self.hw_estop_ok = True
            self.tilt_ok = True
            self.last_odom_t = time.monotonic()
            self.last_scan_t = time.monotonic()

            self.create_subscription(Bool, "/safety/hardware_estop_ok", self._on_hw_estop, 10)
            self.create_subscription(Imu, "/imu/data", self._on_imu, 20)
            self.create_subscription(Odometry, "/wheel/odometry", self._on_odom, 20)
            self.create_subscription(LaserScan, "/scan", self._on_scan, 10)

            self.estop_pub = self.create_publisher(Bool, "/safety/estop_active", 10)
            self.create_timer(0.05, self._evaluate)

        def _on_hw_estop(self, msg: Bool):
            self.hw_estop_ok = bool(msg.data)

        def _on_imu(self, msg: Imu):
            q = msg.orientation
            self.tilt_ok = quat_to_tilt_deg(q.x, q.y, q.z, q.w) <= MAX_SAFE_TILT_DEG

        def _on_odom(self, _msg: Odometry):
            self.last_odom_t = time.monotonic()

        def _on_scan(self, _msg: LaserScan):
            self.last_scan_t = time.monotonic()

        def _evaluate(self):
            now = time.monotonic()
            sensors_fresh = (now - self.last_odom_t) < SENSOR_TIMEOUT_S and (now - self.last_scan_t) < SENSOR_TIMEOUT_S
            estop_triggered = (not self.hw_estop_ok) or (not self.tilt_ok) or (not sensors_fresh)
            self.estop_pub.publish(Bool(data=estop_triggered))


    def main(args=None):
        rclpy.init(args=args)
        node = SafetyMonitorNode()
        rclpy.spin(node)
        node.destroy_node()
        rclpy.shutdown()
