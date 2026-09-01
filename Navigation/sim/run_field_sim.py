#!/usr/bin/env python3
"""
Run the rover state machine on a virtual small field (no hardware, no models).

Usage:
  python3 Navigation/sim/run_field_sim.py            # headless run
  python3 Navigation/sim/run_field_sim.py --view     # live OpenCV view
  python3 Navigation/sim/run_field_sim.py --seed 7   # different field layout
"""
import argparse
import math
import os
import sys
import threading
import time

import cv2
import numpy as np
import yaml

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, "Navigation", "src"))

from field_simulator import (FieldCamera, FieldSimulator, FieldUltrasonic)  # noqa: E402
from state_machine import RoverStateMachine  # noqa: E402

# reuse the real detection dataclass when importable
sys.path.insert(0, os.path.join(REPO, "Weed_Detection"))
try:
    from src.detection_pipeline import WeedDetection  # noqa: E402
except Exception:  # pragma: no cover
    from dataclasses import dataclass

    @dataclass
    class WeedDetection:
        bbox: tuple
        center: tuple
        class_name: str
        confidence: float
        yolo_conf: float = 0.0
        clip_class: str = ""
        clip_conf: float = 0.0
        dino_similarity: float = 0.0
        is_weed: bool = False


class SimGimbal:
    """Gimbal that records the last aimed pixel (ServoGimbalSimulator API)."""

    def __init__(self):
        self.pan_center, self.tilt_center = 90, 60
        self.current_pan, self.current_tilt = 90, 60
        self.last_pixel = None

    def move_to(self, pan_deg, tilt_deg):
        self.current_pan, self.current_tilt = pan_deg, tilt_deg

    def center(self):
        self.move_to(self.pan_center, self.tilt_center)
        self.last_pixel = None

    def aim_at_pixel(self, u, v, frame_w, frame_h, **kw):
        dx = (u - frame_w / 2) / (frame_w / 2)
        dy = (v - frame_h / 2) / (frame_h / 2)
        pan = self.pan_center + dx * 90 * 0.8
        tilt = self.tilt_center + dy * 30 * 0.5
        self.move_to(pan, tilt)
        self.last_pixel = (u, v)
        print(f"[SIM] Gimbal aim → pixel({u},{v}) pan={pan:.0f}° tilt={tilt:.0f}°")
        return pan, tilt

    def get_angles(self):
        return self.current_pan, self.current_tilt


class SimLaser:
    """Laser that kills the weed nearest the gimbal aim point in the field."""

    def __init__(self, field, gimbal):
        self.field = field
        self.gimbal = gimbal
        self.shots = 0

    def fire(self, duration_ms=300):
        self.shots += 1
        hit = None
        if self.gimbal.last_pixel:
            u, v = self.gimbal.last_pixel
            # pixel → rover-frame cm → world cm
            rx = (u - self.field.frame_w / 2) / self.field.px_per_cm_x
            ry = (v - self.field.frame_h / 2) / self.field.px_per_cm_y
            rad = math.radians(self.field.heading)
            dx = rx * math.cos(rad) - ry * math.sin(rad)
            dy = rx * math.sin(rad) + ry * math.cos(rad)
            wx, wy = self.field.rover_x + dx, self.field.rover_y + dy
            hit = self.field.remove_weed_near(wx, wy)
        if hit:
            print(f"[SIM] LASER fired {duration_ms}ms → WEED ELIMINATED "
                  f"at ({hit[0]:.0f},{hit[1]:.0f})cm  ({self.field.weeds_remaining} left)")
        else:
            print(f"[SIM] LASER fired {duration_ms}ms → miss (no weed at aim point)")

    def emergency_off(self):
        pass


class SimSafety:
    """Always-safe interlock for simulation."""

    def __init__(self, simulate=True):
        self.simulate = simulate

    def check_safety(self):
        return True


