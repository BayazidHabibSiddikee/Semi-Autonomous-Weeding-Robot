#!/usr/bin/env python3
"""
Run the real RoverStateMachine inside the virtual field.

Wires FieldSimulator / FieldCamera / FieldUltrasonic (Navigation/src/
field_simulator.py) into the production state machine, using a lightweight
color-threshold detector instead of the YOLO/CLIP pipeline — no models or
hardware required.

Usage:
  python Navigation/run_field_sim.py            # live window
  python Navigation/run_field_sim.py --headless # run N steps, save frames
"""
import sys
import os
import argparse
import math
import time

import cv2
import numpy as np
import yaml

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "src"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "Weed_Detection"))

from field_simulator import FieldSimulator, FieldCamera, FieldUltrasonic
from servo_gimbal import ServoGimbalSimulator
from state_machine import RoverStateMachine
from row_navigator import RowNavigator
from src.calibration import CameraCalibrator
from src.laser_control import LaserController, LaserSafety
from src.detection_pipeline import WeedDetection


# --------------------------------------------------------------------- #
# Simulated gimbal: records the last aimed pixel so FieldUltrasonic
# knows when the laser is pointed at a target (fire-ready Z reading).
# --------------------------------------------------------------------- #
class TrackingGimbal(ServoGimbalSimulator):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.last_pixel = None

    def aim_at_pixel(self, u, v, frame_w, frame_h, **kwargs):
        self.last_pixel = (u, v)
        return super().aim_at_pixel(u, v, frame_w, frame_h, **kwargs)

    def center(self):
        self.last_pixel = None
        super().center()



