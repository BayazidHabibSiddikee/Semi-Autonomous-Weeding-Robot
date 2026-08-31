"""
Serial bridge between Raspberry Pi and ESP32.
Handles command sending and response parsing.
"""
import time


class ESP32Bridge:
    """Manages serial communication with ESP32."""

    def __init__(self, port="/dev/ttyUSB0", baudrate=115200, timeout=2):
        self.port = port
        self.baudrate = baudrate
        self.timeout = timeout
        self.serial = None
        self.connected = False

    def connect(self):
        import serial
        try:
            self.serial = serial.Serial(self.port, self.baudrate, timeout=self.timeout)
            time.sleep(2)
            self.connected = True
            # handshake
            resp = self.send("STATUS?")
            print(f"ESP32 connected on {self.port}: {resp}")
        except Exception as e:
            print(f"Cannot connect to ESP32: {e}")
            self.connected = False

    def disconnect(self):
        if self.serial and self.serial.is_open:
            self.serial.close()
            self.connected = False

    def send(self, cmd):
        """Send command, return response string."""
        if not self.connected:
            raise RuntimeError("ESP32 not connected")
        self.serial.write(f"{cmd}\n".encode())
        response = self.serial.readline().decode().strip()
        return response

    def send_motor(self, direction, duration_ms=500, speed=200):
        """Send motor command: F=forward, B=backward, R=right, L=left, S=stop."""
        if direction == "S":
            return self.send("MOVE S")
        return self.send(f"MOVE {direction} {duration_ms} {speed}")

    def send_servo(self, axis, angle_deg):
        """Send servo command: PAN or TILT."""
        return self.send(f"SERVO {axis} {int(angle_deg)}")

    def send_laser(self, on):
        """Turn laser on/off."""
        return self.send("LASER ON" if on else "LASER OFF")

    def read_ultrasonic(self):
        """Read distance in mm from ultrasonic/ToF sensor."""
        resp = self.send("ULTRASONIC?")
        if resp.startswith("DIST:"):
            try:
                return int(resp.split(":")[1])
            except ValueError:
                return -1
        return -1


class ESP32Simulator:
    """Simulator for testing without ESP32."""

    def __init__(self):
        self.connected = True
        self._laser_on = False
        self._distance = 150  # mm

    def connect(self):
        print("[SIM] ESP32 connected")

    def disconnect(self):
        print("[SIM] ESP32 disconnected")

    def send(self, cmd):
        if cmd == "STATUS?":
            return "OK"
        elif cmd == "ULTRASONIC?":
            return f"DIST:{self._distance}"
        elif cmd == "LASER ON":
            self._laser_on = True
            return "OK"
        elif cmd == "LASER OFF":
            self._laser_on = False
            return "OK"
        elif cmd.startswith("MOVE"):
            parts = cmd.split()
            print(f"[SIM] Motor: {parts[1]} {parts[2] if len(parts) > 2 else ''}")
            return "OK"
        elif cmd.startswith("SERVO"):
            parts = cmd.split()
            print(f"[SIM] Servo: {parts[1]} → {parts[2]}°")
            return "OK"
        return "OK"

    def send_motor(self, direction, duration_ms=500, speed=200):
        return self.send(f"MOVE {direction} {duration_ms} {speed}")

    def send_servo(self, axis, angle_deg):
        return self.send(f"SERVO {axis} {int(angle_deg)}")

    def send_laser(self, on):
        return self.send("LASER ON" if on else "LASER OFF")

    def read_ultrasonic(self):
        return self._distance
