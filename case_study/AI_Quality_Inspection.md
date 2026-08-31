# AI-Based Counterfeit FMCG Detection Using Few-Shot Learning

## Rating: ⭐⭐⭐⭐⭐

## Tags

`Siamese Network` `Few-Shot Learning` `Computer Vision` `YOLOv8` `Raspberry Pi` `Conveyor Belt` `Anomaly Detection` `FMCG`

## Problem

Counterfeit fast-moving consumer goods (FMCG) — especially food and beverages — are a major problem in regional markets. Copycat brands alter logos, fonts, and packaging colors to trick consumers. Manual inspection can't scale, and standard classification models fail when new counterfeit variants appear daily.

**Research Gap:** Existing counterfeit detection systems require retraining on every new fake variant. No practical system exists that can detect *previously unseen* counterfeit packaging with only 5–10 reference images of the authentic product.

## Research Question

Can a Few-Shot Learning system based on Siamese Neural Networks detect counterfeit FMCG packaging using only a small number of authentic reference images, without requiring retraining for each new counterfeit variant?

**Sub-questions:**
1. How does a Siamese Network compare to standard CNN classification for counterfeit detection accuracy?
2. How many authentic reference images are needed for reliable few-shot detection (5, 10, 20)?
3. Can the system run in real-time on an edge device (Raspberry Pi) in a production-like environment?

## Proposed System

### Core Concept

Instead of training on every possible fake (impossible — new fakes appear daily), train the model *only* on the authentic product. Any visual deviation beyond a learned similarity threshold is flagged as a potential counterfeit.

### How It Works

**Siamese Network Pipeline (Software):**

| Step | Action |
|------|--------|
| 1 | Capture image of product on conveyor belt via USB camera |
| 2 | YOLOv8 detects and crops the product bounding box |
| 3 | Cropped image is passed through a Siamese CNN (two shared-weight branches) |
| 4 | Branch A processes the input image; Branch B processes a stored authentic reference |
| 5 | Network outputs a similarity score (0.0 = completely different, 1.0 = identical) |
| 6 | If score < threshold (e.g., 0.75) → flagged as potential counterfeit |
| 7 | Result displayed on LCD + buzzer/LED alert + logged to database |

**Conveyor Belt System (Electronics):**

| Component | Specification | Purpose |
|-----------|--------------|---------|
| Raspberry Pi 5 | 8GB | Main compute unit |
| USB Camera | 1080p, fixed mount | Product image capture |
| Conveyor Belt | 12V DC motor, 30cm wide | Product transport |
| DC Motor Driver | L298N | Conveyor speed control |
| IR Sensor | TCRT5000 | Detect product position under camera |
| Servo Motor | SG90 | Deflect rejected products |
| Solenoid Lock (optional) | 12V | Gate for rejected items |
| LCD Display | 16x2 I2C | Show pass/fail status |
| Buzzer | Active, 5V | Rejection alarm |
| LEDs | Red + Green + Yellow | Status indicators |
| Power Supply | 12V 10A | Combined system power |

### Pin Mapping (Raspberry Pi GPIO)

```
GPIO 17 (Pin 11) → L298N ENA (Conveyor speed PWM)
GPIO 27 (Pin 13) → L298N IN1 (Conveyor direction)
GPIO 22 (Pin 15) → L298N IN2 (Conveyor direction)
GPIO 23 (Pin 16) → Servo PWM (Product rejection arm)
GPIO 24 (Pin 18) → IR Sensor input (product detect)
GPIO 25 (Pin 22) → Buzzer
GPIO 26 (Pin 37) → Green LED (Authentic)
GPIO 5  (Pin 29) → Red LED (Counterfeit)
GPIO 6  (Pin 31) → Yellow LED (Processing)
I2C (SDA/SCL)    → LCD Display
```

## Technical Architecture

```
Product on Conveyor Belt
       ↓
IR Sensor detects product → triggers camera capture
       ↓
USB Camera (1080p)
       ↓
Raspberry Pi 5
       ↓
┌──────┴──────┐
↓             ↓
YOLOv8       Image
(Product      Preprocessing
 Bounding      (resize,
  Box)        normalize)
└──────┬──────┘
       ↓
Cropped Product Image
       ↓
Siamese Network (Two Branches)
       ↓                    ↓
Branch A               Branch B
(Input Image)     (Authentic Reference
                    from database)
       ↓                    ↓
    Feature Vector     Feature Vector
       ↓                    ↓
       └────────┬───────────┘
                ↓
         L1 Distance / Cosine Similarity
                ↓
         Similarity Score (0–1)
                ↓
     ┌──────────┴──────────┐
     ↓                     ↓
Score ≥ 0.75         Score < 0.75
     ↓                     ↓
  AUTHENTIC           COUNTERFEIT
     ↓                     ↓
  Green LED           Red LED + Buzzer
  LCD: "PASS"         Servo rejects item
  Log to DB           LCD: "REJECT"
```

## Siamese Network Design

