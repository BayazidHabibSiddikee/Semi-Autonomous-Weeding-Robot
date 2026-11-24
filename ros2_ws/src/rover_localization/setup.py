from glob import glob
import os
from setuptools import setup

package_name = "rover_localization"

setup(
    name=package_name,
    version="0.1.0",
    packages=[package_name],
    package_dir={package_name: "."},
    data_files=[
        ("share/ament_index/resource_index/packages", ["resource/" + package_name]),
        ("share/" + package_name, ["package.xml"]),
        (os.path.join("share", package_name, "config"), glob("*.yaml")),
    ],
    install_requires=["setuptools"],
    zip_safe=True,
    maintainer="Weeding Rover Team",
    maintainer_email="rover@example.com",
    description="EKF and RTK-GNSS robot_localization configuration for the weeding rover.",
    license="Apache-2.0",
)
