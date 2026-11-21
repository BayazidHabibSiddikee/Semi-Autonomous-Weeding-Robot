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

    def test_startup_handshake_clears_latch_and_validates_ready_state(self):
        from pi_server import HardenedNavigationController

        ctrl = HardenedNavigationController(self.config, simulate=True)
        # Simulate previously latched watchdog & FAULT state on startup
        ctrl.esp32.watchdog_ok = False
        ctrl.sm.state = RoverState.FAULT

        # Without camera frames, ESP32 CLEAR_LATCH succeeds & initializes watchdog,
        # while navigation_dispatch_unlocked stays False until camera is healthy.
        code, body = ctrl.handle_startup_handshake(operator_confirmed=True)
        self.assertEqual(code, 200, body)
        self.assertTrue(body["esp32_ready"])
        self.assertTrue(body["watchdog_initialized"])
        self.assertTrue(body["estop_ok"])
        self.assertFalse(body["camera_healthy"])
        self.assertFalse(body["navigation_dispatch_unlocked"])
        self.assertEqual(ctrl.sm.state, RoverState.PAUSED)
        commands = [s["command"] for s in body["steps"]]
        self.assertIn("PING", commands)
        self.assertIn("CLEAR_LATCH", commands)
        self.assertIn("TELEM?", commands)

    def test_startup_handshake_unlocks_dispatch_when_camera_healthy(self):
        from pi_server import HardenedNavigationController

        ctrl = HardenedNavigationController(self.config, simulate=True)
        ctrl.ingest_camera_frame(b"\xff\xd8\xff\xd9")

        # Refuses CLEAR_LATCH when operator_confirmed=False
        deny_code, deny_body = ctrl.handle_startup_handshake(operator_confirmed=False)
        self.assertEqual(deny_code, 400)
        self.assertFalse(deny_body["watchdog_initialized"])
        self.assertFalse(deny_body["navigation_dispatch_unlocked"])

        # Unlocks dispatch once CLEAR_LATCH + TELEM? ready-state AND camera are healthy
        ok_code, ok_body = ctrl.handle_startup_handshake(operator_confirmed=True)
        self.assertEqual(ok_code, 200, ok_body)
        self.assertTrue(ok_body["watchdog_initialized"])
        self.assertTrue(ok_body["camera_healthy"])
        self.assertTrue(ok_body["navigation_dispatch_unlocked"])

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


if __name__ == "__main__":
    unittest.main()
