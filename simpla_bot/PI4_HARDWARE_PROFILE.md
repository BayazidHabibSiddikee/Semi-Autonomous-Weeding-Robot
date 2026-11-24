# Pi 4 + four-wheel L298N + MaixSense + MG996R controller

This profile is for the actual small rover, not the older ROS/SLAM design.

## Hardware topology
- Raspberry Pi 4: MaixSense perception, navigation, high-level decisions.
- MaixSense-A075V: USB-RNDIS connection to Pi (verify its network interface, address, and firmware). The hub uses one dedicated camera reader and shares fresh frames with telemetry and autonomy.
- One L298N: channel A drives two left motors in parallel; channel B drives two
  right motors in parallel. This is skid/differential steering.
- A separate Arduino/ESP32-class controller drives the MG996R signal.
- The servo has its own regulated supply. Join signal ground to controller
  ground and establish a common signal reference with the Pi as required.
- Keep arc/ignition and grinder power stages separate from Pi and servo control.

## ESP32 motor controller (USB from Pi)

The Pi does not drive the L298N GPIO pins. The Pi sends serial commands over USB
to the ESP32; the ESP32 generates the L298N direction/PWM signals.

The example firmware `firmware/esp32_motor_controller.ino` uses these ESP32 GPIOs:

| L298N / signal | ESP32 GPIO |
|---|---:|
| ENA | 27 |
| IN1 | 25 |
| IN2 | 26 |
| ENB | 14 |
| IN3 | 32 |
| IN4 | 33 |
| E-stop sense | 4 |

These are example assignments, not universal board pins. Verify your exact ESP32
board, pin restrictions, and wiring before connecting the driver. Channel A drives
both left motors in parallel; channel B drives both right motors in parallel.

Remove the L298N ENA and ENB jumper caps so the ESP32 can supply PWM to both
enable inputs. Tie ESP32 GND, L298N logic GND, and motor-supply negative together.
Do not use the L298N 5V output to power the ESP32. Connect ESP32 USB to a Pi USB
host port. The Pi serial protocol is newline-terminated at 115200 baud:
`M <left_pct> <right_pct>`, `STOP`, and `PING`. PING checks firmware and E-stop
status but does not refresh the motor movement watchdog. Identify the device with
`ls -l /dev/serial/by-id/` and set `SIMPLA_ESP32_PORT` to its stable path.
The hub selects the serial backend; the CLI default remains simulation.

The ESP32 E-stop sense input is only a supplementary status/interlock input. A
physical normally-closed E-stop must independently disconnect actuator power.

## MG996R controller protocol
The Pi adapter in hardware/bottle_servo.py sends newline-terminated commands:
- SERVO 90
- SERVO_DISABLE

The receiving MCU must implement this protocol and clamp angles to safe limits.
The Pi-side code does not assume a specific Arduino/ESP32 board or pin. Set the
serial device after identifying it with ls /dev/serial/by-id/.

Do not power an MG996R from the Pi 5 V pin. Use a suitable regulated supply
sized for servo stall current, common ground, and suitable wiring. Avoid
mechanical stops; establish angle limits with the bottle assembly disconnected.

## Critical unknown: motor current
Motor voltage and stall current are not yet known. Keep this profile in
simulation until motor labels/datasheet and battery voltage are identified.
The L298N has significant voltage drop and thermal/current limits. Two motors
in parallel on each channel add their current demands. Check the actual board
and cooling against combined startup/stall demand. If overloaded, replace the
driver; do not attempt to solve an electrical overload with software PWM.

## Bring-up order
1. Identify motor rated voltage, stall current, and battery voltage.
2. Test MaixSense alone and record depth/RGB validity.
3. Test ESP32 USB serial first with motor power disconnected; then test one L298N channel with wheels lifted and a current-limited motor supply.
4. Test the second channel; confirm both motors per side turn together.
5. Test MG996R with its own supply and servo MCU, bottle removed.
6. Verify a physical normally-closed emergency stop cuts actuator energy
   independently of the Pi.
7. Only then perform slow, supervised navigation tests. Keep treatment disabled.

## Known limitations
- Motor distance is estimated from elapsed time and PWM; there are no encoders
  or IMU feedback. Turns and weed alignment are approximate.
- First milestone: teleoperated drive, camera logging, obstacle stop, then slow
  row-following—not autonomous treatment.
- Green-pixel detection is not crop-safe weed classification. Never treat based
  only on a green threshold.
