"""
Mission Coverage Verifier & Checkpoint Persistence (NAV-11, NAV-12).
Tracks per-row progress, completed rows, skipped segments (e.g., obstacles),
coverage percentage, unfinished rows, and supports safe Pause / Resume across
restarts via atomic JSON checkpoints.
"""

import json
import os
import time
from dataclasses import dataclass, field, asdict


@dataclass
class RowCoverageRecord:
    row_index: int
    target_length_cm: float
    covered_length_cm: float = 0.0
    skipped_segments: list[tuple[float, float]] = field(default_factory=list)
    completed: bool = False

    @property
    def coverage_pct(self) -> float:
        if self.target_length_cm <= 0.0:
            return 0.0
        return min(100.0, (self.covered_length_cm / self.target_length_cm) * 100.0)


class MissionTracker:
    """Verifies real field coverage and persists mission checkpoints."""

    def __init__(
        self,
        field_id: str,
        num_rows: int,
        row_length_cm: float,
        checkpoint_path: str | None = None,
    ):
        self.field_id = field_id
        self.num_rows = max(1, int(num_rows))
        self.row_length_cm = float(row_length_cm)
        self.checkpoint_path = checkpoint_path
        self.current_row = 0
        self.last_pose = (0.0, 0.0, 0.0)
        self.rows: list[RowCoverageRecord] = [
            RowCoverageRecord(row_index=i, target_length_cm=self.row_length_cm)
            for i in range(self.num_rows)
        ]

    def record_progress(self, row_index: int, delta_cm: float, pose: tuple[float, float, float]):
        self.current_row = row_index
        self.last_pose = pose
        if 0 <= row_index < len(self.rows) and delta_cm > 0.0:
            rec = self.rows[row_index]
            rec.covered_length_cm = min(rec.target_length_cm, rec.covered_length_cm + delta_cm)

    def mark_row_completed(self, row_index: int):
        if 0 <= row_index < len(self.rows):
            self.rows[row_index].completed = True

    def record_skipped_segment(self, row_index: int, start_cm: float, end_cm: float):
        if 0 <= row_index < len(self.rows):
            self.rows[row_index].skipped_segments.append((round(start_cm, 1), round(end_cm, 1)))

    @property
    def completed_rows(self) -> list[int]:
        return [r.row_index for r in self.rows if r.completed]

    @property
    def unfinished_rows(self) -> list[int]:
        return [r.row_index for r in self.rows if not r.completed]

    @property
    def total_coverage_pct(self) -> float:
        total_target = sum(r.target_length_cm for r in self.rows)
        if total_target <= 0.0:
            return 0.0
        total_covered = sum(r.covered_length_cm for r in self.rows)
        return min(100.0, (total_covered / total_target) * 100.0)

    def summary(self) -> dict:
        return {
            "field_id": self.field_id,
            "current_row": self.current_row,
            "completed_rows": self.completed_rows,
            "unfinished_rows": self.unfinished_rows,
            "total_coverage_pct": round(self.total_coverage_pct, 1),
            "skipped_count": sum(len(r.skipped_segments) for r in self.rows),
            "last_pose": [round(v, 2) for v in self.last_pose],
        }

    def save_checkpoint(self, path: str | None = None) -> str | None:
        target = path or self.checkpoint_path
        if not target:
            return None
        payload = {
            "saved_at": time.time(),
            "field_id": self.field_id,
            "num_rows": self.num_rows,
            "row_length_cm": self.row_length_cm,
            "current_row": self.current_row,
            "last_pose": list(self.last_pose),
            "rows": [asdict(r) for r in self.rows],
        }
        parent = os.path.dirname(target)
        if parent:
            os.makedirs(parent, exist_ok=True)
        tmp = f"{target}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
        os.replace(tmp, target)
        return target

    @classmethod
    def load_checkpoint(cls, path: str) -> "MissionTracker":
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        tracker = cls(
            field_id=data["field_id"],
            num_rows=int(data["num_rows"]),
            row_length_cm=float(data["row_length_cm"]),
            checkpoint_path=path,
        )
        tracker.current_row = int(data.get("current_row", 0))
        lp = data.get("last_pose", [0.0, 0.0, 0.0])
        tracker.last_pose = (float(lp[0]), float(lp[1]), float(lp[2]))
        tracker.rows = [
            RowCoverageRecord(
                row_index=int(r["row_index"]),
                target_length_cm=float(r["target_length_cm"]),
                covered_length_cm=float(r["covered_length_cm"]),
                skipped_segments=[tuple(seg) for seg in r.get("skipped_segments", [])],
                completed=bool(r["completed"]),
            )
            for r in data["rows"]
        ]
        return tracker
