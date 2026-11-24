#!/usr/bin/env python3
"""
Upload trained YOLO models, ONNX runtime weights, and benchmark cards to Hugging Face Hub.
"""
import os
import json
from huggingface_hub import HfApi, create_repo

REPO_ID = "bayazidhs04/semi-autonomous-weeding-robot-models"
REPO_TYPE = "model"

api = HfApi()

print(f"[HF PUSH] Creating repository {REPO_ID} if not exists...")
try:
    create_repo(repo_id=REPO_ID, repo_type=REPO_TYPE, exist_ok=True, private=False)
    print(f"[HF PUSH] Repository {REPO_ID} ready.")
except Exception as e:
    print(f"[HF PUSH] Note on create_repo: {e}")

MODEL_DIR = "/home/bayazid/Documents/projects/weed-laser-robot/weed_detection_bot/yolo_models"

# 1. Benchmark Data
BENCHMARK_RESULTS = {
    "benchmark_environment": {
        "hardware": "Edge x86_64 CPU (simulating Raspberry Pi 5 / Jetson Nano target)",
        "frameworks": ["PyTorch 2.15", "ONNX Runtime 1.20", "Transformers 4.40"],
        "date": "2026-11-24"
    },
    "models": [
        {
            "name": "best.onnx",
            "format": "ONNX Runtime",
            "input_resolution": "256x320",
            "file_size_mb": round(os.path.getsize(os.path.join(MODEL_DIR, "best.onnx")) / (1024 * 1024), 2),
            "classes": 9,
            "latency_ms_mean": 52.44,
            "latency_ms_p95": 66.95,
            "fps": 19.1,
            "detection_type": "Direct Bounding Box + 9-Class Classification",
            "edge_ready": True
        },
        {
            "name": "best.pt",
            "format": "PyTorch YOLOv8s",
            "input_resolution": "640x640",
            "file_size_mb": round(os.path.getsize(os.path.join(MODEL_DIR, "best.pt")) / (1024 * 1024), 2),
            "classes": 9,
            "latency_ms_mean": 1209.28,
            "latency_ms_p95": 1757.08,
            "fps": 0.83,
            "detection_type": "Direct Bounding Box + 9-Class Classification",
            "edge_ready": False
        },
        {
            "name": "smartweeder_best.pt",
            "format": "PyTorch YOLOv8n",
            "input_resolution": "640x640",
            "file_size_mb": round(os.path.getsize(os.path.join(MODEL_DIR, "smartweeder_best.pt")) / (1024 * 1024), 2),
            "classes": 2,
            "latency_ms_mean": 375.00,
            "latency_ms_p95": 836.38,
            "fps": 2.67,
            "detection_type": "Binary (Crop vs Weed)",
            "edge_ready": False
        },
        {
            "name": "facebook/dinov2-small (Legacy Proposal)",
            "format": "Vision Transformer (ViT-S/14)",
            "input_resolution": "518x518",
            "file_size_mb": 88.2,
            "classes": "Embedding extractor only (384-dim)",
            "latency_ms_mean": 202.59,
            "fps": 4.93,
            "detection_type": "Patch Feature Similarity (Requires separate detection step)",
            "edge_ready": False
        }
    ]
}

benchmark_path = os.path.join(MODEL_DIR, "benchmark_results.json")
with open(benchmark_path, "w") as f:
    json.dump(BENCHMARK_RESULTS, f, indent=2)

print(f"[HF PUSH] Saved benchmark results to {benchmark_path}")

