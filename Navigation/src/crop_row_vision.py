"""
Lightweight Crop-Row, Geometric BEV Warp & Ground Vegetation Perception Pipeline
for Raspberry Pi Navigation Server.

Computes real Excess-Green (ExG = 2G - R - B) vegetation segmentation on incoming
camera frames (MaixSense MJPEG / USB cam / Android POST /image) to extract:
  - True geometric top-down Bird's-Eye-View (BEV) perspective warp (OpenCV / Pillow / pure-Python fallback)
  - Bilateral near-ROI and far-ROI vegetation density ratios
  - Left and right crop-band centroids, ridge X positions (`ridges_nx`), and furrow X positions (`furrows_nx`)
  - Lateral offset error (m) and heading error (rad)
  - Calibrated visual row-end confidence (0.0..1.0) requiring BOTH verified bilateral crop-row
    structure in the near ROI AND sharp far-ROI vegetation depletion (eliminating false positives
    on sparse weeds, seedlings, or bare soil)
  - Compact connected-component vegetation cluster boxes (`weed_clusters`)
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
    green_ratio_near_left: float
    green_ratio_near_right: float
    crop_row_structure_detected: bool
    lateral_error_m: float
    heading_error_rad: float
    visual_row_end_conf: float
    row_end_detected: bool
    confidence: float
    ridges_nx: list[float]
    furrows_nx: list[float]
    furrows: list[dict[str, float]]
    weed_clusters: list[dict[str, float]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class BevWarpResult:
    warped: bool
    transform_method: str
    bev_bytes: bytes | None
    mime_type: str
    bev_width: int
    bev_height: int
    boundary_corners: list[list[float]]


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


def _encode_pure_python_png(width: int, height: int, rgb_bytes: bytes) -> bytes:
    """Zero-dependency 8-bit RGB PNG encoder for pure-Python BEV warp fallback."""
    def _chunk(ctype: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(ctype + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + ctype + data + struct.pack(">I", crc)

    stride = width * 3
    raw_rows = bytearray()
    for y in range(height):
        raw_rows.append(0)  # PNG filter type 0 (None)
        start = y * stride
        raw_rows.extend(rgb_bytes[start : start + stride])
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"IDAT", zlib.compress(bytes(raw_rows), level=6))
        + _chunk(b"IEND", b"")
    )


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
            pos += length + 4
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
            if filt == 1:
                for i in range(bpp, stride):
                    cur[i] = (cur[i] + cur[i - bpp]) & 0xFF
            elif filt == 2:
                for i in range(stride):
                    cur[i] = (cur[i] + prev_row[i]) & 0xFF
            elif filt == 3:
                for i in range(stride):
                    a = cur[i - bpp] if i >= bpp else 0
                    cur[i] = (cur[i] + ((a + prev_row[i]) >> 1)) & 0xFF
            elif filt == 4:
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


def _solve_linear_system_8x8(A: list[list[float]], b: list[float]) -> list[float] | None:
    """Solve an 8x8 linear system via Gaussian elimination with partial pivoting."""
    n = 8
    aug = [row[:] + [b[i]] for i, row in enumerate(A)]
    for col in range(n):
        pivot = max(range(col, n), key=lambda r: abs(aug[r][col]))
        if abs(aug[pivot][col]) < 1e-12:
            return None
        aug[col], aug[pivot] = aug[pivot], aug[col]
        piv_val = aug[col][col]
        for j in range(col, n + 1):
            aug[col][j] /= piv_val
        for r in range(n):
            if r == col:
                continue
            factor = aug[r][col]
            if factor != 0.0:
                for j in range(col, n + 1):
                    aug[r][j] -= factor * aug[col][j]
    return [aug[i][n] for i in range(n)]


def _compute_perspective_coeffs(
    dst_pts: list[tuple[float, float]],
    src_pts: list[tuple[float, float]],
) -> list[float] | None:
    """
    Compute 8 projective transform coefficients (a..h) mapping destination (x, y)
    back to source (u, v) via:
      u = (a*x + b*y + c) / (g*x + h*y + 1)
      v = (d*x + e*y + f) / (g*x + h*y + 1)
    Matches Pillow Image.Transform.PERSPECTIVE and inverse-mapped BEV warping.
    """
    A: list[list[float]] = []
    B: list[float] = []
    for (x, y), (u, v) in zip(dst_pts, src_pts):
        A.append([x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y])
        B.append(u)
        A.append([0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y])
        B.append(v)
    return _solve_linear_system_8x8(A, B)


def default_bev_source_quad(width: int, height: int) -> list[list[float]]:
    """
    Forward-tilted rover ground-plane trapezoid (TL, TR, BR, BL) in source image pixels
    representing the navigable crop-row region ahead of the chassis.
    """
    return [
        [round(width * 0.22, 2), round(height * 0.28, 2)],
        [round(width * 0.78, 2), round(height * 0.28, 2)],
        [round(width * 0.96, 2), round(height * 0.96, 2)],
        [round(width * 0.04, 2), round(height * 0.96, 2)],
    ]


def warp_frame_to_bev(
    frame_bytes: bytes,
    *,
    out_width: int = 640,
    out_height: int = 480,
    src_corners: list[list[float]] | None = None,
) -> BevWarpResult:
    """
    Geometrically warp a perspective camera frame into a top-down Bird's-Eye-View (BEV)
    image using a 4-point projective homography transform:
      1. OpenCV `cv2.getPerspectiveTransform` + `cv2.warpPerspective` -> JPEG
      2. Pillow `Image.transform(..., PERSPECTIVE)` -> JPEG
      3. Pure-Python projective inverse warp -> PNG (for minimal environments / PPM & PNG frames)

    Never silently returns the unwarped raw image bytes when decoding fails.
    """
    if not frame_bytes:
        return BevWarpResult(
            warped=False,
            transform_method="empty_input",
            bev_bytes=None,
            mime_type="image/jpeg",
            bev_width=0,
            bev_height=0,
            boundary_corners=[],
        )

    out_w = max(64, int(out_width))
    out_h = max(64, int(out_height))

    # 1. OpenCV path (preferred on Raspberry Pi 4/5)
    if cv2 is not None and np is not None:
        try:
            buf = np.frombuffer(frame_bytes, dtype=np.uint8)
            bgr = cv2.imdecode(buf, cv2.IMREAD_COLOR)
            if bgr is not None and bgr.size > 0:
                h, w = int(bgr.shape[0]), int(bgr.shape[1])
                quad = src_corners if (src_corners and len(src_corners) == 4) else default_bev_source_quad(w, h)
                src_np = np.array(quad, dtype=np.float32)
                dst_np = np.array(
                    [[0.0, 0.0], [float(out_w - 1), 0.0], [float(out_w - 1), float(out_h - 1)], [0.0, float(out_h - 1)]],
                    dtype=np.float32,
                )
                mat = cv2.getPerspectiveTransform(src_np, dst_np)
                warped_bgr = cv2.warpPerspective(bgr, mat, (out_w, out_h), flags=cv2.INTER_LINEAR)
                ok_enc, enc = cv2.imencode(".jpg", warped_bgr, [int(cv2.IMWRITE_JPEG_QUALITY), 88])
                if ok_enc:
                    return BevWarpResult(
                        warped=True,
                        transform_method="opencv_perspective_homography",
                        bev_bytes=enc.tobytes(),
                        mime_type="image/jpeg",
                        bev_width=out_w,
                        bev_height=out_h,
                        boundary_corners=[[round(float(p[0]), 2), round(float(p[1]), 2)] for p in quad],
                    )
        except Exception:
            pass

    # 2. Pillow path
    if PILImage is not None:
        try:
            with PILImage.open(io.BytesIO(frame_bytes)) as img:
                rgb_img = img.convert("RGB")
                w, h = rgb_img.size
                quad = src_corners if (src_corners and len(src_corners) == 4) else default_bev_source_quad(w, h)
                dst_pts = [
                    (0.0, 0.0),
                    (float(out_w - 1), 0.0),
                    (float(out_w - 1), float(out_h - 1)),
                    (0.0, float(out_h - 1)),
                ]
                src_pts = [(float(p[0]), float(p[1])) for p in quad]
                coeffs = _compute_perspective_coeffs(dst_pts, src_pts)
                if coeffs is not None:
                    warped_img = rgb_img.transform(
                        (out_w, out_h),
                        PILImage.Transform.PERSPECTIVE,
                        coeffs,
                        resample=PILImage.Resampling.BILINEAR,
                    )
                    out_buf = io.BytesIO()
                    warped_img.save(out_buf, format="JPEG", quality=88)
                    return BevWarpResult(
                        warped=True,
                        transform_method="pillow_perspective_homography",
                        bev_bytes=out_buf.getvalue(),
                        mime_type="image/jpeg",
                        bev_width=out_w,
                        bev_height=out_h,
                        boundary_corners=[[round(float(p[0]), 2), round(float(p[1]), 2)] for p in quad],
                    )
        except Exception:
            pass

    # 3. Pure-Python projective warp fallback (PPM/PNG) — capped at 320x240 for fast CPU execution
    py_decoded = _decode_pure_python_ppm_or_png(frame_bytes)
    if py_decoded is not None:
        w, h, rgb_bytes, _tag = py_decoded
        pw = min(out_w, 320)
        ph = min(out_h, 240)
        quad = src_corners if (src_corners and len(src_corners) == 4) else default_bev_source_quad(w, h)
        dst_pts = [
            (0.0, 0.0),
            (float(pw - 1), 0.0),
            (float(pw - 1), float(ph - 1)),
            (0.0, float(ph - 1)),
        ]
        src_pts = [(float(p[0]), float(p[1])) for p in quad]
        coeffs = _compute_perspective_coeffs(dst_pts, src_pts)
        if coeffs is not None:
            a, b, c, d, e, f, g, h_c = coeffs
            out_rgb = bytearray(pw * ph * 3)
            src_stride = w * 3
            dst_idx = 0
            for y in range(ph):
                by = b * y + c
                ey = e * y + f
                hy = h_c * y + 1.0
                for x in range(pw):
                    denom = g * x + hy
                    if abs(denom) > 1e-6:
                        u = int((a * x + by) / denom)
                        v = int((d * x + ey) / denom)
                        if 0 <= u < w and 0 <= v < h:
                            sp = v * src_stride + u * 3
                            out_rgb[dst_idx] = rgb_bytes[sp]
                            out_rgb[dst_idx + 1] = rgb_bytes[sp + 1]
                            out_rgb[dst_idx + 2] = rgb_bytes[sp + 2]
                    dst_idx += 3
            png_bytes = _encode_pure_python_png(pw, ph, bytes(out_rgb))
            return BevWarpResult(
                warped=True,
                transform_method="pure_py_perspective_homography",
                bev_bytes=png_bytes,
                mime_type="image/png",
                bev_width=pw,
                bev_height=ph,
                boundary_corners=[[round(float(p[0]), 2), round(float(p[1]), 2)] for p in quad],
            )

    return BevWarpResult(
        warped=False,
        transform_method="undecodable_frame",
        bev_bytes=None,
        mime_type="image/jpeg",
        bev_width=0,
        bev_height=0,
        boundary_corners=[],
    )


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


def _extract_column_ridges_and_furrows(
    mask_rows: list[list[bool]],
    y_start: int,
    y_end: int,
    sw: int,
) -> tuple[list[float], list[float]]:
    """
    Detect distinct vertical crop ridges and the navigable furrows between them from
    a column-wise Excess-Green projection profile.
    """
    span_y = max(1, y_end - y_start)
    col_density = [0.0] * sw
    for y in range(y_start, y_end):
        row = mask_rows[y]
        for x in range(sw):
            if row[x]:
                col_density[x] += 1.0
    col_density = [c / float(span_y) for c in col_density]

    # Simple 5-tap box smoothing
    smoothed = [0.0] * sw
    for x in range(sw):
        lo = max(0, x - 2)
        hi = min(sw, x + 3)
        smoothed[x] = sum(col_density[lo:hi]) / float(hi - lo)

    # Identify contiguous ridge bands where smoothed column density >= 0.12
    ridges_nx: list[float] = []
    in_band = False
    band_start = 0
    min_band_w = max(2, sw // 40)
    for x in range(sw):
        if smoothed[x] >= 0.12:
            if not in_band:
                in_band = True
                band_start = x
        else:
            if in_band:
                if (x - band_start) >= min_band_w:
                    # Weighted centroid of ridge band
                    w_sum = sum(smoothed[band_start:x])
                    cx = (
                        sum(i * smoothed[i] for i in range(band_start, x)) / w_sum
                        if w_sum > 1e-6
                        else 0.5 * (band_start + x)
                    )
                    ridges_nx.append(round(max(0.03, min(0.97, cx / float(sw))), 4))
                in_band = False
    if in_band and (sw - band_start) >= min_band_w:
        w_sum = sum(smoothed[band_start:sw])
        cx = (
            sum(i * smoothed[i] for i in range(band_start, sw)) / w_sum
            if w_sum > 1e-6
            else 0.5 * (band_start + sw)
        )
        ridges_nx.append(round(max(0.03, min(0.97, cx / float(sw))), 4))

    # Furrows are midpoints between adjacent crop ridges
    furrows_nx: list[float] = []
    for i in range(len(ridges_nx) - 1):
        if (ridges_nx[i + 1] - ridges_nx[i]) >= 0.12:
            furrows_nx.append(round(0.5 * (ridges_nx[i] + ridges_nx[i + 1]), 4))

    return ridges_nx, furrows_nx


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
            green_ratio_near_left=0.0,
            green_ratio_near_right=0.0,
            crop_row_structure_detected=False,
            lateral_error_m=0.0,
            heading_error_rad=0.0,
            visual_row_end_conf=0.0,
            row_end_detected=False,
            confidence=0.0,
            ridges_nx=[],
            furrows_nx=[],
            furrows=[],
            weed_clusters=[],
        )

    y_horizon = int(sh * 0.22)
    y_mid = int(sh * 0.55)
    half_x = sw // 2

    far_total = max(1, (y_mid - y_horizon) * sw)
    near_rows = max(1, sh - y_mid)
    near_total = max(1, near_rows * sw)
    near_left_total = max(1, near_rows * half_x)
    near_right_total = max(1, near_rows * max(1, sw - half_x))

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
    green_ratio_near_left = left_cnt / float(near_left_total)
    green_ratio_near_right = right_cnt / float(near_right_total)

    left_cx_norm = (left_sum / float(left_cnt)) / sw if left_cnt >= 4 else 0.25
    right_cx_norm = (right_sum / float(right_cnt)) / sw if right_cnt >= 4 else 0.75
    ridge_separation_nx = right_cx_norm - left_cx_norm

    furrow_center_norm = 0.5 * (left_cx_norm + right_cx_norm)
    pixel_offset_norm = furrow_center_norm - 0.5
    lateral_error_m = max(-0.5, min(0.5, pixel_offset_norm * row_width_m * 1.4))

    if far_left_cnt >= 4 and far_right_cnt >= 4:
        far_center_norm = 0.5 * ((far_left_sum / far_left_cnt) + (far_right_sum / far_right_cnt)) / sw
        heading_error_rad = max(-0.6, min(0.6, math.atan2(far_center_norm - furrow_center_norm, 0.45)))
    else:
        heading_error_rad = 0.0

    # Extract column ridges & furrows across near+mid ground ROI
    ridges_nx, furrows_nx = _extract_column_ridges_and_furrows(mask_rows, y_mid, sh, sw)

    # Bilateral structured crop-row check:
    # A valid visual row-end transition REQUIRES established crop ridges on BOTH left and
    # right sides of the near ROI with real furrow separation. Sparse weeds, bare soil, or
    # single-sided foliage MUST NOT trigger false-positive row-end detections!
    bilateral_near_present = (
        green_ratio_near >= 0.08
        and green_ratio_near_left >= 0.06
        and green_ratio_near_right >= 0.06
        and ridge_separation_nx >= 0.22
    )
    crop_row_structure_detected = bilateral_near_present or (len(ridges_nx) >= 2 and len(furrows_nx) >= 1)

    if bilateral_near_present:
        far_to_near_ratio = green_ratio_far / max(1e-6, green_ratio_near)
        # Depletion score increases ONLY when far ROI drops sharply below near ROI
        # AND absolute far vegetation is sparse (< 0.05)
        abs_depletion = max(0.0, min(1.0, (0.05 - green_ratio_far) / 0.05))
        rel_depletion = max(0.0, min(1.0, (0.35 - far_to_near_ratio) / 0.35))
        if far_to_near_ratio < 0.28 and green_ratio_far < 0.04:
            visual_row_end_conf = round(0.55 + 0.45 * min(abs_depletion, rel_depletion), 3)
        else:
            visual_row_end_conf = round(0.30 * abs_depletion * rel_depletion, 3)
    else:
        # No bilateral crop-row structure visible -> NEVER declare a confident row end!
        visual_row_end_conf = 0.0

    visual_row_end_conf = max(0.0, min(1.0, visual_row_end_conf))
    row_end_detected = bool(bilateral_near_present and visual_row_end_conf >= 0.78)

    if crop_row_structure_detected:
        ridge_signal = min(0.99, 0.35 + (green_ratio_near + green_ratio_far) * 2.2)
        confidence = round(max(0.45, ridge_signal), 3)
    else:
        # Honest low confidence when image lacks structured crop rows (e.g., sparse weeds/soil)
        confidence = round(min(0.40, (green_ratio_near + green_ratio_far) * 2.5), 3)

    if not furrows_nx and bilateral_near_present:
        furrows_nx = [round(furrow_center_norm, 4)]
        ridges_nx = [round(left_cx_norm, 4), round(right_cx_norm, 4)]

    furrows: list[dict[str, float]] = []
    if crop_row_structure_detected and furrows_nx:
        for fnx in furrows_nx:
            f_lat = max(-0.5, min(0.5, (fnx - 0.5) * row_width_m * 1.4))
            furrows.append({
                "center_nx": round(fnx, 4),
                "left_ridge_nx": round(left_cx_norm, 4),
                "right_ridge_nx": round(right_cx_norm, 4),
                "lateral_error_m": round(f_lat, 4),
                "confidence": confidence,
            })

    weed_clusters = _extract_weed_clusters(mask_rows, sw, sh, min_pixels=4)

    return CropRowVisionResult(
        decoded=True,
        analysis_source=source,
        image_width=width,
        image_height=height,
        green_ratio_near=round(green_ratio_near, 4),
        green_ratio_far=round(green_ratio_far, 4),
        green_ratio_near_left=round(green_ratio_near_left, 4),
        green_ratio_near_right=round(green_ratio_near_right, 4),
        crop_row_structure_detected=crop_row_structure_detected,
        lateral_error_m=round(lateral_error_m, 4),
        heading_error_rad=round(heading_error_rad, 4),
        visual_row_end_conf=visual_row_end_conf,
        row_end_detected=row_end_detected,
        confidence=confidence,
        ridges_nx=ridges_nx,
        furrows_nx=furrows_nx,
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
                green_ratio_near_left=0.0,
                green_ratio_near_right=0.0,
                crop_row_structure_detected=False,
                lateral_error_m=0.0,
                heading_error_rad=0.0,
                visual_row_end_conf=0.0,
                row_end_detected=False,
                confidence=0.0,
                ridges_nx=[],
                furrows_nx=[],
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
        mask_rows = []
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
        green_ratio_near_left=0.0,
        green_ratio_near_right=0.0,
        crop_row_structure_detected=False,
        lateral_error_m=0.0,
        heading_error_rad=0.0,
        visual_row_end_conf=0.0,
        row_end_detected=False,
        confidence=0.0,
        ridges_nx=[],
        furrows_nx=[],
        furrows=[],
        weed_clusters=[],
    )
