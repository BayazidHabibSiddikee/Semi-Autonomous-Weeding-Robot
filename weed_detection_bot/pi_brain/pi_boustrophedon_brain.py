import os
import time
import math
import threading
import serial
from collections import deque
import requests
import numpy as np
import cv2
from ultralytics import YOLO
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, Response

app = FastAPI(title="Weed Rover Boustrophedon & Targeting Brain")

# =========================================================================
# 1. HARDWARE, 30-DEG CAMERA & CLIP RECORDING CONFIG
# =========================================================================
HOST = os.environ.get("MAIXSENSE_HOST", "192.168.233.1")
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(BASE_DIR, "..", "yolo_models", "best.pt")
CLIP_DIR = os.path.join(BASE_DIR, "..", "..", "bad_chilli_clips")
os.makedirs(CLIP_DIR, exist_ok=True)

CAM_HEIGHT_MM = 200.0          # 20 cm camera height above furrow
CAM_PITCH_DEG = 30.0           # 30-degree downward tilt
PITCH_RAD = math.radians(CAM_PITCH_DEG)
COS_P, SIN_P = math.cos(PITCH_RAD), math.sin(PITCH_RAD)

FX, FY = 280.0, 280.0          # MaixSense-A075V intrinsic parameters
CX, CY = 160.0, 120.0

TOOL_OFFSET_Y_MM = 140.0       # Distance from front camera lens to cylinder tool center
TOOL_RADIUS_MM   = 85.0        # Radial offset of grinder/flame nozzle from cylinder center
CORRIDOR_HALF_W  = 125.0       # Furrow half-width (reachability window)

FIELD_W_CM, FIELD_H_CM = 600, 800
NUM_ROWS = 10
ROW_SPACING_CM = FIELD_W_CM // (NUM_ROWS + 1)

print(f"Loading YOLO model from: {MODEL_PATH}")
model = YOLO(MODEL_PATH)
lock = threading.Lock()
latest_video_jpg = None
latest_map_jpg = None

# Rolling ring buffer (~3 seconds at 15 FPS) for saving bad chili clips
frame_ring_buffer = deque(maxlen=45)
last_clip_save_time = 0.0
CLIP_COOLDOWN_SEC = 6.0        # Avoid duplicate recordings of the same plant

rover_state = {
    "esp32_dir_8way": 0,       # Discrete 8-path command: 0, 45, 90, 135, 180, 225, 270, 315
    "current_row": 1,
    "direction": 1,            # +1 = North, -1 = South
    "x_cm": float(ROW_SPACING_CM),
    "y_cm": 50.0,
    "turret_angle_deg": 0.0,
    "corner_detected": False,
    "ordered_cut_queue": [],
    "bad_chilli_clips_saved": []
}

# Persistent 2D top-down Boustrophedon map
boustrophedon_map = np.full((FIELD_H_CM, FIELD_W_CM, 3), (35, 40, 35), dtype=np.uint8)
for r in range(1, NUM_ROWS + 1):
    rx = r * ROW_SPACING_CM
    cv2.line(boustrophedon_map, (rx, 50), (rx, FIELD_H_CM - 50), (75, 75, 75), 1)
    if r < NUM_ROWS:
        ty = FIELD_H_CM - 50 if (r % 2 == 1) else 50
        cv2.line(boustrophedon_map, (rx, ty), ((r + 1) * ROW_SPACING_CM, ty), (100, 100, 60), 1)

# =========================================================================
# 2. 30-DEGREE 3D PROJECTION & 8-DIRECTION HEADING
# =========================================================================
def pixel_to_ground_30deg(u, v, depth_mm):
    """Converts pixel (u,v) + depth to 3D ground coordinates under 30 deg pitch."""
    if depth_mm <= 180 or depth_mm >= 2000:
        return None
    xc = ((u - CX) * depth_mm) / FX
    yc = ((v - CY) * depth_mm) / FY
    zc = float(depth_mm)
    x_ground = xc
    y_fwd = zc * COS_P - yc * SIN_P
    z_h = CAM_HEIGHT_MM - (zc * SIN_P + yc * COS_P)
    return x_ground, y_fwd, z_h

