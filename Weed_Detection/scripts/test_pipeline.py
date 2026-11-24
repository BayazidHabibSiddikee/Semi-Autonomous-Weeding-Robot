"""
Test each component of the pipeline independently.
Usage: python scripts/test_pipeline.py --component all
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

def test_detection():
    print("=== Testing Detection Pipeline (YOLO/NCNN) ===")
    from src.detection_pipeline import WeedDetector, is_weed_class
    from src.main import resolve_model_path
    import cv2
    import numpy as np

    assert is_weed_class("weed_grass") is True
    assert is_weed_class("Weed") is True
    assert is_weed_class("crop_tomato") is False
    assert is_weed_class("Maize") is False

    model_path, imgsz, conf_thresh = resolve_model_path()
    detector = WeedDetector(yolo_path=model_path, use_clip=False, use_dino=False, imgsz=imgsz, conf_threshold=conf_thresh)
    frame = np.random.randint(0, 255, (480, 640, 3), dtype=np.uint8)
    detections = detector.detect(frame)
    print(f"  Model: {model_path} | Detections on noise: {len(detections)}")
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
