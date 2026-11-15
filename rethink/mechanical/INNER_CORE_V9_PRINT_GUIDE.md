# Inner Core Turret V9 — 3D Print & Assembly Guide

> **Branch:** `design`  
> **Script:** `inner_core_turret_v9.py`  
> **FreeCAD:** 1.1.4 — all parts `isValid=True`

---

## V9 Fixes Summary (over V8)

| # | Bug in V8 | Fix in V9 |
|---|-----------|-----------|
| 1 | Strut bottom anchor on cylinder belt — struts cut through servo box | Struts now anchor at **gun-collar outer wall** (R=18.52 mm, Z=−35 mm) and angle UP at 70° → ΔR=12.74 mm for 35 mm vertical drop; pods kept strictly below Z=−35 |
| 2 | 625zz bearings generated flat (pancake orientation) | Bearings rotated **90° to vertical** — axle axis is radial outward (like a wheel) |
| 3 | Grinder mount = small blind hole | Open **C-clamp sleeve** (28 mm bore) with split slit + M3 pinch-bolt lug |
| 4 | MG996R mount = closed pocket | Open **pass-through rectangular window** (41×20.5 mm) with 4× M3 flange holes |

---

## Printable Parts (5 — print these)

| File | Layer Height | Infill | Supports | Material | Notes |
|------|-------------|--------|----------|----------|-------|
| `Inner_Cylinder_Cage_120degGear.stl` | 0.2 mm | 30% gyroid | Yes (belt gap) | PETG | Print cage upright; support the BELT_GAP void |
| `Inner_Right_Pod_MG996R_Cradle.stl` | 0.2 mm | 40% | Minimal | PETG | Print so window face is down; struts need no support |
| `Inner_Left_Pod_RS385_GrinderClamp.stl` | 0.2 mm | 40% | None | PETG | Print upright, split slit faces front |
| `Vertical_Gas_Cap_Gear_24T.stl` | 0.15 mm | 60% | None | PLA+ | Fine layer for tooth profile |
| `Vertical_MG996R_Gear_24T.stl` | 0.15 mm | 60% | None | PLA+ | Identical to gas-cap gear |

**Reference only (do NOT print):**
- `Vertical_Bearings_625zz.stl` — visual reference; use real **625zz bearings**
- `Gun_Collar_9cm.stl` — existing physical gun neck; use as fit test only

---

## Hardware Bill of Materials (per turret)

| Item | Spec | Qty | Notes |
|------|------|-----|-------|
| **625zz bearing** | ID=5 mm, OD=16 mm, W=5 mm | 3 | Mounted on radial axle pins; replace printed reference |
| M5 × 20 hex bolt | M5, 20 mm | 3 | Axle pin through bearing + boss |
| M5 nut | Standard | 3 | Lock on outer face |
| **RS-385 DC motor** | 27.7 mm dia, 2.3 mm shaft | 1 | Slides into 28 mm C-clamp bore |
| M3 × 20 hex bolt | M3, 20 mm | 1 | Pinch-bolt on grinder clamp lug |
| M3 nut | Standard | 1 | In lug pocket |
| **MG996R servo** | 40.7×20×36 mm body | 1 | Inserted from rear (−Y) through pass-through window |
| M3 × 12 hex bolt | M3, 12 mm | 4 | MG996R flange ears into cradle |
| M3 nut | Standard | 4 | Behind cradle plate |

---

## Strut Geometry (V9 — Verified)

```
Gun-collar outer top  → Lower belt outer
  R_start = 18.52 mm    R_end = 35.01 mm
  Z_start = −35 mm      Z_end = 0 mm
  ΔR = 12.74 mm         ΔZ = 35 mm
  Angle = arctan(35/12.74) = 70° from horizontal ✓
```

Right pod struts at: 30°, 0°, −30° (front-right quadrant)  
Left pod struts at: 150°, 180°, 210° (front-left quadrant)

---

## 625zz Bearing Installation

1. Press M5 × 20 bolt through the printed axle boss hole (5.4 mm dia) from the **inside** of the cylinder cage.
2. Slide 625zz bearing over the M5 bolt shank — bearing OD (16 mm) rests against the flange boss face.
3. Thread M5 nut on the outer tip — tighten until bearing spins freely but has zero axial play.
4. Repeat at all three 120°-spaced boss positions.

> The bearing axis is **radial** (pointing outward from cage centre), so the outer race face rolls against the C-channel track like a wheel.

---

## RS-385 Grinder Motor Installation

1. Slide RS-385 motor (27.7 mm dia) **straight down** (−Z) into the 28 mm C-clamp bore on the Left Pod.
2. Set motor shaft depth so the grinding tip protrudes the desired amount below the pod bottom.
3. Insert M3 × 20 bolt into the pinch-bolt lug hole and tighten until the slit closes enough to grip the motor — **do not overtighten** (cracks 28 mm bore wall at ~4 N·m).

---

## MG996R Servo Installation

1. Set servo to **90° centre position** via ESC tester or brief power pulse before mounting.
2. Slide MG996R **forward** (+Y direction) through the rear-open rectangular window (41×20.5 mm).
3. Align the two side-ear mounting flanges with the 4× M3 holes on the cradle face.
4. Install 4× M3 × 12 bolts through the flanges and thread M3 nuts on the back — snug but not stripped.
5. Press-fit the **Vertical_MG996R_Gear_24T** (30 mm pitch dia) onto the servo output horn. The gear meshes with **Vertical_Gas_Cap_Gear_24T** on the grey gas-cap pin, 30 mm centre-to-centre.

---

## Assembly Verification Checklist

- [ ] **Strut clearance:** No strut body contacts either pod wall — verify visually or in FreeCAD after import of STEP assembly.
- [ ] **Bearing orientation:** Each 625zz axle pin points radially outward; bearing spins freely in the radial-axial plane (like a wheel on a track).
- [ ] **RS-385 depth:** Motor shaft tip is 5–8 mm below pod bottom; pinch bolt grips motor with no rotation under hand torque.
- [ ] **MG996R shaft position:** Output shaft centre at X=+30 mm, Z=−43 mm, pointing −Y (rearward toward gas cap) ±1 mm.
- [ ] **Gear mesh:** 1:1 ratio (both 24T, Module 1.25); 30 mm centre distance; backlash < 0.3 mm when gears engaged by hand.

---

## File Locations

```
rethink/mechanical/
├── inner_core_turret_v9.py          ← FreeCAD macro (source)
├── Inner_Core_Turret_V9.FCStd       ← FreeCAD project file
├── INNER_CORE_V9_PRINT_GUIDE.md     ← this file
├── stl/
│   ├── Inner_Cylinder_Cage_120degGear.stl
│   ├── Inner_Right_Pod_MG996R_Cradle.stl
│   ├── Inner_Left_Pod_RS385_GrinderClamp.stl
│   ├── Vertical_Gas_Cap_Gear_24T.stl
│   └── Vertical_MG996R_Gear_24T.stl
└── step/
    ├── Inner_Cylinder_Cage_120degGear.step
    ├── Inner_Right_Pod_MG996R_Cradle.step
    ├── Inner_Left_Pod_RS385_GrinderClamp.step
    ├── Vertical_Gas_Cap_Gear_24T.step
    ├── Vertical_MG996R_Gear_24T.step
    └── Inner_Core_V9_Assembly.step   ← combined multi-body STEP
```
