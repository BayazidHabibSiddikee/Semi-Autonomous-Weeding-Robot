"""Join all rover parts into a single object named 'Rover'.

Run headless:
  blender -b field_scene.blend -P join_rover.py
"""
import os

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
PREFIXES = ("RoverChassis", "Wheel", "ControlBox", "CameraMast",
            "Camera", "LaserArm", "LaserNozzle", "LaserBeam")


def main():
    parts = [o for o in bpy.data.objects if o.name.startswith(PREFIXES)]
    print("PARTS:", [o.name for o in parts])
    bpy.ops.object.select_all(action="DESELECT")
    for o in parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = bpy.data.objects["RoverChassis"]
    bpy.ops.object.join()
    rover = bpy.context.view_layer.objects.active
    rover.name = "Rover"
    # origin at the bounding-box center so it moves/rotates predictably
    bpy.ops.object.origin_set(type="ORIGIN_GEOMETRY", center="BOUNDS")
    bpy.ops.object.select_all(action="DESELECT")
    bpy.ops.wm.save_as_mainfile(
        filepath=os.path.join(HERE, "field_scene.blend"))
    print("JOINED:", rover.name, tuple(round(v, 3) for v in rover.location))


main()
