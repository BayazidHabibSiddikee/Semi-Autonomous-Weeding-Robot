#!/usr/bin/env python3
"""
Production Rover Navigation Entry Point.
Fixes:
  - NAV-04: Instantiates and wires RowNavigator into RoverStateMachine.
  - NAV-06: Opens ONE shared ESP32Bridge connection (zero /dev/ttyUSB0 conflict).
  - NAV-08..12: Wires FieldBoundaryGuard, FieldLocalizer, MissionTracker checkpoints,
    and operator Pause / Resume / Recover controls.
  - Strictly decoupled from legacy laser control (navigation-only by default).

Usage:
  python3 Navigation/src/rover_main.py --simulate
  python3 Navigation/src/rover_main.py --resume Navigation/mission_checkpoint.json
"""

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))

from config_loader import load_yaml_config
from esp32_bridge import ESP32Bridge, ESP32Simulator
from field_boundary import FieldBoundaryGuard
from imu_bno055 import BNO055HeadingReader, SimulatedImuHeading
from localizer import FieldLocalizer
from mission_checkpoint import MissionTracker
from rover_motors import create_rover
from row_navigator import RowNavigator
from state_machine import RoverStateMachine
from ultrasonic import UltrasonicSensor, UltrasonicSimulator


def build_navigation_stack(
    config: dict,
    simulate: bool = True,
    resume_path: str | None = None,
    imu_heading_fn=None,
    visual_row_end_fn=None,
    allow_disconnected_esp32: bool = False,
):
    """Assemble the complete decoupled navigation stack over ONE ESP32Bridge with IMU & visual hooks."""
    geo = config["rover"]["geometry"]
    enc = config["rover"]["encoders"]
    obs_cfg = config["rover"]["obstacle_sensor"]
    nav_cfg = config["rover"]["navigation"]
    ser_cfg = config["serial"]

    # 1. Single shared ESP32 serial connection (NAV-06)
    if simulate:
        esp32 = ESP32Simulator(ticks_per_rev=enc["ticks_per_rev"])
        esp32.connect()
        step_physics_fn = esp32.step_physics
    else:
        esp32 = ESP32Bridge(
            port=ser_cfg["esp32_port"],
            baudrate=ser_cfg["esp32_baud"],
            timeout=ser_cfg["esp32_timeout_s"],
        )
        if not esp32.connect() and not allow_disconnected_esp32:
            raise RuntimeError(f"Failed to connect to ESP32 on {ser_cfg['esp32_port']}")
        step_physics_fn = None

    # 2. Continuous encoder + IMU field localizer (NAV-01, NAV-02, NAV-03)
    localizer = FieldLocalizer(
        wheel_radius_cm=geo["wheel_radius_cm"],
        wheel_separation_cm=geo["wheel_separation_cm"],
        skid_multiplier=geo["skid_steer_multiplier"],
        ticks_per_rev=enc["ticks_per_rev"],
        max_slip_residual_cm=nav_cfg["max_slip_residual_cm"],
    )

    # 2b. Wire BNO055 IMU heading feedback (or physics-coupled SimulatedImuHeading in sim mode)
    imu_sensor = None
    if imu_heading_fn is None:
        if simulate:
            imu_sensor = SimulatedImuHeading(
                esp32_sim=esp32,
                wheel_radius_cm=geo["wheel_radius_cm"],
                wheel_separation_cm=geo["wheel_separation_cm"],
                skid_multiplier=geo["skid_steer_multiplier"],
                ticks_per_rev=enc["ticks_per_rev"],
            )
            imu_heading_fn = imu_sensor.read_heading_deg
        else:
            imu_sensor = BNO055HeadingReader.from_config(config)
            if imu_sensor.available:
                imu_heading_fn = imu_sensor.read_heading_deg

    # 3. Field boundary polygon guard (NAV-08)
    boundary = FieldBoundaryGuard.from_rectangle(
        length_cm=nav_cfg["field_length_cm"],
        width_cm=nav_cfg["field_width_cm"],
        safety_margin_cm=geo["boundary_margin_cm"],
    )

    # 4. Closed-loop differential-drive motors sharing the single ESP32Bridge + IMU fusion
    rover = create_rover(
        esp32_bridge=esp32,
        localizer=localizer,
        config=config,
        imu_heading_fn=imu_heading_fn,
        step_physics_fn=step_physics_fn,
    )
    rover.imu_sensor = imu_sensor

    # 5. Structured serpentine RowNavigator (NAV-04, NAV-07)
    navigator = RowNavigator(rover=rover, boundary_guard=boundary, config=config)

    # 6. Initialize pose at Row 0 start inside headland margin
    start_x = nav_cfg["headland_margin_cm"]
    start_y = navigator.row_centers_y[0]
    localizer.reset_pose(start_x, start_y, 0.0, left_ticks=0, right_ticks=0)

    # 7. Fail-safe obstacle sensor on the SAME shared ESP32Bridge (NAV-05, NAV-09)
    if simulate:
        obstacle_sensor = UltrasonicSimulator(
            simulated_distance_mm=900,
            min_valid_mm=obs_cfg["min_valid_mm"],
            max_valid_mm=obs_cfg["max_valid_mm"],
            obstacle_stop_mm=obs_cfg["obstacle_stop_mm"],
        )
    else:
        obstacle_sensor = UltrasonicSensor(
            esp32_bridge=esp32,
            sensor_type=obs_cfg["type"],
            min_valid_mm=obs_cfg["min_valid_mm"],
            max_valid_mm=obs_cfg["max_valid_mm"],
            obstacle_stop_mm=obs_cfg["obstacle_stop_mm"],
            max_consecutive_faults=obs_cfg["max_consecutive_faults"],
        )

    # 8. Coverage verifier & mission checkpoint tracker (NAV-11, NAV-12)
    usable_row_len = nav_cfg["field_length_cm"] - 2.0 * nav_cfg["headland_margin_cm"]
    if resume_path and os.path.exists(resume_path):
        tracker = MissionTracker.load_checkpoint(resume_path)
        navigator.current_row = min(tracker.current_row, navigator.num_rows - 1)
        lx, ly, lh = tracker.last_pose
        localizer.reset_pose(lx, ly, lh, left_ticks=0, right_ticks=0)
    else:
        tracker = MissionTracker(
            field_id=nav_cfg["field_id"],
            num_rows=navigator.num_rows,
            row_length_cm=usable_row_len,
            checkpoint_path=nav_cfg.get("checkpoint_file"),
        )

    # 9. Production Navigation State Machine (decoupled from treatment)
    sm = RoverStateMachine(
        rover=rover,
        row_navigator=navigator,
        obstacle_sensor=obstacle_sensor,
        mission_tracker=tracker,
        safety_check_fn=lambda: esp32.read_telemetry().estop_ok,
        treatment_hook=None,  # Attach modular Flame / Grinder controller only after nav passes
        visual_row_end_fn=visual_row_end_fn,
    )

    return esp32, sm


def main():
    parser = argparse.ArgumentParser(description="Weeding Rover — Production Navigation Controller")
    parser.add_argument("--config", type=str, default="Navigation/rover_config.yaml")
    parser.add_argument("--simulate", action="store_true", help="Run with physics-backed ESP32Simulator")
    parser.add_argument("--resume", type=str, default=None, help="Resume from mission checkpoint JSON")
    args = parser.parse_args()

    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    config_path = os.path.join(repo_root, args.config)
    config = load_yaml_config(config_path)

    esp32, sm = build_navigation_stack(config, simulate=args.simulate, resume_path=args.resume)
    print(f"[Navigation] Starting field '{sm.tracker.field_id}' ({sm.navigator.num_rows} rows, laser detached)")

    try:
        sm.start(max_ticks=600)
    except KeyboardInterrupt:
        sm.pause()
        print("[Navigation] Paused by operator — checkpoint saved.")
    finally:
        sm.stop()
        esp32.disconnect()

    print(f"[Navigation] Final state={sm.state} | Coverage={sm.tracker.summary()}")


if __name__ == "__main__":
    main()
