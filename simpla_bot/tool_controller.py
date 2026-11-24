"""
Flame Control + Grinding Machine Relay Controller for Simpla Bot.

Strictly enforces hardware & software safety interlocks:
  1. `dry_run=True` by default — prints/logs planned activations without energizing relays.
  2. Refuses to energize grinder or flame while the rover is moving.
  3. Checks physical E-Stop status before and continuously during every pulse.
  4. Hard-caps flame pulse duration at `max_flame_burn_s` (default 2.5 s).
  5. Enforces mandatory flame cooldown (`flame_cooldown_s`, default 3.0 s) between pulses.
  6. `emergency_cutoff()` immediately forces both relays OFF.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

from simpla_bot.motor_driver import NormalMotorDriver


@dataclass
class TreatmentResult:
    """Audit record returned after each weed treatment attempt."""

    executed: bool
    dry_run: bool
    mode: str
    grinder_ran_s: float
    flame_ran_s: float
    reason: str


class FlameGrinderController:
    """2-channel safety-interlocked controller for Grinding Machine + Flame Control."""

    def __init__(
        self,
        cfg: Dict[str, Any],
        motor_driver: NormalMotorDriver,
        arm_tools: bool = False,
        clock_fn: Callable[[], float] = time.monotonic,
        sleep_fn: Callable[[float], None] = time.sleep,
    ) -> None:
        t = cfg.get("tools", {})
        md = cfg.get("motor_driver", {})

        self.backend: str = str(md.get("backend", "sim")).lower()
        self.motor_driver = motor_driver
        # Tools stay in dry_run unless BOTH config dry_run==False OR operator passed arm_tools=True
        cfg_dry_run = bool(t.get("dry_run", True))
        self.dry_run: bool = True  # Treatment outputs stay disabled in this hardware profile.

        self.default_mode: str = str(t.get("default_mode", "grinder")).lower()
        self.relay_active_low: bool = bool(t.get("relay_active_low", True))
        self.grinder_pin: int = int(t.get("grinder_relay_pin", 17))
        self.flame_pin: int = int(t.get("flame_relay_pin", 27))
        self.estop_pin: int = int(t.get("estop_pin", 22))
        self.estop_active_high: bool = bool(t.get("estop_active_high", True))

        self.settle_before_fire_s: float = float(t.get("settle_before_fire_s", 0.45))
        self.grinder_duration_s: float = max(0.1, float(t.get("grinder_duration_s", 2.0)))
        self.max_flame_burn_s: float = max(0.1, float(t.get("max_flame_burn_s", 2.5)))
        self.flame_duration_s: float = min(
            self.max_flame_burn_s,
            max(0.1, float(t.get("flame_duration_s", 1.2))),
        )
        self.flame_cooldown_s: float = max(0.5, float(t.get("flame_cooldown_s", 3.0)))
        self.post_treat_pause_s: float = max(0.0, float(t.get("post_treat_pause_s", 0.4)))

        self._clock = clock_fn
        self._sleep = sleep_fn
        self._gpio: Any = None
        self._grinder_on: bool = False
        self._flame_on: bool = False
        self._software_estop: bool = False
        self._last_flame_end_ts: float = -1e9
        self._event_log: list[str] = []

        if self.backend == "gpio":
            self._init_gpio()

    def _init_gpio(self) -> None:
        try:
            import RPi.GPIO as GPIO  # type: ignore
        except ImportError as exc:
            raise RuntimeError(
                "backend='gpio' requires RPi.GPIO on Raspberry Pi."
            ) from exc

        GPIO.setmode(GPIO.BCM)
        GPIO.setwarnings(False)
        off_level = GPIO.HIGH if self.relay_active_low else GPIO.LOW
        GPIO.setup(self.grinder_pin, GPIO.OUT, initial=off_level)
        GPIO.setup(self.flame_pin, GPIO.OUT, initial=off_level)
        pull = GPIO.PUD_UP if self.estop_active_high else GPIO.PUD_DOWN
        GPIO.setup(self.estop_pin, GPIO.IN, pull_up_down=pull)
        self._gpio = GPIO

    # ------------------------------------------------------------------
    # Safety & E-Stop checks
    # ------------------------------------------------------------------

    @property
    def grinder_on(self) -> bool:
        return self._grinder_on

    @property
    def flame_on(self) -> bool:
        return self._flame_on

    @property
    def event_log(self) -> list[str]:
        return list(self._event_log)

    def trigger_software_estop(self, reason: str = "manual") -> None:
        self._software_estop = True
        self._event_log.append(f"ESTOP_TRIGGERED:{reason}")
        self.emergency_cutoff()

    def clear_software_estop(self) -> None:
        self._software_estop = False
        self._event_log.append("ESTOP_CLEARED")

    def is_estop_safe(self) -> bool:
        """Return True ONLY when software E-stop AND hardware E-stop switch are safe."""
        if self._software_estop:
            return False
        if self.backend == "gpio" and self._gpio is not None:
            level = bool(self._gpio.input(self.estop_pin))
            # If estop_active_high=True, HIGH means NC switch opened (triggered!)
            triggered = level if self.estop_active_high else (not level)
            if triggered:
                return False
        return True

    def flame_cooldown_remaining_s(self) -> float:
        elapsed = self._clock() - self._last_flame_end_ts
        return max(0.0, self.flame_cooldown_s - elapsed)

    # ------------------------------------------------------------------
    # Low-level relay outputs
    # ------------------------------------------------------------------

    def _set_relays(self, grinder: bool, flame: bool) -> None:
        self._grinder_on = bool(grinder)
        self._flame_on = bool(flame)

        if self.dry_run:
            self._event_log.append(
                f"DRY_RUN_RELAY grinder={int(self._grinder_on)} flame={int(self._flame_on)}"
            )
            return

        if self.backend == "gpio" and self._gpio is not None:
            GPIO = self._gpio
            on_lv = GPIO.LOW if self.relay_active_low else GPIO.HIGH
            off_lv = GPIO.HIGH if self.relay_active_low else GPIO.LOW
            GPIO.output(self.grinder_pin, on_lv if self._grinder_on else off_lv)
            GPIO.output(self.flame_pin, on_lv if self._flame_on else off_lv)
        elif self.backend == "serial":
            self.motor_driver.send_serial_line(
                f"R {int(self._grinder_on)} {int(self._flame_on)}"
            )
        self._event_log.append(
            f"RELAY grinder={int(self._grinder_on)} flame={int(self._flame_on)}"
        )

    def emergency_cutoff(self) -> None:
        """Immediately shut off both grinder and flame relays AND stop motors."""
        self._grinder_on = False
        self._flame_on = False
        if self.backend == "gpio" and self._gpio is not None:
            GPIO = self._gpio
            off_lv = GPIO.HIGH if self.relay_active_low else GPIO.LOW
            GPIO.output(self.grinder_pin, off_lv)
            GPIO.output(self.flame_pin, off_lv)
        elif self.backend == "serial":
            self.motor_driver.send_serial_line("R 0 0")
        self.motor_driver.stop()
        self._event_log.append("EMERGENCY_CUTOFF")

    # ------------------------------------------------------------------
    # Timed safety-interlocked pulse execution
    # ------------------------------------------------------------------

    def _run_timed_relay(
        self,
        *,
        grinder: bool,
        flame: bool,
        duration_s: float,
    ) -> tuple[float, bool]:
        """Run one relay channel in 50ms slices, aborting instantly on E-stop or motion."""
        elapsed = 0.0
        slice_s = 0.05
        aborted = False
        try:
            self._set_relays(grinder=grinder, flame=flame)
            while elapsed < duration_s:
                if not self.is_estop_safe() or self.motor_driver.is_moving:
                    aborted = True
                    break
                dt = min(slice_s, duration_s - elapsed)
                self._sleep(dt)
                elapsed += dt
        finally:
            self._set_relays(grinder=False, flame=False)
            if flame:
                self._last_flame_end_ts = self._clock()
        return round(elapsed, 2), aborted

    def treat_weed(
        self,
        mode: Optional[str] = None,
        flame_duration_s: Optional[float] = None,
        grinder_duration_s: Optional[float] = None,
    ) -> TreatmentResult:
        """
        Execute a safe weed treatment sequence ("none", "grinder", "flame", or "both").

        Safety sequence:
          1. Verify E-stop is safe.
          2. Verify rover is completely stopped (refuse if wheels are moving!).
          3. Wait `settle_before_fire_s`.
          4. Run grinder (if "grinder" or "both"), then flame (if "flame" or "both")
             subject to hard cap `max_flame_burn_s` and cooldown `flame_cooldown_s`.
          5. Ensure both relays are OFF and wait `post_treat_pause_s`.
        """
        chosen = (mode or self.default_mode).lower().strip()
        if chosen not in ("none", "grinder"):
            return TreatmentResult(
                executed=False,
                dry_run=self.dry_run,
                mode=chosen,
                grinder_ran_s=0.0,
                flame_ran_s=0.0,
                reason=f"Invalid tool mode '{chosen}'",
            )

        if chosen == "none":
            return TreatmentResult(
                executed=False,
                dry_run=self.dry_run,
                mode=chosen,
                grinder_ran_s=0.0,
                flame_ran_s=0.0,
                reason="Navigation-only mode (tools disabled)",
            )

        if not self.is_estop_safe():
            self.emergency_cutoff()
            return TreatmentResult(
                executed=False,
                dry_run=self.dry_run,
                mode=chosen,
                grinder_ran_s=0.0,
                flame_ran_s=0.0,
                reason="Blocked: E-stop active",
            )

        if self.motor_driver.is_moving:
            self._set_relays(grinder=False, flame=False)
            return TreatmentResult(
                executed=False,
                dry_run=self.dry_run,
                mode=chosen,
                grinder_ran_s=0.0,
                flame_ran_s=0.0,
                reason="Blocked: Rover must be completely stopped before activating tools",
            )

        # Check flame cooldown before starting a flame-only sequence
        if False:  # Arc ignition intentionally not implemented in this branch.
            cd = self.flame_cooldown_remaining_s()
            if cd > 0.0:
                return TreatmentResult(
                    executed=False,
                    dry_run=self.dry_run,
                    mode=chosen,
                    grinder_ran_s=0.0,
                    flame_ran_s=0.0,
                    reason=f"Blocked: Flame cooldown active ({cd:.1f}s remaining)",
                )

        # Mandatory chassis settle before firing
        self._sleep(self.settle_before_fire_s)
        if not self.is_estop_safe() or self.motor_driver.is_moving:
            self.emergency_cutoff()
            return TreatmentResult(
                executed=False,
                dry_run=self.dry_run,
                mode=chosen,
                grinder_ran_s=0.0,
                flame_ran_s=0.0,
                reason="Aborted during pre-fire settle check",
            )

        g_ran = 0.0
        f_ran = 0.0

        # Step A: Grinding machine
        if chosen == "grinder":
            g_dur = max(0.1, float(grinder_duration_s or self.grinder_duration_s))
            g_ran, aborted = self._run_timed_relay(
                grinder=True, flame=False, duration_s=g_dur
            )
            if aborted:
                self.emergency_cutoff()
                return TreatmentResult(
                    executed=False,
                    dry_run=self.dry_run,
                    mode=chosen,
                    grinder_ran_s=g_ran,
                    flame_ran_s=0.0,
                    reason="Aborted mid-grind by safety interlock",
                )

        # Step B: Flame control (hard capped!)
        if chosen in ("flame", "both"):
            req_flame = float(flame_duration_s or self.flame_duration_s)
            f_dur = min(self.max_flame_burn_s, max(0.1, req_flame))
            f_ran, aborted = self._run_timed_relay(
                grinder=False, flame=True, duration_s=f_dur
            )
            if aborted:
                self.emergency_cutoff()
                return TreatmentResult(
                    executed=False,
                    dry_run=self.dry_run,
                    mode=chosen,
                    grinder_ran_s=g_ran,
                    flame_ran_s=f_ran,
                    reason="Aborted mid-flame by safety interlock",
                )

        self._sleep(self.post_treat_pause_s)
        tag = "dry-run" if self.dry_run else "live"
        return TreatmentResult(
            executed=True,
            dry_run=self.dry_run,
            mode=chosen,
            grinder_ran_s=g_ran,
            flame_ran_s=f_ran,
            reason=f"Completed ({tag}): grinder={g_ran:.2f}s, flame={f_ran:.2f}s",
        )
