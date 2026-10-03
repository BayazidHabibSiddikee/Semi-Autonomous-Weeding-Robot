#!/usr/bin/env python3
"""
Field scanner: turn an aerial phone photo of a field into:
  - plant mask (green-plant vs soil)
  - detected crop rows (row centers in image coords)
  - a coverage path (waypoints to drive between crop rows)

Usage:
    python3 field_scanner.py <field.jpg> [--out field_plan.png]
"""
import argparse
import os

import cv2
import numpy as np


def segment_plants(bgr):
    """Green plant pixels via HSV (plants are green, soil is brown-grey)."""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    # green hue range 25..95, saturation > 25
    mask = cv2.inRange(hsv, (25, 25, 20), (95, 255, 255))
    # morphological cleanup
    k = np.ones((7, 7), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, k)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k)
    return mask


def find_row_centers(plant_mask):
    """Vertical projection of plants → peaks are crop rows."""
    projection = plant_mask.sum(axis=0) / 255.0
    peak = int(projection.max()) if projection.max() > 0 else 0
    if peak == 0:
        return [], projection
    threshold = peak * 0.25
    inside = projection > threshold
    segments = []
    i = 0
    while i < len(inside):
        if inside[i]:
            j = i
            while j < len(inside) and inside[j]:
                j += 1
            segments.append((i + j) // 2)
            i = j
        else:
            i += 1
    # merge segments that are closer than one "row pitch" (default 25 px)
    if segments:
        merged = [segments[0]]
        for s in segments[1:]:
            if s - merged[-1] < 25:
                merged[-1] = (merged[-1] + s) / 2
            else:
                merged.append(s)
        return [int(m) for m in merged], projection
    return [], projection


def plan_coverage(row_centers, width, height, margin=60, row_gap_px=40):
    """Boustrophedon (lawnmower) path along gaps between detected rows."""
    # gaps: left of first row, between rows, right of last row
    gaps = [0.5 * (width)]  # fallback single middle lane
    if row_centers:
        xs = row_centers
        lanes = []
        lanes.append(xs[0] / 2)
        for a, b in zip(xs, xs[1:]):
            lanes.append((a + b) / 2)
        lanes.append((xs[-1] + width) / 2)
        lanes = [l for l in lanes if l > margin / 2]
        gaps = lanes
    waypoints = []
    direction = 1
    for gx in gaps:
        if gx < 0 or gx > width:
            continue
        if direction == 1:
            waypoints.append((gx, margin))
            waypoints.append((gx, height - margin))
        else:
            waypoints.append((gx, height - margin))
            waypoints.append((gx, margin))
        direction *= -1
    # return to start
    if waypoints:
        waypoints.append(waypoints[0])
    return waypoints


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--out", default="field_plan.png")
    args = ap.parse_args()

    bgr = cv2.imread(args.image)
    if bgr is None:
        print("error: cannot read", args.image)
        return
    bgr = cv2.resize(bgr, (640, int(bgr.shape[0] * 640 / bgr.shape[1])))
    h, w = bgr.shape[:2]

    plants = segment_plants(bgr)
    rows, projection = find_row_centers(plants)
    path = plan_coverage(rows, w, h)

    vis = bgr.copy()
    # green plant mask overlay
    overlay = np.zeros_like(bgr)
    overlay[plants > 0] = (0, 255, 0)
    vis = cv2.addWeighted(vis, 0.75, overlay, 0.25, 0)

    for x in rows:
        cv2.line(vis, (int(x), 0), (int(x), h), (0, 255, 255), 2)
    pts = np.array(path, dtype=np.int32)
    if len(pts) >= 2:
        cv2.polylines(vis, [pts], False, (0, 0, 255), 4)
    for p in pts:
        cv2.circle(vis, tuple(p), 6, (255, 0, 0), -1)
    cv2.putText(vis, f"rows={len(rows)} waypoints={len(path)}",
                (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
    cv2.imwrite(args.out, vis)
    print(f"rows detected: {rows}")
    print(f"coverage waypoints: {path}")
    print(f"saved visualization -> {args.out}")


if __name__ == "__main__":
    main()
