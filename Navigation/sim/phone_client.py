#!/usr/bin/env python3
"""
Phone-side client: upload the field photo + 4 corners to the Pi and let the
Pi do the CV, exactly like the Android app's "Send image to Pi" button.

Usage:
    python3 Navigation/sim/phone_client.py --image <photo> --corners tl,tr,br,bl
"""
import argparse
import base64
import json
import os
import sys
import time
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, "Navigation", "src"))

from pi_discovery import discover_pi, pi_base_url  # noqa: E402


def post_json(url, payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.loads(resp.read().decode())


def get_json(url):
    with urllib.request.urlopen(url, timeout=15) as resp:
        return json.loads(resp.read().decode())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", default=os.path.join(REPO, "Navigation", "images", "field_topview.jpeg"))
    ap.add_argument("--corners", default=None,
                    help="tl,tr,br,bl as pixel x,y pairs in the original photo")
    ap.add_argument("--server", default=None)
    ap.add_argument("--width", type=float, default=6.0)
    ap.add_argument("--length", type=float, default=8.0)
    ap.add_argument("--rows", type=int, default=9)
    args = ap.parse_args()

    server = args.server
    if not server:
        info = discover_pi(timeout=3.0)
        print(f"[PHONE] Pi: {info}")
        server = pi_base_url(info)

    with open(args.image, "rb") as fh:
        image_b64 = base64.b64encode(fh.read()).decode()

    if args.corners:
        pts = []
        for pair in args.corners.split(","):
            x, y = pair.split(":")
            pts.append({"x": float(x), "y": float(y)})
    else:
        # default: the tomato-field rectangle of the sample photo
        import cv2
        img = cv2.imread(args.image)
        h, w = img.shape[:2]
        pts = [
            {"x": 0.19 * w, "y": 0.13 * h},
            {"x": 0.75 * w, "y": 0.13 * h},
            {"x": 0.75 * w, "y": 0.87 * h},
            {"x": 0.19 * w, "y": 0.87 * h},
        ]

    payload = {
        "image": image_b64,
        "corners": pts,
        "field": {"widthM": args.width, "lengthM": args.length, "totalRows": args.rows},
    }

    print(f"[PHONE] uploading photo to {server}/image ...")
    result = post_json(f"{server}/image", payload)
    print(f"[PHONE] Pi answered: accepted={result.get('accepted')} "
          f"rows={result.get('rows')} waypoints={result.get('waypoints')} "
          f"distance={result.get('distanceM')}m")
    analysis = result.get("analysis") or {}
    print(f"[PHONE] Pi analysis: veg={analysis.get('vegetationRatio')} "
          f"exg={analysis.get('exgThreshold')} warnings={analysis.get('warnings')}")
    print(f"[PHONE] artifacts: {result.get('bevUrl')} {result.get('overlayUrl')}")

    print("[PHONE] polling status ...")
    for _ in range(600):
        status = get_json(f"{server}/status")
        print(f"[PHONE] state={status.get('state')} rows={status.get('rowsDone')}/"
              f"{status.get('rowsTotal')} killed={status.get('weedsKilled')} "
              f"remaining={status.get('weedsRemaining')}")
        if status.get("finished"):
            print(f"[PHONE] finished: {json.dumps(status, indent=2)}")
            break
        time.sleep(1.0)


if __name__ == "__main__":
    main()
