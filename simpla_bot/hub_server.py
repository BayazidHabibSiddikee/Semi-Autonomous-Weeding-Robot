#!/usr/bin/env python3
"""Small Simpla Bot phone hub: Android/Wi-Fi ("bayazid"/"12345678") -> Pi -> ESP32; live MaixSense video + 8-way."""
from __future__ import annotations

import hmac
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
import sys
from urllib.parse import parse_qs, urlparse

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

# Fixed default password matching Pi Wi-Fi hotspot ("bayazid" / "12345678")
API_TOKEN = os.environ.get("SIMPLA_API_TOKEN", "12345678").strip() or "12345678"
print(f"\n[SIMPLA HUB] Wi-Fi SSID: bayazid | API Password/Token: {API_TOKEN}")

controller, motor, tools = create_live_controller(cfg, tool_mode="none", arm_tools=False)
camera_fetch = controller.frame_provider
controller_frame_condition = threading.Condition()
latest_frame = None
latest_decision = None
latest_annotated_jpeg: bytes = b""
last_consumed_frame_id = -1
last_camera_monotonic = 0.0

state: dict[str, Any] = {
    "mode": "manual",
    "last_action": "IDLE",
    "heading_8way": 0,
    "camera_online": False,
    "esp32_serial_open": bool(motor._serial is not None and getattr(motor._serial, "is_open", True)),
    "esp32_online": False,
    "esp32_responding": False,
    "esp32_estop_ok": False,
    "esp32_error": getattr(motor, "_serial_error", None),
    "last_camera_frame": 0.0,
    "last_command": 0.0,
    "fault": None,
    "camera_error": None,
    "version": "pi4-maixsense-hub-3-8way",
}
lock = threading.RLock()
auto_stop = threading.Event()
auto_stop.set()
autonomous_thread: threading.Thread | None = None
motion_lock = threading.RLock()
_original_motor_drive = motor.drive
_original_motor_stop = motor.stop


def guarded_motor_drive(left: float, right: float) -> None:
    with motion_lock:
        if threading.current_thread() is autonomous_thread and auto_stop.is_set():
            _original_motor_stop()
            return
        _original_motor_drive(left, right)


def serialized_motor_stop() -> None:
    with motion_lock:
        _original_motor_stop()


motor.drive = guarded_motor_drive
motor.stop = serialized_motor_stop
_original_estop_safe = tools.is_estop_safe
tools.is_estop_safe = lambda: _original_estop_safe() and not auto_stop.is_set() and bool(state["esp32_online"])