class ColorWeedDetector:
    """
    Contour-based stand-in for the AI pipeline: finds light-green spiky
    weed blobs in the frame. Matches the WeedDetector.detect() interface.
    """

    def detect(self, frame, conf_threshold=0.3, use_voting=True):
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        # weeds are lighter/less saturated than crops:
        # weed S~102-112 V~160-200, crop S~155-162 V~110-140
        mask = cv2.inRange(hsv, (40, 80, 150), (75, 135, 255))
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN,
                                np.ones((5, 5), np.uint8))
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL,
                                       cv2.CHAIN_APPROX_SIMPLE)
        detections = []
        for c in contours:
            area = cv2.contourArea(c)
            if area < 120:
                continue
            x, y, w, h = cv2.boundingRect(c)
            x1, y1, x2, y2 = x, y, x + w, y + h
            detections.append(WeedDetection(
                bbox=(x1, y1, x2, y2),
                center=(x + w // 2, y + h // 2),
                class_name="weed_grass",
                confidence=min(0.99, area / 4000.0),
                yolo_conf=min(0.99, area / 4000.0),
                clip_class="weed",
                clip_conf=0.9,
                dino_similarity=0.0,
                is_weed=True,
            ))
        return detections


def make_minimap(field):
    """Top-down minimap of the whole field with the rover on it."""
    scale = 2  # px per cm
    m = np.full((int(field.field_h_cm * scale),
                 int(field.field_w_cm * scale), 3), (55, 65, 85), np.uint8)
    for x, y, r in field.crops:
        cv2.circle(m, (int(x * scale), int(y * scale)),
                   max(2, int(r * scale)), (40, 110, 50), -1)
    for x, y, r in field.weeds:
        cv2.circle(m, (int(x * scale), int(y * scale)),
                   max(2, int(r * scale)), (120, 220, 140), -1)
    rx, ry = int(field.rover_x * scale), int(field.rover_y * scale)
    rad = math.radians(field.heading)
    tip = (int(rx + 14 * math.cos(rad)), int(ry + 14 * math.sin(rad)))
    cv2.arrowedLine(m, (rx, ry), tip, (0, 0, 255), 2)
    cv2.circle(m, (rx, ry), 6, (0, 0, 255), 2)
    return m


class SimRover:
    """
    Rover wrapper adding field coverage: keeps heading while weeds are in
    view, otherwise wanders (turns) so the whole small field gets scanned.
    Implements the RoverMotors interface over FieldSimulator kinematics.
    """

    def __init__(self, field, wander_deg=35):
        self.field = field
        self.wander_deg = wander_deg

    def forward(self, duration_ms=500, speed=200):
        if not self.field.weeds_in_frame():
            turn = self.field.rng.choice([-1, 1]) * self.field.rng.uniform(
                0.4, 1.0) * self.wander_deg
            self.field.rotate_right(turn)
        self.field.forward(duration_ms, speed)

    def backward(self, duration_ms=300, speed=180):
        self.field.backward(duration_ms, speed)

    def rotate_right(self, degrees=90, speed=180):
        self.field.rotate_right(degrees, speed)

    def rotate_left(self, degrees=90, speed=180):
        self.field.rotate_left(degrees, speed)

    def stop(self):
        self.field.stop()

    def emergency_stop(self):
        self.field.emergency_stop()

    def get_position(self):
        return self.field.get_position()

class AvoidUltrasonic(FieldUltrasonic):
    """Forward sensor that steers the rover away when blocked."""

    def __init__(self, field, gimbal=None):
        super().__init__(field, gimbal)
        self.dodges = 0

    def read_distance_mm(self):
        d = super().read_distance_mm()
        if d == 250:  # crop ahead — turn and report clear so the loop resumes
            self.field.rotate_right(self.field.rng.choice([-1, 1]) * 60)
            self.dodges += 1
            print(f"[SIM] Obstacle ahead — dodging (#{self.dodges})")
            return 800
        return d


def main():
    ap = argparse.ArgumentParser(description="Weed laser rover — virtual field sim")
    ap.add_argument("--config", default=os.path.join(REPO, "Navigation", "rover_config.yaml"))
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--max-steps", type=int, default=3000, help="headless tick limit")
    ap.add_argument("--view", action="store_true", help="show live OpenCV view")
    ap.add_argument("--record", metavar="MP4", default=None,
                    help="record the mission (view + minimap) to an mp4 file")
    args = ap.parse_args()

    with open(args.config) as f:
        config = yaml.safe_load(f)

    field = FieldSimulator(config=config, seed=args.seed)
    gimbal = SimGimbal()
    print(f"[SIM] Field {field.field_w_cm:.0f}x{field.field_h_cm:.0f}cm — "
          f"{len(field.crops)} crops, {field.weeds_remaining} weeds")

    sm = RoverStateMachine(
        rover=SimRover(field),            # wandering rover over field kinematics
        gimbal=gimbal,
        ultrasonic=AvoidUltrasonic(field, gimbal),
        detector=ColorWeedDetector(),
        calibrator=type("C", (), {"H": None})(),  # no homography — use fallback
        laser_controller=SimLaser(field, gimbal),
        safety=SimSafety(),
        camera=FieldCamera(field),
        config=config,
    )

    if not args.view:
        # ---- headless: drive the loop, stop when field cleared or limit hit
        writer = None
        if args.record:
            probe = field.get_frame()
            mini = cv2.resize(make_minimap(field), (probe.shape[1], 240))
            canvas = np.vstack([probe, mini])
            writer = cv2.VideoWriter(args.record,
                                     cv2.VideoWriter_fourcc(*"mp4v"), 30.0,
                                     (canvas.shape[1], canvas.shape[0]))
            print(f"[SIM] Recording mission → {args.record}")

        sm.state = "FORWARD"
        sm.running = True
        ticks = 0
        while sm.running and ticks < args.max_steps and field.weeds_remaining > 0:
            sm._tick()
            ticks += 1
            if writer is not None:
                frame = field.get_frame()
                mini = cv2.resize(make_minimap(field), (frame.shape[1], 240))
                canvas = np.vstack([frame, mini])
                cv2.putText(canvas,
                            f"State:{sm.state} Pos:({field.rover_x:.0f},{field.rover_y:.0f})cm "
                            f"H:{field.heading:.0f}deg Weeds:{field.weeds_remaining} "
                            f"Fired:{sm.stats['weeds_fired']}",
                            (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
                writer.write(canvas)
        sm.stop()
        if writer is not None:
            writer.release()
            print(f"[SIM] Saved recording → {args.record}")
        print(f"\n[RESULT] ticks={ticks} stats={sm.stats} "
              f"weeds_left={field.weeds_remaining} laser_shots={sm.laser.shots}")
        cv2.imwrite(os.path.join(REPO, "Navigation", "sim", "last_frame.png"),
                    field.get_frame())
        cv2.imwrite(os.path.join(REPO, "Navigation", "sim", "last_minimap.png"),
                    make_minimap(field))
        print("[SIM] Wrote sim/last_frame.png and sim/last_minimap.png")
        return

    # ---- GUI mode
    sm.state = "FORWARD"
    sm.running = True
    t = threading.Thread(target=sm.start, daemon=True)
    t.start()
    print("[SIM] GUI view — press 'q' to quit")
    while sm.running:
        frame = field.get_frame()
        mini = make_minimap(field)
        mini = cv2.resize(mini, (frame.shape[1], 240))
        canvas = np.vstack([frame, mini])
        cv2.putText(canvas,
                    f"State:{sm.state} Pos:({field.rover_x:.0f},{field.rover_y:.0f})cm "
                    f"H:{field.heading:.0f}deg Weeds:{field.weeds_remaining} "
                    f"Fired:{sm.stats['weeds_fired']}",
                    (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
        cv2.imshow("Weed Laser Rover — Virtual Field", canvas)
        if cv2.waitKey(30) & 0xFF == ord("q"):
            sm.stop()
            break
    cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
