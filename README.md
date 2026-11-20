# Semi-Autonomous Weeding Robot

A weed-detection and laser-elimination robot. Two generations in one repo:

1. **Project-RIPRA / Weed_Detection** — the original gantry on rails: camera
   detects weeds, gantry moves in X/Y, laser fires at fixed Z.
2. **Navigation/** — the current design: a wheeled **rover** that drives crop
   rows in a stop → scan → aim → fire → move loop, with a pan-tilt laser
   gimbal and an ultrasonic/ToF sensor for Z confirmation.

## Demo videos

| Video / Demo | What it shows |
|--------------|---------------|
| [test_video.mp4](weed_detection_bot/videos/test_video.mp4) | Real-world field camera weed detection test run with YOLOv8 |
| [rover_weeding_anim.mp4](Navigation/sim/rover_weeding_anim.mp4) | Blender 3D animation of the rover weeding a field |
| [field_sim_mission.mp4](Navigation/sim/field_sim_mission.mp4) | Full autonomous mission in the Python field simulator: the rover drives the rows, scans with its virtual camera, aims the gimbal and fires the laser at every weed (minimap below shows live position) |

### Weed Detection Field Test
![Weed Detection Demo](weed_detection_bot/videos/weed_detection_demo.gif)

*Preview from `weed_detection_bot/videos/test_video.mp4` evaluated with YOLOv8 model.*

![Field simulator mission](Navigation/sim/field_sim_mission_thumb.png)

## Repo layout

```
Navigation/            the rover (current focus)
├── src/
│   ├── state_machine.py     IDLE→FORWARD→STOP→SCAN→AIM→FIRE loop
│   ├── row_navigator.py     row-following, row-end turns, serpentine coverage
│   ├── rover_motors.py      DC motor control via ESP32 serial
│   ├── servo_gimbal.py      pan-tilt servo aiming (real + simulator)
│   ├── ultrasonic.py        VL53L0X / HC-SR04 distance readings
│   ├── esp32_bridge.py      serial protocol Pi ↔ ESP32
│   └── field_simulator.py   virtual field: soil, crop rows, weeds, ToF, camera
├── esp32_firmware/          firmware for the ESP32 motor/servo driver
├── sim/                     virtual-field runner, Blender scene, videos
│   ├── run_field_sim.py     run a full mission headless / live / recorded
│   ├── build_field_scene.py Blender 3D field + rover scene
│   └── rover_weeding_anim.mp4, field_sim_mission.mp4
├── rover_config.yaml        pins, speeds, thresholds, serial port
└── ROADMAP.md               architecture shift, budget, week plan

Weed_Detection/         detection pipeline + laser control (reused by the rover)
weed_detection_bot/     autonomous edge AI + cloud retraining weed detection bot (YOLOv8 + Pi 5 + ESP32)
Project-RIPRA/          original gantry-era project material
case_study/             supporting case study material
```

## FreeCAD simulation (real CAD rover + field)

`Navigation/sim/freecad_field_sim.py` builds the mission in **FreeCAD** using
the real chassis model from `weed_robot_chassis.FCStd` (scaled mm -> m):

* 6 x 8 m field, 9 crop rows of plants, 27 weeds
* the rover: 33 real CAD parts (TT gearboxes, DC motors, 4 wheels, bridges)
* the boustrophedon coverage path in red
* the rover drives the rows, spinning its wheels and firing the laser at
  every weed it passes

```bash
# inside FreeCAD (GUI) - build + animate + save frames
freecad                                  # then in the Python console:
#   import sys; sys.path.append("<repo>/Navigation/sim")
#   import freecad_field_sim as sim; sim.build_scene_and_animate()

# headless (geometry only)
./FreeCAD.AppImage --console Navigation/sim/freecad_field_sim.py
```

Video: `Navigation/sim/freecad_weeding_mission.mp4` (180 frames, top view).

## Run the virtual mission (no hardware needed)

```bash
# headless mission + recorded video (rover camera view on top, minimap below)
python3 Navigation/sim/run_field_sim.py --record Navigation/sim/field_sim_mission.mp4

# live OpenCV view ('q' to quit)
python3 Navigation/sim/run_field_sim.py --view

# different field layout
python3 Navigation/sim/run_field_sim.py --seed 7
```

The simulator wires the real `RoverStateMachine` into a virtual 3x2 m field,
so the exact code that will run on the rover is what gets exercised here.

## Hardware stack

```
MaixSense-A075V (20cm, 30° down) ─── USB ───► Raspberry Pi 5
                                               ├── YOLOv8 weed detection (best.pt)
                                               ├── 3D BEV furrow tracking & headland corners
                                               ├── Passive chili canopy health scanner
                                               ├── Boustrophedon map generator
                                               ├── FastAPI server → /video_feed /map_feed /cut_plan
                                               └── ESP32 (Serial /dev/ttyUSB0 @ 115200)
                                                         ├── 8-way direction: 0/45/90/135/180/225/270/315°
                                                         ├── Turret yaw servo (MG996R, 120° sector gear)
                                                         └── Relay 1: Grinder motor / Relay 2: Flame valve
```

| File | Purpose |
|------|---------|
| [`weed_detection_bot/pi_brain/pi_boustrophedon_brain.py`](weed_detection_bot/pi_brain/pi_boustrophedon_brain.py) | Main Pi runtime — weed targeting, navigation, canopy scanner, map server |
| [`weed_detection_bot/video_test.py`](weed_detection_bot/video_test.py) | Offline YOLOv8 test on `test_video.mp4` |
| [`weed_detection_bot/yolo_models/best.pt`](weed_detection_bot/yolo_models/best.pt) | Your trained YOLOv8 weed detection weights |
| [`weed_detection_bot/yolo_models/smartweeder_best.pt`](weed_detection_bot/yolo_models/smartweeder_best.pt) | Upstream SmartWeeder weights (alternate) |
| [`weed_detection_bot/esp32_code/allmotor_control.ino`](weed_detection_bot/esp32_code/allmotor_control.ino) | ESP32 firmware — servo, relay, serial command parser |
| [`weed_detection_bot/pi5_code/raspberry_pi_prog.py`](weed_detection_bot/pi5_code/raspberry_pi_prog.py) | Standalone Pi detection + GPIO runner (no MaixSense) |
| [`weed_detection_bot/cloud_trainer/app.py`](weed_detection_bot/cloud_trainer/app.py) | Streamlit annotation & Kaggle retraining pipeline |
| [`urdf/weed_laser_robot.urdf.xacro`](urdf/weed_laser_robot.urdf.xacro) | Full rover URDF: chassis + 4 wheels + turret + MaixSense + Gazebo plugins |

### Run the Pi Brain (on Raspberry Pi)

```bash
cd weed_detection_bot/pi_brain
pip install ultralytics fastapi uvicorn opencv-python-headless requests numpy
python3 pi_boustrophedon_brain.py
# Then open on phone: http://<pi-ip>:8080/video_feed   (live detections)
#                     http://<pi-ip>:8080/map_feed      (boustrophedon map)
#                     http://<pi-ip>:8080/cut_plan      (JSON: weed queue & ESP32 heading)
```

### Run offline video test (no Pi needed)

```bash
cd weed_detection_bot
python3 video_test.py
# Output: runs/weed_v1/video_test/detected_video.mp4
```

### ROS 2 / Gazebo Simulation

```bash
# Check turret + MaixSense joints in RViz2
ros2 launch urdf_tutorial display.launch.py model:=urdf/weed_laser_robot.urdf.xacro
```

See [Navigation/ROADMAP.md](Navigation/ROADMAP.md) for the full plan and
[Navigation/sim/README.md](Navigation/sim/README.md) for simulator details.
