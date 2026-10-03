# Planning & Mapping Pipeline

                                        ┌──────────────┐
      phone photo ────────────────┐     │ Phone app    │
      (top view, no LiDAR)  ──────┤     │ (taps 4      │
                                  ├────►│ corners,     │
      GPS/pose of the rover ──────┘     │ sends image) │
                                        └──────┬───────┘
                                               │ Wi-Fi / MQTT
                                               ▼
                               ┌──────────────────────────────┐
                               │ Raspberry Pi 5               │
                               │                              │
                               │  1. ODM: undistort + crop    │
                               │  2. Green-mask (HSV) or      │
                               │     trained seg. model      │
                               │  3. Row extraction          │
                               │  4. Occupancy grid (soil=free│
                               │     plants/obstacles=blocked)│
                               └──────┬───────────────────────┘
                                      │ /field/occupancy_grid
                                      ▼
                               ┌──────────────────────────────┐
                               │ Planner                       │
                               │  boustrophedon (lawnmower)   │
                               │  / coverage path             │
                               └──────┬───────────────────────┘
                                      │ /rover/waypoints
                                      ▼
                               ┌──────────────────────────────┐
                               │ State machine                │
                               │  FORWARD → STOP → SCAN →    │
                               │  AIM → FIRE                  │
                               └──────┬───────────────────────┘
                                      │
                                      ▼
                                      output image
                              (coverage path overlay)

## Input

- Top-view photo from the phone (JPEG/PNG)
- Coordinates of the field's 4 corners (from the phone app)
- Ultrasonic reading if available

## Output

- Occupancy grid PNG (`Navigation/sim/last_minimap.png` style)
- Coverage path overlay PNG (`Navigation/sim/field_plan_overview.png`)
- Waypoint list the rover's state machine follows

## Why this (instead of LiDAR + SLAM)

- no LiDAR required - the field is visible from above before the robot starts
- phone sends one image, Pi 5 does everything else
- rows + boustrophedon = canonical agriculture coverage pattern

## Does cam + sonar detect edges with this?

- **Cam**: yes. The current `field_scanner.py` (HSV green mask) finds plant
  rows and crop boundary. A trained seg. model (YOLOv8-seg) will make this
  robust to lighting/angle.
- **Sonar**: not by itself. Ultrasonic gives you a 1-D distance to whatever
  is directly in front. It can't "see" the edge of the field unless you scan
  while driving (spinning the rover and recording distance/angle pairs). If
  you want it to detect edges, sweep the sensor or mount it on a servo and
  use the readings to build a tiny 1-2D point cloud. For weeding, it's used
  as a "last-2cm check" before the laser fires, not for mapping.

## Sensor upgrade decision

We settle on:

- Camera (phone or Pi cam) for global field map, rows, corners and weeds
- 1 × VL53L0X for the close-range "is the weed at the right distance?" check
- 1 × HC-SR04 as a backup / safety stop
- No LiDAR, no true VSLAM: pose comes from the phone-image plan plus simple
  rover-frame transforms

This gives us local safety while keeping the hardware inexpensive: map from
photo, waypoints from boustrophedon, one small VL53 + one sonar for the
last-second distance check.
