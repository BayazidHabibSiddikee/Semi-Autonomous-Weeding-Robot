#!/usr/bin/env python3
"""
Tilt-robustness benchmark for the photo -> BEV -> rows -> mission pipeline.

Generates synthetic fields with KNOWN crop-row ground truth (gappy, thin
rows, weed clutter), renders them as if photographed by a tilted phone
camera (pinhole projection of a plane rotated about the horizontal axis:
keystone + foreshortening + growing ground sampling distance toward the far
edge), adds lighting gradient / blur / JPEG realism and imperfect corner
taps, then runs the exact production pipeline (analyze_field_photo) using
the projected field corners as the "tapped corners".

Arms per photo:
  reg : production pipeline (merge_segments + regularize with expected_rows)
  raw : same pipeline with regularize disabled (identity)  [ablation]

Experiments
  1. tilt sweep     : angle 0..60 deg at 3 px corner-tap noise
  2. corner sweep   : corner-tap noise 0..16 px at 30 deg tilt

Metrics
  row-count error, exact row-count rate, row position error (m, when the
  count matches), mission waypoint-count error, end-to-end wall time.

Outputs
  docs/paper/results/tilt_sweep.json   full per-trial records + aggregates
  docs/paper/results/tilt_sweep.csv    per-angle aggregate table
  docs/paper/figures/                  example photo/BEV/overlay triptychs

Run:
    python3 Navigation/benchmarks/tilt_sweep.py
"""
from __future__ import annotations

import json
import math
import os
import sys
import time
from collections import defaultdict

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "src")
sys.path.insert(0, SRC)

import field_pipeline                        # noqa: E402
from field_pipeline import analyze_field_photo  # noqa: E402
from mission_planner import build_mission_json  # noqa: E402

# ---------------------------------------------------------------- config
ANGLES = [0, 10, 20, 30, 40, 50, 60]
SEEDS = 8
WIDTH_M, LENGTH_M = 6.0, 12.0
ROW_COUNTS = [5, 10]           # pitch 1.2 m (easy) vs 0.6 m (realistic, hard)
PX_PER_M = 100
PHOTO_LONG_PX = 1100
CORNER_NOISE_PX = 3.0          # main sweep: realistic imperfect corner taps
CORNER_SWEEP_PX = [0, 2, 4, 8, 16]   # second experiment, fixed 30 deg tilt
OUT_DIR = "/tmp/opencode/bench_out"
RESULTS = os.path.join(HERE, "..", "..", "docs", "paper", "results")
FIGURES = os.path.join(HERE, "..", "..", "docs", "paper", "figures")


# ------------------------------------------------------- synthetic fields
def make_field_bev(width_m: float, length_m: float, n_rows: int,
                   px_per_m: int, rng: np.random.Generator) -> np.ndarray:
    """Top-down field texture: soil, gappy thin crop bands, weeds."""
    W = int(round(width_m * px_per_m))
    H = int(round(length_m * px_per_m))

    # soil: brown base + pixel grain + low-frequency mottling
    img = np.empty((H, W, 3), np.float32)
    img[:, :] = (48, 88, 128)                       # BGR brown
    img += rng.normal(0, 12, (H, W, 1))
    mottle = cv2.GaussianBlur(
        rng.normal(0, 1, (H, W)).astype(np.float32), (0, 0), 31)
    img += mottle[:, :, None] * np.array([10, 14, 18], np.float32)

    # crop rows: thin vertical bands broken into plant-run segments
    row_half = 0.075 * px_per_m * rng.uniform(0.8, 1.3)   # ~0.15 m rows
    run_mu, gap_mu = 1.2 * px_per_m, 0.5 * px_per_m       # on/off lengths
    for i in range(n_rows):
        cx = (i + 0.5) * W / n_rows
        jitter = rng.normal(0, 1.5, (H, 1))
        dist = np.abs(np.arange(W)[None, :] - (cx + jitter))
        band = dist <= row_half
        # carve growth gaps (missing plants / dry patches)
        y = 0
        while y < H:
            y += int(rng.uniform(0.5, 1.0) * run_mu)
            glen = int(rng.exponential(gap_mu) + 0.1 * px_per_m)
            band[y:y + glen, :] = False
            y += glen
        leaf = (rng.normal(0, 1, (H, W)) > 1.1) & band
        img[band] = np.array([55, 132, 74], np.float32)
        img[leaf] += np.array([-15, 40, -10], np.float32)[None, :]

    # weeds: scattered bright-green blobs, on and between rows
    for _ in range(90):
        cy, cx = rng.integers(10, H - 10), rng.integers(10, W - 10)
        r = rng.integers(2, 9)
        color = np.array([60, 175, 85], np.float32) + rng.normal(0, 12, 3)
        cv2.ellipse(img, (int(cx), int(cy)), (int(r), int(r * rng.uniform(0.7, 1.3))),
                    rng.uniform(0, 180), 0, 360, color.tolist(), -1)

    return np.clip(img, 0, 255).astype(np.uint8)


