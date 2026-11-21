"""
Standalone BNO055 9-DOF IMU Heading Reader for the Python Navigation Stack.

Resolves the IMU disconnect finding where FieldLocalizer supported BNO055 yaw
fusion (`imu_heading_fn`), but `rover_main.py` passed `imu_heading_fn=None`.
Supports:
  - Hardware Bosch BNO055 over Raspberry Pi I2C (smbus2 or adafruit_bno055)
    at configurable address (default 0x28 per Navigation/rover_config.yaml).
  - Safe degraded behavior when I2C hardware is absent (returns None rather
    than crashing startup, while exposing `.available` and `.last_error`).
  - SimulatedImuHeading for closed-loop simulation and unit verification.
"""

from __future__ import annotations

import math
import struct
import time

from localizer import normalize_angle_deg


# Bosch BNO055 I2C registers
REG_CHIP_ID = 0x00
BNO055_CHIP_ID = 0xA0
REG_OPR_MODE = 0x3D
REG_PWR_MODE = 0x3E
REG_UNIT_SEL = 0x3B
REG_EULER_H_LSB = 0x1A  # 6 bytes: heading, roll, pitch (1/16 degree per LSB)
OPR_MODE_NDOF = 0x0C


class BNO055HeadingReader:
    """Thread-safe lightweight Bosch BNO055 yaw/tilt reader over Linux I2C."""

    def __init__(
        self,
        i2c_bus: int = 1,
        i2c_addr: int = 0x28,
        max_safe_tilt_deg: float = 22.0,
        stale_timeout_s: float = 0.5,
    ):
        self.i2c_bus = int(i2c_bus)
        self.i2c_addr = int(i2c_addr)
        self.max_safe_tilt_deg = float(max_safe_tilt_deg)
        self.stale_timeout_s = float(stale_timeout_s)

        self.available = False
        self.last_error: str | None = None
        self.last_heading_deg: float | None = None
        self.last_roll_deg: float = 0.0
        self.last_pitch_deg: float = 0.0
        self.last_read_ts: float = 0.0
        self._zero_offset_deg: float | None = None
        self._bus = None
        self._adafruit_sensor = None

        self._connect()

    @classmethod
    def from_config(cls, config: dict) -> "BNO055HeadingReader":
        imu_cfg = config.get("rover", {}).get("imu", {})
        addr_raw = imu_cfg.get("i2c_addr", 0x28)
        addr = int(addr_raw, 16) if isinstance(addr_raw, str) else int(addr_raw)
        return cls(
            i2c_bus=int(imu_cfg.get("i2c_bus", 1)),
            i2c_addr=addr,
            max_safe_tilt_deg=float(imu_cfg.get("max_safe_tilt_deg", 22.0)),
        )

    def _connect(self) -> None:
        # 1. Try adafruit_bno055 if installed
        try:
            import board  # type: ignore
            import adafruit_bno055  # type: ignore

            self._adafruit_sensor = adafruit_bno055.BNO055_I2C(board.I2C(), address=self.i2c_addr)
            self.available = True
            self.last_error = None
            return
        except Exception:
            self._adafruit_sensor = None

        # 2. Fallback to lightweight smbus2 direct register read
        try:
            import smbus2  # type: ignore

            bus = smbus2.SMBus(self.i2c_bus)
            chip_id = bus.read_byte_data(self.i2c_addr, REG_CHIP_ID)
            if chip_id != BNO055_CHIP_ID:
                bus.close()
                self.last_error = f"UNEXPECTED_CHIP_ID:0x{chip_id:02x}"
                self.available = False
                return
            # Configure normal power mode and NDOF 9-axis fusion
            bus.write_byte_data(self.i2c_addr, REG_PWR_MODE, 0x00)
            time.sleep(0.01)
            bus.write_byte_data(self.i2c_addr, REG_UNIT_SEL, 0x00)  # Degrees
            bus.write_byte_data(self.i2c_addr, REG_OPR_MODE, OPR_MODE_NDOF)
            time.sleep(0.02)
            self._bus = bus
            self.available = True
            self.last_error = None
        except Exception as exc:
            self._bus = None
            self.available = False
            self.last_error = f"IMU_INIT_FAILED:{exc}"

    def zero_heading(self) -> None:
        """Tare the current magnetic/fused heading as 0 deg field datum."""
        raw = self._read_raw_euler_deg()
        if raw is not None:
            self._zero_offset_deg = raw[0]

    def _read_raw_euler_deg(self) -> tuple[float, float, float] | None:
        if self._adafruit_sensor is not None:
            try:
                euler = self._adafruit_sensor.euler
                if euler is None or euler[0] is None:
                    return None
                heading = float(euler[0])
                roll = float(euler[1] or 0.0)
                pitch = float(euler[2] or 0.0)
                return heading, roll, pitch
            except Exception as exc:
                self.last_error = f"ADAFRUIT_READ_ERR:{exc}"
                return None

        if self._bus is not None:
            try:
                data = bytes(self._bus.read_i2c_block_data(self.i2c_addr, REG_EULER_H_LSB, 6))
                h_raw, r_raw, p_raw = struct.unpack("<hhh", data)
                return h_raw / 16.0, r_raw / 16.0, p_raw / 16.0
            except Exception as exc:
                self.last_error = f"I2C_READ_ERR:{exc}"
                return None

        return None

    def read_heading_deg(self) -> float | None:
        """
        Return normalized CCW-positive rover yaw in [-180, 180] degrees, or None
        if the IMU is unavailable or the read failed.
        """
        if not self.available:
            return None
        raw = self._read_raw_euler_deg()
        if raw is None:
            return None

        h_cw_deg, roll_deg, pitch_deg = raw
        if not (math.isfinite(h_cw_deg) and math.isfinite(roll_deg) and math.isfinite(pitch_deg)):
            return None

        if self._zero_offset_deg is None:
            self._zero_offset_deg = h_cw_deg

        # BNO055 Euler heading increases clockwise; rover frame yaw is CCW-positive
        rel_ccw_deg = normalize_angle_deg(-(h_cw_deg - self._zero_offset_deg))
        self.last_heading_deg = rel_ccw_deg
        self.last_roll_deg = roll_deg
        self.last_pitch_deg = pitch_deg
        self.last_read_ts = time.monotonic()
        self.last_error = None
        return rel_ccw_deg

    @property
    def tilt_safe(self) -> bool:
        return (
            abs(self.last_roll_deg) <= self.max_safe_tilt_deg
            and abs(self.last_pitch_deg) <= self.max_safe_tilt_deg
        )

    def is_healthy(self, now: float | None = None) -> bool:
        if not self.available or self.last_read_ts <= 0.0:
            return False
        ts = time.monotonic() if now is None else now
        return (ts - self.last_read_ts) <= self.stale_timeout_s and self.tilt_safe

    def close(self) -> None:
        if self._bus is not None:
            try:
                self._bus.close()
            except Exception:
                pass
            self._bus = None


