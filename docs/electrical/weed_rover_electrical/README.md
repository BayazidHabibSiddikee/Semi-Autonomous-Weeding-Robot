# Weed rover electrical (KiCad)

KiCad 9 project for the rover electronics. Open `weed_rover_electrical.kicad_sch`
with KiCad (GUI) — the schematic is self-contained (symbols are embedded, no
external libraries needed).

Files:
- `weed_rover_electrical.kicad_sch` — the schematic (ERC-clean, 0 errors)
- `weed_rover_electrical.pdf` — rendered sheet (A3)
- `weed_rover_schematic.png` — quick-preview image
- `weed_rover.net` — KiCad netlist (33 nets) for anyone wiring the harness
- `make_schematic.py` — regenerates everything headlessly

## Block summary

- **Power**: 3S LiPo (BT1) → main switch (SW1) → 15 A fuse (F1) → INA219
  battery monitor (U4, I2C 0x40) → +12VL rail → Mini560 5 V/5 A buck (U3) → Pi 5.
- **Compute**: Raspberry Pi 5 (U1) runs CV + mission planner; ESP32-WROOM-32E
  (U2) runs the real-time wheel loop and the safety gates. Link = UART
  (100 ms heartbeat, e-stop on silence).
- **Drive**: two MD13S motor drivers (U5/U6) → JST connector (J1) to the
  8-wheel drive. PWM_L/R + DIR_L/R from the ESP32.
- **Laser**: driver + nFET (U7) feeds the 445 nm 2 W diode (D1) at the arm tip.
  Gating is AND-ed: Pi request (`LASER_EN`, via ESP32) **and** the hardware key
  lock (`LASER_ON_HW`, SW2) must both be high.
- **Sensors**: 2× HC-SR04 (U8/U9, TRIG/ECHO) + 2× VL53L0X (U10/U11, I2C 0x29/0x2A
  with XSHUT pins) + INA219, all on the Pi's I2C bus. Buzzer (LS1), power LED
  (D2), and a latching emergency stop (SW3) that breaks the drive chain.

## Regenerating headlessly

`make_schematic.py` writes the `.kicad_sch` with pure-Python (no KiCad needed).
Then with a local KiCad:

```
kicad-cli sch erc weed_rover_electrical.kicad_sch
kicad-cli sch export pdf weed_rover_electrical.kicad_sch -o weed_rover_electrical.pdf
kicad-cli sch export netlist weed_rover_electrical.kicad_sch -o weed_rover.net
```

ERC result at last generation: `Found 20 violations` = 0 errors, only
20 "symbol library '' not installed" warnings, which are expected for embedded
symbols (the official KiCad demos behave the same way outside their dev tree).
