"""
Virtual small-field environment for the weed laser rover.

Simulates a small soil field (default 3m x 2m) with crop rows and scattered
weeds, a downward-facing virtual camera, a virtual VL53L0X ToF sensor, and
rover kinematics. Pure numpy/OpenCV — no AI models or hardware required.
`run_field_sim.py` wires it into the real RoverStateMachine.
"""
import math
import random

import cv2
import numpy as np


class FieldSimulator:
    """Small procedural field with crop rows and weeds, plus a rover."""

    def __init__(self, config=None, seed=42):
        cfg = (config or {}).get("rover", {})
        nav = cfg.get("navigation", {})

        # --- field geometry ---
        self.field_w_cm = 300.0   # along rows (X)
        self.field_h_cm = 200.0   # across rows (Y)
        self.row_spacing_cm = nav.get("row_width_cm", 60)
        self.cam_view_w_cm = 40.0  # camera footprint (X)
        self.cam_view_h_cm = 30.0  # camera footprint (Y)

        self.rng = random.Random(seed)
        self.frame_w = 640
        self.frame_h = 480
        self.px_per_cm_x = self.frame_w / self.cam_view_w_cm
        self.px_per_cm_y = self.frame_h / self.cam_view_h_cm

        # --- rover pose (world cm; heading 0 = +X / along rows) ---
        # start mid-lane BETWEEN crop rows (rows sit at (r + 0.5) * spacing)
        self.rover_x = self.field_w_cm * 0.1
        self.rover_y = (self.field_h_cm / 2.0 // self.row_spacing_cm) * self.row_spacing_cm
        self.heading = 0.0
        self.speed_cms = 10.0     # cm/s at speed=200 (matches RoverMotors est.)

        # --- world content ---
        self.crops = []           # [(x, y, radius_cm)]
        self.weeds = []           # [(x, y, radius_cm)]
        self._generate_field()
        self._soil = self._make_soil()

    def _generate_field(self):
        """Create crop rows along X and scatter weeds between them."""
        self.crops.clear()
        self.weeds.clear()
        n_rows = int(self.field_h_cm // self.row_spacing_cm) + 1
        for r in range(n_rows):
            y = (r + 0.5) * self.row_spacing_cm
            if y >= self.field_h_cm:
                break
            x = 15.0
            while x < self.field_w_cm - 10:
                self.crops.append((x, y, self.rng.uniform(5.0, 7.5)))
                x += self.rng.uniform(28.0, 38.0)

        # weeds: random, but not inside a crop and not on the rover start
        for _ in range(24):
            for _attempt in range(50):
                wx = self.rng.uniform(10, self.field_w_cm - 10)
                wy = self.rng.uniform(10, self.field_h_cm - 10)
                if self._near_any(self.crops, wx, wy, min_dist=9.0):
                    continue
                if (wx - self.rover_x) ** 2 + (wy - self.rover_y) ** 2 < 25 ** 2:
                    continue
                self.weeds.append((wx, wy, self.rng.uniform(3.0, 5.5)))
                break

    @staticmethod
    def _near_any(items, x, y, min_dist):
        return any((x - ix) ** 2 + (y - iy) ** 2 < min_dist ** 2
                   for ix, iy, *_ in items)

    def _make_soil(self):
        """Static brown soil texture the size of one frame."""
        base = np.full((self.frame_h, self.frame_w, 3), (60, 70, 90), np.uint8)
        noise = np.random.randint(-14, 14, (self.frame_h, self.frame_w, 1), dtype=np.int16)
        base = np.clip(base.astype(np.int16) + noise, 0, 255).astype(np.uint8)
        rng = np.random.default_rng(7)
        for _ in range(220):
            px, py = rng.integers(0, self.frame_w), rng.integers(0, self.frame_h)
            r = int(rng.integers(1, 3))
            shade = int(rng.integers(50, 110))
            cv2.circle(base, (int(px), int(py)), r, (shade - 10, shade, shade + 20), -1)
        return base

    def world_to_frame(self, wx, wy):
        """World cm → pixel coords relative to the rover camera."""
        dx, dy = wx - self.rover_x, wy - self.rover_y
        rad = math.radians(self.heading)
        rx = dx * math.cos(rad) + dy * math.sin(rad)
        ry = -dx * math.sin(rad) + dy * math.cos(rad)
        u = int(rx * self.px_per_cm_x + self.frame_w / 2)
        v = int(ry * self.px_per_cm_y + self.frame_h / 2)
        return u, v


    def get_frame(self):
        """Render the downward camera view (BGR)."""
        frame = self._soil.copy()
        for wx, wy, r in self.crops:
            u, v = self.world_to_frame(wx, wy)
            self._draw_plant(frame, u, v, r, crop=True)
        for wx, wy, r in self.weeds:
            u, v = self.world_to_frame(wx, wy)
            self._draw_plant(frame, u, v, r, crop=False)
        return frame

    @staticmethod
    def _draw_plant(frame, u, v, r_cm, crop=True):
        if not (-30 < u < frame.shape[1] + 30 and -30 < v < frame.shape[0] + 30):
            return
        rx = int(r_cm * frame.shape[1] / 40.0)
        ry = int(r_cm * frame.shape[0] / 30.0)
        if crop:
            # tomato: dark green rounded leaves + red fruit dot
            cv2.ellipse(frame, (u, v), (rx, ry), 0, 0, 360, (40, 110, 50), -1)
            cv2.ellipse(frame, (u, v), (max(1, rx // 2), max(1, ry // 2)), 45,
                        0, 360, (55, 140, 65), -1)
            cv2.circle(frame, (u + max(1, rx // 3), v), max(2, rx // 5),
                       (40, 40, 200), -1)
        else:
            # weed: lighter spiky star shape
            pts = []
            for i in range(10):
                ang = math.pi * i / 5.0
                rr = 1.0 if i % 2 == 0 else 0.45
                pts.append((int(u + rx * rr * math.cos(ang)),
                            int(v + ry * rr * math.sin(ang))))
            cv2.fillPoly(frame, [np.array(pts)], (120, 200, 130))
            cv2.circle(frame, (u, v), max(2, rx // 4), (90, 160, 100), -1)

    # ------------------------- kinematics -------------------------- #
    def forward(self, duration_ms=500, speed=200):
        dist = (duration_ms / 1000.0) * self.speed_cms * (speed / 200.0)
        rad = math.radians(self.heading)
        self.rover_x = min(self.field_w_cm - 5,
                           max(5, self.rover_x + dist * math.cos(rad)))
        self.rover_y = min(self.field_h_cm - 5,
                           max(5, self.rover_y + dist * math.sin(rad)))

    def backward(self, duration_ms=300, speed=180):
        self.forward(-duration_ms, speed)

    def rotate_right(self, degrees=90, speed=180):
        self.heading = (self.heading + degrees) % 360.0

    def rotate_left(self, degrees=90, speed=180):
        self.heading = (self.heading - degrees) % 360.0

    def stop(self):
        pass

    def emergency_stop(self):
        self.stop()

    def get_position(self):
        return self.rover_x, self.rover_y, self.heading

    # -------------------------- sensors ----------------------------- #
    def read_distance_mm(self):
        """
        Virtual ToF: ~150mm over soil; large reading near the field edge
        (row end / open space), matching row_end_threshold logic.
        """
        margin = min(self.rover_x, self.rover_y,
                     self.field_w_cm - self.rover_x,
                     self.field_h_cm - self.rover_y)
        if margin < 8.0:
            return 1400  # open space — row end
        return 150 + int(self.rng.uniform(-8, 8))

    # ---------------------- weed interaction ------------------------ #
    def weeds_in_frame(self):
        """Return weeds currently visible in the camera footprint."""
        half_w = self.cam_view_w_cm / 2
        half_h = self.cam_view_h_cm / 2
        rad = math.radians(self.heading)
        visible = []
        for wx, wy, r in self.weeds:
            dx, dy = wx - self.rover_x, wy - self.rover_y
            rx = dx * math.cos(rad) + dy * math.sin(rad)
            ry = -dx * math.sin(rad) + dy * math.cos(rad)
            if abs(rx) <= half_w and abs(ry) <= half_h:
                visible.append((wx, wy, r))
        return visible

    def remove_weed_near(self, wx, wy, tol_cm=7.0):
        """Remove the weed closest to (wx, wy) if within tolerance."""
        best, best_d = None, tol_cm ** 2
        for i, (ix, iy, _r) in enumerate(self.weeds):
            d = (ix - wx) ** 2 + (iy - wy) ** 2
            if d < best_d:
                best, best_d = i, d
        return self.weeds.pop(best) if best is not None else None

    @property
    def weeds_remaining(self):
        return len(self.weeds)




class FieldUltrasonic:
    """
    Context-aware virtual ToF:
      - gimbal aimed at a target (last_pixel set) → downward Z reading
        near the configured fire distance, matching the FIRE state
      - otherwise → forward-looking obstacle/row-end reading for FORWARD
        state (edge detection is direction-aware: only the edge the sensor
        faces counts as a row end)
    """

    def __init__(self, field, gimbal=None):
        self.field = field
        self.gimbal = gimbal

    def read_distance_mm(self):
        if self.gimbal is not None and self.gimbal.last_pixel:
            return 110 + int(self.field.rng.uniform(-5, 5))
        # forward look: is a crop directly in our lane ahead?
        rad = math.radians(self.field.heading)
        fx, fy = (self.field.rover_x + 30 * math.cos(rad),
                  self.field.rover_y + 30 * math.sin(rad))
        for cx, cy, _r in self.field.crops:
            if (cx - fx) ** 2 + (cy - fy) ** 2 < 15 ** 2:
                return 250  # obstacle ahead
        # edge AHEAD of the travel direction only (sensor looks forward, so
        # side/corner proximity must not read as a row end)
        f = self.field
        if abs(math.cos(rad)) > 0.5:
            margin = (f.field_w_cm - f.rover_x) if math.cos(rad) > 0 else f.rover_x
        else:
            margin = (f.field_h_cm - f.rover_y) if math.sin(rad) > 0 else f.rover_y
        if margin < 8.0:
            return 1400     # field edge — row end
        return 800          # clear path

    def is_in_range(self, min_mm=50, max_mm=2000):
        d = self.read_distance_mm()
        return min_mm <= d <= max_mm

    def is_fire_ready(self, target_mm=100, tolerance_mm=50):
        d = self.read_distance_mm()
        return d > 0 and abs(d - target_mm) <= tolerance_mm


class FieldCamera:
    """cv2.VideoCapture-style wrapper around the field renderer."""

    def __init__(self, field):
        self.field = field

    def read(self):
        return True, self.field.get_frame()

    def release(self):
        pass

    def isOpened(self):
        return True
