"""
Main State Machine Controller for Simpla Bot.

Uses ONLY:
  - MaixSense-A075V spatial perception (distance-to-go, corners, obstacles, weeds)
  - Normal Motor Driver (L298N / BTS7960 / Serial Arduino)
  - Flame Control + Grinding Machine 2-channel relay with safety interlocks

States:
  IDLE -> DRIVE_ROW -> APPROACH_WEED -> TREAT_WEED -> CORNER_TURN -> DONE / ESTOP_HALT
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

from simpla_bot.maixsense_perception import (
    MaixSenseClient,
    MaixSenseFrame,
    MaixSenseSpatialAnalyzer,
    SpatialDecision,
)
from simpla_bot.motor_driver import NormalMotorDriver
from simpla_bot.tool_controller import FlameGrinderController


@dataclass
class MissionStats:
    """Running telemetry summary printed to operator console."""

    state: str = "IDLE"
    steps: int = 0
    total_distance_mm: float = 0.0
    row_distance_mm: float = 0.0
    turns_completed: int = 0
    weeds_treated: int = 0
    last_decision: Optional[SpatialDecision] = None
    halt_reason: str = ""
    history: List[str] = field(default_factory=list)


class BenchMaixSenseSimulator:
    """
    Generates realistic synthetic MaixSense-A075V frames for safe bench testing:
      - Straight row approaching a corner wall (distance shrinks smoothly each step)
      - A green weed cluster mid-row to test exact alignment + stop-and-treat
      - A clear LEFT corner opening once the wall reaches corner_stop_mm
    """

    def __init__(self, width: int = 80, height: int = 60) -> None:
        self.width = width
        self.height = height
        self.frame_id = 0
        self.row_remaining_mm = 1350.0
        self.weed_pending = True
        self.weed_distance_mm = 680.0
        self.turn_side = "LEFT"

    def advance_distance(self, mm: float) -> None:
        self.row_remaining_mm = max(350.0, self.row_remaining_mm - mm)
        if self.weed_pending:
            self.weed_distance_mm -= mm
            if self.weed_distance_mm < 250.0:
                self.weed_pending = False

    def reset_new_row(self) -> None:
        self.row_remaining_mm = 1300.0
        self.weed_pending = True
        self.weed_distance_mm = 650.0
        self.turn_side = "RIGHT" if self.turn_side == "LEFT" else "LEFT"

    def fetch_frame(self) -> MaixSenseFrame:
        self.frame_id += 1
        w, h = self.width, self.height
        depth = [int(self.row_remaining_mm)] * (w * h)

        # Left and right corridor walls (close while cruising, open on turn side at corner)
        at_corner = self.row_remaining_mm <= 520.0
        left_d = 1550 if (at_corner and self.turn_side == "LEFT") else 780
        right_d = 1550 if (at_corner and self.turn_side == "RIGHT") else 780

        for y in range(h):
            row_off = y * w
            for x in range(w):
                if x < int(w * 0.33):
                    depth[row_off + x] = left_d
                elif x >= int(w * 0.67):
                    depth[row_off + x] = right_d
                else:
                    depth[row_off + x] = int(self.row_remaining_mm)

        # Brown soil RGB background + green weed patch when weed is ahead
        rgb = [(95, 72, 54)] * (w * h)
        if self.weed_pending and 360.0 <= self.weed_distance_mm <= 900.0:
            wx0, wx1 = int(w * 0.44), int(w * 0.56)
            wy0, wy1 = int(h * 0.58), int(h * 0.72)
            for y in range(wy0, wy1):
                row_off = y * w
                for x in range(wx0, wx1):
                    rgb[row_off + x] = (32, 168, 42)
                    depth[row_off + x] = int(self.weed_distance_mm)

        return MaixSenseFrame(
            frame_id=self.frame_id,
            stamp_msec=self.frame_id * 100,
            received_at=time.monotonic(),
            depth_width=w,
            depth_height=h,
            depth_mm=depth,
            rgb_pixels=rgb,
            rgb_width=w,
            rgb_height=h,
        )


class SimplaBotController:
    """
    Minimal autonomous loop using MaixSense-A075V for all distance & corner logic,
    a normal motor driver, and 2-channel flame/grinder tool control.
    """

    def __init__(
        self,
        cfg: Dict[str, Any],
        frame_provider: Callable[[], Optional[MaixSenseFrame]],
        motor_driver: NormalMotorDriver,
        tool_controller: FlameGrinderController,
        tool_mode: Optional[str] = None,
        clock_fn: Callable[[], float] = time.monotonic,
        on_move_hook: Optional[Callable[[float], None]] = None,
        on_turn_hook: Optional[Callable[[], None]] = None,
    ) -> None:
        self.cfg = cfg
        self.frame_provider = frame_provider
        self.motor = motor_driver
        self.tools = tool_controller
        self.analyzer = MaixSenseSpatialAnalyzer(cfg)
        self.tool_mode = (tool_mode or self.tools.default_mode).lower()
        self._clock = clock_fn
        self._on_move_hook = on_move_hook
        self._on_turn_hook = on_turn_hook

        ms = cfg.get("maixsense", {})
        nav = cfg.get("navigation", {})
        self.max_frame_age_s = float(ms.get("max_frame_age_s", 1.0))
        self.cruise_speed_pct = float(nav.get("cruise_speed_pct", 45.0))
        self.approach_speed_pct = float(nav.get("approach_speed_pct", 28.0))
        self.turn_speed_pct = float(nav.get("turn_speed_pct", 42.0))
        self.max_row_length_mm = float(nav.get("max_row_length_mm", 15000.0))
        self.max_turns = int(nav.get("max_turns", 4))
        self.weed_align_tolerance_mm = float(nav.get("weed_align_tolerance_mm", 45.0))

        self.stats = MissionStats(state="DRIVE_ROW")
        self._last_valid_frame_ts: float = self._clock()
        self._next_uturn_dir: str = "RIGHT"

    def _log(self, msg: str) -> None:
        self.stats.history.append(msg)

    def _halt(self, reason: str) -> MissionStats:
        self.tools.emergency_cutoff()
        self.stats.state = "ESTOP_HALT"
        self.stats.halt_reason = reason
        self._log(f"HALT: {reason}")
        return self.stats

    def step(self, step_dt_s: float = 0.25) -> MissionStats:
        """Execute one perception -> decision -> actuation control step."""
        if self.stats.state in ("DONE", "ESTOP_HALT"):
            return self.stats

        self.stats.steps += 1

        # 1. Hardware & software E-Stop check
        if not self.tools.is_estop_safe():
            return self._halt("Hardware or software E-Stop triggered")

        # 2. Fetch fresh MaixSense frame (with stale-camera watchdog!)
        frame = self.frame_provider()
        now = self._clock()
        if frame is None:
            age = now - self._last_valid_frame_ts
            self.motor.stop()
            if age >= self.max_frame_age_s:
                return self._halt(
                    f"MaixSense camera timeout ({age:.2f}s >= {self.max_frame_age_s:.2f}s)"
                )
            self._log(f"Waiting for MaixSense frame (age={age:.2f}s)")
            return self.stats

        self._last_valid_frame_ts = now
        decision = self.analyzer.analyze(frame)
        self.stats.last_decision = decision

        # 3. Hard obstacle safety stop
        if decision.obstacle_blocked:
            self.motor.stop()
            # If blocked AND it looks like a corner, fall through to corner turn;
            # otherwise halt safely until obstacle clears.
            if not decision.corner_detected:
                return self._halt(
                    f"Obstacle within stop zone ({decision.min_center_mm}mm)"
                )

        # 4. Corner or Row-End Handling (including fallback max_row_length_mm)
        hit_row_limit = self.stats.row_distance_mm >= self.max_row_length_mm
        if decision.corner_detected or hit_row_limit:
            self.motor.stop()
            if self.stats.turns_completed >= self.max_turns:
                self.stats.state = "DONE"
                self._log(
                    f"Mission complete after {self.stats.turns_completed} turns "
                    f"and {self.stats.weeds_treated} weeds treated."
                )
                return self.stats

            self.stats.state = "CORNER_TURN"
            turn_dir = decision.suggested_turn
            if hit_row_limit and turn_dir == "NONE":
                turn_dir = "UTURN"

            if turn_dir == "LEFT":
                angle = -90.0
            elif turn_dir == "RIGHT":
                angle = 90.0
            else:
                # Alternate U-turn direction (boustrophedon lawnmower rows)
                angle = 180.0 if self._next_uturn_dir == "RIGHT" else -180.0
                self._next_uturn_dir = "LEFT" if self._next_uturn_dir == "RIGHT" else "RIGHT"

            turned = self.motor.turn_angle_deg(
                angle,
                speed_pct=self.turn_speed_pct,
                estop_check=self.tools.is_estop_safe,
            )
            self.stats.turns_completed += 1
            self.stats.row_distance_mm = 0.0
            self.stats.state = "DRIVE_ROW"
            if self._on_turn_hook:
                self._on_turn_hook()
            self._log(
                f"Corner ({decision.corner_type}) -> turned {turned:+.0f} deg "
                f"(turn #{self.stats.turns_completed}/{self.max_turns})"
            )
            return self.stats

        # 5. Weed Detected -> Approach exact mm -> Stop -> Grind/Flame
        if decision.weed is not None and self.tool_mode != "none":
            self.stats.state = "APPROACH_WEED"
            dx = decision.weed.dx_to_tool_mm
            # Never drive further than safe front travel distance!
            safe_dx = min(dx, decision.recommended_travel_mm)
            if safe_dx > self.weed_align_tolerance_mm:
                moved = self.motor.move_forward_mm(
                    safe_dx,
                    speed_pct=self.approach_speed_pct,
                    estop_check=self.tools.is_estop_safe,
                )
                self.stats.row_distance_mm += abs(moved)
                self.stats.total_distance_mm = self.motor.total_distance_mm
                if self._on_move_hook:
                    self._on_move_hook(abs(moved))
                self._log(f"Aligned weed: rolled {moved:.0f}mm forward under tool")

            # Must be 100% stopped before energizing grinder or flame
            self.motor.stop()
            self.stats.state = "TREAT_WEED"
            result = self.tools.treat_weed(mode=self.tool_mode)
            if result.executed:
                self.stats.weeds_treated += 1
                self._log(f"Treated weed #{self.stats.weeds_treated}: {result.reason}")
            else:
                self._log(f"Skipped treatment: {result.reason}")

            self.stats.state = "DRIVE_ROW"
            return self.stats

        # 6. Normal Row Cruise (using MaixSense distance-to-go & centering)
        self.stats.state = "DRIVE_ROW"
        # Cap step travel so we never overshoot the corner stop distance
        max_step_mm = self.motor.estimate_step_distance_mm(self.cruise_speed_pct, step_dt_s)
        if decision.recommended_travel_mm < max_step_mm and decision.recommended_travel_mm > 15.0:
            moved = self.motor.move_forward_mm(
                decision.recommended_travel_mm,
                speed_pct=self.approach_speed_pct,
                estop_check=self.tools.is_estop_safe,
            )
        else:
            moved = self.motor.drive_step(
                speed_pct=self.cruise_speed_pct,
                steer_adjust_pct=decision.steer_adjust_pct,
                duration_s=step_dt_s,
                estop_check=self.tools.is_estop_safe,
            )
        self.stats.row_distance_mm += abs(moved)
        self.stats.total_distance_mm = self.motor.total_distance_mm
        if self._on_move_hook:
            self._on_move_hook(abs(moved))

        self._log(
            f"Cruise +{moved:.0f}mm | front={decision.center_mm}mm | "
            f"go={decision.recommended_travel_mm:.0f}mm | steer={decision.steer_adjust_pct:+.1f}%"
        )
        return self.stats

    def run(self, max_steps: int = 80, step_dt_s: float = 0.25) -> MissionStats:
        """Run mission loop safely until DONE, ESTOP_HALT, or max_steps."""
        try:
            for _ in range(max_steps):
                self.step(step_dt_s=step_dt_s)
                if self.stats.state in ("DONE", "ESTOP_HALT"):
                    break
        except KeyboardInterrupt:
            self._halt("Operator KeyboardInterrupt (Ctrl+C)")
        finally:
            self.tools.emergency_cutoff()
        return self.stats


def create_live_controller(
    cfg: Dict[str, Any],
    tool_mode: Optional[str] = None,
    arm_tools: bool = False,
) -> tuple[SimplaBotController, NormalMotorDriver, FlameGrinderController]:
    """Wire up a live MaixSense + real motor driver + tool controller."""
    client = MaixSenseClient(cfg)
    motor = NormalMotorDriver(cfg)
    tools = FlameGrinderController(cfg, motor, arm_tools=arm_tools)
    controller = SimplaBotController(
        cfg=cfg,
        frame_provider=client.fetch_frame,
        motor_driver=motor,
        tool_controller=tools,
        tool_mode=tool_mode,
    )
    return controller, motor, tools
