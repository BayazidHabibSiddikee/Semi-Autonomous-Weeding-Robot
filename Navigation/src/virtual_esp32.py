"""
Virtual ESP32 firmware bridge.

The real Pi talks to the ESP32 over USB serial with a tiny text protocol
(`MOVE F 500 200`, `SERVO PAN 90`, `LASER ON`, `ULTRASONIC?`). This module
implements exactly that protocol, but the "hardware" is the field simulator,
so the whole stack (Pi logic -> ESP32 protocol -> motors/servo/laser/sensor)
can be exercised without hardware.

It is deliberately API-compatible with `esp32_bridge.ESP32Bridge`, so the
same rover code runs against real hardware or against this simulator.
"""
from __future__ import annotations

import time
from typing import List, Optional


class VirtualESP32:
    """ESP32 simulator wired to a FieldSimulator (motors really move the rover)."""

    def __init__(self, field, gimbal=None, log: bool = True, laser_offset_cm: float = 9.0):
        self.field = field
        self.gimbal = gimbal
        self.log_enabled = log
        self.connected = True
        self.laser_on = False
        # the laser head sits on the arm in front of the rover centre, so the
        # ToF sensor reads the distance from the nozzle, not from the chassis
        self.laser_offset_cm = laser_offset_cm
        self.command_log: List[str] = []

    # ----------------------------------------------------------- bridge API

    def connect(self):
        self.connected = True
        self._log("[SIM] ESP32 virtual firmware ready")

    def disconnect(self):
        self.connected = False
        self.laser_on = False

    def send(self, cmd: str) -> str:
        """Handle one protocol line, exactly like the firmware would."""
        self.command_log.append(cmd)
        self._log(f"[ESP32] {cmd}")

        if cmd == "STATUS?":
            return "OK"
        if cmd == "ULTRASONIC?":
            return f"DIST:{self.read_ultrasonic()}"
        if cmd == "LASER ON":
            self.laser_on = True
            return "OK"
        if cmd == "LASER OFF":
            self.laser_on = False
            return "OK"
        if cmd.startswith("MOVE"):
            parts = cmd.split()
            direction = parts[1] if len(parts) > 1 else "S"
            duration = int(parts[2]) if len(parts) > 2 else 500
            speed = int(parts[3]) if len(parts) > 3 else 200
            if direction.upper() in ("T", "TURN"):
                # fine steering: "MOVE T <degrees>" (negative = left)
                self.field.rotate_right(duration, speed)
            else:
                self._move(direction, duration, speed)
            return "OK"
        if cmd.startswith("SERVO"):
            parts = cmd.split()
            axis = parts[1] if len(parts) > 1 else "PAN"
            angle = int(parts[2]) if len(parts) > 2 else 90
            self._servo(axis, angle)
            return "OK"
        return "OK"

    def send_motor(self, direction: str, duration_ms: int = 500, speed: int = 200) -> str:
        if direction == "S":
            return self.send("MOVE S")
        return self.send(f"MOVE {direction} {duration_ms} {speed}")

    def send_servo(self, axis: str, angle_deg: float) -> str:
        return self.send(f"SERVO {axis} {int(angle_deg)}")

    def send_laser(self, on: bool) -> str:
        return self.send("LASER ON" if on else "LASER OFF")

    def read_ultrasonic(self) -> int:
        """
        Distance in mm reported by the ToF sensor.

        The sensor sits on the pan-tilt gimbal, so when the gimbal is aimed at
        a target it reports the distance to that target; otherwise it reports
        whatever is straight ahead.
        """
        if self.gimbal is not None and getattr(self.gimbal, "last_pixel", None):
            wx, wy = self._aimed_field_point()
            if wx is not None:
                dx = wx - self.field.rover_x
                dy = wy - self.field.rover_y
                dist_cm = (dx * dx + dy * dy) ** 0.5 - self.laser_offset_cm
                return int(round(max(dist_cm, 0.0) * 10.0))  # cm -> mm
        return int(self.field.sonar(self.field.heading))

    def _aimed_field_point(self):
        """Field position (cm) the gimbal is currently pointing at."""
        if self.gimbal is None or not getattr(self.gimbal, "last_pixel", None):
            return None, None
        import math

        u, v = self.gimbal.last_pixel
        rx = (u - self.field.frame_w / 2) / self.field.px_per_cm_x
        ry = (v - self.field.frame_h / 2) / self.field.px_per_cm_y
        rad = math.radians(self.field.heading)
        wx = self.field.rover_x + rx * math.cos(rad) - ry * math.sin(rad)
        wy = self.field.rover_y + rx * math.sin(rad) + ry * math.cos(rad)
        return wx, wy

    # ------------------------------------------------------------ internals

    def _move(self, direction: str, duration_ms: int, speed: int):
        if direction == "F":
            self.field.forward(duration_ms, speed)
        elif direction == "B":
            self.field.backward(duration_ms, speed)
        elif direction == "R":
            self.field.rotate_right(90, speed)
        elif direction == "L":
            self.field.rotate_left(90, speed)
        else:
            self.field.stop()

    def _servo(self, axis: str, angle: int):
        if self.gimbal is None:
            return
        if axis.upper() == "PAN":
            self.gimbal.move_to(angle, self.gimbal.current_tilt)
        else:
            self.gimbal.move_to(self.gimbal.current_pan, angle)

    def _log(self, message: str):
        if self.log_enabled:
            print(message)

    # ------------------------------------------------------------- helpers

    def fire_laser_at(self, x_cm: float, y_cm: float, duration_ms: int = 300) -> Optional[tuple]:
        """
        Aim at a field position and fire - the same action the real firmware
        performs, but resolved against the simulated field.
        """
        self.send_laser(True)
        time.sleep(min(duration_ms, 300) / 1000.0)
        self.send_laser(False)
        return self.field.remove_weed_near(x_cm, y_cm)
