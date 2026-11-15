# Inner Core Turret V8 — Print List & Verification Guide

This folder contains the **inner rotating assembly only** (no outer C-channel base ring, no top servo tower). Print and test-fit this sub-assembly first to verify gas gear alignment and strut clearance before committing to the full V7 base.

**CAD Script:** [`inner_core_turret_v8.py`](file:///home/sword/Documents/projects/weed-laser-robot/rethink/mechanical/inner_core_turret_v8.py)
**FreeCAD Project:** [`Inner_Core_Turret_V8.FCStd`](file:///home/sword/Documents/projects/weed-laser-robot/rethink/mechanical/Inner_Core_Turret_V8.FCStd)

---

## V8 Fixes vs V7

| Issue | V7 (old) | V8 (fixed) |
|---|---|---|
| Gas gear plane | Horizontal (Z-axis rotation) | **Vertical (Y-axis)** matching the grey cap's real rotation axis |
| MG996R shaft direction | Pointing sideways (+X) | **Pointing rearward (−Y)** parallel to grey gas cap |
| Strut geometry | Shallow, crowded at seam | **True ≈61° from horizontal**, anchored symmetrically away from X=0 split |
| Scope | Full assembly (too heavy to iterate) | **Inner core only** — fastest print-test cycle |

---

## Parts to Print (5 Pieces)

| File | Qty | Material | Layer | Walls | Infill | Key Notes |
|---|---|---|---|---|---|---|
| `Inner_Cylinder_Cage_120degGear.stl` | 1 | PETG | 0.16 mm | 5 | 40% Grid | Print upright (Z-axis). Sector teeth face +Y (front). Clamp lug at rear. |
| `Inner_Right_Pod_MG996R_Horiz.stl` | 1 | PETG / ABS | 0.20 mm | 4 | 30% Gyroid | Servo shaft through-hole at X=+30, runs rearward in −Y direction |
| `Inner_Left_Pod_MiniGrinder.stl` | 1 | PETG / ABS | 0.20 mm | 4 | 30% Gyroid | 25mm dia motor bore, flat-face down |
| `Vertical_Gas_Cap_Gear_24T.stl` | 1 | PETG / Nylon | 0.12 mm | 5 | 100% Solid | Fits over grey gas cap (22.4mm bore) — **measure your cap with calipers first!** |
| `Vertical_MG996R_Gear_24T.stl` | 1 | PETG / Nylon | 0.12 mm | 5 | 100% Solid | 3mm bore for MG996R shaft |

> [!IMPORTANT]
> **Measure your grey gas cap OD before printing** `Vertical_Gas_Cap_Gear_24T.stl`.
> Edit `GAS_CAP_DIA` on line ~31 of `inner_core_turret_v8.py` and re-run if your cap differs from 22.4 mm:
> ```bash
> freecadcmd rethink/mechanical/inner_core_turret_v8.py
> ```

---

## Coordinate Convention

```
        +Y  (Nozzle / Front)
        ↑
        │
-X ─────┼───── +X  (MG996R side)
        │
        ↓
        -Y  (Grey gas cap / Rear)

   Z = up / down (vertical)
```

- **Gas gears** sit at `Y = -28 mm` (behind gun collar rear face), extruded 9 mm into the page along Y.
- **MG996R shaft centre** is at `(X=+30, Y=-28, Z=-43)` pointing in the `−Y` direction into the gas cap gear.
- **Strut anchors** at top: `R = 38.01 mm` on the lower belt; at bottom: `R = 18.32 mm` on the gun collar.

---

## Post-Print Verification Checklist

1. **Gas Gear Mesh (`Vertical_Gas_Cap_Gear_24T` + `Vertical_MG996R_Gear_24T`):**
   - View from behind (`−Y`): both red and yellow gears are vertical, side by side at `X=0` and `X=+30 mm`.
   - Teeth must mesh without binding when you spin the gas cap by hand. If too tight → adjust `GAS_CAP_DIA` by +0.2 mm and reprint.

2. **Strut Clearance:**
   - Look from front or rear: 4 struts (2 per side) angle steeply inward from the lower belt to the gun collar.
   - No strut should cross within 3 mm of the `X=0` split plane. Use calipers to confirm clearance.

3. **Cylinder Bore Fit:**
   - Slide the printed cage over your gas torch cylinder. It should clamp finger-tight with the M3 bolt. If the bore is too tight → increase `CYL_PERIMETER` by 1-2 mm and regenerate.

4. **MG996R Pocket Fit:**
   - Slide the MG996R into the right pod. The servo body should sit flush with the rear face. The shaft hole at `X=+30` should align with the gear centre. If the pocket is tight → increase `mg_pocket` margins by 0.5 mm per side in the script.
