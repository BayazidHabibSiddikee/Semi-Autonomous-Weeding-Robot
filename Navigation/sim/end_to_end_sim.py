#!/usr/bin/env python3
"""
End-to-end chain simulator: Android app -> Pi -> ESP32 -> rover.

This script plays the role of the Android phone:

  1. takes the top-view field photo
  2. runs the same OpenCV pipeline as the app's FieldAnalyzer
     (Otsu-ExG, morphology, row segments, corners)
  3. builds the mission JSON exactly like the app's BoustrophedonGenerator
  4. POSTs it to the Pi mission server (HTTP, same as the app)
  5. polls /status while the rover drives, weeding along the way
  6. optionally records the mission video

Usage:
    # terminal 1
    python3 Navigation/sim/mission_server.py
    # terminal 2
    python3 Navigation/sim/end_to_end_sim.py --image Navigation/images/field_topview.jpeg
"""
import argparse
import json
import os
import sys
import time
import urllib.request

import cv2
import numpy as np

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, "Navigation", "src"))

from mission_planner import build_mission_json  # noqa: E402
from pi_discovery import discover_pi, pi_base_url  # noqa: E402
from field_analyzer_reference import (  # noqa: E402
    vegetation_mask, column_projection, segments_above, merge_segments, detect_corners,
)


def detect_rows(image_path: str, expected: int | None = None):
    """Same algorithm as the Android FieldAnalyzer."""
    bgr = cv2.imread(image_path)
    if bgr is None:
        raise SystemExit(f"cannot read {image_path}")
    veg, cut = vegetation_mask(bgr)
    proj = column_projection(veg)
    segs = segments_above(proj, proj.max() * 0.25)
    merged = merge_segments(segs, bgr.shape[1], expected)
    corners = detect_corners(veg)
    return bgr, merged, corners, cut


def post_json(url: str, payload: dict) -> dict:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode())


def get_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=10) as resp:
        return json.loads(resp.read().decode())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", default=os.path.join(REPO, "Navigation", "images", "field_topview.jpeg"))
    ap.add_argument("--server", default=None,
                    help="Pi base URL (default: discover it over UDP broadcast)")
    ap.add_argument("--field-width", type=float, default=6.0, help="field width in meters")
    ap.add_argument("--field-length", type=float, default=8.0, help="field length in meters")
    ap.add_argument("--rows", type=int, default=None, help="expected number of crop rows")
    ap.add_argument("--timeout", type=float, default=600.0)
    args = ap.parse_args()

    if not os.path.exists(args.image):
        raise SystemExit(f"field image not found: {args.image}")

    # 0. find the Pi (broadcast probe) - the phone does the same thing
    server = args.server
    if not server:
        print("[APP] probing for the Pi over UDP broadcast ...")
        info = discover_pi(timeout=3.0)
        if info:
            print(f"[APP] Pi found: {info['name']} at {info['host']}:{info['port']}")
        else:
            print("[APP] no Pi answered - falling back to http://127.0.0.1:8080")
        server = pi_base_url(info)

    print("[APP] analysing field photo (Otsu-ExG, as on the phone)...")
    bgr, rows_px, corners, cut = detect_rows(args.image, args.rows)
    print(f"[APP] ExG cut={cut}  rows detected={len(rows_px)}  corners={len(corners)}")

    # BEV width maps to the field width in meters
    bev_width = bgr.shape[1]
    rows_m = [float(x) / bev_width * args.field_width for x in rows_px]
    print(f"[APP] rows in meters: {[round(r, 2) for r in rows_m]}")

    mission = build_mission_json(
        rows_m=rows_m,
        width_m=args.field_width,
        length_m=args.field_length,
    )
    print(f"[APP] mission: {len(mission['path'])} segments, "
          f"{mission['field']['totalRows']} rows")

    print(f"[APP] POSTing mission to {server}/mission ...")
    result = post_json(f"{server}/mission", mission)
    print(f"[APP] server accepted: {result}")

    print("[APP] polling status ...")
    start = time.time()
    last_state = None
    while time.time() - start < args.timeout:
        status = get_json(f"{server}/status")
        if status.get("state") != last_state:
            last_state = status.get("state")
            print(f"[APP] state={status.get('state')} "
                  f"rows={status.get('rowsDone')}/{status.get('rowsTotal')} "
                  f"killed={status.get('weedsKilled')} "
                  f"remaining={status.get('weedsRemaining')}")
        if status.get("finished"):
            print(f"[APP] mission finished: {json.dumps(status, indent=2)}")
            break
        time.sleep(1.0)
    else:
        print("[APP] timeout waiting for the mission to finish")


if __name__ == "__main__":
    main()
