#!/usr/bin/env python3
"""
Honest Navigation Field Simulator (Replaces wandering SimRover & AvoidUltrasonic).
Exercises the EXACT production navigation stack:
  - Single shared ESP32Simulator (closed-loop quadrature wheel encoders)
  - FieldLocalizer (encoder + IMU fusion)
  - FieldBoundaryGuard (polygon + footprint margin)
  - RowNavigator (geometry + pose serpentine traversal)
  - Fail-safe RoverStateMachine (decoupled from legacy laser)
  - MissionTracker (verified coverage % & checkpoint)

Usage:
  python3 Navigation/sim/run_field_sim.py
"""

import argparse
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, "Navigation", "src"))

from config_loader import load_yaml_config
from rover_main import build_navigation_stack


def main():
    ap = argparse.ArgumentParser(description="Production Navigation Field Simulator")
    ap.add_argument("--config", default=os.path.join(REPO, "Navigation", "rover_config.yaml"))
    ap.add_argument("--max-ticks", type=int, default=400)
    args = ap.parse_args()

    config = load_yaml_config(args.config)

    esp32, sm = build_navigation_stack(config, simulate=True)
    sm.start(max_ticks=args.max_ticks)
    esp32.disconnect()

    summary = sm.tracker.summary()
    print(f"[NAV-SIM] Final State     : {sm.state}")
    print(f"[NAV-SIM] Fault Reason    : {sm.fault_reason}")
    print(f"[NAV-SIM] Steps / Turns   : {sm.stats['steps']} / {sm.stats['row_transitions']}")
    print(f"[NAV-SIM] Completed Rows  : {summary['completed_rows']} / {sm.navigator.num_rows}")
    print(f"[NAV-SIM] Coverage        : {summary['total_coverage_pct']}%")
    print(f"[NAV-SIM] Final Pose (cm) : {summary['last_pose']}")


if __name__ == "__main__":
    main()
