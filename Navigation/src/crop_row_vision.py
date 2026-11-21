"""
Lightweight Crop-Row Perception Pipeline for Raspberry Pi Navigation Server.

Computes real Excess-Green (ExG = 2G - R - B) vegetation segmentation on incoming
camera frames (MaixSense MJPEG / USB cam / Android POST /image) to extract:
  - Near-ROI and Far-ROI vegetation density ratios
  - Left and right crop-band centroids & furrow centerline
  - Lateral offset error (m) and heading error (rad)
  - Visual row-end confidence (0.0..1.0) when far-ROI vegetation opens to headland soil

Supports OpenCV (cv2) when installed, falls back to Pillow + NumPy, and safely
returns `decoded=False` on minimal/non-image payloads without crashing the Pi loop.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import io
import math
from typing import Any

try:
    import numpy as np
except ImportError:  # pragma: no cover
    np = None  # type: ignore[assignment]

try:
    import cv2  # type: ignore[import-not-found]
except ImportError:
    cv2 = None

try:
    from PIL import Image as PILImage  # type: ignore[import-not-found]
except ImportError:
    PILImage = None


@dataclass
class CropRowVisionResult:
    decoded: bool
    analysis_source: str
    image_width: int
    image_height: int
    green_ratio_near: float
    green_ratio_far: float
    lateral_error_m: float
    heading_error_rad: float
    visual_row_end_conf: float
    row_end_detected: bool
    confidence: float
    furrows: list[dict[str, float]]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _decode_rgb_array(frame_bytes: bytes):
    """Decode JPEG/PNG bytes into an HxWx3 uint8 RGB numpy array (or None if undecodable)."""
    if not frame_bytes or np is None:
        return None, "no_numpy"

    if cv2 is not None:
        try:
            buf = np.frombuffer(frame_bytes, dtype=np.uint8)
            bgr = cv2.imdecode(buf, cv2.IMREAD_COLOR)
            if bgr is not None and bgr.size > 0:
                rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
                return rgb, "opencv_exg"
        except Exception:
            pass

    if PILImage is not None:
        try:
            with PILImage.open(io.BytesIO(frame_bytes)) as img:
                rgb_img = img.convert("RGB")
                rgb = np.asarray(rgb_img, dtype=np.uint8)
                if rgb.ndim == 3 and rgb.shape[2] >= 3 and rgb.size > 0:
                    return rgb[:, :, :3], "pillow_exg"
        except Exception:
            pass

    return None, "undecodable_frame"


def analyze_crop_row_frame(
    frame_bytes: bytes,
    *,
    row_width_m: float = 0.60,
    exg_threshold: float = 22.0,
) -> CropRowVisionResult:
    """
    Analyze a single RGB/JPEG/PNG camera frame for crop-row alignment and furrow end.

    Returns a CropRowVisionResult. If the payload cannot be decoded as an image
    (e.g., empty/minimal test marker), `decoded` is False and zeroed safe defaults
    are returned so callers know no visual measurement was extracted.
    """
    rgb, source = _decode_rgb_array(frame_bytes)
    if rgb is None or np is None:
        return CropRowVisionResult(
            decoded=False,
            analysis_source=source,
            image_width=0,
            image_height=0,
            green_ratio_near=0.0,
            green_ratio_far=0.0,
            lateral_error_m=0.0,
            heading_error_rad=0.0,
            visual_row_end_conf=0.0,
            row_end_detected=False,
            confidence=0.0,
            furrows=[],
        )

    height, width = int(rgb.shape[0]), int(rgb.shape[1])
    if height < 8 or width < 8:
        return CropRowVisionResult(
            decoded=False,
            analysis_source="frame_too_small",
            image_width=width,
            image_height=height,
            green_ratio_near=0.0,
            green_ratio_far=0.0,
            lateral_error_m=0.0,
            heading_error_rad=0.0,
            visual_row_end_conf=0.0,
            row_end_detected=False,
            confidence=0.0,
            furrows=[],
        )

    # Downsample large frames to <= 160px wide for fast <5 ms Raspberry Pi processing
    step_x = max(1, width // 160)
    step_y = max(1, height // 120)
    small = rgb[::step_y, ::step_x, :].astype(np.float32)
    sh, sw = small.shape[0], small.shape[1]

    # Excess Green index: ExG = 2*G - R - B
    exg = 2.0 * small[:, :, 1] - small[:, :, 0] - small[:, :, 2]
    veg_mask = (exg > exg_threshold) & (small[:, :, 1] > 40.0)

    # Horizon cut at top 22%, Far ROI = [22%..55%], Near ROI = [55%..100%]
    y_horizon = int(sh * 0.22)
    y_mid = int(sh * 0.55)

    far_roi = veg_mask[y_horizon:y_mid, :]
    near_roi = veg_mask[y_mid:, :]

    green_ratio_far = float(np.mean(far_roi)) if far_roi.size > 0 else 0.0
    green_ratio_near = float(np.mean(near_roi)) if near_roi.size > 0 else 0.0

    # Split Near ROI into left and right halves to locate the two flanking crop ridges
    half_x = sw // 2
    left_band = near_roi[:, :half_x]
    right_band = near_roi[:, half_x:]

    xs_left = np.where(left_band)[1]
    xs_right = np.where(right_band)[1] + half_x

    left_cx_norm = float(np.mean(xs_left) / sw) if xs_left.size >= 4 else 0.25
    right_cx_norm = float(np.mean(xs_right) / sw) if xs_right.size >= 4 else 0.75

    # Furrow centerline lies midway between left and right crop ridges
    furrow_center_norm = 0.5 * (left_cx_norm + right_cx_norm)
    pixel_offset_norm = furrow_center_norm - 0.5  # negative = furrow left of camera center
    lateral_error_m = max(-0.5, min(0.5, pixel_offset_norm * row_width_m * 1.4))

    # Estimate heading error from Far ROI vs Near ROI furrow center shift
    far_left = np.where(far_roi[:, :half_x])[1]
    far_right = np.where(far_roi[:, half_x:])[1] + half_x
    if far_left.size >= 4 and far_right.size >= 4:
        far_center_norm = 0.5 * (float(np.mean(far_left)) + float(np.mean(far_right))) / sw
        heading_error_rad = max(-0.6, min(0.6, math.atan2(far_center_norm - furrow_center_norm, 0.45)))
    else:
        heading_error_rad = 0.0

    # Visual row-end confidence: high when Far ROI green disappears (< 3%) while we have valid image contrast
    # Distinguish "open headland ahead" (low far green) from "dense canopy ahead" (high far green)
    far_depletion = max(0.0, min(1.0, (0.08 - green_ratio_far) / 0.08))
    if green_ratio_near >= 0.03:
        # Still seeing near crop rows but far rows ended -> strong row-end approach signal
        visual_row_end_conf = round(0.25 + 0.75 * far_depletion, 3) if far_depletion > 0.45 else round(far_depletion * 0.4, 3)
    else:
        # Both near and far are bare soil -> already in headland / open ground
        visual_row_end_conf = round(max(0.85, far_depletion), 3) if green_ratio_far < 0.02 else round(far_depletion * 0.6, 3)

    visual_row_end_conf = max(0.0, min(1.0, visual_row_end_conf))
    row_end_detected = visual_row_end_conf >= 0.75

    # Detection confidence reflects how clearly left & right ridges (or headland) were segmented
    ridge_signal = min(1.0, (green_ratio_near + green_ratio_far) * 4.0)
    confidence = round(max(0.25, min(0.99, ridge_signal if not row_end_detected else visual_row_end_conf)), 3)

    furrows = [
        {
            "center_nx": round(furrow_center_norm, 4),
            "left_ridge_nx": round(left_cx_norm, 4),
            "right_ridge_nx": round(right_cx_norm, 4),
            "lateral_error_m": round(lateral_error_m, 4),
            "confidence": confidence,
        }
    ]

    return CropRowVisionResult(
        decoded=True,
        analysis_source=source,
        image_width=width,
        image_height=height,
        green_ratio_near=round(green_ratio_near, 4),
        green_ratio_far=round(green_ratio_far, 4),
        lateral_error_m=round(lateral_error_m, 4),
        heading_error_rad=round(heading_error_rad, 4),
        visual_row_end_conf=visual_row_end_conf,
        row_end_detected=row_end_detected,
        confidence=confidence,
        furrows=furrows,
    )
