#!/usr/bin/env python3
"""Small Simpla Bot phone hub: Android/Wi-Fi -> Pi -> ESP32; one MaixSense reader."""
from __future__ import annotations

import hmac
import json
import os
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from simpla_bot.config_util import load_config
from simpla_bot.simpla_bot_controller import MissionStats, create_live_controller

HOST = os.environ.get("SIMPLA_BIND_HOST", "0.0.0.0")
PORT = int(os.environ.get("SIMPLA_PORT", "8080"))
cfg = load_config()
cfg.setdefault("motor_driver", {})["backend"] = "serial"
cfg["motor_driver"]["serial_port"] = os.environ.get(
    "SIMPLA_ESP32_PORT", cfg["motor_driver"].get("serial_port", "/dev/ttyUSB0")
)
cfg.setdefault("tools", {})["dry_run"] = True
cfg["tools"]["default_mode"] = "none"

API_TOKEN = os.environ.get("SIMPLA_API_TOKEN", "").strip()
if not API_TOKEN:
    API_TOKEN = secrets.token_urlsafe(32)
    print("\nSIMPLA_API_TOKEN was not set. Copy this token into the Android Control screen:")
    print(API_TOKEN)
    print("Set SIMPLA_API_TOKEN in the service environment to keep it stable across restarts.\n")

controller, motor, tools = create_live_controller(cfg, tool_mode="none", arm_tools=False)
camera_fetch = controller.frame_provider
controller_frame_condition = threading.Condition()
latest_frame = None
last_consumed_frame_id = -1
last_camera_monotonic = 0.0

state: dict[str, Any] = {
    "mode": "manual",
    "camera_online": False,
    "esp32_serial_open": motor._serial is not None,
    "esp32_online": False,
    "esp32_estop_ok": False,
    "last_camera_frame": 0.0,
    "last_command": 0.0,
    "fault": None,
    "camera_error": None,
    "version": "pi4-maixsense-hub-2",
}
lock = threading.RLock()
auto_stop = threading.Event()
auto_stop.set()
autonomous_thread: threading.Thread | None = None
_original_estop_safe = tools.is_estop_safe
tools.is_estop_safe = lambda: _original_estop_safe() and not auto_stop.is_set()


def controller_frame_provider():
    """Return each new cached camera frame once; never access the camera transport here."""
    global last_consumed_frame_id
    deadline = time.monotonic() + float(controller.max_frame_age_s)
    with controller_frame_condition:
        while latest_frame is None or latest_frame.frame_id == last_consumed_frame_id:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            controller_frame_condition.wait(min(remaining, 0.2))
        age = time.monotonic() - last_camera_monotonic
        if age > controller.max_frame_age_s:
            return None
        last_consumed_frame_id = latest_frame.frame_id
        return latest_frame


# Exactly one worker owns the MaixSense HTTP transport. It publishes frames for
# both manual telemetry and the autonomous state machine.
controller.frame_provider = controller_frame_provider


def camera_worker() -> None:
    global latest_frame, last_camera_monotonic
    while True:
        try:
            frame = camera_fetch()
            if frame is None:
                with lock:
                    state["camera_error"] = "No valid frame from MaixSense /getdeep"
                time.sleep(0.08)
                continue
            decision = controller.analyzer.analyze(frame)
            with controller_frame_condition:
                latest_frame = frame
                last_camera_monotonic = time.monotonic()
                controller_frame_condition.notify_all()
            with lock:
                state["camera_online"] = True
                state["last_camera_frame"] = time.time()
                state["camera_error"] = None
                state["distances_mm"] = {
                    "left": decision.left_mm,
                    "center": decision.center_mm,
                    "right": decision.right_mm,
                }
                state["corner"] = decision.corner_type
                state["weed_detected"] = decision.weed is not None
                state["camera_frame_id"] = frame.frame_id
        except Exception as exc:
            with lock:
                state["camera_error"] = str(exc)
        time.sleep(0.03)


def heartbeat_worker() -> None:
    while True:
        responding = motor.ping()
        with lock:
            state["esp32_online"] = responding
            state["esp32_estop_ok"] = responding
            state["esp32_serial_open"] = motor._serial is not None
        time.sleep(0.8)


def stop_all() -> None:
    auto_stop.set()
    try:
        motor.stop()
    except Exception as exc:
        with lock:
            state["fault"] = f"Motor STOP failed: {exc}"
            state["esp32_serial_open"] = False
            state["esp32_online"] = False
    with lock:
        state["mode"] = "manual"


def autonomous_worker() -> None:
    while not auto_stop.is_set():
        with lock:
            if state["mode"] != "autonomous":
                break
        try:
            stats = controller.step(step_dt_s=0.2)
            decision = stats.last_decision
            if decision is not None:
                with lock:
                    state["last_decision_at"] = time.time()
            if stats.state in ("DONE", "ESTOP_HALT"):
                with lock:
                    state["fault"] = stats.halt_reason or stats.state
                    state["mode"] = "manual"
                try:
                    motor.stop()
                except Exception:
                    pass
                auto_stop.set()
                break
        except Exception as exc:
            with lock:
                state["fault"] = f"Autonomy error: {exc}"
                state["mode"] = "manual"
            auto_stop.set()
            try:
                motor.stop()
            except Exception:
                pass
            break
        time.sleep(0.02)


