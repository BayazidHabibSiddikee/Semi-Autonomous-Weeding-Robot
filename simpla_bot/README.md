# Simpla Bot — Pi 4 hardware profile

**Target hardware**
- Raspberry Pi 4
- Sipeed MaixSense-A075V depth/RGB camera
- One L298N dual H-bridge
- Four DC motors: two left motors wired in parallel on channel A, two right motors in parallel on channel B
- MG996R bottle-rotation servo driven by a separate microcontroller
- Arc/ignition module and one alternative grinder tool (not simultaneously controlled)

This branch deliberately narrows the project to hardware bring-up and supervised navigation. It removes the assumption that the robot is a ROS/SLAM platform.

## Important electrical unknown

Motor voltage and stall current are not known yet. The config therefore defaults to `backend: sim`. Do not switch to GPIO/live motor operation until you have identified the motor rated voltage, stall current, battery voltage, and verified that the L298N can handle the combined current of two parallel motors on each channel. Parallel wiring doubles the current demand of each channel; an L298N may be unsuitable.

## Motor mapping

The existing driver maps one logical left channel and one logical right channel:

| L298N terminal | Raspberry Pi BCM |
|---|---:|
| ENA | 12 |
| IN1 | 5 |
| IN2 | 6 |
| ENB | 13 |
| IN3 | 20 |
| IN4 | 21 |

Channel A drives both left motors in parallel. Channel B drives both right motors in parallel. Both motors on each side always receive the same direction and PWM. There is no independent wheel control.

## MG996R

`hardware/bottle_servo.py` sends `SERVO <angle>\n` and `SERVO_DISABLE\n` over USB serial to a dedicated Arduino/ESP32-class controller. The controller firmware must parse those commands, clamp the mechanical angle, and generate the servo signal. Set the serial port in `config.yaml` after checking:

```bash
ls -l /dev/serial/by-id/
```

Do not power the MG996R from the Pi. Use a separate regulated servo supply sized for its stall current, with a shared signal ground. Calibrate the safe angle range with the bottle mechanism disconnected.

## Arc and grinder

The arc module is an ignition source, not a motor-driver output. This branch does not implement arc ignition or provide an ignition relay sequence. Keep that module physically isolated while commissioning. Treatment outputs remain dry-run only in this branch. The grinder is a separate alternative tool, not a simultaneous mode. Before any real treatment design, it needs a separately engineered, independent safety system and supervised validation.

A software E-stop is not a safety-rated disconnect. Use a physical normally-closed emergency-stop circuit that independently removes actuator energy.

## Software layout

- `config.yaml`: Pi 4 pins, paired motor topology, MaixSense parameters, servo MCU serial settings.
- `motor_driver.py`: existing two-channel differential drive interface.
- `maixsense_perception.py`: camera transport and depth/RGB analysis.
- `simpla_bot_controller.py`: existing experimental row-navigation state machine.
- `hardware/bottle_servo.py`: MG996R serial adapter.
- `PI4_HARDWARE_PROFILE.md`: wiring topology, limits, and commissioning sequence.

## Bring-up sequence

1. Identify all motor labels/specifications and battery voltage. Measure or obtain each motor's stall current.
2. Confirm the L298N current/thermal suitability for two motors per channel. If it is not adequate, select a driver with suitable continuous and peak current ratings.
3. Keep config at `backend: sim`; run the offline simulation.
4. Verify the MaixSense camera independently using `--check-maixsense`.
5. Lift the chassis, use a current-limited motor supply, and test one motor pair at low speed. Confirm direction and stopping.
6. Test the MG996R with the bottle disconnected and its separate supply/controller.
7. Validate physical emergency stop and power isolation.
8. Only then begin slow, supervised navigation tests. No autonomous treatment is enabled.

## Commands

```bash
# Install the light runtime dependencies as required by the camera decoder
python3 -m pip install -r simpla_bot/requirements.txt

# Offline simulation; no hardware outputs
python3 -m simpla_bot.run_simpla_bot --mode sim --tool none

# Check the live MaixSense connection only
python3 -m simpla_bot.run_simpla_bot --check-maixsense
```

## Current limitations

- Distance and turning are open-loop estimates; there are no wheel encoders or IMU.
- Green-pixel clustering is not reliable crop/weed classification.
- The row-following state machine is experimental and must not be trusted for unattended operation.
- Servo MCU firmware is not included yet; the Pi-side serial protocol is documented in the adapter.
