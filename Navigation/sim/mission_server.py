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
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Optional

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, "Navigation", "src"))
sys.path.insert(0, os.path.join(REPO, "Navigation", "sim"))

from mission_planner import MissionPlan  # noqa: E402
from pi_discovery import DISCOVERY_PORT  # noqa: E402
from field_pipeline import analyze_field_photo, decode_image  # noqa: E402


class DiscoveryResponder:
    """
    Answers discovery probes from the phone (UDP broadcast, port 9999).

    The phone asks "is there a rover Pi here?" and gets back its address, so
    nobody has to type an IP address into the app.
    """

    def __init__(self, mission_port: int = 8080, log=print):
        self.mission_port = mission_port
        self.log = log
        self._thread: Optional[threading.Thread] = None
        self._running = False

    def start(self):
        self._running = True
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()
        self.log(f"[DISCOVERY] listening for phone probes on UDP {DISCOVERY_PORT}")

    def stop(self):
        self._running = False

    def _serve(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("", DISCOVERY_PORT))
        except OSError as exc:
            self.log(f"[DISCOVERY] cannot bind UDP {DISCOVERY_PORT}: {exc}")
            return

        while self._running:
            try:
                data, addr = sock.recvfrom(2048)
            except OSError:
                break
            if b"WEEDLASER_DISCOVER" not in data.upper():
                continue
            reply = self._info()
            sock.sendto(json.dumps(reply).encode(), addr)
            self.log(f"[DISCOVERY] answered {addr[0]} with {reply['host']}")

    def _info(self) -> Dict[str, Any]:
        return {
            "service": "weedlaser",
            "name": socket.gethostname(),
            "host": local_ip(),
            "port": self.mission_port,
            "protocol": "http",
        }


def local_ip() -> str:
    """
    Best guess of this machine's LAN address (the one the phone can reach).

    Prefers the interface that carries the default route (wlan/eth), and skips
    VPN/tunnel interfaces, so a hotspot-connected Pi reports its hotspot IP.
    """
    import fcntl
    import struct

    # 1. find the interface used for the default route
    default_iface = None
    try:
        with open("/proc/net/route") as fh:
            for line in fh.readlines()[1:]:
                parts = line.split()
                if len(parts) < 2:
                    continue
                iface, dest = parts[0], parts[1]
                if dest == "00000000" and not iface.startswith(("tun", "tap", "wg")):
                    default_iface = iface
                    break
    except OSError:
        pass

    candidates = []
    if default_iface:
        candidates.append(default_iface)
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        for name in socket.if_nameindex():
            candidates.append(name[1])
    except OSError:
        pass

    for iface in candidates:
        if iface.startswith(("lo", "tun", "tap", "wg", "docker", "veth")):
            continue
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            packed = struct.pack("256s", iface.encode()[:15])
            addr = socket.inet_ntoa(fcntl.ioctl(sock.fileno(), 0x8915, packed)[20:24])
            sock.close()
            if not addr.startswith("127."):
                return addr
        except OSError:
            continue

    # 2. fallback: whatever the OS thinks this host is
    try:
        return socket.gethostbyname(socket.gethostname())
    except OSError:
        return "127.0.0.1"


