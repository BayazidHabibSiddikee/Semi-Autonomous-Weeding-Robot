"""
Comprehensive Test Suite for Simpla Bot (branch: simpla_bot).

Verifies:
  - MaixSense-A075V binary packet encoding/decoding (/set_cfg & /getdeep)
  - Spatial perception: distance-to-go, LEFT/RIGHT corners, DEAD_END, HEADLAND,
    obstacle stopping, corridor centering, and weed-to-tool mm projection
  - Normal motor driver calibrated moves, pivot turns, and emergency stop
  - Flame + Grinder safety interlocks (dry_run default, stationary check,
    E-stop block, flame max burn hard cap, flame cooldown, grinder->flame flow)
  - End-to-end SimplaBotController bench mission & camera stale-frame watchdog
  - Printed PDF manual integrity (SIMPLA_BOT_MANUAL.pdf)
"""

from __future__ import annotations

import unittest
from pathlib import Path

from simpla_bot.build_manual_pdf import build_manual_pdf
from simpla_bot.config_util import load_config
from simpla_bot.maixsense_perception import (
    MaixSenseFrame,
    MaixSenseSpatialAnalyzer,
    build_set_cfg_payload,
    build_synthetic_getdeep_packet,
    parse_getdeep_packet,
)
from simpla_bot.motor_driver import NormalMotorDriver
from simpla_bot.simpla_bot_controller import (
    BenchMaixSenseSimulator,
    SimplaBotController,
)
from simpla_bot.tool_controller import FlameGrinderController


def _make_zone_frame(
    left_mm: int,
    center_mm: int,
    right_mm: int,
    width: int = 60,
    height: int = 40,
    weed_box: tuple[int, int, int, int, int] | None = None,
) -> MaixSenseFrame:
    depth = [center_mm] * (width * height)
    rgb = [(90, 70, 50)] * (width * height)
    for y in range(height):
        row = y * width
        for x in range(width):
            if x < int(width * 0.33):
                depth[row + x] = left_mm
            elif x >= int(width * 0.67):
                depth[row + x] = right_mm
            else:
                depth[row + x] = center_mm
    if weed_box is not None:
        x0, x1, y0, y1, w_depth = weed_box
        for y in range(y0, y1):
            row = y * width
            for x in range(x0, x1):
                rgb[row + x] = (20, 180, 35)
                depth[row + x] = w_depth
    return MaixSenseFrame(
        frame_id=1,
        stamp_msec=100,
        received_at=10.0,
        depth_width=width,
        depth_height=height,
        depth_mm=depth,
        rgb_pixels=rgb,
        rgb_width=width,
        rgb_height=height,
    )


