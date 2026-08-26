# Mission Plan — Detailed Breakdown

## Overview

Build an autonomous laser weeding system that:
1. Sees weeds among crops using multi-model AI
2. Calculates exact position on the field
3. Moves a laser to burn the weed at its meristem

---

## Phase 1: Data Collection & Training

### Step 1.1: Collect Field Images
- Take 200-500 photos of your actual field
- Include different lighting (morning, noon, cloudy)
- Include different growth stages
- Include weeds at various sizes (5mm to 10cm)

### Step 1.2: Annotate Images
- Use Roboflow or LabelImg
- Classes:
  ```
  crop_tomato    — tomato plants
  crop_chili     — chili/spicy pepper plants
  crop_flower    — flower plants
  weed_grass     — grass-type weeds
  weed_dandelion — dandelion and similar
  weed_purslane  — purslane and similar
  weed_amaranth  — amaranth and similar
  weed_other     — unknown weed species
  ```

### Step 1.3: Train Three Models

#### Model A: EfficientNet Classifier (Image-level)
- Input: whole image or cropped plant
- Output: class probabilities (which weed/crop type)
- Best for: understanding WHAT the plant is
- File: `models/efficientnet_weeds.pt`

#### Model B: YOLOv8 Detector (Pixel-level)
- Input: full field image
- Output: bounding boxes + class labels
- Best for: WHERE the weed is (for cutting)
- File: `models/yolo_weeds.pt`

#### Model C: DINOv2 + CLIP (Feature understanding)
- DINOv2: extracts rich visual features without labels
- CLIP: matches images to text descriptions
- Best for: understanding weed characteristics, zero-shot ID
- Used during training to augment Model A & B

---

## Phase 2: Camera Calibration

### Step 2.1: Intrinsic Calibration
- Print 9x6 checkerboard
- Take 15-20 photos at different angles
- Run `cv2.calibrateCamera()` → camera matrix + distortion

### Step 2.2: Extrinsic Calibration
- Place 8-12 ArUco markers on ground at known positions
- Capture image, detect marker centers
- Compute homography: `cv2.findHomography(pixel_pts, world_pts)`
- Store in `models/calibration.npz`

### Step 2.3: Verify Accuracy
- Project test points through homography
- Measure physical error (target: <2mm)
- If >2mm, add more calibration points

---

## Phase 3: Gantry Hardware

### Step 3.1: Build Gantry Frame
- 2020 aluminum extrusion X-Y axes
- NEMA 17 steppers with GT2 belts
- Travel range: 600mm x 400mm (adjustable)

### Step 3.2: Wire Electronics
```
Raspberry Pi 5
  ├── USB Camera (detection input)
  ├── USB → Serial → RAMPS 1.4
  │     ├── X stepper (A4988)
  │     ├── Y stepper (A4988)
  │     └── Laser MOSFET (M106 pin)
  └── GPIO → Emergency stop button
```

### Step 3.3: Firmware
- Flash Marlin to RAMPS/Mega
- Configure steps/mm for your belt pitch
- Test G-code movement: `G1 X100 Y100 F3000`

---

## Phase 4: Laser Setup

### Specifications
- **Wavelength:** 450nm (blue diode) — best chlorophyll absorption
- **Power:** 50-100W optical
- **Spot size:** 3-6mm (adjustable lens)
- **Dwell time:** 0.2-0.4s per weed
- **Working distance:** 300-500mm from ground

### Safety Requirements
- Class 4 laser safety goggles (OD5+ @ 450nm)
- Enclosed working area with interlock
- Emergency stop button
- Warning signage
- Never leave unattended during operation

---

## Phase 5: Integration & Testing

### Pipeline Flow
```
Camera.capture()
    → YOLO.detect(frame)           # ~110ms on Pi 5
    → for each weed detection:
        → pixel_to_gantry(u,v)     # ~0.1ms
        → gantry.move_to(x,y)     # ~500ms
        → laser.fire(duration)     # ~300ms
    → gantry.move_home()
    → repeat
```

### Testing Checklist
- [ ] Each model loads and predicts correctly
- [ ] Calibration accuracy < 2mm
- [ ] Gantry moves to correct positions
- [ ] Laser fires at correct duration
- [ ] Emergency stop works
- [ ] Full pipeline runs end-to-end
- [ ] Test on real field with actual weeds

---

## Timeline

| Week | Task | Deliverable |
|------|------|-------------|
| 1 | Collect field photos, annotate dataset | Labeled dataset (200+ images) |
| 2 | Train EfficientNet + YOLOv8 models | Working .pt files |
| 3 | Build gantry frame, wire electronics | Moving gantry |
| 4 | Camera calibration, homography code | Calibration saved |
| 5 | Integrate detection → movement → laser | End-to-end pipeline |
| 6 | Field testing, tune parameters | Working prototype |

---

## Key Research References

1. **DINOv3 + YOLO26** — +5.4% mAP50 for weed detection (arXiv 2603.00160)
2. **WS-DINO** — DINOv2-based weed segmentation, 88.67% mIoU (Agriculture 2026)
3. **WEEDINO-YOLOv12** — DINOv3-distilled for label-efficient training (Nature 2026)
4. **CLIP + DINOv2 + Multispectral** — 85.4% mIoU for crop/weed segmentation
