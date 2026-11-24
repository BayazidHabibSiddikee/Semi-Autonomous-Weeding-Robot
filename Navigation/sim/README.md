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
