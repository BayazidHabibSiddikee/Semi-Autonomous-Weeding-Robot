---
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