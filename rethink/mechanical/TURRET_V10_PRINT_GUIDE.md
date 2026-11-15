# Turret V10 (V7 Restored) — 3D Print & Assembly Guide

> **Branch:** `design`  
> **Script:** `turret_v10_v7restored.py`  
> **FreeCAD Version:** 1.1.4 — all parts `isValid=True`

---

## 1. Key Engineering Fixes & Features

1. **Restored V7 Dual-Belt Cylinder Cage:**
   - 22 cm inner perimeter ($R_{in} = 35.01\text{ mm}$, $R_{out} = 37.01\text{ mm}$).
   - 20 mm vertical gap between upper and lower belt, 2 mm wall thickness.
   - Dual M3 screw clamp lugs at $-Y$ split seam for clamping onto the rotating core.
   - Restored exact V7 120° sector gear on top belt ($m = 1.5$, 52 full teeth equivalent, Pitch Radius = $39.0\text{ mm}$).
2. **90° Vertical 625zz Bearings on Radial Axles:**
   - 3 radial boss mounts + axle pins on lower belt at 120° spacing ($0^\circ, 120^\circ, 240^\circ$).
   - 625zz bearings ($5\text{ mm}$ ID, $16\text{ mm}$ OD, $5\text{ mm}$ width) stand vertically like wheels to roll smoothly in the C-channel track.
3. **Identical 6.0 mm Rotor Bore on Rear Gas Spur Gears:**
   - Dual 24-tooth gears ($m = 1.25$, Pitch Diameter = $30.0\text{ mm}$).
   - Direct 1:1 mesh in the vertical $X\text{-}Z$ plane located at $Y = -22.0\text{ mm}, Z = -45.0\text{ mm}$.
   - Center distance = $30.0\text{ mm}$ ($X = 0\text{ mm}$ for torch stem, $X = +30.0\text{ mm}$ for MG996R spline).
   - Uniform $6.0\text{ mm}$ central bore fits both the stripped brass valve rotor and MG996R output spline.
4. **Flush Lower Pods & Corrected 70° Struts:**
   - Four $70^\circ$ struts connect the outer wall of the 9 cm gun collar ($Z = -35.0\text{ mm}$, $R_{out} = 18.52\text{ mm}$) to the lower cylinder belt ($Z = 0.0\text{ mm}$, $R = 35.01\text{ mm}$).
   - Lower pods stay flush between $Z = -35.0\text{ mm}$ and $Z = -55.0\text{ mm}$, avoiding any collision with struts.
5. **Standard Actuator Mounts:**
   - **Left Pod (`Lower_Left_Grinder_Part`):** C-clamp sleeve sized for standard 12V RS-385 DC motor ($28.0\text{ mm}$ OD) with $2.5\text{ mm}$ split slit and M3 pinch bolt lug.
   - **Right Pod (`Lower_Right_MG996R_Part`):** Horizontal MG996R cradle with rear $(-Y)$ entry slot and mounting pocket.

---

## 2. 3D Printable Parts List

| Part Name | File | Material | Infill | Layer Height | Supports |
|---|---|---|---|---|---|
| **Upper Cylinder Cage V7** | `stl/Upper_Cylinder_Cage_V7.stl` | PETG / ABS | 35% Gyroid | 0.20 mm | Yes (under belt gap) |
| **Lower Right MG996R Pod** | `stl/Lower_Right_MG996R_Part.stl` | PETG / PLA+ | 40% Grid | 0.20 mm | Minimal |
| **Lower Left Grinder Pod** | `stl/Lower_Left_Grinder_Part.stl` | PETG / PLA+ | 40% Grid | 0.20 mm | None |
| **Gas Stem Gear (24T)** | `stl/Gas_Stem_Gear_24T_6mmBore.stl` | PLA+ / PETG | 60% Lines | 0.12–0.16 mm | None |
| **MG996R Gear (24T)** | `stl/MG996R_Gear_24T_6mmBore.stl` | PLA+ / PETG | 60% Lines | 0.12–0.16 mm | None |

> *Note:* `Three_Bearings_90deg_625zz` is included in the STEP models for CAD clearance verification only; do not 3D print bearings—use standard steel `625zz` miniature ball bearings.

---

## 3. Hardware & Fasteners Bill of Materials

| Component | Dimensions / Spec | Qty | Function |
|---|---|---|---|
| **Ball Bearings** | 625zz ($5\text{ mm} \times 16\text{ mm} \times 5\text{ mm}$) | 3 | Wheel rollers on lower belt |
| **Grinder Motor** | RS-385 / RS-390 ($27.7\text{--}28.0\text{ mm}$ OD) | 1 | Left pod weed cutting / grinding |
| **Valve Servo** | MG996R Metal Gear Servo | 1 | Right pod gas flow regulation |
| **M3 Machine Screws** | M3 $\times 20\text{ mm}$ Socket Head | 2 | Cylinder clamp lugs |
| **M3 Machine Screw** | M3 $\times 20\text{ mm}$ Socket Head | 1 | RS-385 grinder pinch clamp |
| **M3 Machine Screws** | M3 $\times 20\text{ mm}$ Socket Head | 2 | Lower pod split clamping tabs |
| **M3 Hex Nuts** | Standard M3 | 5 | Fastening clamp lugs and pod tabs |

---

## 4. Assembly Step-by-Step

1. **Install Bearings on Upper Cage:**
   - Push three $625\text{zz}$ bearings onto the radial pins ($5.0\text{ mm}$ pin) on the lower belt of `Upper_Cylinder_Cage_V7`.
   - Confirm each bearing rotates freely in the radial vertical plane.
2. **Mount RS-385 Grinder Motor:**
   - Insert RS-385 motor into the $28\text{ mm}$ bore of `Lower_Left_Grinder_Part`.
   - Thread an M3 $\times 20\text{ mm}$ screw through the outer lug and tighten into an M3 nut to clamp the motor body firmly.
3. **Mount MG996R Servo:**
   - Slide the MG996R body into the pocket of `Lower_Right_MG996R_Part` from the rear ($-Y$).
   - Ensure the output spline faces rearward ($-Y$) at $X = +30.0\text{ mm}, Z = -45.0\text{ mm}$.
4. **Join Lower Split Pods around Gun Collar:**
   - Place `Lower_Left_Grinder_Part` and `Lower_Right_MG996R_Part` around the 9 cm gun neck.
   - Fasten the front and rear M3 tabs with two M3 $\times 20\text{ mm}$ screws and nuts.
5. **Press-fit 1:1 Gas Flow Gears:**
   - Press `Gas_Stem_Gear_24T_6mmBore` onto the stripped $6.0\text{ mm}$ brass valve shaft ($X = 0\text{ mm}$).
   - Press `MG996R_Gear_24T_6mmBore` onto the MG996R servo horn/spline adapter ($X = +30.0\text{ mm}$).
   - Verify smooth 1:1 gear meshing with minimal backlash.