def compute_8way_heading(depth_map, current_row, has_immediate_weed):
    """
    Computes Bird's-Eye-View corridor error & headland corners.
    Returns:
      (dir_8way, is_corner, steer_err) where dir_8way in {0, 45, 90, 135, 180, 225, 270, 315}
    """
    v_idx, u_idx = np.mgrid[0:240:4, 0:320:4]
    d = depth_map[0:240:4, 0:320:4].astype(np.float32)
    valid = (d > 200) & (d < 1950)

    xc = ((u_idx - CX) * d) / FX
    yc = ((v_idx - CY) * d) / FY
    y_fwd = d * COS_P - yc * SIN_P
    z_h   = CAM_HEIGHT_MM - (d * SIN_P + yc * COS_P)

    # Emergency front bumper clearance (<180 mm)
    if np.any(valid & (np.abs(xc) < 70.0) & (y_fwd < 180.0)):
        return 180, False, 0.0

    wall_mask = valid & (z_h > 60.0) & (y_fwd > 150.0) & (y_fwd < 1400.0)
    left_pts_x  = xc[wall_mask & (xc < -30.0)]
    right_pts_x = xc[wall_mask & (xc > 30.0)]
    wall_pts_y  = y_fwd[wall_mask]

    left_dist  = float(np.median(np.abs(left_pts_x))) if left_pts_x.size > 5 else 250.0
    right_dist = float(np.median(right_pts_x)) if right_pts_x.size > 5 else 250.0
    steer_err  = left_dist - right_dist

    # Headland Corner check: do crop walls terminate ahead?
    max_wall_y = float(np.percentile(wall_pts_y, 90)) if wall_pts_y.size > 10 else 300.0
    if max_wall_y < 520.0 and not has_immediate_weed:
        turn_dir = 90 if (current_row % 2 == 1) else 270
        return turn_dir, True, steer_err

    # Quantize furrow error into 0 (Straight), 45 (Veer Right), 315 (Veer Left)
    if steer_err < -25.0:
        return 45, False, steer_err
    elif steer_err > 25.0:
        return 315, False, steer_err
    return 0, False, steer_err

# =========================================================================
# 3. PASSIVE CHILI CANOPY HEALTH SCANNER (ZERO AI OVERHEAD)
# =========================================================================
def save_bad_chilli_clip_async(frames_list, snapshot_img, row_id, side_label, y_cm):
    """Background task to save MP4 clip and snapshot."""
    ts = time.strftime("%Y%m%d_%H%M%S")
    clip_name = f"row{row_id}_{side_label}_{int(y_cm)}cm_{ts}.mp4"
    snap_name = f"row{row_id}_{side_label}_{int(y_cm)}cm_{ts}.jpg"
    clip_path = os.path.join(CLIP_DIR, clip_name)
    snap_path = os.path.join(CLIP_DIR, snap_name)

    cv2.imwrite(snap_path, snapshot_img)
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    out = cv2.VideoWriter(clip_path, fourcc, 15.0, (320, 240))
    for f in frames_list:
        out.write(f)
    out.release()

    with lock:
        rover_state["bad_chilli_clips_saved"].append(clip_name)
    print(f"[HEALTH SCANNER] Saved clip: {clip_name}")

