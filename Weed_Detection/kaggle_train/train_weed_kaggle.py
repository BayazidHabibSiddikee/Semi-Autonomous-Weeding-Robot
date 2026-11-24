"""
Kaggle GPU Training Script: Unified Crop-vs-Weed Detector (YOLO26s + YOLO26n -> NCNN + ONNX)
Merges multiple Kaggle bounding-box datasets, trains on GPU with AMP/cache, evaluates on
unseen test split, and exports Raspberry Pi 4 NCNN + ONNX artifacts.
"""
import hashlib
import json
import os
import random
import shutil
import subprocess
import sys
import time
from pathlib import Path

subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "-U", "ultralytics", "ncnn", "onnx", "onnxslim"])

import yaml
from ultralytics import YOLO

SEED = 42
random.seed(SEED)

WORK_DIR = Path("/kaggle/working")
DATASET_DIR = WORK_DIR / "dataset"
EXPORT_DIR = WORK_DIR / "exported_models"
for sub in ["images/train", "images/val", "images/test", "labels/train", "labels/val", "labels/test"]:
    (DATASET_DIR / sub).mkdir(parents=True, exist_ok=True)
EXPORT_DIR.mkdir(parents=True, exist_ok=True)

seen_hashes = set()
counts = {"train": 0, "val": 0, "test": 0}


def md5_file(p: Path) -> str:
    h = hashlib.md5()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def copy_sample(img_path: Path, lbl_path: Path, split: str, class_map: dict, prefix: str):
    if not img_path.exists() or not lbl_path.exists():
        return
    digest = md5_file(img_path)
    if digest in seen_hashes:
        return
    seen_hashes.add(digest)

    lines_out = []
    for raw in lbl_path.read_text().splitlines():
        parts = raw.strip().split()
        if len(parts) < 5:
            continue
        cid = int(float(parts[0]))
        if cid not in class_map:
            continue
        mapped_id = class_map[cid]
        # Clamp normalized coords to [0, 1]
        coords = [max(0.0, min(1.0, float(v))) for v in parts[1:5]]
        if coords[2] <= 0.002 or coords[3] <= 0.002:
            continue
        lines_out.append(f"{mapped_id} {coords[0]:.6f} {coords[1]:.6f} {coords[2]:.6f} {coords[3]:.6f}")

    if not lines_out:
        return

    stem = f"{prefix}_{img_path.stem}_{digest[:6]}"
    dst_img = DATASET_DIR / "images" / split / f"{stem}{img_path.suffix.lower()}"
    dst_lbl = DATASET_DIR / "labels" / split / f"{stem}.txt"
    shutil.copy2(img_path, dst_img)
    dst_lbl.write_text("\n".join(lines_out) + "\n")
    counts[split] += 1


# -------------------------------------------------------------------------
# 1. Ingest Dataset A: vinayakshanawad/weedcrop-image-dataset
# -------------------------------------------------------------------------
ds_a_root = Path("/kaggle/input/weedcrop-image-dataset")
for yaml_path in ds_a_root.rglob("data.yaml"):
    base = yaml_path.parent
    cfg = yaml.safe_load(yaml_path.read_text()) or {}
    names = cfg.get("names", [])
    if isinstance(names, dict):
        names = [names[k] for k in sorted(names.keys())]
    class_map_a = {}
    for idx, name in enumerate(names):
        low = str(name).lower()
        class_map_a[idx] = 1 if "weed" in low else 0
    print(f"[Dataset A] {base} | names={names} -> map={class_map_a}")

    for src_split, dst_split in [("train", "train"), ("valid", "val"), ("val", "val"), ("test", "test")]:
        img_dir = base / src_split / "images"
        lbl_dir = base / src_split / "labels"
        if not img_dir.exists():
            continue
        for img_p in img_dir.iterdir():
            if img_p.suffix.lower() in {".jpg", ".jpeg", ".png", ".bmp"}:
                copy_sample(img_p, lbl_dir / f"{img_p.stem}.txt", dst_split, class_map_a, "wc")

