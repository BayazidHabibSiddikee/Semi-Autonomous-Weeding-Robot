# 3-DOF Laser Arm — PRINT LIST (arm only, body already printed)

The body stays as-is. Only these parts get printed. Servo frames in the CAD
are 40.8 × 19.9 × 42 mm — exactly MG996R / DS3218, the same motors as the
body, so everything lines up 1:1.

## Print (PETG, 0.2 mm, 4 walls, 40% gyroid unless noted)

| # | File (step/) | Size | Orientation / notes |
|---|---|---|---|
| 1 | deck_mount_plate.stl | 100×80×6 | flat on bed. **Drill 2× Ø3.4 mm through the bosses at ±38 mm pitch**, bolts to the body deck (M3) — or match your body's existing deck holes |
| 2 | turret_plate.stl | Ø64×5 | flat |
| 3 | turret_brace.stl | 44×8×8 | flat |
| 4 | upper_link.stl | 160×8×30 w/ Ø16 lighten hole | flat; long part, 220 mm bed OK |
| 5 | upper_link_end_A.stl | Ø30×8 | flat |
| 6 | upper_link_end_B.stl | Ø30×8 | flat |
| 7 | forearm.stl | 140×8×30 | flat |
| 8 | forearm_end_A.stl | Ø26×8 | flat |
| 9 | forearm_end_B.stl | Ø26×8 | flat |
| 10 | forearm_cable_channel.stl | 140×8×6 | flat |
| 11 | shoulder_pivot_hub.stl | Ø24×2.5 | idler disc (PLA OK) |
| 12 | elbow_horn.stl | Ø24×2.5 | **glue onto the stock DS3218 metal horn**, don't trust printed splines |
| 13 | laser_mount_plate.stl | 36×40×6 | flat |
| 14 | laser_clamp_ring.stl | Ø28 OD×46 | on side, light supports |
| 15 | laser_lens_ring.stl | Ø13×4 | few perimeters |
| 16 | harness_clip.stl | 24×10×4 | trivial |

## Don't print — buy real
- yaw servo **MG996R** ×1, shoulder/elbow **DS3218** ×2 (digital, 20 kg·cm)
- **M8 steel rod** ×2 (Ø8×30) for shoulder + elbow shafts, printed shafts shear
- **DS3218 stock metal horns** for the actual drive faces
- M3 hardware: 4×M3×12 (deck bosses), 2×M3×25 (link pivots), servo flange screws, hot glue for horn discs
- **445 nm laser module + driver** — dark-colored printed parts only around it

## Assembly notes
- Mount order: deck plate → yaw servo under it → turret plate on servo horn →
  brace → shoulder servo lying across turret → upper link (horn drive side +
  hub idler side) → elbow servo hangs under the forearm head → forearm →
  wrist plate + clamp ring → laser in, focus ring on, harness clip holds wires
- Endpoint as designed: tip ~351 mm forward / 78 mm up, weeding pose reaches
  the ground ~285 mm ahead of the turret ✓ same numbers as the sim

Total ≈ 300 g, every part fits a 220×220 bed.
