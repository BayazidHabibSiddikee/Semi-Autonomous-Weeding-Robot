"""
Main pipeline: Camera -> YOLO/NCNN Detect -> Safety & Crop Exclusion -> Calibrate -> Actuate.
Loads model path and thresholds from configs/model_config.yaml.
"""
import argparse
import sys
import time
from pathlib import Path
from typing import Optional
import cv2
import yaml

BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from src.detection_pipeline import WeedDetector


# BASE_DIR defined above


def resolve_model_path(explicit_model: Optional[str] = None, model_cfg_path: Path = BASE_DIR / "configs" / "model_config.yaml"):
    """Resolve the best available local model (NCNN -> custom .pt -> ONNX -> fallback .pt)."""
    imgsz = 640
    conf_threshold = 0.30

    candidates = []
    if explicit_model:
        candidates.append(explicit_model)

    if model_cfg_path.exists():
        with open(model_cfg_path) as f:
            mcfg = yaml.safe_load(f) or {}
        ycfg = mcfg.get("yolo", {})
        imgsz = int(ycfg.get("input_size", 640))
        conf_threshold = float(ycfg.get("conf_threshold", 0.30))
        if ycfg.get("deployed_model"):
            candidates.append(ycfg["deployed_model"])
        for fb in ycfg.get("fallback_weights", []):
            candidates.append(fb)

    for cand in candidates:
        p = Path(cand)
        if not p.is_absolute():
            p = (BASE_DIR / p).resolve()
        if p.exists():
            return str(p), imgsz, conf_threshold

    return None, imgsz, conf_threshold


class WeedLaserRobot:
    def __init__(
        self,
        config_path: str = "configs/robot_config.yaml",
        model_path: Optional[str] = None,
        simulate: bool = False,
        arm_actuator: bool = False,
    ):
        cfg_file = Path(config_path)
        if not cfg_file.is_absolute():
            cfg_file = BASE_DIR / cfg_file
        with open(cfg_file) as f:
            self.config = yaml.safe_load(f)

        self.explicit_model = model_path
        self.simulate = simulate
        self.arm_actuator = arm_actuator
        if not self.arm_actuator:
            print("[SAFETY] Actuator DISARMED (dry-run logging only). Pass --arm-actuator only with hardware interlocks & E-Stop verified.")
        self.running = False
        self.detector = None
        self.calibrator = None
        self.gantry = None
        self.laser = None
        self.safety = None
        self.camera = None

    def start(self):
        print("=" * 50)
        print("  WEED LASER ROBOT — Starting Up (YOLO/NCNN)")
        print("=" * 50)

        print("\n[1/5] Loading primary YOLO detector...")
        resolved_model, imgsz, conf_thresh = resolve_model_path(self.explicit_model)
        self.detector = WeedDetector(
            yolo_path=resolved_model,
            use_clip=False,
            use_dino=False,
            imgsz=imgsz,
            conf_threshold=conf_thresh,
        )

        print("\n[2/5] Loading calibration...")
        from src.calibration import CameraCalibrator
        from src.gantry_control import create_gantry
        from src.laser_control import LaserController, LaserSafety

        self.calibrator = CameraCalibrator()
        cal_path = BASE_DIR / "models" / "calibration.npz"
        if cal_path.exists():
            self.calibrator.load_calibration(str(cal_path))
        else:
            print("  WARNING: No calibration found; using proportional mapping.")

        print("\n[3/5] Connecting gantry...")
        self.gantry = create_gantry(simulate=self.simulate, port=self.config["serial"]["port"])
        self.gantry.connect()

        print("\n[4/5] Initializing actuator...")
        self.laser = LaserController(simulate=self.simulate)

        print("\n[5/5] Starting independent safety system...")
        self.safety = LaserSafety(simulate=self.simulate)

        cam_cfg = self.config["camera"]
        self.camera = cv2.VideoCapture(cam_cfg["device_id"])
        self.camera.set(cv2.CAP_PROP_FRAME_WIDTH, cam_cfg["resolution"]["width"])
        self.camera.set(cv2.CAP_PROP_FRAME_HEIGHT, cam_cfg["resolution"]["height"])

        if not self.camera.isOpened():
            print("ERROR: Cannot open camera!")
            return False

        print("\nALL SYSTEMS READY")
        return True

    def process_frame(self, frame):
        if not self.safety.check_safety():
            print("Safety check failed — pausing")
            self.laser.emergency_off()
            return []

        detections = self.detector.detect(frame)
        weeds = [d for d in detections if d.is_weed]
        if not weeds:
            return detections

        for weed in weeds:
            u, v = weed.center
            if self.calibrator.H is not None:
                x_mm, y_mm = self.calibrator.pixel_to_gantry_2d(u, v)
            else:
                h, w = frame.shape[:2]
                x_mm = (u / w) * self.config["gantry"]["x_travel"]
                y_mm = (v / h) * self.config["gantry"]["y_travel"]
            weed.gantry_xy = (x_mm, y_mm)

            self.gantry.move_to(x_mm, y_mm, speed=self.config["gantry"]["max_speed"])
            if self.arm_actuator and self.safety.check_safety():
                dwell = self.config["laser"]["dwell_time_ms"]
                self.laser.fire(duration_ms=dwell)
            elif not self.arm_actuator:
                print(f"  [DRY-RUN] Weed at ({x_mm:.1f}, {y_mm:.1f} mm) — actuator disarmed")

        self.gantry.move_home()
        return detections

    def run(self):
        self.running = True
        frame_idx = 0
        stats = {"frames": 0, "weeds_found": 0}

        while self.running:
            ret, frame = self.camera.read()
            if not ret:
                break
            detections = self.process_frame(frame)
            stats["frames"] += 1
            stats["weeds_found"] += sum(1 for d in detections if d.is_weed)
            annotated = self.detector.annotate_frame(frame, detections)
            cv2.imshow("Weed Laser Robot", annotated)

            key = cv2.waitKey(1) & 0xFF
            if key == ord("q"):
                break
            elif key == ord("e"):
                self.emergency_stop()
            frame_idx += 1

        self.stop()
        print(f"\nSession stats: {stats}")

    def emergency_stop(self):
        print("\n*** EMERGENCY STOP ***")
        self.laser.emergency_off()
        self.gantry.emergency_stop()
        self.running = False

    def stop(self):
        self.running = False
        self.laser.emergency_off()
        self.gantry.move_home()
        self.gantry.disconnect()
        self.laser.cleanup()
        if self.safety:
            self.safety.cleanup()
        if self.camera:
            self.camera.release()
        cv2.destroyAllWindows()


