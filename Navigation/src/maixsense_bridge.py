#!/usr/bin/env python3
"""
Sipeed MaixSense-A075V / MaixSense ToF+RGB Camera
Drive & USB-RNDIS Discovery + Live Hardware Check + Web Console Bridge

Fixes & Capabilities:
  1. Scans mounted USB drives (Windows D:-Z:, Linux /media|/run/media|/mnt, macOS /Volumes)
     and USB RNDIS network adapters (192.168.233.x) to resolve the MaixSense IP (default 192.168.233.1).
  2. Sends the official Sipeed MaixSense-A075V binary POST /set_cfg packet
     (struct.pack("<BBBBBBBBi", ...)) to enable continuous trigger + 16-bit depth + RGB JPEG!
  3. Parses the official /getdeep frame header & payload (RGB JPEG + ToF Depth map).
  4. If the module streams Depth-only (no embedded RGB JPEG), renders a colorized ToF Depth PNG
     using Python stdlib zlib so live video ALWAYS appears in the web console.
  5. Streams live frames + ToF depth telemetry over WebSocket (/ws/camera) with auto-reconnect.

Usage:
  # Check drive, resolve IP, configure RGB+Depth, and verify live frames (stdlib only):
  python maixsense_bridge.py --check-only

  # Stream live MaixSense video + ToF depth to the web console:
  pip install websocket-client
  python maixsense_bridge.py --ws wss://<your-app-host>/ws/camera --room rover-01
"""

from __future__ import annotations

import argparse
import ctypes
import json
import platform
import re
import select
import socket
import string
import struct
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import zlib
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

DEFAULT_MAIXSENSE_IP = "192.168.233.1"
IPV4_RE = re.compile(r"\b((?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3})\b")
MAIX_KEYWORDS = ("maixsense", "sipeed", "a075", "a010", "ms-a075", "rndis", "tof")
TEXT_EXTS = {".txt", ".url", ".html", ".htm", ".ini", ".cfg", ".conf", ".json", ".md", ".yaml", ".yml"}


def frame_config_encode(
    trigger_mode: int = 1,
    deep_mode: int = 1,
    deep_shift: int = 255,
    ir_mode: int = 0,
    status_mode: int = 2,
    status_mask: int = 7,
    rgb_mode: int = 1,
    rgb_res: int = 0,
    expose_time: int = 0,
) -> bytes:
    """
    Official Sipeed MaixSense-A075V /set_cfg binary configuration payload:
      trigger_mode=1 (continuous), deep_mode=1 (16-bit depth), rgb_mode=1 (RGB JPEG enabled),
      rgb_res=0 (default resolution), expose_time=0 (auto exposure).
    """
    return struct.pack(
        "<BBBBBBBBi",
        trigger_mode,
        deep_mode,
        deep_shift,
        ir_mode,
        status_mode,
        status_mask,
        rgb_mode,
        rgb_res,
        expose_time,
    )


def _encode_rgb_png(width: int, height: int, rgb_bytes: bytes) -> bytes:
    """Minimal pure-Python stdlib PNG encoder for fallback ToF depth visualization."""
    def _chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack("!I", len(data)) + tag + data + struct.pack("!I", crc)

    stride = width * 3
    raw = bytearray()
    for y in range(height):
        raw.append(0)  # filter type 0
        row_start = y * stride
        raw.extend(rgb_bytes[row_start : row_start + stride])

    ihdr = struct.pack("!IIBBBBB", width, height, 8, 2, 0, 0, 0)
    idat = zlib.compress(bytes(raw), level=4)
    return b"\x89PNG\r\n\x1a\n" + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", idat) + _chunk(b"IEND", b"")


