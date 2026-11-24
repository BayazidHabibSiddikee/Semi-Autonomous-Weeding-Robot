"""
Wheel Odometry Node for ROS 2 Jazzy.
Computes differential-drive pose + twist from quadrature encoder ticks and
publishes /wheel/odometry for sensor fusion in robot_localization (ekf_local).
Note: Does NOT broadcast odom -> base_footprint TF; EKF owns that transform.
"""

import math
from dataclasses import dataclass

try:
    import rclpy
    from rclpy.node import Node
    from std_msgs.msg import Int64MultiArray
    from nav_msgs.msg import Odometry
    ROS2_AVAILABLE = True
except ImportError:
    ROS2_AVAILABLE = False


@dataclass
class WheelOdomIntegrator:
    wheel_radius_m: float = 0.035
    wheel_separation_m: float = 0.174
    skid_multiplier: float = 1.18
    ticks_per_rev: float = 17280.0

    x: float = 0.0
    y: float = 0.0
    yaw: float = 0.0
    _prev_l: int | None = None
    _prev_r: int | None = None

    def update(self, left_ticks: int, right_ticks: int, dt_s: float) -> tuple[float, float, float, float, float]:
        if self._prev_l is None or self._prev_r is None or dt_s <= 0.0:
            self._prev_l = left_ticks
            self._prev_r = right_ticks
            return self.x, self.y, self.yaw, 0.0, 0.0

        dl_ticks = left_ticks - self._prev_l
        dr_ticks = right_ticks - self._prev_r
        self._prev_l = left_ticks
        self._prev_r = right_ticks

        m_per_tick = (2.0 * math.pi * self.wheel_radius_m) / self.ticks_per_rev
        dl = dl_ticks * m_per_tick
        dr = dr_ticks * m_per_tick

        eff_sep = self.wheel_separation_m * self.skid_multiplier
        ds = 0.5 * (dl + dr)
        dyaw = (dr - dl) / eff_sep

        # Midpoint Runge-Kutta 2 integration
        mid_yaw = self.yaw + 0.5 * dyaw
        self.x += ds * math.cos(mid_yaw)
        self.y += ds * math.sin(mid_yaw)
        self.yaw = math.atan2(math.sin(self.yaw + dyaw), math.cos(self.yaw + dyaw))

        vx = ds / dt_s
        wz = dyaw / dt_s
        return self.x, self.y, self.yaw, vx, wz


if ROS2_AVAILABLE:
    class WheelOdometryNode(Node):
        def __init__(self):
            super().__init__("wheel_odometry_node")
            self.integrator = WheelOdomIntegrator()
            self.last_time = self.get_clock().now()
            self.sub = self.create_subscription(Int64MultiArray, "/wheel_encoders/ticks", self._on_ticks, 20)
            self.pub = self.create_publisher(Odometry, "/wheel/odometry", 20)

        def _on_ticks(self, msg: Int64MultiArray):
            if len(msg.data) < 2:
                return
            now = self.get_clock().now()
            dt = (now - self.last_time).nanoseconds * 1e-9
            self.last_time = now
            x, y, yaw, vx, wz = self.integrator.update(int(msg.data[0]), int(msg.data[1]), dt)

            odom = Odometry()
            odom.header.stamp = now.to_msg()
            odom.header.frame_id = "odom"
            odom.child_frame_id = "base_footprint"
            odom.pose.pose.position.x = x
            odom.pose.pose.position.y = y
            odom.pose.pose.orientation.z = math.sin(yaw * 0.5)
            odom.pose.pose.orientation.w = math.cos(yaw * 0.5)
            odom.twist.twist.linear.x = vx
            odom.twist.twist.angular.z = wz

            # Tuned for agricultural soil slip (higher yaw variance -> IMU dominates heading)
            odom.pose.covariance[0] = 0.005
            odom.pose.covariance[7] = 0.005
            odom.pose.covariance[35] = 0.05
            odom.twist.covariance[0] = 0.002
            odom.twist.covariance[35] = 0.04
            self.pub.publish(odom)


    def main(args=None):
        rclpy.init(args=args)
        node = WheelOdometryNode()
        rclpy.spin(node)
        node.destroy_node()
        rclpy.shutdown()
