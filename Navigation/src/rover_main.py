#!/usr/bin/env python3
"""
Rover entry point — ties detection + navigation + laser into one loop.
Usage: python Navigation/src/rover_main.py --simulate
"""
import sys
import os
import argparse
import yaml
import cv2

# add Weed_Detection to path for detection imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "Weed_Detection"))
# add Navigation src to path
sys.path.insert(0, os.path.dirname(__file__))

from esp32_bridge import ESP32Bridge, ESP32Simulator
from rover_motors import create_rover
from servo_gimbal import ServoGimbal, ServoGimbalSimulator
from ultrasonic import UltrasonicSensor, UltrasonicSimulator
from state_machine import RoverStateMachine

from src.detection_pipeline import WeedDetector
from src.calibration import CameraCalibrator
from src.laser_control import LaserController, LaserSafety


def main():
    parser = argparse.ArgumentParser(description="Weed Laser Rover")
    parser.add_argument("--config", type=str, default="Navigation/rover_config.yaml")
    parser.add_argument("--simulate", action="store_true", help="Simulation mode (no hardware)")
    args = parser.parse_args()

    # load config (resolve path relative to repo root)
    repo_root = os.path.join(os.path.dirname(__file__), "..", "..")
    config_path = os.path.join(repo_root, args.config)
    with open(config_path) as f:
        config = yaml.safe_load(f)

    simulate = args.simulate

    # --- ESP32 bridge ---
    if simulate:
        esp32 = ESP32Simulator()
    else:
        esp32 = ESP32Bridge(
            port=config["serial"]["esp32_port"],
            baudrate=config["serial"]["esp32_baud"],
        )
        esp32.connect()

    # --- Motors ---
    rover = create_rover(
        simulate=simulate,
        port=config["serial"]["esp32_port"],
    )
    if not simulate:
        rover.connect()

    # --- Gimbal ---
    if simulate:
        gimbal = ServoGimbalSimulator(
            pan_center=config["rover"]["servo"]["pan_center"],
            tilt_center=config["rover"]["servo"]["tilt_center"],
        )
    else:
        gimbal = ServoGimbal(
            esp32_bridge=esp32,
            pan_center=config["rover"]["servo"]["pan_center"],
            tilt_center=config["rover"]["servo"]["tilt_center"],
        )

    # --- Ultrasonic ---
    if simulate:
        ultrasonic = UltrasonicSimulator(simulated_distance_mm=150)
    else:
        ultrasonic = UltrasonicSensor(esp32_bridge=esp32)

    # --- Detection ---
    print("\nLoading AI models...")
    detector = WeedDetector(
        yolo_path="models/yolo_weeds.pt",
        efficientnet_path="models/efficientnet_weeds.pt",
        use_clip=True,
        use_dino=False,
    )

    # --- Calibration ---
    calibrator = CameraCalibrator()
    cal_path = os.path.join(repo_root, "Weed_Detection", "models", "calibration.npz")
    if os.path.exists(cal_path):
        calibrator.load_calibration(cal_path)
    else:
        print("WARNING: No calibration loaded")

    # --- Laser ---
    laser = LaserController(simulate=simulate)
    safety = LaserSafety(simulate=simulate)

    # --- Camera ---
    cam_cfg = config["camera"]
    camera = cv2.VideoCapture(cam_cfg["device_id"])
    camera.set(cv2.CAP_PROP_FRAME_WIDTH, cam_cfg["resolution"]["width"])
    camera.set(cv2.CAP_PROP_FRAME_HEIGHT, cam_cfg["resolution"]["height"])

    if not camera.isOpened():
        print("ERROR: Cannot open camera")
        return

    # --- Run ---
    print("\n" + "=" * 50)
    print("  WEED LASER ROVER — ALL SYSTEMS READY")
    print("=" * 50)
    print(f"  Mode: {'SIMULATION' if simulate else 'HARDWARE'}")
    print(f"  Camera: {cam_cfg['resolution']['width']}x{cam_cfg['resolution']['height']}")
    print(f"  Press 'q' to stop, 'e' for emergency stop\n")

    state_machine = RoverStateMachine(
        rover=rover,
        gimbal=gimbal,
        ultrasonic=ultrasonic,
        detector=detector,
        calibrator=calibrator,
        laser_controller=laser,
        safety=safety,
        camera=camera,
        config=config,
    )

    # run in a thread so we can check keyboard
    import threading
    rover_thread = threading.Thread(target=state_machine.start, daemon=True)
    rover_thread.start()

    # keyboard control
    while state_machine.running:
        key = cv2.waitKey(100) & 0xFF
        if key == ord('q'):
            state_machine.stop()
            break
        elif key == ord('e'):
            state_machine._emergency_stop()
            break

        # show camera feed
        ret, frame = camera.read()
        if ret:
            cv2.putText(frame,
                       f"State: {state_machine.state} | Weeds: {state_machine.stats['weeds_fired']}",
                       (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
            cv2.imshow("Weed Laser Rover", frame)

    # cleanup
    state_machine.stop()
    camera.release()
    cv2.destroyAllWindows()
    if not simulate:
        esp32.disconnect()
    print("Rover shutdown complete")


if __name__ == "__main__":
    main()
