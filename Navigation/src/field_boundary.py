"""
Independent Field Boundary Guard (NAV-08).
Enforces a polygon field geofence inset by the rover's physical footprint and
configured safety margin. Every forward step or turn checks local path validity
before motor execution so the rover cannot exit the approved agricultural plot.
"""

import math
from dataclasses import dataclass


@dataclass
class BoundaryCheck:
    inside: bool
    margin_cm: float
    reason: str


class FieldBoundaryGuard:
    """Polygon containment + footprint margin verifier."""

    def __init__(
        self,
        polygon_cm: list[tuple[float, float]],
        safety_margin_cm: float = 15.0,
    ):
        if len(polygon_cm) < 3:
            raise ValueError("Field boundary polygon requires at least 3 vertices.")
        self.polygon = [(float(x), float(y)) for x, y in polygon_cm]
        self.safety_margin_cm = float(safety_margin_cm)

    @classmethod
    def from_rectangle(cls, length_cm: float, width_cm: float, safety_margin_cm: float = 15.0) -> "FieldBoundaryGuard":
        return cls(
            polygon_cm=[
                (0.0, 0.0),
                (length_cm, 0.0),
                (length_cm, width_cm),
                (0.0, width_cm),
            ],
            safety_margin_cm=safety_margin_cm,
        )

    def _point_in_polygon(self, x: float, y: float) -> bool:
        inside = False
        n = len(self.polygon)
        j = n - 1
        for i in range(n):
            xi, yi = self.polygon[i]
            xj, yj = self.polygon[j]
            intersects = ((yi > y) != (yj > y)) and (
                x < (xj - xi) * (y - yi) / ((yj - yi) + 1e-12) + xi
            )
            if intersects:
                inside = not inside
            j = i
        return inside

    def _min_distance_to_edges(self, x: float, y: float) -> float:
        min_d = float("inf")
        n = len(self.polygon)
        for i in range(n):
            x1, y1 = self.polygon[i]
            x2, y2 = self.polygon[(i + 1) % n]
            dx, dy = x2 - x1, y2 - y1
            seg_len2 = dx * dx + dy * dy
            if seg_len2 < 1e-9:
                d = math.hypot(x - x1, y - y1)
            else:
                t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / seg_len2))
                px, py = x1 + t * dx, y1 + t * dy
                d = math.hypot(x - px, y - py)
            min_d = min(min_d, d)
        return min_d

    def check_pose(self, x_cm: float, y_cm: float) -> BoundaryCheck:
        if not self._point_in_polygon(x_cm, y_cm):
            return BoundaryCheck(False, -self._min_distance_to_edges(x_cm, y_cm), "OUTSIDE_FIELD_POLYGON")
        clearance = self._min_distance_to_edges(x_cm, y_cm)
        if clearance < self.safety_margin_cm:
            return BoundaryCheck(
                False,
                clearance,
                f"FOOTPRINT_MARGIN_BREACH({clearance:.1f}cm < {self.safety_margin_cm:.1f}cm)",
            )
        return BoundaryCheck(True, clearance, "WITHIN_SAFE_BOUNDARY")

    def is_move_safe(self, x_cm: float, y_cm: float, heading_deg: float, step_cm: float) -> BoundaryCheck:
        """Project proposed forward step and validate intermediate & end points."""
        rad = math.radians(heading_deg)
        for frac in (0.5, 1.0):
            nx = x_cm + (step_cm * frac) * math.cos(rad)
            ny = y_cm + (step_cm * frac) * math.sin(rad)
            res = self.check_pose(nx, ny)
            if not res.inside:
                return res
        return self.check_pose(x_cm + step_cm * math.cos(rad), y_cm + step_cm * math.sin(rad))
