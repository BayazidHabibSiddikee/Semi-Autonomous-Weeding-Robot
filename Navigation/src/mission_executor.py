"""
Mission executor: drives the simulated rover along a MissionPlan and weeds
as it goes.

This is the "Pi 5" behaviour in software:

    mission JSON  ->  waypoints  ->  motor commands (via ESP32 protocol)
                                    -> stop -> camera scan -> detect weeds
                                    -> gimbal aim -> distance check -> laser

Everything below goes through the ESP32 command interface, so the same code
path is exercised as with real hardware.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from mission_planner import MissionPlan
from virtual_esp32 import VirtualESP32


@dataclass
class MissionStatus:
    """Live status, mirrored to the Pi HTTP endpoint (and the app)."""

    state: str = "IDLE"
    rows_done: int = 0
    rows_total: int = 0
    waypoint_index: int = 0
    waypoints_total: int = 0
    weeds_found: int = 0
    weeds_killed: int = 0
    weeds_remaining: int = 0
    distance_m: float = 0.0
    message: str = ""
    finished: bool = False
    error: Optional[str] = None
    history: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "state": self.state,
            "rowsDone": self.rows_done,
            "rowsTotal": self.rows_total,
            "waypointIndex": self.waypoint_index,
            "waypointsTotal": self.waypoints_total,
            "weedsFound": self.weeds_found,
            "weedsKilled": self.weeds_killed,
            "weedsRemaining": self.weeds_remaining,
            "distanceM": round(self.distance_m, 2),
            "message": self.message,
            "finished": self.finished,
            "error": self.error,
            "history": self.history[-10:],
        }


class MissionExecutor:
    """Runs one mission on a simulated field."""

    def __init__(
        self,
        field,
        plan: MissionPlan,
        detector,
        gimbal,
        esp32: VirtualESP32,
        config: Optional[Dict[str, Any]] = None,
        video_writer=None,
        log=print,
    ):
        self.field = field
        self.plan = plan
        self.detector = detector
        self.gimbal = gimbal
        self.esp32 = esp32
        self.config = config or {}
        self.video_writer = video_writer
        self.log = log

        self.status = MissionStatus(
            rows_total=len(plan.rows_m),
            waypoints_total=len(plan.waypoints),
            weeds_remaining=field.weeds_remaining,
        )

        # field meters -> simulated field centimeters
        self.field_w_cm = field.field_w_cm
        self.field_h_cm = field.field_h_cm
        self.speed = int(self.config.get("rover", {}).get("motor", {}).get("speed", 200))
        self.step_ms = int(self.config.get("rover", {}).get("motor", {}).get("step_forward_ms", 250))
        self.dwell_ms = int(self.config.get("rover", {}).get("laser", {}).get("dwell_time_ms", 300))
        self.fire_distance = int(self.config.get("rover", {}).get("ultrasonic", {}).get("fire_distance_mm", 100))
        # stop every N cm along a row to scan and weed (the real design is
        # stop -> scan -> aim -> fire -> move, not only at the row ends)
        self.scan_interval_cm = float(self.config.get("rover", {}).get("navigation", {}).get("scan_interval_cm", 12.0))
        # short control step keeps the rover on the row (the weeds sit on it)
        self.control_step_ms = 120

    # ------------------------------------------------------------------ main

    def run(self) -> MissionStatus:
        try:
            self._run()
        except Exception as exc:  # pragma: no cover - defensive
            self.status.error = str(exc)
            self.status.state = "ERROR"
            self.status.finished = True
            self.log(f"[MISSION] failed: {exc}")
        return self.status

    def _run(self):
        self.status.state = "FORWARD"
        self._log(f"[MISSION] plan: {self.plan.rows_m} rows, "
                  f"{len(self.plan.waypoints)} waypoints, "
                  f"{self.plan.distance_m:.1f} m")

        start = self.plan.start_point
        self._drive_to(start, "to start")

        for index, (x_m, y_m) in enumerate(self.plan.waypoints):
            self.status.waypoint_index = index
            self.status.state = "FORWARD"
            self._drive_to((x_m, y_m), f"waypoint {index + 1}")

            # stop and weed at the end of every row
            self.status.state = "STOP"
            self.esp32.send_motor("S")
            self.status.state = "SCAN"
            self._weed_here()

            if index in self.plan.row_end_indices:
                self.status.rows_done += 1
            self.status.state = "FORWARD"

        # return to the start position
        self.status.state = "RETURN"
        self._drive_to(start, "back to start")
        self.esp32.send_motor("S")

        self.status.state = "DONE"
        self.status.finished = True
        self.status.weeds_remaining = self.field.weeds_remaining
        self._log(f"[MISSION] done — {self.status.weeds_killed} weeds killed, "
                  f"{self.field.weeds_remaining} left")

    # -------------------------------------------------------------- driving

    def _drive_to(self, target_m, label: str):
        """Pure-pursuit drive towards a field-space target."""
        tx, ty = self._to_field_cm(target_m)
        reached = False
        guard = 0
        since_scan_cm = 0.0

        while not reached and guard < 4000:
            guard += 1
            rx, ry = self.field.rover_x, self.field.rover_y
            dx, dy = tx - rx, ty - ry
            dist = math.hypot(dx, dy)
            if dist < 6.0:  # within 6 cm
                reached = True
                break

            # angle error in the rover frame
            desired = math.atan2(dy, dx)
            error = (desired - math.radians(self.field.heading) + math.pi) % (2 * math.pi) - math.pi

            if abs(error) > math.radians(4):
                # fine steering: the ESP32 turns the wheels a little (MOVE T <deg>)
                turn_deg = max(-25.0, min(25.0, math.degrees(error)))
                self.esp32.send(f"MOVE T {turn_deg:.0f}")
            else:
                self.esp32.send_motor("F", self.control_step_ms, self.speed)

            sim_cm = (self.control_step_ms / 1000.0) * self.field.speed_cms * (self.speed / 200.0)
            # simulated centimeters -> plan meters (the plan is larger than the sim field)
            self.status.distance_m += (sim_cm / 100.0) * (
                self.plan.length_m / max(self.field_w_cm / 100.0, 1e-6)
            )
            since_scan_cm += sim_cm

            # periodic stop -> scan -> weed along the row
            if since_scan_cm >= self.scan_interval_cm:
                since_scan_cm = 0.0
                self.esp32.send_motor("S")
                self.status.state = "SCAN"
                self._weed_here()
                self.status.state = "FORWARD"
            self.status.weeds_remaining = self.field.weeds_remaining
            self._maybe_record()

        self.esp32.send_motor("S")

    # --------------------------------------------------------------- weeding

    def _weed_here(self):
        """Scan the frame under the rover and eliminate every detected weed."""
        frame = self.field.get_frame()
        detections = self.detector.detect(frame)
        weeds = [d for d in detections if d.is_weed]
        self.status.weeds_found += len(weeds)
        if not weeds:
            self._log("[MISSION] no weeds in view")
            return

        for weed in weeds:
            u, v = weed.center
            # pixel -> field cm under the rover
            rx = (u - self.field.frame_w / 2) / self.field.px_per_cm_x
            ry = (v - self.field.frame_h / 2) / self.field.px_per_cm_y
            rad = math.radians(self.field.heading)
            wx = self.field.rover_x + rx * math.cos(rad) - ry * math.sin(rad)
            wy = self.field.rover_y + rx * math.sin(rad) + ry * math.cos(rad)

            # aim the gimbal (through the ESP32 servo interface)
            self.gimbal.aim_at_pixel(u, v, self.field.frame_w, self.field.frame_h)
            self.esp32.send_servo("PAN", self.gimbal.current_pan)
            self.esp32.send_servo("TILT", self.gimbal.current_tilt)

            # distance confirmation before firing
            dist = self.esp32.read_ultrasonic()
            if dist <= 0 or abs(dist - self.fire_distance) > 80:
                self._log(f"[MISSION] weed at ({wx:.0f},{wy:.0f}) cm — "
                          f"distance {dist} mm out of range, skipped")
                continue

            hit = self.esp32.fire_laser_at(wx, wy, self.dwell_ms)
            if hit:
                self.status.weeds_killed += 1
                self._log(f"[MISSION] laser hit at ({hit[0]:.0f},{hit[1]:.0f}) cm")
            else:
                self._log(f"[MISSION] laser missed at ({wx:.0f},{wy:.0f}) cm")
            self.status.weeds_remaining = self.field.weeds_remaining

    # --------------------------------------------------------------- helpers

    def _to_field_cm(self, point_m):
        """Mission meters -> simulated field centimeters."""
        x_m, y_m = point_m
        x_cm = (x_m / max(self.plan.length_m, 1e-6)) * self.field_w_cm
        y_cm = (y_m / max(self.plan.width_m, 1e-6)) * self.field_h_cm
        return x_cm, y_cm

    def _maybe_record(self):
        if self.video_writer is None:
            return
        import cv2
        frame = self.field.get_frame()
        canvas = frame.copy()
        cv2.putText(
            canvas,
            f"{self.status.state} wp{self.status.waypoint_index + 1}/"
            f"{self.status.waypoints_total} weeds:{self.status.weeds_killed}",
            (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2,
        )
        self.video_writer.write(canvas)

    def _log(self, message: str):
        self.status.history.append(message)
        self.log(message)
