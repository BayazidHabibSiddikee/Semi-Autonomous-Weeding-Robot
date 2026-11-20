"""
Zero-dependency fallback YAML config loader for Navigation/rover_config.yaml.
Uses PyYAML when installed, otherwise parses standard nested key: value YAML
so clean checkouts and CI unit tests run with only the Python standard library.
"""


def _parse_scalar(val: str):
    val = val.strip()
    if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
        return val[1:-1]
    low = val.lower()
    if low == "true":
        return True
    if low == "false":
        return False
    if low in ("null", "none", "~"):
        return None
    try:
        return int(val, 0)
    except ValueError:
        pass
    try:
        return float(val)
    except ValueError:
        return val


def load_yaml_config(path: str) -> dict:
    try:
        import yaml
        with open(path, "r", encoding="utf-8") as f:
            return yaml.safe_load(f)
    except ImportError:
        pass

    root: dict = {}
    stack: list[tuple[int, dict]] = [(-1, root)]

    with open(path, "r", encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.split("#", 1)[0].rstrip()
            if not line.strip():
                continue
            indent = len(line) - len(line.lstrip(" "))
            key, _, rest = line.strip().partition(":")
            key = key.strip()
            rest = rest.strip()

            while len(stack) > 1 and indent <= stack[-1][0]:
                stack.pop()

            parent = stack[-1][1]
            if rest == "":
                child: dict = {}
                parent[key] = child
                stack.append((indent, child))
            else:
                parent[key] = _parse_scalar(rest)

    return root
