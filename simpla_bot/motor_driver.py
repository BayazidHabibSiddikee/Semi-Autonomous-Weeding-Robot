"""
Normal Motor Driver Interface for Simpla Bot.

Supports three clean backends with zero external framework dependencies:
  1. "sim"    - Safe bench simulator tracking virtual distance & heading.
  2. "gpio"   - Direct Raspberry Pi GPIO PWM + DIR for L298N or BTS7960 H-bridges.
  3. "serial" - Simple USB-serial ASCII commands to Arduino/ESP32 running
                simpla_bot/firmware/simpla_motor_relay.ino.

All movement commands track whether the rover is currently moving (`is_moving`)
so the flame/grinder controller can enforce a strict stationary safety interlock.
"""

from __future__ import annotations

import time
import threading
from typing import Any, Callable, Dict, Optional


class NormalMotorDriver:
    """Differential-drive motor controller for standard L298N / BTS7960 / serial drivers."""

    def __init__(
        self,
        cfg: Dict[str, Any],
        sleep_fn: Callable[[float], None] = time.sleep,
    ) -> None:
        md = cfg.get("motor_driver", {})
        self.backend: str = str(md.get("backend", "sim")).lower()
        self.driver_type: str = str(md.get("driver_type", "l298n")).lower()
        self.serial_port: str = str(md.get("serial_port", "/dev/ttyUSB0"))
        self.serial_baud: int = int(md.get("serial_baud", 115200))
        self.pwm_freq_hz: int = int(md.get("pwm_freq_hz", 1000))

        self.left_ena_pin: int = int(md.get("left_ena_pin", 12))
        self.left_in1_pin: int = int(md.get("left_in1_pin", 5))
        self.left_in2_pin: int = int(md.get("left_in2_pin", 6))
        self.right_enb_pin: int = int(md.get("right_enb_pin", 13))
        self.right_in3_pin: int = int(md.get("right_in3_pin", 20))
        self.right_in4_pin: int = int(md.get("right_in4_pin", 21))

        self.speed_mm_per_sec_at_100pct: float = float(
            md.get("speed_mm_per_sec_at_100pct", 520.0)
        )
        self.turn_90_deg_sec_at_50pct: float = float(
            md.get("turn_90_deg_sec_at_50pct", 1.35)
        )
        self.invert_left: bool = bool(md.get("invert_left", False))
        self.invert_right: bool = bool(md.get("invert_right", False))

        self._sleep = sleep_fn
        self._left_pct: float = 0.0
        self._right_pct: float = 0.0
        self._total_distance_mm: float = 0.0
        self._heading_deg: float = 0.0
        self._gpio: Any = None
        self._pwm_left: Any = None
        self._pwm_right: Any = None
        self._serial: Any = None
        self._serial_lock = threading.Lock()
        self._command_log: list[str] = []

        if self.backend == "gpio":
            self._init_gpio()
        elif self.backend == "serial":
            self._init_serial()

    # ------------------------------------------------------------------
    # Hardware initialization
    # ------------------------------------------------------------------

    def _init_gpio(self) -> None:
        try:
            import RPi.GPIO as GPIO  # type: ignore
        except ImportError as exc:
            raise RuntimeError(
                "backend='gpio' requires RPi.GPIO on Raspberry Pi. "
                "Use backend='sim' for bench testing on a PC."
            ) from exc

        GPIO.setmode(GPIO.BCM)
        GPIO.setwarnings(False)
        for pin in (
            self.left_ena_pin,
            self.left_in1_pin,
            self.left_in2_pin,
            self.right_enb_pin,
            self.right_in3_pin,
            self.right_in4_pin,
        ):
            GPIO.setup(pin, GPIO.OUT)
            GPIO.output(pin, GPIO.LOW)

        self._pwm_left = GPIO.PWM(self.left_ena_pin, self.pwm_freq_hz)
        self._pwm_right = GPIO.PWM(self.right_enb_pin, self.pwm_freq_hz)
        self._pwm_left.start(0)
        self._pwm_right.start(0)
        self._gpio = GPIO

    def _init_serial(self) -> None:
        try:
            import serial  # type: ignore
        except ImportError as exc:
            raise RuntimeError(
                "backend='serial' requires pyserial (`pip install pyserial`)."
            ) from exc
        self._serial = serial.Serial(self.serial_port, self.serial_baud, timeout=0.2, write_timeout=0.2)
        self._sleep(1.5)  # Allow Arduino auto-reset

    # ------------------------------------------------------------------
    # Telemetry properties
    # ------------------------------------------------------------------

    @property
    def is_moving(self) -> bool:
        return abs(self._left_pct) > 0.1 or abs(self._right_pct) > 0.1

    @property
    def is_stopped(self) -> bool:
        return not self.is_moving

    @property
    def total_distance_mm(self) -> float:
        return round(self._total_distance_mm, 1)

    @property
    def heading_deg(self) -> float:
        return round(self._heading_deg % 360.0, 1)

    @property
    def command_log(self) -> list[str]:
        return list(self._command_log)

    # ------------------------------------------------------------------
    # Low-level drive & stop
    # ------------------------------------------------------------------

    def send_serial_line(self, line: str) -> None:
        """Send an ASCII command line if using the serial Arduino/ESP32 backend."""
        msg = line.strip() + "\n"
        self._command_log.append(line.strip())
        if self.backend == "serial":
            if self._serial is None:
                raise RuntimeError("ESP32 serial port is not open")
            with self._serial_lock:
                self._serial.write(msg.encode("ascii"))
                self._serial.flush()

    def ping(self) -> bool:
        """Return True only when the ESP32 firmware answers PING with a healthy E-stop input."""
        if self.backend != "serial" or self._serial is None:
            return False
        try:
            with self._serial_lock:
                self._serial.reset_input_buffer()
                self._serial.write(b"PING\n")
                self._serial.flush()
                reply = self._serial.readline().decode("ascii", errors="ignore").strip()
            return reply.startswith("PONG ") and "ESTOP=0" in reply
        except Exception:
            return False

    def drive(self, left_pct: float, right_pct: float) -> None:
        """Command raw left/right wheel PWM speeds in [-100, +100]."""
        l_cmd = max(-100.0, min(100.0, float(left_pct)))
        r_cmd = max(-100.0, min(100.0, float(right_pct)))
        self._left_pct = l_cmd
        self._right_pct = r_cmd

        hw_l = -l_cmd if self.invert_left else l_cmd
        hw_r = -r_cmd if self.invert_right else r_cmd

        if self.backend == "gpio" and self._gpio is not None:
            self._apply_gpio_channel(
                hw_l, self.left_in1_pin, self.left_in2_pin, self._pwm_left
            )
            self._apply_gpio_channel(
                hw_r, self.right_in3_pin, self.right_in4_pin, self._pwm_right
            )
        elif self.backend == "serial":
            try:
                self.send_serial_line(f"M {int(round(hw_l))} {int(round(hw_r))}")
            except Exception:
                self._left_pct = self._right_pct = 0.0
                raise
        else:
            self._command_log.append(f"DRIVE L={l_cmd:.1f}% R={r_cmd:.1f}%")

    def _apply_gpio_channel(self, pct: float, pin_a: int, pin_b: int, pwm: Any) -> None:
        GPIO = self._gpio
        duty = min(100.0, abs(pct))
        if abs(pct) < 1.0:
            GPIO.output(pin_a, GPIO.LOW)
            GPIO.output(pin_b, GPIO.LOW)
            pwm.ChangeDutyCycle(0)
        elif pct > 0:
            GPIO.output(pin_a, GPIO.HIGH)
            GPIO.output(pin_b, GPIO.LOW)
            pwm.ChangeDutyCycle(duty)
        else:
            GPIO.output(pin_a, GPIO.LOW)
            GPIO.output(pin_b, GPIO.HIGH)
            pwm.ChangeDutyCycle(duty)

    def stop(self) -> None:
        """Immediately halt both drive motors."""
        self._left_pct = 0.0
        self._right_pct = 0.0
        if self.backend == "gpio" and self._gpio is not None:
            GPIO = self._gpio
            for pin in (
                self.left_in1_pin,
                self.left_in2_pin,
                self.right_in3_pin,
                self.right_in4_pin,
            ):
                GPIO.output(pin, GPIO.LOW)
            self._pwm_left.ChangeDutyCycle(0)
            self._pwm_right.ChangeDutyCycle(0)
        elif self.backend == "serial":
            self.send_serial_line("STOP")
        else:
            self._command_log.append("STOP")

    # ------------------------------------------------------------------
    # Calibrated distance & turn helpers ("how much to go")
    # ------------------------------------------------------------------

    def estimate_step_distance_mm(self, speed_pct: float, duration_s: float) -> float:
        """Estimate distance traveled (mm) for a given motor speed % and time (s)."""
        return (
            self.speed_mm_per_sec_at_100pct
            * (abs(speed_pct) / 100.0)
            * max(0.0, duration_s)
        )

    def drive_step(
        self,
        speed_pct: float,
        steer_adjust_pct: float,
        duration_s: float,
        estop_check: Optional[Callable[[], bool]] = None,
    ) -> float:
        """
        Drive forward for a short control interval `duration_s` while applying
        steering adjustment, returning estimated millimeters traveled.
        """
        if estop_check and not estop_check():
            self.stop()
            return 0.0

        left = max(-100.0, min(100.0, speed_pct + steer_adjust_pct))
        right = max(-100.0, min(100.0, speed_pct - steer_adjust_pct))
        self.drive(left, right)
        self._sleep(max(0.0, duration_s))

        if estop_check and not estop_check():
            self.stop()
            return 0.0

        avg_pct = 0.5 * (left + right)
        dist = self.estimate_step_distance_mm(avg_pct, duration_s)
        self._total_distance_mm += dist
        return dist

    def move_forward_mm(
        self,
        distance_mm: float,
        speed_pct: float = 35.0,
        estop_check: Optional[Callable[[], bool]] = None,
    ) -> float:
        """
        Roll forward (or backward if negative) by an exact distance in millimeters,
        chunked into small 50ms slices so E-stop is checked continuously.
        """
        if abs(distance_mm) < 1.0 or speed_pct <= 0:
            self.stop()
            return 0.0

        direction = 1.0 if distance_mm >= 0 else -1.0
        mm_per_sec = self.speed_mm_per_sec_at_100pct * (abs(speed_pct) / 100.0)
        if mm_per_sec <= 1.0:
            self.stop()
            return 0.0

        total_time = abs(distance_mm) / mm_per_sec
        elapsed = 0.0
        slice_s = 0.05

        try:
            self.drive(direction * abs(speed_pct), direction * abs(speed_pct))
            while elapsed < total_time:
                if estop_check and not estop_check():
                    self.stop()
                    return direction * elapsed * mm_per_sec
                dt = min(slice_s, total_time - elapsed)
                self.drive(direction * abs(speed_pct), direction * abs(speed_pct))
                self._sleep(dt)
                elapsed += dt
        finally:
            self.stop()

        traveled = direction * elapsed * mm_per_sec
        self._total_distance_mm += abs(traveled)
        return round(traveled, 1)

    def turn_angle_deg(
        self,
        angle_deg: float,
        speed_pct: float = 45.0,
        estop_check: Optional[Callable[[], bool]] = None,
    ) -> float:
        """
        Execute an in-place pivot turn:
          angle_deg > 0 -> turn RIGHT (clockwise)
          angle_deg < 0 -> turn LEFT  (counter-clockwise)
        """
        if abs(angle_deg) < 1.0 or speed_pct <= 0:
            self.stop()
            return 0.0

        # Scale calibrated 90-deg duration linearly with angle and inversely with speed
        speed_scale = 50.0 / max(15.0, abs(speed_pct))
        total_time = self.turn_90_deg_sec_at_50pct * (abs(angle_deg) / 90.0) * speed_scale

        # Right turn = left wheel forward, right wheel reverse
        if angle_deg > 0:
            l_cmd, r_cmd = abs(speed_pct), -abs(speed_pct)
        else:
            l_cmd, r_cmd = -abs(speed_pct), abs(speed_pct)

        elapsed = 0.0
        slice_s = 0.05
        try:
            self.drive(l_cmd, r_cmd)
            while elapsed < total_time:
                if estop_check and not estop_check():
                    self.stop()
                    turned = angle_deg * (elapsed / max(1e-6, total_time))
                    self._heading_deg = (self._heading_deg + turned) % 360.0
                    return round(turned, 1)
                dt = min(slice_s, total_time - elapsed)
                self.drive(l_cmd, r_cmd)
                self._sleep(dt)
                elapsed += dt
        finally:
            self.stop()

        self._heading_deg = (self._heading_deg + angle_deg) % 360.0
        return round(angle_deg, 1)

    def close(self) -> None:
        """Safely stop motors and release hardware resources."""
        self.stop()
        if self._pwm_left is not None:
            try:
                self._pwm_left.stop()
            except Exception:
                pass
        if self._pwm_right is not None:
            try:
                self._pwm_right.stop()
            except Exception:
                pass
        if self._serial is not None:
            try:
                self._serial.close()
            except Exception:
                pass
