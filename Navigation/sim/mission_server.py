#!/usr/bin/env python3
"""
Raspberry Pi mission server.

Listens for missions produced by the Android app and executes them on the
rover (real hardware or the simulated one). This is the "Pi 5" half of the
end-to-end chain:

    Android app  --HTTP POST /mission-->  Pi server  -->  rover (via ESP32)

Endpoints
---------
    POST /mission   accept a mission JSON (the app's `Mission` payload)
    GET  /status    current mission status (the app polls this)
    GET  /health    liveness probe
    GET  /plan      the parsed plan of the last accepted mission

Usage
-----
    python3 Navigation/sim/mission_server.py --port 8080 --sim
"""
import argparse
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, "Navigation", "src"))
sys.path.insert(0, os.path.join(REPO, "Navigation", "sim"))

from mission_planner import MissionPlan  # noqa: E402


class MissionServer:
    """Holds the current mission and runs it in a background thread."""

    def __init__(self, config: Optional[Dict[str, Any]] = None, simulate: bool = True,
                 seed: int = 42, log=print):
        self.config = config or {}
        self.simulate = simulate
        self.seed = seed
        self.log = log

        self.plan: Optional[MissionPlan] = None
        self.status: Dict[str, Any] = {
            "state": "IDLE",
            "rowsDone": 0,
            "rowsTotal": 0,
            "weedsFound": 0,
            "weedsKilled": 0,
            "weedsRemaining": 0,
            "distanceM": 0.0,
            "message": "waiting for a mission",
            "finished": False,
            "error": None,
        }
        self._lock = threading.Lock()
        self._thread: Optional[threading.Thread] = None
        self._executor = None

    # ------------------------------------------------------------------ api

    def submit(self, mission_json) -> Dict[str, Any]:
        plan = MissionPlan.from_json(mission_json)
        with self._lock:
            self.plan = plan
            self.status = {
                "state": "RECEIVED",
                "rowsDone": 0,
                "rowsTotal": len(plan.rows_m),
                "weedsFound": 0,
                "weedsKilled": 0,
                "weedsRemaining": 0,
                "distanceM": 0.0,
                "message": f"plan accepted: {len(plan.rows_m)} rows, "
                           f"{len(plan.waypoints)} waypoints, {plan.distance_m:.1f} m",
                "finished": False,
                "error": None,
            }
        self.log(f"[SERVER] {self.status['message']}")
        self.start()
        return {
            "accepted": True,
            "rows": len(plan.rows_m),
            "waypoints": len(plan.waypoints),
            "distanceM": round(plan.distance_m, 2),
        }

    def start(self):
        if self._thread and self._thread.is_alive():
            self.log("[SERVER] mission already running")
            return
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def get_status(self) -> Dict[str, Any]:
        with self._lock:
            return dict(self.status)

    def get_plan(self) -> Dict[str, Any]:
        with self._lock:
            return self.plan.to_dict() if self.plan else {}

    # -------------------------------------------------------------- internals

    def _run(self):
        try:
            if self.simulate:
                self._run_simulated()
            else:
                self._run_on_hardware()
        except Exception as exc:  # pragma: no cover - defensive
            with self._lock:
                self.status["state"] = "ERROR"
                self.status["error"] = str(exc)
                self.status["finished"] = True
            self.log(f"[SERVER] mission failed: {exc}")

    def _run_simulated(self):
        """Run the mission on the field simulator (no hardware)."""
        import cv2
        import yaml
        from field_simulator import FieldSimulator
        from mission_executor import MissionExecutor
        from virtual_esp32 import VirtualESP32
        from run_field_sim import SimGimbal, ColorWeedDetector

        with open(os.path.join(REPO, "Navigation", "rover_config.yaml")) as f:
            config = yaml.safe_load(f)

        # build the simulated field from the plan: crop rows exactly where the
        # rover will drive, weeds along those rows
        rows_y_cm = []
        if self.plan:
            for y_m in self.plan.rows_m:
                y_cm = (y_m / max(self.plan.width_m, 1e-6)) * 200.0
                rows_y_cm.append(y_cm)
        field = FieldSimulator(config=config, seed=self.seed, rows_y_cm=rows_y_cm)
        gimbal = SimGimbal()
        esp32 = VirtualESP32(field, gimbal)
        esp32.connect()

        executor = MissionExecutor(
            field=field,
            plan=self.plan,
            detector=ColorWeedDetector(),
            gimbal=gimbal,
            esp32=esp32,
            config=config,
            log=self.log,
        )
        self._executor = executor

        # mirror the executor status into the server status
        def pump():
            while not executor.status.finished:
                with self._lock:
                    self.status.update(executor.status.to_dict())
                time.sleep(0.2)
            with self._lock:
                self.status.update(executor.status.to_dict())

        pump_thread = threading.Thread(target=pump, daemon=True)
        pump_thread.start()
        executor.run()
        pump_thread.join(timeout=2)

    def _run_on_hardware(self):
        """Run the mission on the real rover (ESP32 over serial)."""
        from mission_executor import MissionExecutor  # noqa: F401

        raise NotImplementedError(
            "Hardware execution is not wired yet - the Pi still needs the "
            "ESP32 serial bridge wired into MissionExecutor."
        )


class Handler(BaseHTTPRequestHandler):
    """HTTP handler; the mission server hangs off the socket server object."""

    def _send(self, code: int, payload: Dict[str, Any]):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        if self.path.startswith("/status"):
            self._send(200, self.server.mission_server.get_status())
        elif self.path.startswith("/plan"):
            self._send(200, self.server.mission_server.get_plan())
        elif self.path.startswith("/health"):
            self._send(200, {"ok": True, "service": "mission_server"})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if self.path.startswith("/mission"):
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            try:
                result = self.server.mission_server.submit(raw)
                self._send(200, result)
            except Exception as exc:
                self._send(400, {"accepted": False, "error": str(exc)})
        else:
            self._send(404, {"error": "not found"})

    def log_message(self, fmt, *args):  # keep the console readable
        pass


def main():
    ap = argparse.ArgumentParser(description="Pi mission server (Android -> Pi -> ESP32)")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--hardware", action="store_true", help="use real hardware instead of the sim")
    args = ap.parse_args()

    server = MissionServer(simulate=not args.hardware, seed=args.seed)
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.mission_server = server  # type: ignore[attr-defined]
    print(f"[SERVER] listening on http://{args.host}:{args.port}  "
          f"({'simulated' if not args.hardware else 'hardware'} mode)")
    print("[SERVER] POST a mission to /mission, poll /status")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[SERVER] shutting down")


if __name__ == "__main__":
    main()
