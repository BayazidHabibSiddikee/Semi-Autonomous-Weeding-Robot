---
license: mit
tags:
- agriculture
- weed-detection
- yolo
- yolo26
- yolov8
- ncnn
- onnx
- raspberry-pi
- robotics
- ros2
- depth-camera
- autonomous-rover
datasets:
- vinayakshanawad/weedcrop-image-dataset
- ravirajsinh45/crop-and-weed-detection-data-with-bounding-boxes
metrics:
- mAP50
- mAP50-95
- precision
- recall
- latency
- fps
---

# Semi-Autonomous Weeding Robot Models & Edge Benchmarks

Official trained weights, NCNN/ONNX edge exports, and benchmarks for the **Semi-Autonomous 8-Direction Weeding Rover** (Raspberry Pi 4 + Sipeed MaixSense-A075V 3D ToF Depth Camera + ESP32 motor/turret controller).

- **GitHub Repository (`design` branch)**: [BayazidHabibSiddikee/Semi-Autonomous-Weeding-Robot](https://github.com/BayazidHabibSiddikee/Semi-Autonomous-Weeding-Robot/tree/design)
- **Kaggle Training Kernel**: [bayazidhs/weed-detector-yolo26-pi4-ncnn-training](https://www.kaggle.com/code/bayazidhs/weed-detector-yolo26-pi4-ncnn-training)

---

## 1. Kaggle-Trained YOLO26 Models (`yolo26_kaggle_trained/`)

Trained on a unified, deduplicated **4,020-image** bounding-box dataset (`train: 3,407` · `val: 365` · `test: 248`) with 2 classes:
- `0: crop`
- `1: weed`

### Unseen Test Set Accuracy (`imgsz=640`)

| Model | Precision | Recall | mAP50 | mAP50-95 | Crop mAP50 | Weed Recall | Weed mAP50 |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **`yolo26n`** *(Pi 4 provisional default)* | 0.7163 | 0.7829 | 0.8049 | **0.4790** | 0.8364 | **0.7459** | **0.7734** |
| **`yolo26s`** *(higher precision)* | **0.7568** | **0.7958** | **0.8244** | 0.4705 | **0.8791** | 0.7384 | 0.7698 |

### Apples-to-Apples Runtime Benchmark (`640×640`, `conf=0.30`, same test images on x86_64 CPU)

| Artifact | Runtime | Mean (ms) | Median (ms) | P95 (ms) | FPS | Avg Detections |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: |
| `yolo26n_best.onnx` | ONNX Runtime | **84.5** | **76.8** | **114.9** | **11.83** | 5.73 |
| `weed_detector_ncnn_model/` (`yolo26n`) | NCNN (FP16) | 255.6 | 245.5 | 296.7 | 3.91 | 5.73 |
| `yolo26s_best.onnx` | ONNX Runtime | 229.1 | 220.0 | 273.9 | 4.37 | 6.80 |
| `yolo26s_ncnn_model/` (`yolo26s`) | NCNN (FP16) | 593.5 | 643.5 | 702.2 | 1.69 | 6.27 |

> **Why `yolo26n` is the provisional Pi 4 default:** It achieves higher weed recall (`0.7459` vs `0.7384`) and `mAP50-95` (`0.4790` vs `0.4705`) than `yolo26s` while running ~2.3–2.7× faster. Both NCNN (ARM NEON) and ONNX should be benchmarked directly on the target Raspberry Pi 4.

---

## 2. Legacy / Multi-Class Reference Weights (Root Directory)

| File | Architecture | Input Dim | Classes |
| :--- | :--- | :--- | :--- |
| `best.onnx` | YOLOv8s ONNX | 256×320 | 9 Agricultural Classes (`Maize`, `Sugar beet`, `Soy`, `Sunflower`, `Potato`, `Pea`, `Bean`, `Pumpkin`, `Weed`) |
| `best.pt` | PyTorch YOLOv8s | 640×640 | 9 Agricultural Classes |
| `smartweeder_best.pt` | PyTorch YOLOv8n | 640×640 | 2 Classes (`crop`, `weed`) |

---

## 3. Quickstart Inference (`Weed_Detection`)

```python
from ultralytics import YOLO

# Load YOLO26n NCNN (or yolo26n_best.onnx)
model = YOLO("yolo26_kaggle_trained/weed_detector_ncnn_model", task="detect")
results = model("field_sample.jpg", imgsz=640, conf=0.30)

for box in results[0].boxes:
    cls_name = results[0].names[int(box.cls)]
    conf = float(box.conf)
    print(cls_name, conf, box.xyxy[0].tolist())
```
