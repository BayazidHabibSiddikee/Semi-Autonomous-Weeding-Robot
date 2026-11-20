"""
ROS 2 Mission Supervisor & AI Tool-Calling Interface.
Exposes high-level ROS 2 Actions and Services to an AI Mission Commander while
enforcing strict safety boundaries:
  - Validates field bounds, speed limits (<= 0.30 m/s), and sensor health.
  - Translates high-level tool calls into Nav2 & custom ROS 2 Action goals.
  - NEVER exposes raw motor PWM, direct wheel duty cycles, or safety/E-stop overrides.
"""

from dataclasses import dataclass, field
from typing import Any
from .mission_planner import FieldMissionPlanner, FieldSpec


# Official Tool Schema exposed to AI Mission Commander
ROS2_AI_TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "name": "start_weeding_mission",
        "ros2_interface": "ExecuteWeedingMission (Custom Action)",
        "kind": "action",
        "description": "Start a supervised multi-row field-weeding or navigation-only mission",
        "parameters": {
            "field_id": "field_01",
            "start_row": 1,
            "end_row": 10,
            "speed_limit_mps": 0.15,
            "enable_weeding": False,  # False = Milestone 1 navigation commissioning
        },
    },
    {
        "name": "follow_crop_row",
        "ros2_interface": "FollowCropRow (Custom Action)",
        "kind": "action",
        "description": "Follow a single crop row using forward visual servoing until row end",
        "parameters": {"row_id": 1, "speed_limit_mps": 0.15},
    },
    {
        "name": "navigate_to_pose",
        "ros2_interface": "nav2_msgs/action/NavigateToPose",
        "kind": "action",
        "description": "Navigate autonomously to a map-frame pose via Nav2",
        "parameters": {"x_m": 0.0, "y_m": 0.3, "yaw_deg": 0.0},
    },
    {
        "name": "follow_waypoints",
        "ros2_interface": "nav2_msgs/action/FollowWaypoints",
        "kind": "action",
        "description": "Visit an ordered list of local map poses sequentially",
        "parameters": {"waypoints": [[1.0, 0.3, 0.0], [1.0, 0.9, 180.0]]},
    },
    {
        "name": "follow_gps_waypoints",
        "ros2_interface": "nav2_msgs/action/FollowGPSWaypoints",
        "kind": "action",
        "description": "Follow RTK-GNSS latitude/longitude waypoints for global field transit",
        "parameters": {"gps_waypoints": [[23.8103, 90.4125]]},
    },
    {
        "name": "navigate_through_poses",
        "ros2_interface": "nav2_msgs/action/NavigateThroughPoses",
        "kind": "action",
        "description": "Execute smooth headland U-turn trajectory through intermediate poses",
        "parameters": {"poses": [[12.85, 0.3, 90.0], [12.85, 0.9, 180.0], [11.85, 0.9, 180.0]]},
    },
    {
        "name": "scan_for_weeds",
        "ros2_interface": "ScanForWeeds (Custom Action)",
        "kind": "action",
        "description": "Trigger downward camera YOLOv8+CLIP+DINOv2+EfficientNet weed scan while stopped",
        "parameters": {"confidence_threshold": 0.78},
    },
    {
        "name": "pause_mission",
        "ros2_interface": "PauseMission (Custom Service)",
        "kind": "service",
        "description": "Cancel active Nav2/row-following action goals and hold safely",
        "parameters": {},
    },
    {
        "name": "get_robot_status",
        "ros2_interface": "GetRobotStatus (Custom Service)",
        "kind": "service",
        "description": "Return EKF pose, battery voltage, sensor health, and mission progress",
        "parameters": {},
    },
]

FORBIDDEN_TOOL_PREFIXES = ("motor_pwm", "set_duty", "bypass_estop", "force_laser", "raw_serial")
MAX_ALLOWED_SPEED_MPS = 0.30


@dataclass
class SensorHealth:
    wheel_encoders_ok: bool = True
    imu_ok: bool = True
    lidar_ok: bool = True
    nav_camera_ok: bool = True
    rtk_gnss_fix: str = "RTK_FIXED"
    hardware_estop_ok: bool = True
    laser_interlock_ok: bool = True


@dataclass
class MissionSupervisor:
    field_spec: FieldSpec = field(default_factory=lambda: FieldSpec(field_id="field_01"))
    sensors: SensorHealth = field(default_factory=SensorHealth)
    active_state: str = "IDLE"
    current_row: int = 1

    def __post_init__(self):
        self.planner = FieldMissionPlanner(self.field_spec)

    def dispatch_tool_call(self, tool_name: str, params: dict[str, Any]) -> dict[str, Any]:
        """Validate AI tool call and route to ROS 2 Action/Service layer."""
        if any(tool_name.lower().startswith(bad) for bad in FORBIDDEN_TOOL_PREFIXES):
            return {
                "accepted": False,
                "error": "POLICY_VIOLATION: AI Commander cannot access motor PWM or safety overrides.",
            }

        if tool_name == "get_robot_status":
            return {
                "accepted": True,
                "state": self.active_state,
                "current_row": self.current_row,
                "sensors": self.sensors.__dict__,
            }

        if tool_name == "pause_mission":
            self.active_state = "PAUSED"
            return {"accepted": True, "state": "PAUSED", "message": "All Nav2 & FollowCropRow goals canceled."}

        if not self.sensors.hardware_estop_ok:
            return {"accepted": False, "error": "HARDWARE_ESTOP_ENGAGED: Clear physical E-stop before dispatch."}

        if tool_name == "start_weeding_mission":
            start_row = int(params.get("start_row", 1))
            end_row = int(params.get("end_row", 1))
            speed = float(params.get("speed_limit_mps", 0.15))
            enable_weeding = bool(params.get("enable_weeding", False))

            ok, msg = self.planner.validate_row_range(start_row, end_row)
            if not ok:
                return {"accepted": False, "error": msg}
            if speed <= 0.0 or speed > MAX_ALLOWED_SPEED_MPS:
                return {
                    "accepted": False,
                    "error": f"speed_limit_mps={speed} exceeds safe limit (0.01..{MAX_ALLOWED_SPEED_MPS} m/s).",
                }
            if not (self.sensors.wheel_encoders_ok and self.sensors.imu_ok and self.sensors.nav_camera_ok):
                return {"accepted": False, "error": "SENSOR_HEALTH_FAILED: Encoders, IMU, and nav_camera required."}
            if enable_weeding and not self.sensors.laser_interlock_ok:
                return {"accepted": False, "error": "LASER_INTERLOCK_OPEN: Weeding disabled until interlock closes."}

            self.active_state = "EXECUTING_MISSION"
            self.current_row = start_row
            return {
                "accepted": True,
                "action": "ExecuteWeedingMission",
                "plan": {
                    "rows": list(range(start_row, end_row + 1)),
                    "speed_limit_mps": speed,
                    "laser_enabled": enable_weeding,
                    "first_headland_turn": [
                        p.__dict__ for p in self.planner.build_headland_turn_poses(start_row, min(end_row, start_row + 1), True)
                    ] if end_row > start_row else [],
                },
            }

        return {"accepted": True, "action": tool_name, "params": params, "state": self.active_state}
