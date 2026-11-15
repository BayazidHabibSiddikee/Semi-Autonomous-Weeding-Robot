# Rethink: Complete Hybrid Weeding Turret & Rover Architecture

This folder contains the complete engineering package for the **Next-Generation Dual-Action Weeding Turret (Turret V7)** and its integrated electrical, mechanical, and embedded firmware architecture on branch [`design`](file:///home/sword/Documents/projects/weed-laser-robot).

---

## 1. System Overview & Context

In earlier iterations (see [`docs/mechanical/laser_arm/`](file:///home/sword/Documents/projects/weed-laser-robot/docs/mechanical/laser_arm/)), the platform targeted precision laser ablation using a 3-DOF articulated arm with a 445nm 2W blue laser diode. While optically effective on thin foliage, laser ablation requires prolonged dwell times per weed.

The **Rethink Architecture** transforms the vehicle into a **high-throughput, dual-action hybrid weeding platform**:
1. **Thermal Weeding (Flame + 10kV Electric Arc Ignitor):** A butane/propane weed-burning torch equipped with an MG996R servo gas metering valve and an optically-isolated high-voltage arc ignitor for rapid broad-spectrum scorching.
2. **Mechanical Weeding (12V High-RPM Grinder):** A miniature tungsten-carbide mechanical grinding cutter that physically shears and macerates stubborn taproots and woody weed stems.
3. **Rotary Cylinder Turret (V7 Mechanical Stage):** Both tools are housed inside a suspended lower pod rotated across a 120° targeting arc by an upper sector gear and high-torque 180° servo mounted on a vertical base tower.

```
+---------------------------------------------------------------------------------------+
|                               ROVER CHASSIS DECK                                      |
|                                                                                       |
|   +-------------------------------------------------------------------------------+   |
|   |                  TWO-SIDED CIRCULAR C-CHANNEL BASE RING                       |   |
|   |  - 4x Inward Chassis Mount Tabs (M4 at R=44mm, 45/135/225/315 deg)            |   |
|   |  - Internal Bearing Raceway Groove (R=42 to 51mm, captures 3x 120 deg bearings|   |
|   |  - INTEGRATED VERTICAL SERVO RISER TOWER (+X side, rises to Z = +30.0 mm)     |   |
|   +---------------------------------------+---------------------------------------+   |
|                                           |                                           |
|                   +-----------------------v-----------------------+                   |
|                   |    180° CYLINDER ROTATION SERVO (Z = +30mm)   |                   |
|                   |    Output Shaft at X = +51.0mm, Y = 0.0mm     |                   |
|                   |    16-Tooth Pinion Gear (Module 1.5, R=12.0mm)|                   |
|                   +-----------------------+-----------------------+                   |
|                                           | (Meshes at exact 51.0mm center dist)      |
|                   +-----------------------v-----------------------+                   |
|                   |      UPPER ROTATING CYLINDER CAGE (Z = +30mm) |                   |
|                   |  - 120° Sector Gear (Module 1.5, R=39.0mm)    |                   |
|                   |  - Dual 2mm Belts around 70.03mm Cylinder Bore |                   |
|                   |  - 3x Radial Bearing Axles at 120° on Lower   |                   |
|                   +-----------------------+-----------------------+                   |
|                                           |                                           |
|                     (35mm drop via 70° angled structural struts)                      |
|                                           |                                           |
|                   +-----------------------v-----------------------+                   |
|                   |     LOWER SPLIT WEEDING TOOLING POD (Z = -51) |                   |
|                   |  - Clamps around 28.65mm (9cm perimeter) Neck |                   |
|                   |  - Right (+X): MG996R Gas Servo (Shaft X=+30) |                   |
|                   |  - Left (-X):  12V Mini Grinder Motor (Dia 26)|                   |
|                   |  - Rear: 1:1 24T Gear Pair on Gas Valve Knob  |                   |
|                   +-----------------------------------------------+                   |
+---------------------------------------------------------------------------------------+
```

---

## 2. Directory Structure

```
rethink/
├── README.md                                      # Master system engineering document (this file)
├── mechanical/
│   ├── complete_turret_v7_master.py               # Parametric FreeCAD CAD script
│   ├── Master_Turret_V7_Complete.FCStd            # Native FreeCAD project file
│   ├── PRINT_LIST.md                              # 3D Printing parameters, materials, and hardware BOM
│   ├── stl/                                       # 9 Individual production-ready STL files
│   │   ├── Base_Right_Half_With_ServoTower.stl    # Base half with integrated Z=+30mm servo riser
│   │   ├── Base_Left_Half.stl                     # Complementary split base ring
│   │   ├── Upper_Cylinder_Cage_120degGear.stl     # Rotating cage with 120° sector gear (Mod 1.5)
│   │   ├── Three_Bearings_On_Lower_Ring.stl       # Triple bearing assembly model
│   │   ├── Top_Rotation_Motor_Pinion_16T.stl      # 16T Mod 1.5 pinion for 180° rotation servo
│   │   ├── Lower_Right_MG996R_Part.stl            # Lower pod right half (holds MG996R gas servo)
│   │   ├── Lower_Left_Grinder_Part.stl            # Lower pod left half (holds 12V grinder motor)
│   │   ├── Gas_Knob_Gear_24T.stl                  # 24T Mod 1.25 gear for torch gas needle valve
│   │   └── MG996R_Flame_Gear_24T.stl              # 24T Mod 1.25 gear for MG996R servo horn
│   └── step/                                      # Precision STEP models for CAM and mating
│       ├── ... (9 individual part STEPs)
│       └── Master_Turret_V7_Assembly.step         # Complete merged assembly STEP file
├── electrical/
│   ├── make_turret_schematic.py                   # Automated KiCad 9/10 schematic generator
│   ├── weeding_turret_electrical.kicad_sch        # KiCad schematic source (ERC verified)
│   ├── weeding_turret_electrical.pdf              # Vector rendered schematic document (A3)
│   ├── weeding_turret_schematic.png               # High-resolution schematic preview image
│   ├── weeding_turret.net                         # KiCad component wiring netlist
│   ├── WIRING_GUIDE.md                            # Comprehensive wiring, power domains & EMI guide
│   └── BOM.md                                     # Electrical Bill of Materials with ratings
└── firmware/
    ├── config.h                                   # Pin mappings, timers, safety thresholds
    └── weeding_turret_controller.ino              # Production ESP32 firmware with state machine
```

---

## 3. Mechanical Highlights (Turret V7)

### Vertical Riser Tower & Exact Center Mesh
In previous CAD revisions, the top 180° cylinder rotation servo lacked a mounting structure to position it at the height of the upper 120° sector gear. The Turret V7 base integrates a heavy-duty vertical riser pillar on `Base_Right_Half_With_ServoTower`:
- **Shaft Position:** Exact coordinate $X = +51.0\text{ mm}$, $Y = 0.0\text{ mm}$, $Z = +30.0\text{ mm}$.
- **Center-to-Center Mesh:**
  $$\text{Pitch Radius}_{\text{Ring}} = \frac{52 \times 1.5}{2} = 39.0\text{ mm}$$
  $$\text{Pitch Radius}_{\text{Pinion}} = \frac{16 \times 1.5}{2} = 12.0\text{ mm}$$
  $$\text{Center Distance} = 39.0\text{ mm} + 12.0\text{ mm} = 51.0\text{ mm}$$
  The pitch circles touch tangentially with zero radial offset.
- **Gear Ratio:** $\frac{52}{16} = 3.25 : 1$. A $180^\circ$ servo sweep articulates the cylinder turret through $\pm 27.7^\circ$ ($\sim 55.4^\circ$ total sweep) across the target field.

### Dual-Channel C-Groove Raceway
The base ring features an internal circular raceway ($R = 42\text{ mm}$ to $51\text{ mm}$, $Z = 2\text{ mm}$ to $8\text{ mm}$) with an open throat of $4\text{ mm}$. Three miniature radial ball bearings mounted at $120^\circ$ on the lower ring ride inside this groove, locking the cylinder against vertical and tilting moments while enabling effortless low-friction rotation.

### 1:1 Flame Control Gear Pair
At the rear of the torch, a 24-tooth spur gear (Module 1.25, Pitch Diameter $30.0\text{ mm}$) pressed over the torch valve knob meshes 1:1 with an identical 24-tooth gear on the MG996R servo horn (Center distance: $15 + 15 = 30.0\text{ mm}$). This provides micro-metering of the fuel gas supply.

---

## 4. Electrical Architecture & Anti-EMI Protections

### Power Distribution Domains
1. **`+12V_MAIN` (3S LiPo Battery 11.1V - 12.6V):** Direct raw bus powering L298N motor drivers, 12V grinding motor (switched via Relay CH2), LM7805 regulator, and 5V Buck converter.
2. **`+5V_LOGIC` (L298N Onboard Regulator):** Powers low-current logic: ESP32 `VIN`, HC-SR04 `VCC`, and Relay optocoupler LEDs. Stabilized by a dedicated **$1000\mu\text{F}$ 25V Low-ESR capacitor** across `VIN` and `GND` to buffer against Wi-Fi TX spikes.
3. **`+5V_BUCK` & `GND_BUCK` (Fully Isolated Domain):** Powered from a dedicated 0.5A buck converter feeding solely Relay `JD-VCC` and the 10kV Arc Module input. The `JD-VCC` jumper on the relay board is **removed**, achieving complete optical isolation and shielding the ESP32 from inductive spikes and high-voltage RF bursts.
4. **`+5V_SERVO` (Dedicated LM7805CV Regulator with Heatsink):** Supplies up to 1.5A peak current to the two high-torque servos (MG996R + 180° Turret Servo) with $10\mu\text{F}$ input and $100\mu\text{F} + 0.1\mu\text{F}$ output decoupling.

### Master Pinout Table

| ESP32 Pin | Connected Peripheral | Signal / Role | Notes |
|---|---|---|---|
| **GPIO 25** | L298N `ENA` | Left Channel PWM | Base motor speed regulation (0-255) |
| **GPIO 26** | L298N `IN1` | Left Direction 1 | Left 2 drive motors in parallel |
| **GPIO 27** | L298N `IN2` | Left Direction 2 | Left 2 drive motors in parallel |
| **GPIO 14** | L298N `ENB` | Right Channel PWM | Base motor speed regulation (0-255) |
| **GPIO 12** | L298N `IN3` | Right Direction 1 | Right 2 drive motors in parallel |
| **GPIO 13** | L298N `IN4` | Right Direction 2 | Right 2 drive motors in parallel |
| **GPIO 5** | HC-SR04 `TRIG` | Ultrasonic Trigger | 10µs pulse output |
| **GPIO 18** | HC-SR04 `ECHO` | Ultrasonic Echo | Protected via $1\text{k}\Omega / 2\text{k}\Omega$ voltage divider |
| **GPIO 19** | 180° Turret Servo | Cylinder Aiming PWM | Drives 16T pinion on 120° sector gear |
| **GPIO 21** | MG996R Servo | Gas Needle Valve PWM | Drives 24T rear flame control gear |
| **GPIO 22** | Relay Channel 1 | Arc Module Trigger | Active-LOW, triggers isolated 10kV arc |
| **GPIO 23** | Relay Channel 2 | Grinder Motor Trigger | Active-LOW, switches 12V cutter motor |

---

## 5. Firmware Execution Protocol

The controller firmware ([`weeding_turret_controller.ino`](file:///home/sword/Documents/projects/weed-laser-robot/rethink/firmware/weeding_turret_controller.ino)) enforces a **strictly sequential operational profile** to eliminate brownouts:

1. **Non-Blocking Safety Guard (60ms cycle):** Continuously ranges obstacles via HC-SR04. If an obstacle breaches $15\text{ cm}$, the robot immediately cuts base motor PWM, closes the gas valve, and de-energizes both relay channels.
2. **Smooth Turret Sweeps:** Step-by-step servo angle interpolation (8ms/deg) prevents violent shock loading on the 3D-printed teeth and damps inrush current.
3. **Sequential Thermal Weeding:**
   - Turret slews to target angle $\rightarrow$ settles for 150ms.
   - Gas valve opens to ignition setting $\rightarrow$ settles for 250ms.
   - Arc module pulses for $400\text{ ms}$ to strike torch flame.
   - Gas valve opens to full burn angle $\rightarrow$ dwells for prescribed burn duration.
   - Gas valve closes $\rightarrow$ flame extinguishes cleanly.
4. **Sequential Mechanical Weeding:**
   - Turret slews to target angle $\rightarrow$ settles.
   - 12V grinder spins up $\rightarrow$ performs cutting stroke for prescribed duration.
   - Grinder spins down.

---

## 6. How to Rebuild CAD & Electrical Assets

### Rebuilding CAD Models (STLs & STEPs):
```bash
freecadcmd rethink/mechanical/complete_turret_v7_master.py
```
Outputs native `Master_Turret_V7_Complete.FCStd`, 9 individual `.stl` files in `rethink/mechanical/stl/`, 9 individual `.step` files in `rethink/mechanical/step/`, and `Master_Turret_V7_Assembly.step`.

### Rebuilding KiCad Schematics (PDF, PNG, SVG, Netlist):
```bash
python3 rethink/electrical/make_turret_schematic.py
```
Runs KiCad ERC, generates `weeding_turret_electrical.pdf`, exports vector SVG, builds `weeding_turret.net`, and renders 200 DPI PNG preview `weeding_turret_schematic.png`.
