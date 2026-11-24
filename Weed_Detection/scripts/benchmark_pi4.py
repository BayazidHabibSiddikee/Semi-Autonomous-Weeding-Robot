"""
Apples-to-apples runtime benchmark for Raspberry Pi 4 deployment.
Compares YOLO26n and YOLO26s across NCNN and ONNX at identical resolution (640x640),
identical confidence threshold (0.30), and identical fixed field test images.

Usage:
  python scripts/benchmark_pi4.py
"""
import json
import shutil
import statistics
import sys
import time
from pathlib import Path
import cv2
from ultralytics import YOLO

BASE_DIR = Path(__file__).resolve().parent.parent
MODELS_DIR = BASE_DIR / "models"
FIXTURES_DIR = BASE_DIR / "tests" / "fixtures"

IMGSZ = 640
CONF = 0.30
WARMUP = 3
RUNS = 15


def ensure_640_onnx(pt_path: Path, out_onnx: Path) -> Path:
    if out_onnx.exists():
        return out_onnx
    print(f"Exporting {pt_path.name} -> {out_onnx.name} at {IMGSZ}x{IMGSZ} for fair comparison...")
    exported = Path(YOLO(str(pt_path)).export(format="onnx", imgsz=IMGSZ, simplify=True))
    shutil.move(str(exported), str(out_onnx))
    return out_onnx


def benchmark_model(name: str, model_path: Path, images: list) -> dict:
    model = YOLO(str(model_path), task="detect")
    for img in images[:WARMUP]:
        model(img, imgsz=IMGSZ, conf=CONF, verbose=False)

    latencies_ms = []
    det_counts = []
    for r in range(RUNS):
        img = images[r % len(images)]
        t0 = time.perf_counter()
        res = model(img, imgsz=IMGSZ, conf=CONF, verbose=False)[0]
        latencies_ms.append((time.perf_counter() - t0) * 1000.0)
        det_counts.append(len(res.boxes))

    sorted_lat = sorted(latencies_ms)
    p95 = sorted_lat[min(len(sorted_lat) - 1, int(0.95 * len(sorted_lat)))]
    mean_ms = statistics.mean(latencies_ms)
    return {
        "model": name,
        "imgsz": f"{IMGSZ}x{IMGSZ}",
        "conf": CONF,
        "mean_ms": round(mean_ms, 2),
        "median_ms": round(statistics.median(latencies_ms), 2),
        "p95_ms": round(p95, 2),
        "fps": round(1000.0 / mean_ms, 2),
        "avg_detections": round(statistics.mean(det_counts), 2),
    }


def main():
    img_paths = sorted(
        p for p in FIXTURES_DIR.iterdir() if p.suffix.lower() in {".jpg", ".jpeg", ".png"}
    )
    if not img_paths:
        raise SystemExit(f"No fixture images found in {FIXTURES_DIR}")
    images = [cv2.imread(str(p)) for p in img_paths]

    onnx_26n_640 = ensure_640_onnx(MODELS_DIR / "yolo26n_best.pt", Path("/tmp/yolo26n_640.onnx"))
    onnx_26s_640 = ensure_640_onnx(MODELS_DIR / "yolo26s_best.pt", Path("/tmp/yolo26s_640.onnx"))

    targets = [
        ("yolo26n_ncnn", MODELS_DIR / "weed_detector_ncnn_model"),
        ("yolo26n_onnx", onnx_26n_640),
        ("yolo26s_ncnn", MODELS_DIR / "yolo26s_ncnn_model"),
        ("yolo26s_onnx", onnx_26s_640),
    ]

    results = []
    for name, path in targets:
        if path.exists():
            results.append(benchmark_model(name, path, images))

    print("\n=== Apples-to-Apples Benchmark (640x640, conf=0.30, same test images) ===")
    print(f"{'Model':<16} {'Mean(ms)':>10} {'Med(ms)':>10} {'P95(ms)':>10} {'FPS':>8} {'AvgDets':>9}")
    for r in results:
        print(f"{r['model']:<16} {r['mean_ms']:>10.1f} {r['median_ms']:>10.1f} {r['p95_ms']:>10.1f} {r['fps']:>8.2f} {r['avg_detections']:>9.2f}")

    out_json = MODELS_DIR / "benchmark_640_comparison.json"
    out_json.write_text(json.dumps(results, indent=2))
    print(f"\nSaved fair benchmark report to {out_json}")


if __name__ == "__main__":
    main()
