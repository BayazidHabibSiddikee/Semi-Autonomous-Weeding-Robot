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

## Pi 4 phone hub (manual + autonomous)

The Pi is the network and autonomy hub. The Android app connects to the Pi's Wi-Fi access point; the Pi connects to the ESP32 by USB serial. The ESP32 owns the L298N motor pins. MaixSense stays connected to the Pi through its USB-RNDIS link.

### Start the hub

1. Flash `simpla_bot/firmware/esp32_motor_controller.ino` to the ESP32. The sketch's example GPIO mapping must be checked against your ESP32 board and wiring.
2. Connect ESP32 USB to the Pi. Check the port with `ls -l /dev/serial/by-id/`; update `motor_driver.serial_port` in `config.yaml` if needed.
3. Keep the robot lifted and motor power disconnected for the first serial test. Install the camera/runtime dependencies and pyserial.
4. From the repository root run:

```bash
python3 -m pip install pyserial
python3 -m simpla_bot.hub_server
```

The control API listens on port 8080:
- `GET /api/status`
- `POST /api/mode` with `{"mode":"manual"}` or `{"mode":"autonomous"}`
- `POST /api/drive` with `{"left":20,"right":20}` (manual mode only; app sends repeated hold commands)
- `POST /api/stop`

### Pi Wi-Fi and Ethernet

On Raspberry Pi OS with NetworkManager, connect Pi Ethernet to the router for internet, then create the robot hotspot:

```bash
sudo nmcli device wifi hotspot ifname wlan0 ssid SimplaBot password 'CHANGE-THIS-PASSWORD'
```

The hotspot gateway is normally `192.168.4.1`; open the Android app's **Control** tab and connect to that IP. If NetworkManager chooses another subnet, use the actual Pi hotspot IP shown by `ip -4 addr show wlan0`.

### Operating modes

- **Manual:** hold a direction in the app. Repeated commands refresh the ESP32 watchdog; releasing the control sends STOP. The Pi also stops if the command stream expires.
- **Autonomous:** the Pi runs the existing experimental MaixSense row-navigation loop and sends motor commands to the ESP32 over USB.
- Switching mode first stops the motor output. Phone loss stops manual movement; the ESP32 serial watchdog stops motor output if Pi-to-ESP32 commands stop.

The app status panel shows Pi/ESP32 connectivity, camera state, depth-zone readings, corner/weed flags, and estimated travel. This is telemetry, not a certified safety system.

**Commissioning limits:** motor output is software-limited to 35% in this initial firmware, but this does not make an electrically overloaded L298N safe. Confirm each motor's rated voltage and stall current, the combined current per L298N channel, wiring, and cooling before connecting motor power. Use a physical normally-closed E-stop that independently removes actuator power. Treatment outputs remain disabled/dry-run; no unattended operation is supported. The autonomous controller is experimental and must be supervised.
