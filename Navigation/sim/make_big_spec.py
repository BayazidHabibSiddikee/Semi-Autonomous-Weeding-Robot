#!/usr/bin/env python3
"""Derive the BIG field spec from the real photo-derived scene.

- scales layout x1.75 in length (8->14 m) and x2.0 in width (6->12 m)
- recentres rows/lanes in the wider field
- replaces the sparse photo weeds with visible clusters planted next to each
  lane (~2.2-2.6 m spacing, +/-0.14 m offset alternating sides, 2 plants each)
"""
import json, random

src = json.load(open("/tmp/photo_scene.json"))
SX, SY = 14.0 / src["length_m"], 12.0 / src["width_m"]   # 1.75, 2.0
L, W = src["length_m"] * SX, src["width_m"] * SY
MARGIN = max(float(src.get("headland_m", 0.2)), 0.25)

rows = sorted(y * SY for y in src["row_y_m"])
lanes = sorted(y * SY for y in src["lanes_y_m"])

def recentre(seq, half):
    span = (seq[-1] - seq[0]) / 2.0
    c = (seq[0] + seq[-1]) / 2.0
    off = 0.0 if abs(c) < 1e-6 else c      # shift so the span is centred on 0
    return [y - off for y in seq]

rows = recentre(rows, W / 2)
lanes = recentre(lanes, W / 2)

# driving range: leave room for the U-turn arc bulge
gaps = [lanes[i + 1] - lanes[i] for i in range(len(lanes) - 1)]
R_MAX = max(gaps) / 2.0
X_END = L / 2.0 - MARGIN - R_MAX

random.seed(7)
weeds = []
for li, ly in enumerate(lanes):
    x = -(X_END - 0.25) + random.uniform(0, 0.9)
    side = 1 if li % 2 == 0 else -1
    while x < X_END - 0.25:
        off = side * random.uniform(0.10, 0.17)
        n = random.choice((1, 2, 2, 2))
        for k in range(n):
            dx = random.uniform(-0.05, 0.05)
            dy = off + random.uniform(-0.035, 0.035)
            weeds.append([round(x + dx, 3), round(ly + dy, 3)])
        x += random.uniform(1.7, 2.2)

big = {
    "width_m": W, "length_m": L,
    "headland_m": MARGIN,
    "row_y_m": [round(y, 3) for y in rows],
    "lanes_y_m": [round(y, 3) for y in lanes],
    "row_spacing_m": round((rows[-1] - rows[0]) / (len(rows) - 1), 3),
    "plant_spacing_m": src["plant_spacing_m"],
    "weeds": weeds,
    "derived_from": "photo_scene.json", "x_end": round(X_END, 3),
    "r_max": round(R_MAX, 3),
}
json.dump(big, open("/tmp/big_field_spec.json", "w"), indent=1)
gaps = [round(g / 2, 3) for g in gaps]
LEG = 2 * X_END
import math
path_len = len(lanes) * LEG + math.pi * sum(g / 2 for g in gaps) if False else \
    len(lanes) * LEG + len(gaps) * math.pi * R_MAX
print(f"field {L}x{W}, rows {len(rows)}, lanes {len(lanes)}, weeds {len(weeds)} plants")
print(f"X_END {X_END:.2f} r_max {R_MAX:.3f} arc radii {gaps[:4]} ...")
print(f"path {path_len:.0f} m -> ~{path_len/3.2*12:.0f} frames @3.2 m/s 12 fps")
