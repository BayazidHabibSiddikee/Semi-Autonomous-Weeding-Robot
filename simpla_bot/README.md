# Simpla Bot — Complete Technical & Operator Manual

**Branch:** `simpla_bot`  
**Hardware Scope:** Sipeed MaixSense-A075V + Normal Motor Driver (L298N / BTS7960 / Serial Arduino) + Flame Control + Grinding Machine **ONLY**  
**Software Scope:** Pure Python 3 (zero ROS 2, zero heavy SLAM, runs on Raspberry Pi 3/4/5 or any Linux/Windows/macOS bench PC)

> **Printable PDF Manual:** A formatted multi-page PDF version of this guide is located at **`simpla_bot/SIMPLA_BOT_MANUAL.pdf`**. You can regenerate it at any time with `python3 simpla_bot/build_manual_pdf.py`.

---

## 1. System Overview

`simpla_bot` strips the weeding robot down to the absolute simplest, easiest-to-wire, easiest-to-debug hardware stack:

1. **One Sensor Does Everything Spatial — Sipeed MaixSense-A075V (ToF Depth + RGB):**
   - Connects over a single USB-C cable (USB-RNDIS virtual Ethernet at `192.168.233.1`).
   - Measures real-world millimeter distances (`200 mm – 2400 mm`) across Left, Center, and Right zones.
   - Tells the bot **how far to travel** (`recommended_travel_mm`), **when it reaches a corner or row end**, **which way to turn** (`LEFT`, `RIGHT`, or `UTURN`), **how to stay centered** between rows/walls, and **exact millimeters to roll forward** so a detected weed lands directly beneath the grinder or flame nozzle.
2. **Normal Motor Driver Only:**
   - Standard dual H-bridge (**L298N**, **BTS7960 43A**, or **Cytron MDD10A**).
   - Works either wired directly to Raspberry Pi GPIO (`backend: "gpio"`) OR via a $5 Arduino Uno/Nano over USB (`backend: "serial"`) using the included `simpla_bot/firmware/simpla_motor_relay.ino` sketch.
3. **Flame Control + Grinding Machine Only:**
   - Driven through a standard **2-channel opto-isolated relay module**:
     - **Relay CH1:** Grinding machine motor / contactor
     - **Relay CH2:** Flame control (12 V solenoid gas valve + spark igniter)
   - Protected by **five independent safety interlocks** (default `dry_run: true`, stationary check, hardware E-stop pin, 2.5 s hard flame duration cap, 3.0 s flame cooldown, and 800 ms serial/camera watchdog).

```
                     +----------------------------------+
                     |     Sipeed MaixSense-A075V       |
                     |   16-bit ToF Depth + RGB Camera  |
                     |      USB-C (192.168.233.1)       |
                     +----------------+-----------------+
                                      | USB-RNDIS
                     +----------------v-----------------+
                     |   Raspberry Pi (simpla_bot)      |
                     |  - Distance-to-go & Corners      |
                     |  - Weed-to-Tool Projection       |
                     |  - Safety Interlocks & Watchdog  |
                     +--------+----------------+--------+
                              |                |
        Option A: Direct GPIO |                | Option B: USB Serial (115200)
        (backend: "gpio")     |                | (backend: "serial")
                              v                v
                 +------------+----------------+------------+
                 |    Normal Motor Driver (L298N / BTS7960) |
                 |       + 2-Channel Relay + NC E-Stop      |
                 +------+--------------------+------+-------+
                        |                    |      |
                        v                    v      v
                  Left & Right          Relay CH1  Relay CH2
                  Drive Motors           Grinder    Flame
```

---

## 2. Bill of Materials (BOM)

