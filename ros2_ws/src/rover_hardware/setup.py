from glob import glob
import os
from setuptools import setup

package_name = "rover_hardware"

setup(
    name=package_name,
    version="0.1.0",
    packages=[
        package_name,
        f"{package_name}.esp32_bridge",
        f"{package_name}.wheel_odometry",
        f"{package_name}.sensor_drivers",
    ],
    package_dir={package_name: "."},
    data_files=[
        ("share/ament_index/resource_index/packages", ["resource/" + package_name]),
        ("share/" + package_name, ["package.xml"]),
        (os.path.join("share", package_name, "config"), glob("config/*.yaml")),
    ],
    install_requires=["setuptools"],
    zip_safe=True,
    maintainer="Weeding Rover Team",
    maintainer_email="rover@example.com",
    description="ESP32 differential-drive bridge, wheel odometry, and BNO055 IMU ROS 2 drivers.",
    license="Apache-2.0",
    entry_points={
        "console_scripts": [
            "esp32_diffdrive_node = rover_hardware.esp32_bridge.esp32_diffdrive_node:main",
            "wheel_odom_node = rover_hardware.wheel_odometry.wheel_odom_node:main",
            "bno055_imu_node = rover_hardware.sensor_drivers.bno055_imu_node:main",
        ],
    },
)
