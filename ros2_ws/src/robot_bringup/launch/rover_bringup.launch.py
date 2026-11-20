"""
ROS 2 Jazzy Physical Rover Bringup Launch File (Raspberry Pi 5 + Ubuntu 24.04).
Launches physical hardware drivers, EKF + RTK-GNSS localization, Nav2 + Collision
Monitor, visual crop-row action server, and safety monitor.
"""

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    serial_port = LaunchConfiguration("serial_port", default="/dev/ttyUSB0")
    enable_weeding = LaunchConfiguration("enable_weeding", default="false")

    return LaunchDescription([
        DeclareLaunchArgument("serial_port", default_value="/dev/ttyUSB0"),
        DeclareLaunchArgument("enable_weeding", default_value="false"),

        Node(
            package="rover_hardware",
            executable="esp32_diffdrive_node",
            name="esp32_diffdrive_bridge",
            output="screen",
            parameters=[{"serial_port": serial_port, "baud_rate": 115200}],
        ),
        Node(
            package="rover_hardware",
            executable="wheel_odom_node",
            name="wheel_odometry_node",
            output="screen",
        ),
        Node(
            package="rover_hardware",
            executable="bno055_imu_node",
            name="bno055_imu_node",
            output="screen",
        ),
        Node(
            package="robot_localization",
            executable="ekf_node",
            name="ekf_local_node",
            output="screen",
            parameters=["ros2_ws/src/rover_localization/ekf.yaml"],
        ),
        Node(
            package="robot_localization",
            executable="navsat_transform_node",
            name="navsat_transform_node",
            output="screen",
            parameters=["ros2_ws/src/rover_localization/gnss.yaml"],
        ),
        Node(
            package="crop_row_navigation",
            executable="row_follow_action",
            name="follow_crop_row_action_server",
            output="screen",
            parameters=[{"row_width_m": 0.60, "default_speed_mps": 0.15}],
        ),
        Node(
            package="robot_safety",
            executable="safety_monitor",
            name="robot_safety_monitor",
            output="screen",
            parameters=[{"enable_weeding": enable_weeding}],
        ),
    ])
