"""
Pi discovery over UDP broadcast.

The phone and the Pi are usually on the same small network (phone hotspot or
Wi-Fi). Instead of typing an IP address into the app, the app broadcasts a
short probe and the Pi answers with its address.

Protocol (UDP, port 9999, broadcast):

    phone -> all : b"WEEDLASER_DISCOVER"
    pi   -> phone: b'{"service":"weedlaser","host":"192.168.43.123","port":8080,...}'

The server side lives in `Navigation/sim/mission_server.py`
(`DiscoveryResponder`); this module is the client, used by the laptop
simulator and mirrored by the Android app (`data/remote/PiDiscovery.kt`).
"""
from __future__ import annotations

import json
import socket
from typing import Any, Dict, Optional

DISCOVERY_PORT = 9999
DISCOVERY_PROBE = b"WEEDLASER_DISCOVER"


def discover_pi(timeout: float = 3.0, port: int = DISCOVERY_PORT) -> Optional[Dict[str, Any]]:
    """
    Broadcast a probe and wait for the Pi to answer.

    Returns the Pi's info dict (`host`, `port`, `name`) or None on timeout.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.settimeout(timeout)

    probe = f"WEEDLASER_DISCOVER".encode()
    for target in ("255.255.255.255", "192.168.43.255", "192.168.0.255"):
        try:
            sock.sendto(probe, (target, port))
        except OSError:
            pass

    deadline = timeout
    while deadline > 0:
        try:
            data, _addr = sock.recvfrom(2048)
        except socket.timeout:
            break
        try:
            info = json.loads(data.decode())
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        if info.get("service") == "weedlaser":
            sock.close()
            return info
    sock.close()
    return None


def pi_base_url(info: Optional[Dict[str, Any]] = None, fallback: str = "127.0.0.1:8080") -> str:
    """Turn a discovery result into `http://host:port`."""
    if not info:
        return f"http://{fallback}"
    return f"http://{info.get('host', '127.0.0.1')}:{info.get('port', 8080)}"


if __name__ == "__main__":
    import sys

    timeout = float(sys.argv[1]) if len(sys.argv) > 1 else 3.0
    found = discover_pi(timeout)
    if found:
        print("Pi found:", found)
        print("Mission URL:", pi_base_url(found))
    else:
        print("no Pi answered the probe (is mission_server.py running?)")
