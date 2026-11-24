"""
Adafruit BNO055 9-DOF Absolute Orientation IMU Driver Node (I2C -> ROS 2).
Publishes sensor_msgs/Imu on /imu/data at 100 Hz in imu_link frame for
robot_localization EKF heading & angular velocity fusion.
"""

try:
    import rclpy
    from rclpy.node import Node
    from sensor_msgs.msg import Imu
    ROS2_AVAILABLE = True
except ImportError:
    ROS2_AVAILABLE = False


if ROS2_AVAILABLE:
    class Bno055ImuNode(Node):
        def __init__(self):
            super().__init__("bno055_imu_node")
            self.declare_parameter("i2c_bus", 1)
            self.declare_parameter("i2c_address", 0x28)
            self.declare_parameter("frame_id", "imu_link")

            self.frame_id = self.get_parameter("frame_id").value
            self.pub = self.create_publisher(Imu, "/imu/data", 50)
            self.sensor = self._init_sensor()
            self.timer = self.create_timer(0.01, self._publish_sample)

        def _init_sensor(self):
            try:
                import board
                import adafruit_bno055
                return adafruit_bno055.BNO055_I2C(board.I2C())
            except Exception as exc:
                self.get_logger().warn(f"BNO055 hardware unavailable ({exc}); running idle stub")
                return None

        def _publish_sample(self):
            if self.sensor is None:
                return
            quat = self.sensor.quaternion
            gyro = self.sensor.gyro
            accel = self.sensor.linear_acceleration
            if not quat or any(v is None for v in quat):
                return

            msg = Imu()
            msg.header.stamp = self.get_clock().now().to_msg()
            msg.header.frame_id = self.frame_id

            # BNO055 returns (w, x, y, z)
            msg.orientation.w = float(quat[0])
            msg.orientation.x = float(quat[1])
            msg.orientation.y = float(quat[2])
            msg.orientation.z = float(quat[3])
            msg.orientation_covariance = [
                0.002, 0.0, 0.0,
                0.0, 0.002, 0.0,
                0.0, 0.0, 0.001,
            ]

            if gyro and all(v is not None for v in gyro):
                msg.angular_velocity.x = float(gyro[0])
                msg.angular_velocity.y = float(gyro[1])
                msg.angular_velocity.z = float(gyro[2])
                msg.angular_velocity_covariance = [
                    0.0005, 0.0, 0.0,
                    0.0, 0.0005, 0.0,
                    0.0, 0.0, 0.0004,
                ]

            if accel and all(v is not None for v in accel):
                msg.linear_acceleration.x = float(accel[0])
                msg.linear_acceleration.y = float(accel[1])
                msg.linear_acceleration.z = float(accel[2])
                msg.linear_acceleration_covariance = [
                    0.02, 0.0, 0.0,
                    0.0, 0.02, 0.0,
                    0.0, 0.0, 0.02,
                ]

            self.pub.publish(msg)


    def main(args=None):
        rclpy.init(args=args)
        node = Bno055ImuNode()
        rclpy.spin(node)
        node.destroy_node()
        rclpy.shutdown()