class TestMaixSenseProtocolAndPerception(unittest.TestCase):
    def setUp(self) -> None:
        self.cfg = load_config()
        self.analyzer = MaixSenseSpatialAnalyzer(self.cfg)

    def test_set_cfg_and_getdeep_packet_roundtrip(self) -> None:
        cfg_bytes = build_set_cfg_payload()
        self.assertEqual(len(cfg_bytes), 12)

        w, h = 160, 120
        depth_in = [950 + (i % 10) for i in range(w * h)]
        fake_jpeg = b"\x00\x00\xff\xd8HELLO_RGB_DATA\xff\xd9\x00"
        raw = build_synthetic_getdeep_packet(
            depth_in, width=w, height=h, rgb_jpeg=fake_jpeg, frame_id=42, stamp_msec=9876
        )

        frame = parse_getdeep_packet(raw)
        self.assertEqual(frame.frame_id, 42)
        self.assertEqual(frame.stamp_msec, 9876)
        self.assertEqual(frame.depth_width, w)
        self.assertEqual(frame.depth_height, h)
        self.assertEqual(frame.depth_mm[0], 950)
        self.assertEqual(frame.depth_mm[-1], depth_in[-1])
        self.assertTrue(frame.rgb_jpeg.startswith(b"\xff\xd8"))
        self.assertTrue(frame.rgb_jpeg.endswith(b"\xff\xd9"))

    def test_straight_corridor_distance_to_go_and_centering(self) -> None:
        # Center wall 1420mm away, corner_stop_mm=520 -> 900mm to go
        # Right is further away (1100mm) than Left (700mm) -> steer right (+)
        frame = _make_zone_frame(left_mm=700, center_mm=1420, right_mm=1100)
        d = self.analyzer.analyze(frame)
        self.assertFalse(d.corner_detected)
        self.assertFalse(d.obstacle_blocked)
        self.assertAlmostEqual(d.recommended_travel_mm, 900.0, delta=5.0)
        self.assertGreater(d.steer_adjust_pct, 0.0)

    def test_left_corner_detection(self) -> None:
        frame = _make_zone_frame(left_mm=1600, center_mm=460, right_mm=620)
        d = self.analyzer.analyze(frame)
        self.assertTrue(d.corner_detected)
        self.assertEqual(d.corner_type, "LEFT_CORNER")
        self.assertEqual(d.suggested_turn, "LEFT")
        self.assertEqual(d.recommended_travel_mm, 0.0)

    def test_right_corner_detection(self) -> None:
        frame = _make_zone_frame(left_mm=600, center_mm=480, right_mm=1700)
        d = self.analyzer.analyze(frame)
        self.assertTrue(d.corner_detected)
        self.assertEqual(d.corner_type, "RIGHT_CORNER")
        self.assertEqual(d.suggested_turn, "RIGHT")

    def test_dead_end_detection(self) -> None:
        frame = _make_zone_frame(left_mm=550, center_mm=450, right_mm=580)
        d = self.analyzer.analyze(frame)
        self.assertTrue(d.corner_detected)
        self.assertEqual(d.corner_type, "DEAD_END")
        self.assertEqual(d.suggested_turn, "UTURN")

    def test_row_end_headland_detection(self) -> None:
        frame = _make_zone_frame(left_mm=2050, center_mm=2100, right_mm=2000)
        d = self.analyzer.analyze(frame)
        self.assertTrue(d.corner_detected)
        self.assertEqual(d.corner_type, "ROW_END_HEADLAND")
        self.assertEqual(d.suggested_turn, "UTURN")

    def test_obstacle_stop(self) -> None:
        frame = _make_zone_frame(left_mm=900, center_mm=260, right_mm=900)
        d = self.analyzer.analyze(frame)
        self.assertTrue(d.obstacle_blocked)

    def test_weed_detection_and_tool_projection(self) -> None:
        # Place a 10x8 green weed cluster in the lower center at slant depth 700mm
        frame = _make_zone_frame(
            left_mm=850,
            center_mm=1500,
            right_mm=850,
            weed_box=(25, 35, 22, 30, 700),
        )
        d = self.analyzer.analyze(frame)
        self.assertIsNotNone(d.weed)
        assert d.weed is not None
        self.assertGreaterEqual(d.weed.pixel_count, 60)
        self.assertAlmostEqual(d.weed.depth_mm, 700.0, delta=5.0)
        # Tool is 120mm behind camera (tool_offset_forward_mm = -120) -> dx > forward_from_cam
        self.assertGreater(d.weed.dx_to_tool_mm, d.weed.forward_from_cam_mm)