def render_tilted_photo(bev: np.ndarray, theta_deg: float,
                        rng: np.random.Generator,
                        corner_noise_px: float = 0.0,
                        photo_long_px: int = PHOTO_LONG_PX):
    """Project the flat field through a pinhole camera tilted by theta_deg.

    The field plane (X right, Y into the scene) is rotated about the X axis;
    the camera looks straight down from 2 m above the near edge.  Returns the
    rendered photo plus the four projected field corners in [TL, TR, BR, BL]
    order (the points the app user would tap), optionally perturbed by
    corner_noise_px of Gaussian tap error.
    """
    H, W = bev.shape[:2]
    L_m, W_m = H / PX_PER_M, W / PX_PER_M
    t = math.radians(theta_deg)

    def project(x_m, y_m, f):
        z = y_m * math.sin(t)                    # far edge dips away
        yv = y_m * math.cos(t)
        denom = 2.0 + z                          # camera 2 m above near edge
        return f * x_m / denom, f * yv / denom

    corners_w = [(0, 0), (W_m, 0), (W_m, L_m), (0, L_m)]   # TL TR BR BL
    proj = [project(x, y, 1.0) for x, y in corners_w]
    us, vs = [p[0] for p in proj], [p[1] for p in proj]
    span = max(max(us) - min(us), max(vs) - min(vs))
    f = photo_long_px / span
    ox, oy = -min(us) * f + 40, -min(vs) * f + 40

    photo_w = int(max(us) * f - min(us) * f + 80)
    photo_h = int(max(vs) * f - min(vs) * f + 80)
    photo_corners = [(u * f + ox, v * f + oy) for u, v in proj]

    src = np.array([(0, 0), (W, 0), (W, H), (0, H)], np.float32)
    dst = np.array(photo_corners, np.float32)
    M = cv2.getPerspectiveTransform(src, dst)
    photo = cv2.warpPerspective(bev, M, (photo_w, photo_h),
                                flags=cv2.INTER_LINEAR)

    # realism: lighting gradient across the frame, blur, JPEG, tap noise
    g = np.linspace(rng.uniform(0.72, 0.9), rng.uniform(0.95, 1.1),
                    photo_h, dtype=np.float32)[:, None, None]
    photo = np.clip(photo.astype(np.float32) * g, 0, 255).astype(np.uint8)
    photo = cv2.GaussianBlur(photo, (0, 0), rng.uniform(0.6, 1.4))
    ok, enc = cv2.imencode(".jpg", photo, [cv2.IMWRITE_JPEG_QUALITY, 85])
    photo = cv2.imdecode(enc, cv2.IMREAD_COLOR)

    if corner_noise_px > 0:
        noise = rng.normal(0, corner_noise_px, (4, 2))
        photo_corners = [(x + dx, y + dy)
                         for (x, y), (dx, dy) in zip(photo_corners, noise)]

    return photo, [(float(x), float(y)) for x, y in photo_corners]


# ------------------------------------------------------------------ metrics
def gt_rows(width_m, n_rows):
    step = width_m / n_rows
    return [(i + 0.5) * step for i in range(n_rows)]


def score(rows_m, width_m, length_m, expected, gt_mission_wp):
    det = sorted(rows_m)
    count_err = len(det) - expected
    pos_err = None
    if len(det) == expected:
        pos_err = float(np.mean(np.abs(np.array(det) - np.array(gt_rows(width_m, expected)))))
    mission = build_mission_json(rows_m=list(det), width_m=width_m, length_m=length_m)
    wp_err = abs(len(mission["path"]) - gt_mission_wp)
    return count_err, pos_err, wp_err, mission


