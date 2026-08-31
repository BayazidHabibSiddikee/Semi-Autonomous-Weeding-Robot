# Camera Calibration Guide

## Overview

Calibration maps pixel coordinates (u,v) from the camera image to real-world gantry coordinates (X,Y mm). This is essential for the laser to hit the exact weed position.

## Two-Step Process

### Step 1: Intrinsic Calibration

Determines the camera's internal parameters (focal length, lens distortion).

**Procedure:**
1. Print a 9x6 checkerboard pattern (squares ~25mm)
2. Take 15-20 photos from different angles and distances
3. Run the calibration script:

```bash
python src/calibration.py --mode intrinsic --images checkerboard_*.jpg
```

**Output:** `models/camera_intrinsic.npz`
- Camera matrix (3x3)
- Distortion coefficients
- Reprojection error (should be < 0.5 pixels)

### Step 2: Extrinsic Calibration (Homography)

Maps pixel positions to gantry coordinates on the ground plane.

**Procedure:**
1. Place 8-12 ArUco markers on the ground at known positions
2. Mark each marker with its (X,Y) position in mm
3. Capture an image of the marker field
4. Run the calibration:

```python
from src.calibration import CameraCalibrator

cal = CameraCalibrator()
cal.load_intrinsic("models/camera_intrinsic.npz")

# ArUco marker positions (marker_id → (X_mm, Y_mm))
marker_positions = {
    0: (0, 0),
    1: (100, 0),
    2: (200, 0),
    3: (0, 100),
    4: (100, 100),
    5: (200, 100),
    # ... more markers
}

cal.auto_calibrate_with_aruco("field_photo.jpg", marker_positions)
```

**Or use interactive mode:**
```bash
python src/calibration.py --mode interactive --camera 0
```
Click points on the camera feed and enter their real-world coordinates.

**Output:** `models/calibration.npz`
- 3x3 homography matrix H

## Verification

After calibration, verify accuracy:

```python
from src.calibration import CameraCalibrator

cal = CameraCalibrator()
cal.load_calibration()

# Test with known points
test_pairs = [
    ((320, 240), (150, 100)),  # pixel(u,v) → expected (X_mm, Y_mm)
    ((100, 100), (30, 20)),
    ((500, 400), (250, 180)),
]

mean_error = cal.verify_calibration(test_pairs)
# Target: mean_error < 2mm
```

## Usage in Pipeline

```python
# Convert detected weed pixel position to gantry coordinates
u, v = weed_center_pixels
x_mm, y_mm = calibrator.pixel_to_gantry(u, v)
gantry.move_to(x_mm, y_mm)
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| High reprojection error | Take more checkerboard photos, ensure good lighting |
| Homography inaccurate | Add more calibration points, ensure flat ground |
| Distortion at edges | Crop out extreme edges, use center of image |
| Drift over time | Re-calibrate periodically, check camera mount stability |
