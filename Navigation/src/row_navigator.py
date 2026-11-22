"""
Closed-Loop Serpentine Row Navigator (NAV-04, NAV-07, NAV-08).
Replaces unreliable open-loop ultrasonic-only row-end detection with fused:
  1. Field geometry + continuous FieldLocalizer pose along the active row
  2. FieldBoundaryGuard pre-move polygon & footprint margin verification
  3. Lateral row-centerline alignment steering
  4. Closed-loop IMU+encoder headland U-turns into Row N+1
"""

import math
from dataclasses import dataclass

from field_boundary import FieldBoundaryGuard
from localizer import normalize_angle_deg


@dataclass
class RowStepOutcome:
    moved: bool
    distance_cm: float
    row_end_reached: bool
    mission_complete: bool
    fault_reason: str | None = None


class RowNavigator:
    """Structured multi-row serpentine navigator wired directly into RoverStateMachine."""

    def __init__(self, rover, boundary_guard: FieldBoundaryGuard, config: dict):
        nav = config["rover"]["navigation"]
        self.rover = rover
        self.boundary = boundary_guard

        self.field_length_cm = float(nav["field_length_cm"])
        self.field_width_cm = float(nav["field_width_cm"])
        self.row_width_cm = float(nav["row_width_cm"])
        self.headland_margin_cm = float(nav["headland_margin_cm"])
        self.step_distance_cm = float(nav["step_distance_cm"])
        self.lateral_kp = float(nav.get("lateral_kp", 0.9))

        # Compute valid row centerlines inside the field polygon
        self.row_centers_y: list[float] = []
        y = self.row_width_cm * 0.5
        while y <= self.field_width_cm - self.boundary.safety_margin_cm:
            if self.boundary.check_pose(self.headland_margin_cm, y).inside:
                self.row_centers_y.append(y)
            y += self.row_width_cm

        if not self.row_centers_y:
            raise ValueError("No valid navigable crop rows fit inside FieldBoundaryGuard.")

        self.current_row = 0
        self.rows_completed = 0

        # Fused visual row-end guards (prevent premature single-frame mid-row turns)
        self.visual_row_end_threshold = float(nav.get("visual_row_end_threshold", 0.85))
        self.visual_row_end_min_frames = max(1, int(nav.get("visual_row_end_min_frames", 3)))
        self.visual_row_end_min_progress = max(
            0.0, min(1.0, float(nav.get("visual_row_end_min_progress", 0.75)))
        )
        self._visual_end_streak = 0

    @property
    def num_rows(self) -> int:
        return len(self.row_centers_y)

    @property
    def active_row_y(self) -> float:
        return self.row_centers_y[self.current_row]

    @property
    def active_row_heading_deg(self) -> float:
        """Even rows travel +X (0 deg); odd rows travel -X (180 deg)."""
        return 0.0 if (self.current_row % 2 == 0) else 180.0

    def row_progress_fraction(self, x_cm: float) -> float:
        """Normalized travel progress (0.0..1.0) along the active navigable row."""
        navigable_len = max(1.0, self.field_length_cm - 2.0 * self.headland_margin_cm)
        if self.current_row % 2 == 0:
            prog = (x_cm - self.headland_margin_cm) / navigable_len
        else:
            prog = ((self.field_length_cm - self.headland_margin_cm) - x_cm) / navigable_len
        return max(0.0, min(1.0, prog))

    def reset_visual_row_end_streak(self) -> None:
        self._visual_end_streak = 0

    def is_row_end(self, x_cm: float, visual_row_end_conf: float = 0.0) -> bool:
        """
        Fused row-end detector (NAV-07):
        1. Geometric boundary check from FieldLocalizer pose ALWAYS triggers at headland margin.
        2. Visual row-end can trigger an early headland transition ONLY when ALL three hold:
           - visual_row_end_conf >= visual_row_end_threshold (default 0.85)
           - Confirmed across >= visual_row_end_min_frames consecutive evaluations (default 3)
           - Odometry confirms rover has traversed >= visual_row_end_min_progress (default 75%)
             of the current row (prevents premature mid-row turns on gaps/shadows/sparse weeds).
        """
        if self.current_row % 2 == 0:
            geom_end = x_cm >= (self.field_length_cm - self.headland_margin_cm)
        else:
            geom_end = x_cm <= self.headland_margin_cm

        if geom_end:
            self._visual_end_streak = 0
            return True

        progress = self.row_progress_fraction(x_cm)
        if visual_row_end_conf >= self.visual_row_end_threshold and progress >= self.visual_row_end_min_progress:
            self._visual_end_streak += 1
        else:
            self._visual_end_streak = 0

        return self._visual_end_streak >= self.visual_row_end_min_frames

    def compute_aligned_heading_deg(self, y_cm: float) -> float:
        """Steer gently back toward the current crop-row centerline."""
        base_heading = self.active_row_heading_deg
        lat_err_cm = self.active_row_y - y_cm
        # Going +X (0 deg): +lat_err means row center is to +Y -> steer +angle
        # Going -X (180 deg): +lat_err means row center is to +Y -> steer -angle
        sign = 1.0 if base_heading == 0.0 else -1.0
        correction = max(-18.0, min(18.0, sign * lat_err_cm * self.lateral_kp))
        return normalize_angle_deg(base_heading + correction)

    def step_along_row(self, abort_check_fn=None, visual_row_end_conf: float = 0.0) -> RowStepOutcome:
        """Execute one boundary-checked closed-loop step along the active crop row."""
        x_cm, y_cm, _heading = self.rover.get_position()

        if self.is_row_end(x_cm, visual_row_end_conf=visual_row_end_conf):
            return RowStepOutcome(
                moved=False,
                distance_cm=0.0,
                row_end_reached=True,
                mission_complete=(self.current_row >= self.num_rows - 1),
            )

        desired_heading = self.compute_aligned_heading_deg(y_cm)

        # Clip step so we stop cleanly at headland margin without breaching boundary (NAV-08)
        if self.current_row % 2 == 0:
            dist_to_end = max(0.0, (self.field_length_cm - self.headland_margin_cm) - x_cm)
        else:
            dist_to_end = max(0.0, x_cm - self.headland_margin_cm)
        step_cm = min(self.step_distance_cm, dist_to_end)

        if step_cm < 1.0:
            return RowStepOutcome(
                moved=False,
                distance_cm=0.0,
                row_end_reached=True,
                mission_complete=(self.current_row >= self.num_rows - 1),
            )

        # Pre-move polygon boundary & footprint margin check (NAV-08)
        bcheck = self.boundary.is_move_safe(x_cm, y_cm, desired_heading, step_cm)
        if not bcheck.inside:
            return RowStepOutcome(
                moved=False,
                distance_cm=0.0,
                row_end_reached=False,
                mission_complete=False,
                fault_reason=f"BOUNDARY_GUARD:{bcheck.reason}",
            )

        ok, actual_cm, reason = self.rover.move_distance(
            target_cm=step_cm,
            target_heading_deg=desired_heading,
            abort_check_fn=abort_check_fn,
        )
        if not ok:
            return RowStepOutcome(
                moved=False,
                distance_cm=actual_cm,
                row_end_reached=False,
                mission_complete=False,
                fault_reason=reason,
            )

        nx, _ny, _nh = self.rover.get_position()
        reached_end = self.is_row_end(nx, visual_row_end_conf=visual_row_end_conf)
        return RowStepOutcome(
            moved=True,
            distance_cm=actual_cm,
            row_end_reached=reached_end,
            mission_complete=reached_end and (self.current_row >= self.num_rows - 1),
        )

    def transition_to_next_row(self, abort_check_fn=None) -> tuple[bool, str]:
        """
        Execute closed-loop serpentine headland turn into Row N+1:
          1. Rotate to +90 deg (across rows toward +Y)
          2. Drive exact lateral offset to next row center Y (boundary-checked)
          3. Rotate to next row heading (180 deg or 0 deg)
        """
        if self.current_row >= self.num_rows - 1:
            return True, "ALL_ROWS_COMPLETE"

        next_row = self.current_row + 1
        target_y = self.row_centers_y[next_row]
        x_cm, y_cm, _ = self.rover.get_position()
        cross_dist = target_y - y_cm
        cross_heading = 90.0 if cross_dist >= 0.0 else -90.0

        # Verify crossing path remains inside field boundary
        bcheck = self.boundary.is_move_safe(x_cm, y_cm, cross_heading, abs(cross_dist))
        if not bcheck.inside:
            return False, f"HEADLAND_BOUNDARY_BREACH:{bcheck.reason}"

        ok, reason = self.rover.rotate_to_heading(cross_heading, abort_check_fn=abort_check_fn)
        if not ok:
            return False, f"TURN_1_FAILED:{reason}"

        ok, _actual, reason = self.rover.move_distance(
            target_cm=abs(cross_dist),
            target_heading_deg=cross_heading,
            abort_check_fn=abort_check_fn,
        )
        if not ok:
            return False, f"LANE_SHIFT_FAILED:{reason}"

        next_heading = 0.0 if (next_row % 2 == 0) else 180.0
        ok, reason = self.rover.rotate_to_heading(next_heading, abort_check_fn=abort_check_fn)
        if not ok:
            return False, f"TURN_2_FAILED:{reason}"

        self.rows_completed += 1
        self.current_row = next_row
        self._visual_end_streak = 0
        return True, f"ENTERED_ROW_{next_row}"

    def get_status(self) -> dict:
        return {
            "current_row": self.current_row,
            "num_rows": self.num_rows,
            "rows_completed": self.rows_completed,
            "active_row_y_cm": round(self.active_row_y, 1),
            "active_row_heading_deg": self.active_row_heading_deg,
            "visual_end_streak": self._visual_end_streak,
            "visual_end_min_frames": self.visual_row_end_min_frames,
            "visual_end_min_progress": self.visual_row_end_min_progress,
        }
