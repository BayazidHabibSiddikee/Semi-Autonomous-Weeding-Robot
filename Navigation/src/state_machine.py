"""
Production Navigation State Machine (NAV-04, NAV-05, NAV-08..NAV-12).

Strictly separates NAVIGATION from TREATMENT:
  - Drives full serpentine crop-row coverage via RowNavigator regardless of
    whether any treatment module (future Flame or Grinder) is attached.
  - Legacy laser dependencies are completely removed from navigation.
  - Fail-safe obstacle handling:
      * Valid clear -> move permitted
      * Unknown obstacle -> OBSTACLE_HOLD (safe stop; never blind auto-dodge)
      * Invalid / -1 sensor reading -> FAULT (immediate stop; requires explicit recovery)
  - Supports PAUSE / RESUME, JSON checkpoints, coverage verification, and
    explicit re-localization after slip or manual relocation.
"""

import time
from typing import Callable

from mission_checkpoint import MissionTracker
from row_navigator import RowNavigator
from ultrasonic import ObstacleStatus


class RoverState:
    IDLE = "IDLE"
    NAVIGATING_ROW = "NAVIGATING_ROW"
    HEADLAND_TURN = "HEADLAND_TURN"
    TREATMENT_HOOK = "TREATMENT_HOOK"
    OBSTACLE_HOLD = "OBSTACLE_HOLD"
    PAUSED = "PAUSED"
    FAULT = "FAULT"
    ESTOP = "ESTOP"
    DONE = "DONE"


