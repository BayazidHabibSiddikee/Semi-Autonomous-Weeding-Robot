# Weed Laser Robot — Automated Weed Detection & Elimination

A multi-model pipeline for detecting, localizing, and laser-destroying weeds in agricultural fields (tomato, chili, flower crops).

## Mission Plan

### Phase 1: Weed Detection (AI Models)
- **DINOv2** — Self-supervised feature extraction (understand plant textures, shapes)
- **CLIP** — Zero-shot classification (identify weed species via text prompts)
- **EfficientNet** — Fine-tuned classifier (6-7 weed types vs crop types)
- **YOLOv8n** — Real-time object detection (bounding boxes + coordinates)

### Phase 2: Position Localization
- Camera intrinsic calibration (checkerboard)
- Extrinsic calibration (ArUco markers → homography matrix)
- Pixel (u,v) → Gantry coordinates (X,Y mm)

### Phase 3: Robot Actuation
- Raspberry Pi 5 → stepper motor controllers (RAMPS/Mega)
- Gantry X/Y movement to weed position
- Laser firing (450nm blue diode, 50-100W)

### Phase 4: Integration
- Full pipeline: Camera → AI → Coordinates → Gantry → Laser
- Real-time feedback loop
- Safety systems

---

## Project Structure

```
weed-laser-robot/
├── README.md                 # This file
├── requirements.txt          # Python dependencies
├── configs/
│   ├── model_config.yaml     # Model hyperparameters
│   └── robot_config.yaml     # Gantry & laser settings
├── src/
│   ├── __init__.py
│   ├── train_weed_model.py   # Train EfficientNet classifier
│   ├── train_yolo.py         # Train YOLOv8 detector
│   ├── dino_features.py      # DINOv2 feature extraction
│   ├── clip_classifier.py    # CLIP zero-shot classification
│   ├── detection_pipeline.py # Combined detection pipeline
│   ├── calibration.py        # Camera-to-gantry calibration
│   ├── gantry_control.py     # Stepper motor control
│   ├── laser_control.py      # Laser on/off + safety
│   └── main.py               # Full system integration
├── scripts/
│   ├── setup.sh              # Install dependencies
│   ├── collect_data.py       # Capture training images
│   ├── annotate_helper.py    # Annotation helper
│   └── test_pipeline.py      # Test each component
├── data/
│   ├── train/                # Training images by class
│   │   ├── crop_tomato/
│   │   ├── crop_chili/
│   │   ├── crop_flower/
│   │   ├── weed_grass/
│   │   ├── weed_dandelion/
│   │   ├── weed_purslane/
│   │   └── weed_amaranth/
│   └── val/                  # Validation images
├── models/                   # Saved .pt models
│   ├── efficientnet_weeds.pt
│   ├── yolo_weeds.pt
│   └── calibration.npz
└── docs/
    ├── MISSION_PLAN.md       # Detailed mission breakdown
    ├── CALIBRATION.md        # Camera calibration guide
    └── HARDWARE.md           # Hardware setup guide
```

## Quick Start

```bash
# 1. Setup
cd weed-laser-robot
bash scripts/setup.sh

# 2. Collect training data
python scripts/collect_data.py

# 3. Train models
python src/train_weed_model.py    # EfficientNet
python src/train_yolo.py          # YOLOv8

# 4. Calibrate camera
python src/calibration.py

# 5. Run full pipeline
python src/main.py
```

## Hardware Required

| Component | Specification | Est. Cost |
|-----------|--------------|-----------|
| Raspberry Pi 5 (8GB) | BCM2712, 4x A76 | $80 |
| USB Camera | OV5647/OV5640 | $25 |
| NEMA 17 Steppers (x2) | + A4988 drivers | $40 |
| Laser Module | 450nm, 50-100W blue diode | $150-300 |
| Gantry Frame | 2020 aluminum extrusion | $100-200 |
| RAMPS 1.4 Controller | + Mega 2560 | $25 |
| **Total** | | **~$420-670** |

## Safety

- **Class 4 laser** — NEVER look at beam directly
- Use proper laser safety goggles (OD5+ @ 450nm)
- Enclose the working area
- Emergency stop button always accessible
