#!/usr/bin/env python3
"""
Per-stage and end-to-end timing benchmark of the field pipeline on a REAL
field photo (Navigation/images/field_topview.jpeg), plus the paper figures
made from the tilt-sweep results.

Outputs
  docs/paper/results/timing.json
  docs/paper/figures/fig_tilt.pdf      row-count robustness vs tilt angle
  docs/paper/figures/fig_tap.pdf       row position error vs corner-tap noise
  docs/paper/figures/fig_example.pdf   synthetic example: photo | BEV | overlay

Run:  python3 Navigation/benchmarks/make_figures.py
"""
from __future__ import annotations

import json
import os
import sys
import time
from collections import defaultdict

import cv2
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "src")
sys.path.insert(0, SRC)

import field_pipeline                          # noqa: E402
from field_analyzer_reference import (         # noqa: E402
    column_projection, merge_segments, regularize, segments_above,
    vegetation_mask)
from field_pipeline import (analyze_field_photo, enhance_for_analysis)  # noqa: E402

RESULTS = os.path.join(HERE, "..", "..", "docs", "paper", "results")
FIGURES = os.path.join(HERE, "..", "..", "docs", "paper", "figures")
REAL_PHOTO = os.path.join(HERE, "..", "images", "field_topview.jpeg")
REPEATS = 7


def ms(fn, *a, **kw):
    best = None
    for _ in range(REPEATS):
        t0 = time.perf_counter()
        fn(*a, **kw)
        dt = (time.perf_counter() - t0) * 1000
        best = dt if best is None else min(best, dt)
    return round(best, 1)          # min = least-disturbed measurement


def timing_benchmark():
    os.makedirs(RESULTS, exist_ok=True)
    bgr = cv2.imread(REAL_PHOTO)
    h, w = bgr.shape[:2]
    corners = [(0, 0), (w, 0), (w, h), (0, h)]   # photo IS the field frame
    Wm, Lm = 3.5, 12.0                            # documented field size

    res = analyze_field_photo(bgr, corners, Wm, Lm, expected_rows=None,
                              out_dir="/tmp/opencode/bench_out", stem="realtiming")
    bev = cv2.imread(res.bev_path)
    veg, _cut = vegetation_mask(enhance_for_analysis(bev))
    proj = column_projection(veg)
    thr = float(proj.max()) * 0.25
    segs = segments_above(proj, thr)
    merged = merge_segments(segs, bev.shape[1], None)

    # authentic figure: real photo -> BEV -> detected-row overlay.
    # Crop to the field block = what the operator's corner selection does.
    # Block bounds eyeballed on a gridded preview once, kept as constants.
    crop = bgr[int(0.13 * h):int(0.93 * h), int(0.199 * w):int(0.76 * w)]
    bh, bw = crop.shape[:2]
    block_corners = [(0, 0), (bw, 0), (bw, bh), (0, bh)]
    res2 = analyze_field_photo(crop, block_corners, 5.25, 4.05,
                               expected_rows=7,
                               out_dir="/tmp/opencode/bench_out", stem="realblock")
    bev = cv2.imread(res2.bev_path)
    veg, _cut = vegetation_mask(enhance_for_analysis(bev))
    proj = column_projection(veg)
    thr = float(proj.max()) * 0.25
    segs = segments_above(proj, thr)
    merged = merge_segments(segs, bev.shape[1], None)

    def stages():
        b, _ = __import__("field_pipeline").warp_to_bev(
            crop, block_corners, 5.25, 4.05)
        veg, _ = vegetation_mask(enhance_for_analysis(b))
        p = column_projection(veg)
        s = segments_above(p, thr)
        m = merge_segments(s, bev.shape[1], None)
        regularize(m, bev.shape[1], None)

    timing = dict(
        photo_px=[bw, bh], bev_px=[bev.shape[1], bev.shape[0]],
        end_to_end_ms=ms(lambda: analyze_field_photo(
            crop, block_corners, 5.25, 4.05, expected_rows=7,
            out_dir="/tmp/opencode/bench_out", stem="realtiming")),
        warp_ms=ms(lambda: field_pipeline.warp_to_bev(crop, block_corners, 5.25, 4.05)),
        segmentation_ms=ms(lambda: vegetation_mask(enhance_for_analysis(bev))),
        projection_rows_ms=ms(lambda: regularize(
            merge_segments(segments_above(column_projection(veg), thr),
                           bev.shape[1], None), bev.shape[1], None)),
        veg_ratio=round(res2.vegetation_ratio, 4),
        rows_detected=len(res2.rows_m),
    )
    with open(os.path.join(RESULTS, "timing.json"), "w") as fh:
        json.dump(timing, fh, indent=1)
    print(json.dumps(timing, indent=1))

    # authentic figure: the real photo -> its BEV -> detected-row overlay
    overlay = cv2.imread(res2.overlay_path)
    photo_s = cv2.resize(crop, (bev.shape[1], bev.shape[0]))
    triptych = np.hstack([photo_s, bev, overlay])
    ok, enc = cv2.imencode(".png", triptych)
    open(os.path.join(FIGURES, "real_field_triptych.png"), "wb").write(enc.tobytes())
    return timing