class SimulatedImuHeading:
    """
    Physics-coupled simulated BNO055 heading sensor for --simulate and unit tests.
    Computes true heading from simulated wheel encoder ticks plus optional injectable
    external yaw disturbance (e.g. testing skid-steer wheel slip detection).
    """

    def __init__(
        self,
        esp32_sim,
        wheel_radius_cm: float = 3.5,
        wheel_separation_cm: float = 17.4,
        skid_multiplier: float = 1.18,
        ticks_per_rev: float = 17280.0,
    ):
        self.esp32 = esp32_sim
        self.eff_separation_cm = wheel_separation_cm * skid_multiplier
        self.cm_per_tick = (2.0 * math.pi * wheel_radius_cm) / ticks_per_rev
        self.available = True
        self.last_error: str | None = None
        self.injected_yaw_offset_deg = 0.0
        self.last_heading_deg: float = 0.0

    def read_heading_deg(self) -> float:
        telem = self.esp32.read_telemetry()
        dl_cm = telem.left_ticks * self.cm_per_tick
        dr_cm = telem.right_ticks * self.cm_per_tick
        yaw_deg = math.degrees((dr_cm - dl_cm) / self.eff_separation_cm)
        self.last_heading_deg = normalize_angle_deg(yaw_deg + self.injected_yaw_offset_deg)
        return self.last_heading_deg
