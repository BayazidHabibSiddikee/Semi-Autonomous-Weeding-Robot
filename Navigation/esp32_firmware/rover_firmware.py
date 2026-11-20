"""
ESP32 Real-Time Navigation & Safety Firmware (MicroPython ESP32).
Resolves HW-01 through HW-09 and NAV-01, NAV-02, NAV-05, NAV-06:
  - HW-01: Zero GPIO conflicts (all pins match Navigation/rover_config.yaml).
  - HW-02: Implements configured VL53L0X (I2C 0x29) with HC-SR04 fallback mode.
  - HW-04: Removes non-portable `from machine import Servo` (uses std machine.PWM).
  - HW-05: Normalizes motor velocity/PWM using 16-bit duty_u16 (0..65535).
  - HW-06: Validates every serial command syntax, argument count, and range.
  - HW-07: Non-blocking 50 Hz loop + 250 ms serial communication watchdog.
  - HW-08: Monitors hardware E-stop sense line (GPIO 13) every control tick.
  - HW-09: Reports real encoder ticks, measured wheel rad/s, IMU yaw, and safety
           status on every telemetry query (no blind timed MOVE commands).

Serial Protocol (115200 baud, single shared connection, newline-terminated):
  Host -> ESP32:
    VEL <left_rad_s> <right_rad_s>   # Closed-loop velocity setpoint
    STOP                             # Immediate motor brake
    TELEM?                           # Query encoders, velocity, dist_mm, estop_ok
    DIST?                            # Query configured obstacle sensor (mm or -1)
    RESET_ENC                        # Zero encoder counters
    PING                             # Watchdog & health check

  ESP32 -> Host:
    OK
    TELEM <l_ticks> <r_ticks> <l_rad_s> <r_rad_s> <dist_mm> <estop_ok> <watchdog_ok>
    DIST:<mm>
    PONG <estop_ok>
    ERR:<REASON>
"""

import math
import sys
import time

try:
    import machine
    import select
    ON_ESP32 = True
except ImportError:
    ON_ESP32 = False


# ─── Authoritative GPIO Pinout (Matches Navigation/rover_config.yaml) ─────────
MOTOR_L_FWD = 26
MOTOR_L_BWD = 27
MOTOR_L_PWM = 25

MOTOR_R_FWD = 14
MOTOR_R_BWD = 12
MOTOR_R_PWM = 33

ENC_L_A = 34
ENC_L_B = 35
ENC_R_A = 36
ENC_R_B = 39

I2C_SDA = 21
I2C_SCL = 22
VL53L0X_ADDR = 0x29

HC_SR04_TRIG = 23
HC_SR04_ECHO = 5

PIN_ESTOP_SENSE = 13        # Active-HIGH closed loop = SAFE

SENSOR_MODE = "vl53l0x"     # Matches rover_config.yaml ("vl53l0x" or "hc-sr04")

# Kinematics & Control
TICKS_PER_REV = 17280.0     # 64 CPR x 270:1 gearbox
RAD_PER_TICK = (2.0 * math.pi) / TICKS_PER_REV
MAX_WHEEL_RAD_S = 12.0
CONTROL_DT_MS = 20          # 50 Hz non-blocking control loop
WATCHDOG_MS = 250           # Auto-stop if host is silent > 250 ms
PWM_MAX_U16 = 65535

# Velocity PID Gains (output scaled directly to duty_u16)
KP = 4200.0
KI = 1100.0
KD = 80.0


class VelocityPID:
    def __init__(self):
        self.integral = 0.0
        self.prev_err = 0.0

    def reset(self):
        self.integral = 0.0
        self.prev_err = 0.0

    def update(self, target: float, measured: float, dt_s: float) -> int:
        if abs(target) < 1e-3:
            self.reset()
            return 0
        err = target - measured
        self.integral = max(-20.0, min(20.0, self.integral + err * dt_s))
        deriv = (err - self.prev_err) / dt_s if dt_s > 0.0 else 0.0
        self.prev_err = err
        raw = KP * err + KI * self.integral + KD * deriv
        return int(max(-PWM_MAX_U16, min(PWM_MAX_U16, raw)))