def paper_figures():
    sweep = json.load(open(os.path.join(RESULTS, "tilt_sweep.json")))
    plt.rcParams.update({"font.size": 8, "axes.grid": True,
                         "grid.alpha": 0.3, "figure.dpi": 150})

    # --- fig 1: row-count robustness vs tilt, per row pitch
    fig, ax = plt.subplots(figsize=(3.35, 2.3))
    styles = {5: ("o", "tab:blue"), 10: ("s", "tab:red")}
    for n_rows in (5, 10):
        marker, color = styles[n_rows]
        for arm, ls, lbl in (("raw", "--", "raw"), ("reg", "-", "regularized")):
            pts = [r for r in sweep["aggregates"]
                   if r["arm"] == arm and r["n_rows"] == n_rows]
            pts.sort(key=lambda r: r["angle"])
            ax.plot([p["angle"] for p in pts], [100 * p["exact_rate"] for p in pts],
                    ls, marker=marker, ms=3, color=color,
                    label=f"{n_rows} rows, {lbl}" if arm == "raw"
                    else f"{n_rows} rows, {lbl}")
    ax.set_xlabel("camera tilt (deg)")
    ax.set_ylabel("exact row-count rate (%)")
    ax.set_ylim(55, 105)
    ax.legend(fontsize=6, loc="lower left")
    fig.tight_layout()
    fig.savefig(os.path.join(FIGURES, "fig_tilt.pdf"))
    fig.savefig(os.path.join(FIGURES, "fig_tilt.png"))

    # --- fig 2: row position error vs corner-tap noise
    fig, ax = plt.subplots(figsize=(3.35, 2.1))
    pts = sorted(sweep["corner_sweep"], key=lambda r: r["corner_noise_px"])
    for arm, color, lbl in (("raw", "tab:red", "raw"), ("reg", "tab:blue", "regularized")):
        sel = [p for p in pts if p["arm"] == arm]
        ax.plot([p["corner_noise_px"] for p in sel],
                [100 * p["mean_pos_err_m"] if p["mean_pos_err_m"] else 0 for p in sel],
                "-o", ms=3, color=color, label=lbl)
    ax.set_xlabel("corner-tap noise $\\sigma$ (px)")
    ax.set_ylabel("row position error (cm)")
    ax.legend(fontsize=6)
    fig.tight_layout()
    fig.savefig(os.path.join(FIGURES, "fig_tap.pdf"))
    fig.savefig(os.path.join(FIGURES, "fig_tap.png"))

    # --- fig 3: synthetic example triptych (60 deg, 10 rows trial)
    rec = [r for r in sweep["records"]
           if r["arm"] == "reg" and r["angle"] == 60 and r["n_rows"] == 10
           and r["seed"] == 0][0]
    base = f"a60_s0"   # stem in OUT_DIR is tag_a.._s0_
    out_dir = "/tmp/opencode/bench_out"
    def load(name):
        for f in os.listdir(out_dir):
            if f == name:
                return cv2.imread(os.path.join(out_dir, f))
        return None
    photo = load("tilt_sweep_photo.jpg")
    # rebuild the example deterministically instead of hunting files
    import tilt_sweep as T
    rng = np.random.default_rng(0)
    bev = T.make_field_bev(T.WIDTH_M, T.LENGTH_M, 10, T.PX_PER_M, rng)
    p60, corners = T.render_tilted_photo(bev, 60, rng, corner_noise_px=3.0)
    from PIL import Image
    res = analyze_field_photo(p60, corners, T.WIDTH_M, T.LENGTH_M,
                              expected_rows=10, out_dir=out_dir, stem="paper_ex")
    a = Image.fromarray(cv2.cvtColor(p60, cv2.COLOR_BGR2RGB))
    b = Image.open(res.bev_path)
    c = Image.open(res.overlay_path)
    # stacked layout: keystone photo (wide wedge) on top, BEV|overlay below;
    # crop the photo panel to its non-black content first
    arr = np.asarray(a.convert("RGB"))
    ys, xs = np.nonzero(arr.max(axis=2) > 25)
    a = a.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
    W = 1800
    a = a.resize((W, round(a.height * W / a.width)))
    h2 = round((W - 10) / (b.width / b.height + c.width / c.height))
    b = b.resize((round(b.width * h2 / b.height), h2))
    c = c.resize((round(c.width * h2 / c.height), h2))
    canvas = Image.new("RGB", (W, a.height + 10 + h2), "white")
    canvas.paste(a, (0, 0))
    canvas.paste(b, (0, a.height + 10))
    canvas.paste(c, (b.width + 10, a.height + 10))
    canvas.save(os.path.join(FIGURES, "fig_example.png"))
    print("figures ->", FIGURES)


if __name__ == "__main__":
    timing_benchmark()
    sys.path.insert(0, HERE)
    paper_figures()
