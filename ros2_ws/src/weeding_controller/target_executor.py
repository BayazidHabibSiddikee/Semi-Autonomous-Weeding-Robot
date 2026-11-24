"""
Laser Target Executor (Weeding Subsystem).
Executes pan-tilt aiming and laser dwell ONLY when:
  1. Rover wheel velocity is confirmed zero from encoder feedback.
  2. Hardware E-stop and physical laser interlock report OK.
  3. Mission mode explicitly enables weeding (disabled during Milestone 1).
"""

from dataclasses import dataclass
from .weed_localizer import LocalizedWeedTarget


@dataclass
class ExecutionResult:
    weed_id: int
    fired: bool
    reason: str


class WeedTargetExecutor:
    def __init__(self, dwell_ms: int = 250, max_dwell_ms: int = 350):
        self.dwell_ms = min(dwell_ms, max_dwell_ms)

    def execute_target(
        self,
        target: LocalizedWeedTarget,
        rover_stopped: bool,
        estop_ok: bool,
        interlock_ok: bool,
        weeding_enabled: bool,
    ) -> ExecutionResult:
        if not weeding_enabled:
            return ExecutionResult(target.weed_id, False, "WEEDING_DISABLED_NAV_ONLY_MODE")
        if not estop_ok:
            return ExecutionResult(target.weed_id, False, "HARDWARE_ESTOP_ACTIVE")
        if not interlock_ok:
            return ExecutionResult(target.weed_id, False, "LASER_INTERLOCK_OPEN")
        if not rover_stopped:
            return ExecutionResult(target.weed_id, False, "ROVER_IN_MOTION_BLOCKED")

        # Hand off to ESP32 SERVO PAN/TILT + LASER ON/OFF (hardware-gated by interlock relay)
        return ExecutionResult(target.weed_id, True, f"FIRED_{self.dwell_ms}MS_AT_({target.x_mm:.1f},{target.y_mm:.1f})MM")
