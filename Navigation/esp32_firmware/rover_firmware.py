"""
ESP32 firmware for the weed laser rover.
Receives serial commands from Pi and drives motors, servos, laser, and ultrasonic.

Flash via PlatformIO or Arduino IDE:
  - Board: ESP32 DevKit v1
  - Upload at 115200 baud

Wiring:
  L298N Motor Driver:
    IN1 → GPIO 26 (left motor fwd)
    IN2 → GPIO 27 (left motor bwd)
    IN3 → GPIO 14 (right motor fwd)
    IN4 → GPIO 12 (right motor bwd)
    ENA → GPIO 25 (left PWM)
    ENB → GPIO 33 (right PWM)

  Servos:
    Pan  → GPIO 18 (PWM channel 0)
    Tilt → GPIO 19 (PWM channel 1)

  Laser:
    MOSFET gate → GPIO 4

  Ultrasonic (VL53L0X via I2C):
    SDA → GPIO 21
    SCL → GPIO 22

  Or HC-SR04:
    TRIG → GPIO 23
    ECHO → GPIO 5
"""

import time

# ─── Pin Definitions ───────────────────────────────────────
# Motor (L298N)
MOTOR_L_FWD = 26
MOTOR_L_BWD = 27
MOTOR_R_FWD = 14
MOTOR_R_BWD = 12
MOTOR_L_EN = 25   # PWM
MOTOR_R_EN = 33   # PWM

# Servos
SERVO_PAN_PIN = 18
SERVO_TILT_PIN = 19

# Laser
LASER_PIN = 4

# Ultrasonic
ULTRASONIC_TRIG = 23
ULTRASONIC_ECHO = 5

# ─── Setup ─────────────────────────────────────────────────
import machine
import time

# Motor PWM
pwm_l = machine.PWM(machine.Pin(MOTOR_L_EN), freq=1000, duty=0)
pwm_r = machine.PWM(machine.Pin(MOTOR_R_EN), freq=1000, duty=0)
pin_l_fwd = machine.Pin(MOTOR_L_FWD, machine.Pin.OUT)
pin_l_bwd = machine.Pin(MOTOR_L_BWD, machine.Pin.OUT)
pin_r_fwd = machine.Pin(MOTOR_R_FWD, machine.Pin.OUT)
pin_r_bwd = machine.Pin(MOTOR_R_BWD, machine.Pin.OUT)

# Servos
from machine import Servo
servo_pan = Servo(SERVO_PAN_PIN)
servo_tilt = Servo(SERVO_TILT_PIN)
servo_pan.angle(90)
servo_tilt.angle(60)

# Laser
pin_laser = machine.Pin(LASER_PIN, machine.Pin.OUT)
pin_laser.value(0)

# Ultrasonic pins
pin_trig = machine.Pin(ULTRASONIC_TRIG, machine.Pin.OUT)
pin_echo = machine.Pin(ULTRASONIC_ECHO, machine.Pin.IN)

# Serial (from Pi)
import sys
import select

# ─── Motor Functions ───────────────────────────────────────
def motor_stop():
    pin_l_fwd.value(0)
    pin_l_bwd.value(0)
    pin_r_fwd.value(0)
    pin_r_bwd.value(0)
    pwm_l.duty(0)
    pwm_r.duty(0)

def motor_forward(speed=200):
    pin_l_fwd.value(1)
    pin_l_bwd.value(0)
    pin_r_fwd.value(1)
    pin_r_bwd.value(0)
    pwm_l.duty(speed)
    pwm_r.duty(speed)

def motor_backward(speed=180):
    pin_l_fwd.value(0)
    pin_l_bwd.value(1)
    pin_r_fwd.value(0)
    pin_r_bwd.value(1)
    pwm_l.duty(speed)
    pwm_r.duty(speed)

def motor_rotate_right(speed=180):
    pin_l_fwd.value(1)
    pin_l_bwd.value(0)
    pin_r_fwd.value(0)
    pin_r_bwd.value(1)
    pwm_l.duty(speed)
    pwm_r.duty(speed)

def motor_rotate_left(speed=180):
    pin_l_fwd.value(0)
    pin_l_bwd.value(1)
    pin_r_fwd.value(1)
    pin_r_bwd.value(0)
    pwm_l.duty(speed)
    pwm_r.duty(speed)

# ─── Servo Functions ──────────────────────────────────────
def set_servo(axis, angle):
    angle = max(0, min(180, int(angle)))
    if axis == "PAN":
        servo_pan.angle(angle)
    elif axis == "TILT":
        servo_tilt.angle(angle)

# ─── Laser Functions ──────────────────────────────────────
def laser_on():
    pin_laser.value(1)

def laser_off():
    pin_laser.value(0)

# ─── Ultrasonic Function ─────────────────────────────────
def read_distance():
    """Read HC-SR04 distance in mm."""
    pin_trig.value(0)
    time.sleep_us(2)
    pin_trig.value(1)
    time.sleep_us(10)
    pin_trig.value(0)

    timeout = time.ticks_us() + 30000  # 30ms timeout
    while pin_echo.value() == 0:
        if time.ticks_us() > timeout:
            return -1
    start = time.ticks_us()

    while pin_echo.value() == 1:
        if time.ticks_us() > timeout:
            return -1

    elapsed = time.ticks_diff(time.ticks_us(), start)
    distance_mm = int(elapsed * 0.343 / 2)
    return distance_mm

# ─── Command Parser ───────────────────────────────────────
def handle_command(cmd):
    parts = cmd.strip().split()
    if not parts:
        return "ERR:EMPTY"

    action = parts[0].upper()

    if action == "MOVE":
        direction = parts[1].upper()
        duration = int(parts[2]) if len(parts) > 2 else 500
        speed = int(parts[3]) if len(parts) > 3 else 200

        if direction == "F":
            motor_forward(speed)
            time.sleep_ms(duration)
            motor_stop()
        elif direction == "B":
            motor_backward(speed)
            time.sleep_ms(duration)
            motor_stop()
        elif direction == "R":
            motor_rotate_right(speed)
            time.sleep_ms(int(duration * 5))  # scale for ~90°
            motor_stop()
        elif direction == "L":
            motor_rotate_left(speed)
            time.sleep_ms(int(duration * 5))
            motor_stop()
        elif direction == "S":
            motor_stop()
        return "DONE"

    elif action == "SERVO":
        axis = parts[1].upper()
        angle = int(parts[2])
        set_servo(axis, angle)
        return "OK"

    elif action == "LASER":
        state = parts[1].upper()
        if state == "ON":
            laser_on()
        elif state == "OFF":
            laser_off()
        return "OK"

    elif action == "ULTRASONIC?":
        dist = read_distance()
        return f"DIST:{dist}"

    elif action == "STATUS?":
        return "OK"

    return f"ERR:UNKNOWN:{action}"

# ─── Main Loop ────────────────────────────────────────────
print("ESP32 Rover Firmware Ready")
buffer = ""

while True:
    # read from USB (Pi)
    data = sys.stdin.read(1)
    if data == "\n":
        if buffer:
            response = handle_command(buffer)
            print(response)
            buffer = ""
    elif data:
        buffer += data

    time.sleep_ms(1)
