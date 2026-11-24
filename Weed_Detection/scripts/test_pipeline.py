"""
Test each component of the pipeline independently.
Usage: python scripts/test_pipeline.py --component all
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

def _iou(box_a, box_b):
    ax1, ay1, ax2, ay2 = box_a
    bx1, by1, bx2, by2 = box_b
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    area_a = max(0, ax2 - ax1) * max(0, ay2 - ay1)
    area_b = max(0, bx2 - bx1) * max(0, by2 - by1)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def test_detection():
    print("=== Testing Detection Pipeline (Real Labeled Fixtures) ===")
    from pathlib import Path
    from src.detection_pipeline import WeedDetector, is_weed_class
    from src.main import resolve_model_path
    import cv2

    assert is_weed_class("weed_grass") is True
    assert is_weed_class("weed") is True
    assert is_weed_class("crop_tomato") is False
    assert is_weed_class("crop") is False

    model_path, imgsz, conf_thresh = resolve_model_path()
    detector = WeedDetector(yolo_path=model_path, use_clip=False, use_dino=False, imgsz=imgsz, conf_threshold=conf_thresh)

    fixtures_dir = Path(__file__).resolve().parent.parent / "tests" / "fixtures"
    img_paths = sorted(p for p in fixtures_dir.iterdir() if p.suffix.lower() in {".jpg", ".jpeg", ".png"})
    assert img_paths, f"No test fixtures found in {fixtures_dir}"

    matched_gt = 0
    total_gt = 0
    for img_path in img_paths:
        frame = cv2.imread(str(img_path))
        h, w = frame.shape[:2]
        detections = detector.detect(frame)

        lbl_path = img_path.with_suffix(".txt")
        gt_boxes = []
        for line in lbl_path.read_text().splitlines():
            parts = line.strip().split()
            if len(parts) < 5:
                continue
            cid = int(float(parts[0]))
            cx, cy, bw, bh = [float(v) for v in parts[1:5]]
            gt_boxes.append((
                cid == 1,
                (int((cx - bw / 2) * w), int((cy - bh / 2) * h), int((cx + bw / 2) * w), int((cy + bh / 2) * h)),
            ))

        total_gt += len(gt_boxes)
        for gt_is_weed, gt_box in gt_boxes:
            best_iou = max((_iou(gt_box, d.bbox) for d in detections if d.is_weed == gt_is_weed and d.confidence >= conf_thresh), default=0.0)
            if best_iou >= 0.40:
                matched_gt += 1

        print(f"  {img_path.name}: {len(detections)} preds vs {len(gt_boxes)} GT boxes")
        for d in detections:
            print(f"    {d.class_name}: conf={d.confidence:.3f} weed={d.is_weed} bbox={d.bbox}")

    assert matched_gt >= 1, f"Expected at least 1 GT box matched at IoU>=0.40, got {matched_gt}/{total_gt}"
    print(f"  Matched {matched_gt}/{total_gt} GT boxes (IoU >= 0.40, conf >= {conf_thresh})")
    print("  Detection test PASSED\n")

def test_calibration():
    print("=== Testing Calibration ===")
    from src.calibration import CameraCalibrator

    cal = CameraCalibrator(camera_height_mm=500)
    # Test pixel_to_gantry with dummy homography
    import numpy as np
    H = np.array([
        [0.5, 0.0, 100.0],
        [0.0, 0.5, 50.0],
        [0.0, 0.0, 1.0]
    ])
    cal.H = H

    x, y = cal.pixel_to_gantry_2d(200, 300)
    print(f"  Pixel(200,300) → Gantry(X={x:.1f}, Y={y:.1f}mm)")
    assert x == 200.0, f"Expected 200, got {x}"
    assert y == 200.0, f"Expected 200, got {y}"
    print("  Calibration test PASSED\n")

def test_gantry():
    print("=== Testing Gantry Control ===")
    from src.gantry_control import GantrySimulator

    gantry = GantrySimulator()
    gantry.connect()
    gantry.move_to(100, 50)
    gantry.move_home()
    gantry.disconnect()
    print("  Gantry test PASSED\n")

def test_laser():
    print("=== Testing Laser Control ===")
    from src.laser_control import LaserController

    laser = LaserController(simulate=True)
    laser.fire(100)
    laser.emergency_off()
    laser.cleanup()
    print("  Laser test PASSED\n")

def test_clip():
    print("=== Testing CLIP Classifier ===")
    from src.clip_classifier import CLIPWeedClassifier
    from PIL import Image
    import numpy as np

    classifier = CLIPWeedClassifier()
    # Create dummy image
    arr = np.random.randint(0, 255, (224, 224, 3), dtype=np.uint8)
    img = Image.fromarray(arr)
    results = classifier.classify(img, top_k=3)
    print(f"  Results: {results}")
    print("  CLIP test PASSED\n")

def test_dino():
    print("=== Testing DINOv2 Extractor ===")
    from src.dino_features import DINOv2Extractor
    from PIL import Image
    import numpy as np

    extractor = DINOv2Extractor()
    arr = np.random.randint(0, 255, (224, 224, 3), dtype=np.uint8)
    img = Image.fromarray(arr)
    feat = extractor.extract(img)
    print(f"  Feature dim: {len(feat)}")
    print(f"  Feature norm: {np.linalg.norm(feat):.4f}")
    print("  DINOv2 test PASSED\n")

def main():
    tests = {
        "detection": test_detection,
        "calibration": test_calibration,
        "gantry": test_gantry,
        "laser": test_laser,
        "clip": test_clip,
        "dino": test_dino,
    }

    component = sys.argv[1] if len(sys.argv) > 1 else "all"

    if component == "all":
        for name, test_fn in tests.items():
            try:
                test_fn()
            except Exception as e:
                print(f"  {name} test FAILED: {e}\n")
    elif component in tests:
        tests[component]()
    else:
        print(f"Unknown component: {component}")
        print(f"Available: {', '.join(tests.keys())}, all")

if __name__ == "__main__":
    main()
