# AI-Based Multi-Person Pose Estimation for Predictive Ergonomic Safety

## Rating: ⭐⭐⭐⭐⭐

## Tags

`YOLOv8-Pose` `Raspberry Pi` `Stepper Motor` `GPIO` `OpenCV` `Pose Estimation` `Ergonomics` `Edge AI`

## Problem

Industrial workers suffer musculoskeletal injuries from poor posture and workstations that don't adapt to their body dimensions. Current safety systems are reactive (alarms after injury), not preventive. Manual ergonomic assessments are periodic, subjective, and don't scale.

**Research Gap:** No existing system combines real-time multi-person pose estimation with closed-loop physical actuation to dynamically adapt a workstation to the worker's body — automatically and continuously.

## Research Question

Can a Raspberry Pi-based edge AI system利用多人体姿态估计实时检测工人的身高、体态和危险姿势，并通过闭环电机控制自动调整工作台高度，从而预防人体工学损伤？

**Sub-questions:**
1. How accurately can YOLOv8-Pose estimate real-world height from 2D keypoints on an edge device?
2. Can hip-knee-ankle angle analysis reliably detect dangerous lifting postures in real-time?
3. Does closed-loop ergonomic adjustment measurably reduce hazardous posture duration compared to static workstations?

## Proposed System

### Core Concept

A camera-driven system that detects multiple workers, estimates their physical dimensions and posture, then physically adjusts the workspace using motors — all on a single Raspberry Pi.

### How It Works

**Multi-Person Pose Estimation (Software):**

| Step | Action |
|------|--------|
| 1 | YOLOv8-Pose (`yolov8n-pose`) runs on Pi 5, detects all people in one pass |
| 2 | Extracts 17 keypoints per person (nose, shoulders, elbows, wrists, hips, knees, ankles) |
| 3 | Calculates height: Y(nose) − Y(ankle), calibrated to real-world centimeters |
| 4 | Calculates joint angles: hip-knee-ankle angle for lifting posture classification |
| 5 | ByteTrack assigns unique ID to each person across frames |
| 6 | If person stands at workstation → Pi triggers motor adjustment |
| 7 | If dangerous bending detected → Pi triggers buzzer + LED warning |

**Closed-Loop Actuation (Electronics):**

| Component | Specification | Purpose |
|-----------|--------------|---------|
| Raspberry Pi 5 | 8GB, BCM2712 | Main compute unit |
| USB Camera | 1080p, 30fps | Video input |
| Stepper Motor | NEMA 17 (1.8°/step) | Vertical workbench adjustment |
| Motor Driver | A4988 / TB6600 | Stepper control via GPIO |
| Linear Actuator | 12V, 100mm stroke | Physical desk height change |
| Relay Module | 4-channel, 5V | Switching actuator power |
| Buzzer | Active buzzer, 5V | Posture warning alarm |
| LEDs | Red + Green | Status indicators |
| Power Supply | 12V 5A | Motor + Pi power |
| Load Cell (optional) | 50kg, HX711 | Detect if worker is lifting heavy objects |

### Pin Mapping (Raspberry Pi GPIO)

```
GPIO 17 (Pin 11) → A4988 STEP (Stepper step signal)
GPIO 27 (Pin 13) → A4988 DIR (Stepper direction)
GPIO 22 (Pin 15) → Relay CH1 (Linear actuator UP)
GPIO 23 (Pin 16) → Relay CH2 (Linear actuator DOWN)
GPIO 24 (Pin 18) → Buzzer
GPIO 25 (Pin 22) → Green LED
GPIO 26 (Pin 37) → Red LED
I2C (SDA/SCL)    → HX711 Load Cell (optional)
```

## Technical Architecture

```
USB Camera (1080p)
       ↓
Raspberry Pi 5 (YOLOv8-Pose + OpenCV)
       ↓
┌──────┴──────┬──────────────┬─────────────┐
↓             ↓              ↓             ↓
Height      Joint Angle    Face ID     Person
Calculation  Analysis     (Optional)  Tracking
(Y nose−     (hip-knee-    (known/     (ByteTrack
  Y ankle)    ankle)       unknown)    unique IDs)
└──────┬──────┴──────────────┴─────────────┘
       ↓
Decision Engine (Python)
       ↓
┌──────┴──────┬──────────────┐
↓             ↓              ↓
Motor         Buzzer         LED
Adjustment    Warning        Status
(PWM →        (If posture    (Green=safe,
 A4988 →      angle < 150°)  Red=danger)
 Stepper)
```

