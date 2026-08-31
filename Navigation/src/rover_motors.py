"""
Rover motor control via ESP32 serial bridge.
Drives DC gear motors for forward/backward/rotate movement.
"""
import time
import math


class RoverMotors:
    """Send movement commands to ESP32 over serial."""

    def __init__(self, port="/dev/ttyUSB0", baudrate=115200, timeout=2):
        self.port = port
        self.baudrate = baudrate
        self.timeout = timeout
        self.serial = None
        self.connected = False
        self.current_x = 0.0  # estimated position in cm
        self.current_y = 0.0
        self.heading = 0.0    # degrees, 0 = forward

    def connect(self):
        import serial
        try:
            self.serial = serial.Serial(self.port, self.baudrate, timeout=self.timeout)
            time.sleep(2)  # wait for ESP32 reset
            self.connected = True
            self._send("STATUS?")
            print(f"Connected to ESP32 on {self.port}")
        except Exception as e:
            print(f"Cannot connect to {self.port}: {e}")
            self.connected = False

    def disconnect(self):
        if self.serial and self.serial.is_open:
            self.stop()
            self.serial.close()
            self.connected = False
            print("Disconnected from ESP32")

    def _send(self, cmd):
        if not self.connected:
            raise RuntimeError("Not connected to ESP32")
        self.serial.write(f"{cmd}\n".encode())
        response = self.serial.readline().decode().strip()
        return response

    def forward(self, duration_ms=500, speed=200):
        """Move forward for duration_ms at given speed."""
        self._send(f"MOVE F {duration_ms} {speed}")
        # estimate position change
        dist_cm = (duration_ms / 1000.0) * 10  # rough: 10 cm/s at speed 200
        rad = math.radians(self.heading)
        self.current_x += dist_cm * math.cos(rad)
        self.current_y += dist_cm * math.sin(rad)
        time.sleep(duration_ms / 1000.0 + 0.1)

    def backward(self, duration_ms=300, speed=180):
        """Move backward for duration_ms."""
        self._send(f"MOVE B {duration_ms} {speed}")
        dist_cm = (duration_ms / 1000.0) * 8
        rad = math.radians(self.heading)
        self.current_x -= dist_cm * math.cos(rad)
        self.current_y -= dist_cm * math.sin(rad)
        time.sleep(duration_ms / 1000.0 + 0.1)

    def rotate_right(self, degrees=90, speed=180):
        """Rotate clockwise by given degrees."""
        self._send(f"MOVE R {degrees} {speed}")
        self.heading = (self.heading + degrees) % 360
        time.sleep(degrees / 90.0 * 0.5 + 0.1)

    def rotate_left(self, degrees=90, speed=180):
        """Rotate counter-clockwise by given degrees."""
        self._send(f"MOVE L {degrees} {speed}")
        self.heading = (self.heading - degrees) % 360
        time.sleep(degrees / 90.0 * 0.5 + 0.1)

    def stop(self):
        """Stop all movement."""
        self._send("MOVE S")

    def get_position(self):
        """Return estimated (x_cm, y_cm, heading_deg)."""
        return self.current_x, self.current_y, self.heading

    def emergency_stop(self):
        """Immediate stop."""
        self.stop()
        print("ROVER EMERGENCY STOP")


class RoverSimulator:
    """Simulator for testing without hardware."""

    def __init__(self):
        self.connected = True
        self.current_x = 0.0
        self.current_y = 0.0
        self.heading = 0.0

    def connect(self):
        print("[SIM] Rover connected")

    def disconnect(self):
        print("[SIM] Rover disconnected")

    def forward(self, duration_ms=500, speed=200):
        dist_cm = (duration_ms / 1000.0) * 10
        rad = math.radians(self.heading)
        self.current_x += dist_cm * math.cos(rad)
        self.current_y += dist_cm * math.sin(rad)
        print(f"[SIM] Forward {duration_ms}ms → ({self.current_x:.1f}, {self.current_y:.1f})")

    def backward(self, duration_ms=300, speed=180):
        dist_cm = (duration_ms / 1000.0) * 8
        rad = math.radians(self.heading)
        self.current_x -= dist_cm * math.cos(rad)
        self.current_y -= dist_cm * math.sin(rad)
        print(f"[SIM] Backward {duration_ms}ms → ({self.current_x:.1f}, {self.current_y:.1f})")

    def rotate_right(self, degrees=90, speed=180):
        self.heading = (self.heading + degrees) % 360
        print(f"[SIM] Rotate right {degrees}° → heading {self.heading}°")

    def rotate_left(self, degrees=90, speed=180):
        self.heading = (self.heading - degrees) % 360
        print(f"[SIM] Rotate left {degrees}° → heading {self.heading}°")

    def stop(self):
        print("[SIM] Stop")

    def get_position(self):
        return self.current_x, self.current_y, self.heading

    def emergency_stop(self):
        print("[SIM] EMERGENCY STOP")


def create_rover(simulate=False, **kwargs):
    """Factory function."""
    if simulate:
        return RoverSimulator()
    return RoverMotors(**kwargs)
