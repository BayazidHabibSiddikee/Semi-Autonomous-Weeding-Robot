# Simulation Environment

Virtual small-field environment for the weed laser rover — no hardware needed.

## 1. Python field simulator (runs the real state machine)

```bash
# headless mission on a 300x200cm field (writes last_frame.png / last_minimap.png)
python3 Navigation/sim/run_field_sim.py

# live OpenCV view: camera feed on top, field minimap below ('q' to quit)
python3 Navigation/sim/run_field_sim.py --view

# different field layout
python3 Navigation/sim/run_field_sim.py --seed 7 --max-steps 9000
```

Wires `FieldSimulator` (soil, crop rows, weeds, rover kinematics, virtual
downward camera, virtual VL53L0X ToF) into the real `RoverStateMachine`
(IDLE→FORWARD→STOP→SCAN→AIM→FIRE loop) with a color-based stand-in detector
(`ColorWeedDetector`) since the AI models aren't trained yet.

Key modules:
- `../src/field_simulator.py` — `FieldSimulator`, `FieldUltrasonic`, `FieldCamera`
- `run_field_sim.py` — runner: `SimRover` (wandering + obstacle dodging),
  `SimGimbal` (records aim pixel), `SimLaser` (eliminates weed at aim point),
  `ColorWeedDetector`

## 2. Blender 3D scene

```bash
blender -b -P build_field_scene.py        # headless: saves field_scene.blend + render
# or open field_scene.blend directly, or run the script in Blender's Text Editor
```

Builds a 6x4 m field: soil mounds, 3 tomato rows, 18 weeds, and the rover
(chassis, 4 wheels, control box, camera mast, laser arm + blue beam).

## 3. Photoreal digital twin (14 x 12 m)

```bash
python3 make_big_spec.py                      # derive big_field_spec.json from the real photo spec
blender -b --factory-startup --python blender_field_sim.py -- \
    big_field_spec.json ~/Downloads/plant_assets /tmp/big_field_frames
ffmpeg -framerate 12 -i /tmp/big_field_frames/frame_%04d.png -c:v libx264 \
    -pix_fmt yuv420p -crf 20 blender_field.mp4
```

Real Poly Haven plants, the CAD rover with its add-ons (Pi, battery, IMU,
ToF dome, ultrasonic pair, 3-DOF laser arm) on proper U-turns over 527
frames at 12 fps (~44 s). Slow crawl at 3.2 m/s; 106 dry-tinted weeds in
clusters beside each lane get zapped from the arm tip as it passes.
Env knobs: `SMOKE=1 SMOKE_FRAME=<n>` (single probe frame), `TWIN_SPEED`,
`TWIN_LASER`, `TWIN_FPS`.
