"""
Fail-Safe Obstacle Sensor Driver (VL53L0X / HC-SR04 over shared ESP32Bridge).
Fixes NAV-05 (invalid -1 sensor readings MUST halt rover and enter FAULT, never
permit forward motion), NAV-09 (unknown obstacles trigger safe OBSTACLE_HOLD,
never blind auto-dodging), and HW-02 (sensor type aligned with rover_config.yaml).
"""

from dataclasses import dataclass
from enum import Enum


class ObstacleStatus(Enum):
    CLEAR = "CLEAR"
    OBSTACLE = "OBSTACLE"
    SENSOR_FAULT = "SENSOR_FAULT"


@dataclass
class ObstacleReading:
    status: ObstacleStatus
    distance_mm: int
    reason: str


class UltrasonicSensor:
    """Fail-safe range sensor evaluating clearance, obstacle hold, and faults."""

    def __init__(
        self,
        esp32_bridge,
        sensor_type: str = "vl53l0x",
        min_valid_mm: int = 40,
        max_valid_mm: int = 2000,
        obstacle_stop_mm: int = 350,
        max_consecutive_faults: int = 2,
    ):
        self.bridge = esp32_bridge
        self.sensor_type = sensor_type
        self.min_valid_mm = min_valid_mm
        self.max_valid_mm = max_valid_mm
        self.obstacle_stop_mm = obstacle_stop_mm
        self.max_consecutive_faults = max_consecutive_faults
        self._consecutive_faults = 0

    def read_distance_mm(self) -> int:
        """Query shared ESP32Bridge for range in mm (-1 on comm/sensor error)."""
        try:
            return int(self.bridge.read_distance_mm())
        except Exception:
            return -1

    def evaluate(self) -> ObstacleReading:
        """
        Fail-safe sensor evaluation (NAV-05 & NAV-09):
          - Reading < 0 or out of valid range -> SENSOR_FAULT (NEVER clear!)
          - Valid reading < obstacle_stop_mm  -> OBSTACLE (safe hold, no auto-dodge)
          - Valid reading >= obstacle_stop_mm -> CLEAR
        """
        dist = self.read_distance_mm()
        if dist < self.min_valid_mm or dist > self.max_valid_mm:
            self._consecutive_faults += 1
            return ObstacleReading(
                status=ObstacleStatus.SENSOR_FAULT,
                distance_mm=dist,
                reason=f"INVALID_READING({dist}mm, consecutive_faults={self._consecutive_faults})",
            )

        self._consecutive_faults = 0
        if dist < self.obstacle_stop_mm:
            return ObstacleReading(
                status=ObstacleStatus.OBSTACLE,
                distance_mm=dist,
                reason=f"UNKNOWN_OBSTACLE_AT_{dist}MM_SAFE_HOLD",
            )

        return ObstacleReading(
            status=ObstacleStatus.CLEAR,
            distance_mm=dist,
            reason="PATH_CLEAR",
        )

    @property
    def fault_latched(self) -> bool:
        return self._consecutive_faults >= self.max_consecutive_faults

    def reset_faults(self):
        self._consecutive_faults = 0


class UltrasonicSimulator(UltrasonicSensor):
    """Deterministic simulator supporting valid clear, obstacle, and -1 fault injection."""

    def __init__(
        self,
        simulated_distance_mm: int = 900,
        min_valid_mm: int = 40,
        max_valid_mm: int = 2000,
        obstacle_stop_mm: int = 350,
    ):
        super().__init__(
            esp32_bridge=None,
            sensor_type="sim_vl53l0x",
            min_valid_mm=min_valid_mm,
            max_valid_mm=max_valid_mm,
            obstacle_stop_mm=obstacle_stop_mm,
        )
        self.distance = simulated_distance_mm

    def read_distance_mm(self) -> int:
        return self.distance