# ------------------------------------------------------------------- sweep
def run_trials(records, corner_noise_px, angle_list, tag, n_rows=None):
    """Run all (arm, angle, seed) trials for one corner-noise setting."""
    n_rows = n_rows if n_rows is not None else N_ROWS
    orig_regularize = field_pipeline.regularize
    for arm in ("reg", "raw"):
        if arm == "raw":   # ablation: disable regularize
            field_pipeline.regularize = lambda d, w, e: d
        for theta in angle_list:
            for seed in range(SEEDS):
                rng = np.random.default_rng(1000 * seed + theta)
                bev = make_field_bev(WIDTH_M, LENGTH_M, n_rows, PX_PER_M, rng)
                photo, corners = render_tilted_photo(
                    bev, theta, rng, corner_noise_px=corner_noise_px)
                gt_mission = build_mission_json(
                    rows_m=gt_rows(WIDTH_M, n_rows), width_m=WIDTH_M, length_m=LENGTH_M)
                stem = f"{tag}_a{theta:02d}_s{seed}_{arm}"
                t0 = time.perf_counter()
                res = analyze_field_photo(
                    photo, corners, WIDTH_M, LENGTH_M,
                    expected_rows=n_rows, out_dir=OUT_DIR, stem=stem)
                dt = time.perf_counter() - t0
                count_err, pos_err, wp_err, _ = score(
                    res.rows_m, WIDTH_M, LENGTH_M, n_rows,
                    len(gt_mission["path"]))
                records.append(dict(arm=arm, angle=theta, seed=seed,
                                    corner_noise_px=corner_noise_px,
                                    n_rows=n_rows,
                                    rows_detected=len(res.rows_m),
                                    count_err=count_err,
                                    pos_err=pos_err, wp_err=wp_err,
                                    t=round(dt, 3),
                                    veg_ratio=round(res.vegetation_ratio, 4)))
        field_pipeline.regularize = orig_regularize
        print(f"  [{tag}] {arm} arm done "
              f"({sum(1 for r in records if r['arm'] == arm)} records)")


def aggregate(records, keys=("arm", "angle")):
    agg = defaultdict(list)
    for r in records:
        agg[tuple(r[k] for k in keys)].append(r)
    table = []
    for k, rs in sorted(agg.items()):
        exact = sum(1 for r in rs if r["count_err"] == 0) / len(rs)
        pos = [r["pos_err"] for r in rs if r["pos_err"] is not None]
        row = dict(zip(keys, k))
        row.update(trials=len(rs), exact_rate=round(exact, 3),
                   mean_count_err=round(float(np.mean([r["count_err"] for r in rs])), 3),
                   mean_pos_err_m=round(float(np.mean(pos)), 4) if pos else None,
                   mean_wp_err=round(float(np.mean([r["wp_err"] for r in rs])), 3),
                   mean_t_s=round(float(np.mean([r["t"] for r in rs])), 3))
        table.append(row)
    return table


def run_sweep():
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(RESULTS, exist_ok=True)
    os.makedirs(FIGURES, exist_ok=True)

    records = []
    t_start = time.time()
    for n_rows in ROW_COUNTS:
        run_trials(records, CORNER_NOISE_PX, ANGLES, f"tilt{int(n_rows)}r",
                   n_rows=n_rows)
    for cn in CORNER_SWEEP_PX:
        if cn == CORNER_NOISE_PX:
            continue   # already covered by the tilt sweep
        run_trials(records, cn, [30], "tap", n_rows=5)

    table = aggregate(records, keys=("arm", "angle", "n_rows"))
    corner_table = aggregate(
        [r for r in records if r["corner_noise_px"] != CORNER_NOISE_PX
         or not (r["angle"] in ANGLES and r["n_rows"] == ROW_COUNTS[0])],
        keys=("arm", "corner_noise_px"))

    out = dict(config=dict(angles=ANGLES, seeds=SEEDS, width_m=WIDTH_M,
                           length_m=LENGTH_M, row_counts=ROW_COUNTS,
                           px_per_m=PX_PER_M, photo_long_px=PHOTO_LONG_PX,
                           corner_noise_px=CORNER_NOISE_PX,
                           corner_sweep_px=CORNER_SWEEP_PX),
               aggregates=table, corner_sweep=corner_table, records=records,
               total_wall_s=round(time.time() - t_start, 1))
    with open(os.path.join(RESULTS, "tilt_sweep.json"), "w") as fh:
        json.dump(out, fh, indent=1)

    with open(os.path.join(RESULTS, "tilt_sweep.csv"), "w") as fh:
        fh.write("arm,angle,n_rows,exact_rate,mean_count_err,"
                 "mean_pos_err_m,mean_wp_err,mean_t_s\n")
        for row in table:
            fh.write(f"{row['arm']},{row['angle']},{row['n_rows']},"
                     f"{row['exact_rate']},{row['mean_count_err']},"
                     f"{row['mean_pos_err_m']},{row['mean_wp_err']},"
                     f"{row['mean_t_s']}\n")

    print(json.dumps(table, indent=1))
    print(f"saved -> {RESULTS}/tilt_sweep.json / .csv  "
          f"({out['total_wall_s']} s total)")
    return out


if __name__ == "__main__":
    run_sweep()
