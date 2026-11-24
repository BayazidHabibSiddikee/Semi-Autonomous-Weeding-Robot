"""
One-Shot Weed Target Execution Lifecycle & Class-Filtered Homography Gate.

Resolves Repository Audit (21 Nov 2026) findings:
  - 1D: Prevents repeated relay actuation on the same visible weed across frames.
        Enforces strict lifecycle:
        DETECTED -> VALIDATED -> POSITIONED -> ACTUATED_ONCE -> VERIFIED -> CONSUMED
        with spatial deduplication, bounded dwell time, cooldown, and stationary interlock.
  - 3C: Hard-filters YOLO detections against APPROVED_WEED_CLASSES; rejects all crop_*
        classes before they can enter the actuation queue.
  - 3D: Requires a calibrated 3x3 pixel-to-ground homography matrix before converting
        bounding boxes into ground millimeters (rejects hardcoded uncalibrated scaling).
"""

from dataclasses import dataclass, field
from enum import Enum
import math
import time
from typing import Callable


APPROVED_WEED_CLASSES = frozenset({
    "weed_grass",
    "weed_dandelion",
    "weed_purslane",
    "weed_amaranth",
    "weed_other",
})

PROTECTED_CROP_CLASSES = frozenset({
    "crop_tomato",
    "crop_chili",
    "crop_flower",
})


class TargetState(str, Enum):
    DETECTED = "DETECTED"
    VALIDATED = "VALIDATED"
    POSITIONED = "POSITIONED"
    ACTUATED_ONCE = "ACTUATED_ONCE"
    VERIFIED = "VERIFIED"
    CONSUMED = "CONSUMED"
    REJECTED = "REJECTED"


@dataclass
class WeedTarget:
    target_id: int
    class_name: str
    confidence: float
    x_lat_mm: float
    y_fwd_mm: float
    state: TargetState = TargetState.DETECTED
    created_at: float = field(default_factory=time.monotonic)
    actuated_at: float | None = None
    actuation_count: int = 0
    reject_reason: str | None = None