| Qty | Component | Specification / Notes |
|---:|---|---|
| 1 | **Sipeed MaixSense-A075V** | ToF + RGB depth camera (USB-C RNDIS `192.168.233.1`) |
| 1 | **Raspberry Pi 4 / 3B+ / 5** | Runs Python 3 `simpla_bot` controller |
| 1 | **Normal Motor Driver** | L298N (small/bench motors up to 2 A/ch) **or** BTS7960 x2 (heavy 12 V–24 V field motors up to 43 A) |
| 2 | **DC Geared Drive Motors** | 12 V or 24 V brushed DC motors (left + right differential drive) |
| 1 | **2-Channel Relay Module** | 5 V opto-isolated relay board (10 A–30 A contacts), active-LOW |
| 1 | **Grinding Machine** | 12 V/24 V brushed motor or AC trimmer switched via Relay CH1 contactor |
| 1 | **Flame Control Assembly** | 12 V Normally-Closed (NC) gas solenoid valve + piezo/electronic spark igniter + inline flashback arrestor |
| 1 | **Hardware E-Stop Button** | Red mushroom latching **Normally-Closed (NC)** switch (cuts main tool/motor power AND signals GPIO/D2) |
| 1 | **Battery + 5 V Buck** | 12 V LiFePO4 / SLA battery + 5 V 3 A buck converter for Raspberry Pi |
| 0–1 | **Arduino Uno / Nano** *(Optional)* | Only needed if using Option B (`backend: "serial"`) for hardware watchdog isolation |

---

## 3. Wiring Diagrams & Pinout Tables

### CRITICAL POWER SAFETY RULE
- **NEVER** power motors, grinder, or gas solenoid from the Raspberry Pi 5 V pin.
- Wire the **Hardware E-Stop (NC mushroom switch)** in **series with the 12 V positive supply** feeding both the Relay COM terminals (Grinder & Flame) and Motor Driver power, AND wire a second NC contact (or sense wire) to the E-Stop logic pin so software halts immediately.
- **Common Ground:** Connect Raspberry Pi `GND`, Motor Driver `GND`, Relay `GND`, and Battery `-` together.

---

### Option A: Direct Raspberry Pi GPIO Wiring (`backend: "gpio"`)

| Function | Raspberry Pi BCM Pin | Physical Pin | Connect To |
|---|---:|---:|---|
| Left Motor PWM | `GPIO 12` | Pin 32 | L298N `ENA` (or BTS7960 `R_EN/L_EN`) |
| Left Motor Dir A | `GPIO 5` | Pin 29 | L298N `IN1` |
| Left Motor Dir B | `GPIO 6` | Pin 31 | L298N `IN2` |
| Right Motor PWM | `GPIO 13` | Pin 33 | L298N `ENB` |
| Right Motor Dir A | `GPIO 20` | Pin 38 | L298N `IN3` |
| Right Motor Dir B | `GPIO 21` | Pin 40 | L298N `IN4` |
| **Grinder Relay (CH1)** | `GPIO 17` | Pin 11 | 2-Ch Relay `IN1` (Active-LOW) |
| **Flame Relay (CH2)** | `GPIO 27` | Pin 13 | 2-Ch Relay `IN2` (Active-LOW) |
| **E-Stop Sense (NC)** | `GPIO 22` | Pin 15 | E-Stop NC switch -> `GND` (Open = HALT) |
| Common Ground | `GND` | Pin 6 / 9 / 14 | Motor Driver `GND` + Relay `GND` + E-Stop |

### Option B: Arduino Uno/Nano USB Serial Bridge (`backend: "serial"`) — *Recommended for Field*

Flash `simpla_bot/firmware/simpla_motor_relay.ino` to an Arduino Uno or Nano, plug it into the Raspberry Pi via USB (`/dev/ttyUSB0`), and set `backend: "serial"` in `simpla_bot/config.yaml`. The Arduino enforces an independent **800 ms serial watchdog** and a **2.5 s hardware flame shutoff** even if the Raspberry Pi crashes!

| Function | Arduino Pin | Connect To |
|---|---:|---|
| Left Motor PWM (`ENA`) | `D5` (PWM) | L298N `ENA` |
| Left Motor `IN1` / `IN2` | `D7` / `D8` | L298N `IN1` / `IN2` |
| Right Motor PWM (`ENB`) | `D6` (PWM) | L298N `ENB` |
| Right Motor `IN3` / `IN4` | `D9` / `D10` | L298N `IN3` / `IN4` |
| **Grinder Relay (CH1)** | `D3` | Relay `IN1` (Active-LOW) |
| **Flame Relay (CH2)** | `D4` | Relay `IN2` (Active-LOW) |
| **Hardware E-Stop (NC)** | `D2` | E-Stop NC switch -> `GND` |

