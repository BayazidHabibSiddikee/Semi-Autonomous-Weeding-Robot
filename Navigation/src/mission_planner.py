"""
Mission planner: parse the JSON mission produced by the Android app and turn
it into a waypoint list the rover can follow.

The Android app sends (kotlinx.serialization, sealed interface PathSegment):

    {
      "version": 1,
      "field": {"widthM": 6.0, "lengthM": 8.0, "totalRows": 9,
                "rowSpacingM": 0.75, "originCorner": "TOP_LEFT"},
      "path": [
        {"type": "FollowRow", "seq": 1, "row": 1, "expectedDistM": 8.0,
         "turnAfter": "RIGHT",
         "startPoint": {"x": 0.0, "y": 0.4},
         "endPoint":   {"x": 8.0, "y": 0.4}},
        {"type": "Turn", "seq": 2, "direction": "RIGHT", "gapM": 0.75,
         "startPoint": {"x": 8.0, "y": 0.4}, "endPoint": {"x": 8.0, "y": 1.15}}
      ],
      "attentionWindow": {"startM": 7.0, "endM": 8.5},
      "generatedAt": 1700000000000
    }

This module keeps the Pi side independent of the Android code: the Pi only
needs to understand the wire format.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple


@dataclass
class MissionPlan:
    """A parsed mission, ready to drive."""

    width_m: float = 6.0
    length_m: float = 8.0
    total_rows: int = 0
    row_spacing_m: float = 0.0
    origin_corner: str = "TOP_LEFT"

    # row centre positions across the field (meters, 0..width_m)
    rows_m: List[float] = field(default_factory=list)
    # ordered waypoints (x_m along length, y_m across width)
    waypoints: List[Tuple[float, float]] = field(default_factory=list)
    # indices in `waypoints` that finish a crop row
    row_end_indices: List[int] = field(default_factory=list)
    # the raw segments, kept for logging / debugging
    segments: List[Dict[str, Any]] = field(default_factory=list)

    attention_start_m: float = 7.0
    attention_end_m: float = 8.5

    @property
    def distance_m(self) -> float:
        total = 0.0
        for (x0, y0), (x1, y1) in zip(self.waypoints, self.waypoints[1:]):
            total += ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
        return total

    @property
    def start_point(self) -> Tuple[float, float]:
        return self.waypoints[0] if self.waypoints else (0.0, 0.0)

    @property
    def end_point(self) -> Tuple[float, float]:
        return self.waypoints[-1] if self.waypoints else (0.0, 0.0)

    # ------------------------------------------------------------------ parse

    @staticmethod
    def from_json(payload: str | bytes | Dict[str, Any]) -> "MissionPlan":
        data = json.loads(payload) if isinstance(payload, (str, bytes)) else payload
        if not isinstance(data, dict):
            raise ValueError("mission payload must be a JSON object")

        fld = data.get("field") or {}
        plan = MissionPlan(
            width_m=float(fld.get("widthM", 6.0)),
            length_m=float(fld.get("lengthM", 8.0)),
            total_rows=int(fld.get("totalRows", 0)),
            row_spacing_m=float(fld.get("rowSpacingM", 0.0)),
            origin_corner=str(fld.get("originCorner", "TOP_LEFT")),
        )

        attention = data.get("attentionWindow") or {}
        plan.attention_start_m = float(attention.get("startM", 7.0))
        plan.attention_end_m = float(attention.get("endM", 8.5))

        waypoints: List[Tuple[float, float]] = []
        rows: List[float] = []
        row_ends: List[int] = []
        segments = data.get("path") or []

        for seg in segments:
            if not isinstance(seg, dict):
                continue
            seg_type = seg.get("type") or seg.get("kind") or ""
            start = seg.get("startPoint") or {}
            end = seg.get("endPoint") or {}
            sx, sy = float(start.get("x", 0.0)), float(start.get("y", 0.0))
            ex, ey = float(end.get("x", 0.0)), float(end.get("y", 0.0))

            if seg_type in ("FollowRow", "followRow", "row", ""):
                if not waypoints:
                    waypoints.append((sx, sy))
                waypoints.append((ex, ey))
                row_ends.append(len(waypoints) - 1)
                if seg.get("row") is not None:
                    rows.append(sy)
            elif seg_type in ("Turn", "turn", ""):
                waypoints.append((ex, ey))
            plan.segments.append(seg)

        plan.waypoints = waypoints
        plan.row_end_indices = row_ends
        plan.rows_m = sorted(set(round(r, 6) for r in rows)) or sorted(
            {round(p[1], 6) for p in waypoints}
        )
        return plan

    def to_dict(self) -> Dict[str, Any]:
        return {
            "widthM": self.width_m,
            "lengthM": self.length_m,
            "totalRows": self.total_rows,
            "rowSpacingM": self.row_spacing_m,
            "originCorner": self.origin_corner,
            "rowsM": self.rows_m,
            "waypoints": [{"x": x, "y": y} for x, y in self.waypoints],
            "distanceM": self.distance_m,
        }


def build_mission_json(
    rows_m: List[float],
    width_m: float,
    length_m: float,
    row_length_m: Optional[float] = None,
    origin_corner: str = "TOP_LEFT",
    headland_m: float = 0.2,
) -> Dict[str, Any]:
    """
    Build a mission payload identical in shape to the Android app's
    `BoustrophedonGenerator` output (used by the app-side simulator and tests).

    `headland_m` keeps the rover away from the field edges: lane endpoints are
    inset by that margin at both the start and end of every row. An explicit
    `row_length_m` override is treated as the exact driving distance and left
    as-is.
    """
    headland = max(headland_m, 0.0)
    row_length = (
        max(length_m - 2.0 * headland, 0.5) if row_length_m is None else row_length_m
    )
    x_lo = headland
    x_hi = max(length_m - headland, headland)
    rows = sorted(rows_m)
    path: List[Dict[str, Any]] = []
    seq = 1

    for index, y in enumerate(rows):
        is_last = index == len(rows) - 1
        start_x = x_lo if index % 2 == 0 else x_hi
        end_x = x_hi if index % 2 == 0 else x_lo
        turn = "RIGHT" if index % 2 == 0 else "LEFT"

        path.append(
            {
                "type": "FollowRow",
                "seq": seq,
                "row": index + 1,
                "expectedDistM": row_length,
                "turnAfter": turn,
                "startPoint": {"x": start_x, "y": y},
                "endPoint": {"x": end_x, "y": y},
            }
        )
        seq += 1

        if not is_last:
            next_y = rows[index + 1]
            path.append(
                {
                    "type": "Turn",
                    "seq": seq,
                    "direction": turn,
                    "gapM": abs(next_y - y),
                    "startPoint": {"x": end_x, "y": y},
                    "endPoint": {"x": end_x, "y": next_y},
                }
            )
            seq += 1

    return {
        "version": 1,
        "field": {
            "widthM": width_m,
            "lengthM": length_m,
            "totalRows": len(rows),
            "rowSpacingM": (width_m / len(rows)) if rows else 0.0,
            "originCorner": origin_corner,
        },
        "path": path,
        "attentionWindow": {"startM": row_length - 1.0, "endM": row_length + 0.5},
        "generatedAt": 0,
    }