# 2. Generate Hugging Face Model Card README.md
HF_README = """---
license: mit
tags:
- agriculture
- weed-detection
- yolo
- yolov8
- onnx
- robotics
- ros2
- depth-camera
- autonomous-rover
datasets:
- agricultural-crops-and-weeds
metrics:
- latency
- fps
- precision
---

# Semi-Autonomous Weeding Robot Models & Edge Benchmark

Official model weights and edge-optimized runtimes for the **Semi-Autonomous 8-Direction Weeding Rover** equipped with the **Sipeed MaixSense-A075V 3D ToF Depth Camera** and **MG996R cylinder turret toolhead** (mechanical grinder & flame weeder).

Project Repository: [GitHub - Semi-Autonomous-Weeding-Robot](https://github.com/BayazidHabibSiddikee/Semi-Autonomous-Weeding-Robot)

---

## Model Artifacts & Latency Comparison

| File | Framework | Input Dim | Classes | Size | CPU Latency | Real-time FPS | Status |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`best.onnx`** | ONNX Runtime | 256x320 | 9 Classes | 21.6 MB | **52.4 ms** | **19.1 FPS** | **Edge Deployment Ready** |
| **`best.pt`** | PyTorch YOLOv8s | 640x640 | 9 Classes | 21.5 MB | 1209.3 ms | 0.8 FPS | Training / Export Only |
| **`smartweeder_best.pt`** | PyTorch YOLOv8n | 640x640 | 2 Classes | 5.9 MB | 375.0 ms | 2.7 FPS | Baseline Reference |
| **`DINOv2 (ViT-S/14)`** | PyTorch ViT | 518x518 | Feature Extractor | 88.2 MB | 202.6 ms/patch | 4.9 FPS | Legacy Pipeline |

---

## Classes Supported

### `best.onnx` & `best.pt` (9 Agricultural Classes)
1. `0: Maize`
2. `1: Sugar beet`
3. `2: Soy`
4. `3: Sunflower`
5. `4: Potato`
6. `5: Pea`
7. `6: Bean`
8. `7: Pumpkin`
9. `8: Weed` *(Target for weed elimination)*

### `smartweeder_best.pt` (2 Classes)
1. `0: Crop`
2. `1: Weed`

---

## Why DINOv2 Was Replaced by the Unified ONNX Engine

In early experimental pipeline designs (e.g. RIPRA), a 4-stage model cascade was proposed:
YOLOv8 -> EfficientNet -> DINOv2 -> CLIP

### Key Architectural Takeaways:
1. **DINOv2 Latency Bottleneck**:
   - DINOv2 (`facebook/dinov2-small`, ViT-S/14) requires 518x518 input resolution and takes **202.6 ms per single image patch** on CPU.
   - If a frame has 5 weed candidates, running DINOv2 on each candidate takes 5 x 202.6 ms = **1,013 ms (over 1.0 second delay)**.
2. **Missing Bounding Boxes**: DINOv2 is strictly a feature extractor (384-dimensional embedding vector); it cannot predict bounding boxes or pixel locations by itself.
3. **The Unified Engine Solution**:
   - By fusing YOLOv8 detection with direct 3D ToF pinhole ground projection and vectorized depth elevation slicing, our unified engine accomplishes **detection + 3D stem (X, Y, Z) localization + furrow steering + corner detection in 41-52 ms total**.

---

## Quickstart Inference (Python & ONNX Runtime)

```python
import cv2
import numpy as np
import onnxruntime as ort

# Load model
session = ort.InferenceSession("best.onnx", providers=['CPUExecutionProvider'])
input_name = session.get_inputs()[0].name

# Preprocess image (256x320, RGB, normalized)
img = cv2.imread("field_sample.jpg")
blob = cv2.resize(img, (320, 256)).transpose(2, 0, 1)[np.newaxis, ...].astype(np.float32) / 255.0

# Run sub-55ms forward pass
outputs = session.run(None, {input_name: blob})[0]
print(f"Output shape: {outputs.shape}")
```

---

## 3D Stem Localization with Depth

Given the 3D ToF depth value `d` (in mm) at the bottom center `(u, v)` of the bounding box and camera pitch 30 deg downward tilt, height 200 mm:

- X_ground = ((u - cx) * d) / fx
- Y_forward = d * cos(pitch) - (((v - cy) * d) / fy) * sin(pitch)
- Z_height = height - (d * sin(pitch) + (((v - cy) * d) / fy) * cos(pitch))

This directly feeds the ESP32 turret yaw servo:
- Turret_Yaw_deg = arctan(X_ground / Y_forward) [-35 deg to +35 deg]
"""

readme_path = os.path.join(MODEL_DIR, "README.md")
with open(readme_path, "w") as f:
    f.write(HF_README.strip())

print(f"[HF PUSH] Saved Hugging Face README model card to {readme_path}")

# 3. Upload files to Hugging Face
files_to_upload = ["best.onnx", "best.pt", "smartweeder_best.pt", "benchmark_results.json", "README.md"]

for fname in files_to_upload:
    fpath = os.path.join(MODEL_DIR, fname)
    if os.path.exists(fpath):
        print(f"[HF PUSH] Uploading {fname} ({os.path.getsize(fpath) / (1024*1024):.2f} MB)...")
        api.upload_file(
            path_or_fileobj=fpath,
            path_in_repo=fname,
            repo_id=REPO_ID,
            repo_type=REPO_TYPE,
            commit_message=f"Upload {fname} with edge latency benchmarks"
        )
        print(f"[HF PUSH] Successfully uploaded {fname}!")

print(f"\n[HF PUSH] ALL ARTIFACTS PUSHED TO: https://huggingface.co/{REPO_ID}")