class TargetExecutionManager:
    """
    Fail-closed, one-shot actuator coordinator.
    Guarantees:
      1. Zero crop detections can ever enter the cutting queue.
      2. Zero uncalibrated pixel-to-ground guesses can command physical actuators.
      3. Each spatially distinct weed target can be actuated AT MOST ONCE.
      4. weeds_eliminated increments ONLY after VERIFIED -> CONSUMED.
    """

    def __init__(
        self,
        homography_matrix: list[list[float]] | None = None,
        min_confidence: float = 0.65,
        dedup_radius_mm: float = 45.0,
        max_dwell_ms: int = 800,
        cooldown_ms: int = 1200,
        y_range_mm: tuple[float, float] = (60.0, 240.0),
    ):
        self.homography = homography_matrix
        self.min_confidence = min_confidence
        self.dedup_radius_mm = dedup_radius_mm
        self.max_dwell_ms = max_dwell_ms
        self.cooldown_ms = cooldown_ms
        self.y_range_mm = y_range_mm

        self._next_id = 1
        self.targets: list[WeedTarget] = []
        self.consumed_positions: list[tuple[float, float, float]] = []
        self.weeds_eliminated = 0
        self.rejected_crops = 0
        self.last_actuation_end_ts = 0.0

    @property
    def is_calibrated(self) -> bool:
        return (
            self.homography is not None
            and len(self.homography) == 3
            and all(len(row) == 3 for row in self.homography)
        )

    def project_pixel_to_ground_mm(self, u_px: float, v_px: float) -> tuple[float, float]:
        """Project image pixel (u, v) through calibrated 3x3 homography H into (x_lat_mm, y_fwd_mm)."""
        if not self.is_calibrated or self.homography is None:
            raise RuntimeError("UNCALIBRATED_HOMOGRAPHY: Physical targeting requires calibrated H matrix.")
        h = self.homography
        w = h[2][0] * u_px + h[2][1] * v_px + h[2][2]
        if abs(w) < 1e-9:
            raise ValueError("Singular homography projection (w == 0)")
        x_mm = (h[0][0] * u_px + h[0][1] * v_px + h[0][2]) / w
        y_mm = (h[1][0] * u_px + h[1][1] * v_px + h[1][2]) / w
        return x_mm, y_mm

    def _is_duplicate(self, x_mm: float, y_mm: float) -> bool:
        for t in self.targets:
            if t.state != TargetState.REJECTED:
                if math.hypot(t.x_lat_mm - x_mm, t.y_fwd_mm - y_mm) <= self.dedup_radius_mm:
                    return True
        for cx, cy, _ in self.consumed_positions:
            if math.hypot(cx - x_mm, cy - y_mm) <= self.dedup_radius_mm:
                return True
        return False

    def ingest_detection(
        self,
        class_name: str,
        confidence: float,
        u_px: float,
        v_px: float,
    ) -> tuple[WeedTarget | None, str]:
        """Validate class whitelist, confidence, calibration, and spatial deduplication."""
        norm_name = class_name.strip().lower()

        if norm_name in PROTECTED_CROP_CLASSES or norm_name.startswith("crop_"):
            self.rejected_crops += 1
            return None, f"REJECTED_PROTECTED_CROP:{norm_name}"

        if norm_name not in APPROVED_WEED_CLASSES:
            return None, f"REJECTED_UNAPPROVED_CLASS:{norm_name}"

        if confidence < self.min_confidence:
            return None, f"REJECTED_LOW_CONFIDENCE:{confidence:.2f}"

        if not self.is_calibrated:
            return None, "REJECTED_UNCALIBRATED_HOMOGRAPHY"

        x_mm, y_mm = self.project_pixel_to_ground_mm(u_px, v_px)
        if not (self.y_range_mm[0] <= y_mm <= self.y_range_mm[1]):
            return None, f"OUT_OF_ACTUATION_WINDOW:y={y_mm:.1f}mm"

        if self._is_duplicate(x_mm, y_mm):
            return None, "DEDUPLICATED_EXISTING_TARGET"

        target = WeedTarget(
            target_id=self._next_id,
            class_name=norm_name,
            confidence=confidence,
            x_lat_mm=x_mm,
            y_fwd_mm=y_mm,
            state=TargetState.VALIDATED,
        )
        self._next_id += 1
        self.targets.append(target)
        return target, "VALIDATED"

    def execute_next_target(
        self,
        rover_speed_cms: float,
        estop_ok: bool,
        interlock_ok: bool,
        actuate_fn: Callable[[WeedTarget, int], bool],
        verify_fn: Callable[[WeedTarget], bool],
        now: float | None = None,
    ) -> tuple[bool, str]:
        """
        Execute at most ONE validated target through:
          VALIDATED -> POSITIONED -> ACTUATED_ONCE -> VERIFIED -> CONSUMED.
        """
        ts = time.monotonic() if now is None else now

        if not estop_ok:
            return False, "BLOCKED:HARDWARE_ESTOP_ACTIVE"
        if not interlock_ok:
            return False, "BLOCKED:TREATMENT_INTERLOCK_OPEN"
        if abs(rover_speed_cms) > 0.01:
            return False, f"BLOCKED:ROVER_NOT_STATIONARY({rover_speed_cms:.2f}cm/s)"
        if self.last_actuation_end_ts > 0 and (ts - self.last_actuation_end_ts) * 1000.0 < self.cooldown_ms:
            return False, "BLOCKED:ACTUATOR_COOLDOWN_ACTIVE"

        candidate = next((t for t in self.targets if t.state == TargetState.VALIDATED), None)
        if candidate is None:
            return False, "NO_VALIDATED_TARGET"

        # One-shot guard: a target with actuation_count > 0 can NEVER fire again
        if candidate.actuation_count > 0:
            candidate.state = TargetState.CONSUMED
            return False, "ALREADY_ACTUATED_ONCE"

        candidate.state = TargetState.POSITIONED
        fired_ok = actuate_fn(candidate, self.max_dwell_ms)
        candidate.actuation_count += 1
        candidate.actuated_at = ts
        self.last_actuation_end_ts = ts

        if not fired_ok:
            candidate.state = TargetState.REJECTED
            candidate.reject_reason = "ACTUATOR_COMMAND_FAILED"
            return False, "ACTUATOR_COMMAND_FAILED"

        candidate.state = TargetState.ACTUATED_ONCE

        if verify_fn(candidate):
            candidate.state = TargetState.VERIFIED
            candidate.state = TargetState.CONSUMED
            self.consumed_positions.append((candidate.x_lat_mm, candidate.y_fwd_mm, ts))
            self.weeds_eliminated += 1
            return True, f"CONSUMED:target#{candidate.target_id}"

        # Even if visual verification fails, consume target so relay cannot fire repeatedly on same spot
        candidate.state = TargetState.CONSUMED
        self.consumed_positions.append((candidate.x_lat_mm, candidate.y_fwd_mm, ts))
        return False, f"UNVERIFIED_CONSUMED:target#{candidate.target_id}"
