"""
Primary single-stage YOLO detection pipeline (NCNN / ONNX / PyTorch) for Raspberry Pi 4.
CLIP, DINOv2, and EfficientNet are optional offline research tools — disabled by default
for real-time edge inference.
"""
import cv2
import numpy as np
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple


NON_WEED_CLASSES = {
    "crop", "soil", "rock", "debris",
    "maize", "sugar beet", "soy", "sunflower", "potato", "pea", "bean", "pumpkin",
}


def is_weed_class(class_name: str) -> bool:
    """Explicit crop-exclusion + weed-target check across 2-class, 8-class, and 9-class schemas."""
    name = (class_name or "").strip().lower()
    if not name:
        return False
    if name.startswith("crop_") or name in NON_WEED_CLASSES:
        return False
    return name == "weed" or name.startswith("weed_") or "weed" in name


@dataclass
class WeedDetection:
    bbox: Tuple[int, int, int, int]       # (x1, y1, x2, y2) in pixels
    center: Tuple[int, int]               # (cx, cy) in pixels
    class_name: str                       # e.g. "weed_dandelion" or "Weed"
    confidence: float                     # 0.0 - 1.0
    yolo_conf: float                      # YOLO detection confidence
    is_weed: bool                         # final verdict
    clip_class: str = "disabled"
    clip_conf: float = 0.0
    dino_similarity: float = 0.0
    gantry_xy: Optional[Tuple[float, float]] = None


class WeedDetector:
    def __init__(
        self,
        yolo_path: Optional[str] = None,
        efficientnet_path: Optional[str] = None,
        use_clip: bool = False,
        use_dino: bool = False,
        imgsz: int = 640,
        conf_threshold: float = 0.30,
    ):
        self.imgsz = imgsz
        self.conf_threshold = conf_threshold
        self.use_clip = use_clip
        self.use_dino = use_dino
        self.yolo_path = yolo_path

        if yolo_path and Path(yolo_path).exists():
            from ultralytics import YOLO
            print(f"Loading YOLO detector: {yolo_path}")
            self.yolo = YOLO(str(yolo_path), task="detect")
        else:
            if yolo_path:
                print(f"WARNING: YOLO model not found at {yolo_path}")
            self.yolo = None

        self.efficientnet = None
        self.clip_model = None
        self.dino_model = None
        self.weed_database = {}

        if efficientnet_path or use_clip or use_dino:
            import torch
            self.device = "cuda" if torch.cuda.is_available() else "cpu"
            if efficientnet_path:
                from torchvision import models
                checkpoint = torch.load(efficientnet_path, map_location=self.device)
                self.ef_classes = checkpoint["classes"]
                self.efficientnet = models.efficientnet_b0(weights=None)
                self.efficientnet.classifier[1] = torch.nn.Linear(
                    self.efficientnet.classifier[1].in_features, len(self.ef_classes)
                )
                self.efficientnet.load_state_dict(checkpoint["model_state_dict"])
                self.efficientnet = self.efficientnet.to(self.device).eval()

            if use_clip:
                import clip
                self.clip_model, self.clip_preprocess = clip.load("ViT-B/32", device=self.device)
                self.clip_model.eval()
                self.clip_names = [
                    "crop_tomato", "crop_chili", "crop_flower",
                    "weed_grass", "weed_dandelion", "weed_purslane",
                    "weed_amaranth", "soil",
                ]
                tokens = clip.tokenize([f"a photo of {n.replace('_', ' ')}" for n in self.clip_names]).to(self.device)
                with torch.no_grad():
                    self.clip_text_feats = torch.nn.functional.normalize(
                        self.clip_model.encode_text(tokens), dim=-1
                    )

            if use_dino:
                from transformers import AutoImageProcessor, AutoModel
                self.dino_processor = AutoImageProcessor.from_pretrained("facebook/dinov2-small")
                self.dino_model = AutoModel.from_pretrained("facebook/dinov2-small").to(self.device).eval()

    def detect_yolo(self, frame: np.ndarray, conf_threshold: Optional[float] = None):
        """Run primary YOLO (NCNN / ONNX / PyTorch) detection."""
        if self.yolo is None:
            return []
        thresh = self.conf_threshold if conf_threshold is None else conf_threshold
        results = self.yolo(frame, imgsz=self.imgsz, conf=thresh, verbose=False)
        detections = []
        for r in results:
            for box in r.boxes:
                cls_name = r.names[int(box.cls)]
                conf = float(box.conf)
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                detections.append(((x1, y1, x2, y2), cls_name, conf))
        return detections

    def load_weed_database(self, npz_path: str):
        """Optional: load pre-extracted DINOv2 features for offline similarity analysis."""
        data = np.load(npz_path)
        for name in data.files:
            self.weed_database[name] = data[name]
        print(f"Loaded {len(self.weed_database)} DINOv2 weed features")

    def detect(self, frame: np.ndarray, conf_threshold: Optional[float] = None, use_voting: bool = False) -> List[WeedDetection]:
        """
        Single-stage real-time detection pipeline.
        Decision is confidence-threshold + explicit crop-exclusion based on YOLO output.
        """
        thresh = self.conf_threshold if conf_threshold is None else conf_threshold
        h, w = frame.shape[:2]
        yolo_dets = self.detect_yolo(frame, conf_threshold=thresh)
        detections: List[WeedDetection] = []

        for bbox, yolo_class, yolo_conf in yolo_dets:
            if yolo_conf < thresh:
                continue

            x1, y1, x2, y2 = [int(v) for v in bbox]
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(w, x2), min(h, y2)
            if x2 <= x1 or y2 <= y1:
                continue

            cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
            is_weed = is_weed_class(yolo_class)

            detections.append(
                WeedDetection(
                    bbox=(x1, y1, x2, y2),
                    center=(cx, cy),
                    class_name=yolo_class,
                    confidence=yolo_conf,
                    yolo_conf=yolo_conf,
                    is_weed=is_weed,
                )
            )

        return detections

    def annotate_frame(self, frame: np.ndarray, detections: List[WeedDetection]) -> np.ndarray:
        """Draw detection results on frame."""
        annotated = frame.copy()
        for det in detections:
            x1, y1, x2, y2 = det.bbox
            if det.is_weed:
                color = (0, 0, 255)
                label = f"WEED {det.class_name} {det.confidence:.2f}"
            else:
                color = (0, 255, 0)
                label = f"CROP {det.class_name} {det.confidence:.2f}"

            cv2.rectangle(annotated, (x1, y1), (x2, y2), color, 2)
            cv2.putText(annotated, label, (x1, max(16, y1 - 8)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)
        return annotated
