"""
Row-following navigation for field traversal.
Handles: move along row → detect row end → turn → enter next row.
"""
import time


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

        # turn right to face perpendicular
        self.rover.rotate_right(90)
        time.sleep(0.3)

        # move across one row width
        steps = self.row_width_cm // self.step_cm
        for _ in range(steps):
            self.rover.forward(duration_ms=500)
            time.sleep(0.1)

        # turn right again to face new row
        self.rover.rotate_right(90)
        time.sleep(0.3)

        self.current_row += 1
        self.rows_completed += 1
        print(f"Now on row {self.current_row}")

    def get_status(self):
        return {
            "current_row": self.current_row,
            "rows_completed": self.rows_completed,
        }