### Relay Output Power Wiring (Grinder + Flame)

```
  12V+ Battery ---> [MAIN FUSE 20A] ---> [PHYSICAL E-STOP NC] --+--> Motor Driver +12V
                                                                |
                                                                +--> Relay CH1 COM
                                                                |       | (NO) ---> Grinder Motor + ---> Battery GND
                                                                |
                                                                +--> Relay CH2 COM
                                                                        | (NO) ---> Gas Solenoid + Igniter ---> Battery GND
```
> **Note:** Always connect the grinder and flame valve to the relay's **NO (Normally Open)** terminal so that power loss, wire breakage, or reboot leaves both tools **OFF**.

---

## 4. Setting Up Sipeed MaixSense-A075V

1. **Physical Mounting:**
   - Mount the MaixSense-A075V centered at the front of the chassis, roughly **`350 mm – 500 mm`** above the soil (`camera_height_mm`), tilted downward by **`25° – 35°`** (`camera_pitch_deg`) so it sees both the crop/walls ahead AND weeds on the ground in front of the chassis.
   - Measure the horizontal distance from the camera lens to the grinder/flame tip and set `tool_offset_forward_mm` in `simpla_bot/config.yaml`:
     - If the tool sits **120 mm behind** the camera lens (mounted under the belly): set `tool_offset_forward_mm: -120.0`.
     - If the tool sits **150 mm in front** of the camera lens (mounted on a front boom): set `tool_offset_forward_mm: 150.0`.
2. **USB-RNDIS Connection (Raspberry Pi / Linux):**
   - Plug the MaixSense-A075V into a USB port on the Raspberry Pi.
   - It enumerates as a USB Ethernet adapter (`usb0` or `eth1`) with camera IP **`192.168.233.1`**.
   - Test connectivity:
     ```bash
     ping -c 3 192.168.233.1
     python3 -m simpla_bot.run_simpla_bot --check-maixsense
     ```
   - You should see live Left / Center / Right millimeter readouts, `go=XXXmm`, and corner detection status.

---

## 5. How MaixSense Decides Corners, "How Much to Go", & Weed Alignment

Every frame from `/getdeep` contains a 16-bit millimeter depth grid (`160x120` or `320x240`) plus an RGB JPEG image. `MaixSenseSpatialAnalyzer` splits the forward mid-band (`25%..68%` height) into three vertical zones:

```
    +-------------------+-------------------+-------------------+
    |     LEFT ZONE     |    CENTER ZONE    |    RIGHT ZONE     |
    |    (5% .. 33%)    |   (34% .. 66%)    |   (67% .. 95%)    |
    |    median: L mm   | median: C, p10: M |    median: R mm   |
    +-------------------+-------------------+-------------------+
```

### A. "How Much to Go" (`recommended_travel_mm`)
$$\text{recommended\_travel\_mm} = \max(0,\; C_{\text{median}} - \text{corner\_stop\_mm})$$
- As the bot drives forward, `recommended_travel_mm` counts down smoothly toward `0 mm`.
- On the final step before a wall/corner, the bot slows to `approach_speed_pct` and rolls **only the exact remaining millimeters** so it never overshoots.
- In wide-open fields with no end wall, `max_row_length_mm` acts as a fallback row-length counter.

### B. Corner & Row-End Detection Rules

