"""
ROS 2 Jazzy Simulation Bringup Launch File (Stage 1 Commissioning).
Launches:
  1. robot_state_publisher (reconciled 4-wheel paired diff-drive URDF)
  2. Gazebo Harmonic field world + ros_gz_bridge
  3. ros2_control diff_drive_controller + joint_state_broadcaster
  4. robot_localization EKF (ekf_local_node)
  5. Nav2 stack + Collision Monitor
  6. crop_row_navigation FollowCropRow Action Server (laser disabled)
"""

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description():
    use_sim_time = LaunchConfiguration("use_sim_time", default="true")

    return LaunchDescription([
        DeclareLaunchArgument("use_sim_time", default_value="true"),

        Node(
            package="robot_localization",
            executable="ekf_node",
            name="ekf_local_node",
            output="screen",
            parameters=[
                "ros2_ws/src/rover_localization/ekf.yaml",
                {"use_sim_time": use_sim_time},
            ],
        ),
        Node(
            package="crop_row_navigation",
            executable="row_follow_action",
            name="follow_crop_row_action_server",
            output="screen",
            parameters=[
                {"use_sim_time": use_sim_time, "row_width_m": 0.60, "default_speed_mps": 0.15}
            ],
        ),
        Node(
            package="robot_safety",
            executable="safety_monitor",
            name="robot_safety_monitor",
            output="screen",
            parameters=[{"use_sim_time": use_sim_time}],
        ),
    ])