```
Input Image (105×105×3)
       ↓
Conv2D(64, 3×3) → ReLU → BatchNorm → MaxPool
       ↓
Conv2D(128, 3×3) → ReLU → BatchNorm → MaxPool
       ↓
Conv2D(128, 3×3) → ReLU → BatchNorm → MaxPool
       ↓
Flatten → Dense(4096) → Sigmoid
       ↓
Output: 128-dim feature vector
       ↓
L1 Distance between two branches
       ↓
Dense(1) → Sigmoid → Similarity Score
```

## Thesis Methodology

### Phase 1: Dataset & Baseline (Months 1–2)

**Dataset Creation:**
- Collect 200+ images of authentic PRAN products (various angles, lighting)
- Collect 200+ images of counterfeit/copycat products from local markets
- Create synthetic fakes: digitally alter logos, fonts, colors using Python/PIL
- Split: 70% train, 15% validation, 15% test

**Baseline Models:**
- Train standard classifiers: ResNet-50, EfficientNet-B0, YOLOv8-cls
- Evaluate: Accuracy, Precision, Recall, F1, ROC-AUC
- This becomes the comparison benchmark

### Phase 2: Siamese Network Development (Months 2–3)

| Task | Detail |
|------|--------|
| Architecture | Implement Siamese CNN with shared weights |
| Loss Function | Contrastive Loss or Triplet Loss |
| Training | 50 epochs, Adam optimizer, lr=1e-4 |
| Reference Set | 5, 10, 20 authentic images per product |
| Evaluation | Same metrics as baseline + few-shot accuracy |

### Phase 3: Edge Deployment & Hardware (Months 3–4)

| Task | Detail |
|------|--------|
| Model optimization | Convert to TFLite, quantize to INT8 |
| Pi deployment | Run inference on Raspberry Pi 5 |
| Conveyor belt build | Assemble belt + motor + IR sensor + camera |
| Integration | Wire servo, buzzer, LEDs, LCD |
| Latency testing | Measure capture-to-decision time |

### Phase 4: Evaluation & Thesis Writing (Months 5–6)

**Experiment 1 — Accuracy Comparison:**
- Siamese Network vs. baseline classifiers
- Test with known counterfeits (seen in training)
- Test with unseen counterfeits (not in training) ← key differentiator

**Experiment 2 — Few-Shot Performance:**
- Vary reference images: 3, 5, 10, 20
- Plot accuracy vs. number of references
- Find minimum viable reference set size

**Experiment 3 — Real-Time Performance:**
- Throughput: products per minute
- Latency: capture → decision in milliseconds
- Edge vs. cloud comparison

## Evaluation Metrics

| Metric | Target |
|--------|--------|
| Seen counterfeit accuracy | >95% |
| Unseen counterfeit accuracy | >80% (few-shot advantage) |
| False positive rate | <5% |
| Inference latency (Pi 5) | <500ms per product |
| Throughput | ≥20 products/minute |
| Minimum reference images | ≤10 for reliable detection |

## Society Impact

- Protects consumers from unsafe counterfeit food products
- Safeguards brand reputation for regional manufacturers
- Scalable to retail supply chains and distributor warehouses
- Can be adapted for pharmaceuticals, cosmetics, electronics
- Supports regulatory enforcement against counterfeit goods

## Environmental Impact

- Reduces waste from counterfeit products entering supply chains
- Less manual inspection = lower energy from human lighting/HVAC
- Early rejection prevents defective packaging from reaching consumers

## Connection to Supervisor's Work

Builds on [[Teacher_Profile]]'s **Machine Vision** and deep learning expertise:
- Same CNN/ViT pipeline used in his gait recognition papers ([[IEEE_Paper_Gait_Recognition]])
- Extends vision-based classification from human identification to product authentication
- Strong co-authorship potential — counterfeit detection in FMCG is under-researched in IEEE/ACM

## Bill of Materials (Estimated Cost)

| Component | Approx. Cost (BDT) |
|-----------|-------------------|
| Raspberry Pi 5 (8GB) | 8,000 |
| USB Camera (1080p, fixed) | 1,500 |
| Conveyor Belt (30cm) | 2,000 |
| L298N Motor Driver | 300 |
| DC Motor (12V) | 800 |
| IR Sensor (TCRT5000) | 100 |
| SG90 Servo Motor | 200 |
| 16x2 I2C LCD | 300 |
| Buzzer + LEDs | 100 |
| 12V 10A Power Supply | 1,500 |
| 3D Printed Mounts | 500 |
| **Total** | **~15,300** |

## Feasibility

- ✅ Siamese Networks well-documented, many open-source implementations
- ✅ MVTec AD dataset provides baseline for anomaly detection comparison
- ✅ Custom dataset achievable (local markets have abundant counterfeit products)
- ✅ YOLOv8n runs on Pi 5; Siamese Net is lightweight after quantization
- ✅ Clear quantitative evaluation (accuracy, F1, latency, throughput)
- ✅ 6-month timeline realistic for MTE thesis
- ✅ Novel angle — few-shot counterfeit detection in FMCG is under-researched
