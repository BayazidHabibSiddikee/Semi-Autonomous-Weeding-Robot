"""
Automated Navigation Sector Verification Suite (NAV-01 through NAV-12 + HW-06/07/08).
Tests each subsystem independently before full multi-row serpentine coverage:
  1. Straight-line encoder displacement (NAV-01)
  2. Closed-loop IMU+encoder rotation & slip detection (NAV-02, NAV-10)
  3. Continuous field localization + ArUco/landmark re-localization (NAV-03, NAV-10)
  4. RowNavigator wired directly to RoverStateMachine serpentine mission (NAV-04, NAV-07, NAV-11)
  5. Fail-safe invalid (-1) sensor reading -> FAULT + explicit recovery (NAV-05)
  6. Single shared ESP32Bridge instance across motors & sensor (NAV-06)
  7. FieldBoundaryGuard polygon + footprint margin enforcement (NAV-08)
  8. Unknown obstacle safe OBSTACLE_HOLD without auto-dodging (NAV-09)
  9. Mission Pause/Resume & JSON checkpoint persistence (NAV-12)
 10. ESP32 firmware command validation, watchdog, and hardware E-stop (HW-06, HW-07, HW-08)
"""

import os
import sys
import tempfile
import unittest

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(REPO, "Navigation", "src"))
sys.path.insert(0, os.path.join(REPO, "Navigation", "esp32_firmware"))

from config_loader import load_yaml_config
from esp32_bridge import ESP32Simulator
from field_boundary import FieldBoundaryGuard
from localizer import FieldLocalizer
from mission_checkpoint import MissionTracker
from rover_firmware import RoverFirmwareController
from rover_main import build_navigation_stack
from state_machine import RoverState


def load_config() -> dict:
    return load_yaml_config(os.path.join(REPO, "Navigation", "rover_config.yaml"))


