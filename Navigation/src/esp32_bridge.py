"""
Single Shared Thread-Safe Serial Bridge between Raspberry Pi 5 and ESP32.
Fixes NAV-06 (eliminates dual /dev/ttyUSB0 port opening between ESP32Bridge and
RoverMotors), HW-06 (command validation), and HW-07 (comm health tracking).
"""

import math
import threading
import time
from dataclasses import dataclass


@dataclass
class Esp32Telemetry:
    left_ticks: int
    right_ticks: int
    left_rad_s: float
    right_rad_s: float
    distance_mm: int
    estop_ok: bool
    watchdog_ok: bool
    valid: bool = True


@dataclass
class StopAckResult:
    """Verified stop acknowledgement from ESP32 (Audit 1E: never treats SIM/NO_ACK/UART_ERR as verified HW stop)."""
    verified: bool
    response: str
    simulated: bool = False
    estop_latched: bool = False


class ESP32Bridge:
    """
    Authoritative singleton-style shared serial bus to the ESP32.
    All navigation subsystems (RoverMotors, ObstacleSensor, SafetyWatchdog) MUST
    share one ESP32Bridge instance rather than opening /dev/ttyUSB0 independently.
    """

    def __init__(self, port: str = "/dev/ttyUSB0", baudrate: int = 115200, timeout: float = 0.5):
        self.port = port
        self.baudrate = baudrate
        self.timeout = timeout
        self.serial = None
        self.connected = False
        self._lock = threading.Lock()
        self.last_rx_time = 0.0
        self.consecutive_errors = 0
        self.last_telemetry: Esp32Telemetry | None = None

    @staticmethod
    def _candidate_usb_ports(preferred_port: str) -> list[str]:
        import os
        import re

        candidates: list[str] = []
        if preferred_port:
            candidates.append(preferred_port)
        if os.path.isdir("/dev"):
            pattern = re.compile(r"^(ttyUSB\d+|ttyACM\d+|cu\.usb\S+|cu\.SLAB\S+|cu\.wchusb\S+)$")
            try:
                for entry in sorted(os.listdir("/dev")):
                    if pattern.match(entry):
                        full = f"/dev/{entry}"
                        if full not in candidates:
                            candidates.append(full)
            except OSError:
                pass
        return candidates

    def connect(self) -> bool:
        try:
            import serial
        except ImportError:
            self.connected = False
            print("[ESP32Bridge] pyserial not installed; ESP32 USB bridge remains disconnected.")
            return False
        with self._lock:
            if self.connected and self.serial and self.serial.is_open:
                return True
            last_exc: Exception | None = None
            for candidate_port in self._candidate_usb_ports(self.port):
                try:
                    self.serial = serial.Serial(candidate_port, self.baudrate, timeout=self.timeout)
                    time.sleep(1.5)
                    self.serial.reset_input_buffer()
                    self.port = candidate_port
                    self.connected = True
                    resp = self._send_unlocked("PING")
                    if not resp.startswith("PONG"):
                        raise RuntimeError(f"Unexpected ESP32 handshake on {candidate_port}: {resp!r}")
                    # Inspect immediate telemetry so latch state (estop_ok / watchdog_ok) is known
                    # right after handshake without ever silently clearing an emergency latch.
                    telem_raw = self._send_unlocked("TELEM?")
                    self.last_telemetry = self._parse_telemetry(telem_raw)
                    self.consecutive_errors = 0
                    return True
                except Exception as exc:
                    last_exc = exc
                    if self.serial and self.serial.is_open:
                        try:
                            self.serial.close()
                        except Exception:
                            pass
                    self.serial = None
                    self.connected = False
            print(f"[ESP32Bridge] Connection failed on {self.port}: {last_exc}")
            return False

    def disconnect(self):
        with self._lock:
            if self.serial and self.serial.is_open:
                try:
                    self._send_unlocked("STOP")
                except Exception:
                    pass
                self.serial.close()
            self.connected = False

    def _send_unlocked(self, cmd: str) -> str:
        if not self.connected or self.serial is None:
            raise RuntimeError("ESP32 not connected")
        clean = cmd.strip()
        if not clean or "\n" in clean or "\r" in clean:
            raise ValueError(f"Invalid command frame: {cmd!r}")
        self.serial.write(f"{clean}\n".encode("ascii"))
        self.serial.flush()
        raw = self.serial.readline().decode("ascii", errors="ignore").strip()
        if not raw:
            self.consecutive_errors += 1
            return "ERR:TIMEOUT"
        self.last_rx_time = time.monotonic()
        self.consecutive_errors = 0
        return raw

    def send(self, cmd: str) -> str:
        with self._lock:
            return self._send_unlocked(cmd)

    def send_velocity(self, left_rad_s: float, right_rad_s: float) -> tuple[bool, str]:
        if not (math.isfinite(left_rad_s) and math.isfinite(right_rad_s)):
            return False, "ERR:NON_FINITE"
        resp = self.send(f"VEL {left_rad_s:.4f} {right_rad_s:.4f}")
        return resp == "OK", resp

    def send_stop(self) -> bool:
        try:
            resp = self.send("STOP")
            return resp in ("OK", "OK:STOPPED")
        except Exception:
            return False

    def send_emergency_stop(self) -> StopAckResult:
        """Issue latching hardware ESTOP over UART and verify strict firmware acknowledgement (Audit 1E)."""
        if not self.connected or self.serial is None:
            return StopAckResult(verified=False, response="UART_ERR:DISCONNECTED", simulated=False, estop_latched=False)
        try:
            resp = self.send("ESTOP")
        except Exception as exc:
            return StopAckResult(verified=False, response=f"UART_ERR:{exc}", simulated=False, estop_latched=False)

        if resp in ("OK:ESTOP_LATCHED", "OK:STOPPED"):
            return StopAckResult(verified=True, response=resp, simulated=False, estop_latched=True)
        return StopAckResult(verified=False, response=resp or "NO_ACK", simulated=False, estop_latched=False)

    def clear_latch(self) -> tuple[bool, str]:
        try:
            resp = self.send("CLEAR_LATCH")
            return resp == "OK:LATCH_CLEARED", resp
        except Exception as exc:
            return False, f"UART_ERR:{exc}"

    def recover_watchdog_latch(self, operator_confirmed: bool = False) -> tuple[bool, str]:
        """
        Explicit operator-authorized recovery procedure for ESP32 watchdog/E-stop latches.
        Never clears a latch silently; verifies physical GPIO 13 E-stop loop via firmware
        CLEAR_LATCH response and confirms healthy TELEM? afterwards.
        """
        if not operator_confirmed:
            return False, "ERR:OPERATOR_CONFIRMATION_REQUIRED"
        if not self.connected:
            return False, "ERR:DISCONNECTED"
        ok, resp = self.clear_latch()
        if not ok:
            return False, resp
        telem = self.read_telemetry()
        if not telem.valid:
            return False, "ERR:TELEM_INVALID_AFTER_CLEAR"
        if not telem.estop_ok:
            return False, "ERR:PHYSICAL_ESTOP_OPEN"
        if not telem.watchdog_ok:
            return False, "ERR:WATCHDOG_STILL_LATCHED"
        return True, "OK:LATCH_CLEARED"

    def reset_encoders(self) -> bool:
        return self.send("RESET_ENC") == "OK"

    @staticmethod
    def _parse_telemetry(resp: str) -> Esp32Telemetry:
        if not resp.startswith("TELEM "):
            return Esp32Telemetry(0, 0, 0.0, 0.0, -1, False, False, valid=False)
        parts = resp.split()
        if len(parts) != 8:
            return Esp32Telemetry(0, 0, 0.0, 0.0, -1, False, False, valid=False)
        try:
            return Esp32Telemetry(
                left_ticks=int(parts[1]),
                right_ticks=int(parts[2]),
                left_rad_s=float(parts[3]),
                right_rad_s=float(parts[4]),
                distance_mm=int(parts[5]),
                estop_ok=(parts[6] == "1"),
                watchdog_ok=(parts[7] == "1"),
                valid=True,
            )
        except ValueError:
            return Esp32Telemetry(0, 0, 0.0, 0.0, -1, False, False, valid=False)

    def read_telemetry(self) -> Esp32Telemetry:
        resp = self.send("TELEM?")
        telem = self._parse_telemetry(resp)
        self.last_telemetry = telem
        return telem

    def read_distance_mm(self) -> int:
        resp = self.send("DIST?")
        if resp.startswith("DIST:"):
            try:
                return int(resp.split(":")[1])
            except ValueError:
                return -1
        return -1


