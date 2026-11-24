"""
ROS 2 Jazzy ESP32 Differential-Drive Bridge Node.
Converts geometry_msgs/Twist (/cmd_vel_safe from Nav2 Collision Monitor) into
closed-loop wheel angular velocities (VEL <l_rad_s> <r_rad_s>) and publishes
raw encoder telemetry + hardware safety flags at 50 Hz.
"""

import math
from dataclasses import dataclass

try:
    import rclpy
    from rclpy.node import Node
    from geometry_msgs.msg import Twist
    from std_msgs.msg import Bool, Int64MultiArray, Float64MultiArray
    ROS2_AVAILABLE = True
except ImportError:
    ROS2_AVAILABLE = False


@dataclass
class RoverKinematics:
    wheel_radius_m: float = 0.035
    wheel_separation_m: float = 0.174
    skid_multiplier: float = 1.18
    max_wheel_rad_s: float = 12.0

    def twist_to_wheel_rad_s(self, linear_x: float, angular_z: float) -> tuple[float, float]:
        eff_sep = self.wheel_separation_m * self.skid_multiplier
        v_left = linear_x - (angular_z * eff_sep / 2.0)
        v_right = linear_x + (angular_z * eff_sep / 2.0)
        w_left = max(-self.max_wheel_rad_s, min(self.max_wheel_rad_s, v_left / self.wheel_radius_m))
        w_right = max(-self.max_wheel_rad_s, min(self.max_wheel_rad_s, v_right / self.wheel_radius_m))
        return w_left, w_right


if ROS2_AVAILABLE:
    import serial

    class Esp32DiffDriveNode(Node):
        def __init__(self):
            super().__init__("esp32_diffdrive_bridge")
            self.declare_parameter("serial_port", "/dev/ttyUSB0")
            self.declare_parameter("baud_rate", 115200)
            self.declare_parameter("wheel_radius", 0.035)
            self.declare_parameter("wheel_separation", 0.174)
            self.declare_parameter("skid_multiplier", 1.18)

            self.kin = RoverKinematics(
                wheel_radius_m=self.get_parameter("wheel_radius").value,
                wheel_separation_m=self.get_parameter("wheel_separation").value,
                skid_multiplier=self.get_parameter("skid_multiplier").value,
            )

            port = self.get_parameter("serial_port").value
            baud = self.get_parameter("baud_rate").value
            self.ser = serial.Serial(port, baud, timeout=0.02)

            self.cmd_sub = self.create_subscription(Twist, "/cmd_vel_safe", self._on_cmd_vel, 10)
            self.enc_pub = self.create_publisher(Int64MultiArray, "/wheel_encoders/ticks", 20)
            self.vel_pub = self.create_publisher(Float64MultiArray, "/wheel_encoders/rad_s", 20)
            self.estop_pub = self.create_publisher(Bool, "/safety/hardware_estop_ok", 10)
            self.interlock_pub = self.create_publisher(Bool, "/safety/laser_interlock_ok", 10)

            self.timer = self.create_timer(0.02, self._poll_serial)
            self.get_logger().info(f"ESP32 bridge ready on {port} @ {baud} baud")

        def _on_cmd_vel(self, msg: Twist):
            w_l, w_r = self.kin.twist_to_wheel_rad_s(msg.linear.x, msg.angular.z)
            self.ser.write(f"VEL {w_l:.4f} {w_r:.4f}\n".encode("ascii"))

        def _poll_serial(self):
            while self.ser.in_waiting:
                line = self.ser.readline().decode("ascii", errors="ignore").strip()
                if not line.startswith("ODOM "):
                    continue
                parts = line.split()
                if len(parts) != 7:
                    continue
                try:
                    l_ticks, r_ticks = int(parts[1]), int(parts[2])
                    l_rad_s, r_rad_s = float(parts[3]), float(parts[4])
                    estop_ok = parts[5] == "1"
                    interlock_ok = parts[6] == "1"
                except ValueError:
                    continue

                self.enc_pub.publish(Int64MultiArray(data=[l_ticks, r_ticks]))
                self.vel_pub.publish(Float64MultiArray(data=[l_rad_s, r_rad_s]))
                self.estop_pub.publish(Bool(data=estop_ok))
                self.interlock_pub.publish(Bool(data=interlock_ok))


    def main(args=None):
        rclpy.init(args=args)
        node = Esp32DiffDriveNode()
        try:
            rclpy.spin(node)
        finally:
            node.ser.write(b"STOP\n")
            node.ser.close()
            node.destroy_node()
            rclpy.shutdown()
