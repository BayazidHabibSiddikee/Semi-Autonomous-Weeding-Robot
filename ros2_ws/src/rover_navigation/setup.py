from glob import glob
import os
from setuptools import setup

package_name = "rover_navigation"

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
    description="Nav2 parameters, mission planner, and field mission action coordinators.",
    license="Apache-2.0",
    entry_points={
        "console_scripts": [
            "mission_planner = rover_navigation.mission_planner:main",
        ],
    },
)
