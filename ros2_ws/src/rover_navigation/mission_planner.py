"""
Multi-Row Field Mission Planner (Sowbot-inspired Architecture).
Computes row-entry waypoints, headland U-turn transition poses for Nav2
(NavigateThroughPoses / NavigateToPose), and enforces field geofence bounds.

Supports Milestone 1 (navigation-only single/multi-row validation with laser OFF)
and full supervised weeding missions.
"""

import math
from dataclasses import dataclass


@dataclass
class FieldSpec:
    field_id: str
    origin_x_m: float = 0.0
    origin_y_m: float = 0.0
    row_length_m: float = 12.0
    row_width_m: float = 0.60
    num_rows: int = 10
    headland_clearance_m: float = 0.85


@dataclass
class Pose2D:
    x: float
    y: float
    yaw: float


class FieldMissionPlanner:
    def __init__(self, field: FieldSpec):
        self.field = field

    def validate_row_range(self, start_row: int, end_row: int) -> tuple[bool, str]:
        if start_row < 1 or end_row > self.field.num_rows or start_row > end_row:
            return False, (
                f"Invalid row range [{start_row}..{end_row}] for field '{self.field.field_id}' "
                f"(valid: 1..{self.field.num_rows})"
            )
        return True, "OK"

    def row_center_y(self, row_num: int) -> float:
        return self.field.origin_y_m + (row_num - 0.5) * self.field.row_width_m

    def is_inside_geofence(self, x_m: float, y_m: float) -> bool:
        min_x = self.field.origin_x_m - self.field.headland_clearance_m - 0.5
        max_x = self.field.origin_x_m + self.field.row_length_m + self.field.headland_clearance_m + 0.5
        min_y = self.field.origin_y_m - 0.5
        max_y = self.field.origin_y_m + self.field.num_rows * self.field.row_width_m + 0.5
        return (min_x <= x_m <= max_x) and (min_y <= y_m <= max_y)

    def build_headland_turn_poses(self, from_row: int, to_row: int, exiting_far_end: bool) -> list[Pose2D]:
        """
        Generate smooth 3-point headland U-turn waypoints for Nav2 NavigateThroughPoses:
          1. Clear row exit straight ahead into headland
          2. Lateral transit across row width to next row axis
          3. Aligned entry pose facing back into the next crop row
        """
        y_from = self.row_center_y(from_row)
        y_to = self.row_center_y(to_row)
        cross_yaw = math.pi / 2.0 if y_to >= y_from else -math.pi / 2.0

        if exiting_far_end:
            x_exit = self.field.origin_x_m + self.field.row_length_m + self.field.headland_clearance_m
            x_entry = self.field.origin_x_m + self.field.row_length_m - 0.15
            return [
                Pose2D(x_exit, y_from, cross_yaw),
                Pose2D(x_exit, y_to, math.pi),
                Pose2D(x_entry, y_to, math.pi),
            ]
        else:
            x_exit = self.field.origin_x_m - self.field.headland_clearance_m
            x_entry = self.field.origin_x_m + 0.15
            return [
                Pose2D(x_exit, y_from, cross_yaw),
                Pose2D(x_exit, y_to, 0.0),
                Pose2D(x_entry, y_to, 0.0),
            ]