def passive_chili_canopy_scanner(rgb_img, depth_map, weed_boxes):
    """Inspects elevated side chili walls (|X| > 80mm, Z > 80mm) outside weed bboxes."""
    global last_clip_save_time
    canopy_mask = np.ones((240, 320), dtype=bool)
    for (x1, y1, x2, y2) in weed_boxes:
        canopy_mask[max(0, y1):min(240, y2), max(0, x1):min(320, x2)] = False

    v_idx, u_idx = np.mgrid[0:240, 0:320]
    d = depth_map.astype(np.float32)
    valid = (d > 220) & (d < 1200) & canopy_mask

    xc = ((u_idx - CX) * d) / FX
    yc = ((v_idx - CY) * d) / FY
    z_h = CAM_HEIGHT_MM - (d * SIN_P + yc * COS_P)

    hsv = cv2.cvtColor(rgb_img, cv2.COLOR_BGR2HSV)
    # Yellowing / mosaic / brown necrosis range
    bad_color_mask = cv2.inRange(hsv, np.array([10, 55, 50]), np.array([30, 255, 255])) > 0

    for side_label, side_cond, box_roi in [
        ("LEFT_ROW", xc < -80.0, (5, 40, 95, 190)),
        ("RIGHT_ROW", xc > 80.0, (225, 40, 315, 190))
    ]:
        crop_pixels = valid & side_cond & (z_h > 80.0)
        total_crop_px = int(np.count_nonzero(crop_pixels))
        if total_crop_px < 250:
            continue

        bad_px = int(np.count_nonzero(crop_pixels & bad_color_mask))
        bad_ratio = bad_px / float(total_crop_px)

        if bad_ratio > 0.28:
            bx1, by1, bx2, by2 = box_roi
            cv2.rectangle(rgb_img, (bx1, by1), (bx2, by2), (0, 140, 255), 2)
            cv2.putText(rgb_img, f"BAD CHILI ({side_label}) {int(bad_ratio*100)}%",
                        (bx1, by1 - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (0, 140, 255), 1)

            now = time.time()
            if now - last_clip_save_time > CLIP_COOLDOWN_SEC and len(frame_ring_buffer) > 10:
                last_clip_save_time = now
                frames_copy = list(frame_ring_buffer)
                snap_copy = rgb_img.copy()
                with lock:
                    r_id = rover_state["current_row"]
                    ry_cm = rover_state["y_cm"]
                    rx_cm = rover_state["x_cm"] + (-15 if side_label == "LEFT_ROW" else 15)
                    if 0 <= rx_cm < FIELD_W_CM and 0 <= int(ry_cm) < FIELD_H_CM:
                        cv2.circle(boustrophedon_map, (int(rx_cm), int(ry_cm)), 4, (0, 140, 255), -1)

                threading.Thread(
                    target=save_bad_chilli_clip_async,
                    args=(frames_copy, snap_copy, r_id, side_label, ry_cm),
                    daemon=True
                ).start()

# =========================================================================
# 4. WEED CUT-POINT & PRIORITY QUEUE
# =========================================================================
def build_weed_cut_queue(results, rgb_img, depth_map, current_turret_deg):
    weeds = []
    weed_boxes = []
    for r in results:
        for box in r.boxes:
            x1, y1, x2, y2 = map(int, box.xyxy[0].tolist())
            weed_boxes.append((x1, y1, x2, y2))
            u_cut = (x1 + x2) // 2
            v_cut = max(0, min(239, y2 - max(2, int(0.10 * (y2 - y1)))))

            patch = depth_map[max(0, v_cut-2):min(240, v_cut+3), max(0, u_cut-2):min(320, u_cut+3)]
            valid_p = patch[(patch > 180) & (patch < 1900)]
            if valid_p.size == 0:
                continue
            coords = pixel_to_ground_30deg(u_cut, v_cut, float(np.median(valid_p)))
            if coords is None:
                continue
            x_g, y_f, _ = coords

            if abs(x_g) <= CORRIDOR_HALF_W:
                drive_mm = round(y_f - TOOL_OFFSET_Y_MM, 1)
                turret_deg = round(math.degrees(math.asin(max(-1.0, min(1.0, x_g / TOOL_RADIUS_MM)))), 1)
                weeds.append({
                    "bbox": (x1, y1, x2, y2),
                    "cut_px": (u_cut, v_cut),
                    "x_ground_mm": round(x_g, 1),
                    "y_forward_mm": round(y_f, 1),
                    "drive_to_cut_mm": drive_mm,
                    "turret_deg": turret_deg,
                    "band": int(y_f // 30.0),
                    "slew_cost": abs(turret_deg - current_turret_deg)
                })

    ordered = sorted(weeds, key=lambda w: (w["band"], w["slew_cost"]))
    for idx, w in enumerate(ordered):
        rank = idx + 1
        x1, y1, x2, y2 = w["bbox"]
        uc, vc = w["cut_px"]
        w["order_rank"] = rank
        color = (0, 0, 255) if rank == 1 else (0, 255, 0)
        cv2.rectangle(rgb_img, (x1, y1), (x2, y2), color, 2)
        cv2.circle(rgb_img, (uc, vc), 4, (255, 0, 255), -1)
        cv2.putText(rgb_img, f"#{rank} Go:{w['drive_to_cut_mm']}mm Ang:{w['turret_deg']}d",
                    (x1, max(12, y1 - 5)), cv2.FONT_HERSHEY_SIMPLEX, 0.36, color, 1)
    return ordered, weed_boxes

# =========================================================================
# 5. CAMERA INTERFACE & MASTER CONTROL LOOP
# =========================================================================
def init_maixsense_camera():
    """Initializes MaixSense-A075V stream with 16-bit depth + JPEG RGB."""
    import struct
    try:
        cfg = struct.pack("<BBBBBBBBi", 1, 1, 255, 0, 0, 7, 1, 0, 0)
        r = requests.post(f"http://{HOST}/set_cfg", data=cfg, timeout=2.0)
        return r.status_code == 200
    except Exception as e:
        print("[CAMERA] set_cfg notice:", e)
        return False

def fetch_maixsense():
    try:
        r = requests.get(f"http://{HOST}/getdeep", timeout=1.5)
        if r.status_code != 200 or len(r.content) < 153628:
            return None, None
        payload = r.content[28:]
        depth = np.frombuffer(payload[:153600], dtype=np.uint16).reshape((240, 320))
        if np.median(depth) > 4000:
            depth = depth >> 2
        jpg_idx = payload.find(b"\xff\xd8", 153600)
        rgb = cv2.imdecode(np.frombuffer(payload[jpg_idx:], dtype=np.uint8), cv2.IMREAD_COLOR) if jpg_idx != -1 else None
        return depth, rgb
    except Exception:
        return None, None

def pi_master_loop():
    global latest_video_jpg, latest_map_jpg
    init_maixsense_camera()
    print("[MASTER LOOP] MaixSense stream initialized.")
    while True:
        depth, rgb = fetch_maixsense()
        if depth is None or rgb is None:
            time.sleep(0.03)
            continue

        rgb_320 = cv2.resize(rgb, (320, 240))
        results = model(rgb_320, verbose=False)

        with lock:
            cur_ang = rover_state["turret_angle_deg"]
            cur_row = rover_state["current_row"]

        ordered_weeds, weed_boxes = build_weed_cut_queue(results, rgb_320, depth, cur_ang)
        passive_chili_canopy_scanner(rgb_320, depth, weed_boxes)

        has_close_weed = len(ordered_weeds) > 0 and ordered_weeds[0]["drive_to_cut_mm"] <= 15.0
        dir_8way, is_corner, steer_err = compute_8way_heading(depth, cur_row, has_close_weed)

        cv2.putText(rgb_320, f"ESP32 Dir:{dir_8way}deg | Err:{int(steer_err)}mm",
                    (8, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 0), 1)
        frame_ring_buffer.append(rgb_320.copy())

        with lock:
            rover_state["esp32_dir_8way"] = dir_8way
            rover_state["corner_detected"] = is_corner
            rover_state["ordered_cut_queue"] = [
                {k: v for k, v in w.items() if k not in ("bbox", "cut_px")}
                for w in ordered_weeds
            ]

            # Update live position & cut targets on map
            rx, ry = int(rover_state["x_cm"]), int(rover_state["y_cm"])
            cv2.circle(boustrophedon_map, (rx, ry), 2, (255, 200, 0), -1)

            if ordered_weeds:
                first_w = ordered_weeds[0]
                wx = int(rx + first_w["x_ground_mm"] / 10.0)
                wy = int(ry + rover_state["direction"] * (first_w["y_forward_mm"] / 10.0))
                if 0 <= wx < FIELD_W_CM and 0 <= wy < FIELD_H_CM:
                    cv2.circle(boustrophedon_map, (wx, wy), 3, (0, 0, 255), -1)

            map_view = boustrophedon_map.copy()
            cv2.circle(map_view, (rx, ry), 6, (0, 255, 255), 2)

            _, v_jpg = cv2.imencode(".jpg", rgb_320)
            _, m_jpg = cv2.imencode(".jpg", map_view)
            latest_video_jpg = v_jpg.tobytes()
            latest_map_jpg = m_jpg.tobytes()

# =========================================================================
# ESP32 HARDWARE USB SERIAL & NETWORK BRIDGE
# =========================================================================
esp32_serial = None
esp32_lock = threading.Lock()

def get_esp32_serial():
    global esp32_serial
    if esp32_serial is not None and getattr(esp32_serial, "is_open", False):
        return esp32_serial
    for p in ["/dev/ttyUSB0", "/dev/ttyUSB1", "/dev/ttyACM0"]:
        if os.path.exists(p):
            try:
                s = serial.Serial(p, 115200, timeout=0.1)
                esp32_serial = s
                print(f"[ESP32 BRIDGE] Connected on {p}")
                return esp32_serial
            except Exception as e:
                print(f"[ESP32 BRIDGE] Port {p} open error: {e}")
    return None

def send_esp32_cmd(cmd: str):
    with esp32_lock:
        s = get_esp32_serial()
        if s:
            try:
                s.write(f"{cmd.strip()}\n".encode("ascii"))
                s.flush()
                return
            except Exception as e:
                print(f"[ESP32 BRIDGE] Serial write error: {e}")
        # Fallback to HTTP if ESP32 Wi-Fi is reachable at 192.168.4.1
        try:
            requests.get(f"http://192.168.4.1/cmd?q={cmd.strip()}", timeout=0.2)
        except Exception:
            pass

def send_esp32_dir(angle: int, speed: int = 28):
    if angle in (0, 360):
        cmd = "FORWARD"
    elif angle == 180:
        cmd = "BACKWARD"
    elif angle in (90, 45, 135):
        cmd = "RIGHT"
    elif angle in (270, 225, 315):
        cmd = "LEFT"
    else:
        cmd = f"DIR {angle} {speed}"
    send_esp32_cmd(cmd)

def send_esp32_stop():
    send_esp32_cmd("STOP")

@app.get("/api/frame.jpg")
def api_frame():
    with lock:
        f = latest_video_jpg
    if f:
        return Response(content=f, media_type="image/jpeg")
    return Response(content=b"", status_code=503)

@app.get("/api/status")
def api_status():
    with lock:
        st = dict(rover_state)
        st["mode"] = rover_state.get("mode", "autonomous")
        st["esp32_online"] = esp32_serial is not None and getattr(esp32_serial, "is_open", False)
        st["camera_online"] = latest_video_jpg is not None
        st["version"] = "pi4-weed-boustrophedon-v2"
        return st

@app.post("/api/dir")
async def api_dir(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    angle = int(body.get("angle", 0))
    speed = int(body.get("speed", 28))
    send_esp32_dir(angle, speed)
    return {"ok": True, "angle": angle, "speed": speed}

@app.post("/api/stop")
def api_stop():
    send_esp32_stop()
    return {"ok": True, "action": "STOP"}

@app.post("/api/mode")
async def api_mode(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    m = str(body.get("mode", "autonomous"))
    with lock:
        rover_state["mode"] = m
    return {"ok": True, "mode": m}

@app.post("/api/servo")
async def api_servo(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    deg = int(body.get("angle_deg", 0))
    send_esp32_cmd(f"SERVO {deg}")
    return {"ok": True, "servo_deg": deg}

@app.post("/api/arc")
async def api_arc(request: Request):
    try:
        body = await request.json()
    except Exception:
        body = {}
    act = str(body.get("action", "pulse")).lower()
    dur = int(body.get("duration_ms", 800))
    cmd = "ARC OFF" if act == "off" else f"ARC {dur}"
    send_esp32_cmd(cmd)
    return {"ok": True, "arc": cmd}

@app.get("/video_feed")
def video_feed():
    def gen():
        while True:
            with lock:
                f = latest_video_jpg
            if f:
                yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + f + b"\r\n"
            else:
                time.sleep(0.03)
    return StreamingResponse(gen(), media_type="multipart/x-mixed-replace; boundary=frame")

@app.get("/map_feed")
def map_feed():
    def gen():
        while True:
            with lock:
                m = latest_map_jpg
            if m:
                yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + m + b"\r\n"
            else:
                time.sleep(0.05)
    return StreamingResponse(gen(), media_type="multipart/x-mixed-replace; boundary=frame")

@app.get("/cut_plan")
def get_cut_plan():
    with lock:
        return rover_state

if __name__ == "__main__":
    t = threading.Thread(target=pi_master_loop, daemon=True)
    t.start()
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
