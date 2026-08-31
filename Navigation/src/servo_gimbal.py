"""
Pan-tilt servo gimbal for aiming the laser at detected weeds.
Sends servo angle commands to ESP32 over serial.
"""
import time


class ServoGimbal:
    """Control pan/tilt servos via ESP32 serial."""

    def __init__(self, esp32_bridge, pan_range=(0, 180), tilt_range=(30, 90),
                 pan_center=90, tilt_center=60, settle_ms=300):
        self.bridge = esp32_bridge
        self.pan_range = pan_range
        self.tilt_range = tilt_range
        self.pan_center = pan_center
        self.tilt_center = tilt_center
        self.settle_ms = settle_ms
        self.current_pan = pan_center
        self.current_tilt = tilt_center

    def move_to(self, pan_deg, tilt_deg):
        """Move servos to absolute angles."""
        pan_deg = max(self.pan_range[0], min(self.pan_range[1], pan_deg))
        tilt_deg = max(self.tilt_range[0], min(self.tilt_range[1], tilt_deg))

        self.bridge.send(f"SERVO PAN {int(pan_deg)}")
        self.bridge.send(f"SERVO TILT {int(tilt_deg)}")
        self.current_pan = pan_deg
        self.current_tilt = tilt_deg
        time.sleep(self.settle_ms / 1000.0)

    def center(self):
        """Return servos to center position."""
        self.move_to(self.pan_center, self.tilt_center)

    def aim_at_pixel(self, u, v, frame_w, frame_h, camera_height_mm=500):
        """
        Convert pixel (u,v) to servo angles.
        Simple proportional mapping: center pixel = center servo angle.
        """
        # normalize pixel to -1..1 range from center
        dx = (u - frame_w / 2) / (frame_w / 2)   # -1 (left) to +1 (right)
        dy = (v - frame_h / 2) / (frame_h / 2)    # -1 (top) to +1 (bottom)

        # map to servo range
        pan_half = (self.pan_range[1] - self.pan_range[0]) / 2
        tilt_half = (self.tilt_range[1] - self.tilt_range[0]) / 2

        pan_deg = self.pan_center + dx * pan_half * 0.8  # 80% of range for safety margin
        tilt_deg = self.tilt_center + dy * tilt_half * 0.5  # less tilt sensitivity

        self.move_to(pan_deg, tilt_deg)
        return pan_deg, tilt_deg

    def get_angles(self):
        """Return current (pan, tilt) in degrees."""
        return self.current_pan, self.current_tilt


class ServoGimbalSimulator:
    """Simulator for testing."""

    def __init__(self, **kwargs):
        self.pan_center = kwargs.get("pan_center", 90)
        self.tilt_center = kwargs.get("tilt_center", 60)
        self.current_pan = self.pan_center
        self.current_tilt = self.tilt_center

    def move_to(self, pan_deg, tilt_deg):
        self.current_pan = pan_deg
        self.current_tilt = tilt_deg
        print(f"[SIM] Gimbal → pan={pan_deg:.1f}° tilt={tilt_deg:.1f}°")

    def center(self):
        self.move_to(self.pan_center, self.tilt_center)

    def aim_at_pixel(self, u, v, frame_w, frame_h, **kwargs):
        pan_half = 90 * 0.8
        tilt_half = 30 * 0.5
        dx = (u - frame_w / 2) / (frame_w / 2)
        dy = (v - frame_h / 2) / (frame_h / 2)
        pan = self.pan_center + dx * pan_half
        tilt = self.tilt_center + dy * tilt_half
        self.move_to(pan, tilt)
        return pan, tilt

    def get_angles(self):
        return self.current_pan, self.current_tilt
