# 3D Printing & Assembly Guide — Weeding Turret V7

This guide outlines manufacturing parameters, material selection, print settings, and hardware fasteners for the 9 parts comprising the **Complete Weeding Turret V7**.

All individual STLs are located in [`rethink/mechanical/stl/`](file:///home/sword/Documents/projects/weed-laser-robot/rethink/mechanical/stl/) and parametric CAD STEPs in [`rethink/mechanical/step/`](file:///home/sword/Documents/projects/weed-laser-robot/rethink/mechanical/step/).

---

## 1. Printable Parts Manifest

| Part File (`.stl`) | Qty | Recommended Material | Layer Height | Perimeters (Walls) | Infill | Print Notes / Orientation |
|---|---|---|---|---|---|---|
| `Base_Right_Half_With_ServoTower.stl` | 1 | PETG / ABS / ASA | 0.20 mm | 4 walls (1.6mm) | 30% Gyroid | Flat face down (Z=0). Enables vertical tower rigidity. |
| `Base_Left_Half.stl` | 1 | PETG / ABS / ASA | 0.20 mm | 4 walls (1.6mm) | 30% Gyroid | Flat face down. Mirrors right base. |
| `Upper_Cylinder_Cage_120degGear.stl` | 1 | PETG / Tough PLA | 0.16 mm | 5 walls (2.0mm) | 40% Grid | Print vertical (bearing axles facing up). High layer adhesion needed for 120° sector teeth. |
| `Three_Bearings_On_Lower_Ring.stl` | 3 | PETG / POM / Nylon | 0.12 mm | 4 walls | 100% Solid | Or replace with standard miniature 683 / MR115 / 623 bearings with 4.5mm thickness. |
| `Top_Rotation_Motor_Pinion_16T.stl` | 1 | PETG / Nylon | 0.12 mm | 5 walls | 100% Solid | Print flat on gear face. Fine layer height ensures accurate Module 1.5 gear tooth profile. |
| `Lower_Right_MG996R_Part.stl` | 1 | PETG / ABS | 0.20 mm | 4 walls (1.6mm) | 30% Gyroid | Print with gun neck semi-circle facing upward. |
| `Lower_Left_Grinder_Part.stl` | 1 | PETG / ABS | 0.20 mm | 4 walls (1.6mm) | 30% Gyroid | Flat face down. 26mm dia motor clamp bore. |
| `Gas_Knob_Gear_24T.stl` | 1 | PETG / PLA+ | 0.16 mm | 4 walls | 50% Gyroid | Fits onto 22.2 mm rear gas torch knob. |
| `MG996R_Flame_Gear_24T.stl` | 1 | PETG / PLA+ | 0.16 mm | 4 walls | 50% Gyroid | Mounts to 25T standard MG996R servo horn disc. |

---

## 2. Hardware Bill of Materials (Mechanical)

| Item | Specification | Qty | Application |
|---|---|---|---|
| **Base Joining Screws** | M3 × 20 mm Socket Head Cap Screw + M3 Locknuts | 2 | Clamps Left & Right base halves together |
| **Chassis Mounting Screws** | M4 × 16 mm Hex/Button Head Screws + M4 Washers | 4 | Fastens base tabs through rover deck plate |
| **Upper Cage Clamp Bolts** | M3 × 25 mm Socket Head Cap Screws + M3 Nuts | 2 | Clamps upper & lower belts around cylinder body |
| **Lower Pod Clamp Bolts** | M3 × 25 mm Socket Head Cap Screws + M3 Nuts | 2 | Clamps front and rear tabs around 28.65 mm gun neck |
| **Bearing Axle Pins** | M3 × 12 mm Stainless Steel Dowel Pins or Screws | 3 | Retains radial bearings in cage raceway bosses |
| **Radial Ball Bearings** | Miniature Bearings (OD 15 mm, ID 6 mm, Width 4.5 mm) | 3 | Rides inside base C-channel raceway groove |
| **Servo Mounting Hardware** | M3 × 10 mm Screws + M3 Tapped Brass Heat-set Inserts | 8 | Secures top rotation servo and bottom MG996R |
| **Grinder Motor Clamp** | M3 × 16 mm Screw + Nut | 1 | Cinches grinder motor sleeve clamp tight |

---

## 3. Assembly Sequence

1. **Base Ring Assembly:**
   - Slide the Left and Right base halves around the cylinder raceway.
   - Insert M3 × 20 mm bolts through the front/rear ear lugs and tighten with locknuts.
   - Secure the assembled base to the robot chassis deck using 4× M4 bolts at the 45°, 135°, 225°, and 315° tab positions ($R = 44\text{ mm}$).

2. **Upper Cage & Turret Drive:**
   - Press the 3 ball bearings onto their 120° spaced axle bosses on the lower ring.
   - Slide the upper cage down into the base C-channel raceway so the bearings engage the internal groove.
   - Slip the cylinder tube inside the cage bore ($70.03\text{ mm}$ dia) and tighten the dual M3 clamp bolts.
   - Mount the 180° rotation servo into the vertical tower pocket at $Z = +30\text{ mm}$.
   - Press the 16T pinion gear onto the servo output horn; verify mesh with the 120° sector gear at exact $51.0\text{ mm}$ center-to-center distance.

3. **Lower Pod (Weeding Tooling Head):**
   - Mate the Lower Right (MG996R mount) and Lower Left (Grinder mount) pods around the $28.65\text{ mm}$ torch gun neck.
   - Fasten the front and rear clamp tabs with M3 × 25 mm screws.
   - Mount the MG996R servo into the right cradle with its shaft positioned at $X = +30.0\text{ mm}$.
   - Press the 24T Gas Knob Gear over the torch gas valve (22.2 mm dia) and the 24T Servo Gear onto the MG996R servo horn.
   - Insert the mini grinding motor into the left bore (26 mm dia) and tighten its retention clamp.
