"""
Ultrasonic / ToF sensor for Z-axis distance measurement.
Used to confirm laser firing distance before each shot.
"""
import time


class UltrasonicSensor:
    """Read distance from VL53L0X ToF or HC-SR04 via ESP32."""

    def __init__(self, esp32_bridge, sensor_type="vl53l0x"):
        self.bridge = esp32_bridge
        self.sensor_type = sensor_type

    def read_distance_mm(self):
        """
        Query ESP32 for current distance reading.
        Returns distance in mm, or -1 on error.
        """
        response = self.bridge.send("ULTRASONIC?")
        if response.startswith("DIST:"):
            try:
                return int(response.split(":")[1])
            except ValueError:
                return -1
        return -1

    def is_in_range(self, min_mm=50, max_mm=2000):
        """Check if distance is within readable range."""
        dist = self.read_distance_mm()
        return min_mm <= dist <= max_mm

    def is_fire_ready(self, target_mm=100, tolerance_mm=30):
        """Check if distance is within firing tolerance of target."""
        dist = self.read_distance_mm()
        if dist < 0:
            return False
        return abs(dist - target_mm) <= tolerance_mm


class UltrasonicSimulator:
    """Simulator for testing."""

    def __init__(self, simulated_distance_mm=150):
        self.distance = simulated_distance_mm

    def read_distance_mm(self):
        return self.distance

    def is_in_range(self, min_mm=50, max_mm=2000):
        return min_mm <= self.distance <= max_mm

    def is_fire_ready(self, target_mm=100, tolerance_mm=30):
        return abs(self.distance - target_mm) <= tolerance_mm
