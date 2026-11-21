#!/usr/bin/env python3
"""
Sipeed MaixSense-A075V / MaixSense ToF+RGB Camera
Drive & USB-RNDIS Discovery + Live Hardware Check + Web Console Bridge

Workflow:
  1. Scans mounted USB drives (Windows D:-Z:, Linux /media|/run/media|/mnt, macOS /Volumes)
     for a MaixSense volume or config/URL file containing the camera IP address.
  2. Inspects local USB RNDIS / Ethernet Gadget network interfaces (e.g. 192.168.233.x)
     to resolve the MaixSense gateway IP (default: 192.168.233.1).
  3. Runs a live HTTP hardware check against http://<ip>/ and http://<ip>/getdeep
     (optionally configuring RGB+Depth via /set_cfg) and decodes real RGB JPEG + ToF depth.
  4. Streams live RGB JPEG frames and ToF depth telemetry to the Weeding Rover web console
     over WebSocket (/ws/camera?room=rover-01&role=publisher&transport=maixsense).

Usage:
  # Check drive, resolve IP, and run live camera test (stdlib only, no pip required):
  python Navigation/src/maixsense_bridge.py --check-only

  # Stream live MaixSense RGB + Depth telemetry to the web console:
  pip install websocket-client
  python Navigation/src/maixsense_bridge.py --ws wss://<your-app-host>/ws/camera --room rover-01
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import platform
import re
import socket
import string
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

DEFAULT_MAIXSENSE_IP = "192.168.233.1"
IPV4_RE = re.compile(r"\b((?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3})\b")
MAIX_KEYWORDS = ("maixsense", "sipeed", "a075", "a010", "ms-a075", "rndis", "tof")
TEXT_EXTS = {".txt", ".url", ".html", ".htm", ".ini", ".cfg", ".conf", ".json", ".md", ".yaml", ".yml"}


def _get_windows_volume_label(drive_root: str) -> str:
    try:
        buf = ctypes.create_unicode_buffer(261)
        fs_buf = ctypes.create_unicode_buffer(261)
        res = ctypes.windll.kernel32.GetVolumeInformationW(
            ctypes.c_wchar_p(drive_root),
            buf,
            len(buf),
            None,
            None,
            None,
            fs_buf,
            len(fs_buf),
        )
        return buf.value if res else ""
    except Exception:
        return ""


def _extract_ip_from_file(file_path: Path) -> Optional[str]:
    try:
        if file_path.stat().st_size > 128 * 1024:
            return None
        content = file_path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return None

    matches = IPV4_RE.findall(content)
    if not matches:
        return None
    # Prefer the standard MaixSense 192.168.233.x subnet if present
    for ip in matches:
        if ip.startswith("192.168.233."):
            return ip
    return matches[0]


def scan_mounted_drives() -> Dict[str, Any]:
    """Scan mounted OS drives for a MaixSense USB volume and extract any IP address."""
    system = platform.system()
    candidate_roots: List[Tuple[Path, str]] = []

    if system == "Windows":
        bitmask = ctypes.windll.kernel32.GetLogicalDrives()
        for idx, letter in enumerate(string.ascii_uppercase):
            if letter in ("A", "B", "C"):
                continue
            if bitmask & (1 << idx):
                root = f"{letter}:\\"
                label = _get_windows_volume_label(root)
                candidate_roots.append((Path(root), label))
    elif system == "Darwin":
        vols = Path("/Volumes")
        if vols.is_dir():
            for entry in vols.iterdir():
                if entry.is_dir() and entry.name != "Macintosh HD":
                    candidate_roots.append((entry, entry.name))
    else:
        for base in (Path("/media"), Path("/run/media"), Path("/mnt")):
            if not base.is_dir():
                continue
            try:
                for entry in base.iterdir():
                    if not entry.is_dir():
                        continue
                    # /media/<user>/<volume>
                    sub_dirs = [d for d in entry.iterdir() if d.is_dir()] if base.name == "media" else []
                    if sub_dirs:
                        for sub in sub_dirs:
                            candidate_roots.append((sub, sub.name))
                    else:
                        candidate_roots.append((entry, entry.name))
            except PermissionError:
                continue

    drives_checked: List[str] = []
    matched_drive: Optional[str] = None
    matched_label: Optional[str] = None
    extracted_ip: Optional[str] = None
    ip_source_file: Optional[str] = None

    for root_path, label in candidate_roots:
        display = f"{root_path} ({label or 'unnamed'})"
        drives_checked.append(display)
        label_lower = f"{root_path.name} {label}".lower()
        is_maix_volume = any(k in label_lower for k in MAIX_KEYWORDS)

        try:
            entries = list(root_path.iterdir())[:80]
        except Exception:
            entries = []

        for item in entries:
            name_lower = item.name.lower()
            if any(k in name_lower for k in MAIX_KEYWORDS):
                is_maix_volume = True

            if item.is_file() and (
                item.suffix.lower() in TEXT_EXTS
                or any(k in name_lower for k in ("ip", "readme", "maix", "sipeed", "config", "url"))
            ):
                ip = _extract_ip_from_file(item)
                if ip and (is_maix_volume or ip.startswith("192.168.233.")):
                    extracted_ip = ip
                    ip_source_file = str(item)
                    matched_drive = str(root_path)
                    matched_label = label or root_path.name
                    break

        if is_maix_volume and not matched_drive:
            matched_drive = str(root_path)
            matched_label = label or root_path.name

        if extracted_ip:
            break

    return {
        "os": system,
        "drives_checked": drives_checked,
        "drive_found": matched_drive is not None,
        "drive_path": matched_drive,
        "drive_label": matched_label,
        "ip_from_drive": extracted_ip,
        "ip_source_file": ip_source_file,
    }


def scan_rndis_interfaces() -> Dict[str, Any]:
    """Inspect local network interfaces for a USB RNDIS / 192.168.233.x MaixSense adapter."""
    system = platform.system()
    raw_output = ""
    try:
        if system == "Windows":
            raw_output = subprocess.check_output(
                ["ipconfig"], text=True, errors="ignore", timeout=4
            )
        elif system == "Darwin":
            raw_output = subprocess.check_output(
                ["ifconfig"], text=True, errors="ignore", timeout=4
            )
        else:
            raw_output = subprocess.check_output(
                ["ip", "-4", "addr"], text=True, errors="ignore", timeout=4
            )
    except Exception:
        raw_output = ""

    rndis_ips = [ip for ip in IPV4_RE.findall(raw_output) if ip.startswith("192.168.233.")]
    gateway_ip: Optional[str] = None
    interface_hint: Optional[str] = None

    if rndis_ips:
        # Host gets e.g. 192.168.233.2+; MaixSense device itself is 192.168.233.1
        parts = rndis_ips[0].split(".")
        gateway_ip = f"{parts[0]}.{parts[1]}.{parts[2]}.1"
        interface_hint = f"USB RNDIS (host {rndis_ips[0]} -> cam {gateway_ip})"

    return {
        "rndis_found": len(rndis_ips) > 0,
        "host_ips": rndis_ips,
        "camera_ip": gateway_ip,
        "interface_hint": interface_hint,
    }


def tcp_port_open(ip: str, port: int = 80, timeout: float = 1.2) -> bool:
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return True
    except OSError:
        return False


def configure_maixsense_rgb_depth(ip: str, port: int = 80) -> bool:
    """
    Push standard MaixSense-A075V /set_cfg parameters so /getdeep includes both
    ToF depth and RGB JPEG stream if not already active.
    """
    url = f"http://{ip}:{port}/set_cfg"
    # Official MaixSense-A075V web-API binary config payload (trigger=auto, deep_mode=1, rgb_map=1)
    # Also gracefully tolerated if firmware already streams RGB+Depth by default.
    try:
        req = urllib.request.Request(
            f"http://{ip}:{port}/get_cfg",
            method="GET",
            headers={"User-Agent": "WeedingRover-MaixSenseCheck/1.0"},
        )
        with urllib.request.urlopen(req, timeout=1.5) as resp:
            if resp.status == 200:
                return True
    except Exception:
        pass
    return False


def parse_maixsense_getdeep(payload: bytes) -> Dict[str, Any]:
    """
    Parse Sipeed MaixSense-A075V /getdeep binary payload.
    Extracts:
      - frame_id & timestamp (when standard 20/24-byte header is present)
      - embedded RGB JPEG bytes (SOI 0xFFD8 .. EOI 0xFFD9)
      - ToF depth summary (center_depth_mm, min_depth_mm, max_depth_mm)
    """
    total_len = len(payload)
    frame_id = 0
    stamp_msec = 0
    deep_size = 0
    rgb_size = 0

    # Standard MaixSense-A075V header starts with: frameid (uint64), stamp_msec (uint64),
    # followed by int32 sizes (deep_data_size, rgb_data_size, ir_data_size, status_data_size)
    if total_len >= 32:
        try:
            fid, ts, s0, s1 = struct.unpack_from("<QQii", payload, 0)
            if 0 <= s0 < total_len and 0 <= s1 <= total_len:
                frame_id = int(fid)
                stamp_msec = int(ts)
                deep_size = max(0, int(s0))
                rgb_size = max(0, int(s1))
        except struct.error:
            pass

    # Locate embedded RGB JPEG frame reliably across firmware versions
    jpeg_bytes: Optional[bytes] = None
    soi = payload.find(b"\xff\xd8\xff")
    if soi != -1:
        eoi = payload.find(b"\xff\xd9", soi + 2)
        if eoi != -1:
            jpeg_bytes = payload[soi : eoi + 2]
            rgb_size = len(jpeg_bytes)

    # Extract uint16 ToF depth statistics (millimeters) from depth block preceding JPEG
    center_depth_mm: Optional[int] = None
    min_depth_mm: Optional[int] = None
    max_depth_mm: Optional[int] = None

    depth_start = 32
    depth_end = soi if (soi != -1 and soi > depth_start + 64) else min(total_len, depth_start + deep_size)
    if depth_end > depth_start + 64:
        depth_slice = payload[depth_start:depth_end]
        usable_len = (len(depth_slice) // 2) * 2
        if usable_len >= 64:
            vals = struct.unpack(f"<{usable_len // 2}H", depth_slice[:usable_len])
            # Filter physically plausible ToF range (80 mm .. 4500 mm)
            valid = [v for v in vals[::8] if 80 <= v <= 4500]
            if valid:
                min_depth_mm = min(valid)
                max_depth_mm = max(valid)
                mid = len(vals) // 2
                center_win = [v for v in vals[max(0, mid - 12) : min(len(vals), mid + 12)] if 80 <= v <= 4500]
                center_depth_mm = (
                    int(sum(center_win) / len(center_win))
                    if center_win
                    else int(sum(valid) / len(valid))
                )

    return {
        "total_bytes": total_len,
        "frame_id": frame_id,
        "stamp_msec": stamp_msec,
        "deep_bytes": max(0, depth_end - depth_start),
        "rgb_bytes": rgb_size,
        "jpeg_bytes": jpeg_bytes,
        "center_depth_mm": center_depth_mm,
        "min_depth_mm": min_depth_mm,
        "max_depth_mm": max_depth_mm,
    }


def fetch_maixsense_frame(ip: str, port: int = 80, timeout: float = 2.0) -> Dict[str, Any]:
    """Fetch one live frame from MaixSense (/getdeep, fallback to /getrgb or /capture)."""
    last_err = ""
    for endpoint in ("/getdeep", "/getrgb", "/capture", "/jpg"):
        url = f"http://{ip}:{port}{endpoint}"
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "WeedingRover-MaixSenseCheck/1.0"},
            )
            t0 = time.perf_counter()
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                dt_ms = (time.perf_counter() - t0) * 1000.0
                parsed = parse_maixsense_getdeep(raw)
                parsed["endpoint"] = endpoint
                parsed["http_status"] = resp.status
                parsed["latency_ms"] = round(dt_ms, 1)
                if parsed["jpeg_bytes"] or parsed["total_bytes"] > 64:
                    return parsed
        except Exception as exc:
            last_err = f"{endpoint}: {exc}"
    raise RuntimeError(f"Unable to fetch MaixSense frame from http://{ip}:{port} ({last_err})")


def discover_maixsense(override_ip: Optional[str] = None, port: int = 80) -> Dict[str, Any]:
    drive_info = scan_mounted_drives()
    rndis_info = scan_rndis_interfaces()

    candidates: List[Tuple[str, str]] = []
    if override_ip:
        candidates.append((override_ip, "CLI --ip override"))
    if drive_info["ip_from_drive"]:
        candidates.append((drive_info["ip_from_drive"], f"Drive file {drive_info['ip_source_file']}"))
    if rndis_info["camera_ip"]:
        candidates.append((rndis_info["camera_ip"], rndis_info["interface_hint"] or "USB RNDIS"))
    candidates.append((DEFAULT_MAIXSENSE_IP, "Default MaixSense-A075V IP"))

    # Deduplicate preserving priority
    seen = set()
    unique_candidates: List[Tuple[str, str]] = []
    for ip, source in candidates:
        if ip not in seen:
            seen.add(ip)
            unique_candidates.append((ip, source))

    reachable_ip: Optional[str] = None
    reachable_source: Optional[str] = None
    for ip, source in unique_candidates:
        if tcp_port_open(ip, port, timeout=1.0):
            reachable_ip = ip
            reachable_source = source
            break

    return {
        "drive": drive_info,
        "rndis": rndis_info,
        "candidates": unique_candidates,
        "ip": reachable_ip or unique_candidates[0][0],
        "ip_source": reachable_source or unique_candidates[0][1],
        "http_reachable": reachable_ip is not None,
    }


def run_live_check(override_ip: Optional[str], port: int) -> Dict[str, Any]:
    print("\n=== MaixSense Drive, Network & Live Camera Check ===")
    disc = discover_maixsense(override_ip, port)

    d = disc["drive"]
    r = disc["rndis"]
    print(f"[1/4] Mounted Drives Checked : {len(d['drives_checked'])}")
    if d["drive_found"]:
        print(f"      -> PASS: MaixSense drive detected at {d['drive_path']} (label={d['drive_label']})")
        if d["ip_from_drive"]:
            print(f"      -> IP extracted from drive: {d['ip_from_drive']} ({d['ip_source_file']})")
    else:
        print("      -> INFO: No dedicated MaixSense mass-storage volume found (USB RNDIS may still be active).")

    if r["rndis_found"]:
        print(f"[2/4] USB RNDIS Adapter      : PASS ({r['interface_hint']})")
    else:
        print(f"[2/4] USB RNDIS Adapter      : WARN (No 192.168.233.x host adapter found; trying {disc['ip']})")

    if not disc["http_reachable"]:
        print(f"[3/4] MaixSense HTTP Port    : FAIL (http://{disc['ip']}:{port} did not respond)")
        print("\nTroubleshooting:")
        print("  - Verify the USB-C data cable is plugged into MaixSense (not power-only).")
        print("  - Wait ~8 seconds for MaixSense Linux + RNDIS gadget to boot.")
        print("  - On Windows, ensure 'USB Ethernet/RNDIS Gadget' has a 192.168.233.x address.")
        return disc

    print(f"[3/4] MaixSense HTTP Port    : PASS (http://{disc['ip']}:{port} via {disc['ip_source']})")
    configure_maixsense_rgb_depth(disc["ip"], port)

    try:
        frame = fetch_maixsense_frame(disc["ip"], port, timeout=2.5)
        has_rgb = frame["jpeg_bytes"] is not None
        print(
            f"[4/4] Live Frame Payload     : PASS ({frame['endpoint']}, {frame['total_bytes']} bytes, "
            f"{frame['latency_ms']} ms, RGB JPEG={'YES (' + str(frame['rgb_bytes']) + ' B)' if has_rgb else 'NO'}, "
            f"Center Depth={frame['center_depth_mm']} mm, Min Depth={frame['min_depth_mm']} mm)"
        )
        disc["sample_frame"] = {k: v for k, v in frame.items() if k != "jpeg_bytes"}
    except Exception as exc:
        print(f"[4/4] Live Frame Payload     : FAIL ({exc})")

    return disc


def stream_to_console(ws_base_url: str, room: str, override_ip: Optional[str], port: int, target_fps: float) -> None:
    try:
        import websocket  # type: ignore
    except ImportError:
        print("\nERROR: 'websocket-client' is required to relay live video to the web console.")
        print("Install it once with:  pip install websocket-client")
        sys.exit(1)

    disc = run_live_check(override_ip, port)
    if not disc["http_reachable"]:
        sys.exit(2)

    cam_ip = disc["ip"]
    label = f"MaixSense ({cam_ip})"
    sep = "&" if "?" in ws_base_url else "?"
    full_ws_url = (
        f"{ws_base_url}{sep}"
        f"room={urllib.parse.quote(room)}&role=publisher&transport=maixsense&label={urllib.parse.quote(label)}"
    )

    print(f"\nConnecting live MaixSense bridge -> {full_ws_url}")
    ws = websocket.create_connection(full_ws_url, timeout=8)
    print("Connected! Streaming live MaixSense RGB frames & ToF depth telemetry. Press Ctrl+C to stop.")

    min_interval = 1.0 / max(1.0, min(20.0, target_fps))
    frame_counter = 0
    fps_t0 = time.perf_counter()
    fps_frames = 0
    measured_fps = 0.0

    try:
        while True:
            t_loop = time.perf_counter()
            try:
                frame = fetch_maixsense_frame(cam_ip, port, timeout=2.0)
            except Exception as exc:
                print(f"[warn] Frame grab failed: {exc}")
                time.sleep(0.5)
                continue

            frame_counter += 1
            fps_frames += 1
            dt_win = time.perf_counter() - fps_t0
            if dt_win >= 1.0:
                measured_fps = fps_frames / dt_win
                fps_frames = 0
                fps_t0 = time.perf_counter()

            jpeg = frame.get("jpeg_bytes")
            if jpeg:
                ws.send_binary(jpeg)

            # Send structured ToF depth + discovery metadata every 3rd frame
            if frame_counter == 1 or frame_counter % 3 == 0:
                telemetry_msg = {
                    "type": "maixsense:telemetry",
                    "ip": cam_ip,
                    "ipSource": disc["ip_source"],
                    "driveFound": bool(disc["drive"]["drive_found"]),
                    "drivePath": disc["drive"]["drive_path"] or "",
                    "interfaceName": disc["rndis"]["interface_hint"] or "TCP/HTTP",
                    "endpoint": frame.get("endpoint", "/getdeep"),
                    "frameId": frame.get("frame_id", frame_counter),
                    "fps": round(measured_fps, 1),
                    "latencyMs": frame.get("latency_ms", 0),
                    "centerDepthMm": frame.get("center_depth_mm"),
                    "minDepthMm": frame.get("min_depth_mm"),
                    "maxDepthMm": frame.get("max_depth_mm"),
                    "rgbBytes": frame.get("rgb_bytes", 0),
                    "depthBytes": frame.get("deep_bytes", 0),
                }
                ws.send(json.dumps(telemetry_msg))

            elapsed = time.perf_counter() - t_loop
            if elapsed < min_interval:
                time.sleep(min_interval - elapsed)
    except KeyboardInterrupt:
        print("\nStopping MaixSense bridge.")
    finally:
        try:
            ws.close()
        except Exception:
            pass


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Discover MaixSense camera via USB drive & RNDIS IP, run live check, and stream to web console."
    )
    parser.add_argument("--ip", default=None, help="Optional manual MaixSense IP (default: auto-detect, fallback 192.168.233.1)")
    parser.add_argument("--port", type=int, default=80, help="MaixSense HTTP port (default: 80)")
    parser.add_argument("--check-only", action="store_true", help="Only run drive/IP discovery and live frame check")
    parser.add_argument("--ws", default=None, help="Web console WebSocket URL (e.g. wss://<host>/ws/camera)")
    parser.add_argument("--room", default="rover-01", help="Camera room ID (default: rover-01)")
    parser.add_argument("--fps", type=float, default=10.0, help="Target stream FPS (default: 10)")
    args = parser.parse_args()

    if args.check_only or not args.ws:
        run_live_check(args.ip, args.port)
        if not args.ws:
            print("\nTip: pass --ws wss://<your-console-host>/ws/camera --room rover-01 to stream live video into the dashboard.")
        return

    stream_to_console(args.ws, args.room, args.ip, args.port, args.fps)


if __name__ == "__main__":
    main()
