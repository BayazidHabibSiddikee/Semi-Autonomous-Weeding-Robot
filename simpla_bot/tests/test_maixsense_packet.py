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
        frame = parse_getdeep_packet(packet, width, height)
        self.assertEqual(frame.frame_id, 42)
        self.assertEqual(frame.stamp_msec, 1234)
        self.assertEqual(frame.depth_width, width)
        self.assertEqual(frame.depth_height, height)
        self.assertEqual(frame.depth_mm, values)

    def test_rejects_short_header(self):
        with self.assertRaisesRegex(ValueError, "packet too short"):
            parse_getdeep_packet(b"short")

    def test_rejects_truncated_depth_payload(self):
        packet = build_synthetic_getdeep_packet([500] * (8 * 8), 8, 8)
        with self.assertRaisesRegex(ValueError, "Truncated depth payload"):
            parse_getdeep_packet(packet[:60], 8, 8)


if __name__ == "__main__":
    unittest.main()
