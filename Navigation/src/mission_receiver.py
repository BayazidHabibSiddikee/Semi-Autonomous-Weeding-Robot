#!/usr/bin/env python3
"""
Raspberry Pi HTTP Mission Receiver & UDP Discovery Responder for the Android BEV Planner.

Endpoints (HTTP on 0.0.0.0:8080 by default):
  GET  /health   -> {"status": "ok", "device": "weed-laser-rover", "version": 1, ...}
  GET  /mission  -> Returns the currently loaded mission JSON (or 404 if none)
  POST /mission  -> Validates & stores an Android BEV Mission JSON payload, returns ACK

UDP Discovery Responder (port 8081):
  Listens for b"DISCOVER_WEED_ROVER" broadcast packets and replies with JSON metadata
  so the Android app's discoverDevices() can auto-find the Raspberry Pi on Wi-Fi/hotspot.

Usage:
  python3 Navigation/src/mission_receiver.py --host 0.0.0.0 --port 8080
"""
import argparse
import json
import os
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Dict, Optional, Tuple


DISCOVERY_PORT = 8081
DISCOVERY_MAGIC = b"DISCOVER_WEED_ROVER"


def validate_mission_payload(data: Any) -> Tuple[bool, str]:
    """Validate an incoming Android Mission JSON payload."""
    if not isinstance(data, dict):
        return False, "Mission payload must be a JSON object"

    version = data.get("version")
    if not isinstance(version, int) or version < 1:
        return False, "Invalid or missing 'version' (>= 1 required)"

    field = data.get("field")
    if not isinstance(field, dict):
        return False, "Missing 'field' object"

    width_m = field.get("widthM", field.get("width_m"))
    length_m = field.get("lengthM", field.get("length_m"))
    total_rows = field.get("totalRows", field.get("total_rows"))
    if not isinstance(width_m, (int, float)) or width_m <= 0:
        return False, "Invalid field widthM (> 0 required)"
    if not isinstance(length_m, (int, float)) or length_m <= 0:
        return False, "Invalid field lengthM (> 0 required)"
    if not isinstance(total_rows, int) or total_rows < 1:
        return False, "Invalid field totalRows (>= 1 required)"

    path = data.get("path")
    if not isinstance(path, list) or len(path) == 0:
        return False, "Mission 'path' must be a non-empty list of segments"

    for idx, seg in enumerate(path):
        if not isinstance(seg, dict):
            return False, f"Path segment #{idx} must be an object"
        if "seq" not in seg:
            return False, f"Path segment #{idx} missing 'seq'"

    return True, "ok"