def main():
    parser = argparse.ArgumentParser(description="Weed Laser Robot (YOLO/NCNN)")
    parser.add_argument("--config", type=str, default="configs/robot_config.yaml")
    parser.add_argument("--model", type=str, default=None, help="Path to NCNN dir, ONNX, or .pt model")
    parser.add_argument("--source", type=str, default="0", help="Camera index, video, or image path (detect-only)")
    parser.add_argument("--simulate", action="store_true", help="Run in simulation mode")
    parser.add_argument("--arm-actuator", action="store_true", help="Arm physical actuator (requires hardware interlock & E-Stop)")
    parser.add_argument("--detect-only", action="store_true", help="Detection only, no gantry/laser")
    args = parser.parse_args()

    if args.detect_only:
        resolved_model, imgsz, conf_thresh = resolve_model_path(args.model)
        detector = WeedDetector(
            yolo_path=resolved_model,
            use_clip=False,
            use_dino=False,
            imgsz=imgsz,
            conf_threshold=conf_thresh,
        )
        src = int(args.source) if args.source.isdigit() else args.source
        if isinstance(src, str) and Path(src).suffix.lower() in {".jpg", ".jpeg", ".png", ".bmp"}:
            frame = cv2.imread(src)
            t0 = time.perf_counter()
            detections = detector.detect(frame)
            ms = (time.perf_counter() - t0) * 1000
            print(f"Inference: {ms:.1f} ms | Detections: {len(detections)}")
            for d in detections:
                print(f"  {d.class_name} ({d.confidence:.2f}) weed={d.is_weed} bbox={d.bbox}")
            return

        cap = cv2.VideoCapture(src)
        while cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                break
            t0 = time.perf_counter()
            detections = detector.detect(frame)
            ms = (time.perf_counter() - t0) * 1000
            annotated = detector.annotate_frame(frame, detections)
            cv2.putText(annotated, f"{ms:.1f} ms ({1000/max(ms,1):.1f} FPS)", (10, 28),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
            cv2.imshow("Weed Detection (YOLO/NCNN)", annotated)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break
        cap.release()
        cv2.destroyAllWindows()
    else:
        robot = WeedLaserRobot(
            config_path=args.config,
            model_path=args.model,
            simulate=args.simulate,
            arm_actuator=args.arm_actuator,
        )
        if robot.start():
            robot.run()


if __name__ == "__main__":
    main()
