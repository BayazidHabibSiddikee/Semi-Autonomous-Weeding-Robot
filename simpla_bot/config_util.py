"""
Zero-dependency configuration loader for simpla_bot/config.yaml.

Uses PyYAML if installed, otherwise falls back to a clean stdlib parser that
supports nested mappings, strings, booleans, ints, floats, and '#' comments.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict


def _parse_scalar(raw: str) -> Any:
    val = raw.strip()
    if not val:
        return ""
    if (val.startswith('"') and val.endswith('"')) or (
        val.startswith("'") and val.endswith("'")
    ):
        return val[1:-1]
    lower = val.lower()
    if lower == "true":
        return True
    if lower == "false":
        return False
    if lower in ("null", "none", "~"):
        return None
    try:
        if "." in val or "e" in lower:
            return float(val)
        return int(val)
    except ValueError:
        return val


def _strip_inline_comment(line: str) -> str:
    in_single = False
    in_double = False
    for idx, ch in enumerate(line):
        if ch == "'" and not in_double:
            in_single = not in_single
        elif ch == '"' and not in_single:
            in_double = not in_double
        elif ch == "#" and not in_single and not in_double:
            return line[:idx]
    return line


def parse_simple_yaml(text: str) -> Dict[str, Any]:
    """Parse indentation-based key: value YAML documents using stdlib only."""
    root: Dict[str, Any] = {}
    stack: list[tuple[int, Dict[str, Any]]] = [(-1, root)]

    for raw_line in text.splitlines():
        cleaned = _strip_inline_comment(raw_line).rstrip()
        if not cleaned.strip():
            continue

        indent = len(cleaned) - len(cleaned.lstrip(" "))
        stripped = cleaned.lstrip(" ")
        if ":" not in stripped:
            continue

        key_part, val_part = stripped.split(":", 1)
        key = key_part.strip()
        val_str = val_part.strip()

        while len(stack) > 1 and indent <= stack[-1][0]:
            stack.pop()
        current_map = stack[-1][1]

        if val_str == "":
            nested: Dict[str, Any] = {}
            current_map[key] = nested
            stack.append((indent, nested))
        else:
            current_map[key] = _parse_scalar(val_str)

    return root


def load_config(config_path: str | Path | None = None) -> Dict[str, Any]:
    """Load simpla_bot YAML configuration file."""
    path = Path(config_path) if config_path else Path(__file__).with_name("config.yaml")
    text = path.read_text(encoding="utf-8")
    try:
        import yaml  # type: ignore

        loaded = yaml.safe_load(text)
        if isinstance(loaded, dict):
            return loaded
    except Exception:
        pass
    return parse_simple_yaml(text)