class ESP32Simulator:
    """
    Physics-backed ESP32 bridge simulator for unit tests and virtual field runs.
    Integrates closed-loop velocity setpoints into realistic quadrature encoder
    ticks, supports fault injection (sensor drop, E-stop, wheel slip).
    """

    def __init__(self, ticks_per_rev: float = 17280.0):
        self.connected = True
        self.ticks_per_rev = ticks_per_rev
        self.rad_per_tick = (2.0 * math.pi) / ticks_per_rev
        self.left_ticks = 0
        self.right_ticks = 0
        self.left_rad_s = 0.0
        self.right_rad_s = 0.0
        self.distance_mm = 900
        self.estop_ok = True
        self.watchdog_ok = True
        self._lock = threading.Lock()
        self.slip_factor_l = 1.0
        self.slip_factor_r = 1.0

    def connect(self) -> bool:
        self.connected = True
        return True

    def disconnect(self):
        self.send_stop()
        self.connected = False

    def step_physics(self, dt_s: float):
        """Advance simulated wheel encoders by dt_s seconds."""
        with self._lock:
            if not self.estop_ok:
                self.left_rad_s = 0.0
                self.right_rad_s = 0.0
                return
            dl_rad = self.left_rad_s * self.slip_factor_l * dt_s
            dr_rad = self.right_rad_s * self.slip_factor_r * dt_s
            self.left_ticks += int(round(dl_rad / self.rad_per_tick))
            self.right_ticks += int(round(dr_rad / self.rad_per_tick))

    def send(self, cmd: str) -> str:
        parts = cmd.strip().split()
        if not parts:
            return "ERR:EMPTY"
        action = parts[0].upper()
        if action == "PING":
            return f"PONG {int(self.estop_ok)}"
        if action == "STOP":
            self.left_rad_s = 0.0
            self.right_rad_s = 0.0
            return "OK:STOPPED"
        if action == "ESTOP":
            self.left_rad_s = 0.0
            self.right_rad_s = 0.0
            self.estop_ok = False
            return "OK:ESTOP_LATCHED"
        if action == "CLEAR_LATCH":
            self.estop_ok = True
            self.watchdog_ok = True
            return "OK:LATCH_CLEARED"
        if action == "RESET_ENC":
            self.left_ticks = 0
            self.right_ticks = 0
            return "OK"
        if action == "DIST?":
            return f"DIST:{self.distance_mm}"
        if action == "VEL" and len(parts) == 3:
            if not self.estop_ok:
                return "ERR:ESTOP_LATCHED"
            self.left_rad_s = float(parts[1])
            self.right_rad_s = float(parts[2])
            return "OK"
        return "ERR:UNKNOWN"

    def send_velocity(self, left_rad_s: float, right_rad_s: float) -> tuple[bool, str]:
        resp = self.send(f"VEL {left_rad_s:.4f} {right_rad_s:.4f}")
        return resp == "OK", resp

    def send_stop(self) -> bool:
        return self.send("STOP") in ("OK", "OK:STOPPED")

    def send_emergency_stop(self) -> StopAckResult:
        if not self.connected:
            return StopAckResult(verified=False, response="NO_ACK", simulated=True, estop_latched=False)
        resp = self.send("ESTOP")
        return StopAckResult(
            verified=(resp == "OK:ESTOP_LATCHED"),
            response=resp,
            simulated=True,
            estop_latched=(resp == "OK:ESTOP_LATCHED"),
        )

    def clear_latch(self) -> tuple[bool, str]:
        resp = self.send("CLEAR_LATCH")
        return resp == "OK:LATCH_CLEARED", resp

    def recover_watchdog_latch(self, operator_confirmed: bool = False) -> tuple[bool, str]:
        if not operator_confirmed:
            return False, "ERR:OPERATOR_CONFIRMATION_REQUIRED"
        if not self.connected:
            return False, "ERR:DISCONNECTED"
        return self.clear_latch()

    def reset_encoders(self) -> bool:
        return self.send("RESET_ENC") == "OK"

    def read_telemetry(self) -> Esp32Telemetry:
        with self._lock:
            return Esp32Telemetry(
                left_ticks=self.left_ticks,
                right_ticks=self.right_ticks,
                left_rad_s=self.left_rad_s,
                right_rad_s=self.right_rad_s,
                distance_mm=self.distance_mm,
                estop_ok=self.estop_ok,
                watchdog_ok=self.watchdog_ok,
                valid=True,
            )

    def read_distance_mm(self) -> int:
        return self.distance_mm
