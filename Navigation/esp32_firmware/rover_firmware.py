"""
ESP32 MicroPython Firmware for the Semi-Autonomous Weeding Robot.

Fixes & Hardware Architecture:
  - Uses stock MicroPython machine.PWM (50Hz) for the MG996R cylinder turret
    (removes non-existent `from machine import Servo`).
  - Parses the exact JSON line protocol sent by Navigation/src/pi_server.py:
      {"drive": 0|45|90|180|270|315|"STOP", "turret": -35.0..+35.0, "r1_grinder": 0|1, "r2_flame": 0|1}
  - Supports 8-Way Rover Drive:
      0° (Fwd), 45° (Steer Right), 315° (Steer Left),
      90° (U-Turn Pivot Right), 270° (U-Turn Pivot Left), 180° (Rev), "STOP"
  - Drives Dual Relay Board (fail-closed OFF on boot & fault):
      Relay 1 (GPIO 16): Grinder Motor
      Relay 2 (GPIO 17): Thermal Flame Valve
  - Hardware Watchdog (1500ms):
      If Pi stops sending serial frames or link drops, motors brake and BOTH relays cut OFF automatically.
  - Non-blocking serial poll via select.poll() + Hardware E-STOP pin (GPIO 34, active-LOW).
"""

import json
import select
import sys
import time
import machine

# ─── Pin Definitions (Conflict-Free ESP32 DevKit v1) ───────
# L298N Dual H-Bridge Drive Motors
MOTOR_L_FWD = 26
MOTOR_L_BWD = 27
MOTOR_R_FWD = 14
MOTOR_R_BWD = 12
MOTOR_L_EN = 25   # PWM
MOTOR_R_EN = 33   # PWM

# Cylinder Turret MG996R Sector Gear (-35° to +35°, centered at 90° mechanical)
TURRET_SERVO_PIN = 18

# Dual Relay Board (active HIGH by default; set RELAY_ACTIVE_LOW = True for opto-isolated low-trigger boards)
RELAY_1_GRINDER_PIN = 16
RELAY_2_FLAME_PIN = 17
RELAY_ACTIVE_LOW = False

# Hardware E-STOP Switch (NC switch to GND -> HIGH when pressed/open triggers immediate cut)
HW_ESTOP_PIN = 34

# Safety Watchdog Timeout (ms)
WATCHDOG_MS = 1500

# ─── Hardware Initialization (Fail-Safe OFF) ───────────────
pwm_l = machine.PWM(machine.Pin(MOTOR_L_EN), freq=1000)
pwm_r = machine.PWM(machine.Pin(MOTOR_R_EN), freq=1000)
pin_l_fwd = machine.Pin(MOTOR_L_FWD, machine.Pin.OUT, value=0)
pin_l_bwd = machine.Pin(MOTOR_L_BWD, machine.Pin.OUT, value=0)
pin_r_fwd = machine.Pin(MOTOR_R_FWD, machine.Pin.OUT, value=0)
pin_r_bwd = machine.Pin(MOTOR_R_BWD, machine.Pin.OUT, value=0)

# Stock MicroPython 50Hz PWM Servo Driver (500us..2500us -> 0..180 deg)
turret_pwm = machine.PWM(machine.Pin(TURRET_SERVO_PIN), freq=50)

pin_relay_grinder = machine.Pin(RELAY_1_GRINDER_PIN, machine.Pin.OUT)
pin_relay_flame = machine.Pin(RELAY_2_FLAME_PIN, machine.Pin.OUT)
pin_hw_estop = machine.Pin(HW_ESTOP_PIN, machine.Pin.IN)


def _set_motor_pwm(pwm_obj, duty_0_to_1023):
    duty_clamped = max(0, min(1023, int(duty_0_to_1023)))
    if hasattr(pwm_obj, "duty_u16"):
        pwm_obj.duty_u16(int(duty_clamped * 64))
    else:
        pwm_obj.duty(duty_clamped)


def set_turret_deg(offset_deg):
    """Map turret offset (-35..+35 deg) to mechanical servo angle (55..125 deg) at 50Hz PWM."""
    clamped = max(-35.0, min(35.0, float(offset_deg)))
    mech_angle = 90.0 + clamped  # 55..125 deg
    pulse_us = 500.0 + (mech_angle / 180.0) * 2000.0
    duty_u16 = int((pulse_us / 20000.0) * 65535.0)
    if hasattr(turret_pwm, "duty_u16"):
        turret_pwm.duty_u16(duty_u16)
    else:
        turret_pwm.duty(int((pulse_us / 20000.0) * 1023.0))


def set_relays(grinder_on, flame_on):
    g_val = 0 if (bool(grinder_on) == RELAY_ACTIVE_LOW) else 1
    f_val = 0 if (bool(flame_on) == RELAY_ACTIVE_LOW) else 1
    pin_relay_grinder.value(g_val)
    pin_relay_flame.value(f_val)


def motor_stop():
    pin_l_fwd.value(0)
    pin_l_bwd.value(0)
    pin_r_fwd.value(0)
    pin_r_bwd.value(0)
    _set_motor_pwm(pwm_l, 0)
    _set_motor_pwm(pwm_r, 0)


