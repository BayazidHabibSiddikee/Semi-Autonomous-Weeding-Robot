"""
Pi-side field pipeline: photo + 4 corners -> BEV -> rows -> mission.

This is the heavy CV that used to live only in the phone app. Running it on
the Pi means:

  * the phone only has to capture a photo and tap 4 corners
  * the raw image never has to be processed on a slow phone
  * the Pi can re-run the analysis with different parameters without
    shipping a new APK

Steps
-----
  1. decode the uploaded photo
  2. perspective-warp the 4 selected corners into a top-down (BEV) image,
     scaled so the BEV keeps the real-world aspect ratio of the field
  3. segment the vegetation (ExG + Otsu + HSV + morphology)
  4. extract the crop rows
  5. turn the rows into a boustrophedon mission
"""
from __future__ import annotations

import base64
import math
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

from mission_planner import build_mission_json

# The analyzer lives in field_analyzer_reference (validated mirror of the
# Android FieldAnalyzer). Import defensively so the server still starts if
# OpenCV is missing.
try:
    from field_analyzer_reference import (
        column_projection,
        detect_corners,
        merge_segments,
        segments_above,
        vegetation_mask,
    )
    _HAVE_CV = True
except Exception:  # pragma: no cover
    _HAVE_CV = False


@dataclass
class FieldAnalysis:
    """Result of analysing one field photo."""

    bev_path: str = ""
    overlay_path: str = ""
    rows_m: List[float] = field(default_factory=list)
    row_pixels: List[int] = field(default_factory=list)
    field_corners_px: List[Tuple[float, float]] = field(default_factory=list)
    vegetation_ratio: float = 0.0
    exg_threshold: int = 0
    bev_width: int = 0
    bev_height: int = 0
    mission: Dict[str, Any] = field(default_factory=dict)
    warnings: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "rowsM": [round(r, 3) for r in self.rows_m],
            "rowPixels": self.row_pixels,
            "fieldCornersPx": [[round(x, 1), round(y, 1)] for x, y in self.field_corners_px],
            "vegetationRatio": round(self.vegetation_ratio, 4),
            "exgThreshold": self.exg_threshold,
            "bevWidth": self.bev_width,
            "bevHeight": self.bev_height,
            "mission": self.mission,
            "warnings": self.warnings,
        }


def decode_image(payload: str | bytes) -> np.ndarray:
    """Decode a base64 (or raw) JPEG/PNG into a BGR array."""
    if isinstance(payload, str):
        raw = base64.b64decode(payload)
    else:
        raw = payload
    buf = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("could not decode the uploaded image")
    return img


def warp_to_bev(
    image: np.ndarray,
    corners: List[Tuple[float, float]],
    width_m: float,
    length_m: float,
    target_width: int = 900,
) -> Tuple[np.ndarray, np.ndarray]:
    """
    Perspective-warp the 4 selected corners into a top-down view.

    The BEV keeps the real-world aspect ratio of the field, so a metre is the
    same number of pixels across and along the field.

    Returns (bev_image, homography) where the homography maps the *original*
    photo pixels to the BEV pixels.
    """
    if len(corners) != 4:
        raise ValueError("exactly 4 corner points are required")

    h_img, w_img = image.shape[:2]
    aspect = max(length_m, 1e-6) / max(width_m, 1e-6)   # length / width
    out_w = int(target_width)
    out_h = int(round(target_width * aspect))
    out_h = max(200, min(out_h, 4000))

    src = np.array([(float(x), float(y)) for x, y in corners], dtype=np.float32)
    dst = np.array(
        [
            (0.0, 0.0),
            (float(out_w), 0.0),
            (float(out_w), float(out_h)),
            (0.0, float(out_h)),
        ],
        dtype=np.float32,
    )

    matrix = cv2.getPerspectiveTransform(src, dst)
    bev = cv2.warpPerspective(
        image, matrix, (out_w, out_h), flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0),
    )
    return bev, matrix


def analyze_bev(bev: np.ndarray, expected_rows: Optional[int] = None) -> Dict[str, Any]:
    """Run the agricultural CV on a BEV image."""
    if not _HAVE_CV:
        raise RuntimeError("OpenCV pipeline unavailable on the Pi")

    veg, exg_cut = vegetation_mask(bev)
    projection = column_projection(veg)
    threshold = float(projection.max()) * 0.25 if projection.max() > 0 else 0.0
    segments = segments_above(projection, threshold)
    merged = merge_segments(segments, bev.shape[1], expected_rows)
    corners = detect_corners(veg)
    vegetation_ratio = float(np.count_nonzero(veg)) / float(bev.shape[0] * bev.shape[1])

    return {
        "rows_px": merged,
        "corners": corners,
        "vegetation_ratio": vegetation_ratio,
        "exg_threshold": int(exg_cut),
        "mask": veg,
    }


def build_overlay(bev: np.ndarray, rows_px: List[float], corners: List[Tuple[float, float]],
                  out_path: str) -> str:
    """Save a visualisation: rows (yellow), field corners (magenta)."""
    vis = bev.copy()
    for x in rows_px:
        cv2.line(vis, (int(x), 0), (int(x), vis.shape[0]), (0, 255, 255), 2)
    if len(corners) == 4:
        cv2.polylines(vis, [np.array(corners, np.int32)], True, (255, 0, 255), 3)
    cv2.putText(vis, f"rows={len(rows_px)}", (10, 25),
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    cv2.imwrite(out_path, vis)
    return out_path


def analyze_field_photo(
    image: np.ndarray,
    corners: List[Tuple[float, float]],
    width_m: float,
    length_m: float,
    expected_rows: Optional[int] = None,
    out_dir: str = ".",
    stem: str = "field",
) -> FieldAnalysis:
    """Full pipeline: photo + corners -> BEV -> rows -> mission."""
    result = FieldAnalysis()

    bev, _matrix = warp_to_bev(image, corners, width_m, length_m)
    result.bev_width = bev.shape[1]
    result.bev_height = bev.shape[0]

    bev_path = os.path.join(out_dir, f"{stem}_bev.jpg")
    os.makedirs(out_dir, exist_ok=True)
    cv2.imwrite(bev_path, bev)
    result.bev_path = bev_path

    analysis = analyze_bev(bev, expected_rows)
    rows_px = analysis["rows_px"]
    result.row_pixels = [int(round(x)) for x in rows_px]
    result.field_corners_px = [(float(c[0]), float(c[1])) for c in analysis["corners"]]
    result.vegetation_ratio = analysis["vegetation_ratio"]
    result.exg_threshold = analysis["exg_threshold"]

    # BEV pixels across the field width -> meters
    rows_m = [(x / max(bev.shape[1], 1)) * width_m for x in rows_px]
    result.rows_m = rows_m

    if not rows_m:
        result.warnings.append("no crop rows found - check the corner selection")
    if expected_rows and rows_m and abs(len(rows_m) - expected_rows) > 1:
        result.warnings.append(
            f"detected {len(rows_m)} rows but {expected_rows} were expected"
        )

    overlay_path = os.path.join(out_dir, f"{stem}_plan.jpg")
    build_overlay(bev, rows_px, analysis["corners"], overlay_path)
    result.overlay_path = overlay_path

    result.mission = build_mission_json(
        rows_m=rows_m,
        width_m=width_m,
        length_m=length_m,
    )
    return result