# -------------------------------------------------------------------------
# 2. Ingest Dataset B: ravirajsinh45/crop-and-weed-detection-data-with-bounding-boxes
# -------------------------------------------------------------------------
ds_b_root = Path("/kaggle/input/crop-and-weed-detection-data-with-bounding-boxes")
if ds_b_root.exists():
    classes_file = next(ds_b_root.rglob("classes.txt"), None)
    class_map_b = {0: 0, 1: 1}
    if classes_file:
        c_names = [line.strip().lower() for line in classes_file.read_text().splitlines() if line.strip()]
        class_map_b = {i: (1 if "weed" in n else 0) for i, n in enumerate(c_names)}
        print(f"[Dataset B] classes.txt={c_names} -> map={class_map_b}")

    imgs_b = [p for p in ds_b_root.rglob("*") if p.suffix.lower() in {".jpg", ".jpeg", ".png"}]
    imgs_b.sort()
    random.shuffle(imgs_b)
    n_b = len(imgs_b)
    for i, img_p in enumerate(imgs_b):
        lbl_p = img_p.with_suffix(".txt")
        if i < int(0.8 * n_b):
            sp = "train"
        elif i < int(0.9 * n_b):
            sp = "val"
        else:
            sp = "test"
        copy_sample(img_p, lbl_p, sp, class_map_b, "agri")

print(f"\nUnified Dataset Counts: {counts} (total={sum(counts.values())})")

data_yaml_path = DATASET_DIR / "weed_data.yaml"
data_yaml_path.write_text(
    f"path: {DATASET_DIR}\ntrain: images/train\nval: images/val\ntest: images/test\n\nnames:\n  0: crop\n  1: weed\n"
)

# -------------------------------------------------------------------------
# 3. Train & Validate YOLO26s (primary) and YOLO26n (fast fallback)
# -------------------------------------------------------------------------
summary = {"dataset_counts": counts, "models": {}}

for model_name in ["yolo26s.pt", "yolo26n.pt"]:
    tag = Path(model_name).stem
    print(f"\n================ TRAINING {model_name} ================")
    t0 = time.time()
    model = YOLO(model_name)
    model.train(
        data=str(data_yaml_path),
        epochs=80,
        patience=20,
        imgsz=640,
        batch=-1,
        amp=True,
        cache=True,
        cos_lr=True,
        workers=4,
        project=str(WORK_DIR / "runs"),
        name=tag,
        verbose=True,
    )
    train_sec = round(time.time() - t0, 1)

    best_pt = WORK_DIR / "runs" / tag / "weights" / "best.pt"
    best_model = YOLO(str(best_pt))

    print(f"\n--- Evaluating {tag} on unseen TEST split ---")
    metrics = best_model.val(data=str(data_yaml_path), split="test", imgsz=640)

    per_class = {}
    if hasattr(metrics.box, "ap_class_index") and metrics.box.ap_class_index is not None:
        for i, cid in enumerate(metrics.box.ap_class_index):
            p, r, ap50, ap = metrics.box.class_result(i)
            per_class[best_model.names[int(cid)]] = {
                "precision": round(float(p), 4),
                "recall": round(float(r), 4),
                "mAP50": round(float(ap50), 4),
                "mAP50_95": round(float(ap), 4),
            }

    # Export NCNN (640, fp16) & ONNX (320, simplified)
    ncnn_exported = Path(best_model.export(format="ncnn", imgsz=640, half=True))
    onnx_exported = Path(best_model.export(format="onnx", imgsz=[256, 320], simplify=True))

    out_sub = EXPORT_DIR / tag
    out_sub.mkdir(parents=True, exist_ok=True)
    shutil.copy2(best_pt, out_sub / f"{tag}_best.pt")
    shutil.copy2(onnx_exported, out_sub / f"{tag}_best.onnx")
    ncnn_dst = out_sub / f"{tag}_ncnn_model"
    if ncnn_dst.exists():
        shutil.rmtree(ncnn_dst)
    shutil.copytree(ncnn_exported, ncnn_dst)

    summary["models"][tag] = {
        "train_seconds": train_sec,
        "precision": round(float(metrics.box.mp), 4),
        "recall": round(float(metrics.box.mr), 4),
        "mAP50": round(float(metrics.box.map50), 4),
        "mAP50_95": round(float(metrics.box.map), 4),
        "per_class": per_class,
    }

(EXPORT_DIR / "training_summary.json").write_text(json.dumps(summary, indent=2))
print("\n=== TRAINING & EXPORT COMPLETE ===")
print(json.dumps(summary, indent=2))
