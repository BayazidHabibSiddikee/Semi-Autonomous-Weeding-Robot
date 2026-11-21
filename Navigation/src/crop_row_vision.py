"""
Lightweight Crop-Row & Ground Vegetation Perception Pipeline for Raspberry Pi Navigation Server.

Computes real Excess-Green (ExG = 2G - R - B) vegetation segmentation on incoming
camera frames (MaixSense MJPEG / USB cam / Android POST /image) to extract:
  - Near-ROI and Far-ROI vegetation density ratios
  - Left and right crop-band centroids & furrow centerline
  - Lateral offset error (m) and heading error (rad)
  - Visual row-end confidence (0.0..1.0) when far-ROI vegetation opens to headland soil
  - Compact connected-component vegetation cluster boxes (`weed_clusters`)

Supports OpenCV (cv2) + NumPy on Raspberry Pi 4, falls back to Pillow + NumPy,
and includes a zero-dependency pure-Python PNG/PPM (P6) fallback so automated
tests and minimal Python environments run identical ExG segmentation math.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
import io
import math
import struct
from typing import Any
import zlib

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
    weed_clusters: list[dict[str, float]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _paeth_predictor(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa = abs(p - a)
    pb = abs(p - b)
    pc = abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def _decode_pure_python_ppm_or_png(frame_bytes: bytes) -> tuple[int, int, bytes, str] | None:
    """
    Zero-dependency decoder for binary PPM (P6) and 8-bit RGB/RGBA PNG frames.
    Returns (width, height, rgb_bytes, source_tag) or None.
    """
    if not frame_bytes:
        return None

    # 1. Binary PPM (P6) — emitted directly by ffmpeg -f rawvideo/ppm or cameras
    if frame_bytes.startswith(b"P6"):
        idx = 2
        n = len(frame_bytes)
        tokens: list[bytes] = []
        while len(tokens) < 3 and idx < n:
            # Skip whitespace and comments
            while idx < n and frame_bytes[idx] in b" \t\r\n":
                idx += 1
            if idx < n and frame_bytes[idx] == ord("#"):
                while idx < n and frame_bytes[idx] != ord("\n"):
                    idx += 1
                continue
            start = idx
            while idx < n and frame_bytes[idx] not in b" \t\r\n":
                idx += 1
            if idx > start:
                tokens.append(frame_bytes[start:idx])
        if len(tokens) == 3 and idx < n:
            try:
                w = int(tokens[0])
                h = int(tokens[1])
                maxval = int(tokens[2])
            except ValueError:
                return None
            # Single whitespace byte separates header from RGB raster
            idx += 1
            expected = w * h * 3
            if w >= 8 and h >= 8 and maxval == 255 and len(frame_bytes) - idx >= expected:
                return w, h, frame_bytes[idx : idx + expected], "pure_py_ppm_exg"
        return None

    # 2. Standard 8-bit RGB/RGBA non-interlaced PNG
    if frame_bytes.startswith(b"\x89PNG\r\n\x1a\n"):
        pos = 8
        n = len(frame_bytes)
        width = height = bit_depth = color_type = interlace = 0
        idat_chunks: list[bytes] = []
        while pos + 8 <= n:
            length, ctype = struct.unpack(">I4s", frame_bytes[pos : pos + 8])
            pos += 8
            if pos + length + 4 > n:
                return None
            chunk_data = frame_bytes[pos : pos + length]
            pos += length + 4  # skip CRC
            if ctype == b"IHDR" and length >= 13:
                width, height, bit_depth, color_type, _comp, _filt, interlace = struct.unpack(
                    ">IIBBBBB", chunk_data[:13]
                )
            elif ctype == b"IDAT":
                idat_chunks.append(chunk_data)
            elif ctype == b"IEND":
                break

        if (
            width < 8
            or height < 8
            or bit_depth != 8
            or color_type not in (2, 6)
            or interlace != 0
            or not idat_chunks
        ):
            return None

        bpp = 3 if color_type == 2 else 4
        stride = width * bpp
        try:
            raw = zlib.decompress(b"".join(idat_chunks))
        except zlib.error:
            return None
        if len(raw) < height * (stride + 1):
            return None

        rgb_out = bytearray(width * height * 3)
        prev_row = bytearray(stride)
        raw_pos = 0
        out_pos = 0
        for _y in range(height):
            filt = raw[raw_pos]
            raw_pos += 1
            cur = bytearray(raw[raw_pos : raw_pos + stride])
            raw_pos += stride
            if filt == 1:  # Sub
                for i in range(bpp, stride):
                    cur[i] = (cur[i] + cur[i - bpp]) & 0xFF
            elif filt == 2:  # Up
                for i in range(stride):
                    cur[i] = (cur[i] + prev_row[i]) & 0xFF
            elif filt == 3:  # Average
                for i in range(stride):
                    a = cur[i - bpp] if i >= bpp else 0
                    cur[i] = (cur[i] + ((a + prev_row[i]) >> 1)) & 0xFF
            elif filt == 4:  # Paeth
                for i in range(stride):
                    a = cur[i - bpp] if i >= bpp else 0
                    b = prev_row[i]
                    c = prev_row[i - bpp] if i >= bpp else 0
                    cur[i] = (cur[i] + _paeth_predictor(a, b, c)) & 0xFF
            elif filt != 0:
                return None

            if bpp == 3:
                rgb_out[out_pos : out_pos + stride] = cur
                out_pos += stride
            else:
                for i in range(0, stride, 4):
                    rgb_out[out_pos] = cur[i]
                    rgb_out[out_pos + 1] = cur[i + 1]
                    rgb_out[out_pos + 2] = cur[i + 2]
                    out_pos += 3
            prev_row = cur

        return width, height, bytes(rgb_out), "pure_py_png_exg"

    return None


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


def _extract_weed_clusters(mask_rows: list[list[bool]], sw: int, sh: int, min_pixels: int = 5) -> list[dict[str, float]]:
    """
    Lightweight 4-connected component extractor on downsampled ExG mask.
    Returns normalized bounding boxes (0..1) sorted largest-first (up to 12 clusters).
    """
    visited = [[False] * sw for _ in range(sh)]
    clusters: list[dict[str, float]] = []

    for y0 in range(sh):
        row = mask_rows[y0]
        vrow = visited[y0]
        for x0 in range(sw):
            if not row[x0] or vrow[x0]:
                continue
            stack = [(x0, y0)]
            vrow[x0] = True
            min_x = max_x = x0
            min_y = max_y = y0
            count = 0
            sum_x = 0
            sum_y = 0

            while stack:
                cx, cy = stack.pop()
                count += 1
                sum_x += cx
                sum_y += cy
                if cx < min_x:
                    min_x = cx
                if cx > max_x:
                    max_x = cx
                if cy < min_y:
                    min_y = cy
                if cy > max_y:
                    max_y = cy

                if cx + 1 < sw and mask_rows[cy][cx + 1] and not visited[cy][cx + 1]:
                    visited[cy][cx + 1] = True
                    stack.append((cx + 1, cy))
                if cx - 1 >= 0 and mask_rows[cy][cx - 1] and not visited[cy][cx - 1]:
                    visited[cy][cx - 1] = True
                    stack.append((cx - 1, cy))
                if cy + 1 < sh and mask_rows[cy + 1][cx] and not visited[cy + 1][cx]:
                    visited[cy + 1][cx] = True
                    stack.append((cx, cy + 1))
                if cy - 1 >= 0 and mask_rows[cy - 1][cx] and not visited[cy - 1][cx]:
                    visited[cy - 1][cx] = True
                    stack.append((cx, cy - 1))

            if count >= min_pixels:
                clusters.append({
                    "cx_nx": round((sum_x / count) / sw, 4),
                    "cy_nx": round((sum_y / count) / sh, 4),
                    "x0_nx": round(min_x / sw, 4),
                    "y0_nx": round(min_y / sh, 4),
                    "x1_nx": round((max_x + 1) / sw, 4),
                    "y1_nx": round((max_y + 1) / sh, 4),
                    "area_ratio": round(count / float(sw * sh), 5),
                    "pixels": float(count),
                })

    clusters.sort(key=lambda c: c["pixels"], reverse=True)
    return clusters[:12]


def _compute_metrics_from_mask(
    mask_rows: list[list[bool]],
    width: int,
    height: int,
    source: str,
    row_width_m: float,
) -> CropRowVisionResult:
    sh = len(mask_rows)
    sw = len(mask_rows[0]) if sh > 0 else 0
    if sh < 4 or sw < 4:
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
            weed_clusters=[],
        )

    y_horizon = int(sh * 0.22)
    y_mid = int(sh * 0.55)
    half_x = sw // 2

    far_total = max(1, (y_mid - y_horizon) * sw)
    near_total = max(1, (sh - y_mid) * sw)

    far_green = 0
    near_green = 0
    left_sum = 0
    left_cnt = 0
    right_sum = 0
    right_cnt = 0
    far_left_sum = 0
    far_left_cnt = 0
    far_right_sum = 0
    far_right_cnt = 0

    for y in range(y_horizon, y_mid):
        row = mask_rows[y]
        for x in range(sw):
            if row[x]:
                far_green += 1
                if x < half_x:
                    far_left_sum += x
                    far_left_cnt += 1
                else:
                    far_right_sum += x
                    far_right_cnt += 1

    for y in range(y_mid, sh):
        row = mask_rows[y]
        for x in range(sw):
            if row[x]:
                near_green += 1
                if x < half_x:
                    left_sum += x
                    left_cnt += 1
                else:
                    right_sum += x
                    right_cnt += 1

    green_ratio_far = far_green / float(far_total)
    green_ratio_near = near_green / float(near_total)

    left_cx_norm = (left_sum / float(left_cnt)) / sw if left_cnt >= 4 else 0.25
    right_cx_norm = (right_sum / float(right_cnt)) / sw if right_cnt >= 4 else 0.75

    furrow_center_norm = 0.5 * (left_cx_norm + right_cx_norm)
    pixel_offset_norm = furrow_center_norm - 0.5
    lateral_error_m = max(-0.5, min(0.5, pixel_offset_norm * row_width_m * 1.4))

    if far_left_cnt >= 4 and far_right_cnt >= 4:
        far_center_norm = 0.5 * ((far_left_sum / far_left_cnt) + (far_right_sum / far_right_cnt)) / sw
        heading_error_rad = max(-0.6, min(0.6, math.atan2(far_center_norm - furrow_center_norm, 0.45)))
    else:
        heading_error_rad = 0.0

    far_depletion = max(0.0, min(1.0, (0.08 - green_ratio_far) / 0.08))
    if green_ratio_near >= 0.03:
        visual_row_end_conf = (
            round(0.25 + 0.75 * far_depletion, 3)
            if far_depletion > 0.45
            else round(far_depletion * 0.4, 3)
        )
    else:
        visual_row_end_conf = (
            round(max(0.85, far_depletion), 3)
            if green_ratio_far < 0.02
            else round(far_depletion * 0.6, 3)
        )

    visual_row_end_conf = max(0.0, min(1.0, visual_row_end_conf))
    row_end_detected = visual_row_end_conf >= 0.75

    ridge_signal = min(1.0, (green_ratio_near + green_ratio_far) * 4.0)
    confidence = round(
        max(0.25, min(0.99, ridge_signal if not row_end_detected else visual_row_end_conf)), 3
    )

    furrows = [
        {
            "center_nx": round(furrow_center_norm, 4),
            "left_ridge_nx": round(left_cx_norm, 4),
            "right_ridge_nx": round(right_cx_norm, 4),
            "lateral_error_m": round(lateral_error_m, 4),
            "confidence": confidence,
        }
    ]

    weed_clusters = _extract_weed_clusters(mask_rows, sw, sh, min_pixels=4)

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
        weed_clusters=weed_clusters,
    )


def analyze_crop_row_frame(
    frame_bytes: bytes,
    *,
    row_width_m: float = 0.60,
    exg_threshold: float = 22.0,
) -> CropRowVisionResult:
    """
    Analyze a single RGB/JPEG/PNG/PPM camera frame for crop-row alignment, furrow end,
    and ground vegetation clusters using Excess-Green (ExG = 2G - R - B).
    """
    rgb, source = _decode_rgb_array(frame_bytes)
    if rgb is not None and np is not None:
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
                weed_clusters=[],
            )

        step_x = max(1, width // 160)
        step_y = max(1, height // 120)
        small = rgb[::step_y, ::step_x, :].astype(np.float32)
        exg = 2.0 * small[:, :, 1] - small[:, :, 0] - small[:, :, 2]
        veg_mask = (exg > exg_threshold) & (small[:, :, 1] > 40.0)
        mask_rows = veg_mask.tolist()
        return _compute_metrics_from_mask(mask_rows, width, height, source, row_width_m)

    # Zero-dependency fallback for PPM (P6) and PNG frames when OpenCV/Pillow/NumPy are absent
    py_decoded = _decode_pure_python_ppm_or_png(frame_bytes)
    if py_decoded is not None:
        width, height, rgb_bytes, py_source = py_decoded
        step_x = max(1, width // 160)
        step_y = max(1, height // 120)
        mask_rows: list[list[bool]] = []
        row_stride = width * 3
        for y in range(0, height, step_y):
            base = y * row_stride
            mrow: list[bool] = []
            for x in range(0, width, step_x):
                p = base + x * 3
                r = rgb_bytes[p]
                g = rgb_bytes[p + 1]
                b = rgb_bytes[p + 2]
                exg_val = (2 * g) - r - b
                mrow.append(exg_val > exg_threshold and g > 40)
            mask_rows.append(mrow)
        return _compute_metrics_from_mask(mask_rows, width, height, py_source, row_width_m)

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
        weed_clusters=[],
    )
