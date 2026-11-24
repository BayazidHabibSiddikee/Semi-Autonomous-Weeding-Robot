"""
MaixSense-A075V Spatial Perception Module for Simpla Bot.

Handles:
  1. Official Sipeed MaixSense-A075V HTTP protocol over USB-RNDIS (192.168.233.1):
       - POST /set_cfg  (12-byte <BBBBBBBBi payload)
       - GET  /getdeep  (44-byte header + 16-bit depth map in mm + RGB JPEG)
  2. Pure-Python 16-bit ToF depth analysis (zero numpy/OpenCV required on host):
       - Exact distance to front wall / obstacle ("how much to go" in mm)
       - 90-degree LEFT / RIGHT corner detection, DEAD_END, and ROW_END_HEADLAND
       - Left/Right wall-balance steering error to keep straight down a row
       - Weed cluster detection (Excess-Green RGB fused with ToF depth) to compute
         exact forward travel distance (dx_to_tool_mm) to align the weed under
         the grinding machine or flame nozzle.
"""

from __future__ import annotations

import math
import statistics
import struct
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple


# =============================================================================
# Data structures
# =============================================================================

@dataclass
class MaixSenseFrame:
    """Single synchronized ToF depth + optional RGB frame from MaixSense-A075V."""

    frame_id: int
    stamp_msec: int
    received_at: float
    depth_width: int
    depth_height: int
    # Row-major uint16 millimeter values (len == depth_width * depth_height)
    depth_mm: List[int]
    # Raw JPEG bytes returned by MaixSense (may be empty if RGB disabled)
    rgb_jpeg: bytes = b""
    # Optional decoded RGB grid [(r, g, b), ...] with width/height for testing or CV
    rgb_pixels: Optional[List[Tuple[int, int, int]]] = None
    rgb_width: int = 0
    rgb_height: int = 0


@dataclass
class WeedDetection:
    """Weed detected in RGB and projected to real-world millimeters via ToF depth."""

    cx_norm: float          # -1.0 (left) .. 0.0 (center) .. +1.0 (right)
    cy_norm: float          # 0.0 (top) .. 1.0 (bottom)
    pixel_count: int
    depth_mm: float         # Direct ToF slant range at weed pixel
    forward_from_cam_mm: float  # Ground-projected horizontal distance ahead of camera
    dx_to_tool_mm: float    # Exact mm rover must roll forward to put weed under tool


@dataclass
class SpatialDecision:
    """Everything Simpla Bot needs to know from one MaixSense frame."""

    timestamp: float
    valid_ratio: float
    # Zone median depths (mm) — None if no valid pixels in zone
    left_mm: Optional[float]
    center_mm: Optional[float]
    right_mm: Optional[float]
    min_center_mm: Optional[float]
    # How much distance is safe to travel forward right now (mm)
    recommended_travel_mm: float
    # Steering correction (-max..+max %) to stay centered between left & right sides
    steer_adjust_pct: float
    # Corner / obstacle / row-end state
    obstacle_blocked: bool
    corner_detected: bool
    corner_type: str        # "NONE" | "LEFT_CORNER" | "RIGHT_CORNER" | "DEAD_END" | "ROW_END_HEADLAND"
    suggested_turn: str     # "NONE" | "LEFT" | "RIGHT" | "UTURN"
    # Optional weed target fused with ToF depth
    weed: Optional[WeedDetection] = None
    notes: List[str] = field(default_factory=list)


# =============================================================================
# Official MaixSense-A075V Packet Encoder / Decoder
# =============================================================================

def build_set_cfg_payload(
    trigger_mode: int = 1,
    deep_mode: int = 0,
    deep_shift: int = 255,
    ir_mode: int = 0,
    status_mode: int = 2,
    status_mask: int = 7,
    rgb_mode: int = 1,
    rgb_res: int = 0,
    expose_time: int = 0,
) -> bytes:
    """
    Build Sipeed's 12-byte /set_cfg structure.
    deep_mode=0 selects 16-bit depth values in millimetres; rgb_mode=1 selects JPEG.
    """
    return struct.pack(
        "<BBBBBBBBi",
        trigger_mode,
        deep_mode,
        deep_shift,
        ir_mode,
        status_mode,
        status_mask,
        rgb_mode,
        rgb_res,
        expose_time,
    )


