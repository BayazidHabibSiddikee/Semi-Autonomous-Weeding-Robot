import os
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, ExecuteProcess
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node

def generate_launch_description():
    current_dir = os.path.dirname(os.path.abspath(__file__))
    workspace_dir = os.path.dirname(current_dir)
    urdf_file = os.path.join(current_dir, 'weed_laser_robot.urdf')
    rviz_config = os.path.join(workspace_dir, 'rviz', 'default.rviz')

    with open(urdf_file, 'r') as infp:
        content = infp.read()

    use_sim_time = LaunchConfiguration('use_sim_time', default='false')

    # Robot State Publisher Node
    robot_state_publisher_node = Node(
        package='robot_state_publisher',
        executable='robot_state_publisher',
        name='robot_state_publisher',
        output='screen',
        parameters=[{
            'robot_description': content,
            'use_sim_time': use_sim_time
        }]
    )

    # Active Joint State Publisher: publishes wheel + turret joint transforms so RViz can render TF links!
    joint_pub_node = ExecuteProcess(
        cmd=['python3', os.path.join(current_dir, 'joint_state_pub.py')],
        output='screen'
    )

    # RViz2 Node pre-configured with RobotModel, Grid, and TF displays enabled
    rviz_args = ['-d', rviz_config] if os.path.exists(rviz_config) else []
    rviz_node = Node(
        package='rviz2',
        executable='rviz2',
        name='rviz2',
        output='screen',
        arguments=rviz_args
    )

    return LaunchDescription([
        DeclareLaunchArgument('use_sim_time', default_value='false', description='Use simulation (Gazebo) clock if true'),
        robot_state_publisher_node,
        joint_pub_node,
        rviz_node
    ])