# --------------------------------------------------------------------- #
# Color-threshold detector: weeds are rendered as light spiky green
# (BGR ~120,200,130) vs dark crop leaves (BGR ~40,110,50).
# --------------------------------------------------------------------- #
class SimulatedWeedDetector:
    def __init__(self, min_area_px=40):
        self.min_area_px = min_area_px

    def detect(self, frame):
        b = frame[:, :, 0].astype(int)
        g = frame[:, :, 1].astype(int)
        r = frame[:, :, 2].astype(int)
        mask = ((g > 150) & (g - b > 30) & (g - r > 20) & (r > 80)).astype(np.uint8) * 255
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN,
                                cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        detections = []
        for c in contours:
            if cv2.contourArea(c) < self.min_area_px:
                continue
            x, y, bw, bh = cv2.boundingRect(c)
            detections.append(WeedDetection(
                bbox=(x, y, x + bw, y + bh),
                center=(x + bw // 2, y + bh // 2),
                class_name="weed_simulated",
                confidence=0.9,
                yolo_conf=0.9,
                clip_class="weed",
                clip_conf=0.9,
                dino_similarity=0.0,
                is_weed=True,
            ))
        return detections


def draw_overlay(field, sm, frame):
    pos = field.get_position()
    cv2.putText(frame,
                f"State: {sm.state} | pos=({pos[0]:.0f},{pos[1]:.0f})cm "
                f"hdg={pos[2]:.0f} | weeds left: {field.weeds_remaining} "
                f"fired: {sm.stats['weeds_fired']}",
                (10, frame.shape[0] - 10),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)
    return frame


def draw_minimap(field):
    scale = 2  # px per cm
    m = np.zeros((int(field.field_h_cm) * scale, int(field.field_w_cm) * scale, 3), np.uint8)
    for x, y, r in field.crops:
        cv2.circle(m, (int(x * scale), int(y * scale)), max(2, int(r * scale)), (50, 110, 40), -1)
    for x, y, r in field.weeds:
        cv2.circle(m, (int(x * scale), int(y * scale)), max(2, int(r * scale)), (130, 200, 120), -1)
    rx, ry, _hdg = field.get_position()
    cv2.circle(m, (int(rx * scale), int(ry * scale)), 4, (0, 0, 255), -1)
    return cv2.resize(m, (320, int(320 * m.shape[0] / m.shape[1])))



# --------------------------------------------------------------------- #
# Laser wrapper: a successful fire removes the weed currently under the
# gimbal aim point in the virtual field (pixel → world inverse transform).
# --------------------------------------------------------------------- #
class FieldLaser(LaserController):
    def __init__(self, field, gimbal, **kwargs):
        super().__init__(**kwargs)
        self.field = field
        self.gimbal = gimbal

    def fire(self, duration_ms=300):
        super().fire(duration_ms=duration_ms)
        if self.gimbal.last_pixel:
            u, v = self.gimbal.last_pixel
            f = self.field
            rx = (u - f.frame_w / 2.0) / f.px_per_cm_x
            ry = (v - f.frame_h / 2.0) / f.px_per_cm_y
            rad = math.radians(f.heading)
            dx = rx * math.cos(rad) - ry * math.sin(rad)
            dy = rx * math.sin(rad) + ry * math.cos(rad)
            removed = f.remove_weed_near(f.rover_x + dx, f.rover_y + dy, tol_cm=8.0)
            if removed:
                print(f"  Weed removed at ({removed[0]:.0f},{removed[1]:.0f})cm "
                      f"— {f.weeds_remaining} left")


def main():
    parser = argparse.ArgumentParser(description="Field simulation for the weed laser rover")
    parser.add_argument("--config",
                        default=os.path.join(os.path.dirname(__file__), "rover_config.yaml"))
    parser.add_argument("--headless", action="store_true",
                        help="no GUI; save frames to sim/run_frames/")
    parser.add_argument("--max-steps", type=int, default=2500)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    with open(args.config) as f:
        config = yaml.safe_load(f)

    field = FieldSimulator(config=config, seed=args.seed)
    camera = FieldCamera(field)
    gimbal = TrackingGimbal(
        pan_center=config["rover"]["servo"]["pan_center"],
        tilt_center=config["rover"]["servo"]["tilt_center"],
    )
    ultrasonic = FieldUltrasonic(field, gimbal=gimbal)
    rover = field  # FieldSimulator implements forward/stop/rotate_right/emergency_stop
    detector = SimulatedWeedDetector()
    calibrator = CameraCalibrator()  # no calibration → pixel fallback in state machine
    laser = FieldLaser(field, gimbal, simulate=True)
    safety = LaserSafety(simulate=True)

    # camera resolution used by state machine pixel→cm fallback
    config["camera"]["resolution"]["width"] = field.frame_w
    config["camera"]["resolution"]["height"] = field.frame_h

    sm = RoverStateMachine(
        rover=rover, gimbal=gimbal, ultrasonic=ultrasonic, detector=detector,
        calibrator=calibrator, laser_controller=laser, safety=safety,
        camera=camera, config=config,
    )
    navigator = RowNavigator(rover, ultrasonic, config)

    out_dir = os.path.join(os.path.dirname(__file__), "sim", "run_frames")
    if args.headless:
        os.makedirs(out_dir, exist_ok=True)
        print(f"Headless mode — frames saved to {out_dir}")

    # run the state machine manually (no thread) so we can render each tick
    sm.running = True
    sm.state = "FORWARD"
    step = 0
    try:
        while sm.running and step < args.max_steps and field.weeds_remaining > 0:
            # row-end handling (only when gimbal is centered, i.e. sensor
            # is forward-looking, not aimed down at a target)
            if gimbal.last_pixel is None and sm.state in ("FORWARD", "STOP"):
                if ultrasonic.read_distance_mm() > navigator.row_end_threshold:
                    navigator.turn_to_next_row()
            sm._tick()
            step += 1
            frame = draw_overlay(field, sm, camera.read()[1])
            if args.headless:
                if step % 10 == 0:
                    cv2.imwrite(os.path.join(out_dir, f"step_{step:04d}.png"), frame)
                time.sleep(0.01)
            else:
                minimap = draw_minimap(field)
                cv2.imshow("FieldSim — rover view", frame)
                cv2.imshow("FieldSim — minimap", minimap)
                if cv2.waitKey(1) & 0xFF == ord('q'):
                    sm.stop()
    finally:
        sm.stop()
        cv2.destroyAllWindows()

    pos = field.get_position()
    print(f"\nFinished after {step} ticks | rover at ({pos[0]:.0f},{pos[1]:.0f})cm "
          f"heading {pos[2]:.0f}deg")
    print(f"Weeds remaining: {field.weeds_remaining} | fired: {sm.stats['weeds_fired']} "
          f"of {sm.stats['weeds_found']} found | scans: {sm.stats['scans']}")


if __name__ == "__main__":
    main()
