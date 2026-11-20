#!/usr/bin/env python3
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import JointState
import math
import time

class DummyJointStatePublisher(Node):
    def __init__(self):
        super().__init__('dummy_joint_state_publisher')
        self.publisher_ = self.create_publisher(JointState, 'joint_states', 10)
        self.timer = self.create_timer(0.05, self.timer_callback) # 20 Hz
        self.start_time = time.time()
        self.joints = [
            'front_left_wheel_joint',
            'front_right_wheel_joint',
            'rear_left_wheel_joint',
            'rear_right_wheel_joint',
            'turret_yaw_joint'
        ]

    def timer_callback(self):
        msg = JointState()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.name = self.joints
        t = time.time() - self.start_time
        # Gentle sinusoidal motion for turret demonstration
        turret_ang = 0.35 * math.sin(t * 1.5)
        wheel_ang = (t * 2.0) % (2 * math.pi)
        msg.position = [wheel_ang, wheel_ang, wheel_ang, wheel_ang, turret_ang]
        self.publisher_.publish(msg)

def main(args=None):
    rclpy.init(args=args)
    node = DummyJointStatePublisher()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    node.destroy_node()
    rclpy.shutdown()

if __name__ == '__main__':
    main()
