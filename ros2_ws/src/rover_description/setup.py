from glob import glob
import os
from setuptools import setup

package_name = "rover_description"

setup(
    name=package_name,
    version="0.1.0",
    packages=[package_name],
    package_dir={package_name: "."},
    data_files=[
        ("share/ament_index/resource_index/packages", ["resource/" + package_name]),
        ("share/" + package_name, ["package.xml"]),
        (os.path.join("share", package_name, "urdf"), glob("urdf/*")),
    ],
    install_requires=["setuptools"],
    zip_safe=True,
    maintainer="Weeding Rover Team",
    maintainer_email="rover@example.com",
    description="URDF/Xacro mechanical description of the 4-wheel differential-drive weeding rover.",
    license="Apache-2.0",
)
