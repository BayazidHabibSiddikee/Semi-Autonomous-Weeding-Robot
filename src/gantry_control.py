"""
Gantry motor control via serial (RAMPS/Mega).
Sends G-code commands to move the X/Y stepper motors.
"""
import serial
import time
import math

class GantryController:
    def __init__(self, port="/dev/ttyUSB0", baudrate=115200, timeout=1):
        self.port = port
        self.baudrate = baudrate
        self.serial = None
        self.current_x = 0.0
        self.current_y = 0.0
        self.connected = False

    def connect(self):
        """Connect to the stepper controller."""
        try:
            self.serial = serial.Serial(self.port, self.baudrate, timeout=1)
            time.sleep(2)  # wait for Arduino to reset
            self.connected = True
            print(f"Connected to {self.port}")
            # Wait for firmware ready
            self._wait_ready()
        except serial.SerialException as e:
            print(f"Cannot connect to {self.port}: {e}")
            self.connected = False

    def disconnect(self):
        """Disconnect serial."""
        if self.serial and self.serial.is_open:
            self.serial.close()
            self.connected = False
            print("Disconnected")

    def _send(self, cmd):
        """Send G-code command and wait for response."""
        if not self.connected:
            raise RuntimeError("Not connected")
        self.serial.write(f"{cmd}\n".encode())
        response = self.serial.readline().decode().strip()
        return response

    def _wait_ready(self):
        """Wait for controller to be ready."""
        self._send("M115")  # firmware info
        self._send("G28")   # home all axes
        print("Homing complete")

    def move_to(self, x_mm, y_mm, speed=3000):
        """Move to absolute position (mm)."""
        if not self.connected:
            raise RuntimeError("Not connected")
        cmd = f"G1 X{x_mm:.2f} Y{y_mm:.2f} F{speed}"
        self._send(cmd)
        self.current_x = x_mm
        self.current_y = y_mm
        # Wait for movement to complete
        dist = math.sqrt((x_mm - self.current_x)**2 + (y_mm - self.current_y)**2)
        wait_time = dist / speed * 60 + 0.1
        time.sleep(min(wait_time, 2.0))

    def move_relative(self, dx_mm, dy_mm, speed=3000):
        """Move relative to current position."""
        new_x = self.current_x + dx_mm
        new_y = self.current_y + dy_mm
        self.move_to(new_x, new_y, speed)

    def move_home(self, speed=3000):
        """Move to home position (0, 0)."""
        self._send("G28")
        self.current_x = 0.0
        self.current_y = 0.0
        time.sleep(1)

    def get_position(self):
        """Get current position from controller."""
        response = self._send("M114")
        # Parse response: "X:0.00 Y:0.00 Z:0.00 E:0.00 Count X:0 Y:0"
        try:
            parts = response.split()
            x = float(parts[0].split(":")[1])
            y = float(parts[1].split(":")[1])
            self.current_x = x
            self.current_y = y
            return x, y
        except (IndexError, ValueError):
            return self.current_x, self.current_y

    def set_speed(self, speed_mm_min):
        """Set movement speed."""
        self._send(f"G1 F{speed_mm_min}")

    def enable_steppers(self):
        """Enable stepper motors."""
        self._send("M17")

    def disable_steppers(self):
        """Disable stepper motors (free movement)."""
        self._send("M18")

    def emergency_stop(self):
        """Emergency stop all movement."""
        if self.serial and self.serial.is_open:
            self.serial.write(b"!\n")  # feed hold
            self.serial.write(b"M84\n")  # disable steppers
        print("EMERGENCY STOP")

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, *args):
        self.disconnect()


class GantrySimulator:
    """Simulator for testing without hardware."""

    def __init__(self):
        self.current_x = 0.0
        self.current_y = 0.0
        self.connected = True

    def connect(self):
        print("[SIM] Gantry connected (simulation mode)")

    def disconnect(self):
        print("[SIM] Gantry disconnected")

    def move_to(self, x_mm, y_mm, speed=3000):
        dist = math.sqrt((x_mm - self.current_x)**2 + (y_mm - self.current_y)**2)
        print(f"[SIM] Move to (X={x_mm:.1f}, Y={y_mm:.1f}) — {dist:.1f}mm")
        self.current_x = x_mm
        self.current_y = y_mm

    def move_home(self, speed=3000):
        print("[SIM] Move home")
        self.current_x = 0.0
        self.current_y = 0.0

    def get_position(self):
        return self.current_x, self.current_y

    def emergency_stop(self):
        print("[SIM] EMERGENCY STOP")

    def enable_steppers(self):
        print("[SIM] Steppers enabled")

    def disable_steppers(self):
        print("[SIM] Steppers disabled")


def create_gantry(simulate=False, **kwargs):
    """Factory function to create gantry controller."""
    if simulate:
        return GantrySimulator()
    return GantryController(**kwargs)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=str, default="/dev/ttyUSB0")
    parser.add_argument("--simulate", action="store_true")
    parser.add_argument("--test", action="store_true", help="Run movement test")
    args = parser.parse_args()

    gantry = create_gantry(simulate=args.simulate, port=args.port)
    gantry.connect()

    if args.test:
        print("\nRunning movement test...")
        gantry.move_to(100, 0)
        gantry.move_to(100, 100)
        gantry.move_to(0, 100)
        gantry.move_home()
        print("Test complete!")

    gantry.disconnect()
