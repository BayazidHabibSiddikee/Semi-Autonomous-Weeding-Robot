"""
Main pipeline: Camera → Detect → Calibrate → Move → Laser.
Full integration of all components.
"""
import cv2
import time
import argparse
import yaml
import numpy as np
from pathlib import Path

from src.detection_pipeline import WeedDetector
from src.calibration import CameraCalibrator
from src.gantry_control import create_gantry
from src.laser_control import LaserController, LaserSafety

class WeedLaserRobot:
    def __init__(self, config_path="configs/robot_config.yaml", simulate=False):
        with open(config_path) as f:
            self.config = yaml.safe_load(f)

        self.simulate = simulate
        self.running = False

        # Components (initialized in start())
        self.detector = None
        self.calibrator = None
        self.gantry = None
        self.laser = None
        self.safety = None
        self.camera = None

    def start(self):
        """Initialize all components."""
        print("=" * 50)
        print("  WEED LASER ROBOT — Starting Up")
        print("=" * 50)

        # Load detection models
        print("\n[1/5] Loading AI models...")
        self.detector = WeedDetector(
            yolo_path="models/yolo_weeds.pt",
            efficientnet_path="models/efficientnet_weeds.pt",
            use_clip=True,
            use_dino=True,
        )
        # Load DINOv2 weed database if available
        dino_path = "models/dino_features.npz"
        if Path(dino_path).exists():
            self.detector.load_weed_database(dino_path)

        # Load calibration
        print("\n[2/5] Loading calibration...")
        self.calibrator = CameraCalibrator()
        cal_path = "models/calibration.npz"
        if Path(cal_path).exists():
            self.calibrator.load_calibration(cal_path)
        else:
            print("  WARNING: No calibration found! Run calibration.py first.")

        # Connect gantry
        print("\n[3/5] Connecting gantry...")
        self.gantry = create_gantry(
            simulate=self.simulate,
            port=self.config["serial"]["port"]
        )
        self.gantry.connect()

        # Initialize laser
        print("\n[4/5] Initializing laser...")
        self.laser = LaserController(simulate=self.simulate)

        # Safety system
        print("\n[5/5] Starting safety system...")
        self.safety = LaserSafety(simulate=self.simulate)

        # Open camera
        cam_cfg = self.config["camera"]
        self.camera = cv2.VideoCapture(cam_cfg["device_id"])
        self.camera.set(cv2.CAP_PROP_FRAME_WIDTH, cam_cfg["resolution"]["width"])
        self.camera.set(cv2.CAP_PROP_FRAME_HEIGHT, cam_cfg["resolution"]["height"])

        if not self.camera.isOpened():
            print("ERROR: Cannot open camera!")
            return False

        print("\n" + "=" * 50)
        print("  ALL SYSTEMS READY")
        print("=" * 50)
        return True

    def process_frame(self, frame):
        """Process a single frame: detect weeds → move → laser."""
        if not self.safety.check_safety():
            print("Safety check failed — pausing")
            self.laser.emergency_off()
            return []

        # Detect weeds
        detections = self.detector.detect(frame)
        weeds = [d for d in detections if d.is_weed]

        if not weeds:
            return detections

        # Process each weed
        for weed in weeds:
            u, v = weed.center

            # Convert pixel position to gantry X,Y coordinates
            if self.calibrator.H is not None:
                try:
                    x_mm, y_mm = self.calibrator.pixel_to_gantry_2d(u, v)
                    weed.gantry_xy = (x_mm, y_mm)
                except Exception as e:
                    print(f"  Calibration error: {e}")
                    continue
            else:
                # Fallback: simple proportional mapping
                h, w = frame.shape[:2]
                x_travel = self.config["gantry"]["x_travel"]
                y_travel = self.config["gantry"]["y_travel"]
                x_mm = (u / w) * x_travel
                y_mm = (v / h) * y_travel
                weed.gantry_xy = (x_mm, y_mm)

            x_mm, y_mm = weed.gantry_xy
            print(f"  Weed at pixel({u},{v}) → gantry(X={x_mm:.1f}, Y={y_mm:.1f}mm)")

            # Move gantry to weed X,Y position (Z is fixed — laser at 3cm)
            self.gantry.move_to(x_mm, y_mm,
                              speed=self.config["gantry"]["max_speed"])

            # Fire laser (fixed height, full power)
            if self.safety.check_safety():
                dwell = self.config["laser"]["dwell_time_ms"]
                self.laser.fire(duration_ms=dwell)
                print(f"    Fired laser for {dwell}ms")

        # Return home after processing
        self.gantry.move_home()
        return detections

    def run(self):
        """Main loop: continuous detection and weeding."""
        self.running = True
        cam_cfg = self.config["camera"]
        fps = cam_cfg["fps"]
        skip = 2  # process every Nth frame

        print(f"\nRunning pipeline at {fps} fps (checking every {skip} frames)...")
        print("Press 'q' to stop, 's' for snapshot, 'e' for emergency stop\n")

        frame_idx = 0
        stats = {"frames": 0, "weeds_found": 0, "weeds_cut": 0}

        while self.running:
            ret, frame = self.camera.read()
            if not ret:
                print("Camera read failed")
                break

            if frame_idx % skip == 0:
                detections = self.process_frame(frame)
                weeds = [d for d in detections if d.is_weed]
                stats["frames"] += 1
                stats["weeds_found"] += len(weeds)
                stats["weeds_cut"] += len(weeds)  # assuming all are cut

                # Display
                annotated = self.detector.annotate_frame(frame, detections)
                cv2.putText(annotated,
                           f"Frame {frame_idx} | Weeds: {stats['weeds_found']}",
                           (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
                cv2.imshow("Weed Laser Robot", annotated)

            key = cv2.waitKey(1) & 0xFF
            if key == ord('q'):
                break
            elif key == ord('s'):
                cv2.imwrite(f"snapshot_{frame_idx}.jpg", frame)
                print(f"  Snapshot saved: snapshot_{frame_idx}.jpg")
            elif key == ord('e'):
                self.emergency_stop()

            frame_idx += 1

        self.stop()
        print(f"\nSession stats: {stats}")

    def emergency_stop(self):
        """Emergency stop everything."""
        print("\n*** EMERGENCY STOP ***")
        self.laser.emergency_off()
        self.gantry.emergency_stop()
        self.running = False

    def stop(self):
        """Clean shutdown."""
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
        print("System shutdown complete")


def main():
    parser = argparse.ArgumentParser(description="Weed Laser Robot")
    parser.add_argument("--config", type=str, default="configs/robot_config.yaml")
    parser.add_argument("--simulate", action="store_true", help="Run in simulation mode")
    parser.add_argument("--detect-only", action="store_true", help="Detection only, no gantry/laser")
    args = parser.parse_args()

    if args.detect_only:
        # Just run detection on camera feed
        from src.detection_pipeline import WeedDetector
        detector = WeedDetector(use_clip=True, use_dino=False)
        cap = cv2.VideoCapture(0)

        print("Detection-only mode (no robot). Press 'q' to quit.")
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            detections = detector.detect(frame)
            annotated = detector.annotate_frame(frame, detections)
            cv2.imshow("Weed Detection", annotated)
            if cv2.waitKey(1) & 0xFF == ord('q'):
                break

        cap.release()
        cv2.destroyAllWindows()
    else:
        robot = WeedLaserRobot(config_path=args.config, simulate=args.simulate)
        if robot.start():
            robot.run()


if __name__ == "__main__":
    main()
