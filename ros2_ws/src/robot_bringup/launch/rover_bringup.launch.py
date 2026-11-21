"""
ROS 2 Jazzy Physical Rover Bringup Launch File (Raspberry Pi 5 + Ubuntu 24.04).
Launches physical hardware drivers, EKF + RTK-GNSS localization, Nav2 bringup,
Nav2 Collision Monitor (/cmd_vel_nav -> /cmd_vel_safe) with lifecycle manager,
visual crop-row action server, and safety monitor.

Firmware Protocol Note:
  - This ROS 2 stack uses `ros2_ws/src/rover_hardware/esp32_bridge/esp32_closed_loop_firmware.py`
    which streams asynchronous `ODOM <l_ticks> <r_ticks> ...` packets at 50 Hz.
  - The standalone Python Pi stack (`Navigation/src/pi_server.py`) uses
    `Navigation/esp32_firmware/rover_firmware.py` (`TELEM?` polling protocol).
  - Do NOT mix firmware files across the two runtimes.
"""

import os

from ament_index_python.packages import get_package_share_directory
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription
from launch.conditions import IfCondition
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    serial_port = LaunchConfiguration("serial_port", default="/dev/ttyUSB0")
    enable_weeding = LaunchConfiguration("enable_weeding", default="false")
    use_nav2 = LaunchConfiguration("use_nav2", default="true")

    loc_share = get_package_share_directory("rover_localization")
    nav_share = get_package_share_directory("rover_navigation")
    nav2_bringup_share = get_package_share_directory("nav2_bringup")

    ekf_yaml = os.path.join(loc_share, "config", "ekf.yaml")
    gnss_yaml = os.path.join(loc_share, "config", "gnss.yaml")
    nav2_params = os.path.join(nav_share, "config", "nav2_params.yaml")

    return LaunchDescription([
        DeclareLaunchArgument("serial_port", default_value="/dev/ttyUSB0"),
        DeclareLaunchArgument("enable_weeding", default_value="false"),
        DeclareLaunchArgument("use_nav2", default_value="true"),

        # 1. Physical Hardware Drivers (ROS 2 ODOM streaming firmware on ESP32)
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

        # 2. Sensor Fusion Localization (Encoders + BNO055 + RTK-GNSS)
        Node(
            package="robot_localization",
            executable="ekf_node",
            name="ekf_local_node",
            output="screen",
            parameters=[ekf_yaml],
        ),
        Node(
            package="robot_localization",
            executable="navsat_transform_node",
            name="navsat_transform_node",
            output="screen",
            parameters=[gnss_yaml],
        ),

        # 3. Nav2 Navigation Stack (outputs /cmd_vel_nav -> routed through Collision Monitor)
        IncludeLaunchDescription(
            PythonLaunchDescriptionSource(
                os.path.join(nav2_bringup_share, "launch", "navigation_launch.py")
            ),
            condition=IfCondition(use_nav2),
            launch_arguments={
                "params_file": nav2_params,
                "use_sim_time": "false",
            }.items(),
        ),

        # 4. Nav2 Collision Monitor: explicitly bridges /cmd_vel_nav -> /cmd_vel_safe
        Node(
            package="nav2_collision_monitor",
            executable="collision_monitor",
            name="collision_monitor",
            output="screen",
            parameters=[nav2_params],
            remappings=[
                ("cmd_vel_in", "/cmd_vel_nav"),
                ("cmd_vel_out", "/cmd_vel_safe"),
            ],
        ),
        Node(
            package="nav2_lifecycle_manager",
            executable="lifecycle_manager",
            name="lifecycle_manager_collision_monitor",
            output="screen",
            parameters=[{
                "autostart": True,
                "node_names": ["collision_monitor"],
            }],
        ),

        # 5. Crop-Row Visual Action Server (publishes /cmd_vel_nav into Collision Monitor)
        Node(
            package="crop_row_navigation",
            executable="row_follow_action",
            name="follow_crop_row_action_server",
            output="screen",
            parameters=[{"row_width_m": 0.60, "default_speed_mps": 0.15}],
        ),

        # 6. Safety Monitor (hardware E-stop sense + tilt + watchdog supervision)
        Node(
            package="robot_safety",
            executable="safety_monitor",
            name="robot_safety_monitor",
            output="screen",
            parameters=[{"enable_weeding": enable_weeding}],
        ),
    ])
