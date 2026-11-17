# 🌿 SmartWeeder — Autonomous Weed Detection & Removal Robot

<div align="center">

![Status](https://img.shields.io/badge/Status-Active%20Development-brightgreen?style=for-the-badge)
![Python](https://img.shields.io/badge/Python-3.10+-3776AB?style=for-the-badge&logo=python&logoColor=white)
![C++](https://img.shields.io/badge/C++-Arduino-00599C?style=for-the-badge&logo=cplusplus&logoColor=white)
![YOLOv8s](https://img.shields.io/badge/YOLOv8s-Ultralytics-FF4500?style=for-the-badge)
![Raspberry Pi](https://img.shields.io/badge/Raspberry%20Pi%205-A22846?style=for-the-badge&logo=raspberrypi&logoColor=white)
![ESP32](https://img.shields.io/badge/ESP32-Microcontroller-E7352C?style=for-the-badge&logo=espressif&logoColor=white)

**An end-to-end autonomous agricultural robot that detects and physically eradicates weeds using edge AI, cloud-based continuous retraining, and embedded hardware — reducing herbicide use and enabling precision farming.**

[Overview](#-overview) · [Architecture](#-system-architecture) · [Hardware Stack](#-hardware-stack) · [Getting Started](#-getting-started) · [Repository Structure](#-repository-structure) · [How It Works](#-how-it-works) · [Contributing](#-contributing)

</div>

---

## 📖 Overview

SmartWeeder is a fully autonomous ground robot designed for **precision weed management** in agricultural fields. It combines real-time computer vision at the edge with a cloud-based continuous retraining loop to improve its accuracy over time. Rather than blanket-spraying herbicides, SmartWeeder navigates rows of crops, identifies weeds using a YOLOv8s model running on a Raspberry Pi 5, and physically removes them via a motorized cutter mechanism — all without human intervention.

### ✨ Key Features

- 🔍 **Real-time weed detection** using a fine-tuned YOLOv8s model running at the edge on a Raspberry Pi 5
- 🤖 **Autonomous navigation & actuation** via ESP32-driven motor controllers and a physical cutting mechanism
- ☁️ **Continuous learning pipeline** — annotate new images in a Streamlit web app, sync to Kaggle, retrain on the full combined dataset, and auto-deploy
- 🔁 **Hourly model polling** — the Pi checks Kaggle every hour and auto-downloads any newer model version
- 📡 **Serial UART communication** between the Pi (brain) and ESP32 (body) for low-latency motor commands
- 🌱 **Eco-friendly & chemical-free** — eliminates targeted weeds mechanically, preserving soil health

---

## 🏗️ System Architecture

```
+------------------------------------------------------------------+
|                    CLOUD TRAINING LAYER                          |
|                                                                  |
|  +----------------------+       +----------------------------+   |
|  |  Streamlit           |       |  Kaggle Dataset            |   |
|  |  Annotation App      |       |                            |   |
|  |                      | push  |  Existing images           |   |
|  |  - Upload images     +-----> |  +                         |   |
|  |  - Draw bboxes       | data  |  New annotated images      |   |
|  |  - Label weeds       |       |  (merged into one dataset) |   |
|  +----------------------+       +-------------+--------------+   |
|                                               |                  |
|                                     Trigger full retrain         |
|                                     on combined dataset          |
|                                               |                  |
|                                 +-------------v--------------+   |
|                                 |  YOLOv8s Training Notebook |   |
|                                 |  (Kaggle GPU Runtime)      |   |
|                                 |                            |   |
|                                 |  Saves versioned best.pt   |   |
|                                 |  as dataset output         |   |
+---------------------------------+-------------+--------------+---+
                                               |
                                    Versioned best.pt
                                    available on Kaggle
                                               |
+----------------------------------------------v-------------------+
|                    EDGE LAYER  (Raspberry Pi 5)                  |
|                                                                  |
|  +--------------------------------------------------------------+|
|  |                 Hourly Background Scheduler                  ||
|  |                                                              ||
|  |  Every 60 min --> Poll Kaggle API for latest version         ||
|  |                            |                                 ||
|  |             New version available?                           ||
|  |              YES |                    NO |                   ||
|  |                  v                       v                   ||
|  |     Download best.pt             Skip, continue              ||
|  |     Replace model in             with current model          ||
|  |     yolo_models/                                             ||
|  +--------------------------------------------------------------+|
|                                                                  |
|  USB Camera --> Capture Frame --> YOLOv8s Inference              |
|                                         |                        |
|                                Weed detected?                    |
|                                    YES  |                        |
|                                         v                        |
|                           Send UART command to ESP32             |
+------------------------------------------+-----------------------+
                                           |
                                     Serial / UART
                                           |
+------------------------------------------v-----------------------+
|                   ACTUATION LAYER  (ESP32)                       |
|                                                                  |
|  Receive UART command                                            |
|       |                                                          |
|       v                                                          |
|  [1] Halt drive motors                                           |
|       |                                                          |
|       v                                                          |
|  [2] Activate cutter mechanism  (preset duration)               |
|       |                                                          |
|       v                                                          |
|  [3] Resume navigation                                           |
|                                                                  |
|  Motor Driver A  -->  DC Drive Motors   (locomotion)             |
|  Motor Driver B  -->  Cutter Mechanism  (weed removal)           |
+------------------------------------------------------------------+
```

---

## 🛠️ Hardware Stack

| Component | Role | Details |
|---|---|---|
| **Raspberry Pi 5** | Main compute / AI inference | Runs YOLOv8s, manages camera stream, model polling & UART |
| **ESP32** | Embedded motor controller | Receives UART commands, drives motors & cutter |
| **USB Web Camera** | Vision input | Live field video feed for inference |
| **Motor Drivers (×2)** | Power interface | Controls DC drive motors and cutter motor |
| **DC Drive Motors** | Locomotion | Moves robot autonomously across field rows |
| **Cutting Mechanism** | Weed removal | Physically severs weed at root level |
| **Power Supply** | Onboard power | LiPo / Li-ion battery bank (field-deployable) |

> 📐 Full wiring diagrams, circuit schematics, and hardware assembly guides are available in the [`docs/`](./docs/) directory.

---

## 📁 Repository Structure

```
smartweeder/
│
├── cloud_trainer/               # Cloud training & annotation pipeline
│   ├── app.py                   # Streamlit web app for image annotation & Kaggle sync
│   └── dataset-metadata.json    # Kaggle dataset configuration
│
├── pi5_code/                    # Raspberry Pi 5 edge inference code
│   └── raspberry_pi_prog.py     # Main loop: camera -> YOLOv8s -> UART + hourly model polling
│
├── esp32_code/                  # ESP32 embedded firmware
│   └── allmotor_control.ino     # Motor driver control & cutter trigger logic
│
├── yolo_models/                 # Trained model weights
│   └── best.pt                  # Active YOLOv8s weights (auto-updated hourly from Kaggle)
│
├── docs/                        # Project documentation
│   ├── circuit_diagram.pdf      # Full wiring schematic
│   └── hardware_assembly.md     # Step-by-step hardware build guide
│
└── README.md
```

---

## 🚀 Getting Started

### Prerequisites

- Python 3.10+ with `pip`
- Arduino IDE (for ESP32 flashing)
- Kaggle account with API credentials configured (`~/.kaggle/kaggle.json`)
- Raspberry Pi 5 running Raspberry Pi OS (64-bit)

---

### 1️⃣ Cloud Training Pipeline

Use the Streamlit annotation app to label new field images and push them to Kaggle for retraining:

```bash
# Install dependencies
pip install streamlit ultralytics kaggle

# Launch the annotation app
streamlit run cloud_trainer/app.py
```

Inside the app you can:
- Upload raw field images and draw bounding boxes around weeds
- Push annotated data to Kaggle (configured via `dataset-metadata.json`)
- The Kaggle notebook then merges new images with the existing full dataset and triggers a complete YOLOv8s retrain
- The resulting `best.pt` is saved as a versioned Kaggle dataset output

---

### 2️⃣ Initial Edge Setup (Raspberry Pi 5)

Install the required dependencies on the Pi. After the first setup, all subsequent model updates are handled **automatically** every hour.

```bash
# On the Raspberry Pi 5
pip install ultralytics pyserial opencv-python kaggle

# Pull the initial model weights (first-time only)
kaggle datasets download <your-username>/<your-dataset> -p yolo_models/ --unzip

# Verify
ls yolo_models/
# --> best.pt
```

---

### 3️⃣ Flash the ESP32

1. Open `esp32_code/allmotor_control.ino` in the **Arduino IDE**
2. Select the correct board: `Tools → Board → ESP32 Dev Module`
3. Select the correct COM port and click **Upload**
4. Connect the ESP32 to the Raspberry Pi via USB serial (UART)

---

### 4️⃣ Run the Robot

```bash
# On the Raspberry Pi 5
# Starts the autonomous detect-and-eradicate loop
# + launches the hourly Kaggle model polling background thread
python3 pi5_code/raspberry_pi_prog.py
```

The robot will:
1. Start the USB camera stream
2. Run YOLOv8s inference on each captured frame
3. On weed detection, send a UART command to the ESP32
4. The ESP32 halts navigation, activates the cutter, then resumes
5. Every hour, a background thread checks Kaggle for a newer `best.pt` and downloads it automatically if found

---

## ⚙️ How It Works

### 1. Annotation & Upload
New field images are uploaded and annotated via the Streamlit web app. Bounding boxes are drawn around weeds and the labeled data is pushed to the configured Kaggle dataset.

### 2. Full Cloud Retrain
On Kaggle, the training notebook merges the newly uploaded images with the **full existing dataset** and triggers a complete YOLOv8s retrain using Kaggle's GPU runtime. The best-performing weights (`best.pt`) are saved as a versioned dataset output, making them immediately available via the Kaggle API.

### 3. Hourly Model Polling
A background thread on the Pi queries the Kaggle API **once every hour**, comparing the latest dataset version number against the currently loaded model. If a newer version is found, the Pi automatically downloads `best.pt` into `yolo_models/` — no manual intervention or SSH required. The next inference cycle picks up the updated weights seamlessly.

### 4. Real-Time Inference
The Pi continuously captures frames from the USB camera and feeds them through YOLOv8s. When a weed is detected above the confidence threshold, a cut command is sent over UART to the ESP32.

### 5. Actuation
The ESP32 listens on its serial interface for commands from the Pi. Upon receiving a weed-detected signal, it halts the drive motors, activates the cutter for a preset duration, then resumes autonomous navigation.

---

## 📊 Model Details

| Metric | Value |
|---|---|
| Model variant | YOLOv8s (small) |
| Input resolution | 640 × 640 |
| Training platform | Kaggle (GPU runtime) |
| Inference device | Raspberry Pi 5 (CPU) |
| Model update cadence | Hourly auto-poll from Kaggle |
| Detection classes | `weed`, `crop` |

> ⚡ For improved throughput, `best.pt` can be exported to ONNX or TFLite format for faster CPU inference on the Pi 5.

---

## 🌱 Motivation & Impact

Conventional weed management relies heavily on broadcast herbicide spraying — costly, environmentally harmful, and increasingly ineffective against herbicide-resistant weed species. SmartWeeder addresses this with a **mechanical, chemical-free alternative** that:

- Targets and removes only detected weeds, leaving surrounding crops untouched
- Reduces herbicide usage and associated environmental runoff
- Lowers operational costs for small-to-mid-scale farmers
- Operates fully autonomously, reducing manual labor requirements
- Continuously improves detection accuracy through the cloud retraining loop

---

## 🤝 Contributing

Contributions are welcome — whether it's expanding the dataset, optimizing inference speed, or improving the hardware design. Feel free to open an issue or submit a pull request.

```bash
# Fork the repo, then:
git checkout -b feature/your-feature-name
git commit -m "Add: your feature description"
git push origin feature/your-feature-name
# Open a Pull Request
```

---

## 📄 License

This project is licensed under the MIT License. See [`LICENSE`](./LICENSE) for details.

---

<div align="center">

Built with ❤️ for sustainable agriculture · Powered by YOLOv8s, Raspberry Pi 5 & ESP32

</div>
