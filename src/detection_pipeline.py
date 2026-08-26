"""
Combined detection pipeline: DINOv2 + CLIP + YOLO + EfficientNet.
Runs all models together for robust weed detection.
"""
import torch
import cv2
import numpy as np
from PIL import Image
from dataclasses import dataclass
from typing import List, Optional

@dataclass
class WeedDetection:
    bbox: tuple           # (x1, y1, x2, y2) in pixels
    center: tuple         # (cx, cy) in pixels
    class_name: str       # e.g. "weed_dandelion"
    confidence: float     # 0.0 - 1.0
    yolo_conf: float      # YOLO detection confidence
    clip_class: str       # CLIP classification result
    clip_conf: float      # CLIP confidence
    dino_similarity: float  # DINOv2 feature similarity
    is_weed: bool         # final verdict
    gantry_xy: Optional[tuple] = None  # (X_mm, Y_mm) after calibration

class WeedDetector:
    def __init__(self, yolo_path=None, efficientnet_path=None, use_clip=True, use_dino=True):
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.use_clip = use_clip
        self.use_dino = use_dino

        # Load YOLO
        if yolo_path:
            from ultralytics import YOLO
            print(f"Loading YOLO: {yolo_path}")
            self.yolo = YOLO(yolo_path)
        else:
            self.yolo = None

        # Load EfficientNet
        if efficientnet_path:
            from torchvision import models
            checkpoint = torch.load(efficientnet_path, map_location=self.device)
            self.ef_classes = checkpoint["classes"]
            self.efficientnet = models.efficientnet_b0(pretrained=False)
            self.efficientnet.classifier[1] = torch.nn.Linear(
                self.efficientnet.classifier[1].in_features, len(self.ef_classes)
            )
            self.efficientnet.load_state_dict(checkpoint["model_state_dict"])
            self.efficientnet = self.efficientnet.to(self.device).eval()
            print(f"Loaded EfficientNet: {len(self.ef_classes)} classes")
        else:
            self.efficientnet = None

        # Load CLIP
        if use_clip:
            import clip
            self.clip_model, self.clip_preprocess = clip.load("ViT-B/32", device=self.device)
            self.clip_model.eval()
            self.clip_texts = [
                "a photo of a tomato plant",
                "a photo of a chili pepper plant",
                "a photo of a flower plant",
                "a photo of grass weed",
                "a photo of dandelion weed",
                "a photo of purslane weed",
                "a photo of amaranth weed",
                "bare soil",
            ]
            self.clip_names = [
                "crop_tomato", "crop_chili", "crop_flower",
                "weed_grass", "weed_dandelion", "weed_purslane",
                "weed_amaranth", "soil"
            ]
            tokens = clip.tokenize(self.clip_texts).to(self.device)
            with torch.no_grad():
                self.clip_text_feats = self.clip_model.encode_text(tokens)
                self.clip_text_feats = torch.nn.functional.normalize(self.clip_text_feats, dim=-1)

        # Load DINOv2
        if use_dino:
            from transformers import AutoImageProcessor, AutoModel
            self.dino_processor = AutoImageProcessor.from_pretrained("facebook/dinov2-small")
            self.dino_model = AutoModel.from_pretrained("facebook/dinov2-small").to(self.device).eval()

        # Weed database for DINOv2 similarity
        self.weed_database = {}  # name -> feature vector

    def detect_yolo(self, frame):
        """Run YOLO detection, return list of (bbox, class, conf)."""
        if self.yolo is None:
            return []
        results = self.yolo(frame, verbose=False)
        detections = []
        for r in results:
            for box in r.boxes:
                cls_name = r.names[int(box.cls)]
                conf = float(box.conf)
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                detections.append(((x1, y1, x2, y2), cls_name, conf))
        return detections

    def classify_clip(self, crop_image):
        """Classify a cropped image with CLIP."""
        if not self.use_clip:
            return "unknown", 0.0
        import clip
        pil_img = Image.fromarray(cv2.cvtColor(crop_image, cv2.COLOR_BGR2RGB))
        img_input = self.clip_preprocess(pil_img).unsqueeze(0).to(self.device)
        with torch.no_grad():
            img_feat = self.clip_model.encode_image(img_input)
            img_feat = torch.nn.functional.normalize(img_feat, dim=-1)
            sims = (img_feat @ self.clip_text_feats.T).squeeze(0)
            probs = sims.softmax(dim=0).cpu().numpy()
        best_idx = int(probs.argmax())
        return self.clip_names[best_idx], float(probs[best_idx])

    def get_dino_feature(self, crop_image):
        """Extract DINOv2 feature from cropped image."""
        if not self.use_dino:
            return None
        pil_img = Image.fromarray(cv2.cvtColor(crop_image, cv2.COLOR_BGR2RGB))
        inputs = self.dino_processor(images=pil_img, return_tensors="pt").to(self.device)
        with torch.no_grad():
            outputs = self.dino_model(**inputs)
            feat = outputs.last_hidden_state[:, 0, :]
            feat = torch.nn.functional.normalize(feat, dim=-1)
        return feat.cpu().numpy().flatten()

    def load_weed_database(self, npz_path):
        """Load pre-extracted DINOv2 features for similarity matching."""
        data = np.load(npz_path)
        for name in data.files:
            self.weed_database[name] = data[name]
        print(f"Loaded {len(self.weed_database)} weed features")

    def detect(self, frame, conf_threshold=0.3, use_voting=True):
        """
        Full detection pipeline on a frame.
        Returns list of WeedDetection objects.
        """
        h, w = frame.shape[:2]
        yolo_dets = self.detect_yolo(frame)
        detections = []

        for bbox, yolo_class, yolo_conf in yolo_dets:
            x1, y1, x2, y2 = [int(v) for v in bbox]
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(w, x2), min(h, y2)
            crop = frame[y1:y2, x1:x2]
            if crop.size == 0:
                continue

            cx, cy = (x1 + x2) // 2, (y1 + y2) // 2

            # CLIP classification
            clip_class, clip_conf = self.classify_clip(crop)

            # DINOv2 feature
            dino_feat = self.get_dino_feature(crop)
            dino_sim = 0.0
            if dino_feat is not None and self.weed_database:
                best_sim = -1
                for name, db_feat in self.weed_database.items():
                    sim = float(np.dot(dino_feat, db_feat))
                    if sim > best_sim:
                        best_sim = sim
                dino_sim = best_sim

            # EfficientNet classification
            ef_class = yolo_class
            if self.efficientnet is not None:
                import torchvision.transforms as T
                ef_transform = T.Compose([
                    T.ToPILImage(),
                    T.Resize((224, 224)),
                    T.ToTensor(),
                    T.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
                ])
                crop_rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
                tensor = ef_transform(crop_rgb).unsqueeze(0).to(self.device)
                with torch.no_grad():
                    output = self.efficientnet(tensor)
                    probs = torch.nn.functional.softmax(output, dim=1)
                    ef_idx = int(probs.argmax())
                    ef_class = self.ef_classes[ef_idx]
                    ef_conf = float(probs[0, ef_idx])

            # Voting / consensus
            is_weed = self._vote_weed(yolo_class, clip_class, ef_class, yolo_conf, clip_conf)

            detection = WeedDetection(
                bbox=(x1, y1, x2, y2),
                center=(cx, cy),
                class_name=clip_class if clip_class.startswith("weed_") else yolo_class,
                confidence=max(yolo_conf, clip_conf),
                yolo_conf=yolo_conf,
                clip_class=clip_class,
                clip_conf=clip_conf,
                dino_similarity=dino_sim,
                is_weed=is_weed,
            )
            detections.append(detection)

        return detections

    def _vote_weed(self, yolo_class, clip_class, ef_class, yolo_conf, clip_conf):
        """Consensus decision: is this a weed?"""
        votes = 0
        if yolo_class.startswith("weed_"):
            votes += 1
        if clip_class.startswith("weed_"):
            votes += 1
        if ef_class.startswith("weed_"):
            votes += 1
        return votes >= 2  # majority vote

    def annotate_frame(self, frame, detections):
        """Draw detection results on frame."""
        annotated = frame.copy()
        for det in detections:
            x1, y1, x2, y2 = det.bbox
            if det.is_weed:
                color = (0, 0, 255)  # red for weeds
                label = f"WEED {det.class_name} {det.confidence:.2f}"
            else:
                color = (0, 255, 0)  # green for crops
                label = f"CROP {det.class_name} {det.confidence:.2f}"

            cv2.rectangle(annotated, (x1, y1), (x2, y2), color, 2)
            cv2.putText(annotated, label, (x1, y1 - 8),
                       cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1)
        return annotated