def apply_8way_drive(drive_cmd, base_speed=680):
    """
    8-Way Rover Drive:
      0   -> Straight Forward
      45  -> Forward + Steer Right (furrow centering)
      315 -> Forward + Steer Left  (furrow centering)
      90  -> U-Turn Pivot Right
      270 -> U-Turn Pivot Left
      180 -> Reverse
      STOP / None -> Immediate Brake
    """
    if drive_cmd is None or drive_cmd == "STOP":
        motor_stop()
        return

    deg = int(drive_cmd) % 360
    if deg == 0:
        pin_l_fwd.value(1); pin_l_bwd.value(0)
        pin_r_fwd.value(1); pin_r_bwd.value(0)
        _set_motor_pwm(pwm_l, base_speed)
        _set_motor_pwm(pwm_r, base_speed)
    elif deg == 45:
        pin_l_fwd.value(1); pin_l_bwd.value(0)
        pin_r_fwd.value(1); pin_r_bwd.value(0)
        _set_motor_pwm(pwm_l, base_speed)
        _set_motor_pwm(pwm_r, int(base_speed * 0.55))
    elif deg == 315:
        pin_l_fwd.value(1); pin_l_bwd.value(0)
        pin_r_fwd.value(1); pin_r_bwd.value(0)
        _set_motor_pwm(pwm_l, int(base_speed * 0.55))
        _set_motor_pwm(pwm_r, base_speed)
    elif deg == 90:
        pin_l_fwd.value(1); pin_l_bwd.value(0)
        pin_r_fwd.value(0); pin_r_bwd.value(1)
        _set_motor_pwm(pwm_l, int(base_speed * 0.85))
        _set_motor_pwm(pwm_r, int(base_speed * 0.85))
    elif deg == 270:
        pin_l_fwd.value(0); pin_l_bwd.value(1)
        pin_r_fwd.value(1); pin_r_bwd.value(0)
        _set_motor_pwm(pwm_l, int(base_speed * 0.85))
        _set_motor_pwm(pwm_r, int(base_speed * 0.85))
    elif deg == 180:
        pin_l_fwd.value(0); pin_l_bwd.value(1)
        pin_r_fwd.value(0); pin_r_bwd.value(1)
        _set_motor_pwm(pwm_l, int(base_speed * 0.75))
        _set_motor_pwm(pwm_r, int(base_speed * 0.75))
    else:
        motor_stop()


def failsafe_all_off():
    motor_stop()
    set_relays(False, False)
    set_turret_deg(0.0)


# Ensure safe boot state
failsafe_all_off()


# ─── Protocol Handler (JSON primary + legacy text fallback) ─
def handle_line(raw_line):
    line = raw_line.strip()
    if not line:
        return "ERR:EMPTY"

    if line.startswith("{"):
        try:
            pkt = json.loads(line)
        except Exception:
            failsafe_all_off()
            return "ERR:BAD_JSON"

        drive = pkt.get("drive", "STOP")
        turret = pkt.get("turret", 0.0)
        r1 = bool(pkt.get("r1_grinder", 0))
        r2 = bool(pkt.get("r2_flame", 0))

        # Safety interlock: never run Grinder/Flame relays while driving
        if drive != "STOP" and drive is not None:
            r1 = False
            r2 = False

        apply_8way_drive(drive)
        set_turret_deg(turret)
        set_relays(r1, r2)
        return "OK"

    upper = line.upper()
    if upper in ("STOP", "ESTOP", "E-STOP"):
        failsafe_all_off()
        return "OK:STOPPED"
    if upper == "STATUS?":
        return "OK:READY"

    return "ERR:UNKNOWN:" + upper


# ─── Non-Blocking Serial Loop + Watchdog ───────────────────
poller = select.poll()
poller.register(sys.stdin, select.POLLIN)

last_rx_ms = time.ticks_ms()
watchdog_tripped = False
rx_buf = ""

print("ESP32_WEED_ROVER_FW_V2_READY")

while True:
    # 1. Check hardware E-STOP pin
    if pin_hw_estop.value() == 1:
        if not watchdog_tripped:
            failsafe_all_off()
            watchdog_tripped = True
            print("FAULT:HW_ESTOP")

    # 2. Poll stdin non-blockingly (20ms slice)
    events = poller.poll(20)
    if events:
        ch = sys.stdin.read(1)
        if ch == "\n":
            if rx_buf:
                last_rx_ms = time.ticks_ms()
                watchdog_tripped = False
                resp = handle_line(rx_buf)
                print(resp)
                rx_buf = ""
        elif ch:
            rx_buf += ch
            if len(rx_buf) > 256:
                rx_buf = ""
                failsafe_all_off()
                print("ERR:OVERFLOW")

    # 3. Serial Watchdog: cut motors + relays if Pi goes silent > 1500ms
    if not watchdog_tripped and time.ticks_diff(time.ticks_ms(), last_rx_ms) > WATCHDOG_MS:
        failsafe_all_off()
        watchdog_tripped = True
        print("WATCHDOG:FAILSAFE_STOP")