def _status_bytes_per_pixel(status_mode: int) -> float:
    # Sipeed status modes: 0=16-bit, 1=2-bit, 2=8-bit, 3=1-bit.
    mapping = {0: 2.0, 1: 0.25, 2: 1.0, 3: 0.125}
    if status_mode not in mapping:
        raise ValueError(f"Unsupported MaixSense status_mode: {status_mode}")
    return mapping[status_mode]


def build_synthetic_getdeep_packet(
    depth_mm: Sequence[int],
    width: int = 320,
    height: int = 240,
    rgb_jpeg: bytes = b"",
    frame_id: int = 1,
    stamp_msec: int = 1000,
) -> bytes:
    """Build a packet using Sipeed's documented 36-byte header and payload layout."""
    if len(depth_mm) != width * height:
        raise ValueError(f"Expected {width * height} depth values, got {len(depth_mm)}")
    depth_bytes = struct.pack(
        f"<{len(depth_mm)}H",
        *(max(0, min(65535, int(v))) for v in depth_mm),
    )
    # The default config is 16-bit depth + 16-bit IR + 8-bit status.
    ir_bytes = bytes(width * height * 2)
    status_bytes = bytes(width * height)
    deep_payload = depth_bytes + ir_bytes + status_bytes
    frame_cfg = build_set_cfg_payload()
    header = struct.pack("<QQ", frame_id, stamp_msec) + frame_cfg + struct.pack(
        "<ii", len(deep_payload), len(rgb_jpeg)
    )
    return header + deep_payload + rgb_jpeg


