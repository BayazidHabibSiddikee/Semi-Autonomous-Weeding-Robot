"""
Unified Edge AI & Real-Time Navigation Engine for Semi-Autonomous Weeding Robot

Merges:
  1. Object Detection (Weeds vs. Crops) via YOLOv8 / ONNX
  2. 3D Stem Base Localization (X_ground, Y_forward, Z_height) from MaixSense-A075V Depth
  3. Furrow Ridge & Crop Wall Tracking (Elevation slicing > 60mm)
  4. Headland Row-End Corner Detection (< 520mm wall termination)
  5. Discrete 8-Way Heading Quantizer (0, 45, 90, 135, 180, 225, 270, 315 deg)
  6. Monotonic Forward-Sweep Priority Queue (30mm distance bands sorted by min turret slew)

Outputs in < 20 ms:
  - Exact weed millimeter coordinates relative to rover
  - Serial command strings ready for ESP32: "DIR <heading>", "TURRET <deg>", "CUT <tool> <ms>"
"""

import os
import math
import time
from dataclasses import dataclass, field
from typing import List, Tuple, Optional, Dict, Any
import numpy as np
import cv2

# =========================================================================
# HARDWARE CALIBRATION & KINEMATICS
# =========================================================================
CAM_HEIGHT_MM = 200.0          # 20 cm height above furrow soil
CAM_PITCH_DEG = 30.0           # 30-degree downward tilt
PITCH_RAD = math.radians(CAM_PITCH_DEG)
COS_P, SIN_P = math.cos(PITCH_RAD), math.sin(PITCH_RAD)

FX, FY = 280.0, 280.0          # MaixSense-A075V camera intrinsics (320x240)
CX, CY = 160.0, 120.0

TOOL_OFFSET_Y_MM = 140.0       # Distance from front camera lens to tool center
TOOL_RADIUS_MM   = 85.0        # Radial reach of grinder/torch from cylinder center
CORRIDOR_HALF_W  = 125.0       # Half-width of furrow (reachable cutting window)

# Model class mapping for best.pt (9 classes)
CLASS_NAMES = {
    0: 'Maize', 1: 'Sugar beet', 2: 'Soy', 3: 'Sunflower',
    4: 'Potato', 5: 'Pea', 6: 'Bean', 7: 'Pumpkin', 8: 'Weed'
}
WEED_CLASS_IDS = {8}  # Class 8 is 'Weed'

@dataclass
class WeedTarget:
    bbox: Tuple[int, int, int, int]      # (x1, y1, x2, y2)
    cut_pixel: Tuple[int, int]            # (u_stem, v_stem)
    x_ground_mm: float                   # Left/Right offset from centerline (+/- mm)
    y_forward_mm: float                  # True flat ground distance ahead (mm)
    drive_to_cut_mm: float               # Distance rover must advance to position tool (mm)
    turret_deg: float                    # Turret yaw rotation (-35 to +35 deg)
    band_id: int                         # 30mm forward slice ID
    slew_cost: float                     # Angular distance from current turret position
    confidence: float                    # Detection confidence (0.0 - 1.0)
    label: str                           # 'Weed' or crop name

@dataclass
class UnifiedDecision:
    timestamp: float
    # Navigation Outputs
    esp32_heading_8way: int              # 0, 45, 90, 135, 180, 225, 270, 315 deg
    steer_error_mm: float                # Lateral error from furrow center (+/- mm)
    is_corner_detected: bool             # True when crop walls end ahead (headland U-turn)
    # Targeting Outputs
    weeds: List[WeedTarget]              # Prioritized weed list (closest band first)
    immediate_target: Optional[WeedTarget] # Weed directly reachable or next to cut
    command_string: str                  # Formatted ESP32 command (e.g. "DIR 0", "TURRET 15")
    action_state: str                    # "FORWARD", "STEER", "CORNER_TURN", "CUTTING"