## Thesis Methodology

### Phase 1: System Design & Implementation (Months 1–3)

| Task | Deliverable |
|------|-------------|
| Hardware assembly | Functional Pi + camera + motor + sensor rig |
| YOLOv8-Pose integration | Running on Pi 5 at ≥15 FPS |
| Height calibration | Conversion from pixel coords to cm using known reference |
| Joint angle calculation | Python module computing hip-knee-ankle angles |
| Motor control module | GPIO code for stepper/actuator positioning |
| Safety trigger logic | Buzzer/LED activation on dangerous posture |

### Phase 2: Experimental Evaluation (Months 4–5)

**Experiment 1 — Height Estimation Accuracy:**
- 10 participants of known heights (155cm–185cm)
- Measure at distances: 1m, 2m, 3m, 4m
- Record estimated vs actual height
- Calculate Mean Absolute Error (MAE) and RMSE

**Experiment 2 — Posture Detection Reliability:**
- Participants perform 5 tasks: standing, sitting, bending forward, lifting box, reaching overhead
- System classifies posture in real-time
- Compare against manual observation (ground truth)
- Calculate Precision, Recall, F1-Score

**Experiment 3 — Ergonomic Adjustment Response Time:**
- Measure time from person detection → motor completion
- Target: <3 seconds from detection to workbench at correct height
- Test with 5, 10, 15 participants approaching sequentially

**Experiment 4 — Comparative Study:**
- Group A: Workers at static-height workbench (no system)
- Group B: Workers at AI-adjusted workbench
- Measure: time spent in dangerous posture (video annotation)
- Hypothesis: Group B shows ≥40% reduction in hazardous posture duration

### Phase 3: Analysis & Thesis Writing (Month 6)

- Statistical analysis (paired t-test, ANOVA)
- Comparison with related work
- Limitations and future work
- Thesis document preparation

## Evaluation Metrics

| Metric | Target |
|--------|--------|
| Height estimation MAE | <3 cm at 2m distance |
| Posture classification F1 | >0.85 |
| Detection-to-actuation latency | <3 seconds |
| Multi-person tracking accuracy | >90% ID consistency |
| System FPS on Pi 5 | ≥15 FPS |

## Society Impact

- Prevents workplace musculoskeletal disorders (MSDs)
- Reduces worker compensation costs
- Scalable to factories, warehouses, workshops
- Non-invasive (camera-based, no wearables required)
- Real-time feedback vs periodic manual assessments

## Environmental Impact

- Low-power edge device (Pi 5: ~5W) vs cloud processing
- Reduces workplace injury waste (fewer discarded materials from errors)
- Extends equipment lifespan through proper ergonomic use

## Connection to Supervisor's Work

Directly builds on [[Teacher_Profile]]'s **Machine Vision** expertise:
- His gait recognition papers ([[IEEE_Paper_Gait_Recognition]], BiGaitNet) use the same deep learning pipeline (Vision Transformer + keypoint extraction)
- This project extends human pose analysis from *identification* to *ergonomic safety*
- Strong potential for co-authorship on an IEEE conference paper

## Bill of Materials (Estimated Cost)

| Component | Approx. Cost (BDT) |
|-----------|-------------------|
| Raspberry Pi 5 (8GB) | 8,000 |
| USB Webcam (1080p) | 1,500 |
| NEMA 17 Stepper Motor | 1,200 |
| A4988 Driver Module | 300 |
| 12V Linear Actuator | 2,500 |
| 4-Channel Relay Module | 400 |
| Buzzer + LEDs | 100 |
| 12V 5A Power Supply | 800 |
| 3D Printed Mounts | 500 |
| **Total** | **~15,300** |

## Feasibility

- ✅ YOLOv8n-pose runs on Pi 5 at usable FPS
- ✅ All components locally available or shippable
- ✅ Clear quantitative evaluation metrics
- ✅ 6-month timeline realistic for MTE thesis
- ✅ Publication potential (IEEE conference)
- ✅ Leverages supervisor's Machine Vision expertise
