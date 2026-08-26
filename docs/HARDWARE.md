# Hardware Setup Guide

## Components List

### Computing
| Item | Model | Qty | Cost |
|------|-------|-----|------|
| SBC | Raspberry Pi 5 (8GB) | 1 | $80 |
| Storage | microSD 64GB A2 | 1 | $15 |
| Power | USB-C 5V/5A PSU | 1 | $12 |
| Cooler | Active cooler or fan | 1 | $10 |

### Camera
| Item | Model | Qty | Cost |
|------|-------|-----|------|
| Camera | OV5647/OV5647 USB camera | 1 | $25 |
| Lens | M12 wide-angle (90-120°) | 1 | $8 |
| Mount | Camera bracket + screws | 1 | $5 |

### Gantry
| Item | Model | Qty | Cost |
|------|-------|-----|------|
| Frame | 2020 aluminum extrusion | 4x 600mm, 2x 400mm | $40 |
| Brackets | 2020 corner brackets | 16 | $12 |
| Belts | GT2 timing belt (6mm) | 2m | $8 |
| Pulleys | GT2 20T pulley | 2 | $6 |
| Lead screws | T8 lead screw 300mm | 2 | $15 |
| Bearings | LM8UU linear bearings | 8 | $10 |
| Rails | 8mm smooth rod 400mm | 4 | $12 |

### Motors & Drivers
| Item | Model | Qty | Cost |
|------|-------|-----|------|
| Steppers | NEMA 17 (42mm, 1.8°) | 2 | $20 |
| Driver | A4988 or DRV8825 | 2 | $6 |
| Controller | RAMPS 1.4 | 1 | $12 |
| Arduino | Mega 2560 | 1 | $12 |

### Laser
| Item | Model | Qty | Cost |
|------|-------|-----|------|
| Laser | 450nm blue diode module | 1 | $80-200 |
| Lens | Focus lens (adjustable) | 1 | $15 |
| Driver | Constant current driver | 1 | $20 |
| MOSFET | IRF540N or logic-level | 1 | $3 |
| Heatsink | Aluminum + fan | 1 | $10 |
| Power | 12V/10A PSU | 1 | $20 |

### Safety
| Item | Model | Qty | Cost |
|------|-------|-----|------|
| Goggles | OD5+ @ 450nm | 1 pair | $30 |
| E-stop | Emergency stop button | 1 | $8 |
| Interlock | Door/magnetic switch | 1 | $5 |

**Total estimated cost: $420-670**

---

## Wiring Diagram

```
Raspberry Pi 5
├── USB ──→ Camera (OV5647)
├── USB ──→ Arduino Mega 2560
│              ├── RAMPS 1.4
│              │   ├── A4988 ──→ X Stepper (NEMA 17)
│              │   ├── A4988 ──→ Y Stepper (NEMA 17)
│              │   └── MOSFET ──→ Laser Driver ──→ Laser Diode
│              └── GPIO 23 ──→ Emergency Stop Button
│              └── GPIO 24 ──→ Safety Interlock Switch
└── GPIO 18 ──→ (alternative direct laser control)
```

---

## Assembly Steps

### 1. Build Gantry Frame
1. Cut 2020 extrusions to length
2. Assemble rectangular frame with corner brackets
3. Mount smooth rods on X and Y axes
4. Install linear bearings on carriage
5. Attach GT2 pulleys to stepper shafts
6. Thread belts through pulleys and attach to carriage

### 2. Mount Electronics
1. Attach RAMPS 1.4 to Mega 2560
2. Plug in A4988 drivers (set current limit to ~0.8A for NEMA 17)
3. Wire steppers to RAMPS (X motor, Y motor)
4. Wire laser MOSFET to RAMPS fan pin (M106)
5. Mount Raspberry Pi near the gantry
6. Connect Pi USB to Arduino USB

### 3. Mount Camera
1. Position camera directly above the center of the work area
2. Height: 400-600mm above ground (adjust for field of view)
3. Angle: pointing straight down (0° from vertical)
4. Secure mount — no vibration or wobble

### 4. Mount Laser
1. Position laser pointing straight down
2. Same height as camera or slightly offset
3. Connect driver to 12V PSU
4. Connect MOSFET gate to RAMPS fan output
5. Test at LOW power first

---

## Calibration Checklist

- [ ] Camera intrinsic calibration (checkerboard)
- [ ] Camera extrinsic calibration (ArUco markers)
- [ ] Gantry steps/mm calibration
- [ ] Laser focus adjustment
- [ ] Pixel-to-gantry mapping accuracy < 2mm
- [ ] Emergency stop tested
- [ ] Safety interlock tested
