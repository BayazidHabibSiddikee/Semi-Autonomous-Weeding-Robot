# Electrical Wiring & Power Architecture Guide

This guide describes the complete electrical schematic, power distribution rails, optical isolation, and noise suppression techniques for the **Autonomous Weeding Robot (Turret V7 + 4WD Base)**.

Schematic files available in [`rethink/electrical/`](file:///home/sword/Documents/projects/weed-laser-robot/rethink/electrical/):
- KiCad Source: [`weeding_turret_electrical.kicad_sch`](file:///home/sword/Documents/projects/weed-laser-robot/rethink/electrical/weeding_turret_electrical.kicad_sch)
- Printable Vector PDF: [`weeding_turret_electrical.pdf`](file:///home/sword/Documents/projects/weed-laser-robot/rethink/electrical/weeding_turret_electrical.pdf)
- Preview Image: [`weeding_turret_schematic.png`](file:///home/sword/Documents/projects/weed-laser-robot/rethink/electrical/weeding_turret_schematic.png)
- KiCad Netlist: [`weeding_turret.net`](file:///home/sword/Documents/projects/weed-laser-robot/rethink/electrical/weeding_turret.net)

---

## 1. Power Rail Topology

To eliminate microcontroller lockups caused by inductive motor spikes and 10,000V high-voltage arc ignition pulses, power is segmented into **3 isolated voltage domains**:

```
[3S LiPo Battery 11.1V - 12.6V] 
       │
       ├───> [Main Switch SW1] ───> [15A Fuse F1] ───> Rail: +12V_MAIN
       │                                                      │
       ├──────────────────────────────────────────────────────┼────────────────────────────────────────┐
       │                                                      │                                        │
       ▼                                                      ▼                                        ▼
[5V Buck Converter (0.5A)]                             [L298N Driver 12V In]                   [LM7805CV + Heatsink]
       │                                                      │ (onboard regulator)                    │
       ├── Rail: +5V_BUCK (Isolated)                          ├── Rail: +5V_LOGIC (~200mA)             ├── Rail: +5V_SERVO (1.5A)
       └── Rail: GND_BUCK (Isolated)                          │   (w/ 1000uF low-ESR cap)              └── Common GND
                                                              └── Common GND
```

### Rail Specifications

1. **`+12V_MAIN` (High Current Direct Rail):**
   - Supplies L298N Dual H-Bridge motor power stage.
   - Supplies Mini Grinding Motor (switched via Relay Channel 2).
   - Supplies LM7805CV linear regulator input.
   - Supplies 5V Buck Converter input.

2. **`+5V_LOGIC` (Clean Low-Current Rail, L298N Onboard Reg):**
   - Supplies ESP32 `VIN` pin (buffered with a $1000\mu\text{F}$ 25V capacitor across `VIN` and `GND`).
   - Supplies HC-SR04 ultrasonic sensor `VCC`.
   - Supplies 2-Channel Relay Module logic `VCC` (photodiode side).

3. **`+5V_BUCK` & `GND_BUCK` (Galvanically Isolated Domain):**
   - **Crucial:** Remove the `JD-VCC` jumper from the relay board!
   - Wire `+5V_BUCK` to Relay `JD-VCC` pin and Relay Channel 1 `COM`.
   - Wire `GND_BUCK` to Buck output negative, Relay `GND` (power side), and Arc Module `VIN-`.
   - **Do NOT connect `GND_BUCK` to system `GND`!** This complete optical isolation stops 10kV ignition transients from entering the ESP32 ground plane.

4. **`+5V_SERVO` (Dedicated Dynamic Motor Rail, LM7805CV with Heatsink):**
   - Converts 12V to 5V (1.5A peak).
   - Filtered with $10\mu\text{F}$ on input and $100\mu\text{F} + 0.1\mu\text{F}$ on output.
   - Supplies both high-torque servos (Top 180° cylinder rotation servo + MG996R gas valve servo).
   - Sequential firmware execution ensures only one servo steps at any instant, keeping thermal dissipation on the LM7805 under 3.5 Watts.

---

## 2. Complete Interconnect & Pinout Table

| Subsystem | Module Pin | Connected To | Signal / Wire Type | Function / Engineering Notes |
|---|---|---|---|---|
| **Power** | Battery `+` | Switch `SW1` | 16 AWG Red | 3S LiPo positive lead |
| **Power** | Battery `-` | Common `GND` | 16 AWG Black | Central negative star ground |
| **Power** | `SW1` out | Fuse `F1` | 16 AWG Red | 15A Automotive Blade Fuse holder |
| **Power** | `F1` out | `+12V_MAIN` | 16 AWG Red | Protected system 12V distribution bus |
| **ESP32** | `VIN` | `+5V_LOGIC` | 22 AWG Red | Power input (from L298N 5V terminal) |
| **ESP32** | `GND` | Common `GND` | 22 AWG Black | Common logic ground |
| **Capacitor** | `+` / `-` | `+5V_LOGIC` / `GND` | Short leads | $1000\mu\text{F}$ 25V buffer across ESP32 VIN/GND |
| **Base Drive** | `ENA` | ESP32 `GPIO 25` | 24 AWG Signal | PWM Left speed control (Channel 0) |
| **Base Drive** | `IN1` | ESP32 `GPIO 26` | 24 AWG Signal | Left Motors Direction Bit 1 |
| **Base Drive** | `IN2` | ESP32 `GPIO 27` | 24 AWG Signal | Left Motors Direction Bit 2 |
| **Base Drive** | `ENB` | ESP32 `GPIO 14` | 24 AWG Signal | PWM Right speed control (Channel 1) |
| **Base Drive** | `IN3` | ESP32 `GPIO 12` | 24 AWG Signal | Right Motors Direction Bit 1 |
| **Base Drive** | `IN4` | ESP32 `GPIO 13` | 24 AWG Signal | Right Motors Direction Bit 2 |
| **Base Drive** | `OUT1`, `OUT2` | Left 2 Motors | 18 AWG Pair | Wired in parallel (front-left + rear-left) |
| **Base Drive** | `OUT3`, `OUT4` | Right 2 Motors | 18 AWG Pair | Wired in parallel (front-right + rear-right) |
| **Ultrasonic** | `VCC`, `GND` | `+5V_LOGIC`, `GND` | 24 AWG Pair | Sensor logic supply |
| **Ultrasonic** | `TRIG` | ESP32 `GPIO 5` | 24 AWG Signal | 10 microsecond trigger pulse |
| **Ultrasonic** | `ECHO` | Resistor $1\text{k}\Omega$ | 24 AWG Signal | Input to $1\text{k}\Omega / 2\text{k}\Omega$ divider network |
| **Divider** | Midpoint | ESP32 `GPIO 18` | 24 AWG Signal | Clamped 3.33V pulse to protect ESP32 pin |
| **Divider** | Low side | Common `GND` | 24 AWG Ground | Ground return of $2\text{k}\Omega$ resistor |
| **Turret Servo**| `SIG` | ESP32 `GPIO 19` | 24 AWG Signal | 50 Hz PWM position pulse |
| **Turret Servo**| `VCC`, `GND` | `+5V_SERVO`, `GND` | 22 AWG Pair | Powered from LM7805 regulator |
| **Gas Servo** | `SIG` | ESP32 `GPIO 21` | 24 AWG Signal | 50 Hz PWM position pulse (MG996R) |
| **Gas Servo** | `VCC`, `GND` | `+5V_SERVO`, `GND` | 22 AWG Pair | Powered from LM7805 regulator |
| **Relay Logic**| `VCC`, `GND` | `+5V_LOGIC`, `GND` | 24 AWG Pair | Supplies optocoupler input LEDs |
| **Relay Logic**| `IN1` | ESP32 `GPIO 22` | 24 AWG Signal | Active-LOW Arc trigger control |
| **Relay Logic**| `IN2` | ESP32 `GPIO 23` | 24 AWG Signal | Active-LOW Grinder trigger control |
| **Relay Power**| `JD-VCC` | `+5V_BUCK` | 20 AWG Red | Isolated coil supply (Jumper REMOVED!) |
| **Relay Power**| `GND` (pwr) | `GND_BUCK` | 20 AWG Black | Isolated buck converter ground return |
| **Relay CH1** | `COM` | `+5V_BUCK` | 20 AWG Red | Power input to Arc relay contact |
| **Relay CH1** | `NO` | Arc Module `VIN+` | 20 AWG Red | Switched power to Arc module |
| **Arc Module** | `VIN-` | `GND_BUCK` | 20 AWG Black | Isolated return path |
| **Arc Snubber**| 1N4007 Diode| Across `VIN+` & `VIN-`| Diode Leads | Cathode to `VIN+`, Anode to `VIN-` |
| **Relay CH2** | `COM` | `+12V_MAIN` | 18 AWG Red | Power input to Grinder relay contact |
| **Relay CH2** | `NO` | Grinder `M+` | 18 AWG Red | Switched 12V to cutter motor |
| **Grinder Mtr**| `M-` | Common `GND` | 18 AWG Black | Main ground return |
| **Grinder Flyback**| 1N4007 Diode| Across `M+` & `M-` | Diode Leads | Cathode to `M+`, Anode to `M-` |
| **Grinder RF** | $0.1\mu\text{F}$ Cap | Across `M+` & `M-` | Ceramic Leads | High frequency brush spark filter |

---

## 3. High-Voltage Arc EMI Mitigation Protocol

1. **Jumper Removal:** The plastic shunt bridging `VCC` and `JD-VCC` on the relay board **must be permanently removed**. Failure to remove this jumper will tie the noisy arc ground directly to the ESP32 ground, crashing the chip within 50ms of firing.
2. **Spark Gap Spacing:** Set the high-voltage electrode gap at the burner nozzle to between **3.0 mm and 4.5 mm**. Gaps exceeding 5 mm place excessive dielectric stress on the transformer windings.
3. **Physical Wire Separation:** Run the twin high-voltage output silicone leads directly to the torch nozzle without passing near any servo wires, motor leads, or the ultrasonic sensor cable. Maintain at least $30\text{ mm}$ clearance.