def watchdog_worker() -> None:
    while True:
        time.sleep(0.08)
        with lock:
            should_stop = (
                state["mode"] == "manual"
                and motor.is_moving
                and time.monotonic() - state["last_command"] > 0.45
            )
        if should_stop:
            try:
                motor.stop()
            except Exception as exc:
                with lock:
                    state["fault"] = f"Pi command watchdog STOP failed: {exc}"
                    state["esp32_online"] = False


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_: Any) -> None:
        pass

    def send_json(self, code: int, payload: dict[str, Any]) -> None:
        raw = json.dumps(payload, allow_nan=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def authorized(self) -> bool:
        supplied = self.headers.get("Authorization", "")
        expected = "Bearer " + API_TOKEN
        if not hmac.compare_digest(supplied, expected):
            self.send_json(401, {"error": "unauthorized", "message": "Enter the Pi API token in the Android Control screen."})
            return False
        return True

    def read_json(self) -> dict[str, Any]:
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ValueError("Invalid Content-Length")
        if size < 0 or size > 4096:
            raise ValueError("Request body must be 0..4096 bytes")
        if size == 0:
            return {}
        value = json.loads(self.rfile.read(size).decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("JSON body must be an object")
        return value

    def do_GET(self) -> None:
        if not self.authorized():
            return
        if self.path != "/api/status":
            self.send_json(404, {"error": "not_found"})
            return
        now = time.time()
        with lock:
            frame_age = now - state["last_camera_frame"] if state["last_camera_frame"] else None
            payload = dict(state)
            payload.update({
                "mode": state["mode"],
                "esp32_serial_open": motor._serial is not None,
                "esp32_online": bool(state["esp32_online"]),
                "moving": motor.is_moving,
                "heading_deg": motor.heading_deg,
                "distance_mm": motor.total_distance_mm,
                "tools_dry_run": True,
                "last_camera_frame_age_s": round(frame_age, 2) if frame_age is not None else None,
                "camera_online": bool(frame_age is not None and frame_age <= 2.0),
            })
        self.send_json(200, payload)

    def do_POST(self) -> None:
        if not self.authorized():
            return
        try:
            data = self.read_json()
            if self.path == "/api/stop":
                stop_all()
                self.send_json(200, {"ok": True, "mode": "manual"})
                return
            if self.path == "/api/mode":
                global autonomous_thread
                mode = str(data.get("mode", ""))
                if mode not in ("manual", "autonomous"):
                    self.send_json(400, {"error": "mode must be manual or autonomous"})
                    return
                stop_all()
                if mode == "autonomous":
                    previous = autonomous_thread
                    if previous is not None and previous.is_alive():
                        previous.join(timeout=2.5)
                    if previous is not None and previous.is_alive():
                        self.send_json(503, {"error": "previous autonomous loop is still stopping"})
                        return
                    if not state["esp32_online"]:
                        self.send_json(503, {"error": "ESP32 is not responding to PING or its E-stop input is open"})
                        return
                    auto_stop.clear()
                    controller.stats = MissionStats(state="DRIVE_ROW")
                    controller._last_valid_frame_ts = time.monotonic()
                    with lock:
                        state["fault"] = None
                        state["mode"] = "autonomous"
                    autonomous_thread = threading.Thread(target=autonomous_worker, daemon=True)
                    autonomous_thread.start()
                self.send_json(200, {"ok": True, "mode": mode})
                return
            if self.path == "/api/drive":
                with lock:
                    if state["mode"] != "manual":
                        self.send_json(409, {"error": "manual mode is not active"})
                        return
                    if not state["esp32_online"]:
                        self.send_json(503, {"error": "ESP32 heartbeat is not healthy"})
                        return
                    left = max(-35, min(35, int(data.get("left", 0))))
                    right = max(-35, min(35, int(data.get("right", 0))))
                    try:
                        motor.drive(left, right)
                    except Exception as exc:
                        state["fault"] = f"ESP32 serial write failed: {exc}"
                        state["esp32_serial_open"] = False
                        state["esp32_online"] = False
                        self.send_json(503, {"error": "ESP32 serial unavailable; command rejected"})
                        return
                    state["last_command"] = time.monotonic()
                self.send_json(200, {"ok": True, "left": left, "right": right})
                return
            self.send_json(404, {"error": "not_found"})
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            self.send_json(400, {"error": str(exc)})
        except Exception as exc:
            self.send_json(500, {"error": str(exc)})


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    threading.Thread(target=camera_worker, daemon=True, name="maixsense-reader").start()
    threading.Thread(target=heartbeat_worker, daemon=True, name="esp32-heartbeat").start()
    threading.Thread(target=watchdog_worker, daemon=True, name="manual-watchdog").start()
    print(f"Simpla Bot hub listening on http://{HOST}:{PORT}")
    try:
        ReusableThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    finally:
        stop_all()
        tools.emergency_cutoff()
        motor.close()