class RoverStateMachine:
    """Navigation-first fail-safe state machine with decoupled treatment hook."""

    def __init__(
        self,
        rover,
        row_navigator: RowNavigator,
        obstacle_sensor,
        mission_tracker: MissionTracker,
        safety_check_fn: Callable[[], bool] | None = None,
        treatment_hook: Callable[[tuple[float, float, float]], dict] | None = None,
        visual_row_end_fn: Callable[[], float] | None = None,
    ):
        self.rover = rover
        self.navigator = row_navigator
        self.obstacle_sensor = obstacle_sensor
        self.tracker = mission_tracker
        self.safety_check_fn = safety_check_fn or (lambda: True)
        # Optional modular treatment callback (Flame / Grinder); None = navigation-only
        self.treatment_hook = treatment_hook
        # Optional visual row-end confidence provider (0.0..1.0) from live navigation camera
        self.visual_row_end_fn = visual_row_end_fn

        self.state = RoverState.IDLE
        self.running = False
        self.fault_reason: str | None = None
        self.stats = {
            "steps": 0,
            "row_transitions": 0,
            "obstacle_holds": 0,
            "faults": 0,
            "treatment_stops": 0,
        }

    def _preflight_safety_and_sensors(self) -> tuple[bool, str]:
        """Evaluated before AND during every motor movement."""
        if not self.safety_check_fn():
            self._trigger_estop("HARDWARE_ESTOP_ACTIVE")
            return False, "HARDWARE_ESTOP_ACTIVE"

        pose = self.rover.localizer.get_pose()
        if not pose.localized:
            self._enter_fault(f"LOCALIZATION_SLIP_EXCEEDED({pose.slip_residual_cm:.1f}cm)")
            return False, "LOCALIZATION_LOST"

        obs = self.obstacle_sensor.evaluate()
        if obs.status == ObstacleStatus.SENSOR_FAULT:
            self._enter_fault(f"OBSTACLE_SENSOR_FAULT:{obs.reason}")
            return False, obs.reason
        if obs.status == ObstacleStatus.OBSTACLE:
            self.rover.stop()
            self.state = RoverState.OBSTACLE_HOLD
            self.stats["obstacle_holds"] += 1
            return False, obs.reason

        return True, "OK"

    def _enter_fault(self, reason: str):
        self.rover.stop()
        self.state = RoverState.FAULT
        self.fault_reason = reason
        self.stats["faults"] += 1
        self.tracker.save_checkpoint()

    def _trigger_estop(self, reason: str = "EMERGENCY_STOP"):
        self.rover.emergency_stop()
        self.state = RoverState.ESTOP
        self.fault_reason = reason
        self.running = False
        self.tracker.save_checkpoint()

    def pause(self):
        """Safe operator pause with atomic checkpoint save (NAV-12)."""
        self.rover.stop()
        self.state = RoverState.PAUSED
        self.tracker.save_checkpoint()

    def resume(self) -> tuple[bool, str]:
        """Resume from PAUSED or OBSTACLE_HOLD only if safety & sensors are valid."""
        if self.state in (RoverState.FAULT, RoverState.ESTOP):
            return False, f"Cannot resume directly from {self.state}; explicit recover() required."
        ok, reason = self._preflight_safety_and_sensors()
        if not ok:
            return False, reason
        self.state = RoverState.NAVIGATING_ROW
        return True, "RESUMED"

    def recover(self, relocalize_pose: tuple[float, float, float] | None = None) -> tuple[bool, str]:
        """
        Explicit validated recovery procedure from FAULT or ESTOP (NAV-05, NAV-10).
        Optionally accepts a verified (x_cm, y_cm, heading_deg) landmark/operator fix.
        """
        if not self.safety_check_fn():
            return False, "HARDWARE_ESTOP_STILL_ENGAGED"

        if relocalize_pose is not None:
            telem = self.rover.bridge.read_telemetry()
            self.rover.localizer.reset_pose(
                relocalize_pose[0],
                relocalize_pose[1],
                relocalize_pose[2],
                left_ticks=telem.left_ticks if telem.valid else None,
                right_ticks=telem.right_ticks if telem.valid else None,
            )

        self.obstacle_sensor.reset_faults()
        obs = self.obstacle_sensor.evaluate()
        if obs.status == ObstacleStatus.SENSOR_FAULT:
            return False, f"SENSOR_STILL_FAULTED:{obs.reason}"

        if not self.rover.localizer.get_pose().localized:
            return False, "LOCALIZATION_UNVERIFIED: Provide relocalize_pose."

        self.fault_reason = None
        self.state = RoverState.PAUSED
        return True, "RECOVERED_TO_PAUSED"

    def start(self, max_ticks: int | None = None, tick_delay_s: float = 0.0):
        self.running = True
        if self.state == RoverState.IDLE:
            self.state = RoverState.NAVIGATING_ROW

        ticks = 0
        while self.running:
            self.tick()
            ticks += 1
            if max_ticks is not None and ticks >= max_ticks:
                break
            if tick_delay_s > 0.0:
                time.sleep(tick_delay_s)

    def tick(self):
        """Execute one deterministic state-machine transition."""
        if self.state in (RoverState.PAUSED, RoverState.FAULT, RoverState.ESTOP, RoverState.DONE):
            self.rover.stop()
            if self.state == RoverState.DONE:
                self.running = False
            return

        if self.state == RoverState.OBSTACLE_HOLD:
            # Stay safely stopped until unknown obstacle clears (NAV-09: never blind auto-dodge)
            obs = self.obstacle_sensor.evaluate()
            if obs.status == ObstacleStatus.SENSOR_FAULT:
                self._enter_fault(f"OBSTACLE_SENSOR_FAULT:{obs.reason}")
            elif obs.status == ObstacleStatus.CLEAR and self.safety_check_fn():
                self.state = RoverState.NAVIGATING_ROW
            return

        if self.state == RoverState.IDLE:
            self.state = RoverState.NAVIGATING_ROW
            return

        if self.state == RoverState.NAVIGATING_ROW:
            ok, _reason = self._preflight_safety_and_sensors()
            if not ok:
                return

            vis_conf = 0.0
            if self.visual_row_end_fn is not None:
                try:
                    vis_conf = max(0.0, min(1.0, float(self.visual_row_end_fn())))
                except Exception:
                    vis_conf = 0.0
            outcome = self.navigator.step_along_row(
                abort_check_fn=self._preflight_safety_and_sensors,
                visual_row_end_conf=vis_conf,
            )

            if outcome.distance_cm > 0.0:
                self.stats["steps"] += 1
                self.tracker.record_progress(
                    self.navigator.current_row,
                    outcome.distance_cm,
                    self.rover.get_position(),
                )

            if outcome.fault_reason:
                if self.state not in (RoverState.OBSTACLE_HOLD, RoverState.ESTOP):
                    self._enter_fault(outcome.fault_reason)
                return

            if outcome.row_end_reached:
                self.tracker.mark_row_completed(self.navigator.current_row)
                self.tracker.save_checkpoint()
                if outcome.mission_complete:
                    self.rover.stop()
                    self.state = RoverState.DONE
                    self.running = False
                else:
                    self.state = RoverState.HEADLAND_TURN
                return

            # Optional stationary treatment window (decoupled from navigation)
            if self.treatment_hook is not None:
                self.state = RoverState.TREATMENT_HOOK

        elif self.state == RoverState.TREATMENT_HOOK:
            self.rover.stop()
            if not self.safety_check_fn():
                self._trigger_estop("ESTOP_DURING_TREATMENT")
                return
            self.treatment_hook(self.rover.get_position())
            self.stats["treatment_stops"] += 1
            self.state = RoverState.NAVIGATING_ROW

        elif self.state == RoverState.HEADLAND_TURN:
            ok, reason = self.navigator.transition_to_next_row(
                abort_check_fn=self._preflight_safety_and_sensors
            )
            if not ok:
                if self.state not in (RoverState.OBSTACLE_HOLD, RoverState.ESTOP):
                    self._enter_fault(reason)
                return

            self.stats["row_transitions"] += 1
            self.tracker.save_checkpoint()
            self.state = RoverState.NAVIGATING_ROW

    def stop(self):
        self.running = False
        self.rover.stop()
        self.tracker.save_checkpoint()
