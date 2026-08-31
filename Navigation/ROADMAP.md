# Navigation — Roadmap

## Architecture Shift

**Old design (Weed_Detection/):** Gantry on rails, G-code stepper control, laser fixed at 3cm.
**New design:** Wheeled rover, stop-scan-fire-move loop, ultrasonic for Z, 1ft arm for aiming.

The detection pipeline (`detection_pipeline.py`, `calibration.py`) and laser control (`laser_control.py`) stay. Everything else in the motion stack gets replaced.

---

## Hardware Stack

```
Raspberry Pi 5 (main computer)
├── USB Camera (vertical, downward) → X,Y weed detection
├── Ultrasonic sensor (VL53L0X ToF) → Z distance confirmation
├── ESP32 (via USB serial) → motor + servo driver
│   ├── L298N/H-Bridge → DC gear motors (left + right wheels)
│   ├── Servo 1 (pan) → aim laser left/right
│   ├── Servo 2 (tilt) → aim laser up/down (within 1ft arm)
│   └── MOSFET → laser fire
└── GPIO → E-stop button + safety interlock
```

---

## State Machine

```
IDLE
  │
  ▼
FORWARD ──(ultrasonic detects row-end/obstacle)──► ROTATE
  │                                                    │
  │                                                    ▼
  │◄───────────────────────────────────────────────────┘
  ▼
STOP
  │
  ▼
SCAN (camera captures frame)
  │
  ├── no weed detected → FORWARD
  │
  ├── weed detected → AIM (pan-tilt to X,Y)
  │                      │
  │                      ▼
  │                   FIRE (ultrasonic confirms Z → laser fires)
  │                      │
  │                      ▼
  │                   (repeat SCAN for more weeds in frame)
  │
  └── all weeds cleared → FORWARD
```

---

## Files to Create

### Phase 1: Motor Control (`Navigation/src/`)

| File | Purpose |
|------|---------|
| `rover_motors.py` | DC motor driver via ESP32 serial (forward, backward, rotate, stop) |
| `servo_gimbal.py` | Pan-tilt servo control via ESP32 (aim at X,Y position) |
| `ultrasonic.py` | VL53L0X ToF sensor reading (distance in mm) |
| `esp32_bridge.py` | Serial protocol between Pi ↔ ESP32 (command parsing) |

### Phase 2: Navigation Logic

| File | Purpose |
|------|---------|
| `state_machine.py` | The IDLE→FORWARD→STOP→SCAN→AIM→FIRE loop |
| `row_navigator.py` | Row-following logic (move forward, detect row-end, rotate 90°, enter next row) |
| `rover_config.yaml` | Motor speeds, servo angles, ultrasonic thresholds, serial port |

### Phase 3: Integration

| File | Purpose |
|------|---------|
| `rover_main.py` | Entry point — ties detection + navigation + laser into one loop |
| `tests/test_rover.py` | Unit tests for each navigation component |

### Phase 4: ESP32 Firmware

| File | Purpose |
|------|---------|
| `esp32_firmware/` | Arduino/PlatformIO code for ESP32 (receive commands, drive motors/servos) |

---

## Integration with Existing Code

### What we reuse from `Weed_Detection/src/`:

| Module | How it connects |
|--------|----------------|
| `detection_pipeline.py` | Called during SCAN state — returns `WeedDetection` list with pixel (u,v) |
| `calibration.py` | `pixel_to_gantry_2d(u,v)` → returns (X,Y) in cm — same math works for rover |
| `laser_control.py` | `LaserController.fire()` called during FIRE state |
| `laser_control.py` → `LaserSafety` | E-stop and interlock checking every state transition |

### What changes:

| Old (gantry) | New (rover) |
|--------------|-------------|
| `gantry_control.py` → G-code to RAMPS | `rover_motors.py` → ESP32 serial → DC motors |
| `main.py` → `process_frame()` moves gantry | `state_machine.py` → full state loop |
| Fixed Z at 3cm | Ultrasonic confirms Z before firing |
| No navigation | `row_navigator.py` for field traversal |

---

## Serial Protocol (Pi ↔ ESP32)

Simple text-based protocol over USB serial:

```
Pi → ESP32:
  MOVE F 500      # forward 500ms
  MOVE B 300      # backward 300ms
  MOVE R 90       # rotate right 90 degrees
  MOVE L 90       # rotate left 90 degrees
  MOVE S          # stop
  SERVO PAN 45    # pan servo to 45 degrees
  SERVO TILT 30   # tilt servo to 30 degrees
  LASER ON        # fire laser
  LASER OFF       # stop laser
  ULTRASONIC?     # query distance
  STATUS?         # query motor/servo status

ESP32 → Pi:
  OK              # command acknowledged
  DIST:235        # ultrasonic reading in mm
  DONE            # movement complete
  ERR:MSG         # error message
```

---

## Week-by-Week Plan

| Week | Task | Deliverable |
|------|------|-------------|
| 1 | ESP32 firmware + serial protocol | ESP32 drives motors on serial commands |
| 2 | Pi ↔ ESP32 bridge + motor control | `rover_motors.py` moves rover forward/back/rotate |
| 3 | Servo gimbal + ultrasonic | `servo_gimbal.py` aims, `ultrasonic.py` reads distance |
| 4 | State machine + row navigator | Full stop→scan→aim→fire→move loop |
| 5 | Integrate with detection pipeline | Camera detects weed → rover aims → laser fires |
| 6 | Field testing + tuning | Working prototype on real soil |

---

## Budget (Revised)

| Component | Est. Cost (BDT) |
|-----------|-----------------|
| Raspberry Pi 5 (8GB) | 8,000 |
| ESP32 DevKit | 500 |
| DC Gear Motors (x2) + Wheels | 1,200 |
| L298N Motor Driver | 200 |
| SG90 Servos (x2) for pan-tilt | 200 |
| VL53L0X ToF Sensor | 300 |
| USB Camera (OV5647) | 1,500 |
| 450nm Laser Module | 3,000 |
| MOSFET + Driver | 200 |
| Battery (12V LiPo or similar) | 1,500 |
| Chassis + frame materials | 1,000 |
| **Total** | **~17,600 BDT** |
