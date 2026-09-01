"""Animate the rover driving along +X across the field, cutting weeds.

Rover moves from its current X to the far edge of the field.
Weeds inside the cutting band (|wy - rover_y| < CUT_HALF_W) shrink to
zero exactly when the laser nozzle passes over them.

Run headless:
  blender -b field_scene.blend -P animate_rover_run.py
"""
import math
import os

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
FPS = 24
DURATION_S = 10
FRAME_END = FPS * DURATION_S          # 240
TRAVEL_X = 4.4                        # move from x~0.8 to ~5.2 (field edge)
CUT_HALF_W = 0.35                     # half-width of the cutting band (m)
FRONT_OFFSET = 1.0                    # laser nozzle sits ~1.0 m ahead of rover origin


def clear_old_animation():
    for o in bpy.data.objects:
        o.animation_data_clear()


def get_rover():
    rover = bpy.data.objects.get("Rover")
    if rover is None:  # fall back: joined object may still carry old names
        rover = bpy.data.objects.get("RoverChassis")
    if rover is None:
        raise RuntimeError("No joined 'Rover' object found — run join_rover.py first")
    return rover


def set_linear(rover):
    ad = rover.animation_data
    if ad is None or ad.action is None:
        return
    # Blender 4.4+ slotted actions: fcurves live in channelbags
    fcurves = []
    action = ad.action
    if hasattr(action, "fcurves"):
        fcurves = list(action.fcurves)
    else:
        for layer in action.layers:
            for strip in layer.strips:
                for cb in strip.channelbags:
                    fcurves.extend(cb.fcurves)
    for fc in fcurves:
        if fc.data_path == "location":
            for kp in fc.keyframe_points:
                kp.interpolation = "LINEAR"


def animate_rover(rover):
    rover.keyframe_insert("location", frame=1)
    rover.location.x += TRAVEL_X
    rover.keyframe_insert("location", frame=FRAME_END)
    set_linear(rover)


def animate_weeds(rover):
    start_x, rover_y = rover.location.x, rover.location.y
    for o in bpy.data.objects:
        if not o.name.startswith("Weed_"):
            continue
        wx, wy = o.location.x, o.location.y
        if abs(wy - rover_y) > CUT_HALF_W:
            continue  # outside cutting band, weed survives
        t = (wx - FRONT_OFFSET - start_x) / TRAVEL_X
        f_cut = max(2, min(FRAME_END, round(1 + t * (FRAME_END - 1))))
        o.keyframe_insert("scale", frame=1)                # full size
        o.scale = (o.scale.x * 0.001, o.scale.y * 0.001, o.scale.z * 0.001)
        o.keyframe_insert("scale", frame=f_cut)            # shrinks at cut
        # zero-scale weeds vanish; also disable shadow-casting artifacts
        o.hide_render = False


def setup_render():
    sc = bpy.context.scene
    sc.render.fps = FPS
    sc.frame_start, sc.frame_end = 1, FRAME_END
    sc.render.resolution_x, sc.render.resolution_y = 1280, 720
    sc.render.image_settings.file_format = "PNG"
    sc.render.filepath = os.path.join(HERE, "anim_frames/frame_")


def main():
    clear_old_animation()
    rover = get_rover()
    animate_rover(rover)
    animate_weeds(rover)
    setup_render()
    bpy.ops.wm.save_as_mainfile(
        filepath=os.path.join(HERE, "field_scene.blend"))
    bpy.ops.render.render(animation=True)
    print("ANIMATION_DONE")


main()
