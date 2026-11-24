import unittest

from simpla_bot.maixsense_perception import (
    build_synthetic_getdeep_packet,
    parse_getdeep_packet,
)


class MaixSensePacketTests(unittest.TestCase):
    def test_round_trip_depth_frame(self):
        width, height = 16, 12
        values = [400 + (i % 200) for i in range(width * height)]
        packet = build_synthetic_getdeep_packet(
            values, width=width, height=height, frame_id=42, stamp_msec=1234
        )
        self.assertEqual(len(packet), 36 + (width * height * 5))
        frame = parse_getdeep_packet(packet, width, height)
        self.assertEqual(frame.frame_id, 42)
        self.assertEqual(frame.stamp_msec, 1234)
        self.assertEqual(frame.depth_width, width)
        self.assertEqual(frame.depth_height, height)
        self.assertEqual(frame.depth_mm, values)

    def test_a075v_default_depth_geometry(self):
        width, height = 320, 240
        packet = build_synthetic_getdeep_packet([900] * (width * height))
        frame = parse_getdeep_packet(packet)
        self.assertEqual((frame.depth_width, frame.depth_height), (320, 240))
        self.assertEqual(len(frame.depth_mm), 320 * 240)

    def test_rgb_jpeg_is_read_after_depth_ir_and_status(self):
        width, height = 8, 8
        jpeg = b"\xff\xd8test-jpeg\xff\xd9"
        packet = build_synthetic_getdeep_packet(
            [750] * (width * height), width, height, rgb_jpeg=jpeg
        )
        frame = parse_getdeep_packet(packet, width, height)
        self.assertEqual(frame.rgb_jpeg, jpeg)

    def test_default_configuration_uses_16_bit_depth(self):
        from simpla_bot.maixsense_perception import build_set_cfg_payload
        config = build_set_cfg_payload()
        self.assertEqual(len(config), 12)
        self.assertEqual(config[1], 0)

    def test_rejects_short_header(self):
        with self.assertRaisesRegex(ValueError, "packet too short"):
            parse_getdeep_packet(b"short")

    def test_rejects_truncated_depth_payload(self):
        packet = build_synthetic_getdeep_packet([500] * (8 * 8), 8, 8)
        with self.assertRaisesRegex(ValueError, "Truncated MaixSense payload"):
            parse_getdeep_packet(packet[:60], 8, 8)


if __name__ == "__main__":
    unittest.main()
