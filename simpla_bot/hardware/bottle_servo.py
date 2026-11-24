"""Serial adapter for an MG996R driven by a separate Arduino/ESP32 controller.

Protocol:
    Pi -> controller: SERVO <angle_degrees>\n
    Pi -> controller: SERVO_DISABLE\n

The MCU validates angles and generates the servo signal. Power the servo from
a suitable separate regulated supply. Raspberry Pi GPIO is NOT a servo supply.
"""
from __future__ import annotations
import time

class BottleServoController:
    """Serial command client for a dedicated MG996R microcontroller."""
    def __init__(self, port="/dev/ttyACM0", baudrate=115200, min_angle=0,
                 max_angle=180, timeout_s=1.0, serial_instance=None):
        if min_angle < 0 or max_angle > 180 or min_angle >= max_angle:
            raise ValueError("Servo limits must satisfy 0 <= min < max <= 180")
        self.min_angle = int(min_angle)
        self.max_angle = int(max_angle)
        self._serial = serial_instance
        if self._serial is None:
            try:
                import serial
            except ImportError as exc:
                raise RuntimeError("Install pyserial to use the servo controller") from exc
            self._serial = serial.Serial(port, baudrate, timeout=timeout_s)
            time.sleep(2.0)  # Allow common Arduino boards to reset.

    def set_angle(self, angle_degrees):
        angle = int(angle_degrees)
        if not self.min_angle <= angle <= self.max_angle:
            raise ValueError(f"Angle {angle} outside {self.min_angle}..{self.max_angle}")
        self._serial.write(f"SERVO {angle}\\n".encode("ascii"))
        self._serial.flush()

    def disable_signal(self):
        """Stop servo pulses; this is NOT a power disconnect."""
        self._serial.write(b"SERVO_DISABLE\\n")
        self._serial.flush()

    def close(self):
        if self._serial is not None:
            self._serial.close()
            self._serial = None
