"""
Navigation state machine for the weed laser rover.
IDLE → FORWARD → STOP → SCAN → AIM → FIRE → repeat
"""
import time
import cv2
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "Weed_Detection"))


class RoverState:
    IDLE = "IDLE"
    FORWARD = "FORWARD"
    STOP = "STOP"
    SCAN = "SCAN"
    AIM = "AIM"
    FIRE = "FIRE"
    ROTATE = "ROTATE"
    DONE = "DONE"


class RoverStateMachine:
    """
    Controls the full rover loop:
    move → stop → detect → aim → fire → move
    """

    def __init__(self, rover, gimbal, ultrasonic, detector, calibrator,
                 laser_controller, safety, camera, config):
        self.rover = rover
        self.gimbal = gimbal
        self.ultrasonic = ultrasonic
        self.detector = detector
        self.calibrator = calibrator
        self.laser = laser_controller
        self.safety = safety
        self.camera = camera
        self.config = config

        self.state = RoverState.IDLE
        self.running = False
        self.frame_w = config["camera"]["resolution"]["width"]
        self.frame_h = config["camera"]["resolution"]["height"]
        self.step_ms = config["rover"]["motor"]["step_forward_ms"]
        self.obstacle_threshold = config["rover"]["navigation"]["obstacle_threshold"]
        self.fire_distance = config["rover"]["ultrasonic"]["fire_distance_mm"]

        self.stats = {
            "steps": 0,
            "scans": 0,
            "weeds_found": 0,
            "weeds_fired": 0,
        }

    def start(self):
        """Begin the rover loop."""
        self.running = True
        self.state = RoverState.FORWARD
        print(f"Rover started — state: {self.state}")

        while self.running:
            self._tick()
            time.sleep(0.05)

    def _tick(self):
        """Execute one state transition."""
        if not self.safety.check_safety():
            self._emergency_stop()
            return

        if self.state == RoverState.IDLE:
            self.state = RoverState.FORWARD

        elif self.state == RoverState.FORWARD:
            self._do_forward()

        elif self.state == RoverState.STOP:
            self._do_stop()

        elif self.state == RoverState.SCAN:
            self._do_scan()

        elif self.state == RoverState.AIM:
            self._do_aim()

        elif self.state == RoverState.FIRE:
            self._do_fire()

        elif self.state == RoverState.ROTATE:
            self._do_rotate()

        elif self.state == RoverState.DONE:
            self.running = False

    def _do_forward(self):
        """Move forward one step, check for obstacles."""
        dist = self.ultrasonic.read_distance_mm()

        if dist > 0 and dist < self.obstacle_threshold:
            print(f"Obstacle detected at {dist}mm — stopping")
            self.rover.stop()
            self.state = RoverState.STOP
            return

        self.rover.forward(duration_ms=self.step_ms)
        self.stats["steps"] += 1
        self.state = RoverState.STOP

    def _do_stop(self):
        """Stopped — ready to scan."""
        self.rover.stop()
        self.state = RoverState.SCAN

    def _do_scan(self):
        """Capture frame and detect weeds."""
        ret, frame = self.camera.read()
        if not ret:
            print("Camera read failed — retrying")
            self.state = RoverState.FORWARD
            return

        self.stats["scans"] += 1
        detections = self.detector.detect(frame)
        weeds = [d for d in detections if d.is_weed]

        if not weeds:
            self.state = RoverState.FORWARD
            return

        self.stats["weeds_found"] += len(weeds)
        self._pending_weeds = weeds
        self._current_weed_idx = 0
        self._scan_frame = frame
        print(f"Found {len(weeds)} weed(s) — processing")
        self.state = RoverState.AIM

    def _do_aim(self):
        """Aim the gimbal at the current weed."""
        if self._current_weed_idx >= len(self._pending_weeds):
            # all weeds processed — move on
            self.gimbal.center()
            self.state = RoverState.FORWARD
            return

        weed = self._pending_weeds[self._current_weed_idx]
        u, v = weed.center

        # convert pixel to cm
        if self.calibrator.H is not None:
            x_cm, y_cm = self.calibrator.pixel_to_gantry_2d(u, v)
        else:
            x_cm = (u / self.frame_w) * 30 - 15  # rough fallback
            y_cm = (v / self.frame_h) * 20 - 10

        print(f"  Weed #{self._current_weed_idx + 1}: pixel({u},{v}) → ({x_cm:.1f},{y_cm:.1f})cm")

        # aim gimbal
        self.gimbal.aim_at_pixel(u, v, self.frame_w, self.frame_h)
        self.state = RoverState.FIRE

    def _do_fire(self):
        """Confirm distance and fire laser."""
        dist = self.ultrasonic.read_distance_mm()
        print(f"  Distance: {dist}mm (target: {self.fire_distance}mm)")

        if dist < 0:
            print("  Ultrasonic read failed — skipping")
            self._advance_weed()
            return

        if not self.ultrasonic.is_fire_ready(target_mm=self.fire_distance, tolerance_mm=50):
            print(f"  Distance out of range ({dist}mm) — skipping")
            self._advance_weed()
            return

        if self.safety.check_safety():
            dwell = self.config["rover"]["laser"]["dwell_time_ms"]
            self.laser.fire(duration_ms=dwell)
            self.stats["weeds_fired"] += 1
            print(f"  Fired laser for {dwell}ms")

        self._advance_weed()

    def _advance_weed(self):
        """Move to next weed or back to scanning."""
        self._current_weed_idx += 1
        if self._current_weed_idx < len(self._pending_weeds):
            self.state = RoverState.AIM
        else:
            self.gimbal.center()
            self.state = RoverState.FORWARD

    def _do_rotate(self):
        """Rotate for row-end turn."""
        self.rover.rotate_right(90)
        self.state = RoverState.FORWARD

    def _emergency_stop(self):
        print("\n*** EMERGENCY STOP ***")
        self.laser.emergency_off()
        self.rover.emergency_stop()
        self.running = False

    def stop(self):
        """Clean stop."""
        self.running = False
        self.laser.emergency_off()
        self.rover.stop()
        self.gimbal.center()
        print(f"\nStats: {self.stats}")