| Condition Seen by MaixSense | Detected `corner_type` | Action (`suggested_turn`) |
|---|---|---|
| `min_center_mm <= obstacle_stop_mm` (320 mm) and NOT a corner | Obstacle Stop | Immediate **HALT** |
| `center_mm <= corner_stop_mm` (520 mm) AND `left_mm >= 1050 mm`, right blocked | `LEFT_CORNER` | Stop & pivot **-90° LEFT** |
| `center_mm <= corner_stop_mm` (520 mm) AND `right_mm >= 1050 mm`, left blocked | `RIGHT_CORNER` | Stop & pivot **+90° RIGHT** |
| `center_mm <= corner_stop_mm` AND both Left & Right open (T-junction) | More open side | Pivot **90°** toward wider side |
| `center_mm <= corner_stop_mm` AND both Left & Right blocked | `DEAD_END` | Stop & execute **180° U-TURN** |
| `center_mm >= 1850 mm` AND Left & Right also wide open | `ROW_END_HEADLAND` | Exited row -> **180° U-TURN** (alternating L/R) |

### C. Corridor Centering Steering
While driving straight, the bot compares `right_mm - left_mm` and applies a gentle proportional steering nudge (`steer_adjust_pct = clamp((R - L) * centering_kp, -18%, +18%)`) to stay centered between walls or crop beds.

### D. Weed Alignment Under Grinder / Flame (`dx_to_tool_mm`)
1. The RGB image scans the central ground strip for green weeds using **Excess-Green** (`ExG = 2G - R - B >= 38`).
2. The weed's pixel centroid is looked up in the synchronized ToF depth map (`slant_mm`).
3. Using camera height and downward pitch angle, `slant_mm` is projected onto horizontal ground distance ahead of the lens (`forward_from_cam_mm`).
4. Subtracting `tool_offset_forward_mm` gives the **exact forward travel in millimeters** (`dx_to_tool_mm`):
   $$\text{dx\_to\_tool\_mm} = \text{forward\_from\_cam\_mm} - \text{tool\_offset\_forward\_mm}$$
5. The bot rolls forward `dx_to_tool_mm` at slow `approach_speed_pct`, comes to a **100% full stop**, waits `settle_before_fire_s` (0.45 s), runs the grinder and/or flame, pauses `post_treat_pause_s`, and resumes driving.

---

## 6. Calibration Guide (Takes 5 Minutes)

Always calibrate on the actual surface (concrete floor for bench tests, soil for field runs):

### Step 1: Straight Distance Calibration (`speed_mm_per_sec_at_100pct`)
1. Place tape on the floor at the front wheel axle.
2. Run:
   ```bash
   python3 -m simpla_bot.run_simpla_bot --calibrate-drive 1000
   ```
3. Measure the actual distance traveled in millimeters (say it traveled `860 mm` instead of `1000 mm`).
4. Update `config.yaml`:
   $$\text{new\_speed} = \text{old\_speed} \times \frac{\text{actual\_mm}}{1000}$$
   Example: `520.0 * (860 / 1000) = 447.2`.
5. If either wheel spins backward, set `invert_left: true` or `invert_right: true`.

### Step 2: 90-Degree Turn Calibration (`turn_90_deg_sec_at_50pct`)
1. Mark the chassis heading on the floor and run:
   ```bash
   python3 -m simpla_bot.run_simpla_bot --calibrate-turn 90
   ```
2. If the bot turned `105°` instead of `90°`, decrease `turn_90_deg_sec_at_50pct`:
   $$\text{new\_turn\_sec} = \text{old\_turn\_sec} \times \frac{90}{\text{actual\_deg}}$$

### Step 3: Tool Offset Calibration (`tool_offset_forward_mm`)
1. Place a bright green target (leaf or green card) 600 mm ahead of the rover.
2. Run in dry-run mode (`--mode live --tool grinder` **without** `--arm-tools`).
3. When the bot stops and prints `DRY_RUN_RELAY grinder=1`, check if the green card is directly under the grinder blade / flame nozzle.
4. Adjust `tool_offset_forward_mm` by the remaining error in millimeters and re-verify.

---

## 7. Running Simpla Bot (Step-by-Step)

### Phase 1: Offline Bench Simulation (Zero Hardware Required)
```bash
python3 -m simpla_bot.run_simpla_bot --mode sim --tool both
```
Verify that you see cruising, weed alignment, dry-run grinder/flame activation, corner turns, and clean mission completion.

