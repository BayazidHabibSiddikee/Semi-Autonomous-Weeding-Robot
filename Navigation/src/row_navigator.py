"""
Row-following navigation for field traversal.
Handles: move along row → detect row end → turn → enter next row.
"""
import time
import math


class RowNavigator:
    """Navigate through crop rows in a field."""

    def __init__(self, rover, ultrasonic, config):
        self.rover = rover
        self.ultrasonic = ultrasonic
        self.row_width_cm = config["rover"]["navigation"]["row_width_cm"]
        self.step_cm = config["rover"]["navigation"]["step_forward_cm"]
        self.row_end_threshold = config["rover"]["navigation"]["row_end_threshold"]
        self.current_row = 0
        self.rows_completed = 0
        self.cross_dir = 1  # +1 = move toward increasing Y at row ends

    def move_forward_one_step(self):
        """Move forward one step along the current row."""
        self.rover.forward(duration_ms=500)
        return True

    def check_row_end(self):
        """
        Check if we've reached the end of the current row.
        Ultrasonic pointing forward: large reading = open space = row end.
        """
        dist = self.ultrasonic.read_distance_mm()
        if dist < 0:
            return False
        return dist > self.row_end_threshold

    def turn_to_next_row(self):
        """
        Execute row-end turn:
        1. Rotate 90° right (face across rows)
        2. Move forward one row width
        3. Rotate 90° right again (face new row direction)
        """
        print(f"Row end — turning to row {self.current_row + 1}")

        # serpentine: turn so the crossing move goes in cross_dir; when the
        # field boundary blocks further lane shifts, reverse direction
        if self.cross_dir > 0:
            turn = self.rover.rotate_right if self.current_row % 2 == 0 \
                else self.rover.rotate_left
        else:
            turn = self.rover.rotate_left if self.current_row % 2 == 0 \
                else self.rover.rotate_right

        # turn to face across the rows
        turn(90)
        time.sleep(0.3)

        # move across one row width — use real displacement when the rover
        # can report its position, else fall back to configured step distance
        if hasattr(self.rover, "get_position"):
            sx, sy, _ = self.rover.get_position()
            last = (sx, sy)
            while True:
                self.rover.forward(duration_ms=500)
                time.sleep(0.1)
                cx, cy, _ = self.rover.get_position()
                if math.hypot(cx - sx, cy - sy) >= self.row_width_cm:
                    break
                if math.hypot(cx - last[0], cy - last[1]) < 0.5:
                    self.cross_dir *= -1  # boundary reached — sweep back
                    break
                last = (cx, cy)
        else:
            steps = max(1, self.row_width_cm // self.step_cm)
            for _ in range(steps):
                self.rover.forward(duration_ms=500)
                time.sleep(0.1)

        # turn again to face along the new row
        turn(90)
        time.sleep(0.3)

        # drive into the new row so the forward sensor clears the field edge
        # (otherwise the row-end check immediately re-triggers)
        if hasattr(self.rover, "get_position"):
            sx, sy, _ = self.rover.get_position()
            last = (sx, sy)
            while True:
                self.rover.forward(duration_ms=500)
                time.sleep(0.1)
                cx, cy, _ = self.rover.get_position()
                if math.hypot(cx - sx, cy - sy) >= self.step_cm:
                    break
                if math.hypot(cx - last[0], cy - last[1]) < 0.5:
                    break  # clamped at field boundary
                last = (cx, cy)
        else:
            self.rover.forward(duration_ms=500)

        self.current_row += 1
        self.rows_completed += 1
        print(f"Now on row {self.current_row}")

    def get_status(self):
        return {
            "current_row": self.current_row,
            "rows_completed": self.rows_completed,
        }
