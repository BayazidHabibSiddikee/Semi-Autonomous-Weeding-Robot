#!/usr/bin/env python3
"""Small Simpla Bot phone hub: Android/Wi-Fi -> Pi -> ESP32 USB serial."""
from __future__ import annotations
import json, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from simpla_bot.config_util import load_config
from simpla_bot.simpla_bot_controller import create_live_controller

HOST, PORT = "0.0.0.0", 8080
cfg = load_config()
cfg.setdefault("motor_driver", {})["backend"] = "serial"
cfg["tools"]["dry_run"] = True
cfg["tools"]["default_mode"] = "none"
controller, motor, tools = create_live_controller(cfg, tool_mode="none", arm_tools=False)
state: dict[str, Any] = {
    "mode": "manual", "camera_online": False, "esp32_online": motor._serial is not None,
    "last_camera_frame": 0.0, "last_command": 0.0, "fault": None, "version": "pi4-usb-hub-1",
}
lock = threading.RLock()
auto_stop = threading.Event()
_original_estop_safe = tools.is_estop_safe
tools.is_estop_safe = lambda: _original_estop_safe() and not auto_stop.is_set()

def stop_all() -> None:
    # Signal the autonomous loop before issuing STOP. Its movement helpers check
    # tools.is_estop_safe every 50 ms, so the stop request interrupts long moves.
    auto_stop.set()
    motor.stop()
    with lock:
        state["mode"] = "manual"

def autonomous_worker() -> None:
    auto_stop.clear()
    while not auto_stop.is_set():
        with lock:
            if state["mode"] != "autonomous":
                break
        try:
            # Do not hold the HTTP state lock here: STOP must remain responsive.
            stats = controller.step(step_dt_s=0.2)
            decision = stats.last_decision
            if decision is not None:
                with lock:
                    state["camera_online"] = True
                    state["last_camera_frame"] = time.time()
                    state["distances_mm"] = {
                        "left": decision.left_mm, "center": decision.center_mm,
                        "right": decision.right_mm
                    }
                    state["corner"] = decision.corner_type
                    state["weed_detected"] = decision.weed is not None
            if stats.state in ("DONE", "ESTOP_HALT"):
                with lock:
                    state["fault"] = stats.halt_reason or stats.state
                    state["mode"] = "manual"
                motor.stop()
                break
        except Exception as exc:
            with lock:
                state["fault"] = str(exc)
                state["mode"] = "manual"
            motor.stop()
            break
        time.sleep(0.05)

def watchdog() -> None:
    while True:
        time.sleep(0.1)
        with lock:
            if state["mode"] == "manual" and motor.is_moving:
                if time.monotonic() - state["last_command"] > 0.45:
                    motor.stop()

def sensor_worker() -> None:
    # Keep MaixSense telemetry fresh even while the operator is driving manually.
    while True:
        with lock:
            manual = state["mode"] == "manual"
        if manual:
            try:
                frame = controller.frame_provider()
                if frame is not None:
                    decision = controller.analyzer.analyze(frame)
                    with lock:
                        state["camera_online"] = True
                        state["last_camera_frame"] = time.time()
                        state["distances_mm"] = {
                            "left": decision.left_mm, "center": decision.center_mm,
                            "right": decision.right_mm
                        }
                        state["corner"] = decision.corner_type
                        state["weed_detected"] = decision.weed is not None
                else:
                    with lock:
                        state["camera_online"] = False
            except Exception as exc:
                with lock:
                    state["camera_online"] = False
                    state["camera_error"] = str(exc)
        time.sleep(0.4)

threading.Thread(target=watchdog, daemon=True).start()
threading.Thread(target=sensor_worker, daemon=True).start()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_: Any) -> None:
        pass
    def send_json(self, code: int, payload: dict[str, Any]) -> None:
        raw = json.dumps(payload, allow_nan=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(raw)
    def read_json(self) -> dict[str, Any]:
        size = min(int(self.headers.get("Content-Length", "0")), 4096)
        return json.loads(self.rfile.read(size) or b"{}")
    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
    def do_GET(self) -> None:
        if self.path != "/api/status":
            self.send_json(404, {"error":"not_found"}); return
        with lock:
            payload = dict(state)
            payload.update({
                "mode": state["mode"],
                "esp32_online": motor._serial is not None,
                "moving": motor.is_moving,
                "heading_deg": motor.heading_deg,
                "distance_mm": motor.total_distance_mm,
                "tools_dry_run": True,
                "last_camera_frame_age_s": (round(time.time() - state["last_camera_frame"], 2) if state["last_camera_frame"] else None),
            })
        self.send_json(200, payload)
    def do_POST(self) -> None:
        try:
            data = self.read_json()
            if self.path == "/api/stop":
                stop_all()
                self.send_json(200, {"ok": True, "mode":"manual"})
                return
            if self.path == "/api/mode":
                mode = str(data.get("mode", ""))
                if mode not in ("manual", "autonomous"):
                    self.send_json(400, {"error":"mode must be manual or autonomous"}); return
                stop_all()
                if mode == "autonomous":
                    with lock:
                        state["fault"] = None
                        state["mode"] = "autonomous"
                    threading.Thread(target=autonomous_worker, daemon=True).start()
                self.send_json(200, {"ok":True, "mode":mode})
                return
            if self.path == "/api/drive":
                with lock:
                    if state["mode"] != "manual":
                        self.send_json(409, {"error":"manual mode is not active"}); return
                    left = max(-35, min(35, int(data.get("left", 0))))
                    right = max(-35, min(35, int(data.get("right", 0))))
                    motor.drive(left, right)
                    state["last_command"] = time.monotonic()
                self.send_json(200, {"ok":True, "left":left, "right":right})
                return
            self.send_json(404, {"error":"not_found"})
        except Exception as exc:
            self.send_json(500, {"error":str(exc)})

if __name__ == "__main__":
    print(f"Simpla Bot hub listening on http://0.0.0.0:{PORT}")
    try:
        ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
    finally:
        stop_all()
        tools.emergency_cutoff()
        motor.close()
