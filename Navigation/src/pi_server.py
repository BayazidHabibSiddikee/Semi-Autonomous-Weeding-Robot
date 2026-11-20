#!/usr/bin/env python3
"""
Raspberry Pi 4/5 Onboard Autonomous Weeding Pipeline & FastAPI Stream Server.

Endpoints:
  GET  /health         -> Readiness, hardware attachment flags (camera, yolo, esp32), auth status
  POST /image          -> Upload field photo -> ExG + perspective-quad boundary -> Auto-BEV + Ridge/Furrow segmentation
  GET  /bev_image      -> Serves the exact auto-warped 2D top-down BEV JPEG so the phone taps in BEV coordinates
  POST /start_mission  -> Start mission from tapped BEV [Start] & optional [End] (gated by confidence >= 0.45 & valid furrows)
  POST /heartbeat      -> Phone keep-alive heartbeat (link-loss > 5s triggers fail-safe stop & relays OFF)
  POST /stop           -> Emergency Stop (halts motors & cuts Relay 1 Grinder + Relay 2 Thermal Flame)
  GET  /video_feed     -> Live MJPEG camera stream (real cv2.VideoCapture when attached, annotated with YOLOv8 & furrow guides)
  GET  /map_feed       -> Live MJPEG BEV field map with route, rover pose, weeds, and chlorosis pins
  GET  /cut_plan       -> JSON telemetry (heading, ESP32 8-way drive, turret angle, cut queue, relays, link status)

UDP Discovery Responder:
  Listens on UDP port 8081 for "DISCOVER_WEED_ROVER" and replies with JSON including the HTTP port (8000).

Run on Raspberry Pi:
  WEED_ROVER_API_TOKEN=your-secret uvicorn Navigation.src.pi_server:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import hmac
import json
import math
import os
import secrets
import socket
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    import cv2
    import numpy as np
except ImportError:  # pragma: no cover
    cv2 = None
    np = None

try:
    import serial
except ImportError:  # pragma: no cover
    serial = None

try:
    from ultralytics import YOLO
except ImportError:  # pragma: no cover
    YOLO = None  # type: ignore

try:
    from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
    from fastapi.middleware.cors import CORSMiddleware
    from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
except ImportError:  # pragma: no cover
    FastAPI = None  # type: ignore

DATA_DIR = Path(os.environ.get("WEED_ROVER_DATA_DIR", "/tmp/weed_rover_pi"))
CLIPS_DIR = DATA_DIR / "chlorosis_clips"
DATA_DIR.mkdir(parents=True, exist_ok=True)
CLIPS_DIR.mkdir(parents=True, exist_ok=True)

HTTP_PORT = int(os.environ.get("WEED_ROVER_PORT", "8000"))
DISCOVERY_PORT = int(os.environ.get("WEED_ROVER_DISCOVERY_PORT", "8081"))
MIN_CONFIDENCE = 0.45
HEARTBEAT_TIMEOUT_S = float(os.environ.get("WEED_ROVER_HEARTBEAT_TIMEOUT_S", "5.0"))
CAMERA_INDEX = int(os.environ.get("WEED_ROVER_CAMERA_ID", "0"))
YOLO_MODEL_PATH = os.environ.get("WEED_ROVER_YOLO_WEIGHTS", "Weed_Detection/models/best.pt")

# Bearer token for mutating/safety-critical routes (/image, /start_mission, /stop, /heartbeat).
# Set WEED_ROVER_API_TOKEN in the Pi environment; if unset, an ephemeral per-boot token is generated
# unless WEED_ROVER_ALLOW_UNAUTHENTICATED=1 is explicitly opted in for offline bench tests.
_ENV_TOKEN = os.environ.get("WEED_ROVER_API_TOKEN", "").strip()
_ALLOW_OPEN = os.environ.get("WEED_ROVER_ALLOW_UNAUTHENTICATED", "0") == "1"
API_TOKEN: Optional[str] = (
    None if _ALLOW_OPEN else (_ENV_TOKEN or secrets.token_urlsafe(16))
)
if API_TOKEN and not _ENV_TOKEN:
    print(f"[PiServer] Generated session API token (set WEED_ROVER_API_TOKEN to pin): {API_TOKEN}")


def verify_api_token(authorization: Optional[str] = None) -> None:
    if API_TOKEN is None:
        return
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Bearer token")
    provided = authorization[len("Bearer ") :].strip()
    if not hmac.compare_digest(provided, API_TOKEN):
        raise HTTPException(status_code=403, detail="Invalid Bearer token")


# ---------------------------------------------------------------------------
# ESP32 UART Serial Controller (/dev/ttyUSB0 @ 115200) — Single Shared Link
# ---------------------------------------------------------------------------
class Esp32UartController:
    """Single shared UART link to ESP32 MicroPython firmware (JSON line protocol)."""

    def __init__(self, port: str = "/dev/ttyUSB0", baud: int = 115200) -> None:
        self.port = port
        self.baud = baud
        self._lock = threading.Lock()
        self.ser = None
        if serial is not None and os.path.exists(port):
            try:
                self.ser = serial.Serial(port, baud, timeout=0.15)
            except Exception as exc:
                print(f"[ESP32] Could not open {port}: {exc}")
                self.ser = None

    def send_command(
        self,
        drive_deg: Optional[int],
        turret_deg: float,
        relay1_grinder: bool,
        relay2_flame: bool,
    ) -> Tuple[str, str]:
        clamped_turret = max(-35.0, min(35.0, float(turret_deg)))
        cmd = {
            "drive": "STOP" if drive_deg is None else int(drive_deg),
            "turret": round(clamped_turret, 1),
            "r1_grinder": int(bool(relay1_grinder)),
            "r2_flame": int(bool(relay2_flame)),
        }
        line = json.dumps(cmd, separators=(",", ":")) + "\n"
        ack = "SIM"
        with self._lock:
            if self.ser is not None:
                try:
                    self.ser.write(line.encode("ascii"))
                    raw = self.ser.readline().decode("ascii", errors="ignore").strip()
                    ack = raw or "NO_ACK"
                except Exception as exc:
                    ack = f"UART_ERR:{exc}"
        return line.strip(), ack


# ---------------------------------------------------------------------------
# Step 1 & 2: Perspective-Aware Plot Boundary Detection & Honest Furrow Segmentation
# ---------------------------------------------------------------------------
def order_corners_clockwise(pts: "np.ndarray") -> List[List[float]]:
    """Order 4 image points clockwise as [TL, TR, BR, BL]."""
    pts = np.asarray(pts, dtype=np.float32)
    s = pts.sum(axis=1)
    diff = np.diff(pts, axis=1).reshape(-1)
    tl = pts[np.argmin(s)]
    br = pts[np.argmax(s)]
    tr = pts[np.argmin(diff)]
    bl = pts[np.argmax(diff)]
    return [tl.tolist(), tr.tolist(), br.tolist(), bl.tolist()]


def detect_plot_quadrilateral(veg_mask: "np.ndarray", w: int, h: int) -> Optional[List[List[float]]]:
    """
    Find the dominant contiguous crop-plot cluster (rejecting isolated border weeds/trees)
    and approximate its outer hull as a 4-corner perspective quadrilateral so oblique
    phone photos warp into a true top-down BEV.
    """
    # Connect plants within the field plot while rejecting tiny scattered background noise
    close_k = cv2.getStructuringElement(cv2.MORPH_RECT, (max(15, w // 35), max(15, h // 35)))
    open_k = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    cleaned = cv2.morphologyEx(veg_mask, cv2.MORPH_OPEN, open_k)
    merged = cv2.morphologyEx(cleaned, cv2.MORPH_CLOSE, close_k)

    contours, _ = cv2.findContours(merged, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    # Keep the largest contiguous vegetation region (main crop plot)
    largest = max(contours, key=cv2.contourArea)
    if cv2.contourArea(largest) < (w * h * 0.03):
        return None

    hull = cv2.convexHull(largest)
    peri = cv2.arcLength(hull, True)

    # Try Douglas-Peucker polygon approximation to recover true perspective trapezoid/quad
    for eps_mult in (0.02, 0.035, 0.05, 0.075, 0.1):
        approx = cv2.approxPolyDP(hull, eps_mult * peri, True)
        if len(approx) == 4:
            quad = approx.reshape(4, 2).astype(np.float32)
            quad[:, 0] = np.clip(quad[:, 0], 0, w - 1)
            quad[:, 1] = np.clip(quad[:, 1], 0, h - 1)
            return order_corners_clockwise(quad)

    # Fallback: extreme TL/TR/BR/BL hull vertices (preserves trapezoid taper better than minAreaRect)
    pts = hull.reshape(-1, 2).astype(np.float32)
    quad = np.array(order_corners_clockwise(pts), dtype=np.float32)
    if cv2.contourArea(quad) >= (w * h * 0.03):
        return quad.tolist()

    rect = cv2.minAreaRect(pts)
    box = cv2.boxPoints(rect)
    box[:, 0] = np.clip(box[:, 0], 0, w - 1)
    box[:, 1] = np.clip(box[:, 1], 0, h - 1)
    return order_corners_clockwise(box)


def auto_detect_boundary_and_bev(
    bgr: "np.ndarray", bev_w: int = 640, bev_h: int = 480
) -> Tuple["np.ndarray", List[List[float]], List[float], List[float], float]:
    """
    1. Excess Green (ExG = 2G - R - B) + HSV green mask -> largest plot quadrilateral
    2. Perspective Homography warp -> 2D Top-Down BEV
    3. Honest Crop Ridge vs. Furrow segmentation (NEVER fabricates fake furrows!)
    """
    h, w = bgr.shape[:2]
    b, g, r = cv2.split(bgr.astype(np.int16))
    exg = (2 * g - r - b) > 12

    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    hsv_mask = cv2.inRange(hsv, (20, 25, 25), (100, 255, 255)) > 0
    veg = (exg & hsv_mask).astype(np.uint8) * 255

    corners = detect_plot_quadrilateral(veg, w, h)
    if corners is None:
        # No valid crop plot found — return honest 0.0 confidence and empty furrows
        bev = cv2.resize(bgr, (bev_w, bev_h))
        return bev, [], [], [], 0.0

    src = np.array(corners, dtype=np.float32)
    dst = np.array([[0, 0], [bev_w, 0], [bev_w, bev_h], [0, bev_h]], dtype=np.float32)
    H = cv2.getPerspectiveTransform(src, dst)
    bev = cv2.warpPerspective(bgr, H, (bev_w, bev_h))

    # Segment Crop Ridges (green peaks) vs Traversable Furrows (bare-soil valleys between ridges)
    bb, bg, br = cv2.split(bev.astype(np.int16))
    bev_hsv = cv2.cvtColor(bev, cv2.COLOR_BGR2HSV)
    bev_veg = (((2 * bg - br - bb) > 10) & (cv2.inRange(bev_hsv, (20, 25, 25), (100, 255, 255)) > 0)).astype(np.float32)

    col_profile = bev_veg.mean(axis=0)
    smooth = np.convolve(col_profile, np.ones(15) / 15.0, mode="same")
    mean_v = float(smooth.mean())

    if mean_v < 0.015:
        return bev, corners, [], [], 0.0

    ridges_nx: List[float] = []
    min_sep = max(28, bev_w // 12)
    peak_thresh = max(mean_v * 0.55, 0.04)

    raw_peaks: List[int] = []
    for c in range(12, bev_w - 12):
        if smooth[c] > smooth[c - 1] and smooth[c] >= smooth[c + 1] and smooth[c] > peak_thresh:
            raw_peaks.append(c)

    # Non-maximum suppression by peak height
    raw_peaks.sort(key=lambda c: float(smooth[c]), reverse=True)
    kept: List[int] = []
    for p in raw_peaks:
        if all(abs(p - k) >= min_sep for k in kept):
            kept.append(p)
    kept.sort()
    ridges_nx = [round(c / bev_w, 4) for c in kept]

    # Furrows = deepest soil valley between each adjacent pair of crop ridges (NO fake defaults!)
    furrows_nx: List[float] = []
    if len(kept) >= 2:
        for i in range(len(kept) - 1):
            x0 = kept[i] + 6
            x1 = kept[i + 1] - 6
            if x1 > x0:
                valley = x0 + int(np.argmin(smooth[x0 : x1 + 1]))
                furrows_nx.append(round(valley / bev_w, 4))

    # Honest confidence score [0.0..0.98]
    if len(kept) < 2 or not furrows_nx:
        confidence = round(min(0.35, mean_v * 1.5), 3)
    else:
        diffs = np.diff(kept)
        avg_d = float(diffs.mean()) if len(diffs) else 1.0
        uniformity = max(0.0, 1.0 - float(np.max(np.abs(diffs - avg_d))) / (avg_d + 1.0)) if len(diffs) else 0.4
        count_score = min(1.0, len(kept) / 5.0)
        veg_signal = min(1.0, mean_v / 0.14)
        confidence = round(min(0.98, max(0.0, 0.45 * count_score + 0.35 * uniformity + 0.20 * veg_signal)), 3)

    return bev, corners, ridges_nx, furrows_nx, confidence


# ---------------------------------------------------------------------------
# Step 3–6: Cut-Band Grouping, Real Camera/YOLO Perception & Control Loop
# ---------------------------------------------------------------------------
@dataclass
class WeedTarget:
    weed_id: int
    x_ground_mm: float
    y_fwd_mm: float
    band_mm: int
    turret_angle_deg: float
    confidence: float


@dataclass
class ChlorosisClip:
    clip_id: int
    timestamp: float
    side: str
    row_index: int
    filename: str
    duration_s: float = 3.0


def group_targets_into_30mm_bands(
    targets: List[Tuple[int, float, float, float]],
    current_turret_deg: float,
    mount_y_mm: float = 220.0,
) -> List[WeedTarget]:
    """Group YOLOv8 weed stem bases (X_ground, Y_fwd) into 30mm bands sorted by min turret slew."""
    bands: Dict[int, List[WeedTarget]] = {}
    for wid, xg, yf, conf in targets:
        band = int(yf // 30) * 30
        angle = max(-35.0, min(35.0, math.degrees(math.atan2(xg, max(60.0, mount_y_mm)))))
        bands.setdefault(band, []).append(
            WeedTarget(
                weed_id=wid,
                x_ground_mm=round(xg, 1),
                y_fwd_mm=round(yf, 1),
                band_mm=band,
                turret_angle_deg=round(angle, 1),
                confidence=round(conf, 2),
            )
        )

    ordered: List[WeedTarget] = []
    cur = current_turret_deg
    for band in sorted(bands.keys()):
        remaining = list(bands[band])
        while remaining:
            remaining.sort(key=lambda t: abs(t.turret_angle_deg - cur))
            nxt = remaining.pop(0)
            ordered.append(nxt)
            cur = nxt.turret_angle_deg
    return ordered


class PiRoverPipeline:
    """Thread-safe Pi onboard pipeline with real camera/YOLO hooks, link-loss failsafe, and ESP32 UART."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.esp32 = Esp32UartController()

        # Attempt real camera & YOLO initialization; fall back transparently with explicit hardware flags
        self.camera = None
        if cv2 is not None:
            cap = cv2.VideoCapture(CAMERA_INDEX)
            if cap is not None and cap.isOpened():
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
                self.camera = cap
            elif cap is not None:
                cap.release()

        self.yolo_model = None
        if YOLO is not None and os.path.exists(YOLO_MODEL_PATH):
            try:
                self.yolo_model = YOLO(YOLO_MODEL_PATH)
            except Exception as exc:
                print(f"[YOLO] Could not load {YOLO_MODEL_PATH}: {exc}")

        self.bev_path = DATA_DIR / "latest_bev.jpg"
        self.bev_image: Optional["np.ndarray"] = None
        self.bev_version: int = 0
        self.boundary_corners: List[List[float]] = []
        self.ridges_nx: List[float] = []
        self.furrows_nx: List[float] = []
        self.detection_confidence: float = 0.0

        self.start_pt: Optional[Tuple[float, float]] = None
        self.end_pt: Optional[Tuple[float, float]] = None
        self.route_waypoints: List[Tuple[float, float]] = []
        self.active_wp_idx: int = 0

        self.running: bool = False
        self.e_stopped: bool = False
        self.state: str = "IDLE"
        self.fault_reason: Optional[str] = None
        self.relay_mode: str = "grinder"
        self.last_heartbeat_ts: float = time.time()

        self.rover_nx: float = 0.5
        self.rover_ny: float = 0.9
        self.heading_deg: float = 0.0
        self.drive_cmd_deg: Optional[int] = None
        self.lateral_offset_mm: float = 0.0
        self.wall_distance_mm: float = 1800.0
        self.turret_angle_deg: float = 0.0
        self.relay1_grinder: bool = False
        self.relay2_flame: bool = False
        self.cut_queue: List[WeedTarget] = []
        self.chlorosis_clips: List[ChlorosisClip] = []
        self.weeds_eliminated: int = 0
        self.last_uart_ack: str = "IDLE"
        self.latest_camera_frame: Optional["np.ndarray"] = None
        self._clip_buffer: List["np.ndarray"] = []

        self._worker = threading.Thread(target=self._control_loop, daemon=True)
        self._worker.start()

        self._discovery = threading.Thread(target=self._udp_discovery_loop, daemon=True)
        self._discovery.start()

    def _udp_discovery_loop(self) -> None:
        """Respond to Android UDP broadcast discovery on port 8081 with HTTP port 8000."""
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("", DISCOVERY_PORT))
        except Exception as exc:
            print(f"[Discovery] UDP bind failed on {DISCOVERY_PORT}: {exc}")
            return

        while True:
            try:
                data, addr = sock.recvfrom(1024)
                if b"DISCOVER_WEED_ROVER" in data:
                    reply = json.dumps(
                        {
                            "name": socket.gethostname(),
                            "port": HTTP_PORT,
                            "service": "weed-rover-pi5-pipeline",
                            "auth_required": API_TOKEN is not None,
                        }
                    ).encode("utf-8")
                    sock.sendto(reply, addr)
            except Exception:
                time.sleep(0.5)

    def record_heartbeat(self) -> Dict[str, Any]:
        with self.lock:
            self.last_heartbeat_ts = time.time()
            return {"status": "ok", "state": self.state, "running": self.running}

    def ingest_field_photo(self, raw_bytes: bytes) -> Dict[str, Any]:
        if cv2 is None or np is None:
            raise RuntimeError("OpenCV/NumPy not installed on Pi host")
        arr = np.frombuffer(raw_bytes, dtype=np.uint8)
        bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if bgr is None:
            raise ValueError("Could not decode uploaded image")

        bev, corners, ridges, furrows, conf = auto_detect_boundary_and_bev(bgr)
        cv2.imwrite(str(self.bev_path), bev)

        with self.lock:
            self.bev_image = bev
            self.bev_version += 1
            self.boundary_corners = corners
            self.ridges_nx = ridges
            self.furrows_nx = furrows
            self.detection_confidence = conf
            self.running = False
            self.fault_reason = None
            self.start_pt = None
            self.end_pt = None
            self.route_waypoints = []
            self.state = "READY_FOR_POINTS" if (conf >= MIN_CONFIDENCE and len(furrows) >= 1) else "LOW_CONFIDENCE"

            return {
                "status": "ok",
                "bev_url": f"/bev_image?v={self.bev_version}",
                "bev_width": int(bev.shape[1]),
                "bev_height": int(bev.shape[0]),
                "boundary_corners": corners,
                "ridges_nx": ridges,
                "furrows_nx": furrows,
                "confidence": conf,
                "min_confidence": MIN_CONFIDENCE,
                "ready": conf >= MIN_CONFIDENCE and len(furrows) >= 1,
                "map_feed": "/map_feed",
                "video_feed": "/video_feed",
            }

    def start_mission(
        self,
        start_nx: float,
        start_ny: float,
        end_nx: Optional[float],
        end_ny: Optional[float],
        relay_mode: str = "grinder",
    ) -> Dict[str, Any]:
        with self.lock:
            if self.bev_image is None:
                raise HTTPException(status_code=409, detail="Upload a field photo (/image) before starting a mission.")
            if self.detection_confidence < MIN_CONFIDENCE or not self.furrows_nx:
                raise HTTPException(
                    status_code=422,
                    detail=f"Cannot start mission: row detection confidence ({self.detection_confidence:.2f}) below minimum {MIN_CONFIDENCE:.2f} or no traversable furrows detected.",
                )
            if not (0.0 <= start_nx <= 1.0 and 0.0 <= start_ny <= 1.0):
                raise HTTPException(status_code=400, detail="Start point must be normalized in [0.0, 1.0] BEV coordinates.")

            self.start_pt = (max(0.02, min(0.98, start_nx)), max(0.02, min(0.98, start_ny)))
            if end_nx is not None and end_ny is not None:
                self.end_pt = (max(0.02, min(0.98, end_nx)), max(0.02, min(0.98, end_ny)))
            else:
                self.end_pt = (
                    self.furrows_nx[-1] if abs(start_nx - self.furrows_nx[0]) < abs(start_nx - self.furrows_nx[-1]) else self.furrows_nx[0],
                    0.08 if start_ny > 0.5 else 0.92,
                )

            self.relay_mode = relay_mode if relay_mode in ("grinder", "flame", "both") else "grinder"
            self.route_waypoints = self._build_boustrophedon_route(self.start_pt, self.end_pt)
            self.active_wp_idx = 1 if len(self.route_waypoints) > 1 else 0
            self.rover_nx, self.rover_ny = self.route_waypoints[0]
            self.e_stopped = False
            self.fault_reason = None
            self.running = True
            self.last_heartbeat_ts = time.time()
            self.state = "FURROW_GUIDANCE"
            self.weeds_eliminated = 0
            self.chlorosis_clips = []
            return {
                "status": "started",
                "waypoints": len(self.route_waypoints),
                "start": {"nx": self.start_pt[0], "ny": self.start_pt[1]},
                "end": {"nx": self.end_pt[0], "ny": self.end_pt[1]},
                "relay_mode": self.relay_mode,
            }

    def _build_boustrophedon_route(
        self, start: Tuple[float, float], end: Tuple[float, float]
    ) -> List[Tuple[float, float]]:
        furrows = sorted(self.furrows_nx)
        s_idx = min(range(len(furrows)), key=lambda i: abs(furrows[i] - start[0]))
        e_idx = min(range(len(furrows)), key=lambda i: abs(furrows[i] - end[0]))

        step = 1 if e_idx >= s_idx else -1
        chosen = [furrows[i] for i in range(s_idx, e_idx + step, step)]
        top_y = min(0.08, min(start[1], end[1]))
        bot_y = max(0.92, max(start[1], end[1]))
        going_up = start[1] > 0.5

        pts: List[Tuple[float, float]] = []
        for idx, fx in enumerate(chosen):
            y0 = start[1] if idx == 0 else (bot_y if going_up else top_y)
            y1 = end[1] if idx == len(chosen) - 1 else (top_y if going_up else bot_y)
            pts.append((fx, y0))
            pts.append((fx, y1))
            going_up = not going_up
        return pts

    def emergency_stop(self, reason: str = "Operator E-STOP") -> Dict[str, Any]:
        with self.lock:
            self.running = False
            self.e_stopped = True
            self.state = "E_STOP"
            self.fault_reason = reason
            self.drive_cmd_deg = None
            self.relay1_grinder = False
            self.relay2_flame = False
            _, ack = self.esp32.send_command(None, 0.0, False, False)
            self.last_uart_ack = ack
        return {"status": "stopped", "reason": reason, "esp32_ack": ack}

    def _analyze_live_camera_frame(
        self, frame: "np.ndarray"
    ) -> Tuple[float, float, List[Tuple[int, float, float, float]], Optional[str]]:
        """
        Real vision processing on live camera frame:
          - Computes furrow lateral offset (mm) from left vs. right green crop wall centroid balance
          - Estimates front row-end openness when green walls disappear in upper lookahead band
          - Runs YOLOv8 best.pt (when weights loaded) to locate weed stem bases (X_ground, Y_fwd)
          - Checks side canopy strips for chlorosis yellowing (Hue 18..34 in OpenCV HSV)
        """
        fh, fw = frame.shape[:2]
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        green = cv2.inRange(hsv, (35, 35, 30), (95, 255, 255))

        # Left vs right crop wall balance in lower half -> lateral centering error (mm)
        lower = green[fh // 2 :, :]
        left_density = float(lower[:, : fw // 3].mean()) / 255.0
        right_density = float(lower[:, (2 * fw) // 3 :].mean()) / 255.0
        lateral_mm = (left_density - right_density) * 90.0

        # Upper corridor canopy check -> low flanking vegetation implies approaching headland/row end
        upper_sides = (float(green[: fh // 3, : fw // 3].mean()) + float(green[: fh // 3, (2 * fw) // 3 :].mean())) / 510.0
        wall_mm = 420.0 if upper_sides < 0.04 else 1600.0

        # YOLOv8 stem-base targeting if trained weights are installed
        raw_weeds: List[Tuple[int, float, float, float]] = []
        if self.yolo_model is not None:
            try:
                results = self.yolo_model.predict(frame, conf=0.45, verbose=False)
                wid = 1
                for res in results:
                    for box in res.boxes:
                        x1, y1, x2, y2 = box.xyxy[0].tolist()
                        conf = float(box.conf[0].item())
                        cx = (x1 + x2) / 2.0
                        stem_y = y2
                        # Map pixel coordinates to ground mm relative to rover centerline
                        x_ground_mm = ((cx - fw / 2.0) / (fw / 2.0)) * 200.0
                        y_fwd_mm = max(60.0, (1.0 - stem_y / fh) * 550.0)
                        raw_weeds.append((wid, x_ground_mm, y_fwd_mm, conf))
                        wid += 1
            except Exception:
                pass

        # Passive Bad-Chili Chlorosis check on left/right canopy edges (yellowing hue 18..34)
        yellow = cv2.inRange(hsv, (18, 80, 70), (34, 255, 255))
        left_yellow = float(yellow[:, : fw // 4].mean()) / 255.0
        right_yellow = float(yellow[:, (3 * fw) // 4 :].mean()) / 255.0
        chlorosis_side: Optional[str] = None
        if left_yellow > 0.14:
            chlorosis_side = "LEFT"
        elif right_yellow > 0.14:
            chlorosis_side = "RIGHT"

        return lateral_mm, wall_mm, raw_weeds, chlorosis_side

    def _save_chlorosis_clip_async(self, frames: List["np.ndarray"], side: str, row_idx: int) -> None:
        if cv2 is None or not frames:
            return
        clip_id = len(self.chlorosis_clips) + 1
        filename = f"bad_chili_r{row_idx}_{side.lower()}_{clip_id:02d}.mp4"
        out_path = CLIPS_DIR / filename
        h, w = frames[0].shape[:2]
        writer = cv2.VideoWriter(str(out_path), cv2.VideoWriter_fourcc(*"mp4v"), 10.0, (w, h))
        for f in frames:
            writer.write(f)
        writer.release()
        with self.lock:
            self.chlorosis_clips.append(
                ChlorosisClip(
                    clip_id=clip_id,
                    timestamp=time.time(),
                    side=side,
                    row_index=row_idx,
                    filename=filename,
                    duration_s=round(len(frames) / 10.0, 1),
                )
            )

    def _control_loop(self) -> None:
        """Onboard perception + link-loss watchdog + ESP32 UART dispatch loop."""
        last_clip_ts = 0.0
        while True:
            time.sleep(0.12)

            # Capture real camera frame outside lock if hardware camera is attached
            cam_frame = None
            if self.camera is not None:
                ok, frm = self.camera.read()
                if ok and frm is not None:
                    cam_frame = frm

            with self.lock:
                if cam_frame is not None:
                    self.latest_camera_frame = cam_frame
                    self._clip_buffer.append(cam_frame.copy())
                    if len(self._clip_buffer) > 30:
                        self._clip_buffer.pop(0)

                if not self.running or self.e_stopped or not self.route_waypoints:
                    continue

                # Link-Loss Failsafe: if phone heartbeat stops for > HEARTBEAT_TIMEOUT_S, halt safely!
                if (time.time() - self.last_heartbeat_ts) > HEARTBEAT_TIMEOUT_S:
                    self.running = False
                    self.state = "LINK_LOST_STOP"
                    self.fault_reason = f"Phone heartbeat lost for >{HEARTBEAT_TIMEOUT_S:.0f}s — motors & relays cut"
                    self.drive_cmd_deg = None
                    self.relay1_grinder = False
                    self.relay2_flame = False
                    _, ack = self.esp32.send_command(None, 0.0, False, False)
                    self.last_uart_ack = ack
                    continue

                if self.active_wp_idx >= len(self.route_waypoints):
                    self.running = False
                    self.state = "DONE"
                    self.drive_cmd_deg = None
                    self.relay1_grinder = False
                    self.relay2_flame = False
                    _, ack = self.esp32.send_command(None, 0.0, False, False)
                    self.last_uart_ack = ack
                    continue

                tx, ty = self.route_waypoints[self.active_wp_idx]
                dx = tx - self.rover_nx
                dy = ty - self.rover_ny
                dist = math.hypot(dx, dy)

                # Real camera perception when camera attached; otherwise transparent bench dead-reckoning
                if cam_frame is not None:
                    lat_mm, wall_mm, raw_weeds, chlorosis_side = self._analyze_live_camera_frame(cam_frame)
                    self.lateral_offset_mm = round(lat_mm, 1)
                    self.wall_distance_mm = round(wall_mm, 1)
                    self.cut_queue = group_targets_into_30mm_bands(raw_weeds, self.turret_angle_deg)
                    if chlorosis_side and (time.time() - last_clip_ts) > 8.0:
                        last_clip_ts = time.time()
                        frames_copy = list(self._clip_buffer)
                        threading.Thread(
                            target=self._save_chlorosis_clip_async,
                            args=(frames_copy, chlorosis_side, self.active_wp_idx // 2 + 1),
                            daemon=True,
                        ).start()
                else:
                    self.wall_distance_mm = round(max(240.0, dist * 4000.0), 1)
                    self.lateral_offset_mm = 0.0
                    self.cut_queue = []

                # Actuate MG996R turret & Dual Relays if a verified YOLOv8 weed is inside cut reach (60..240mm)
                active_cut = next((t for t in self.cut_queue if 60.0 <= t.y_fwd_mm <= 240.0), None)
                if active_cut is not None:
                    self.state = "CUT_BAND_ACTIVE"
                    self.drive_cmd_deg = None
                    self.turret_angle_deg = active_cut.turret_angle_deg
                    self.relay1_grinder = self.relay_mode in ("grinder", "both")
                    self.relay2_flame = self.relay_mode in ("flame", "both")
                    self.weeds_eliminated += 1
                    _, ack = self.esp32.send_command(
                        self.drive_cmd_deg, self.turret_angle_deg, self.relay1_grinder, self.relay2_flame
                    )
                    self.last_uart_ack = ack
                    continue

                self.relay1_grinder = False
                self.relay2_flame = False
                self.turret_angle_deg = 0.0

                if dist < 0.015:
                    self.rover_nx, self.rover_ny = tx, ty
                    self.active_wp_idx += 1
                    continue

                step = min(0.018, dist)
                self.rover_nx += (dx / dist) * step
                self.rover_ny += (dy / dist) * step
                self.heading_deg = round((math.degrees(math.atan2(dx, -dy)) + 360.0) % 360.0, 1)

                if abs(dx) > abs(dy):
                    self.state = "U_TURN_PIVOT"
                    self.drive_cmd_deg = 90 if dx > 0 else 270
                elif self.wall_distance_mm < 520.0:
                    self.state = "ROW_END_DETECTED"
                    self.drive_cmd_deg = 90
                elif abs(self.lateral_offset_mm) > 25.0:
                    self.state = "FURROW_CENTERING"
                    self.drive_cmd_deg = 45 if self.lateral_offset_mm < 0 else 315
                else:
                    self.state = "FURROW_GUIDANCE"
                    self.drive_cmd_deg = 0

                _, ack = self.esp32.send_command(
                    self.drive_cmd_deg, self.turret_angle_deg, self.relay1_grinder, self.relay2_flame
                )
                self.last_uart_ack = ack

    def get_cut_plan(self) -> Dict[str, Any]:
        with self.lock:
            return {
                "state": self.state,
                "running": self.running,
                "e_stopped": self.e_stopped,
                "fault_reason": self.fault_reason,
                "hardware": {
                    "camera_attached": self.camera is not None,
                    "yolo_loaded": self.yolo_model is not None,
                    "esp32_serial": self.esp32.ser is not None,
                    "simulation_mode": self.camera is None,
                },
                "rover_pose": {"nx": round(self.rover_nx, 4), "ny": round(self.rover_ny, 4)},
                "heading_deg": self.heading_deg,
                "esp32_drive_deg": self.drive_cmd_deg,
                "esp32_ack": self.last_uart_ack,
                "lateral_offset_mm": self.lateral_offset_mm,
                "wall_distance_mm": self.wall_distance_mm,
                "turret_angle_deg": self.turret_angle_deg,
                "relay1_grinder": self.relay1_grinder,
                "relay2_flame": self.relay2_flame,
                "relay_mode": self.relay_mode,
                "weeds_eliminated": self.weeds_eliminated,
                "cut_queue": [t.__dict__ for t in self.cut_queue],
                "chlorosis_clips": [c.__dict__ for c in self.chlorosis_clips[-10:]],
            }

    def render_map_jpeg(self) -> bytes:
        if cv2 is None or np is None:
            return b""
        with self.lock:
            canvas = self.bev_image.copy() if self.bev_image is not None else np.full((480, 640, 3), (30, 38, 34), dtype=np.uint8)
            h, w = canvas.shape[:2]

            for fx in self.furrows_nx:
                x = int(fx * w)
                cv2.line(canvas, (x, 0), (x, h), (90, 175, 255), 1)

            for i in range(len(self.route_waypoints) - 1):
                p1 = (int(self.route_waypoints[i][0] * w), int(self.route_waypoints[i][1] * h))
                p2 = (int(self.route_waypoints[i + 1][0] * w), int(self.route_waypoints[i + 1][1] * h))
                cv2.line(canvas, p1, p2, (212, 182, 6), 2)

            if self.start_pt:
                cv2.circle(canvas, (int(self.start_pt[0] * w), int(self.start_pt[1] * h)), 8, (0, 220, 90), -1)
            if self.end_pt:
                cv2.circle(canvas, (int(self.end_pt[0] * w), int(self.end_pt[1] * h)), 8, (60, 70, 240), -1)

            rx, ry = int(self.rover_nx * w), int(self.rover_ny * h)
            cv2.circle(canvas, (rx, ry), 10, (0, 220, 255), 3)
            ok, enc = cv2.imencode(".jpg", canvas, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
            return enc.tobytes() if ok else b""

    def render_video_jpeg(self) -> bytes:
        if cv2 is None or np is None:
            return b""
        with self.lock:
            if self.latest_camera_frame is not None:
                frame = self.latest_camera_frame.copy()
            else:
                frame = np.full((480, 640, 3), (30, 36, 42), dtype=np.uint8)
                cv2.putText(
                    frame,
                    "NO PHYSICAL CAMERA ATTACHED (BENCH MODE)",
                    (70, 235),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.65,
                    (160, 190, 210),
                    2,
                )

            h, w = frame.shape[:2]
            cv2.rectangle(frame, (0, 0), (w, 34), (15, 23, 42), -1)
            cv2.putText(
                frame,
                f"{self.state} | WALL {self.wall_distance_mm:.0f}mm | OFF {self.lateral_offset_mm:+.1f}mm | TUR {self.turret_angle_deg:+.1f}deg",
                (10, 23),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.48,
                (118, 230, 0),
                1,
            )
            ok, enc = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
            return enc.tobytes() if ok else b""


pipeline = PiRoverPipeline()

if FastAPI is not None:
    app = FastAPI(title="Weed Rover Pi 5 Onboard Pipeline", version="2.1.0")
    allowed_origins = [
        o.strip()
        for o in os.environ.get("WEED_ROVER_CORS_ORIGINS", "http://localhost:3000,http://192.168.4.1:3000").split(",")
        if o.strip()
    ]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_methods=["GET", "POST"],
        allow_headers=["Authorization", "Content-Type"],
    )

    def _require_auth(authorization: Optional[str] = Header(default=None)) -> None:
        verify_api_token(authorization)

    @app.get("/health")
    def health() -> Dict[str, Any]:
        return {
            "status": "ok",
            "service": "weed-rover-pi5-pipeline",
            "state": pipeline.state,
            "auth_required": API_TOKEN is not None,
            "camera_attached": pipeline.camera is not None,
            "yolo_loaded": pipeline.yolo_model is not None,
            "esp32_serial": pipeline.esp32.ser is not None,
        }

    @app.post("/image", dependencies=[Depends(_require_auth)])
    async def upload_image(file: UploadFile = File(...)) -> JSONResponse:
        data = await file.read()
        if not data:
            raise HTTPException(status_code=400, detail="Empty image payload")
        if len(data) > 20 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="Image exceeds 20 MB limit")
        try:
            res = pipeline.ingest_field_photo(data)
        except Exception as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return JSONResponse(res)

    @app.get("/bev_image")
    def bev_image():
        if not pipeline.bev_path.exists():
            raise HTTPException(status_code=404, detail="No BEV image generated yet. POST /image first.")
        return FileResponse(str(pipeline.bev_path), media_type="image/jpeg")

    @app.post("/start_mission", dependencies=[Depends(_require_auth)])
    async def start_mission(req: Request) -> JSONResponse:
        body = await req.json()
        start = body.get("start")
        if not isinstance(start, dict) or "nx" not in start or "ny" not in start:
            raise HTTPException(status_code=400, detail="Missing start {nx, ny}")
        end = body.get("end")
        end_nx = float(end["nx"]) if isinstance(end, dict) and "nx" in end else None
        end_ny = float(end["ny"]) if isinstance(end, dict) and "ny" in end else None
        relay_mode = str(body.get("relay_mode", "grinder"))
        res = pipeline.start_mission(float(start["nx"]), float(start["ny"]), end_nx, end_ny, relay_mode)
        return JSONResponse(res)

    @app.post("/heartbeat", dependencies=[Depends(_require_auth)])
    def heartbeat() -> JSONResponse:
        return JSONResponse(pipeline.record_heartbeat())

    @app.post("/stop", dependencies=[Depends(_require_auth)])
    def stop_rover() -> JSONResponse:
        return JSONResponse(pipeline.emergency_stop("Operator E-STOP"))

    @app.get("/cut_plan")
    def cut_plan() -> JSONResponse:
        return JSONResponse(pipeline.get_cut_plan())

    def _mjpeg_generator(render_fn):
        while True:
            jpg = render_fn()
            if jpg:
                yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpg + b"\r\n"
            time.sleep(0.12)

    @app.get("/video_feed")
    def video_feed():
        return StreamingResponse(
            _mjpeg_generator(pipeline.render_video_jpeg),
            media_type="multipart/x-mixed-replace; boundary=frame",
        )

    @app.get("/map_feed")
    def map_feed():
        return StreamingResponse(
            _mjpeg_generator(pipeline.render_map_jpeg),
            media_type="multipart/x-mixed-replace; boundary=frame",
        )