def _render_depth_png(depth_vals: Tuple[int, ...], width: int = 160, height: int = 120) -> Optional[bytes]:
    """Render uint16 millimeter ToF depth values to a clean emerald/amber heatmap PNG."""
    total = len(depth_vals)
    if total < 64:
        return None
    # Auto-detect common MaixSense resolutions (320x240, 160x120, 100x100)
    if total >= 320 * 240:
        src_w, src_h = 320, 240
    elif total >= 160 * 120:
        src_w, src_h = 160, 120
    elif total >= 100 * 100:
        src_w, src_h = 100, 100
    else:
        side = int(total ** 0.5)
        if side < 8:
            return None
        src_w, src_h = side, side

    out_w, out_h = min(160, src_w), min(120, src_h)
    rgb = bytearray(out_w * out_h * 3)
    p = 0
    for y in range(out_h):
        sy = (y * src_h) // out_h
        row_off = sy * src_w
        for x in range(out_w):
            sx = (x * src_w) // out_w
            d = depth_vals[row_off + sx]
            if d < 80 or d > 4500:
                rgb[p] = 18
                rgb[p + 1] = 28
                rgb[p + 2] = 24
            else:
                # Near = warm amber/red, Mid = emerald, Far = deep teal
                norm = min(1.0, max(0.0, (d - 150.0) / 2600.0))
                if norm < 0.35:
                    t = norm / 0.35
                    r = int(235 - 70 * t)
                    g = int(100 + 115 * t)
                    b = int(40 + 40 * t)
                else:
                    t = (norm - 0.35) / 0.65
                    r = int(165 * (1.0 - t) + 12 * t)
                    g = int(215 * (1.0 - t * 0.45))
                    b = int(80 + 100 * t)
                rgb[p] = r
                rgb[p + 1] = g
                rgb[p + 2] = b
            p += 3
    return _encode_rgb_png(out_w, out_h, bytes(rgb))


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
            raw_output = subprocess.check_output(["ipconfig"], text=True, errors="ignore", timeout=4)
        elif system == "Darwin":
            raw_output = subprocess.check_output(["ifconfig"], text=True, errors="ignore", timeout=4)
        else:
            raw_output = subprocess.check_output(["ip", "-4", "addr"], text=True, errors="ignore", timeout=4)
    except Exception:
        raw_output = ""

    rndis_ips = [ip for ip in IPV4_RE.findall(raw_output) if ip.startswith("192.168.233.")]
    gateway_ip: Optional[str] = None
    interface_hint: Optional[str] = None

    if rndis_ips:
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
    Send the official Sipeed MaixSense-A075V binary POST /set_cfg packet to ensure
    continuous triggering (trigger_mode=1), 16-bit depth (deep_mode=1), and RGB JPEG (rgb_mode=1).
    """
    cfg_payload = frame_config_encode(
        trigger_mode=1,
        deep_mode=1,
        deep_shift=255,
        ir_mode=0,
        status_mode=2,
        status_mask=7,
        rgb_mode=1,
        rgb_res=0,
        expose_time=0,
    )
    try:
        req = urllib.request.Request(
            f"http://{ip}:{port}/set_cfg",
            data=cfg_payload,
            method="POST",
            headers={
                "Content-Type": "application/octet-stream",
                "User-Agent": "WeedingRover-MaixSenseBridge/2.0",
            },
        )
        with urllib.request.urlopen(req, timeout=2.0) as resp:
            if resp.status == 200:
                time.sleep(0.15)
                return True
    except Exception:
        pass
    return False


def perform_hardware_power_cycle(ip: str, port: int = 80, power_off_sec: float = 1.5) -> bool:
    """
    Execute a lower-level hardware power-cycle on the local MaixSense device:
      1. Halt active sensor capture (trigger_mode=0 via POST /set_cfg) and send /reboot if supported.
      2. On Linux hosts with sysfs permission, toggle /sys/bus/usb/devices/<dev>/authorized 0 -> 1
         to force a full USB bus power/enumeration cycle.
      3. Wait for re-enumeration and send official cold POST /set_cfg to re-enable RGB+ToF.
    """
    print(f"[hard-reset] Starting lower-level power-cycle sequence for MaixSense ({ip}:{port})...")
    # Step 1: Stop trigger mode cleanly
    stop_payload = frame_config_encode(0, 0, 255, 0, 2, 7, 0, 0, 0)
    try:
        req = urllib.request.Request(
            f"http://{ip}:{port}/set_cfg",
            data=stop_payload,
            method="POST",
            headers={"Content-Type": "application/octet-stream"},
        )
        with urllib.request.urlopen(req, timeout=1.2):
            pass
    except Exception:
        pass

    try:
        with urllib.request.urlopen(f"http://{ip}:{port}/reboot", timeout=1.0):
            pass
    except Exception:
        pass

    # Step 2: Linux USB sysfs power/authorization cycle (no shell execution)
    usb_cycled = False
    if platform.system() == "Linux":
        usb_base = Path("/sys/bus/usb/devices")
        if usb_base.exists():
            maix_vendors = {"1f3a", "0525", "359f"}
            maix_tokens = ("maixsense", "sipeed", "rndis", "allwinner", "a075")
            for dev in usb_base.iterdir():
                if not re.match(r"^[0-9]+-[0-9]+(?:\.[0-9]+)*$", dev.name):
                    continue
                try:
                    vid = (dev / "idVendor").read_text(encoding="utf-8", errors="ignore").strip().lower() if (dev / "idVendor").exists() else ""
                    prod = (dev / "product").read_text(encoding="utf-8", errors="ignore").strip().lower() if (dev / "product").exists() else ""
                    mfg = (dev / "manufacturer").read_text(encoding="utf-8", errors="ignore").strip().lower() if (dev / "manufacturer").exists() else ""
                    if vid in maix_vendors or any(tok in f"{prod} {mfg}" for tok in maix_tokens):
                        auth_file = dev / "authorized"
                        if auth_file.exists():
                            print(f"[hard-reset] Cycling USB sysfs device {dev.name} ({vid} {prod})...")
                            auth_file.write_text("0", encoding="utf-8")
                            time.sleep(max(0.8, min(3.0, power_off_sec)))
                            auth_file.write_text("1", encoding="utf-8")
                            usb_cycled = True
                            time.sleep(2.0)
                            break
                except OSError as exc:
                    print(f"[hard-reset] USB sysfs toggle skipped ({exc}); using firmware reset.")
                    break

    if not usb_cycled:
        time.sleep(0.8)

    # Step 3: Cold re-initialize RGB JPEG + 16-bit ToF depth
    ok = configure_maixsense_rgb_depth(ip, port)
    print(f"[hard-reset] Power-cycle sequence finished (usb_cycled={usb_cycled}, set_cfg_ok={ok}).")
    return usb_cycled or ok


def parse_maixsense_getdeep(payload: bytes) -> Dict[str, Any]:
    """
    Parse Sipeed MaixSense-A075V /getdeep binary payload:
      - Bytes 0..16  : frameid (uint64), stamp_msec (uint64)
      - Bytes 16..28 : frame_config (12 bytes <BBBBBBBBi)
      - Bytes 28..44 : deep_data_size, rgb_data_size, ir_data_size, status_data_size (4 x int32)
      - Bytes 44..   : [depth_bytes][rgb_jpeg_bytes][ir_bytes][status_bytes]
    Includes fallback JPEG SOI/EOI scanning AND depth-to-PNG visualization if RGB JPEG is absent.
    """
    total_len = len(payload)
    frame_id = 0
    stamp_msec = 0
    deep_size = 0
    rgb_size = 0
    depth_start = 44

    if total_len >= 44:
        try:
            fid, ts = struct.unpack_from("<QQ", payload, 0)
            s_deep, s_rgb, _s_ir, _s_stat = struct.unpack_from("<iiii", payload, 28)
            if 0 <= s_deep <= total_len and 0 <= s_rgb <= total_len and (44 + s_deep + s_rgb) <= total_len + 64:
                frame_id = int(fid)
                stamp_msec = int(ts)
                deep_size = max(0, int(s_deep))
                rgb_size = max(0, int(s_rgb))
                depth_start = 44
        except struct.error:
            pass

    # Extract embedded RGB JPEG (either by exact offset or universal SOI..EOI scan)
    image_bytes: Optional[bytes] = None
    image_format = "none"

    if rgb_size > 128 and (depth_start + deep_size + rgb_size) <= total_len:
        candidate = payload[depth_start + deep_size : depth_start + deep_size + rgb_size]
        if candidate.startswith(b"\xff\xd8"):
            image_bytes = candidate
            image_format = "rgb_jpeg"

    if image_bytes is None:
        soi = payload.find(b"\xff\xd8\xff")
        if soi != -1:
            eoi = payload.rfind(b"\xff\xd9")
            if eoi > soi + 2:
                image_bytes = payload[soi : eoi + 2]
                rgb_size = len(image_bytes)
                image_format = "rgb_jpeg"

    # Parse 16-bit ToF depth block (millimeters)
    center_depth_mm: Optional[int] = None
    min_depth_mm: Optional[int] = None
    max_depth_mm: Optional[int] = None
    depth_vals: Tuple[int, ...] = ()

    soi_pos = payload.find(b"\xff\xd8\xff")
    if deep_size > 64 and depth_start + deep_size <= total_len:
        depth_slice = payload[depth_start : depth_start + deep_size]
    elif soi_pos > 44 + 64:
        depth_slice = payload[44:soi_pos]
    elif total_len > 44 + 64 and image_bytes is None:
        depth_slice = payload[44:]
    else:
        depth_slice = b""

    usable_len = (len(depth_slice) // 2) * 2
    if usable_len >= 64:
        depth_vals = struct.unpack(f"<{usable_len // 2}H", depth_slice[:usable_len])
        valid = [v for v in depth_vals[::8] if 80 <= v <= 4500]
        if valid:
            min_depth_mm = min(valid)
            max_depth_mm = max(valid)
            mid = len(depth_vals) // 2
            center_win = [v for v in depth_vals[max(0, mid - 12) : min(len(depth_vals), mid + 12)] if 80 <= v <= 4500]
            center_depth_mm = (
                int(sum(center_win) / len(center_win))
                if center_win
                else int(sum(valid) / len(valid))
            )

    # Fallback: if firmware did not include an RGB JPEG, render ToF depth map to PNG so video ALWAYS displays!
    if image_bytes is None and depth_vals:
        png = _render_depth_png(depth_vals)
        if png:
            image_bytes = png
            image_format = "tof_depth_png"

    return {
        "total_bytes": total_len,
        "frame_id": frame_id,
        "stamp_msec": stamp_msec,
        "deep_bytes": len(depth_slice),
        "rgb_bytes": rgb_size,
        "image_bytes": image_bytes,
        "image_format": image_format,
        "center_depth_mm": center_depth_mm,
        "min_depth_mm": min_depth_mm,
        "max_depth_mm": max_depth_mm,
    }


def fetch_maixsense_frame(ip: str, port: int = 80, timeout: float = 2.0) -> Dict[str, Any]:
    """Fetch one live frame from MaixSense (/getdeep, fallback to /getrgb, /capture, /jpg)."""
    last_err = ""
    for endpoint in ("/getdeep", "/getrgb", "/capture", "/jpg"):
        url = f"http://{ip}:{port}{endpoint}"
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "WeedingRover-MaixSenseBridge/2.0"},
            )
            t0 = time.perf_counter()
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                dt_ms = (time.perf_counter() - t0) * 1000.0
                parsed = parse_maixsense_getdeep(raw)
                parsed["endpoint"] = endpoint
                parsed["http_status"] = resp.status
                parsed["latency_ms"] = round(dt_ms, 1)
                if parsed["image_bytes"] or parsed["total_bytes"] > 64:
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
    print(f"[1/5] Mounted Drives Checked : {len(d['drives_checked'])}")
    if d["drive_found"]:
        print(f"      -> PASS: MaixSense drive detected at {d['drive_path']} (label={d['drive_label']})")
        if d["ip_from_drive"]:
            print(f"      -> IP extracted from drive: {d['ip_from_drive']} ({d['ip_source_file']})")
    else:
        print("      -> INFO: No dedicated MaixSense mass-storage volume found (USB RNDIS may still be active).")

    if r["rndis_found"]:
        print(f"[2/5] USB RNDIS Adapter      : PASS ({r['interface_hint']})")
    else:
        print(f"[2/5] USB RNDIS Adapter      : WARN (No 192.168.233.x host adapter found; trying {disc['ip']})")

    if not disc["http_reachable"]:
        print(f"[3/5] MaixSense HTTP Port    : FAIL (http://{disc['ip']}:{port} did not respond)")
        print("\nTroubleshooting:")
        print("  - Verify the USB-C data cable is plugged into MaixSense (not power-only).")
        print("  - Wait ~8 seconds for MaixSense Linux + RNDIS gadget to boot.")
        print("  - On Windows, ensure 'USB Ethernet/RNDIS Gadget' has a 192.168.233.x address.")
        return disc

    print(f"[3/5] MaixSense HTTP Port    : PASS (http://{disc['ip']}:{port} via {disc['ip_source']})")
    cfg_ok = configure_maixsense_rgb_depth(disc["ip"], port)
    print(f"[4/5] POST /set_cfg RGB+ToF  : {'PASS (RGB JPEG + 16-bit Depth enabled)' if cfg_ok else 'INFO (Using device current config)'}")

    try:
        frame = fetch_maixsense_frame(disc["ip"], port, timeout=2.5)
        img_len = len(frame["image_bytes"]) if frame["image_bytes"] else 0
        print(
            f"[5/5] Live Frame Payload     : PASS ({frame['endpoint']}, {frame['total_bytes']} B, "
            f"{frame['latency_ms']} ms, Video={frame['image_format']} ({img_len} B), "
            f"Center Depth={frame['center_depth_mm']} mm, Min Depth={frame['min_depth_mm']} mm)"
        )
        disc["sample_frame"] = {k: v for k, v in frame.items() if k != "image_bytes"}
    except Exception as exc:
        print(f"[5/5] Live Frame Payload     : FAIL ({exc})")

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

    min_interval = 1.0 / max(1.0, min(20.0, target_fps))
    frame_counter = 0

    try:
        while True:
            ws = None
            try:
                print(f"\nConnecting live MaixSense bridge -> {full_ws_url}")
                ws = websocket.create_connection(full_ws_url, timeout=10)
                print("Connected! Streaming live MaixSense frames & ToF depth telemetry. Press Ctrl+C to stop.")

                fps_t0 = time.perf_counter()
                fps_frames = 0
                measured_fps = 0.0
                consecutive_empty = 0

                while True:
                    t_loop = time.perf_counter()

                    # Check for remote diagnostic/hard-reset control signals from Hardware Audit view
                    try:
                        if ws.sock is not None:
                            readable, _, _ = select.select([ws.sock], [], [], 0.0)
                            if readable:
                                raw_ctrl = ws.recv()
                                if isinstance(raw_ctrl, str):
                                    if "maixsense:hard_reset" in raw_ctrl:
                                        perform_hardware_power_cycle(cam_ip, port)
                                    elif "maixsense:reconnect" in raw_ctrl:
                                        print(f"[diag] Received force-reconnect command -> re-initializing POST /set_cfg on {cam_ip}:{port}")
                                        configure_maixsense_rgb_depth(cam_ip, port)
                    except Exception:
                        pass

                    try:
                        frame = fetch_maixsense_frame(cam_ip, port, timeout=2.0)
                    except Exception as exc:
                        print(f"[warn] Frame grab failed: {exc}")
                        time.sleep(0.4)
                        continue

                    img_bytes = frame.get("image_bytes")
                    if not img_bytes:
                        consecutive_empty += 1
                        if consecutive_empty % 10 == 1:
                            configure_maixsense_rgb_depth(cam_ip, port)
                        time.sleep(0.15)
                        continue

                    consecutive_empty = 0
                    frame_counter += 1
                    fps_frames += 1
                    dt_win = time.perf_counter() - fps_t0
                    if dt_win >= 1.0:
                        measured_fps = fps_frames / dt_win
                        fps_frames = 0
                        fps_t0 = time.perf_counter()

                    ws.send_binary(img_bytes)

                    if frame_counter == 1 or frame_counter % 3 == 0:
                        telemetry_msg = {
                            "type": "maixsense:telemetry",
                            "ip": cam_ip,
                            "ipSource": disc["ip_source"],
                            "driveFound": bool(disc["drive"]["drive_found"]),
                            "drivePath": disc["drive"]["drive_path"] or "",
                            "interfaceName": disc["rndis"]["interface_hint"] or "USB RNDIS / HTTP",
                            "endpoint": f"{frame.get('endpoint', '/getdeep')} ({frame.get('image_format', 'rgb')})",
                            "frameId": frame.get("frame_id", frame_counter),
                            "fps": round(measured_fps, 1),
                            "latencyMs": frame.get("latency_ms", 0),
                            "centerDepthMm": frame.get("center_depth_mm"),
                            "minDepthMm": frame.get("min_depth_mm"),
                            "maxDepthMm": frame.get("max_depth_mm"),
                            "rgbBytes": len(img_bytes),
                            "depthBytes": frame.get("deep_bytes", 0),
                        }
                        ws.send(json.dumps(telemetry_msg))

                    elapsed = time.perf_counter() - t_loop
                    if elapsed < min_interval:
                        time.sleep(min_interval - elapsed)
            except KeyboardInterrupt:
                raise
            except Exception as ws_err:
                print(f"[warn] WebSocket connection interrupted ({ws_err}). Reconnecting in 2s...")
                time.sleep(2.0)
            finally:
                if ws is not None:
                    try:
                        ws.close()
                    except Exception:
                        pass
    except KeyboardInterrupt:
        print("\nStopping MaixSense bridge.")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Discover MaixSense camera via USB drive & RNDIS IP, configure RGB+Depth, and stream to web console."
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
