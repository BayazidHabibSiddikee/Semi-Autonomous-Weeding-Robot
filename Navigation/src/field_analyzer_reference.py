#!/usr/bin/env python3
"""
Python mirror of the Android FieldAnalyzer (core/opencv/FieldAnalyzer.kt).

Purpose: validate the exact algorithm/parameters that were ported to Kotlin
before running it on a phone. Run:

    python3 Navigation/src/field_analyzer_reference.py Navigation/images/field_topview.jpeg
"""
import argparse
import sys

import cv2
import numpy as np

FALLBACK_EXG_THRESHOLD = 8
MERGE_FRACTION = 0.6


def vegetation_mask(bgr):
    b, g, r = cv2.split(bgr)
    exg = 2.0 * g.astype(np.int16) - r.astype(np.int16) - b.astype(np.int16)

    # Otsu on ExG scaled into 8 bit (0.25 * exg + 128)
    exg8 = np.clip(exg * 0.25 + 128.0, 0, 255).astype(np.uint8)
    otsu_value, _ = cv2.threshold(exg8, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    exg_cut = int(round((otsu_value - 128.0) * 4.0))
    final_cut = exg_cut if 1 <= exg_cut <= 250 else FALLBACK_EXG_THRESHOLD

    exg_mask = (exg > final_cut).astype(np.uint8) * 255

    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    hsv_mask = cv2.inRange(hsv, (15, 20, 20), (95, 255, 255))

    veg = cv2.bitwise_and(exg_mask, hsv_mask)
    veg = cv2.morphologyEx(veg, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    veg = cv2.morphologyEx(veg, cv2.MORPH_CLOSE, np.ones((15, 3), np.uint8))
    veg = cv2.morphologyEx(veg, cv2.MORPH_CLOSE, np.ones((3, 15), np.uint8))
    return veg, final_cut


def column_projection(mask):
    return (mask > 0).sum(axis=0) / mask.shape[0]


def segments_above(projection, threshold):
    segs = []
    i = 0
    n = len(projection)
    while i < n:
        if projection[i] > threshold:
            j = i
            while j < n and projection[j] > threshold:
                j += 1
            segs.append((i + j) // 2)
            i = j
        else:
            i += 1
    return segs


def merge_segments(segments, width, expected):
    if not segments:
        return []
    pitch = width / float(expected or len(segments))
    merge_dist = max(12.0, pitch * MERGE_FRACTION)
    merged = []
    for s in segments:
        if not merged:
            merged.append(float(s))
        elif s - merged[-1] < merge_dist:
            merged[-1] = (merged[-1] + s) / 2.0
        else:
            merged.append(float(s))
    return merged


def regularize(detected, width, expected):
    if not expected or expected <= 0:
        return detected
    if not detected:
        step = width / float(expected)
        return [(i + 0.5) * step for i in range(expected)]
    if len(detected) == expected:
        return detected
    step = width / float(expected)
    offsets = []
    for x in detected:
        slot = int(min(max((x / step) - 0.5, 0), expected - 1))
        offsets.append(x - (slot + 0.5) * step)
    median_offset = sorted(offsets)[len(offsets) // 2]
    median_offset = min(max(median_offset, -step * 0.35), step * 0.35)
    out = []
    for i in range(expected):
        nominal = (i + 0.5) * step + median_offset
        close = next((d for d in detected if abs(d - nominal) < step * 0.4), None)
        out.append(min(max(close if close is not None else nominal, 4.0), width - 4.0))
    return out


def detect_corners(mask):
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return []
    all_pts = np.vstack(contours)
    rect = cv2.minAreaRect(all_pts)
    box = cv2.boxPoints(rect)
    pts = sorted(box.tolist(), key=lambda p: p[1])
    top = sorted(pts[:2], key=lambda p: p[0])
    bottom = sorted(pts[2:], key=lambda p: p[0])
    return [top[0], top[1], bottom[1], bottom[0]]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--expected", type=int, default=None)
    ap.add_argument("--out", default="field_analyzer_out.png")
    args = ap.parse_args()

    bgr = cv2.imread(args.image)
    if bgr is None:
        print("cannot read", args.image)
        return 1

    veg, cut = vegetation_mask(bgr)
    proj = column_projection(veg)
    thr = proj.max() * 0.25
    segs = segments_above(proj, thr)
    merged = merge_segments(segs, bgr.shape[1], args.expected)
    rows = regularize(merged, bgr.shape[1], args.expected)
    corners = detect_corners(veg)

    print(f"ExG cut (Otsu)     : {cut}")
    print(f"segments           : {segs}")
    print(f"after merge        : {[round(m) for m in merged]}")
    print(f"rows (final)       : {[round(r) for r in rows]}")
    print(f"field corners      : {[[round(c) for c in p] for p in corners]}")

    vis = bgr.copy()
    for x in rows:
        cv2.line(vis, (int(x), 0), (int(x), vis.shape[0]), (0, 255, 255), 2)
    if len(corners) == 4:
        cv2.polylines(vis, [np.array(corners, np.int32)], True, (255, 0, 255), 3)
    cv2.imwrite(args.out, vis)
    print("saved ->", args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
