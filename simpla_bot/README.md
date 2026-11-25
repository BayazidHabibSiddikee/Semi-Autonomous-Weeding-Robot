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

Motor voltage and stall current are not known yet. The config therefore defaults to `backend: sim`. Do not connect motor power until you have identified the motor rated voltage, stall current, battery voltage, and verified that the single L298N can handle the combined current of two parallel motors on each channel. Parallel wiring doubles the current demand of each channel; an L298N may be unsuitable.

## Motor mapping

There is exactly ONE L298N module. Its two H-bridge channels map one logical left side and one logical right side:

| L298N terminal | ESP32 GPIO (firmware defaults) |
|---|---:|
| ENA | 27 |
| IN1 | 25 |
| IN2 | 26 |
| ENB | 14 |
| IN3 | 32 |
| IN4 | 33 |

Channel A drives both left motors in parallel. Channel B drives both right motors in parallel. Both motors on each side always receive the same direction and PWM. There is no independent wheel control. Remove the ENA and ENB jumper caps if the ESP32 is driving those enable pins with PWM. Tie ESP32 GND, L298N logic GND, and the motor-supply negative together. Keep motor supply wiring separate from Pi/ESP32 logic power. Never connect the L298N 5V output to the ESP32 5V/3V3 rail.

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

- `config.yaml`: paired motor topology, MaixSense parameters, ESP32 and servo serial settings.
- `motor_driver.py`: two-channel differential drive interface, with USB serial output to ESP32.
- `hub_server.py`: lightweight HTTP API for the Android app and autonomous/manual mode switching.
- `firmware/esp32_motor_controller.ino`: ESP32 USB serial motor firmware.
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
python3 -m pip install pyserial pillow

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

1. Flash `simpla_bot/firmware/esp32_motor_controller.ino` to the ESP32. Confirm the GPIO mapping against the exact ESP32 board and wiring.
2. Connect ESP32 USB to the Pi and identify its stable device name:

```bash
ls -l /dev/serial/by-id/
```

Set `SIMPLA_ESP32_PORT` to that exact path. If `/dev/serial/by-id/` is empty, use the detected `/dev/ttyUSB0` or `/dev/ttyACM0` only after confirming which device is the ESP32.
3. Install Pi dependencies:

```bash
python3 -m pip install -r simpla_bot/requirements-pi.txt
```

4. Verify the MaixSense USB-RNDIS network before starting the hub. The A075V uses `192.168.233.1`; Sipeed warns that `192.168.233.0/24` must not already be used by the router LAN. The camera can take around 10–15 seconds after power-on to become ready. Check the Pi interfaces:

```bash
ip -br link
ip -br addr
ip route
ping -c 3 192.168.233.1
```

If the RNDIS interface has no address, identify its actual interface name from `ip -br link` (often an `enx...` device), then assign the Pi-side address:

```bash
sudo nmcli connection add type ethernet ifname RNDIS_INTERFACE con-name maixsense-rndis ipv4.method manual ipv4.addresses 192.168.233.2/24 ipv4.never-default yes ipv6.method disabled
sudo nmcli connection up maixsense-rndis
ping -c 3 192.168.233.1
```

Replace `RNDIS_INTERFACE` with the real interface name. Do not create a duplicate connection if one already exists or if the interface already has a working address. Then run the camera-only check:

```bash
python3 -m simpla_bot.run_simpla_bot --check-maixsense
```

5. Set a stable API token and start the hub from the repository root:

```bash
export SIMPLA_ESP32_PORT=/dev/serial/by-id/YOUR_ESP32_DEVICE
export SIMPLA_API_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
python3 -m simpla_bot.hub_server
```

Copy the printed/configured token into the Android app's **Pi API token** field. Keep the token private. If you omit `SIMPLA_API_TOKEN`, the hub generates a temporary token and prints it at startup; it changes after a restart.

The authenticated API listens on port 8080:
- `GET /api/status` — camera freshness, ESP32 heartbeat, depth zones and robot state
- `POST /api/mode` with `{"mode":"manual"}` or `{"mode":"autonomous"}`
- `POST /api/drive` with `{"left":20,"right":20}` (manual mode only; app repeats commands while held)
- `POST /api/stop`

Every endpoint requires `Authorization: Bearer <token>`. The hub has no permissive CORS policy. The ESP32 must answer `PING` with `PONG ESTOP=0`; an open E-stop loop or missing heartbeat blocks motion.

### Pi Wi-Fi and Ethernet

On Raspberry Pi OS with NetworkManager, connect Pi Ethernet to the router for internet, then create the robot hotspot:

```bash
sudo nmcli device wifi hotspot ifname wlan0 ssid bayazid password '12345678'
```

NetworkManager's default shared hotspot address is commonly `10.42.0.1`; open the Android app's **Control** tab and use the actual Pi hotspot IP shown by `ip -4 addr show wlan0`. The app defaults to `10.42.0.1` but lets you edit it.

### Operating modes

- **Manual:** hold a direction in the app. Repeated drive commands refresh the motor watchdog; releasing the control sends STOP. The Pi command watchdog also stops motion if the phone command stream expires.
- **Camera:** one dedicated Pi worker reads MaixSense. It publishes the latest frame to the manual telemetry display and the autonomous controller; the camera transport is never read concurrently.
- **Autonomous:** the Pi requires a fresh MaixSense frame and a healthy ESP32 heartbeat before starting. It consumes each camera frame once and halts if frames become stale.
- **ESP32 heartbeat:** PING checks firmware/E-stop health but does not refresh the motor movement watchdog. Only valid drive commands refresh that watchdog.
- Switching mode first stops motor output. Phone loss stops manual movement; loss of Pi drive commands stops the ESP32 output.

The app status panel shows Pi/ESP32 heartbeat, camera freshness, depth-zone readings, corner/weed flags, and estimated travel. The Android APK is not included or built by this branch; build it locally from `android_app/` after checking out this branch. This telemetry is not a certified safety system.

**Commissioning limits:** motor output is software-limited to 35% in this initial firmware, but this does not make an electrically overloaded L298N safe. Confirm each motor's rated voltage and stall current, the combined current per L298N channel, wiring, and cooling before connecting motor power. Use a physical normally-closed E-stop that independently removes actuator power. Treatment outputs remain disabled/dry-run; no unattended operation is supported. The autonomous controller is experimental and must be supervised.


## Build the Android app locally (not built by this branch)

From the repository root, on a machine with JDK 17:

```bash
cd android_app
chmod +x gradlew
./gradlew assembleDebug
```

The debug APK will be at `android_app/app/build/outputs/apk/debug/app-debug.apk`.
To run only the Kotlin compile check without packaging an APK, use
`./gradlew :app:compileDebugKotlin`.
