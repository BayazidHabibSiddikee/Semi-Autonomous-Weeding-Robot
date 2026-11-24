"""
Weed Localizer Bridge (Preserves Existing Weed_Detection Research).
Wraps Weed_Detection/src/detection_pipeline.py and calibration.py so the ROS 2
Mission Supervisor can request weed detection during stationary SCAN windows
and obtain metric targets in base_footprint frame without re-writing ML code.
"""

import os
import sys
from dataclasses import dataclass

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
WEED_SRC = os.path.join(REPO_ROOT, "Weed_Detection", "src")
if WEED_SRC not in sys.path:
    sys.path.insert(0, WEED_SRC)


@dataclass
class LocalizedWeedTarget:
    weed_id: int
    species: str
    confidence: float
    pixel_u: float
    pixel_v: float
    x_mm: float
    y_mm: float


class WeedLocalizerBridge:
    """Adapter from existing YOLOv8+CLIP+DINOv2+EfficientNet pipeline to ROS 2."""

    def __init__(self, calibrator=None, detector=None):
        self.calibrator = calibrator
        self.detector = detector

    def localize_frame(self, frame, min_confidence: float = 0.78) -> list[LocalizedWeedTarget]:
        if self.detector is None:
            return []

        raw_dets = self.detector.detect(frame)
        targets: list[LocalizedWeedTarget] = []
        for idx, det in enumerate(raw_dets, start=1):
            if not getattr(det, "is_weed", False):
                continue
            conf = float(getattr(det, "confidence", 0.0))
            if conf < min_confidence:
                continue
            u, v = det.center
            if self.calibrator is not None and getattr(self.calibrator, "H", None) is not None:
                x_cm, y_cm = self.calibrator.pixel_to_gantry_2d(u, v)
                x_mm, y_mm = x_cm * 10.0, y_cm * 10.0
            else:
                x_mm, y_mm = 0.0, 0.0
            targets.append(
                LocalizedWeedTarget(
                    weed_id=idx,
                    species=getattr(det, "label", "weed_unknown"),
                    confidence=conf,
                    pixel_u=float(u),
                    pixel_v=float(v),
                    x_mm=float(x_mm),
                    y_mm=float(y_mm),
                )
            )
        return targets