class TestMotorAndFlameGrinderSafety(unittest.TestCase):
    def setUp(self) -> None:
        self.cfg = load_config()
        self.cfg["motor_driver"]["backend"] = "sim"
        self.now = 100.0
        self.motor = NormalMotorDriver(self.cfg, sleep_fn=self._advance_clock)
        self.tools = FlameGrinderController(
            self.cfg,
            self.motor,
            arm_tools=True,
            clock_fn=lambda: self.now,
            sleep_fn=self._advance_clock,
        )

    def _advance_clock(self, dt: float) -> None:
        self.now += dt

    def test_dry_run_default_without_arm_flag(self) -> None:
        safe_tools = FlameGrinderController(
            self.cfg, self.motor, arm_tools=False, sleep_fn=lambda _s: None
        )
        self.assertTrue(safe_tools.dry_run)
        res = safe_tools.treat_weed(mode="grinder")
        self.assertTrue(res.executed)
        self.assertTrue(res.dry_run)

    def test_blocks_flame_and_grinder_while_moving(self) -> None:
        self.motor.drive(40, 40)
        res = self.tools.treat_weed(mode="both")
        self.assertFalse(res.executed)
        self.assertIn("stopped", res.reason.lower())
        self.assertFalse(self.tools.grinder_on)
        self.assertFalse(self.tools.flame_on)
        self.motor.stop()

    def test_blocks_on_estop(self) -> None:
        self.tools.trigger_software_estop("test")
        res = self.tools.treat_weed(mode="flame")
        self.assertFalse(res.executed)
        self.assertIn("e-stop", res.reason.lower())

    def test_flame_hard_cap_and_cooldown(self) -> None:
        # Request an unsafe 9.0s flame burn -> MUST be capped at max_flame_burn_s (2.5s)
        res1 = self.tools.treat_weed(mode="flame", flame_duration_s=9.0)
        self.assertTrue(res1.executed)
        self.assertLessEqual(res1.flame_ran_s, 2.55)
        self.assertFalse(self.tools.flame_on)

        # Immediately trying to fire again MUST be blocked by cooldown (3.0s)
        res2 = self.tools.treat_weed(mode="flame")
        self.assertFalse(res2.executed)
        self.assertIn("cooldown", res2.reason.lower())

        # After cooldown elapses, flame is allowed again
        self.now += 4.0
        res3 = self.tools.treat_weed(mode="both", grinder_duration_s=1.0, flame_duration_s=1.0)
        self.assertTrue(res3.executed)
        self.assertAlmostEqual(res3.grinder_ran_s, 1.0, delta=0.1)
        self.assertAlmostEqual(res3.flame_ran_s, 1.0, delta=0.1)

    def test_calibrated_move_and_turn(self) -> None:
        moved = self.motor.move_forward_mm(500.0, speed_pct=50.0)
        self.assertAlmostEqual(moved, 500.0, delta=25.0)
        self.assertTrue(self.motor.is_stopped)

        turned = self.motor.turn_angle_deg(90.0, speed_pct=50.0)
        self.assertAlmostEqual(turned, 90.0, delta=1.0)
        self.assertAlmostEqual(self.motor.heading_deg, 90.0, delta=1.0)


class TestEndToEndControllerAndManual(unittest.TestCase):
    def test_end_to_end_bench_mission(self) -> None:
        cfg = load_config()
        cfg["motor_driver"]["backend"] = "sim"
        cfg["navigation"]["max_turns"] = 2

        now = [50.0]

        def step_clock(dt: float) -> None:
            now[0] += dt

        sim_cam = BenchMaixSenseSimulator()
        motor = NormalMotorDriver(cfg, sleep_fn=step_clock)
        tools = FlameGrinderController(
            cfg,
            motor,
            arm_tools=False,
            clock_fn=lambda: now[0],
            sleep_fn=step_clock,
        )
        ctrl = SimplaBotController(
            cfg=cfg,
            frame_provider=sim_cam.fetch_frame,
            motor_driver=motor,
            tool_controller=tools,
            tool_mode="both",
            clock_fn=lambda: now[0],
            on_move_hook=sim_cam.advance_distance,
            on_turn_hook=sim_cam.reset_new_row,
        )
        stats = ctrl.run(max_steps=80)
        self.assertEqual(stats.state, "DONE")
        self.assertEqual(stats.turns_completed, 2)
        self.assertGreaterEqual(stats.weeds_treated, 1)
        self.assertGreater(stats.total_distance_mm, 1000.0)
        self.assertTrue(motor.is_stopped)

    def test_camera_timeout_watchdog_halts_safely(self) -> None:
        cfg = load_config()
        cfg["motor_driver"]["backend"] = "sim"
        now = [10.0]

        motor = NormalMotorDriver(cfg, sleep_fn=lambda _s: None)
        tools = FlameGrinderController(cfg, motor, arm_tools=False, sleep_fn=lambda _s: None)
        ctrl = SimplaBotController(
            cfg=cfg,
            frame_provider=lambda: None,
            motor_driver=motor,
            tool_controller=tools,
            clock_fn=lambda: now[0],
        )
        now[0] = 11.5  # Exceeds max_frame_age_s (1.0s)
        stats = ctrl.step()
        self.assertEqual(stats.state, "ESTOP_HALT")
        self.assertIn("timeout", stats.halt_reason.lower())
        self.assertTrue(motor.is_stopped)

    def test_manual_pdf_generated_and_valid(self) -> None:
        pdf_path = build_manual_pdf()
        self.assertTrue(Path(pdf_path).exists())
        data = Path(pdf_path).read_bytes()
        self.assertTrue(data.startswith(b"%PDF-1.4"))
        self.assertIn(b"SIMPLA BOT", data)
        self.assertIn(b"MaixSense-A075V", data)
        self.assertIn(b"xref", data)
        self.assertTrue(data.rstrip().endswith(b"%%EOF"))
        self.assertGreater(len(data), 5000)


if __name__ == "__main__":
    unittest.main()