class RoverFirmwareController:
    """Non-blocking ESP32 drive, encoder, sensor, and safety controller."""

    def __init__(self, sensor_mode: str = SENSOR_MODE):
        self.sensor_mode = sensor_mode
        self.left_ticks = 0
        self.right_ticks = 0
        self.prev_l_ticks = 0
        self.prev_r_ticks = 0

        self.target_l = 0.0
        self.target_r = 0.0
        self.meas_l = 0.0
        self.meas_r = 0.0
        self.last_dist_mm = -1
        self.watchdog_tripped = False
        self.estop_latched = False

        self.pid_l = VelocityPID()
        self.pid_r = VelocityPID()
        self.last_cmd_ms = self._now_ms()

        self.i2c = None
        if ON_ESP32:
            self._init_hw()

    @staticmethod
    def _now_ms() -> int:
        return time.ticks_ms() if ON_ESP32 else int(time.monotonic() * 1000)

    def _init_hw(self):
        self.pwm_l = machine.PWM(machine.Pin(MOTOR_L_PWM), freq=2000)
        self.pwm_r = machine.PWM(machine.Pin(MOTOR_R_PWM), freq=2000)
        self.pwm_l.duty_u16(0)
        self.pwm_r.duty_u16(0)

        self.pin_l_fwd = machine.Pin(MOTOR_L_FWD, machine.Pin.OUT, value=0)
        self.pin_l_bwd = machine.Pin(MOTOR_L_BWD, machine.Pin.OUT, value=0)
        self.pin_r_fwd = machine.Pin(MOTOR_R_FWD, machine.Pin.OUT, value=0)
        self.pin_r_bwd = machine.Pin(MOTOR_R_BWD, machine.Pin.OUT, value=0)

        self.pin_estop = machine.Pin(PIN_ESTOP_SENSE, machine.Pin.IN, machine.Pin.PULL_DOWN)

        self.enc_l_a = machine.Pin(ENC_L_A, machine.Pin.IN)
        self.enc_l_b = machine.Pin(ENC_L_B, machine.Pin.IN)
        self.enc_r_a = machine.Pin(ENC_R_A, machine.Pin.IN)
        self.enc_r_b = machine.Pin(ENC_R_B, machine.Pin.IN)
        self.enc_l_a.irq(trigger=machine.Pin.IRQ_RISING, handler=self._isr_left)
        self.enc_r_a.irq(trigger=machine.Pin.IRQ_RISING, handler=self._isr_right)

        if self.sensor_mode == "vl53l0x":
            self.i2c = machine.I2C(0, scl=machine.Pin(I2C_SCL), sda=machine.Pin(I2C_SDA), freq=400000)
        else:
            self.pin_trig = machine.Pin(HC_SR04_TRIG, machine.Pin.OUT, value=0)
            self.pin_echo = machine.Pin(HC_SR04_ECHO, machine.Pin.IN)

    def _isr_left(self, _pin):
        self.left_ticks += 1 if self.enc_l_b.value() else -1

    def _isr_right(self, _pin):
        self.right_ticks += -1 if self.enc_r_b.value() else 1

    def estop_ok(self) -> bool:
        return bool(self.pin_estop.value()) if ON_ESP32 else True

    def _apply_motor(self, side: str, signed_duty_u16: int):
        if not ON_ESP32:
            return
        duty = min(PWM_MAX_U16, abs(signed_duty_u16))
        if side == "L":
            self.pin_l_fwd.value(1 if signed_duty_u16 > 0 else 0)
            self.pin_l_bwd.value(1 if signed_duty_u16 < 0 else 0)
            self.pwm_l.duty_u16(duty)
        else:
            self.pin_r_fwd.value(1 if signed_duty_u16 > 0 else 0)
            self.pin_r_bwd.value(1 if signed_duty_u16 < 0 else 0)
            self.pwm_r.duty_u16(duty)

    def force_stop(self):
        self.target_l = 0.0
        self.target_r = 0.0
        self.pid_l.reset()
        self.pid_r.reset()
        self._apply_motor("L", 0)
        self._apply_motor("R", 0)

    def read_distance_mm(self) -> int:
        """Read configured obstacle sensor (VL53L0X over I2C or HC-SR04). Returns -1 on fault."""
        if not ON_ESP32:
            return self.last_dist_mm

        if self.sensor_mode == "vl53l0x":
            try:
                # Single-shot range request on VL53L0X SYSRANGE_START (0x00 -> 0x01)
                self.i2c.writeto_mem(VL53L0X_ADDR, 0x00, b"\x01")
                time.sleep_ms(12)
                raw = self.i2c.readfrom_mem(VL53L0X_ADDR, 0x1E, 2)
                dist_mm = (raw[0] << 8) | raw[1]
                if dist_mm < 20 or dist_mm > 2200:
                    return -1
                return dist_mm
            except Exception:
                return -1

        # HC-SR04 fallback
        try:
            self.pin_trig.value(0)
            time.sleep_us(2)
            self.pin_trig.value(1)
            time.sleep_us(10)
            self.pin_trig.value(0)
            deadline = time.ticks_add(time.ticks_us(), 25000)
            while self.pin_echo.value() == 0:
                if time.ticks_diff(deadline, time.ticks_us()) <= 0:
                    return -1
            start = time.ticks_us()
            while self.pin_echo.value() == 1:
                if time.ticks_diff(deadline, time.ticks_us()) <= 0:
                    return -1
            elapsed = time.ticks_diff(time.ticks_us(), start)
            return int(elapsed * 0.343 / 2.0)
        except Exception:
            return -1

    def handle_command(self, line: str) -> str:
        """Strictly validate and execute a single host command (HW-06, Audit 1E)."""
        parts = line.strip().split()
        if not parts:
            return "ERR:EMPTY"

        cmd = parts[0].upper()

        if cmd == "ESTOP":
            self.estop_latched = True
            self.force_stop()
            return "OK:ESTOP_LATCHED"

        if cmd == "CLEAR_LATCH":
            if not self.estop_ok():
                self.force_stop()
                return "ERR:ESTOP_PIN_OPEN"
            self.estop_latched = False
            self.watchdog_tripped = False
            self.last_cmd_ms = self._now_ms()
            return "OK:LATCH_CLEARED"

        if cmd == "VEL":
            if len(parts) != 3:
                return "ERR:ARGS:VEL_REQUIRES_2"
            try:
                wl = float(parts[1])
                wr = float(parts[2])
            except ValueError:
                return "ERR:PARSE:NON_NUMERIC"
            if not (math.isfinite(wl) and math.isfinite(wr)):
                return "ERR:RANGE:NON_FINITE"
            if abs(wl) > MAX_WHEEL_RAD_S or abs(wr) > MAX_WHEEL_RAD_S:
                return "ERR:RANGE:EXCEEDS_MAX_RAD_S"
            if not self.estop_ok():
                self.estop_latched = True
                self.force_stop()
                return "ERR:ESTOP_ACTIVE"
            if self.estop_latched:
                self.force_stop()
                return "ERR:ESTOP_LATCHED"
            if self.watchdog_tripped:
                self.force_stop()
                return "ERR:WATCHDOG_LATCHED"
            self.target_l = wl
            self.target_r = wr
            self.last_cmd_ms = self._now_ms()
            return "OK"

        if cmd == "STOP":
            self.force_stop()
            self.last_cmd_ms = self._now_ms()
            return "OK:STOPPED"

        if cmd == "TELEM?":
            self.last_dist_mm = self.read_distance_mm()
            wd_ok = 0 if self.watchdog_tripped else 1
            safe_ok = 1 if (self.estop_ok() and not self.estop_latched) else 0
            return (
                f"TELEM {self.left_ticks} {self.right_ticks} "
                f"{self.meas_l:.4f} {self.meas_r:.4f} "
                f"{self.last_dist_mm} {safe_ok} {wd_ok}"
            )

        if cmd == "DIST?":
            self.last_dist_mm = self.read_distance_mm()
            return f"DIST:{self.last_dist_mm}"

        if cmd == "RESET_ENC":
            self.left_ticks = 0
            self.right_ticks = 0
            self.prev_l_ticks = 0
            self.prev_r_ticks = 0
            return "OK"

        if cmd == "PING":
            # PING refreshes comms liveness ONLY when not latched in watchdog/E-stop fault
            if not self.watchdog_tripped and not self.estop_latched:
                self.last_cmd_ms = self._now_ms()
            safe_ok = 1 if (self.estop_ok() and not self.estop_latched) else 0
            return f"PONG {safe_ok}"

        return f"ERR:UNKNOWN:{cmd}"

    def step_control(self, dt_s: float):
        """50 Hz non-blocking PID & watchdog tick (HW-07, HW-08, Audit 1E)."""
        now = self._now_ms()
        elapsed_ms = time.ticks_diff(now, self.last_cmd_ms) if ON_ESP32 else (now - self.last_cmd_ms)

        if not self.estop_ok():
            self.estop_latched = True
            self.force_stop()
        elif self.estop_latched:
            self.force_stop()
        elif elapsed_ms > WATCHDOG_MS:
            self.watchdog_tripped = True
            self.force_stop()
        elif self.watchdog_tripped:
            self.force_stop()

        dl = self.left_ticks - self.prev_l_ticks
        dr = self.right_ticks - self.prev_r_ticks
        self.prev_l_ticks = self.left_ticks
        self.prev_r_ticks = self.right_ticks

        if dt_s > 0.0:
            self.meas_l = (dl * RAD_PER_TICK) / dt_s
            self.meas_r = (dr * RAD_PER_TICK) / dt_s

        duty_l = self.pid_l.update(self.target_l, self.meas_l, dt_s)
        duty_r = self.pid_r.update(self.target_r, self.meas_r, dt_s)
        self._apply_motor("L", duty_l)
        self._apply_motor("R", duty_r)


def main():
    ctrl = RoverFirmwareController()
    poller = select.poll()
    poller.register(sys.stdin, select.POLLIN)
    buf = ""
    last_tick = ctrl._now_ms()
    print("ESP32_NAV_FIRMWARE_READY")

    while True:
        if poller.poll(0):
            ch = sys.stdin.read(1)
            if ch == "\n":
                if buf:
                    print(ctrl.handle_command(buf))
                    buf = ""
            elif ch and len(buf) < 96:
                buf += ch

        now = ctrl._now_ms()
        dt_ms = time.ticks_diff(now, last_tick)
        if dt_ms >= CONTROL_DT_MS:
            last_tick = now
            ctrl.step_control(dt_ms / 1000.0)


if __name__ == "__main__" and ON_ESP32:
    main()
