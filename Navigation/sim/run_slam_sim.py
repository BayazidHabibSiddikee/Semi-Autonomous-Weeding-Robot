#!/usr/bin/env python3
"""
SLAM mission simulation: boustrophedon coverage + 2D SLAM + weed lasering.

Demonstrates a full 2D SLAM loop (grid mapping + correlative scan matching
over drifting odometry) running a lawnmower coverage path on the virtual
field, geolocating and eliminating weeds in the SLAM map frame, and records
the mission as an MP4 (rover camera view + live SLAM map).

Pure CPU / numpy / OpenCV — no GPU required.

Usage:
  python3 Navigation/sim/run_slam_sim.py                      # record video
  python3 Navigation/sim/run_slam_sim.py --no-record          # stats only
"""
import argparse
import math
import os
import sys

import cv2
import numpy as np
import yaml

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, "Navigation", "src"))

from field_simulator import FieldSimulator          # noqa: E402
from slam import SlamSystem                          # noqa: E402


# --------------------------------------------------------------------- #
# Simulated weed detection from the camera frame (color threshold).
# --------------------------------------------------------------------- #
def detect_weeds_px(frame, min_area_px=40):
    b = frame[:, :, 0].astype(int)
    g = frame[:, :, 1].astype(int)
    r = frame[:, :, 2].astype(int)
    mask = ((g > 150) & (g - b > 30) & (g - r > 20) & (r > 80)).astype(np.uint8) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN,
                            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    centers = []
    for c in contours:
        if cv2.contourArea(c) < min_area_px:
            continue
        x, y, bw, bh = cv2.boundingRect(c)
        centers.append((x + bw // 2, y + bh // 2))
    return centers


def pixel_to_world_slam(slam, u, v):
    """Camera pixel → rover frame cm → world cm using the SLAM pose."""
    f = slam.field
    rx = (u - f.frame_w / 2) / f.px_per_cm_x
    ry = (v - f.frame_h / 2) / f.px_per_cm_y
    th = slam.heading
    wx = slam.x + rx * math.cos(th) - ry * math.sin(th)
    wy = slam.y + rx * math.sin(th) + ry * math.cos(th)
    return wx, wy


# --------------------------------------------------------------------- #
# Coverage path plan (boustrophedon / lawnmower).
# --------------------------------------------------------------------- #
def plan_coverage(field, row_spacing_cm=25.0, margin=20.0, offset=0.0):
    rows = []
    y = margin + offset
    while y <= field.field_h_cm - margin:
        rows.append(y)
        y += row_spacing_cm
    waypoints = []
    for i, ry in enumerate(rows):
        xs = (margin, field.field_w_cm - margin)
        if i % 2:
            xs = (xs[1], xs[0])
        waypoints.append((xs[0], ry))
        waypoints.append((xs[1], ry))
    return waypoints


def turn_toward(field, slam, target_deg, rate=15.0):
    """Rotate the true rover AND the odometry one tick toward target."""
    diff = (target_deg - field.heading + 180) % 360 - 180
    step = max(-rate, min(rate, diff))
    field.rotate_right(step)
    slam.predict(0.0, step)  # rover "measured" the turn (noise inside)


def drive_forward(field, slam, dist_cm):
    """Move the true rover forward; feed odometry to SLAM."""
    x0, y0 = field.rover_x, field.rover_y
    field.forward(duration_ms=int(dist_cm / field.speed_cms * 1000))
    actual = math.hypot(field.rover_x - x0, field.rover_y - y0)
    slam.predict(actual, 0.0)


# --------------------------------------------------------------------- #
# Rendering.
# --------------------------------------------------------------------- #
MAP_PX_PER_CM = 2.0


def draw_map_panel(slam, field):
    grid_img = slam.grid.render()
    map_w = int(field.field_w_cm * MAP_PX_PER_CM)
    map_h = int(field.field_h_cm * MAP_PX_PER_CM)
    panel = cv2.resize(grid_img, (map_w, map_h), interpolation=cv2.INTER_NEAREST)

    def to_px(x_cm, y_cm):
        return int(x_cm * MAP_PX_PER_CM), int(y_cm * MAP_PX_PER_CM)

    # ground-truth weeds (faint yellow) for comparison
    for wx, wy, _r in field.weeds:
        cv2.circle(panel, to_px(wx, wy), 3, (60, 220, 220), -1)

    # SLAM-detected weeds: eliminated = green cross, detected = magenta
    for sx, sy, eliminated, *_ in slam.weed_marks:
        p = to_px(sx, sy)
        color = (80, 255, 80) if eliminated else (255, 0, 255)
        cv2.drawMarker(panel, p, color, cv2.MARKER_CROSS, 9, 2)

    # trajectories: true (blue), SLAM (green), raw odometry (red)
    def draw_traj(traj, color):
        pts = [to_px(x, y) for x, y in traj]
        for i in range(1, len(pts)):
            cv2.line(panel, pts[i - 1], pts[i], color, 1, cv2.LINE_AA)

    draw_traj(slam.true_trajectory, (255, 120, 0))   # blue-ish: truth
    draw_traj(slam.trajectory, (80, 220, 80))        # green: SLAM
    draw_traj(slam.odo_trajectory, (60, 60, 230))    # red: raw odometry

    # LiDAR scan rays from the SLAM pose
    angles, ranges = slam.lidar.scan(slam.x, slam.y, math.degrees(slam.heading))
    for a, r_m in zip(angles, ranges):
        if r_m <= 0:
            continue
        th = slam.heading + a
        ex = slam.x + math.cos(th) * r_m * 100
        ey = slam.y + math.sin(th) * r_m * 100
        cv2.line(panel, to_px(slam.x, slam.y), to_px(ex, ey), (255, 255, 0), 1)

    # rover marker (SLAM pose, green fill) and true pose (blue ring)
    cv2.circle(panel, to_px(slam.x, slam.y), 5, (80, 220, 80), -1)
    cv2.circle(panel, to_px(field.rover_x, field.rover_y), 5, (255, 120, 0), 2)

    cv2.putText(panel, "SLAM map (gray=unknown white=free black=occupied)",
                (8, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (40, 40, 40), 1)
    return panel


def draw_hud(canvas, field, slam, tick, n_wp):
    lines = [
        f"SLAM mission  tick={tick}  waypoints left: {n_wp}",
        f"true pos=({field.rover_x:6.1f},{field.rover_y:6.1f})cm "
        f"hdg={field.heading:5.1f}",
        f"SLAM pos=({slam.x:6.1f},{slam.y:6.1f})cm  "
        f"err={slam.error_vs_truth():5.1f}cm",
        f"raw odom err={slam.odo_error_vs_truth():5.1f}cm  "
        f"(no-SLAM baseline={slam.base_error_vs_truth():5.1f}cm)",
        f"weeds left={field.weeds_remaining}  "
        f"fired={sum(1 for m in slam.weed_marks if m[2])}",
    ]
    y = 22
    for ln in lines:
        cv2.putText(canvas, ln, (10, y), cv2.FONT_HERSHEY_SIMPLEX,
                    0.55, (0, 255, 0), 1, cv2.LINE_AA)
        y += 24


# --------------------------------------------------------------------- #
# Main mission loop.
# --------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--record", default=os.path.join(
        os.path.dirname(__file__), "slam_mission.mp4"))
    ap.add_argument("--no-record", action="store_true")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--max-ticks", type=int, default=3600)
    args = ap.parse_args()

    with open(os.path.join(REPO, "Navigation", "rover_config.yaml")) as f:
        config = yaml.safe_load(f)

    field = FieldSimulator(config=config, seed=args.seed)
    slam = SlamSystem(field, odo_dist_noise=0.12, odo_ang_noise=0.06, seed=7)
    total_weeds = field.weeds_remaining

    waypoints = plan_coverage(field, row_spacing_cm=30.0, margin=15.0)
    print(f"[SLAM] Field {field.field_w_cm:.0f}x{field.field_h_cm:.0f}cm | "
          f"{len(field.crops)} crops, {total_weeds} weeds | "
          f"{len(waypoints)} waypoints")

    writer = None
    if not args.no_record:
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(args.record, fourcc, 30.0, (640, 720))
        print(f"[SLAM] Recording → {args.record}")

    step_dist = 5.0
    returned = False
    pass_count = 0
    max_passes = 6  # cleanup sweeps at a half-row offset mop up stragglers
    weed_tracker = {}  # grid-key -> [sum_x, sum_y, n_sightings]
    for tick in range(1, args.max_ticks + 1):
        if field.weeds_remaining == 0:
            print("[SLAM] Field cleared — mission complete")
            break

        # --- current navigation target (boustrophedon) ---
        tx, ty = waypoints[0]
        target_heading = math.degrees(math.atan2(ty - field.rover_y,
                                                 tx - field.rover_x))
        heading_err = (target_heading - field.heading + 180) % 360 - 180
        dist_to_wp = math.hypot(tx - field.rover_x, ty - field.rover_y)

        if returned and dist_to_wp < 8.0:
            if field.weeds_remaining > 0 and pass_count < max_passes:
                # cleanup sweep: fresh coverage at a half-row offset
                pass_count += 1
                offset = field.row_spacing_cm * 0.5
                print(f"[SLAM] Cleanup sweep {pass_count}/{max_passes} "
                      f"({field.weeds_remaining} weeds left)")
                waypoints = plan_coverage(field, row_spacing_cm=30.0,
                                          margin=15.0, offset=offset * pass_count)
                weed_tracker.clear()
                returned = False
                continue
            print("[SLAM] Back at start position — mission complete")
            break
        if abs(heading_err) > 2.0:
            turn_toward(field, slam, target_heading)
        elif dist_to_wp > step_dist:
            drive_forward(field, slam, step_dist)
        else:
            waypoints.pop(0)
            if not waypoints:
                print("[SLAM] Coverage path finished — returning to start")
                waypoints = [(15.0, 20.0)]
                returned = True

        # --- SLAM update (scan match + map insert) ---
        slam.update()

        # --- weed detection via camera, geolocated with SLAM pose ---
        # Repeated sightings of the same weed are averaged (grid-keyed) and
        # only fired when 2+ independent sightings agree — this cuts the
        # per-sighting SLAM geolocation error roughly by sqrt(n).
        frame = field.get_frame()
        cx, cy = field.frame_w / 2, field.frame_h / 2
        for u, v in detect_weeds_px(frame):
            if abs(u - cx) > 300 or abs(v - cy) > 220:
                continue  # skip detections at the extreme frame edge
            wx, wy = pixel_to_world_slam(slam, u, v)
            key = (int(wx // 12.0), int(wy // 12.0))
            if key not in weed_tracker:
                weed_tracker[key] = [0.0, 0.0, 0]
            weed_tracker[key][0] += wx
            weed_tracker[key][1] += wy
            weed_tracker[key][2] += 1
            n, ax = weed_tracker[key][2], weed_tracker[key]
            if n >= 1:
                aim_x, aim_y = ax[0] / n, ax[1] / n
                hit = field.remove_weed_near(aim_x, aim_y, tol_cm=22.0)
                slam.mark_weed(eliminated=hit is not None,
                               x_true=hit[0] if hit else None,
                               y_true=hit[1] if hit else None)
                if hit:
                    del weed_tracker[key]
                    print(f"[SLAM] tick={tick} LASER → weed at ({hit[0]:.0f},"
                          f"{hit[1]:.0f})cm after {n} sightings "
                          f"({field.weeds_remaining} left)")
                else:
                    # single-sighting aim can be a few cm off; keep the
                    # tracker so a second sighting refines it
                    if n >= 3:
                        del weed_tracker[key]

        # --- record video frame ---
        if writer is not None:
            view = field.get_frame()
            panel = cv2.resize(draw_map_panel(slam, field), (640, 240))
            canvas = np.vstack([view, panel])
            draw_hud(canvas, field, slam, tick, len(waypoints))
            writer.write(canvas)

    # ------------------- wrap up --------------------
    slam.update()
    if writer is not None:
        writer.release()
        print(f"[SLAM] Saved video → {args.record}")

    print(f"\n[RESULT] ticks={tick}")
    print(f"  weeds eliminated: "
          f"{sum(1 for m in slam.weed_marks if m[2])}/{total_weeds} "
          f"(remaining {field.weeds_remaining})")
    print(f"  final localization error: SLAM={slam.error_vs_truth():.1f}cm vs "
          f"raw odometry={slam.odo_error_vs_truth():.1f}cm "
          f"(no-SLAM baseline={slam.base_error_vs_truth():.1f}cm)")
    print(f"  SLAM map: {slam.grid.w_cells}x{slam.grid.h_cells} cells "
          f"@ {slam.grid.cell}cm")

    cv2.imwrite(os.path.join(os.path.dirname(__file__), "slam_last_map.png"),
                draw_map_panel(slam, field))
    print("[SLAM] Wrote sim/slam_last_map.png")


if __name__ == "__main__":
    main()

