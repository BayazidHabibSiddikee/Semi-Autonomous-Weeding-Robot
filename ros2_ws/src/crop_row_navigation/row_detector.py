"""
Visual Crop-Row Detector (Sowbot ExG + Otsu + PRBonn Strip Centerline Fitting).
Processes frames from the forward-facing navigation camera (/nav_camera/image_raw):
  1. Computes Excess Green vegetation index: ExG = 2*G - R - B
  2. Segments crop foliage via Otsu adaptive thresholding + morphological cleanup
  3. Extracts left and right crop-row peaks across horizontal image strips
  4. Fits left/right row lines and computes centerline lateral offset (m),
     heading error (rad), and row-end confidence (green density drop in far ROI).
"""

import math
from dataclasses import dataclass
import numpy as np

try:
    import cv2
    CV2_AVAILABLE = True
except ImportError:
    CV2_AVAILABLE = False


@dataclass
class RowObservation:
    valid: bool
    lateral_error_m: float         # +ve = rover shifted right of centerline
    heading_error_rad: float       # +ve = rover pointed right of row tangent
    row_end_confidence: float      # 0.0..1.0 (>0.75 indicates row end reached)
    left_row_x_px: float
    right_row_x_px: float
    center_bottom_px: float
    center_top_px: float
    green_ratio_near: float
    green_ratio_far: float


class CropRowDetector:
    """Classical ExG + Otsu crop-row centerline extractor for real-time edge CPU."""

    def __init__(
        self,
        row_width_m: float = 0.60,
        roi_top_frac: float = 0.35,
        roi_bottom_frac: float = 0.95,
        n_strips: int = 8,
        min_green_ratio: float = 0.035,
    ):
        self.row_width_m = row_width_m
        self.roi_top_frac = roi_top_frac
        self.roi_bottom_frac = roi_bottom_frac
        self.n_strips = n_strips
        self.min_green_ratio = min_green_ratio

    @staticmethod
    def compute_exg_mask(bgr_frame: np.ndarray) -> np.ndarray:
        """Compute Excess Green (2G - R - B) and Otsu binary foliage mask."""
        b = bgr_frame[:, :, 0].astype(np.float32)
        g = bgr_frame[:, :, 1].astype(np.float32)
        r = bgr_frame[:, :, 2].astype(np.float32)

        exg = 2.0 * g - r - b
        exg_norm = np.clip((exg - exg.min()) / (exg.max() - exg.min() + 1e-6) * 255.0, 0, 255).astype(np.uint8)

        if CV2_AVAILABLE:
            _, mask = cv2.threshold(exg_norm, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
            mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
            mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
            return mask

        # Fallback NumPy thresholding if OpenCV is absent in lightweight tests
        thresh = np.mean(exg_norm) + 0.75 * np.std(exg_norm)
        return (exg_norm > thresh).astype(np.uint8) * 255

    def detect(self, bgr_frame: np.ndarray) -> RowObservation:
        h, w = bgr_frame.shape[:2]
        y_top = int(h * self.roi_top_frac)
        y_bot = int(h * self.roi_bottom_frac)
        roi = bgr_frame[y_top:y_bot, :]
        mask = self.compute_exg_mask(roi)

        rh, rw = mask.shape
        mid_x = rw // 2

        # Near vs Far vegetation density for row-end detection (replaces unreliable sonar)
        far_band = mask[: rh // 3, :]
        near_band = mask[rh // 2 :, :]
        green_far = float(np.count_nonzero(far_band)) / max(1, far_band.size)
        green_near = float(np.count_nonzero(near_band)) / max(1, near_band.size)

        if green_near < self.min_green_ratio and green_far < self.min_green_ratio:
            return RowObservation(
                valid=False,
                lateral_error_m=0.0,
                heading_error_rad=0.0,
                row_end_confidence=1.0,
                left_row_x_px=float(w * 0.25),
                right_row_x_px=float(w * 0.75),
                center_bottom_px=float(mid_x),
                center_top_px=float(mid_x),
                green_ratio_near=green_near,
                green_ratio_far=green_far,
            )

        strip_h = max(1, rh // self.n_strips)
        centers_y: list[float] = []
        centers_x: list[float] = []
        left_xs: list[float] = []
        right_xs: list[float] = []

        for idx in range(self.n_strips):
            s_y0 = idx * strip_h
            s_y1 = min(rh, (idx + 1) * strip_h)
            strip = mask[s_y0:s_y1, :]
            col_hist = strip.sum(axis=0).astype(np.float32)

            left_half = col_hist[:mid_x]
            right_half = col_hist[mid_x:]
            if left_half.max() <= 0 or right_half.max() <= 0:
                continue

            lx = float(np.argmax(left_half))
            rx = float(mid_x + np.argmax(right_half))
            if (rx - lx) < rw * 0.18:
                continue

            left_xs.append(lx)
            right_xs.append(rx)
            centers_x.append(0.5 * (lx + rx))
            centers_y.append(0.5 * (s_y0 + s_y1))

        if len(centers_x) < 2:
            row_end_conf = max(0.0, min(1.0, 1.0 - (green_far / max(self.min_green_ratio, 1e-4))))
            return RowObservation(
                valid=False,
                lateral_error_m=0.0,
                heading_error_rad=0.0,
                row_end_confidence=row_end_conf,
                left_row_x_px=float(np.mean(left_xs)) if left_xs else float(w * 0.25),
                right_row_x_px=float(np.mean(right_xs)) if right_xs else float(w * 0.75),
                center_bottom_px=float(mid_x),
                center_top_px=float(mid_x),
                green_ratio_near=green_near,
                green_ratio_far=green_far,
            )

        # Linear regression: x = m * y + b in ROI coordinates
        y_arr = np.asarray(centers_y, dtype=np.float32)
        x_arr = np.asarray(centers_x, dtype=np.float32)
        slope, intercept = np.polyfit(y_arr, x_arr, 1)

        center_top_px = float(intercept)
        center_bot_px = float(slope * rh + intercept)

        # Convert pixel offset at bottom of ROI to metric lateral error using known row width
        mean_row_span_px = max(20.0, float(np.mean(np.asarray(right_xs) - np.asarray(left_xs))))
        m_per_px = self.row_width_m / mean_row_span_px
        lateral_error_m = (mid_x - center_bot_px) * m_per_px

        # Heading error from centerline tilt in image plane
        heading_error_rad = math.atan2(center_top_px - center_bot_px, float(rh))

        # Far-band foliage drop relative to near-band signals approaching headland / row end
        far_drop = 1.0 - min(1.0, green_far / max(green_near, self.min_green_ratio))
        row_end_conf = max(0.0, min(1.0, far_drop if green_far < self.min_green_ratio * 1.4 else 0.0))

        return RowObservation(
            valid=True,
            lateral_error_m=lateral_error_m,
            heading_error_rad=heading_error_rad,
            row_end_confidence=row_end_conf,
            left_row_x_px=float(np.mean(left_xs)),
            right_row_x_px=float(np.mean(right_xs)),
            center_bottom_px=center_bot_px,
            center_top_px=center_top_px,
            green_ratio_near=green_near,
            green_ratio_far=green_far,
        )