def dir_to_differential(angle_deg: int, speed: int = 28) -> tuple[int, int]:
    """Map 8-way heading (0, 45, 90, 135, 180, 225, 270, 315) to differential drive (-35..35)."""
    spd = max(10, min(35, int(speed)))
    ang = ((int(angle_deg) + 22) // 45 * 45) % 360
    mapping = {
        0: (spd, spd),
        45: (spd, int(spd * 0.40)),
        90: (int(spd * 0.85), -int(spd * 0.85)),
        135: (-int(spd * 0.80), -int(spd * 0.35)),
        180: (-spd, -spd),
        225: (-int(spd * 0.35), -int(spd * 0.80)),
        270: (-int(spd * 0.85), int(spd * 0.85)),
        315: (int(spd * 0.40), spd),
    }
    return mapping.get(ang, (0, 0))


def _render_live_jpeg(frame: Any, decision: Any, mode: str, action: str) -> bytes:
    """Render annotated RGB + live action/depth/weed overlay JPEG for the Android app."""
    try:
        import cv2
        import numpy as np

        img = None
        if frame is not None and getattr(frame, "rgb_jpeg", b""):
            arr = np.frombuffer(frame.rgb_jpeg, dtype=np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)

        if img is None and frame is not None and getattr(frame, "depth_mm", None):
            dh = int(getattr(frame, "depth_height", 240))
            dw = int(getattr(frame, "depth_width", 320))
            d_arr = np.array(frame.depth_mm, dtype=np.uint16).reshape((dh, dw))
            norm = np.clip((d_arr.astype(np.float32) / 2000.0) * 255.0, 0, 255).astype(np.uint8)
            img = cv2.applyColorMap(norm, cv2.COLORMAP_JET)

        if img is None:
            img = np.zeros((360, 480, 3), dtype=np.uint8)
            cv2.putText(img, "WAITING FOR MAIXSENSE CAMERA...", (28, 175),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 200, 255), 2)

        h, w = img.shape[:2]
        # Top HUD banner
        cv2.rectangle(img, (0, 0), (w, 54), (18, 24, 32), -1)
        hud1 = f"MODE: {mode.upper()} | {action}"
        cv2.putText(img, hud1[:44], (10, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 255, 160), 2)

        if decision is not None:
            l_mm = int(decision.left_mm) if decision.left_mm is not None else -1
            c_mm = int(decision.center_mm) if decision.center_mm is not None else -1
            r_mm = int(decision.right_mm) if decision.right_mm is not None else -1
            hud2 = f"L:{l_mm} C:{c_mm} R:{r_mm}mm | {decision.corner_type}"
            cv2.putText(img, hud2[:52], (10, 45), cv2.FONT_HERSHEY_SIMPLEX, 0.48, (220, 235, 255), 1)

            if decision.weed is not None:
                wx = int(((decision.weed.cx_norm + 1.0) * 0.5) * w)
                wy = int(decision.weed.cy_norm * h)
                cv2.circle(img, (wx, wy), 16, (0, 0, 255), 2)
                cv2.drawMarker(img, (wx, wy), (0, 255, 255), cv2.MARKER_CROSS, 24, 2)
                cv2.putText(img, f"WEED {int(decision.weed.dx_to_tool_mm)}mm",
                            (max(8, wx - 45), max(72, wy - 20)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 2)

        ok, enc = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
        return enc.tobytes() if ok else (frame.rgb_jpeg if frame is not None else b"")
    except Exception:
        if frame is not None and getattr(frame, "rgb_jpeg", b""):
            return frame.rgb_jpeg
        return b""


def controller_frame_provider():
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


controller.frame_provider = controller_frame_provider


def camera_worker() -> None:
    global latest_frame, latest_decision, latest_annotated_jpeg, last_camera_monotonic
    while True:
        try:
            frame = camera_fetch()
            if frame is None:
                with lock:
                    state["camera_error"] = "No valid frame from MaixSense /getdeep"
                    mode = state["mode"]
                    action = state["last_action"]
                placeholder = _render_live_jpeg(None, None, mode, action)
                if placeholder:
                    with lock:
                        latest_annotated_jpeg = placeholder
                time.sleep(0.15)
                continue
            decision = controller.analyzer.analyze(frame)
            with lock:
                mode = state["mode"]
                action = state["last_action"]
            jpeg_bytes = _render_live_jpeg(frame, decision, mode, action)
            with controller_frame_condition:
                latest_frame = frame
                latest_decision = decision
                last_camera_monotonic = time.monotonic()
                controller_frame_condition.notify_all()
            with lock:
                if jpeg_bytes:
                    latest_annotated_jpeg = jpeg_bytes
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
                if mode == "autonomous":
                    state["last_action"] = (
                        f"AUTO: WEED ({int(decision.weed.dx_to_tool_mm)}mm)"
                        if decision.weed is not None
                        else f"AUTO: {decision.corner_type}"
                    )
        except Exception as exc:
            with lock:
                state["camera_error"] = str(exc)
        time.sleep(0.03)


def heartbeat_worker() -> None:
    last_reconnect = 0.0
    while True:
        responding, estop_ok = motor.probe()
        now = time.monotonic()
        if not responding and now - last_reconnect >= 3.0:
            last_reconnect = now
            motor.reconnect_serial()
        with lock:
            state["esp32_responding"] = responding
            state["esp32_online"] = responding and estop_ok
            state["esp32_estop_ok"] = estop_ok
            state["esp32_error"] = getattr(motor, "_serial_error", None)
            state["esp32_serial_open"] = bool(
                motor._serial is not None and getattr(motor._serial, "is_open", True)
            )
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
        state["last_action"] = "STOPPED"


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
                    state["last_action"] = f"AUTO: {stats.state}"
            if stats.state in ("DONE", "ESTOP_HALT"):
                with lock:
                    state["fault"] = stats.halt_reason or stats.state
                    state["mode"] = "manual"
                    state["last_action"] = f"HALT: {stats.state}"
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
                state["last_action"] = "AUTO ERROR"
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
                with lock:
                    state["last_action"] = "MANUAL IDLE"
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
        query = parse_qs(urlparse(self.path).query)
        q_token = query.get("token", [""])[0]
        expected = "Bearer " + API_TOKEN
        if hmac.compare_digest(supplied, expected) or hmac.compare_digest(q_token, API_TOKEN):
            return True
        self.send_json(401, {"error": "unauthorized", "message": "Use password/token 12345678."})
        return False

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
        clean_path = urlparse(self.path).path

        if clean_path == "/api/frame.jpg":
            with lock:
                jpeg = latest_annotated_jpeg
                mode = state["mode"]
                action = state["last_action"]
            if not jpeg:
                jpeg = _render_live_jpeg(None, None, mode, action)
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(jpeg)))
            self.end_headers()
            self.wfile.write(jpeg)
            return

        if clean_path == "/video_feed":
            self.send_response(200)
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                while True:
                    with lock:
                        jpeg = latest_annotated_jpeg
                        mode = state["mode"]
                        action = state["last_action"]
                    if not jpeg:
                        jpeg = _render_live_jpeg(None, None, mode, action)
                    if jpeg:
                        self.wfile.write(
                            b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                            + str(len(jpeg)).encode()
                            + b"\r\n\r\n"
                            + jpeg
                            + b"\r\n"
                        )
                    time.sleep(0.08)
            except (BrokenPipeError, ConnectionResetError):
                return

        if clean_path != "/api/status":
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
        clean_path = urlparse(self.path).path
        try:
            data = self.read_json()
            if clean_path == "/api/stop":
                stop_all()
                self.send_json(200, {"ok": True, "mode": "manual"})
                return
            if clean_path == "/api/mode":
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
                    camera_age = time.time() - state["last_camera_frame"] if state["last_camera_frame"] else 9999.0
                    if camera_age > 2.0:
                        self.send_json(503, {"error": "MaixSense has no fresh frame; check its USB-RNDIS link"})
                        return
                    auto_stop.clear()
                    controller.stats = MissionStats(state="DRIVE_ROW")
                    controller._last_valid_frame_ts = time.monotonic()
                    with lock:
                        state["fault"] = None
                        state["mode"] = "autonomous"
                        state["last_action"] = "AUTO: DRIVE_ROW"
                    autonomous_thread = threading.Thread(target=autonomous_worker, daemon=True)
                    autonomous_thread.start()
                else:
                    with lock:
                        state["last_action"] = "MANUAL READY"
                self.send_json(200, {"ok": True, "mode": mode})
                return
            if clean_path in ("/api/drive", "/api/dir"):
                with lock:
                    if state["mode"] != "manual":
                        self.send_json(409, {"error": "manual mode is not active"})
                        return
                    if not state["esp32_online"]:
                        self.send_json(503, {"error": "ESP32 heartbeat is not healthy"})
                        return
                    if clean_path == "/api/dir":
                        angle = int(data.get("angle", 0))
                        speed = int(data.get("speed", 28))
                        left, right = dir_to_differential(angle, speed)
                        state["heading_8way"] = angle
                        action_label = f"MANUAL DIR {angle} deg"
                    else:
                        left = max(-35, min(35, int(data.get("left", 0))))
                        right = max(-35, min(35, int(data.get("right", 0))))
                        action_label = f"MANUAL L:{left} R:{right}"
                    try:
                        motor.drive(left, right)
                    except Exception as exc:
                        state["fault"] = f"ESP32 serial write failed: {exc}"
                        state["esp32_serial_open"] = False
                        state["esp32_online"] = False
                        self.send_json(503, {"error": "ESP32 serial unavailable; command rejected"})
                        return
                    state["last_command"] = time.monotonic()
                    state["last_action"] = action_label
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
        try:
            tools.emergency_cutoff()
        except Exception:
            pass
        motor.close()