class MissionStore:
    """Thread-safe store for the active mission received from the Android planner."""

    def __init__(self, save_path: Optional[str] = None,
                 on_mission_received: Optional[Callable[[Dict[str, Any]], None]] = None):
        self._lock = threading.Lock()
        self._mission: Optional[Dict[str, Any]] = None
        self._received_at: Optional[float] = None
        self._save_path = save_path
        self._on_mission_received = on_mission_received

    def set_mission(self, mission: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            self._mission = mission
            self._received_at = time.time()
            if self._save_path:
                os.makedirs(os.path.dirname(os.path.abspath(self._save_path)), exist_ok=True)
                with open(self._save_path, "w", encoding="utf-8") as f:
                    json.dump(mission, f, indent=2)
        if self._on_mission_received:
            self._on_mission_received(mission)
        return {
            "ack": True,
            "status": "accepted",
            "received_at": self._received_at,
            "segments": len(mission.get("path", [])),
            "version": mission.get("version", 1),
        }

    def get_mission(self) -> Optional[Dict[str, Any]]:
        with self._lock:
            return self._mission

    def health(self) -> Dict[str, Any]:
        with self._lock:
            return {
                "status": "ok",
                "device": "weed-laser-rover",
                "version": 1,
                "has_mission": self._mission is not None,
                "received_at": self._received_at,
            }


def _make_handler(store: MissionStore):
    class MissionRequestHandler(BaseHTTPRequestHandler):
        def _send_json(self, code: int, payload: Dict[str, Any]):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/health":
                self._send_json(200, store.health())
            elif self.path == "/mission":
                mission = store.get_mission()
                if mission is None:
                    self._send_json(404, {"error": "No mission loaded"})
                else:
                    self._send_json(200, mission)
            else:
                self._send_json(404, {"error": f"Unknown endpoint: {self.path}"})

        def do_POST(self):
            if self.path != "/mission":
                self._send_json(404, {"error": f"Unknown endpoint: {self.path}"})
                return

            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > 2_000_000:
                self._send_json(400, {"ack": False, "error": "Invalid Content-Length"})
                return

            raw = self.rfile.read(length)
            try:
                data = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                self._send_json(400, {"ack": False, "error": f"Malformed JSON: {exc}"})
                return

            ok, err = validate_mission_payload(data)
            if not ok:
                self._send_json(400, {"ack": False, "error": err})
                return

            ack = store.set_mission(data)
            print(f"[MissionReceiver] Accepted mission: {ack['segments']} segments")
            self._send_json(200, ack)

        def log_message(self, fmt, *args):
            print(f"[MissionReceiver] {self.address_string()} - {fmt % args}")

    return MissionRequestHandler


class MissionReceiverServer:
    """Runs the HTTP mission receiver and UDP LAN discovery responder."""

    def __init__(self, host: str = "0.0.0.0", port: int = 8080,
                 discovery_port: int = DISCOVERY_PORT,
                 save_path: str = "Navigation/active_mission.json",
                 on_mission_received: Optional[Callable[[Dict[str, Any]], None]] = None):
        self.host = host
        self.port = port
        self.discovery_port = discovery_port
        self.store = MissionStore(save_path=save_path, on_mission_received=on_mission_received)
        self._httpd: Optional[ThreadingHTTPServer] = None
        self._http_thread: Optional[threading.Thread] = None
        self._udp_thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()

    def start(self):
        self._stop_event.clear()
        self._httpd = ThreadingHTTPServer((self.host, self.port), _make_handler(self.store))
        self._http_thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._http_thread.start()

        self._udp_thread = threading.Thread(target=self._run_udp_discovery, daemon=True)
        self._udp_thread.start()
        print(f"[MissionReceiver] Listening on http://{self.host}:{self.port} (UDP discovery :{self.discovery_port})")

    def _run_udp_discovery(self):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.settimeout(1.0)
        try:
            sock.bind(("", self.discovery_port))
        except OSError as exc:
            print(f"[MissionReceiver] UDP discovery bind failed on :{self.discovery_port}: {exc}")
            sock.close()
            return

        reply = json.dumps({
            "name": socket.gethostname() or "WeedLaser-Pi",
            "port": self.port,
            "type": "RASPBERRY_PI",
        }).encode("utf-8")

        while not self._stop_event.is_set():
            try:
                data, addr = sock.recvfrom(1024)
                if data.strip() == DISCOVERY_MAGIC:
                    sock.sendto(reply, addr)
            except socket.timeout:
                continue
            except OSError:
                break
        sock.close()

    def stop(self):
        self._stop_event.set()
        if self._httpd:
            self._httpd.shutdown()
            self._httpd.server_close()
            self._httpd = None


def main():
    parser = argparse.ArgumentParser(description="Weed Laser Rover — Pi Mission Receiver")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--save-path", default="Navigation/active_mission.json")
    args = parser.parse_args()

    server = MissionReceiverServer(host=args.host, port=args.port, save_path=args.save_path)
    server.start()
    try:
        while True:
            time.sleep(1.0)
    except KeyboardInterrupt:
        print("\n[MissionReceiver] Shutting down...")
        server.stop()


if __name__ == "__main__":
    main()
