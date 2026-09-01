"""Build the 3D weed-field + rover scene in Blender.

Run inside Blender (headless works too):
  blender -b -P build_field_scene.py   # builds + saves .blend + render
  # or from Blender's Text Editor: Run Script
"""
import math
import os
import random

import bpy

rng = random.Random(42)
FIELD_W, FIELD_H, ROW_SP = 6.0, 4.0, 1.2  # meters (300x200cm field)
HERE = os.path.dirname(os.path.abspath(__file__))


def mat(name, color, rough=0.9):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = rough
    return m


def build():
    # clean scene
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()

    soil_m = mat("Soil", (0.28, 0.17, 0.10))
    crop_m = mat("CropGreen", (0.10, 0.45, 0.12))
    weed_m = mat("WeedGreen", (0.35, 0.75, 0.30))
    metal_m = mat("FrameMetal", (0.75, 0.77, 0.80), 0.35)
    tire_m = mat("Tire", (0.05, 0.05, 0.05))
    laser_m = mat("LaserBlue", (0.1, 0.4, 1.0), 0.2)

    # ground
    bpy.ops.mesh.primitive_plane_add(size=1, location=(FIELD_W / 2, FIELD_H / 2, 0))
    g = bpy.context.object
    g.name = "SoilGround"
    g.scale = (FIELD_W, FIELD_H, 1)
    g.data.materials.append(soil_m)

    # soil mounds (crop rows)
    for i in range(3):
        y = (i + 0.5) * ROW_SP
        bpy.ops.mesh.primitive_cube_add(size=1, location=(FIELD_W / 2, y, 0.03))
        m = bpy.context.object
        m.name = f"Mound_{i + 1}"
        m.scale = (FIELD_W * 0.95, 0.25, 0.06)
        m.data.materials.append(soil_m)

    # crop rows: tomato plants
    for i in range(3):
        y = (i + 0.5) * ROW_SP
        x = 0.3
        while x < FIELD_W - 0.2:
            bpy.ops.mesh.primitive_cylinder_add(
                radius=0.02, depth=0.35, location=(x, y, 0.18))
            bpy.context.object.name = "CropStem"
            bpy.context.object.data.materials.append(crop_m)
            for dx, dy, dz, r in [(-0.06, 0, 0.38, 0.09),
                                  (0.06, 0.02, 0.42, 0.08),
                                  (0, 0.05, 0.46, 0.07)]:
                bpy.ops.mesh.primitive_uv_sphere_add(
                    radius=r, location=(x + dx, y + dy, dz),
                    segments=12, ring_count=8)
                leaf = bpy.context.object
                leaf.name = "CropLeaf"
                leaf.data.materials.append(crop_m)
                leaf.scale = (1.3, 1.0, 0.5)
            bpy.ops.mesh.primitive_uv_sphere_add(
                radius=0.03, location=(x + 0.05, y - 0.04, 0.30))
            t = bpy.context.object
            t.name = "Tomato"
            t.data.materials.append(mat("TomatoRed", (0.8, 0.05, 0.03), 0.4))
            x += rng.uniform(0.55, 0.75)

    # scattered weeds (between rows)
    for n in range(18):
        for _ in range(40):
            wx = rng.uniform(0.2, FIELD_W - 0.2)
            wy = rng.uniform(0.2, FIELD_H - 0.2)
            if min(abs(wy - (i + 0.5) * ROW_SP) for i in range(3)) > 0.22:
                break
        bpy.ops.mesh.primitive_ico_sphere_add(
            subdivisions=2, radius=0.06, location=(wx, wy, 0.05))
        w = bpy.context.object
        w.name = f"Weed_{n + 1}"
        w.data.materials.append(weed_m)
        w.scale = (1.2, 1.2, 0.45)

    _build_rover(RX=0.8, RY=1.8, metal_m=metal_m, tire_m=tire_m,
                 laser_m=laser_m)
    _build_env_camera()


def _build_rover(RX, RY, metal_m, tire_m, laser_m):
    """Rover chassis (0.6 x 0.4 m) with camera mast and laser arm."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=(RX, RY, 0.16))
    ch = bpy.context.object
    ch.name = "RoverChassis"
    ch.scale = (0.6, 0.4, 0.08)
    ch.data.materials.append(metal_m)

    for sx in (-0.26, 0.26):
        for sy in (-0.24, 0.24):
            bpy.ops.mesh.primitive_cylinder_add(
                radius=0.09, depth=0.06, location=(RX + sx, RY + sy, 0.09),
                rotation=(0, math.pi / 2, 0))
            bpy.context.object.name = "Wheel"
            bpy.context.object.data.materials.append(tire_m)

    bpy.ops.mesh.primitive_cube_add(size=1, location=(RX + 0.08, RY, 0.28))
    e = bpy.context.object
    e.name = "ControlBox"
    e.scale = (0.16, 0.2, 0.1)
    e.data.materials.append(mat("PCB", (0.05, 0.25, 0.1), 0.5))

    # camera mast + downward camera
    bpy.ops.mesh.primitive_cylinder_add(
        radius=0.012, depth=0.3, location=(RX - 0.15, RY, 0.4))
    bpy.context.object.name = "CameraMast"
    bpy.context.object.data.materials.append(metal_m)
    bpy.ops.mesh.primitive_cube_add(size=1, location=(RX - 0.15, RY, 0.24))
    cam = bpy.context.object
    cam.name = "Camera"
    cam.scale = (0.05, 0.06, 0.04)
    cam.data.materials.append(tire_m)

    # pan-tilt arm + laser nozzle + beam
    bpy.ops.mesh.primitive_cylinder_add(
        radius=0.015, depth=0.25, location=(RX + 0.25, RY, 0.38),
        rotation=(0, math.pi / 2, 0))
    arm = bpy.context.object
    arm.name = "LaserArm"
    arm.rotation_euler = (0, math.radians(-35), 0)
    arm.data.materials.append(metal_m)
    bpy.ops.mesh.primitive_cylinder_add(
        radius=0.02, depth=0.1, location=(RX + 0.38, RY, 0.3),
        rotation=(0, math.radians(-35), 0))
    bpy.context.object.name = "LaserNozzle"
    bpy.context.object.data.materials.append(laser_m)
    bpy.ops.mesh.primitive_cylinder_add(
        radius=0.004, depth=0.5, location=(RX + 0.6, RY, 0.17),
        rotation=(0, math.radians(-55), 0))
    beam = bpy.context.object
    beam.name = "LaserBeam"
    beam.data.materials.append(mat("Beam", (0.2, 0.6, 1.0), 0.1))


def _build_env_camera():
    bpy.ops.object.light_add(type="SUN", location=(3, -2, 6))
    sun = bpy.context.object
    sun.data.energy = 4
    sun.rotation_euler = (math.radians(45), 0, math.radians(30))
    bpy.ops.object.camera_add(location=(FIELD_W / 2 - 1.5, -3.2, 3.2),
                              rotation=(math.radians(62), 0, math.radians(15)))
    bpy.context.scene.camera = bpy.context.object


def save_and_render():
    out_blend = os.path.join(HERE, "field_scene.blend")
    bpy.ops.wm.save_as_mainfile(filepath=out_blend)
    scene = bpy.context.scene
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    scene.render.filepath = os.path.join(HERE, "field_render.png")
    bpy.ops.render.render(write_still=True)
    print(f"SAVED: {out_blend}")


if __name__ == "__main__":
    build()
    save_and_render()
