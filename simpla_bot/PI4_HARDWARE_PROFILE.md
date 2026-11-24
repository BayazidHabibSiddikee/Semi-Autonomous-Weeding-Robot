# Pi 4 + four-wheel L298N + MaixSense + MG996R controller

This profile is for the actual small rover, not the older ROS/SLAM design.

## Hardware topology
- Raspberry Pi 4: MaixSense perception, navigation, high-level decisions.
- MaixSense-A075V: USB connection to Pi (verify USB-RNDIS and firmware).
- One L298N: channel A drives two left motors in parallel; channel B drives two
  right motors in parallel. This is skid/differential steering.
- A separate Arduino/ESP32-class controller drives the MG996R signal.
- The servo has its own regulated supply. Join signal ground to controller
  ground and establish a common signal reference with the Pi as required.
- Keep arc/ignition and grinder power stages separate from Pi and servo control.

## Existing L298N GPIO mapping (BCM numbering)
| L298N | Pi BCM |
|---|---:|
| ENA | 12 |
| IN1 | 5 |
| IN2 | 6 |
| ENB | 13 |
| IN3 | 20 |
| IN4 | 21 |

Remove ENA/ENB jumpers only if using Pi PWM on those enable inputs. Verify
jumper arrangement and logic compatibility before wiring. All four motors on
a side receive the same direction and PWM; there is no independent wheel control.

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
3. Test one L298N channel with wheels lifted and current-limited motor supply.
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