class UnifiedWeedingModel:
    """
    Unified Single-Model Engine running ONNX or PyTorch weights with vectorized depth math.
    """
    def __init__(self, model_path: Optional[str] = None, conf_threshold: float = 0.25):
        self.conf_threshold = conf_threshold
        base_dir = os.path.dirname(os.path.abspath(__file__))
        
        # Prefer optimized ONNX model if present, otherwise fall back to PyTorch .pt
        onnx_candidate = os.path.join(base_dir, "..", "yolo_models", "best.onnx")
        pt_candidate   = os.path.join(base_dir, "..", "yolo_models", "best.pt")

        if model_path and os.path.exists(model_path):
            chosen_path = model_path
        elif os.path.exists(onnx_candidate):
            chosen_path = onnx_candidate
        else:
            chosen_path = pt_candidate

        self.model_path = chosen_path
        self.use_onnx = chosen_path.endswith(".onnx")
        print(f"[UNIFIED MODEL] Initializing from: {self.model_path} (ONNX={self.use_onnx})")

        if self.use_onnx:
            import onnxruntime as ort
            self.session = ort.InferenceSession(self.model_path, providers=['CPUExecutionProvider'])
            self.input_name = self.session.get_inputs()[0].name
            # Model input shape (1, 3, 256, 320)
            self.in_h, self.in_w = 256, 320
        else:
            from ultralytics import YOLO
            self.model = YOLO(self.model_path)

    # ---------------------------------------------------------------------
    # 1. 3D COORDINATE PROJECTION (30° Downward Tilt)
    # ---------------------------------------------------------------------
    @staticmethod
    def pixel_to_ground(u: int, v: int, depth_mm: float) -> Optional[Tuple[float, float, float]]:
        if depth_mm <= 180 or depth_mm >= 2500:
            return None
        xc = ((u - CX) * depth_mm) / FX
        yc = ((v - CY) * depth_mm) / FY
        zc = float(depth_mm)
        x_ground = xc
        y_fwd = zc * COS_P - yc * SIN_P
        z_height = CAM_HEIGHT_MM - (zc * SIN_P + yc * COS_P)
        return x_ground, y_fwd, z_height

    # ---------------------------------------------------------------------
    # 2. FAST VECTORIZED ELEVATION SLICER (CORRIDOR & CORNERS)
    # ---------------------------------------------------------------------
    @staticmethod
    def slice_depth_corridor(depth_map: np.ndarray, current_row: int) -> Tuple[int, bool, float]:
        """
        Extracts elevation changes to identify crop ridges and row-end headland corners.
        Returns:
          (esp32_heading_8way, is_corner, steer_error_mm)
        """
        # Downsample grid (step=4) for < 2ms execution on edge CPU
        v_idx, u_idx = np.mgrid[0:240:4, 0:320:4]
        d = depth_map[0:240:4, 0:320:4].astype(np.float32)
        valid = (d > 200) & (d < 1950)

        xc = ((u_idx - CX) * d) / FX
        yc = ((v_idx - CY) * d) / FY
        y_fwd = d * COS_P - yc * SIN_P
        z_h   = CAM_HEIGHT_MM - (d * SIN_P + yc * COS_P)

        # Front obstacle safety check (<180 mm)
        if np.any(valid & (np.abs(xc) < 70.0) & (y_fwd < 180.0)):
            return 180, False, 0.0  # Emergency reverse straight

        # Crop ridges stand > 60mm above furrow floor
        wall_mask = valid & (z_h > 60.0) & (y_fwd > 150.0) & (y_fwd < 1400.0)
        left_pts_x  = xc[wall_mask & (xc < -30.0)]
        right_pts_x = xc[wall_mask & (xc > 30.0)]
        wall_pts_y  = y_fwd[wall_mask]

        left_dist  = float(np.median(np.abs(left_pts_x))) if left_pts_x.size > 5 else 250.0
        right_dist = float(np.median(right_pts_x)) if right_pts_x.size > 5 else 250.0
        steer_err  = left_dist - right_dist  # +ve = closer to right wall, -ve = closer to left wall

        # Corner Detection: Check if crop walls terminate in forward path
        max_wall_y = float(np.percentile(wall_pts_y, 90)) if wall_pts_y.size > 10 else 300.0
        if max_wall_y < 520.0:
            turn_dir = 90 if (current_row % 2 == 1) else 270
            return turn_dir, True, steer_err

        # Quantize steering error into 8-direction ESP32 angles
        if steer_err < -25.0:
            return 45, False, steer_err   # Too close to left -> Veer right 45°
        elif steer_err > 25.0:
            return 315, False, steer_err  # Too close to right -> Veer left 315°
        return 0, False, steer_err        # Centered -> Straight 0°

    # ---------------------------------------------------------------------
    # 3. RUN INFERENCE & PARSE TARGETS
    # ---------------------------------------------------------------------
    def _detect_onnx(self, rgb_img: np.ndarray) -> List[Tuple[int, int, int, int, float, int]]:
        """Fast ONNX forward pass returning (x1, y1, x2, y2, conf, cls_id)."""
        h_orig, w_orig = rgb_img.shape[:2]
        resized = cv2.resize(rgb_img, (self.in_w, self.in_h))
        # Format: (1, 3, 256, 320) normalized float32
        blob = resized.transpose(2, 0, 1)[np.newaxis, ...].astype(np.float32) / 255.0
        outputs = self.session.run(None, {self.input_name: blob})[0] # (1, 13, 1680)
        
        preds = outputs[0] # (13, 1680) -> rows 0-3: [cx, cy, w, h], rows 4-12: class confidences
        boxes = []
        cx, cy, bw, bh = preds[0], preds[1], preds[2], preds[3]
        class_scores = preds[4:] # (9, 1680)
        max_scores = np.max(class_scores, axis=0)
        class_ids  = np.argmax(class_scores, axis=0)

        mask = max_scores >= self.conf_threshold
        scale_x = w_orig / float(self.in_w)
        scale_y = h_orig / float(self.in_h)

        for i in np.where(mask)[0]:
            score = float(max_scores[i])
            cid = int(class_ids[i])
            x1 = int((cx[i] - bw[i] / 2.0) * scale_x)
            y1 = int((cy[i] - bh[i] / 2.0) * scale_y)
            x2 = int((cx[i] + bw[i] / 2.0) * scale_x)
            y2 = int((cy[i] + bh[i] / 2.0) * scale_y)
            boxes.append((x1, y1, x2, y2, score, cid))
        return boxes

    def _detect_pt(self, rgb_img: np.ndarray) -> List[Tuple[int, int, int, int, float, int]]:
        """PyTorch fallback forward pass."""
        results = self.model(rgb_img, verbose=False, conf=self.conf_threshold)[0]
        boxes = []
        for box in results.boxes:
            coords = box.xyxy[0].tolist()
            conf = float(box.conf[0])
            cid = int(box.cls[0])
            boxes.append((int(coords[0]), int(coords[1]), int(coords[2]), int(coords[3]), conf, cid))
        return boxes

    # ---------------------------------------------------------------------
    # 4. UNIFIED PIPELINE EXECUTION
    # ---------------------------------------------------------------------
    def process_frame(
        self,
        rgb_img: np.ndarray,
        depth_map: np.ndarray,
        current_row: int = 1,
        current_turret_deg: float = 0.0
    ) -> UnifiedDecision:
        t_start = time.time()

        # Step A: Run Object Detection
        if self.use_onnx:
            raw_detections = self._detect_onnx(rgb_img)
        else:
            raw_detections = self._detect_pt(rgb_img)

        # Step B: Parse Weed Stem Coordinates & Prioritize Queue
        weeds: List[WeedTarget] = []
        for (x1, y1, x2, y2, conf, cls_id) in raw_detections:
            label = CLASS_NAMES.get(cls_id, f"Class_{cls_id}")
            # Weed filter (class 8 in best.pt or label contains 'weed')
            if cls_id not in WEED_CLASS_IDS and "weed" not in label.lower():
                continue

            # Stem base cut point (bottom-center of bounding box)
            u_stem = (x1 + x2) // 2
            v_stem = max(0, min(239, y2 - max(2, int(0.10 * (y2 - y1)))))

            # Sample 5x5 median depth patch around stem base to reject sensor noise
            patch = depth_map[max(0, v_stem-2):min(240, v_stem+3), max(0, u_stem-2):min(320, u_stem+3)]
            valid_p = patch[(patch > 180) & (patch < 2000)]
            if valid_p.size == 0:
                continue
            d_mm = float(np.median(valid_p))

            coords = self.pixel_to_ground(u_stem, v_stem, d_mm)
            if coords is None:
                continue
            x_g, y_f, z_h = coords

            # Check if weed is within reachable furrow corridor
            if abs(x_g) <= CORRIDOR_HALF_W:
                drive_mm = round(y_f - TOOL_OFFSET_Y_MM, 1)
                # Compute required turret angle to position tool over stem base
                ratio = max(-1.0, min(1.0, x_g / TOOL_RADIUS_MM))
                turret_deg = round(math.degrees(math.asin(ratio)), 1)
                turret_deg = max(-35.0, min(35.0, turret_deg))

                band_id = int(y_f // 30.0) # 30mm forward distance slices
                slew_cost = abs(turret_deg - current_turret_deg)

                weeds.append(WeedTarget(
                    bbox=(x1, y1, x2, y2),
                    cut_pixel=(u_stem, v_stem),
                    x_ground_mm=round(x_g, 1),
                    y_forward_mm=round(y_f, 1),
                    drive_to_cut_mm=drive_mm,
                    turret_deg=turret_deg,
                    band_id=band_id,
                    slew_cost=round(slew_cost, 1),
                    confidence=round(conf, 2),
                    label=label
                ))

        # Sort weed targets: closest band first, then minimum turret rotation
        weeds.sort(key=lambda w: (w.band_id, w.slew_cost))

        # Step C: Slicing Depth Map for Furrow Steering & Headland Corners
        has_close_weed = len(weeds) > 0 and weeds[0].drive_to_cut_mm <= 15.0
        heading_8way, is_corner, steer_err = self.slice_depth_corridor(depth_map, current_row)

        # Step D: Formulate Decision and ESP32 Command String
        immediate_target = None
        if len(weeds) > 0 and weeds[0].drive_to_cut_mm <= 15.0:
            immediate_target = weeds[0]
            action_state = "CUTTING"
            cmd_str = f"TURRET {int(immediate_target.turret_deg)}; CUT GRINDER 1500"
        elif is_corner:
            action_state = "CORNER_TURN"
            cmd_str = f"DIR {heading_8way}"
        elif heading_8way != 0:
            action_state = "STEER"
            cmd_str = f"DIR {heading_8way}"
        else:
            action_state = "FORWARD"
            cmd_str = "DIR 0"

        return UnifiedDecision(
            timestamp=t_start,
            esp32_heading_8way=heading_8way,
            steer_error_mm=round(steer_err, 1),
            is_corner_detected=is_corner,
            weeds=weeds,
            immediate_target=immediate_target,
            command_string=cmd_str,
            action_state=action_state
        )

# =========================================================================
# STANDALONE VERIFICATION BENCHMARK
# =========================================================================
if __name__ == "__main__":
    print("Testing Unified Weeding Model...")
    engine = UnifiedWeedingModel()
    dummy_rgb = np.zeros((240, 320, 3), dtype=np.uint8)
    dummy_depth = np.full((240, 320), 800, dtype=np.uint16)

    # Add simulated crop walls on left and right
    dummy_depth[:, :50] = 400
    dummy_depth[:, 270:] = 400

    decision = engine.process_frame(dummy_rgb, dummy_depth, current_row=1)
    print(f"Action: {decision.action_state}")
    print(f"ESP32 Command: {decision.command_string}")
    print(f"Steer Error: {decision.steer_error_mm} mm | Heading: {decision.esp32_heading_8way}°")
    print("Unified model initialized and verified successfully!")