class NavigationAuditTestSuite(unittest.TestCase):
    def setUp(self):
        self.config = load_config()
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.config["rover"]["navigation"]["checkpoint_file"] = os.path.join(
            self.tmp_dir.name, "mission_checkpoint.json"
        )

    def tearDown(self):
        self.tmp_dir.cleanup()

    def test_nav01_nav02_closed_loop_encoder_and_imu_turn(self):
        esp32, sm = build_navigation_stack(self.config, simulate=True)
        start_x, start_y, _ = sm.rover.get_position()

        ok, actual_cm, reason = sm.rover.move_distance(target_cm=25.0, target_heading_deg=0.0)
        self.assertTrue(ok, reason)
        self.assertAlmostEqual(actual_cm, 25.0, delta=1.5)
        nx, ny, _ = sm.rover.get_position()
        self.assertAlmostEqual(nx - start_x, 25.0, delta=1.5)
        self.assertAlmostEqual(ny, start_y, delta=1.5)

        ok, reason = sm.rover.rotate_to_heading(90.0)
        self.assertTrue(ok, reason)
        _, _, h = sm.rover.get_position()
        self.assertAlmostEqual(h, 90.0, delta=3.0)

    def test_nav03_nav10_slip_fault_and_explicit_relocalization(self):
        loc = FieldLocalizer(max_slip_residual_cm=5.0)
        loc.reset_pose(30.0, 30.0, 0.0, left_ticks=0, right_ticks=0)
        # Encoders say straight (dl == dr), IMU reports sudden 50 deg yaw slip
        loc.update(left_ticks=1000, right_ticks=1000, imu_heading_deg=0.0)
        pose = loc.update(left_ticks=2000, right_ticks=2000, imu_heading_deg=50.0)
        self.assertFalse(pose.localized)

        # Landmark/ArUco correction restores localization
        loc.apply_landmark_correction(x_obs_cm=38.0, y_obs_cm=30.0, heading_obs_deg=0.0, gain=1.0)
        fixed = loc.get_pose()
        self.assertTrue(fixed.localized)
        self.assertAlmostEqual(fixed.x_cm, 38.0, delta=0.1)

    def test_nav05_invalid_sensor_reading_enters_fault_and_stops(self):
        esp32, sm = build_navigation_stack(self.config, simulate=True)
        sm.state = RoverState.NAVIGATING_ROW
        sm.running = True
        start_pose = sm.rover.get_position()

        # Inject sensor failure (-1)
        sm.obstacle_sensor.distance = -1
        sm.tick()

        self.assertEqual(sm.state, RoverState.FAULT)
        self.assertIn("OBSTACLE_SENSOR_FAULT", sm.fault_reason or "")
        # Rover MUST NOT have moved forward on -1 reading
        self.assertEqual(sm.rover.get_position(), start_pose)

        # Cannot blindly resume from FAULT without validated recover()
        ok, _ = sm.resume()
        self.assertFalse(ok)

        # Restore sensor and run explicit validated recovery
        sm.obstacle_sensor.distance = 900
        ok, msg = sm.recover()
        self.assertTrue(ok, msg)
        self.assertEqual(sm.state, RoverState.PAUSED)

    def test_nav06_single_shared_esp32_bridge(self):
        esp32, sm = build_navigation_stack(self.config, simulate=True)
        self.assertIs(sm.rover.bridge, esp32)

    def test_nav08_field_boundary_guard_blocks_exit(self):
        guard = FieldBoundaryGuard.from_rectangle(300.0, 200.0, safety_margin_cm=15.0)
        self.assertTrue(guard.check_pose(50.0, 50.0).inside)
        self.assertFalse(guard.check_pose(10.0, 50.0).inside)
        self.assertFalse(guard.is_move_safe(280.0, 50.0, heading_deg=0.0, step_cm=15.0).inside)

    def test_nav09_unknown_obstacle_safe_hold_no_autododge(self):
        esp32, sm = build_navigation_stack(self.config, simulate=True)
        sm.state = RoverState.NAVIGATING_ROW
        sm.running = True
        start_pose = sm.rover.get_position()

        # Unknown obstacle at 220 mm (< 350 mm threshold)
        sm.obstacle_sensor.distance = 220
        sm.tick()

        self.assertEqual(sm.state, RoverState.OBSTACLE_HOLD)
        # Heading unchanged — rover did NOT blindly auto-dodge around unknown obstacle
        self.assertEqual(sm.rover.get_position(), start_pose)

        # Once obstacle clears, navigation resumes cleanly
        sm.obstacle_sensor.distance = 900
        sm.tick()
        self.assertEqual(sm.state, RoverState.NAVIGATING_ROW)

    def test_nav04_nav07_nav11_nav12_full_serpentine_coverage_and_checkpoint(self):
        esp32, sm = build_navigation_stack(self.config, simulate=True)

        # Run partial mission, pause, verify checkpoint persistence, then resume to completion
        sm.start(max_ticks=15)
        sm.pause()
        self.assertEqual(sm.state, RoverState.PAUSED)

        ckpt_path = self.config["rover"]["navigation"]["checkpoint_file"]
        self.assertTrue(os.path.exists(ckpt_path))
        loaded = MissionTracker.load_checkpoint(ckpt_path)
        self.assertGreater(loaded.total_coverage_pct, 0.0)

        ok, msg = sm.resume()
        self.assertTrue(ok, msg)
        sm.start(max_ticks=400)

        self.assertEqual(sm.state, RoverState.DONE)
        self.assertEqual(sm.stats["row_transitions"], sm.navigator.num_rows - 1)
        summary = sm.tracker.summary()
        self.assertEqual(len(summary["completed_rows"]), sm.navigator.num_rows)
        self.assertEqual(summary["unfinished_rows"], [])
        self.assertGreaterEqual(summary["total_coverage_pct"], 95.0)

    def test_hw06_hw07_firmware_validation_and_watchdog(self):
        fw = RoverFirmwareController()
        self.assertTrue(fw.handle_command("VEL 1.5 1.5") == "OK")
        self.assertTrue(fw.handle_command("VEL 99.0 0.0").startswith("ERR:RANGE"))
        self.assertTrue(fw.handle_command("VEL bad args").startswith("ERR:PARSE"))
        self.assertTrue(fw.handle_command("INVALID_CMD").startswith("ERR:UNKNOWN"))

        # Simulate watchdog timeout (> 250 ms without host command)
        fw.last_cmd_ms -= 400
        fw.step_control(0.02)
        self.assertTrue(fw.watchdog_tripped)
        self.assertEqual(fw.target_l, 0.0)
        self.assertEqual(fw.target_r, 0.0)
        # Audit 1E: Watchdog latch MUST NOT clear on VEL or PING — only on explicit CLEAR_LATCH
        self.assertEqual(fw.handle_command("VEL 1.0 1.0"), "ERR:WATCHDOG_LATCHED")
        self.assertEqual(fw.handle_command("CLEAR_LATCH"), "OK:LATCH_CLEARED")
        self.assertEqual(fw.handle_command("VEL 1.0 1.0"), "OK")

    def test_audit26_1a_no_virtual_pose_without_physical_encoders(self):
        from pi_server import HardenedNavigationController

        ctrl = HardenedNavigationController(self.config, simulate=True)
        ctrl.camera_monitor.record_frame_ok()
        before = ctrl.get_status()["pose_measured"]

        # Freeze physical wheel encoders (slip_factor = 0 -> zero ticks even if motor commanded)
        ctrl.esp32.slip_factor_l = 0.0
        ctrl.esp32.slip_factor_r = 0.0
        ctrl.esp32.send_velocity(4.0, 4.0)
        ctrl.esp32.step_physics(0.5)
        telem = ctrl.esp32.read_telemetry()
        ctrl.sm.rover.localizer.update(telem.left_ticks, telem.right_ticks, imu_heading_deg=0.0)
        after = ctrl.get_status()["pose_measured"]

        # Map position MUST NOT advance mathematically when physical encoders did not turn
        self.assertAlmostEqual(after["x_cm"], before["x_cm"], delta=0.01)
        self.assertAlmostEqual(after["y_cm"], before["y_cm"], delta=0.01)

    def test_audit26_1c_camera_failure_causes_immediate_stop_no_blind_move(self):
        from pi_server import HardenedNavigationController

        ctrl = HardenedNavigationController(self.config, simulate=True)
        ctrl.camera_monitor.record_frame_ok(now=100.0)
        code, data = ctrl.handle_start_mission(nav_only=True, operator_confirmed=True, now=100.1)
        self.assertEqual(code, 200, data)

        pose_before = ctrl.sm.rover.get_position()
        # Simulate camera read failure -> must immediately STOP and enter FAULT (zero blind movement)
        ctrl.camera_monitor.record_read_failure()
        ctrl.camera_monitor.record_read_failure()
        status = ctrl.step_control_loop(now=100.2)

        self.assertEqual(status["state"], RoverState.FAULT)
        self.assertIn("CAMERA_LOSS", status["fault_reason"])
        self.assertFalse(status["mission_active"])
        self.assertEqual(ctrl.sm.rover.get_position(), pose_before)

    def test_audit26_1d_3c_3d_one_shot_target_lifecycle_and_crop_rejection(self):
        from target_lifecycle import TargetExecutionManager, TargetState

        # Uncalibrated manager MUST refuse detections (Audit 3D)
        uncal = TargetExecutionManager(homography_matrix=None)
        tgt, reason = uncal.ingest_detection("weed_dandelion", 0.95, 640, 360)
        self.assertIsNone(tgt)
        self.assertEqual(reason, "REJECTED_UNCALIBRATED_HOMOGRAPHY")

        # Calibrated manager
        H = [
            [0.421, -0.012, -260.0],
            [0.015, 0.418, 10.0],
            [0.0, 0.0, 1.0],
        ]
        mgr = TargetExecutionManager(homography_matrix=H, dedup_radius_mm=45.0, cooldown_ms=1000)

        # Audit 3C: Protected crops MUST be hard-rejected
        tgt, reason = mgr.ingest_detection("crop_tomato", 0.99, 640, 360)
        self.assertIsNone(tgt)
        self.assertIn("REJECTED_PROTECTED_CROP", reason)
        self.assertEqual(mgr.rejected_crops, 1)

        # Valid weed accepted once, duplicate frame deduplicated
        t1, r1 = mgr.ingest_detection("weed_dandelion", 0.91, 640, 360)
        self.assertIsNotNone(t1)
        self.assertEqual(r1, "VALIDATED")
        t_dup, r_dup = mgr.ingest_detection("weed_dandelion", 0.93, 642, 361)
        self.assertIsNone(t_dup)
        self.assertEqual(r_dup, "DEDUPLICATED_EXISTING_TARGET")

        # Cannot actuate while rover is moving
        fires = []
        ok, msg = mgr.execute_next_target(
            rover_speed_cms=12.0,
            estop_ok=True,
            interlock_ok=True,
            actuate_fn=lambda t, dwell: (fires.append((t.target_id, dwell)) or True),
            verify_fn=lambda t: True,
            now=10.0,
        )
        self.assertFalse(ok)
        self.assertIn("ROVER_NOT_STATIONARY", msg)

        # Stationary actuation fires ONCE and consumes target
        ok, msg = mgr.execute_next_target(
            rover_speed_cms=0.0,
            estop_ok=True,
            interlock_ok=True,
            actuate_fn=lambda t, dwell: (fires.append((t.target_id, dwell)) or True),
            verify_fn=lambda t: True,
            now=10.5,
        )
        self.assertTrue(ok, msg)
        self.assertEqual(len(fires), 1)
        self.assertEqual(mgr.weeds_eliminated, 1)
        self.assertEqual(t1.state, TargetState.CONSUMED)

        # Re-seeing same weed on next frame MUST NOT re-actuate or double-count
        t_again, r_again = mgr.ingest_detection("weed_dandelion", 0.94, 641, 359)
        self.assertIsNone(t_again)
        self.assertEqual(r_again, "DEDUPLICATED_EXISTING_TARGET")

    def test_audit26_1e_estop_latch_and_unverified_ack_returns_503(self):
        from pi_server import HardenedNavigationController

        # Firmware E-stop latch check
        fw = RoverFirmwareController()
        self.assertEqual(fw.handle_command("ESTOP"), "OK:ESTOP_LATCHED")
        self.assertEqual(fw.handle_command("VEL 2.0 2.0"), "ERR:ESTOP_LATCHED")
        self.assertEqual(fw.handle_command("CLEAR_LATCH"), "OK:LATCH_CLEARED")
        self.assertEqual(fw.handle_command("VEL 2.0 2.0"), "OK")

        # Pi server /stop MUST return HTTP 503 when ESP32 ACK fails (disconnected / NO_ACK)
        ctrl = HardenedNavigationController(self.config, simulate=True)
        ctrl.esp32.connected = False
        code, body = ctrl.handle_stop()
        self.assertEqual(code, 503)
        self.assertFalse(body["ack_verified"])
        self.assertFalse(body["stopped"])

        # When ESP32 is connected and ACKs OK:ESTOP_LATCHED, /stop returns HTTP 200
        ctrl.esp32.connected = True
        code, body = ctrl.handle_stop()
        self.assertEqual(code, 200)
        self.assertTrue(body["ack_verified"])
        self.assertTrue(body["estop_latched"])

    def test_audit26_2b_2c_3a_launch_interlocks_and_sample_image_guard(self):
        from pi_server import HardenedNavigationController

        ctrl = HardenedNavigationController(self.config, simulate=True, model_loaded=False)
        # Missing camera + missing weed model (when nav_only=False) -> blocked 412
        code, body = ctrl.handle_start_mission(nav_only=False, operator_confirmed=True)
        self.assertEqual(code, 412)
        self.assertTrue(any("CAMERA_UNHEALTHY" in b for b in body["blockers"]))
        self.assertIn("WEED_MODEL_NOT_LOADED", body["blockers"])
        self.assertIn("HOMOGRAPHY_NOT_CALIBRATED", body["blockers"])

        # Audit 2C: Sample demo image (/media/field_render.png) MUST be blocked on live hardware
        ctrl.simulate = False
        ctrl.camera_monitor.record_frame_ok()
        code, body = ctrl.handle_start_mission(
            source_type="sample",
            image_url="/media/field_render.png",
            nav_only=True,
            operator_confirmed=True,
        )
        self.assertEqual(code, 412)
        self.assertIn("SAMPLE_IMAGE_FORBIDDEN_ON_LIVE_HARDWARE", body["blockers"])

    def test_audit_c_cold_boot_standby_and_explicit_watchdog_recovery(self):
        from pi_server import HardenedNavigationController

        # 1. Cold-boot ESP32 waits >1.5s before Pi connects: motors stay stopped, NO phantom latch
        fw = RoverFirmwareController()
        fw.last_cmd_ms -= 2000
        fw.step_control(0.02)
        self.assertFalse(fw.watchdog_tripped)
        self.assertEqual(fw.target_l, 0.0)
        self.assertEqual(fw.target_r, 0.0)

        # 2. Pi connects via PING -> PONG 1 1 (estop_ok=1, watchdog_ok=1) and syncs host
        self.assertEqual(fw.handle_command("PING"), "PONG 1 1")
        self.assertTrue(fw.host_synced)

        # 3. Subsequent host silence > 250 ms MUST latch watchdog and resist PING
        fw.last_cmd_ms -= 400
        fw.step_control(0.02)
        self.assertTrue(fw.watchdog_tripped)
        self.assertEqual(fw.handle_command("PING"), "PONG 1 0")
        self.assertEqual(fw.handle_command("VEL 1.0 1.0"), "ERR:WATCHDOG_LATCHED")

        # 4. Pi controller explicit recovery requires operator_confirmed=True
        ctrl = HardenedNavigationController(self.config, simulate=True)
        ctrl.esp32.watchdog_ok = False
        ctrl.sm.state = RoverState.FAULT

        code_deny, body_deny = ctrl.handle_recover(operator_confirmed=False)
        self.assertEqual(code_deny, 400)
        self.assertFalse(body_deny["recovered"])
        self.assertFalse(ctrl.esp32.watchdog_ok)

        code_ok, body_ok = ctrl.handle_recover(operator_confirmed=True)
        self.assertEqual(code_ok, 200, body_ok)
        self.assertTrue(body_ok["recovered"])
        self.assertEqual(body_ok["state"], RoverState.PAUSED)
        self.assertTrue(ctrl.esp32.watchdog_ok)

    def test_audit_b_camera_ingestion_visual_row_end_and_background_worker(self):
        import time
        from pi_server import BackgroundControlWorker, HardenedNavigationController

        ctrl = HardenedNavigationController(self.config, simulate=True)
        self.assertFalse(ctrl.get_status()["hardware"]["camera_healthy"])

        # Ingest live JPEG bytes + visual row-end confidence
        code, resp = ctrl.ingest_camera_frame(b"\xff\xd8\xff\xd9", visual_row_end_conf=0.92)
        self.assertEqual(code, 200)
        self.assertTrue(resp["camera_healthy"])
        self.assertAlmostEqual(resp["visual_row_end_conf"], 0.92, places=2)

        # Start mission and verify visual row-end confidence triggers HEADLAND_TURN
        start_code, start_data = ctrl.handle_start_mission(nav_only=True, operator_confirmed=True)
        self.assertEqual(start_code, 200, start_data)
        ctrl.step_control_loop()
        self.assertEqual(ctrl.sm.state, RoverState.HEADLAND_TURN)

        # Verify BackgroundControlWorker thread executes control ticks autonomously
        worker = BackgroundControlWorker(ctrl, hz=25.0)
        ticks_before = ctrl.worker_ticks
        worker.start()
        try:
            time.sleep(0.18)
            self.assertTrue(worker.is_running)
        finally:
            worker.stop()
        self.assertGreater(ctrl.worker_ticks, ticks_before)

    def test_audit_d_imu_heading_wired_into_navigation_stack(self):
        esp32, sm = build_navigation_stack(self.config, simulate=True)
        self.assertIsNotNone(sm.rover.imu_heading_fn)
        self.assertIsNotNone(sm.rover.imu_sensor)

        # Inject sudden skid-steer yaw divergence on simulated IMU -> localizer detects slip
        sm.rover.imu_sensor.injected_yaw_offset_deg = 0.0
        sm.rover.move_distance(target_cm=8.0, target_heading_deg=0.0)
        sm.rover.imu_sensor.injected_yaw_offset_deg = 60.0
        ok, _, _ = sm.rover.move_distance(target_cm=8.0, target_heading_deg=0.0)
        pose = sm.rover.localizer.get_pose()
        self.assertGreater(pose.slip_residual_cm, 5.0)

    def test_audit_e_ros2_colcon_workspace_manifests_and_collision_monitor_wiring(self):
        import xml.etree.ElementTree as ET

        expected_pkgs = [
            "crop_row_navigation",
            "robot_bringup",
            "robot_safety",
            "rover_description",
            "rover_hardware",
            "rover_localization",
            "rover_navigation",
            "weeding_controller",
        ]
        for pkg in expected_pkgs:
            pkg_dir = os.path.join(REPO, "ros2_ws", "src", pkg)
            pkg_xml = os.path.join(pkg_dir, "package.xml")
            setup_py = os.path.join(pkg_dir, "setup.py")
            setup_cfg = os.path.join(pkg_dir, "setup.cfg")
            res_file = os.path.join(pkg_dir, "resource", pkg)
            self.assertTrue(os.path.exists(pkg_xml), f"Missing {pkg_xml}")
            self.assertTrue(os.path.exists(setup_py), f"Missing {setup_py}")
            self.assertTrue(os.path.exists(setup_cfg), f"Missing {setup_cfg}")
            self.assertTrue(os.path.exists(res_file), f"Missing {res_file}")
            tree = ET.parse(pkg_xml)
            self.assertEqual(tree.getroot().findtext("name"), pkg)

        launch_path = os.path.join(
            REPO, "ros2_ws", "src", "robot_bringup", "launch", "rover_bringup.launch.py"
        )
        with open(launch_path, "r", encoding="utf-8") as fh:
            launch_src = fh.read()
        self.assertIn("nav2_collision_monitor", launch_src)
        self.assertIn("/cmd_vel_nav", launch_src)
        self.assertIn("/cmd_vel_safe", launch_src)

    def test_audit_f_detections_remain_fail_closed_until_calibrated_and_loaded(self):
        from pi_server import HardenedNavigationController

        ctrl = HardenedNavigationController(self.config, simulate=True, model_loaded=False)
        code, body = ctrl.handle_detection(
            class_name="weed_dandelion", confidence=0.95, u_px=640, v_px=360
        )
        self.assertEqual(code, 412)
        self.assertEqual(body["reason"], "WEED_MODEL_NOT_LOADED")

        ctrl.model_loaded = True
        code2, body2 = ctrl.handle_detection(
            class_name="weed_dandelion", confidence=0.95, u_px=640, v_px=360
        )
        self.assertEqual(code2, 412)
        self.assertEqual(body2["reason"], "HOMOGRAPHY_NOT_CALIBRATED")

        cal_code, cal_body = ctrl.set_homography_matrix([
            [0.421, -0.012, -260.0],
            [0.015, 0.418, 10.0],
            [0.0, 0.0, 1.0],
        ])
        self.assertEqual(cal_code, 200)
        self.assertTrue(cal_body["homography_calibrated"])

        crop_code, crop_body = ctrl.handle_detection(
            class_name="crop_tomato", confidence=0.99, u_px=640, v_px=360
        )
        self.assertEqual(crop_code, 200)
        self.assertFalse(crop_body["accepted"])
        self.assertIn("REJECTED_PROTECTED_CROP", crop_body["reason"])

        weed_code, weed_body = ctrl.handle_detection(
            class_name="weed_dandelion", confidence=0.92, u_px=640, v_px=360
        )
        self.assertEqual(weed_code, 200)
        self.assertTrue(weed_body["accepted"])

    def test_startup_handshake_read_only_never_clears_latch_automatically(self):
        from pi_server import HardenedNavigationController

        ctrl = HardenedNavigationController(self.config, simulate=True)
        # Simulate previously latched watchdog & FAULT state on startup
        ctrl.esp32.watchdog_ok = False
        ctrl.sm.state = RoverState.FAULT

        # Default read-only inspection (allow_clear_latch=False) MUST NOT send CLEAR_LATCH
        ro_code, ro_body = ctrl.handle_startup_handshake()
        self.assertEqual(ro_code, 200, ro_body)
        self.assertTrue(ro_body["inspection_only"])
        self.assertFalse(ro_body["clear_latch_attempted"])
        self.assertTrue(ro_body["latch_locked"])
        self.assertFalse(ro_body["esp32_ready"])
        self.assertFalse(ro_body["watchdog_initialized"])
        self.assertFalse(ro_body["navigation_dispatch_unlocked"])
        self.assertEqual(ctrl.sm.state, RoverState.FAULT)
        self.assertFalse(ctrl.esp32.watchdog_ok)
        ro_commands = [s["command"] for s in ro_body["steps"]]
        self.assertIn("PING", ro_commands)
        self.assertNotIn("CLEAR_LATCH", ro_commands)

        # Explicit allow_clear_latch=True WITHOUT operator_confirmed MUST fail (HTTP 400)
        deny_code, deny_body = ctrl.handle_startup_handshake(
            allow_clear_latch=True, operator_confirmed=False
        )
        self.assertEqual(deny_code, 400)
        self.assertTrue(deny_body["latch_locked"])
        self.assertFalse(deny_body["clear_latch_attempted"])
        self.assertEqual(ctrl.sm.state, RoverState.FAULT)

        # Explicit allow_clear_latch=True WITH operator_confirmed=True clears latch
        # and leaves state machine strictly PAUSED (mission_active=False)
        code, body = ctrl.handle_startup_handshake(
            allow_clear_latch=True, operator_confirmed=True
        )
        self.assertEqual(code, 200, body)
        self.assertFalse(body["inspection_only"])
        self.assertTrue(body["clear_latch_attempted"])
        self.assertFalse(body["latch_locked"])
        self.assertTrue(body["esp32_ready"])
        self.assertTrue(body["watchdog_initialized"])
        self.assertTrue(body["estop_ok"])
        self.assertFalse(body["camera_healthy"])
        self.assertFalse(body["navigation_dispatch_unlocked"])
        self.assertEqual(ctrl.sm.state, RoverState.PAUSED)
        self.assertFalse(ctrl.mission_active)
        commands = [s["command"] for s in body["steps"]]
        self.assertIn("PING", commands)
        self.assertIn("CLEAR_LATCH", commands)
        self.assertIn("TELEM?", commands)

    def test_startup_handshake_unlocks_dispatch_when_camera_healthy(self):
        from pi_server import HardenedNavigationController

        ctrl = HardenedNavigationController(self.config, simulate=True)
        ctrl.ingest_camera_frame(b"\xff\xd8\xff\xd9")

        # Refuses CLEAR_LATCH when allow_clear_latch=True & operator_confirmed=False
        deny_code, deny_body = ctrl.handle_startup_handshake(
            allow_clear_latch=True, operator_confirmed=False
        )
        self.assertEqual(deny_code, 400)
        self.assertFalse(deny_body["watchdog_initialized"])
        self.assertFalse(deny_body["navigation_dispatch_unlocked"])

        # Unlocks dispatch once operator-authorized CLEAR_LATCH + TELEM? AND camera are healthy
        ok_code, ok_body = ctrl.handle_startup_handshake(
            allow_clear_latch=True, operator_confirmed=True
        )
        self.assertEqual(ok_code, 200, ok_body)
        self.assertTrue(ok_body["watchdog_initialized"])
        self.assertTrue(ok_body["camera_healthy"])
        self.assertTrue(ok_body["navigation_dispatch_unlocked"])
        self.assertFalse(ctrl.mission_active)

    def test_async_control_loop_worker_drives_mission_continuously(self):
        import asyncio
        from pi_server import AsyncControlLoopWorker, HardenedNavigationController

        ctrl = HardenedNavigationController(self.config, simulate=True)
        ctrl.ingest_camera_frame(b"\xff\xd8\xff\xd9")
        start_x = ctrl.get_status()["pose_measured"]["x_cm"]

        code, body = ctrl.handle_start_mission(nav_only=True, operator_confirmed=True)
        self.assertEqual(code, 200, body)

        async def _exercise():
            worker = AsyncControlLoopWorker(ctrl, hz=25.0)
            task = worker.start()
            self.assertTrue(worker.is_running)
            self.assertIsNotNone(task)
            # Keep camera frames fresh while the async background worker ticks the mission
            for _ in range(4):
                ctrl.ingest_camera_frame(b"\xff\xd8\xff\xd9")
                await asyncio.sleep(0.06)
            await worker.stop()
            self.assertFalse(worker.is_running)

        asyncio.run(_exercise())
        self.assertGreater(ctrl.worker_ticks, 2)
        end_x = ctrl.get_status()["pose_measured"]["x_cm"]
        self.assertGreater(end_x, start_x)

    def test_global_app_boot_survives_unplugged_usb_esp32_fail_closed(self):
        from pi_server import HardenedNavigationController

        cfg = load_config()
        cfg["serial"]["esp32_port"] = "/dev/nonexistent_esp32_port_xyz"
        # Must NOT raise RuntimeError during module import/boot when USB cable is unplugged
        ctrl = HardenedNavigationController(cfg, simulate=False)
        self.assertFalse(ctrl.esp32.connected)
        # Launch interlock MUST remain strictly fail-closed until ESP32 connects
        code, body = ctrl.handle_start_mission(nav_only=True, operator_confirmed=True)
        self.assertEqual(code, 412)
        self.assertIn("ESP32_NOT_CONNECTED", body["blockers"])

    @staticmethod
    def _make_synthetic_png(width: int, height: int, pixel_fn) -> bytes:
        import struct
        import zlib

        def _chunk(ctype: bytes, data: bytes) -> bytes:
            crc = zlib.crc32(ctype + data) & 0xFFFFFFFF
            return struct.pack(">I", len(data)) + ctype + data + struct.pack(">I", crc)

        raw_rows = bytearray()
        for y in range(height):
            raw_rows.append(0)  # filter type 0
            for x in range(width):
                r, g, b = pixel_fn(x, y)
                raw_rows.extend((r, g, b))
        ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
        return (
            b"\x89PNG\r\n\x1a\n"
            + _chunk(b"IHDR", ihdr)
            + _chunk(b"IDAT", zlib.compress(bytes(raw_rows)))
            + _chunk(b"IEND", b"")
        )

    def test_crop_row_vision_computes_row_end_and_lateral_error(self):
        from pi_server import HardenedNavigationController

        ctrl = HardenedNavigationController(self.config, simulate=True)

        # Frame 1: Continuous green crop ridges on left & right, bare brown furrow in center
        def continuous_row_px(x: int, y: int):
            if 10 <= x <= 24 or 56 <= x <= 70:
                return (30, 175, 40)  # crop green
            return (110, 82, 58)  # brown soil

        row_png = self._make_synthetic_png(80, 60, continuous_row_px)
        code1, body1 = ctrl.ingest_camera_frame(row_png, mime_type="image/png")
        self.assertEqual(code1, 200)
        self.assertTrue(body1["bev_ready"])
        self.assertEqual(body1["bev_url"], "/bev_image")

        if body1["vision_decoded"]:
            # Continuous green in both near & far bands -> low row-end confidence
            self.assertLess(body1["visual_row_end_conf"], 0.45)
            self.assertFalse(body1["row_end_detected"])
            self.assertGreater(body1["green_ratio_far"], 0.15)
            self.assertGreaterEqual(len(body1["furrows"]), 1)

            # Frame 2: Row end approaching — green only in near band (bottom), bare soil in far band (top)
            def row_end_px(x: int, y: int):
                if y >= 32 and (10 <= x <= 24 or 56 <= x <= 70):
                    return (30, 175, 40)
                return (110, 82, 58)

            end_png = self._make_synthetic_png(80, 60, row_end_px)
            code2, body2 = ctrl.ingest_camera_frame(end_png, mime_type="image/png")
            self.assertEqual(code2, 200)
            self.assertTrue(body2["vision_decoded"])
            self.assertGreater(body2["visual_row_end_conf"], body1["visual_row_end_conf"])
            self.assertGreaterEqual(body2["visual_row_end_conf"], 0.70)
            # Confirm RoverStateMachine visual_row_end_fn sees the computed value
            self.assertAlmostEqual(
                ctrl._get_visual_row_end_conf(), body2["visual_row_end_conf"], places=2
            )

    def test_multipart_image_upload_extraction_for_android_client(self):
        from pi_server import HardenedNavigationController, extract_multipart_image

        boundary = "----AndroidPiLiveClientBoundary"
        sample_jpeg = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00\xff\xd9"
        body = (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="frame.jpg"\r\n'
            f"Content-Type: image/jpeg\r\n\r\n"
        ).encode("utf-8") + sample_jpeg + f"\r\n--{boundary}--\r\n".encode("utf-8")
        content_type = f"multipart/form-data; boundary={boundary}"

        extracted, mime = extract_multipart_image(body, content_type)
        self.assertEqual(extracted, sample_jpeg)
        self.assertEqual(mime, "image/jpeg")

        ctrl = HardenedNavigationController(self.config, simulate=True)
        code, resp = ctrl.ingest_camera_frame(extracted, mime_type=mime)
        self.assertEqual(code, 200)
        self.assertTrue(resp["ok"])
        self.assertTrue(resp["bev_ready"])
        self.assertEqual(resp["bev_url"], "/bev_image")
        self.assertIn("furrows", resp)
        self.assertIn("row_end_detected", resp)
        self.assertIn("confidence", resp)

    def test_load_weed_model_path_confinement_and_verification(self):
        import tempfile
        from pi_server import HardenedNavigationController

        ctrl = HardenedNavigationController(self.config, simulate=True)

        # Reject empty path
        c0, b0 = ctrl.load_weed_model("")
        self.assertEqual(c0, 400)
        self.assertFalse(ctrl.model_loaded)

        with tempfile.TemporaryDirectory() as tmpdir:
            prev_env = os.environ.get("WEED_MODEL_DIR")
            os.environ["WEED_MODEL_DIR"] = tmpdir
            try:
                # Reject path traversal outside WEED_MODEL_DIR
                c1, b1 = ctrl.load_weed_model("../../etc/passwd")
                self.assertEqual(c1, 403)
                self.assertEqual(b1["error"], "MODEL_PATH_OUTSIDE_ALLOWED_DIR")
                self.assertFalse(ctrl.model_loaded)

                # Reject unsupported extension
                txt_path = os.path.join(tmpdir, "notes.txt")
                with open(txt_path, "wb") as fh:
                    fh.write(b"not a model")
                c2, b2 = ctrl.load_weed_model("notes.txt")
                self.assertEqual(c2, 400)
                self.assertFalse(ctrl.model_loaded)

                # Reject missing .pt file
                c3, b3 = ctrl.load_weed_model("missing_weights.pt")
                self.assertEqual(c3, 404)
                self.assertFalse(ctrl.model_loaded)

                # Accept verified real .pt file inside WEED_MODEL_DIR
                pt_path = os.path.join(tmpdir, "weed_detector_v1.pt")
                with open(pt_path, "wb") as fh:
                    fh.write(b"WEIGHTS_PAYLOAD_BYTES")
                c4, b4 = ctrl.load_weed_model("weed_detector_v1.pt")
                self.assertEqual(c4, 200, b4)
                self.assertTrue(b4["model_loaded"])
                self.assertTrue(ctrl.model_loaded)
                self.assertEqual(b4["model_file"], "weed_detector_v1.pt")
                self.assertGreater(b4["size_bytes"], 0)
            finally:
                if prev_env is None:
                    os.environ.pop("WEED_MODEL_DIR", None)
                else:
                    os.environ["WEED_MODEL_DIR"] = prev_env

    def test_execute_next_treatment_target_enforces_interlocks_and_stationary_stop(self):
        from pi_server import HardenedNavigationController

        ctrl = HardenedNavigationController(self.config, simulate=True)
        ctrl.ingest_camera_frame(b"\xff\xd8\xff\xd9")

        # Strictly blocked by default (nav_only_mode=True, model_loaded=False, uncalibrated, no actuator)
        c1, b1 = ctrl.execute_next_treatment_target()
        self.assertEqual(c1, 412)
        self.assertIn("NAV_ONLY_MODE_ACTIVE", b1["blockers"])
        self.assertIn("WEED_MODEL_NOT_LOADED", b1["blockers"])
        self.assertIn("HOMOGRAPHY_NOT_CALIBRATED", b1["blockers"])
        self.assertIn("TREATMENT_ACTUATOR_NOT_ATTACHED", b1["blockers"])

        # Enable all interlocks explicitly
        ctrl.nav_only_mode = False
        ctrl.model_loaded = True
        ctrl.set_homography_matrix([
            [0.421, -0.012, -260.0],
            [0.015, 0.418, 10.0],
            [0.0, 0.0, 1.0],
        ])
        d_code, d_body = ctrl.handle_detection(
            class_name="weed_dandelion", confidence=0.94, u_px=640, v_px=360
        )
        self.assertEqual(d_code, 200)
        self.assertTrue(d_body["accepted"])

        actuated: list[tuple[int, int]] = []

        def mock_actuator(target, dwell_ms: int) -> bool:
            actuated.append((target.target_id, dwell_ms))
            return True

        c2, b2 = ctrl.execute_next_treatment_target(actuator_fn=mock_actuator)
        self.assertEqual(c2, 200, b2)
        self.assertTrue(b2["executed"])
        self.assertEqual(b2["weeds_eliminated"], 1)
        self.assertEqual(len(actuated), 1)
        # Rover velocity must be zeroed prior to stationary treatment actuation
        self.assertEqual(ctrl.esp32.left_rad_s, 0.0)
        self.assertEqual(ctrl.esp32.right_rad_s, 0.0)

    def test_bearer_token_authentication_verification(self):
        from pi_server import verify_bearer_token

        # Open when no token configured (local bench default)
        self.assertTrue(verify_bearer_token(None, None))
        self.assertTrue(verify_bearer_token(None, ""))

        # Enforced when PI_API_TOKEN is configured
        secret = "field-rover-secret-token-99"
        self.assertFalse(verify_bearer_token(None, secret))
        self.assertFalse(verify_bearer_token("", secret))
        self.assertFalse(verify_bearer_token("Basic abc123", secret))
        self.assertFalse(verify_bearer_token("Bearer wrong-token", secret))
        self.assertTrue(verify_bearer_token(f"Bearer {secret}", secret))
        self.assertTrue(verify_bearer_token(f"bearer {secret}", secret))

    def test_ros2_row_follow_action_server_structure(self):
        repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
        action_def = os.path.join(
            repo_root, "ros2_ws", "src", "crop_row_navigation", "action", "FollowCropRow.action"
        )
        node_src = os.path.join(
            repo_root, "ros2_ws", "src", "crop_row_navigation", "row_follow_action.py"
        )
        self.assertTrue(os.path.isfile(action_def), "FollowCropRow.action interface missing")
        self.assertTrue(os.path.isfile(node_src), "row_follow_action.py missing")
        with open(action_def, "r", encoding="utf-8") as fh:
            action_text = fh.read()
        self.assertIn("nearest_weed_distance_from_base_m", action_text)
        self.assertIn("weeds_measured_count", action_text)
        with open(node_src, "r", encoding="utf-8") as fh:
            src = fh.read()
        self.assertIn("ActionServer(", src)
        self.assertIn("/follow_crop_row", src)
        self.assertIn("_goal_callback", src)
        self.assertIn("_handle_accepted_callback", src)
        self.assertIn("_cancel_callback", src)
        self.assertIn("_execute_goal_callback", src)
        self.assertIn("WeedBaseDistanceEstimator", src)
        self.assertIn("base_link", src)
        self.assertIn("MultiThreadedExecutor", src)

    def _load_row_follow_module(self):
        import importlib.util

        repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
        node_src = os.path.join(
            repo_root, "ros2_ws", "src", "crop_row_navigation", "row_follow_action.py"
        )
        spec = importlib.util.spec_from_file_location("row_follow_action_mod", node_src)
        self.assertIsNotNone(spec)
        assert spec is not None and spec.loader is not None
        mod = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = mod
        spec.loader.exec_module(mod)
        return mod

    def test_ros2_weed_base_distance_measurement_modes(self):
        import math

        mod = self._load_row_follow_module()
        est = mod.WeedBaseDistanceEstimator(
            camera_offset_x_m=0.22,
            camera_offset_y_m=0.0,
            camera_height_m=0.42,
            camera_pitch_deg=35.0,
            fov_h_deg=68.0,
            fov_v_deg=52.0,
            image_width_px=640,
            image_height_px=480,
        )

        # 1. Flat-ground pinhole projection at image center (320, 240)
        m_center = est.measure_weed(u_px=320, v_px=240, class_name="weed_dandelion", confidence=0.92)
        self.assertIsNotNone(m_center)
        expected_x = 0.22 + 0.42 / math.tan(math.radians(35.0))
        self.assertEqual(m_center.method, "pinhole_ground")
        self.assertAlmostEqual(m_center.x_base_m, expected_x, places=3)
        self.assertAlmostEqual(m_center.y_base_m, 0.0, places=3)
        self.assertAlmostEqual(
            m_center.distance_from_base_m,
            math.hypot(m_center.x_base_m, m_center.y_base_m),
            places=3,
        )
        self.assertTrue(m_center.in_treatment_reach)

        # Lower pixel (closer to rover) must yield shorter distance from base_link
        m_near = est.measure_weed(u_px=320, v_px=390, class_name="weed_grass")
        self.assertIsNotNone(m_near)
        self.assertLess(m_near.distance_from_base_m, m_center.distance_from_base_m)

        # Left pixel -> +Y in ROS REP-103 base_link; right pixel -> -Y
        m_left = est.measure_weed(u_px=180, v_px=320, class_name="weed_left")
        m_right = est.measure_weed(u_px=460, v_px=320, class_name="weed_right")
        self.assertIsNotNone(m_left)
        self.assertIsNotNone(m_right)
        self.assertGreater(m_left.y_base_m, 0.0)
        self.assertLess(m_right.y_base_m, 0.0)
        self.assertAlmostEqual(m_left.y_base_m, -m_right.y_base_m, places=3)

        # Above-horizon ray must be rejected cleanly
        est_shallow = mod.WeedBaseDistanceEstimator(camera_pitch_deg=10.0, fov_v_deg=60.0)
        self.assertIsNone(est_shallow.measure_weed(u_px=320, v_px=0, class_name="weed_sky"))

        # 2. RGB-D ToF depth projection
        m_depth = est.measure_weed(u_px=320, v_px=240, depth_m=0.80, class_name="weed_depth")
        self.assertIsNotNone(m_depth)
        self.assertEqual(m_depth.method, "rgbd_depth")
        self.assertAlmostEqual(m_depth.x_base_m, 0.22 + 0.80 * math.cos(math.radians(35.0)), places=3)
        self.assertAlmostEqual(m_depth.y_base_m, 0.0, places=3)

        # 3. Calibrated homography (mm) + camera-to-base offset
        est_h = mod.WeedBaseDistanceEstimator(
            camera_offset_x_m=0.22,
            homography_matrix=[
                [1.0, 0.0, -320.0],   # lateral mm (right +)
                [0.0, 1.0, 100.0],    # forward mm ahead of camera
                [0.0, 0.0, 1.0],
            ],
            homography_units="mm",
        )
        m_hom = est_h.measure_weed(u_px=420, v_px=200, class_name="weed_homography")
        self.assertIsNotNone(m_hom)
        self.assertEqual(m_hom.method, "homography")
        self.assertAlmostEqual(m_hom.x_base_m, 0.22 + 0.30, places=3)  # 0.52 m forward
        self.assertAlmostEqual(m_hom.y_base_m, -0.10, places=3)        # 0.10 m right -> -0.10 Y
        self.assertAlmostEqual(m_hom.distance_from_base_m, math.hypot(0.52, -0.10), places=3)

        # 4. Batch measurement excludes protected crops and sorts nearest-first from base_link
        batch = est.measure_batch([
            {"class_name": "crop_tomato", "confidence": 0.99, "u_px": 320, "v_px": 410},
            {"class_name": "weed_far", "confidence": 0.88, "u_px": 320, "v_px": 240},
            {"class_name": "weed_near", "confidence": 0.93, "u_px": 320, "v_px": 390},
        ])
        self.assertEqual(len(batch), 2)
        self.assertEqual(batch[0].class_name, "weed_near")
        self.assertEqual(batch[1].class_name, "weed_far")
        self.assertLess(batch[0].distance_from_base_m, batch[1].distance_from_base_m)

    def test_ros2_row_follow_goal_completion_cancellation_and_estop_cycles(self):
        import time
        import types

        mod = self._load_row_follow_module()
        est = mod.WeedBaseDistanceEstimator()

        class FakeGoalHandle:
            def __init__(self, cancel_on_check: int | None = None):
                self._cancel_on_check = cancel_on_check
                self._checks = 0
                self.terminal_state: str | None = None

            @property
            def is_cancel_requested(self) -> bool:
                self._checks += 1
                return self._cancel_on_check is not None and self._checks >= self._cancel_on_check

            def succeed(self):
                self.terminal_state = "SUCCEEDED"

            def canceled(self):
                self.terminal_state = "CANCELED"

            def abort(self):
                self.terminal_state = "ABORTED"

        # Cycle 1: Normal completion on row end with live weed base_link distance feedback
        gh_ok = FakeGoalHandle()
        tick_counter = {"n": 0}
        cmds: list[tuple[float, float]] = []
        zeros = {"count": 0}
        feedbacks: list[dict] = []
        statuses: list[str] = []

        def fake_track_update(_obs):
            tick_counter["n"] += 1
            return types.SimpleNamespace(
                lateral_error_m=0.02,
                heading_error_rad=0.01,
                row_end_confidence=0.95 if tick_counter["n"] >= 3 else 0.1,
                row_end_reached=tick_counter["n"] >= 3,
            )

        outcome_ok = mod.run_row_follow_cycle(
            row_id=2,
            speed_limit_mps=0.18,
            max_duration_s=5.0,
            goal_handle=gh_ok,
            get_estop_fn=lambda: False,
            get_frame_fn=lambda: ("frame", time.monotonic()),
            detect_fn=lambda f: f,
            track_update_fn=fake_track_update,
            track_reset_fn=lambda: None,
            compute_cmd_fn=lambda _st, vcap: types.SimpleNamespace(linear_x_mps=vcap, angular_z_rad_s=-0.05),
            publish_cmd_fn=lambda vx, wz: cmds.append((vx, wz)),
            publish_zero_fn=lambda: zeros.__setitem__("count", zeros["count"] + 1),
            publish_status_fn=statuses.append,
            measure_weeds_fn=lambda: est.measure_batch([
                {"class_name": "weed_dandelion", "confidence": 0.91, "u_px": 320, "v_px": 370}
            ]),
            publish_feedback_fn=lambda _gh, fb: feedbacks.append(fb),
            get_odom_distance_fn=lambda: 1.5 * tick_counter["n"],
            tick_sleep_s=0.0,
        )
        state_ok = mod.finalize_goal_handle(gh_ok, outcome_ok)
        self.assertEqual(state_ok, "SUCCEEDED")
        self.assertEqual(gh_ok.terminal_state, "SUCCEEDED")
        self.assertTrue(outcome_ok["success"])
        self.assertEqual(outcome_ok["reason"], "ROW_END_REACHED")
        self.assertGreater(outcome_ok["nearest_weed_distance_from_base_m"], 0.2)
        self.assertEqual(outcome_ok["weeds_measured_count"], 1)
        self.assertGreaterEqual(zeros["count"], 1)
        self.assertEqual(len(feedbacks), 3)
        self.assertGreater(feedbacks[0]["nearest_weed_distance_from_base_m"], 0.2)

        # Cycle 2: Action cancellation stops motors and marks goal CANCELED
        gh_cancel = FakeGoalHandle(cancel_on_check=2)
        cancel_zeros = {"count": 0}
        outcome_cancel = mod.run_row_follow_cycle(
            row_id=3,
            speed_limit_mps=0.18,
            max_duration_s=5.0,
            goal_handle=gh_cancel,
            get_estop_fn=lambda: False,
            get_frame_fn=lambda: ("frame", time.monotonic()),
            detect_fn=lambda f: f,
            track_update_fn=lambda _obs: types.SimpleNamespace(
                lateral_error_m=0.0, heading_error_rad=0.0, row_end_confidence=0.0, row_end_reached=False
            ),
            track_reset_fn=lambda: None,
            compute_cmd_fn=lambda _st, vcap: types.SimpleNamespace(linear_x_mps=vcap, angular_z_rad_s=0.0),
            publish_cmd_fn=lambda _vx, _wz: None,
            publish_zero_fn=lambda: cancel_zeros.__setitem__("count", cancel_zeros["count"] + 1),
            publish_status_fn=lambda _s: None,
            tick_sleep_s=0.0,
        )
        state_cancel = mod.finalize_goal_handle(gh_cancel, outcome_cancel)
        self.assertEqual(state_cancel, "CANCELED")
        self.assertEqual(gh_cancel.terminal_state, "CANCELED")
        self.assertFalse(outcome_cancel["success"])
        self.assertEqual(outcome_cancel["reason"], "CANCELED")
        self.assertGreaterEqual(cancel_zeros["count"], 1)

        # Cycle 3: Hardware E-stop immediately aborts goal and zeroes velocity
        gh_estop = FakeGoalHandle()
        estop_zeros = {"count": 0}
        outcome_estop = mod.run_row_follow_cycle(
            row_id=4,
            speed_limit_mps=0.18,
            max_duration_s=5.0,
            goal_handle=gh_estop,
            get_estop_fn=lambda: True,
            get_frame_fn=lambda: ("frame", time.monotonic()),
            detect_fn=lambda f: f,
            track_update_fn=lambda _obs: types.SimpleNamespace(row_end_reached=False),
            track_reset_fn=lambda: None,
            compute_cmd_fn=lambda _st, vcap: types.SimpleNamespace(linear_x_mps=vcap, angular_z_rad_s=0.0),
            publish_cmd_fn=lambda _vx, _wz: None,
            publish_zero_fn=lambda: estop_zeros.__setitem__("count", estop_zeros["count"] + 1),
            publish_status_fn=lambda _s: None,
            tick_sleep_s=0.0,
        )
        state_estop = mod.finalize_goal_handle(gh_estop, outcome_estop)
        self.assertEqual(state_estop, "ABORTED")
        self.assertEqual(gh_estop.terminal_state, "ABORTED")
        self.assertFalse(outcome_estop["success"])
        self.assertEqual(outcome_estop["reason"], "HARDWARE_ESTOP_ACTIVE")
        self.assertGreaterEqual(estop_zeros["count"], 1)

    def test_ros2_realtime_motion_compensation_and_treatment_positioning(self):
        import time
        import types

        mod = self._load_row_follow_module()
        est = mod.WeedBaseDistanceEstimator(
            camera_offset_x_m=0.22,
            camera_offset_y_m=0.0,
            camera_height_m=0.42,
            camera_pitch_deg=35.0,
            actuator_offset_x_m=0.25,
            actuator_offset_y_m=0.0,
            treatment_stop_tolerance_m=0.04,
            treatment_lateral_tolerance_m=0.14,
        )

        # 1. Motion compensation must shift weed closer to base_link by vx * dt
        static_m = est.measure_weed(u_px=320, v_px=240, depth_m=0.80, class_name="weed_a")
        moving_m = est.measure_weed(
            u_px=320,
            v_px=240,
            depth_m=0.80,
            class_name="weed_a",
            detection_age_s=0.10,
            linear_vx_mps=0.20,
            angular_wz_rad_s=0.0,
        )
        self.assertIsNotNone(static_m)
        self.assertIsNotNone(moving_m)
        self.assertAlmostEqual(static_m.x_base_m - moving_m.x_base_m, 0.02, places=3)
        self.assertAlmostEqual(moving_m.latency_compensated_s, 0.10, places=3)
        self.assertAlmostEqual(moving_m.dx_to_actuator_m, moving_m.x_base_m - 0.25, places=3)

        # 2. TreatmentPositioningController transitions: CRUISE -> APPROACH_SLOWDOWN -> TREATMENT_ALIGNED_HOLD -> PASSED
        pos_ctrl = mod.TreatmentPositioningController(
            approach_slowdown_distance_m=0.45,
            approach_min_speed_mps=0.04,
            stop_tolerance_m=0.04,
            lateral_corridor_m=0.14,
            enabled=True,
        )

        def _make_weed(x_base: float, y_base: float = 0.0):
            dx = x_base - 0.25
            dy = y_base
            return mod.WeedBaseMeasurement(
                class_name="weed_dandelion",
                confidence=0.95,
                u_px=320.0,
                v_px=360.0,
                x_base_m=x_base,
                y_base_m=y_base,
                distance_from_base_m=round((x_base**2 + y_base**2) ** 0.5, 4),
                bearing_rad=0.0,
                dx_to_actuator_m=round(dx, 4),
                dy_to_actuator_m=round(dy, 4),
                distance_to_actuator_m=round((dx**2 + dy**2) ** 0.5, 4),
                latency_compensated_s=0.0,
                method="rgbd_depth",
                in_treatment_reach=True,
                ready_for_treatment=abs(dx) <= 0.04 and abs(dy) <= 0.14,
            )

        dec_far = pos_ctrl.modulate_command(0.18, 0.02, [_make_weed(0.95)])
        self.assertEqual(dec_far.mode, "CRUISE")
        self.assertAlmostEqual(dec_far.linear_x_mps, 0.18, places=4)
        self.assertFalse(dec_far.aligned_for_treatment)

        dec_approach = pos_ctrl.modulate_command(0.18, 0.02, [_make_weed(0.45)])
        self.assertEqual(dec_approach.mode, "APPROACH_SLOWDOWN")
        self.assertGreater(dec_approach.linear_x_mps, 0.04)
        self.assertLess(dec_approach.linear_x_mps, 0.18)
        self.assertFalse(dec_approach.aligned_for_treatment)

        dec_align = pos_ctrl.modulate_command(0.18, 0.05, [_make_weed(0.26, 0.01)])
        self.assertEqual(dec_align.mode, "TREATMENT_ALIGNED_HOLD")
        self.assertEqual(dec_align.linear_x_mps, 0.0)
        self.assertEqual(dec_align.angular_z_rad_s, 0.0)
        self.assertTrue(dec_align.aligned_for_treatment)

        # Already passed behind the actuator -> resume CRUISE
        dec_passed = pos_ctrl.modulate_command(0.18, 0.0, [_make_weed(0.10)])
        self.assertEqual(dec_passed.mode, "CRUISE")
        self.assertAlmostEqual(dec_passed.linear_x_mps, 0.18, places=4)

        # 3. End-to-end cycle with approaching weed -> stationary treatment alignment -> row end
        sequence = [_make_weed(0.90), _make_weed(0.45), _make_weed(0.25), _make_weed(0.05)]
        step = {"i": 0}
        aligned_targets: list = []
        feedbacks: list[dict] = []
        cmds: list[tuple[float, float]] = []

        class _GH:
            is_cancel_requested = False

            def succeed(self):
                pass

            def canceled(self):
                pass

            def abort(self):
                pass

        def _track(_obs):
            idx = step["i"]
            step["i"] += 1
            return types.SimpleNamespace(
                lateral_error_m=0.01,
                heading_error_rad=0.0,
                row_end_confidence=1.0 if idx >= 3 else 0.0,
                row_end_reached=idx >= 3,
            )

        outcome = mod.run_row_follow_cycle(
            row_id=5,
            speed_limit_mps=0.18,
            max_duration_s=5.0,
            goal_handle=_GH(),
            get_estop_fn=lambda: False,
            get_frame_fn=lambda: ("frame", time.monotonic()),
            detect_fn=lambda f: f,
            track_update_fn=_track,
            track_reset_fn=lambda: None,
            compute_cmd_fn=lambda _st, vcap: types.SimpleNamespace(linear_x_mps=vcap, angular_z_rad_s=0.0),
            publish_cmd_fn=lambda vx, wz: cmds.append((vx, wz)),
            publish_zero_fn=lambda: None,
            publish_status_fn=lambda _s: None,
            measure_weeds_fn=lambda: [sequence[min(step["i"] - 1, len(sequence) - 1)]],
            publish_treatment_target_fn=aligned_targets.append,
            positioning_controller=pos_ctrl,
            publish_feedback_fn=lambda _gh, fb: feedbacks.append(fb),
            tick_sleep_s=0.0,
        )
        self.assertTrue(outcome["success"])
        self.assertEqual(outcome["treatment_alignments_count"], 1)
        self.assertEqual(len(aligned_targets), 1)
        self.assertAlmostEqual(aligned_targets[0].x_base_m, 0.25, places=3)
        self.assertEqual(
            [fb["positioning_mode"] for fb in feedbacks],
            ["CRUISE", "APPROACH_SLOWDOWN", "TREATMENT_ALIGNED_HOLD", "CRUISE"],
        )
        # Approach velocity was strictly lower than cruise velocity
        self.assertLess(cmds[1][0], cmds[0][0])


if __name__ == "__main__":
    unittest.main()
