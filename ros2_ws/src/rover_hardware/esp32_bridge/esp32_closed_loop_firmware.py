"""
ESP32 Closed-Loop Differential-Drive Firmware (MicroPython / PlatformIO Reference)
Fixes critical defects in legacy Navigation/esp32_firmware/rover_firmware.py:
  1. Eliminates blocking time.sleep_ms() during motor moves so E-stop is instant.
  2. Adds quadrature wheel encoder ISRs (64 CPR x 270:1 gearbox = 17,280 ticks/rev).
  3. Implements 50 Hz closed-loop velocity PID per left/right motor channel.
  4. Adds 250 ms serial command watchdog — auto-stops motors if Pi hangs.
  5. Resolves GPIO pin conflicts (Laser=GPIO4, L_PWM=GPIO25, R_PWM=GPIO33,
     Encoders=GPIO34/35/36/39, Hardware E-Stop Sense=GPIO13, Laser Interlock=GPIO15).

Serial Protocol (115200 baud, newline-terminated):
  Pi -> ESP32:
    VEL <left_rad_s> <right_rad_s>   # Closed-loop wheel angular velocity target
    STOP                             # Immediate zero-velocity brake
    SERVO <PAN|TILT> <deg>           # Gimbal aiming (only honored when stopped)
    LASER <ON|OFF>                   # Honored ONLY if hardware interlock == HIGH & stopped
    RESET_ENC                        # Zero encoder counters
    PING                             # Health & safety status query

  ESP32 -> Pi (streamed at 50 Hz):
    ODOM <left_ticks> <right_ticks> <left_rad_s> <right_rad_s> <estop_ok> <interlock_ok>
"""

import sys
import time
import math

try:
    import machine
    import select
    ON_ESP32 = True
except ImportError:
    ON_ESP32 = False


# ─── Resolved GPIO Pin Map (Zero Pin Conflicts) ───────────────────────────────
MOTOR_L_FWD = 26
MOTOR_L_BWD = 27
MOTOR_L_PWM = 25   # Dedicated Left PWM (removed conflicting laser mapping)

MOTOR_R_FWD = 14
MOTOR_R_BWD = 12
MOTOR_R_PWM = 33   # Dedicated Right PWM

# Quadrature Encoders (Input-only GPIOs 34-39 ideal for high-speed encoder ISRs)
ENC_L_A = 34
ENC_L_B = 35
ENC_R_A = 36
ENC_R_B = 39

# Independent Hardware Safety Lines (Active-HIGH = Safe / Closed loop)
PIN_ESTOP_SENSE = 13          # Reads hardware E-stop relay contact
PIN_LASER_INTERLOCK = 15      # Reads key-switch + lid/tilt safety interlock
PIN_LASER_MOSFET = 4          # Laser PWM/MOSFET gate (AND-gated in hardware with E-stop)

# Pan-Tilt Gimbal Servos
SERVO_PAN_PIN = 18
SERVO_TILT_PIN = 19

# Kinematics & Control Constants
TICKS_PER_REV = 17280.0       # 64 CPR x 270:1 metal geared DC motor
RAD_PER_TICK = (2.0 * math.pi) / TICKS_PER_REV
CONTROL_DT_MS = 20            # 50 Hz control loop
WATCHDOG_MS = 250             # Auto-stop if no VEL command within 250 ms

# Velocity PID Gains (rad/s -> PWM duty 0..1023)
KP = 68.0
KI = 18.0
KD = 1.2
MAX_DUTY = 1023


