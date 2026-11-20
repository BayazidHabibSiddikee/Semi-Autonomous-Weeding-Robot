"""
Temporal Crop-Row Tracker.
Applies exponential smoothing + consecutive-frame debounce to RowObservation so
brief shadows, gaps in foliage, or sunlight glare do not destabilize steering or
cause false row-end triggers.
"""

from dataclasses import dataclass
from .row_detector import RowObservation


@dataclass
class TrackedRowState:
    tracking_locked: bool
    lateral_error_m: float
    heading_error_rad: float
    row_end_reached: bool
    row_end_confidence: float
    missed_frames: int


class CropRowTracker:
    def __init__(
        self,
        alpha_lat: float = 0.35,
        alpha_yaw: float = 0.30,
        row_end_thresh: float = 0.78,
        row_end_debounce_frames: int = 8,
        max_missed_frames: int = 12,
    ):
        self.alpha_lat = alpha_lat
        self.alpha_yaw = alpha_yaw
        self.row_end_thresh = row_end_thresh
        self.row_end_debounce_frames = row_end_debounce_frames
        self.max_missed_frames = max_missed_frames

        self._lat = 0.0
        self._yaw = 0.0
        self._row_end_count = 0
        self._missed_frames = 0
        self._initialized = False

    def reset(self):
        self._lat = 0.0
        self._yaw = 0.0
        self._row_end_count = 0
        self._missed_frames = 0
        self._initialized = False

    def update(self, obs: RowObservation) -> TrackedRowState:
        if obs.row_end_confidence >= self.row_end_thresh:
            self._row_end_count += 1
        else:
            self._row_end_count = max(0, self._row_end_count - 1)

        if obs.valid:
            self._missed_frames = 0
            if not self._initialized:
                self._lat = obs.lateral_error_m
                self._yaw = obs.heading_error_rad
                self._initialized = True
            else:
                self._lat = (1.0 - self.alpha_lat) * self._lat + self.alpha_lat * obs.lateral_error_m
                self._yaw = (1.0 - self.alpha_yaw) * self._yaw + self.alpha_yaw * obs.heading_error_rad
        else:
            self._missed_frames += 1

        locked = self._initialized and (self._missed_frames <= self.max_missed_frames)
        row_end = self._row_end_count >= self.row_end_debounce_frames

        return TrackedRowState(
            tracking_locked=locked,
            lateral_error_m=self._lat,
            heading_error_rad=self._yaw,
            row_end_reached=row_end,
            row_end_confidence=obs.row_end_confidence,
            missed_frames=self._missed_frames,
        )