class MissionServer:
    """Holds the current mission and runs it in a background thread."""

    def __init__(self, config: Optional[Dict[str, Any]] = None, simulate: bool = True,
                 seed: int = 42, log=print):
        self.config = config or {}
        self.simulate = simulate
        self.seed = seed
        self.log = log

        self.outbox = os.path.join(REPO, "Navigation", "sim", "outbox")
        os.makedirs(self.outbox, exist_ok=True)

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

    def submit_image(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """
        Receive a field photo + 4 corners from the phone, run the CV on the Pi
        and return the resulting mission.

        Payload::

            {
              "image": "<base64 jpeg>",
              "corners": [{"x":..,"y":..}, ... 4],
              "field": {"widthM": 6.0, "lengthM": 8.0, "totalRows": 9}
            }
        """
        image_b64 = payload.get("image")
        if not image_b64:
            raise ValueError("payload is missing the 'image' field")

        corners_raw = payload.get("corners") or []
        if len(corners_raw) != 4:
            raise ValueError("exactly 4 corner points are required")
        corners = [(float(c["x"]), float(c["y"])) for c in corners_raw]

        fld = payload.get("field") or {}
        width_m = float(fld.get("widthM", 6.0))
        length_m = float(fld.get("lengthM", 8.0))
        expected = fld.get("totalRows")
        expected = int(expected) if expected else None
        speed_mps = float(fld.get("speedMps", 0.5) or 0.5)
        laser_range = float(fld.get("laserRangeM", 0.30) or 0.30)
        weed_threshold = float(fld.get("weedThreshold", 50.0) or 50.0)
        headland_m = float(fld.get("headlandMarginM", 0.2) or 0.2)
        max_weeds = int(float(fld.get("maxWeeds", 60.0) or 60.0))
        renderer = str(fld.get("renderer") or "freecad")

        image = decode_image(image_b64)
        stem = f"field_{int(time.time() * 1000)}"
        analysis = analyze_field_photo(
            image=image,
            corners=corners,
            width_m=width_m,
            length_m=length_m,
            expected_rows=expected,
            out_dir=self.outbox,
            stem=stem,
        )

        # never start a rover on a mission with no lanes: the photo did not
        # cover the field (wrong angle, night shot...) - let the app know.
        if not analysis.rows_m:
            raise ValueError(
                "No crop rows detected in the photo. The photo is likely too "
                "dark or was not taken from directly above the field - "
                "retake it in daylight, camera pointing straight down, and "
                "pick the 4 field corners."
            )
        if expected and len(analysis.rows_m) < max(1, expected // 3):
            raise ValueError(
                f"only {len(analysis.rows_m)} of ~{expected} rows detected. "
                "The photo probably does not cover the whole field or is too "
                "dark - retake it in daylight from directly above."
            )

        # the phone can now just ask the Pi to execute the plan
        result = self.submit(analysis.mission)
        result.update({
            "analysis": analysis.to_dict(),
            "bevUrl": f"/artifacts/{os.path.basename(analysis.bev_path)}",
            "overlayUrl": f"/artifacts/{os.path.basename(analysis.overlay_path)}",
        })

        # auto-run the 3D digital-twin sim in the background: the phone can
        # poll GET /sim3d and stream the finished video
        try:
            from sim3d_job import get as sim3d
            sim3d().start(
                analysis,
                width_m=width_m,
                length_m=length_m,
                laser_range_m=laser_range,
                weed_threshold=weed_threshold,
                speed_mps=speed_mps,
                headland_m=headland_m,
                max_weeds=max_weeds,
                renderer=renderer,
            )
            result["simStatusUrl"] = "/sim3d"
        except Exception as exc:  # render must never break the mission flow
            self.log(f"[SIM3D] failed to start: {exc}")
        return result

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
        if self.path.startswith("/artifacts/"):
            name = os.path.basename(self.path.split("/artifacts/")[-1])
            path = os.path.join(self.server.mission_server.outbox, name)
            if not os.path.isfile(path):
                self._send(404, {"error": "not found"})
                return
            with open(path, "rb") as fh:
                body = fh.read()
            ctype = "image/jpeg" if path.endswith((".jpg", ".jpeg")) else (
                "video/mp4" if path.endswith(".mp4") else "image/png")
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path.startswith("/status"):
            self._send(200, self.server.mission_server.get_status())
        elif self.path.startswith("/live.jpg"):
            # LIVE feed: the newest screenshot of the digital-twin render
            # currently running in FreeCAD (served as PNG bytes)
            from sim3d_job import get as sim3d
            frame = sim3d().latest_frame_path()
            if frame and os.path.isfile(frame):
                try:
                    with open(frame, "rb") as fh:
                        body = fh.read()
                    self.send_response(200)
                    self.send_header("Content-Type", "image/png")
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(body)
                except Exception as exc:
                    self._send(500, {"error": f"live frame read failed: {exc}"})
            else:
                self._send(404, {"error": "no live frame yet - send a photo first"})
        elif self.path.startswith("/sim3d"):
            from sim3d_job import get as sim3d
            snap = sim3d().snapshot()
            if snap.get("video"):
                snap["videoUrl"] = f"/artifacts/{snap['video']}"
            # how far the render got (the animation saves a png per frame)
            try:
                import glob
                snap["framesDone"] = len(
                    glob.glob(os.path.join("/tmp", "photo_sim_frames", "frame_*.png"))
                )
            except Exception:
                pass
            self._send(200, snap)
        elif self.path.startswith("/plan"):
            self._send(200, self.server.mission_server.get_plan())
        elif self.path.startswith("/health"):
            self._send(200, {
                "ok": True,
                "service": "mission_server",
                "name": socket.gethostname(),
            })
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length", 0))
        self.server.mission_server.log(
            f"[HTTP] POST {self.path} from {self.client_address[0]} ({length} bytes)"
        )
        if self.path.startswith("/image"):
            raw = self.rfile.read(length)
            try:
                payload = json.loads(raw.decode())
                result = self.server.mission_server.submit_image(payload)
                self._send(200, result)
            except Exception as exc:
                self._send(400, {"accepted": False, "error": str(exc)})
            return
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
    try:
        httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError as exc:
        if exc.errno == 98:
            print(f"[SERVER] port {args.port} is already in use - another mission "
                  f"server is running. Stop it with:\n"
                  f"    pkill -f mission_server.py\n"
                  f"or start this one on another port: --port {args.port + 1}")
            return
        raise
    httpd.mission_server = server  # type: ignore[attr-defined]
    discovery = DiscoveryResponder(mission_port=args.port)
    discovery.start()

    print(f"[SERVER] listening on http://{args.host}:{args.port}  "
          f"({'simulated' if not args.hardware else 'hardware'} mode)")
    print(f"[SERVER] reachable from the phone at http://{local_ip()}:{args.port}")
    print("[SERVER] POST a mission to /mission, poll /status")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[SERVER] shutting down")


if __name__ == "__main__":
    main()