def parse_getdeep_packet(
    raw: bytes,
    default_width: int = 320,
    default_height: int = 240,
) -> MaixSenseFrame:
    """
    Decode the documented Sipeed MaixSense-A075V /getdeep packet.

    Layout: 16-byte frame ID/timestamp + 12-byte config + two int32 sizes
    (36-byte header), then depth + IR + status (deep_size bytes), then RGB.
    The depth/IR/status component sizes are derived from the 12-byte config.
    """
    header_size = 36
    if len(raw) < header_size:
        raise ValueError(
            f"MaixSense packet too short: {len(raw)} bytes (need >= {header_size})"
        )

    frame_id, stamp_msec = struct.unpack_from("<QQ", raw, 0)
    config = struct.unpack_from("<BBBBBBBBi", raw, 16)
    _trigger_mode, deep_mode, _deep_shift, ir_mode, status_mode = config[:5]
    deep_size, rgb_size = struct.unpack_from("<ii", raw, 28)
    if deep_size < 0 or rgb_size < 0:
        raise ValueError("MaixSense packet contains negative payload size")

    deep_start = header_size
    deep_end = deep_start + deep_size
    rgb_end = deep_end + rgb_size
    if deep_end > len(raw) or rgb_end > len(raw):
        raise ValueError(
            f"Truncated MaixSense payload: expected {rgb_end} bytes, got {len(raw)}"
        )

    depth_bpp = 2 if deep_mode == 0 else 1
    ir_bpp = 2 if ir_mode == 0 else 1
    status_bpp = _status_bytes_per_pixel(status_mode)
    total_bpp = depth_bpp + ir_bpp + status_bpp
    pixel_count_float = deep_size / total_bpp
    pixel_count = int(round(pixel_count_float))
    if abs(pixel_count_float - pixel_count) > 1e-6:
        raise ValueError("MaixSense deep_size is inconsistent with its frame config")

    if pixel_count == default_width * default_height:
        width, height = default_width, default_height
    elif pixel_count == 320 * 240:
        width, height = 320, 240
    elif pixel_count == 160 * 120:
        width, height = 160, 120
    elif pixel_count == 100 * 100:
        width, height = 100, 100
    else:
        side = int(math.isqrt(pixel_count))
        if side * side == pixel_count:
            width, height = side, side
        elif default_width > 0 and pixel_count % default_width == 0:
            width, height = default_width, pixel_count // default_width
        else:
            raise ValueError(f"Cannot infer MaixSense frame dimensions from {pixel_count} pixels")

    pixel_count = width * height
    depth_size = pixel_count * depth_bpp
    ir_size = pixel_count * ir_bpp
    status_multiplier = {0: 16, 1: 2, 2: 8, 3: 1}[status_mode]
    status_size = (pixel_count // 8) * status_multiplier
    if depth_size + ir_size + status_size != deep_size:
        raise ValueError("MaixSense payload sizes do not match config-derived depth/IR/status sizes")

    depth_payload = raw[deep_start : deep_start + depth_size]
    if deep_mode == 0:
        depth_mm = list(struct.unpack(f"<{pixel_count}H", depth_payload))
    else:
        depth_mm = list(depth_payload)

    rgb_jpeg = b""
    if rgb_size:
        rgb_chunk = raw[deep_end:rgb_end]
        soi = rgb_chunk.find(b"\xff\xd8")
        eoi = rgb_chunk.rfind(b"\xff\xd9")
        if soi != -1 and eoi > soi:
            rgb_jpeg = rgb_chunk[soi : eoi + 2]
        else:
            rgb_jpeg = rgb_chunk

    return MaixSenseFrame(
        frame_id=frame_id,
        stamp_msec=stamp_msec,
        received_at=time.monotonic(),
        depth_width=width,
        depth_height=height,
        depth_mm=depth_mm,
        rgb_jpeg=rgb_jpeg,
    )


# =============================================================================
# Live HTTP Client (USB-RNDIS 192.168.233.1)
# =============================================================================

class MaixSenseClient:
    """Minimal stdlib HTTP client for Sipeed MaixSense-A075V over USB-RNDIS."""

    def __init__(self, cfg: Dict[str, Any]) -> None:
        ms = cfg.get("maixsense", {})
        self.host = str(ms.get("host", "192.168.233.1"))
        self.port = int(ms.get("port", 80))
        self.timeout_s = float(ms.get("timeout_s", 1.5))
        self.depth_width = int(ms.get("depth_width", 320))
        self.depth_height = int(ms.get("depth_height", 240))
        self.base_url = f"http://{self.host}:{self.port}"
        self.configured = False

    def configure(self) -> bool:
        """Send /set_cfg to enable 16-bit depth + RGB stream."""
        payload = build_set_cfg_payload()
        req = urllib.request.Request(
            f"{self.base_url}/set_cfg",
            data=payload,
            method="POST",
            headers={"Content-Type": "application/octet-stream"},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
                ok = 200 <= resp.status < 300
                self.configured = ok
                return ok
        except (urllib.error.URLError, TimeoutError, OSError):
            self.configured = False
            return False

    def fetch_frame(self) -> Optional[MaixSenseFrame]:
        """Fetch and decode one synchronized ToF + RGB frame from /getdeep."""
        if not self.configured:
            self.configure()
        req = urllib.request.Request(f"{self.base_url}/getdeep", method="GET")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
                raw = resp.read()
            frame = parse_getdeep_packet(raw, self.depth_width, self.depth_height)
            # Optionally decode JPEG on Raspberry Pi if Pillow or OpenCV is available
            if frame.rgb_jpeg and frame.rgb_pixels is None:
                _try_decode_rgb_jpeg(frame)
            return frame
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            return None


def _try_decode_rgb_jpeg(frame: MaixSenseFrame) -> None:
    """Decode JPEG bytes into downsampled RGB tuples if Pillow or OpenCV is installed."""
    if not frame.rgb_jpeg:
        return
    try:
        import io
        from PIL import Image  # type: ignore

        img = Image.open(io.BytesIO(frame.rgb_jpeg)).convert("RGB")
        target_w, target_h = min(80, img.width), min(60, img.height)
        img = img.resize((target_w, target_h))
        frame.rgb_pixels = list(img.getdata())
        frame.rgb_width = target_w
        frame.rgb_height = target_h
        return
    except Exception:
        pass
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore

        arr = np.frombuffer(frame.rgb_jpeg, dtype=np.uint8)
        bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if bgr is not None:
            small = cv2.resize(bgr, (80, 60))
            rgb = cv2.cvtColor(small, cv2.COLOR_BGR2RGB)
            frame.rgb_pixels = [
                (int(r), int(g), int(b)) for r, g, b in rgb.reshape(-1, 3)
            ]
            frame.rgb_width = 80
            frame.rgb_height = 60
    except Exception:
        pass


# =============================================================================
# Spatial Analyzer: Corners, Distance-to-Go, Obstacles & Weed Projection
# =============================================================================

class MaixSenseSpatialAnalyzer:
    """
    Turns a MaixSense-A075V ToF + RGB frame into clear driving & weeding decisions:
      - How far forward the bot can safely travel (recommended_travel_mm)
      - Whether a corner / wall / dead-end / row-end headland is ahead and which way to turn
      - Left/right centering steering adjustment
      - Weed location and exact mm to move forward to put the weed under the flame/grinder
    """

    def __init__(self, cfg: Dict[str, Any]) -> None:
        ms = cfg.get("maixsense", {})
        nav = cfg.get("navigation", {})

        self.min_valid_mm = int(ms.get("min_valid_mm", 180))
        self.max_valid_mm = int(ms.get("max_valid_mm", 2400))
        self.camera_height_mm = float(ms.get("camera_height_mm", 420.0))
        self.camera_pitch_deg = float(ms.get("camera_pitch_deg", 28.0))
        self.tool_offset_forward_mm = float(ms.get("tool_offset_forward_mm", -120.0))

        self.obstacle_stop_mm = float(nav.get("obstacle_stop_mm", 320.0))
        self.corner_stop_mm = float(nav.get("corner_stop_mm", 520.0))
        self.corner_open_side_mm = float(nav.get("corner_open_side_mm", 1050.0))
        self.side_asymmetry_mm = float(nav.get("side_asymmetry_mm", 280.0))
        self.headland_open_mm = float(nav.get("headland_open_mm", 1850.0))
        self.centering_kp = float(nav.get("centering_kp", 0.04))
        self.max_steer_adjust_pct = float(nav.get("max_steer_adjust_pct", 18.0))
        self.weed_exg_threshold = int(nav.get("weed_exg_threshold", 38))
        self.weed_min_cluster_px = int(nav.get("weed_min_cluster_px", 18))

    def _valid_zone_depths(
        self,
        frame: MaixSenseFrame,
        x0_frac: float,
        x1_frac: float,
        y0_frac: float,
        y1_frac: float,
    ) -> List[int]:
        w, h = frame.depth_width, frame.depth_height
        if w <= 0 or h <= 0 or not frame.depth_mm:
            return []
        x0 = max(0, min(w, int(w * x0_frac)))
        x1 = max(x0, min(w, int(w * x1_frac)))
        y0 = max(0, min(h, int(h * y0_frac)))
        y1 = max(y0, min(h, int(h * y1_frac)))

        vals: List[int] = []
        depth = frame.depth_mm
        lo, hi = self.min_valid_mm, self.max_valid_mm
        # Subsample by 2 on larger frames to keep Raspberry Pi CPU low
        step = 2 if (w * h) > 10000 else 1
        for y in range(y0, y1, step):
            row_offset = y * w
            for x in range(x0, x1, step):
                d = depth[row_offset + x]
                if lo <= d <= hi:
                    vals.append(d)
        return vals

    def project_slant_to_ground_forward_mm(self, slant_mm: float) -> float:
        """
        Convert a ToF slant range (mm) from the downward-pitched MaixSense camera
        into horizontal ground distance ahead of the camera lens (mm).
        """
        pitch_rad = math.radians(max(0.0, min(80.0, self.camera_pitch_deg)))
        # Horizontal component along rover X axis
        horiz_pitch = slant_mm * math.cos(pitch_rad)
        # Geometric triangulation check against mounting height
        if slant_mm > self.camera_height_mm:
            horiz_geom = math.sqrt(max(0.0, slant_mm * slant_mm - self.camera_height_mm * self.camera_height_mm))
            return 0.5 * (horiz_pitch + horiz_geom)
        return max(0.0, horiz_pitch)

    def detect_weed(self, frame: MaixSenseFrame) -> Optional[WeedDetection]:
        """
        Detect the largest green weed cluster in the lower-center RGB ROI and fuse
        its centroid with the MaixSense 16-bit ToF depth map to compute exact travel
        distance (dx_to_tool_mm) to center it under the grinder or flame nozzle.
        """
        if not frame.rgb_pixels or frame.rgb_width <= 0 or frame.rgb_height <= 0:
            return None

        rw, rh = frame.rgb_width, frame.rgb_height
        # Inspect central lane (20%..80% width) and lower-middle ground band (40%..92% height)
        x0, x1 = int(rw * 0.20), int(rw * 0.80)
        y0, y1 = int(rh * 0.40), int(rh * 0.92)

        green_x_sum = 0.0
        green_y_sum = 0.0
        green_count = 0
        thr = self.weed_exg_threshold

        pixels = frame.rgb_pixels
        for y in range(y0, y1):
            row_off = y * rw
            for x in range(x0, x1):
                r, g, b = pixels[row_off + x]
                exg = 2 * g - r - b
                if exg >= thr and g > r and g > b:
                    green_x_sum += x
                    green_y_sum += y
                    green_count += 1

        if green_count < self.weed_min_cluster_px:
            return None

        cx = green_x_sum / green_count
        cy = green_y_sum / green_count
        cx_norm = (cx / max(1.0, rw - 1)) * 2.0 - 1.0
        cy_norm = cy / max(1.0, rh - 1)

        # Sample a small ToF patch around the weed centroid for noise-resistant depth
        u = max(0.0, min(1.0, cx / max(1.0, rw)))
        v = max(0.0, min(1.0, cy / max(1.0, rh)))
        patch = self._valid_zone_depths(
            frame,
            max(0.0, u - 0.06),
            min(1.0, u + 0.06),
            max(0.0, v - 0.06),
            min(1.0, v + 0.06),
        )
        if not patch:
            return None

        slant_mm = float(statistics.median(patch))
        forward_mm = self.project_slant_to_ground_forward_mm(slant_mm)
        # If tool is behind camera (tool_offset_forward_mm < 0), rover must travel further
        # forward_mm - tool_offset_forward_mm = forward_mm + |offset|.
        dx_to_tool_mm = forward_mm - self.tool_offset_forward_mm

        return WeedDetection(
            cx_norm=round(cx_norm, 3),
            cy_norm=round(cy_norm, 3),
            pixel_count=green_count,
            depth_mm=round(slant_mm, 1),
            forward_from_cam_mm=round(forward_mm, 1),
            dx_to_tool_mm=round(dx_to_tool_mm, 1),
        )

    def analyze(self, frame: MaixSenseFrame) -> SpatialDecision:
        """Analyze one MaixSense frame for distance-to-go, corners, steering, and weeds."""
        # Horizon / mid-forward band (25%..68% vertical) avoids looking straight at the floor
        left_vals = self._valid_zone_depths(frame, 0.05, 0.33, 0.25, 0.68)
        center_vals = self._valid_zone_depths(frame, 0.34, 0.66, 0.25, 0.68)
        right_vals = self._valid_zone_depths(frame, 0.67, 0.95, 0.25, 0.68)

        total_samples = max(1, (frame.depth_width * frame.depth_height) // 4)
        valid_count = len(left_vals) + len(center_vals) + len(right_vals)
        valid_ratio = min(1.0, valid_count / max(1.0, total_samples * 0.4))

        left_mm = float(statistics.median(left_vals)) if left_vals else None
        center_mm = float(statistics.median(center_vals)) if center_vals else None
        right_mm = float(statistics.median(right_vals)) if right_vals else None

        # Use 10th percentile in center zone to catch narrow poles/obstacles safely
        if center_vals:
            sorted_c = sorted(center_vals)
            p10_idx = max(0, int(len(sorted_c) * 0.10))
            min_center_mm: Optional[float] = float(sorted_c[p10_idx])
        else:
            min_center_mm = None

        notes: List[str] = []

        # 1. Immediate obstacle check
        obstacle_blocked = (
            min_center_mm is not None and min_center_mm <= self.obstacle_stop_mm
        )
        if obstacle_blocked:
            notes.append(f"Obstacle close ahead ({min_center_mm:.0f}mm <= {self.obstacle_stop_mm:.0f}mm)")

        # 2. How much distance left to travel safely ("how much to go")
        if center_mm is None:
            # No close echoes in front band -> open path up to max range minus buffer
            recommended_travel_mm = max(0.0, float(self.max_valid_mm) - self.corner_stop_mm)
        else:
            recommended_travel_mm = max(0.0, center_mm - self.corner_stop_mm)

        # 3. Corner & row-end detection
        corner_detected = False
        corner_type = "NONE"
        suggested_turn = "NONE"

        front_approaching_wall = (
            center_mm is not None and center_mm <= self.corner_stop_mm
        )
        if front_approaching_wall:
            corner_detected = True
            l_val = left_mm if left_mm is not None else float(self.max_valid_mm)
            r_val = right_mm if right_mm is not None else float(self.max_valid_mm)

            left_open = l_val >= self.corner_open_side_mm
            right_open = r_val >= self.corner_open_side_mm

            if left_open and not right_open:
                corner_type = "LEFT_CORNER"
                suggested_turn = "LEFT"
                notes.append(f"Front wall at {center_mm:.0f}mm; LEFT open ({l_val:.0f}mm)")
            elif right_open and not left_open:
                corner_type = "RIGHT_CORNER"
                suggested_turn = "RIGHT"
                notes.append(f"Front wall at {center_mm:.0f}mm; RIGHT open ({r_val:.0f}mm)")
            elif left_open and right_open:
                # T-junction / headland fence: prefer more open side
                if l_val >= r_val + self.side_asymmetry_mm:
                    corner_type = "LEFT_CORNER"
                    suggested_turn = "LEFT"
                elif r_val >= l_val + self.side_asymmetry_mm:
                    corner_type = "RIGHT_CORNER"
                    suggested_turn = "RIGHT"
                else:
                    corner_type = "LEFT_CORNER"
                    suggested_turn = "LEFT"
                notes.append(f"T-corner ahead ({center_mm:.0f}mm); turning {suggested_turn}")
            else:
                corner_type = "DEAD_END"
                suggested_turn = "UTURN"
                notes.append(
                    f"Dead end (L={l_val:.0f}mm, C={center_mm:.0f}mm, R={r_val:.0f}mm) -> U-TURN"
                )
        elif (
            center_mm is not None
            and center_mm >= self.headland_open_mm
            and (left_mm is None or left_mm >= self.headland_open_mm)
            and (right_mm is None or right_mm >= self.headland_open_mm)
        ):
            # All 3 zones wide open -> exited crop corridor into open headland
            corner_detected = True
            corner_type = "ROW_END_HEADLAND"
            suggested_turn = "UTURN"
            notes.append(f"Open headland detected (C={center_mm:.0f}mm) -> row end")

        # 4. Corridor centering steering adjustment (positive = steer right, negative = steer left)
        steer_adjust_pct = 0.0
        if not corner_detected and left_mm is not None and right_mm is not None:
            # If right_mm > left_mm, rover is too close to left side -> nudge right (+)
            balance_err_mm = right_mm - left_mm
            raw_steer = balance_err_mm * self.centering_kp
            steer_adjust_pct = max(
                -self.max_steer_adjust_pct,
                min(self.max_steer_adjust_pct, raw_steer),
            )

        # 5. Weed detection fused with ToF depth
        weed = self.detect_weed(frame)
        if weed is not None:
            notes.append(
                f"Weed detected ({weed.pixel_count}px) at {weed.forward_from_cam_mm:.0f}mm "
                f"(roll {weed.dx_to_tool_mm:.0f}mm to align under tool)"
            )

        return SpatialDecision(
            timestamp=frame.received_at,
            valid_ratio=round(valid_ratio, 3),
            left_mm=round(left_mm, 1) if left_mm is not None else None,
            center_mm=round(center_mm, 1) if center_mm is not None else None,
            right_mm=round(right_mm, 1) if right_mm is not None else None,
            min_center_mm=round(min_center_mm, 1) if min_center_mm is not None else None,
            recommended_travel_mm=round(recommended_travel_mm, 1),
            steer_adjust_pct=round(steer_adjust_pct, 2),
            obstacle_blocked=obstacle_blocked,
            corner_detected=corner_detected,
            corner_type=corner_type,
            suggested_turn=suggested_turn,
            weed=weed,
            notes=notes,
        )