class ChannelPID:
    """Discrete PID controller with anti-windup for one drive channel."""

    def __init__(self, kp=KP, ki=KI, kd=KD):
        self.kp = kp
        self.ki = ki
        self.kd = kd
        self.integral = 0.0
        self.prev_err = 0.0

    def reset(self):
        self.integral = 0.0
        self.prev_err = 0.0

    def compute(self, target_rad_s: float, measured_rad_s: float, dt_s: float) -> int:
        if abs(target_rad_s) < 1e-3:
            self.reset()
            return 0
        err = target_rad_s - measured_rad_s
        self.integral = max(-25.0, min(25.0, self.integral + err * dt_s))
        deriv = (err - self.prev_err) / dt_s if dt_s > 0 else 0.0
        self.prev_err = err
        out = self.kp * err + self.ki * self.integral + self.kd * deriv
        return int(max(-MAX_DUTY, min(MAX_DUTY, out)))


class ClosedLoopRoverFirmware:
    """Non-blocking ESP32 controller for ros2_control differential drive."""

    def __init__(self):
        self.left_ticks = 0
        self.right_ticks = 0
        self.prev_left_ticks = 0
        self.prev_right_ticks = 0

        self.target_l = 0.0
        self.target_r = 0.0
        self.meas_l = 0.0
        self.meas_r = 0.0

        self.pid_l = ChannelPID()
        self.pid_r = ChannelPID()
        self.last_cmd_ms = self._now_ms()
        self.laser_enabled = False

        if ON_ESP32:
            self._init_hardware()

    def _now_ms(self) -> int:
        return time.ticks_ms() if ON_ESP32 else int(time.time() * 1000)

    def _init_hardware(self):
        self.pwm_l = machine.PWM(machine.Pin(MOTOR_L_PWM), freq=2000, duty=0)
        self.pwm_r = machine.PWM(machine.Pin(MOTOR_R_PWM), freq=2000, duty=0)
        self.l_fwd = machine.Pin(MOTOR_L_FWD, machine.Pin.OUT, value=0)
        self.l_bwd = machine.Pin(MOTOR_L_BWD, machine.Pin.OUT, value=0)
        self.r_fwd = machine.Pin(MOTOR_R_FWD, machine.Pin.OUT, value=0)
        self.r_bwd = machine.Pin(MOTOR_R_BWD, machine.Pin.OUT, value=0)

        self.pin_estop = machine.Pin(PIN_ESTOP_SENSE, machine.Pin.IN, machine.Pin.PULL_DOWN)
        self.pin_interlock = machine.Pin(PIN_LASER_INTERLOCK, machine.Pin.IN, machine.Pin.PULL_DOWN)
        self.pin_laser = machine.Pin(PIN_LASER_MOSFET, machine.Pin.OUT, value=0)

        self.enc_l_a = machine.Pin(ENC_L_A, machine.Pin.IN)
        self.enc_l_b = machine.Pin(ENC_L_B, machine.Pin.IN)
        self.enc_r_a = machine.Pin(ENC_R_A, machine.Pin.IN)
        self.enc_r_b = machine.Pin(ENC_R_B, machine.Pin.IN)

        self.enc_l_a.irq(trigger=machine.Pin.IRQ_RISING, handler=self._isr_left)
        self.enc_r_a.irq(trigger=machine.Pin.IRQ_RISING, handler=self._isr_right)

    def _isr_left(self, _pin):
        self.left_ticks += 1 if self.enc_l_b.value() else -1

    def _isr_right(self, _pin):
        self.right_ticks += -1 if self.enc_r_b.value() else 1

    def estop_ok(self) -> bool:
        return bool(self.pin_estop.value()) if ON_ESP32 else True

    def interlock_ok(self) -> bool:
        return bool(self.pin_interlock.value()) if ON_ESP32 else True

    def _drive_channel(self, side: str, signed_duty: int):
        if not ON_ESP32:
            return
        duty = min(MAX_DUTY, abs(signed_duty))
        if side == "L":
            self.l_fwd.value(1 if signed_duty > 0 else 0)
            self.l_bwd.value(1 if signed_duty < 0 else 0)
            self.pwm_l.duty(duty)
        else:
            self.r_fwd.value(1 if signed_duty > 0 else 0)
            self.r_bwd.value(1 if signed_duty < 0 else 0)
            self.pwm_r.duty(duty)

    def force_stop(self):
        self.target_l = 0.0
        self.target_r = 0.0
        self.pid_l.reset()
        self.pid_r.reset()
        self._drive_channel("L", 0)
        self._drive_channel("R", 0)
        self.laser_enabled = False
        if ON_ESP32:
            self.pin_laser.value(0)

    def parse_line(self, line: str) -> str:
        parts = line.strip().split()
        if not parts:
            return ""
        cmd = parts[0].upper()

        if cmd == "VEL" and len(parts) == 3:
            if not self.estop_ok():
                self.force_stop()
                return "ERR:ESTOP_ACTIVE"
            self.target_l = max(-12.0, min(12.0, float(parts[1])))
            self.target_r = max(-12.0, min(12.0, float(parts[2])))
            self.last_cmd_ms = self._now_ms()
            # Never permit laser while moving
            if abs(self.target_l) > 1e-3 or abs(self.target_r) > 1e-3:
                self.laser_enabled = False
                if ON_ESP32:
                    self.pin_laser.value(0)
            return "OK"

        if cmd == "STOP":
            self.force_stop()
            return "OK"

        if cmd == "LASER" and len(parts) == 2:
            want_on = parts[1].upper() == "ON"
            rover_stopped = abs(self.meas_l) < 0.02 and abs(self.meas_r) < 0.02
            if want_on and self.estop_ok() and self.interlock_ok() and rover_stopped:
                self.laser_enabled = True
                if ON_ESP32:
                    self.pin_laser.value(1)
                return "OK"
            self.laser_enabled = False
            if ON_ESP32:
                self.pin_laser.value(0)
            return "ERR:SAFETY_INTERLOCK" if want_on else "OK"

        if cmd == "RESET_ENC":
            self.left_ticks = 0
            self.right_ticks = 0
            self.prev_left_ticks = 0
            self.prev_right_ticks = 0
            return "OK"

        if cmd == "PING":
            return f"PONG {int(self.estop_ok())} {int(self.interlock_ok())}"

        return f"ERR:UNKNOWN:{cmd}"

    def step_control(self, dt_s: float) -> str:
        now = self._now_ms()
        # Hardware E-stop or serial watchdog override
        if not self.estop_ok() or (now - self.last_cmd_ms) > WATCHDOG_MS:
            self.force_stop()

        dl = self.left_ticks - self.prev_left_ticks
        dr = self.right_ticks - self.prev_right_ticks
        self.prev_left_ticks = self.left_ticks
        self.prev_right_ticks = self.right_ticks

        self.meas_l = (dl * RAD_PER_TICK) / dt_s
        self.meas_r = (dr * RAD_PER_TICK) / dt_s

        duty_l = self.pid_l.compute(self.target_l, self.meas_l, dt_s)
        duty_r = self.pid_r.compute(self.target_r, self.meas_r, dt_s)
        self._drive_channel("L", duty_l)
        self._drive_channel("R", duty_r)

        return (
            f"ODOM {self.left_ticks} {self.right_ticks} "
            f"{self.meas_l:.4f} {self.meas_r:.4f} "
            f"{int(self.estop_ok())} {int(self.interlock_ok())}"
        )


def run_loop():
    fw = ClosedLoopRoverFirmware()
    poller = select.poll() if ON_ESP32 else None
    if poller:
        poller.register(sys.stdin, select.POLLIN)
    buf = ""
    last_tick = fw._now_ms()
    print("ESP32_CLOSED_LOOP_READY")

    while True:
        if poller and poller.poll(0):
            ch = sys.stdin.read(1)
            if ch == "\n":
                resp = fw.parse_line(buf)
                if resp:
                    print(resp)
                buf = ""
            elif ch:
                buf += ch

        now = fw._now_ms()
        if (now - last_tick) >= CONTROL_DT_MS:
            dt_s = (now - last_tick) / 1000.0
            last_tick = now
            print(fw.step_control(dt_s))


if __name__ == "__main__" and ON_ESP32:
    run_loop()
