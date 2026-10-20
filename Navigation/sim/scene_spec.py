#!/usr/bin/env python3
"""
Photo -> scene spec: turn an analysed field photo (BEV + detected rows) into a
JSON blob that the FreeCAD digital-twin builder (`photo_scene.py`) can consume
without needing OpenCV inside FreeCAD.

Input:  a BEV image (top-down warp of the field photo) + real field dimensions
Output: JSON with
  * plant-row positions (metres, world Y)
  * driving lanes       (midpoints BETWEEN the crop rows)
  * weed positions      (vegetation clusters in the gaps -> world X/Y)

The BEV keeps the real aspect ratio: pixels across the width map linearly to
the field width, pixels along the height to the field length.
"""
from __future__ import annotations

import json
import math
import os
import sys
from typing import Dict, List, Tuple

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from field_analyzer_reference import vegetation_mask  # noqa: E402
from field_pipeline import enhance_for_analysis  # noqa: E402


def row_bands(
    veg_mask: np.ndarray,
    expected_rows: int | None = None,
    band_frac: float = 0.25,
) -> List[float]:
    """X pixels of the vertical crop-row bands (column projection peaks)."""
    projection = veg_mask.mean(axis=0)  # green fraction per column
    peak = float(projection.max())
    threshold = peak * band_frac if peak > 0 else 0.0
    columns = projection >= threshold
    rows_px = []
    start = None
    for x, on in enumerate(columns):
        if on and start is None:
            start = x
        elif not on and start is not None:
            rows_px.append(((start + x - 1) / 2.0, x - start))
            start = None
    if start is not None:
        rows_px.append(((start + len(columns) - 1) / 2.0, len(columns) - start))

    # keep only bands whose width looks like a row (not the picture border)
    h_px = veg_mask.shape[0]
    return [
        center for center, width in sorted(rows_px)
        if width < h_px * 0.8
    ]


def weed_clusters(
    veg_mask: np.ndarray,
    rows_px: List[float],
    bev_w: int,
    min_area_px: int = 18,
    max_weeds: int = 60,
) -> List[Tuple[int, int, int]]:
    """
    Vegetation blobs OUTSIDE the crop-row bands = the weeds to zap.
    Returns (px_x, px_y, area) sorted by area (largest first).
    """
    mask = veg_mask.copy()
    half_w = 26  # row half-width estimation in BEV pixels
    for cx in rows_px:
        x0 = int(max(cx - half_w, 0))
        x1 = int(min(cx + half_w, bev_w))
        mask[:, x0:x1] = 0
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN,
                            np.ones((3, 3), np.uint8))
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    clusters = []
    for i in range(1, n):
        area = int(stats[i, cv2.CC_STAT_AREA])
        if area < min_area_px:
            continue
        px = stats[i, cv2.CC_STAT_LEFT] + stats[i, cv2.CC_STAT_WIDTH] / 2
        py = stats[i, cv2.CC_STAT_TOP] + stats[i, cv2.CC_STAT_HEIGHT] / 2
        clusters.append((float(px), float(py), area))
    clusters.sort(key=lambda c: -c[2])
    return clusters[:max_weeds]


def build_spec(
    bev_path: str,
    width_m: float,
    length_m: float,
    expected_rows: int | None = None,
    band_frac: float = 0.25,
    weed_min_area: int = 18,
    out_path: str | None = None,
) -> Dict:
    """Full photo -> scene spec conversion."""
    image = enhance_for_analysis(cv2.imread(bev_path))
    if image is None:
        raise ValueError(f"cannot read {bev_path}")
    bev_h, bev_w = image.shape[:2]

    veg, _cut = vegetation_mask(image)
    rows_px = row_bands(veg, expected_rows, band_frac=band_frac)
    if len(rows_px) < 2:
        raise ValueError(
            f"only {len(rows_px)} crop-row band(s) - not enough for a digital twin"
        )

    # pixels -> metres (world axes: X along length, Y across width)
    def pxw_to_y(px: float) -> float:
        return px / bev_w * width_m - width_m / 2.0

    def pxh_to_x_px(px: float) -> float:
        return px / bev_h * length_m - length_m / 2.0

    row_y = sorted(pxw_to_y(px) for px in rows_px)

    # lanes: midpoints BETWEEN neighbouring crop rows (the rover drives there)
    lanes_y = [
        (row_y[i] + row_y[i + 1]) / 2.0
        for i in range(len(row_y) - 1)
        if abs(row_y[i + 1] - row_y[i]) > 0.12
    ]

    weeds = []
    for px, py, _area in weed_clusters(veg, rows_px, bev_w, min_area_px=weed_min_area):
        wx = pxh_to_x_px(py)
        wy = pxw_to_y(px)
        # keep weeds only inside the driving corridors (never on plants)
        for lane in lanes_y:
            if abs(wy - lane) < 0.18:
                weeds.append((round(wx, 3), round(wy, 3)))
                break

    spec = {
        "width_m": round(width_m, 3),
        "length_m": round(length_m, 3),
        "rows_px": [round(px, 1) for px in rows_px],
        "row_y_m": [round(y, 3) for y in row_y],
        "row_spacing_m": round(
            abs(row_y[-1] - row_y[0]) / max(len(row_y) - 1, 1), 3
        ),
        "lanes_y_m": [round(y, 3) for y in lanes_y],
        "plant_spacing_m": 0.35,
        "weeds": weeds,
        "bev": os.path.basename(bev_path),
    }
    if out_path:
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "w") as fh:
            json.dump(spec, fh, indent=1)
    return spec


def latest_bev(outbox: str | None = None) -> str:
    import glob
    if not outbox:
        outbox = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "sim", "outbox",
        )
    files = sorted(glob.glob(os.path.join(outbox, "*_bev.jpg")))
    if not files:
        raise ValueError("no BEV artifact found - upload a photo first")
    return files[-1]


def main() -> None:
    import argparse
    ap = argparse.ArgumentParser(description="BEV photo -> FreeCAD scene spec")
    ap.add_argument("--bev", default=None, help="path to a *_bev.jpg artifact")
    ap.add_argument("--width", type=float, default=6.0)
    ap.add_argument("--length", type=float, default=8.0)
    ap.add_argument("--out", default="/tmp/photo_scene.json")
    args = ap.parse_args()

    bev = args.bev or latest_bev()
    spec = build_spec(bev, args.width, args.length, out_path=args.out)
    print("spec ->", args.out)
    for key, val in spec.items():
        if key != "weeds":
            print(f"  {key}: {val}")
    print(f"  weeds: {len(spec['weeds'])} at {spec['weeds'][:6]} ...")


if __name__ == "__main__":
    main()
