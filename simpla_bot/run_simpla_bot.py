#!/usr/bin/env python3
"""
Command-Line Runner for Simpla Bot (branch: simpla_bot).

Examples:
  # 1. Safe bench simulation (runs anywhere, no hardware needed):
  python3 -m simpla_bot.run_simpla_bot --mode sim --tool none

  # 2. Verify Sipeed MaixSense-A075V connection & live distance/corner readout:
  python3 -m simpla_bot.run_simpla_bot --check-maixsense

  # 3. Live driving with dry-run tools (flame/grinder will NOT energize):
  python3 -m simpla_bot.run_simpla_bot --mode live --tool grinder

  # 4. Live field operation with tools ARMED (physical E-Stop required!):
  python3 -m simpla_bot.run_simpla_bot --mode live --tool none

  # 5. Calibrate straight distance (drives 1000mm so you can measure with a tape):
  python3 -m simpla_bot.run_simpla_bot --calibrate-drive 1000

  # 6. Calibrate 90-degree turn:
  python3 -m simpla_bot.run_simpla_bot --calibrate-turn 90
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

# Allow running either as `python3 -m simpla_bot.run_simpla_bot` or `python3 simpla_bot/run_simpla_bot.py`
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from simpla_bot.config_util import load_config
from simpla_bot.maixsense_perception import MaixSenseClient, MaixSenseSpatialAnalyzer
from simpla_bot.motor_driver import NormalMotorDriver
from simpla_bot.simpla_bot_controller import (
    BenchMaixSenseSimulator,
    SimplaBotController,
    create_live_controller,
)
from simpla_bot.tool_controller import FlameGrinderController


def cmd_check_maixsense(cfg: dict, samples: int = 5) -> int:
    """Connect to MaixSense-A075V and print live L/C/R distances & corner readout."""
    client = MaixSenseClient(cfg)
    analyzer = MaixSenseSpatialAnalyzer(cfg)
    print(f"[MaixSense] Connecting to {client.base_url} ...")
    ok = client.configure()
    print(f"[MaixSense] /set_cfg -> {'OK' if ok else 'FAILED (check USB-RNDIS 192.168.233.1)'}")
    if not ok:
        return 1

    for idx in range(samples):
        frame = client.fetch_frame()
        if frame is None:
            print(f"  Frame {idx + 1}: TIMEOUT / READ ERROR")
            continue
        d = analyzer.analyze(frame)
        weed_str = (
            f"WEED dx={d.weed.dx_to_tool_mm:.0f}mm ({d.weed.pixel_count}px)"
            if d.weed
            else "no weed"
        )
        print(
            f"  Frame #{frame.frame_id} ({frame.depth_width}x{frame.depth_height}) | "
            f"L={d.left_mm}mm C={d.center_mm}mm R={d.right_mm}mm | "
            f"go={d.recommended_travel_mm:.0f}mm | corner={d.corner_type} ({d.suggested_turn}) | {weed_str}"
        )
        time.sleep(0.2)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Simpla Bot — Pi 4, MaixSense-A075V, paired L298N motors"
    )
    parser.add_argument("--config", default=None, help="Path to config.yaml")
    parser.add_argument(
        "--mode",
        choices=("sim", "live"),
        default="sim",
        help="sim = safe offline bench simulation; live = real MaixSense & motor driver",
    )
    parser.add_argument(
        "--tool",
        choices=("none", "grinder"),
        default=None,
        help="Treatment tool mode (default comes from config.yaml)",
    )
    parser.add_argument(
        "--check-maixsense",
        action="store_true",
        help="Read 5 live MaixSense-A075V frames and print corner/distance diagnostics",
    )
    parser.add_argument(
        "--calibrate-drive",
        type=float,
        default=None,
        help="Drive forward by N millimeters (e.g. 1000) to calibrate speed_mm_per_sec_at_100pct",
    )
    parser.add_argument(
        "--calibrate-turn",
        type=float,
        default=None,
        help="Pivot turn by N degrees (e.g. 90 or -90) to calibrate turn_90_deg_sec_at_50pct",
    )
    parser.add_argument(
        "--max-steps",
        type=int,
        default=60,
        help="Maximum control steps before stopping",
    )
    args = parser.parse_args(argv)

    cfg = load_config(args.config)

    if args.check_maixsense:
        return cmd_check_maixsense(cfg)

    if args.calibrate_drive is not None:
        motor = NormalMotorDriver(cfg)
        try:
            print(f"[Calibrate] Driving forward {args.calibrate_drive:.0f}mm at 50% speed...")
            moved = motor.move_forward_mm(args.calibrate_drive, speed_pct=50.0)
            print(f"[Calibrate] Done (estimated {moved:.0f}mm). Measure real floor distance with tape.")
        finally:
            motor.close()
        return 0

    if args.calibrate_turn is not None:
        motor = NormalMotorDriver(cfg)
        try:
            print(f"[Calibrate] Pivoting {args.calibrate_turn:+.0f} degrees at 50% speed...")
            turned = motor.turn_angle_deg(args.calibrate_turn, speed_pct=50.0)
            print(f"[Calibrate] Done (commanded {turned:+.0f} deg). Adjust turn_90_deg_sec_at_50pct if needed.")
        finally:
            motor.close()
        return 0

    if args.mode == "sim":
        # Force safe sim backend & instant sleep for quick bench verification
        cfg.setdefault("motor_driver", {})["backend"] = "sim"
        sim_cam = BenchMaixSenseSimulator()
        motor = NormalMotorDriver(cfg, sleep_fn=lambda _s: None)
        tools = FlameGrinderController(
            cfg,
            motor,
            arm_tools=False,
            sleep_fn=lambda _s: None,
        )
        ctrl = SimplaBotController(
            cfg=cfg,
            frame_provider=sim_cam.fetch_frame,
            motor_driver=motor,
            tool_controller=tools,
            tool_mode=args.tool,
            on_move_hook=sim_cam.advance_distance,
            on_turn_hook=sim_cam.reset_new_row,
        )
        print(
            f"[Simpla Bot] Starting BENCH SIM | tool={ctrl.tool_mode} | "
            f"dry_run={tools.dry_run} | max_turns={ctrl.max_turns}"
        )
        stats = ctrl.run(max_steps=args.max_steps)
        for line in stats.history:
            print("  ", line)
        print(
            f"[Simpla Bot] Finished state={stats.state} | "
            f"distance={stats.total_distance_mm:.0f}mm | "
            f"turns={stats.turns_completed} | weeds={stats.weeds_treated}"
        )
        motor.close()
        return 0 if stats.state != "ESTOP_HALT" else 2

    # Live hardware mode
    ctrl, motor, tools = create_live_controller(
        cfg, tool_mode=args.tool, arm_tools=False
    )
    print(
        f"[Simpla Bot] LIVE MODE | backend={motor.backend} | "
        f"tool={ctrl.tool_mode} | dry_run={tools.dry_run}"
    )
    if not tools.dry_run:
        print("  WARNING: FLAME/GRINDER RELAYS ARE ARMED! Keep hand on physical E-Stop.")
    try:
        stats = ctrl.run(max_steps=args.max_steps)
        print(
            f"[Simpla Bot] Stopped state={stats.state} | reason='{stats.halt_reason}' | "
            f"distance={stats.total_distance_mm:.0f}mm | turns={stats.turns_completed} | "
            f"weeds={stats.weeds_treated}"
        )
    finally:
        tools.emergency_cutoff()
        motor.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