### Phase 2: MaixSense Live Sensor Verification
```bash
python3 -m simpla_bot.run_simpla_bot --check-maixsense
```
Wave a cardboard box in front of the sensor at 400 mm (should report corner/obstacle) and hold it on the left/right side to verify `LEFT_CORNER` vs `RIGHT_CORNER`.

### Phase 3: Hardware Dry-Run (Wheels On Blocks, Gas Valve Closed!)
1. Lift the drive wheels off the ground on blocks.
2. Keep propane/gas supply **CLOSED** and grinder power **UNPLUGGED**.
3. Verify E-Stop cuts power immediately when pressed.
4. Run without `--arm-tools`:
   ```bash
   python3 -m simpla_bot.run_simpla_bot --mode live --tool both
   ```
   Relays stay safely OFF (`dry_run: true`) while you confirm motor direction, corner turns, and MaixSense watchdog (unplug USB -> motors must stop within 1.0 s).

### Phase 4: Armed Field Operation
> **FIRE & MECHANICAL SAFETY:** Keep a Class ABC fire extinguisher within arm's reach, inspect all propane hoses with soapy water for leaks, clear dry straw/brush around test boundaries, and keep an operator walking beside the physical E-Stop at all times.

```bash
# Grinder only:
python3 -m simpla_bot.run_simpla_bot --mode live --tool grinder --arm-tools

# Flame only:
python3 -m simpla_bot.run_simpla_bot --mode live --tool flame --arm-tools

# Grinder cut followed by brief flame sear:
python3 -m simpla_bot.run_simpla_bot --mode live --tool both --arm-tools
```

---

## 8. Flame & Grinder Safety Interlocks Summary

| Layer | Protection | Setting |
|---|---|---|
| **Layer 1** | Safe Boot Default | `dry_run: true` — tools never fire unless `--arm-tools` is passed |
| **Layer 2** | Stationary Interlock | Software + Arduino firmware refuse relay ON while any wheel PWM != 0 |
| **Layer 3** | Flame Time Cap + Cooldown | Hard capped at `2.5 s` max burn (`max_flame_burn_s`) + `3.0 s` mandatory cooldown |
| **Layer 4** | Watchdogs | Camera timeout (`1.0 s`) + Arduino serial timeout (`0.8 s`) shut off motors & relays |
| **Layer 5** | Physical Hardware E-Stop | NC mushroom switch physically disconnects 12 V supply to motors, grinder, and gas valve |

---

## 9. Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| `--check-maixsense` fails to connect | USB-RNDIS interface has no IP on `192.168.233.x` | Run `ip a` and assign `sudo ip addr add 192.168.233.2/24 dev usb0 && sudo ip link set usb0 up` |
| Robot drives backwards or spins in circles | Motor polarity inverted | Set `invert_left: true` or `invert_right: true` in `simpla_bot/config.yaml` |
| Relays click ON at boot instead of OFF | Active-HIGH relay board vs active-LOW setting | Flip `relay_active_low: false` in `config.yaml` (and `RELAY_ACTIVE_LOW` in `.ino`) |
| Flame/grinder logs `Blocked: E-stop active` | NC E-Stop switch is open or unwired | Verify continuity between E-Stop pin and `GND` when button is released |
| Bot stops too early before walls | `corner_stop_mm` too large or camera pitched too low (seeing floor) | Raise camera pitch slightly (`20°–28°`) or reduce `corner_stop_mm` |
| Weed not detected on live camera | Pillow/OpenCV not installed on Pi to decode RGB JPEG | Run `pip install pillow` (lightweight) on Raspberry Pi |

---

## 10. Creating & Pushing the `simpla_bot` Git Branch

From your local clone of the repository, run either the helper script:
```bash
bash simpla_bot/setup_simpla_bot_branch.sh
git push -u origin simpla_bot
```
Or manually:
```bash
git checkout -b simpla_bot
git add simpla_bot/
git commit -m "Add simpla_bot standalone MaixSense + normal motor driver + flame/grinder stack"
git push -u origin simpla_bot
```
