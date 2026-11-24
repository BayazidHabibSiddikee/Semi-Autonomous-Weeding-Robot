from setuptools import setup

package_name = "crop_row_navigation"

setup(
    name=package_name,
    version="0.1.0",
    packages=[package_name],
    package_dir={package_name: "."},
    data_files=[
        ("share/ament_index/resource_index/packages", ["resource/" + package_name]),
        ("share/" + package_name, ["package.xml"]),
    ],
    install_requires=["setuptools"],
    zip_safe=True,
    maintainer="Weeding Rover Team",
    maintainer_email="rover@example.com",
    description="Visual crop-row tracking and FollowCropRow ROS 2 action server.",
    license="Apache-2.0",
    entry_points={
        "console_scripts": [
            "row_follow_action = crop_row_navigation.row_follow_action:main",
        ],
    },
)
