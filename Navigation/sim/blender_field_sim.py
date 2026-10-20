"""Blender digital-twin field: real Poly Haven plants + CAD rover + zap anim.

Usage:
  blender -b --factory-startup --python blender_field_build.py -- \
      <spec.json> <assets_dir> <frames_out_dir>
"""
import bpy, bmesh, json, math, os, random, sys
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
SPEC_PATH, ASSETS_DIR, OUT_DIR = argv
OUT_DIR = os.path.abspath(OUT_DIR)
os.makedirs(OUT_DIR, exist_ok=True)

SPEC = json.load(open(SPEC_PATH))
ROWS = SPEC["row_y_m"]            # crop row y positions
LANES = SPEC["lanes_y_m"]         # driving lanes (y across width)
WEEDS = [(w[0], w[1]) for w in SPEC["weeds"]]
W, L = SPEC["width_m"], SPEC["length_m"]
MARGIN = float(SPEC.get("headland_m", 0.2))
ENDS = L / 2.0 - MARGIN           # rover lane half-length

fps = 24
V = float(os.environ.get("TWIN_SPEED", "6.0"))   # visual m/s
LASER_RANGE = float(os.environ.get("TWIN_LASER", "0.35"))
LEGS = len(LANES)
LEG_LEN = 2.0 * ENDS
TOTAL_S = LEGS * LEG_LEN
FRAMES = int(TOTAL_S / V * fps) + 14
ROVER_TGT_LEN = 0.5               # metres, rover length in scene

print(f"[build] field {L}x{W}, {len(ROWS)} rows, {LEGS} lanes, {len(WEEDS)} weeds")
print(f"[build] path {TOTAL_S:.1f} m @ {V} m/s -> {FRAMES} frames @ {fps} fps")

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
random.seed(11)

# ---------------------------------------------------------------- library
TPL = {}

def append_templates(blend, names, key_prefix):
    path = os.path.join(ASSETS_DIR, blend)
    src = bpy.data.objects
    before = set(src.keys())
    imgs_before = set(bpy.data.images.keys())
    with bpy.data.libraries.load(path, link=False) as (data_from, data_to):
        found = [n for n in data_from.objects if n in names]
        data_to.objects = found
    # absolute-path the textures that came with this append
    for img in bpy.data.images:
        if img.name not in imgs_before and img.filepath.startswith("//"):
            img.filepath = os.path.join(os.path.dirname(path), img.filepath[2:])
            img.source = "FILE"
    for n in list(set(src.keys()) - before):
        ob = src[n]
        TPL.setdefault(f"{key_prefix}_{n}", ob)
        print(f"[build]  template {key_prefix}_{n}")

SHRUBS = ["shrub_01_a_LOD1", "shrub_01_c_LOD1", "shrub_01_d_LOD1",
          "shrub_01_e_LOD1", "shrub_01_f_LOD1"]
NETTLE = ["nettle_plant_tall_a_LOD1", "nettle_plant_tall_b_LOD1",
          "nettle_plant_medium_a_LOD1", "nettle_plant_medium_b_LOD1",
          "nettle_plant_small_a_LOD1"]
ROSETTE = ["weed_plant_02_a_LOD1", "weed_plant_02_b_LOD1", "weed_plant_02_c_LOD1",
           "weed_plant_02_d_LOD1", "weed_plant_02_e_LOD1"]
append_templates("shrub_01/shrub_01_4k.blend", SHRUBS, "shrub")
append_templates("nettle_plant/nettle_plant_4k.blend", NETTLE, "nettle")
append_templates("weed_plant_02/weed_plant_02_4k.blend", ROSETTE, "rosette")

for t in TPL.values():
    t.hide_render = True
    t.hide_viewport = True

def instance(prefix, loc, rot_z=0.0, scale=1.0):
    names = [k for k in TPL if k.startswith(prefix)]
    src = TPL[random.choice(names)]
    ob = src.copy()                      # linked mesh data, own transform
    ob.hide_render = False
    ob.hide_viewport = False
    ob.location = loc
    ob.rotation_euler = (0, 0, rot_z)
    ob.scale = (scale, scale, scale)
    bpy.context.scene.collection.objects.link(ob)
    return ob

# ---------------------------------------------------------------- environment
bpy.ops.mesh.primitive_plane_add(size=1, location=(0, 0, -0.02))
ground = bpy.context.object
ground.scale = (24, 18, 1)
soil = bpy.data.materials.new("soil")
soil.use_nodes = True
nt = soil.node_tree
bsdf = nt.nodes["Principled BSDF"]
base = nt.nodes["Principled BSDF"].inputs["Base Color"]
noise = nt.nodes.new("ShaderNodeTexNoise")
noise.inputs["Scale"].default_value = 9.0
noise.inputs["Detail"].default_value = 8.0
ramp = nt.nodes.new("ShaderNodeValToRGB")
ramp.color_ramp.elements[0].color = (0.055, 0.038, 0.022, 1)   # dark tilled soil
ramp.color_ramp.elements[1].color = (0.34, 0.22, 0.11, 1)      # dry topsoil
nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
nt.links.new(ramp.outputs["Color"], base)
bsdf.inputs["Roughness"].default_value = 0.95
bump = nt.nodes.new("ShaderNodeBump")
bump.inputs["Strength"].default_value = 1.2
big = nt.nodes.new("ShaderNodeTexNoise")
big.inputs["Scale"].default_value = 2.2
big.inputs["Detail"].default_value = 6.0
add = nt.nodes.new("ShaderNodeMath")
add.operation = "MULTIPLY_ADD"
add.inputs[1].default_value = 0.55      # fine noise weight; big clumps add the rest
add.inputs[2].default_value = 0.0
nt.links.new(noise.outputs["Fac"], add.inputs[0])
nt.links.new(big.outputs["Fac"], add.inputs[2])
bump.inputs["Strength"].default_value = 1.4
nt.links.new(add.outputs[0], bump.inputs["Height"])
nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
ground.data.materials.append(soil)

world = bpy.data.worlds.new("world")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.55, 0.65, 0.85, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 1.6
scene.world = world

sun = bpy.data.lights.new("sun", type="SUN")
sun.energy = 4.5
sun.color = (1.0, 0.96, 0.88)
sun.angle = math.radians(4)
sun_ob = bpy.data.objects.new("sun", sun)
sun_ob.rotation_euler = (math.radians(50), math.radians(8), math.radians(35))
bpy.context.scene.collection.objects.link(sun_ob)

# ---------------------------------------------------------------- crops
for row_y in ROWS:
    x = -(ENDS - 0.05)
    while x <= ENDS - 0.05 + 1e-6:
        jitter = random.uniform(-0.04, 0.04)
        instance(
            "shrub_",
            loc=(x + jitter, row_y + random.uniform(-0.03, 0.03), 0.0),
            rot_z=random.uniform(0, math.tau),
            scale=random.uniform(0.9, 1.25),
        )
        x += 0.34

# ---------------------------------------------------------------- weeds
weed_obs = []
def zap_frame_for(weed):
    wx, wy = weed
    lane = min(range(LEGS), key=lambda i: abs(LANES[i] - wy))
    if abs(LANES[lane] - wy) > LASER_RANGE:
        return None
    if lane % 2 == 0:                    # -ends -> +ends
        s_local = wx + ENDS
    else:
        s_local = ENDS - wx
    if not (-0.05 <= s_local <= LEG_LEN + 0.05):
        return None
    f = int(round((lane * LEG_LEN + s_local) / V * fps))
    if 3 <= f <= FRAMES - 5:
        return f
    return None

for uid, (wx, wy) in enumerate(WEEDS):
    f = zap_frame_for((wx, wy))
    scale = random.uniform(1.0, 1.35)
    ob = instance(
        "nettle_" if random.random() < 0.45 else "rosette_",
        loc=(wx + random.uniform(-0.05, 0.05),
             wy + random.uniform(-0.04, 0.04), 0.0),
        rot_z=random.uniform(0, math.tau),
        scale=scale,
    )
    weed_obs.append({"ob": ob, "frame": f, "base": scale})

# ---------------------------------------------------------------- rover
bpy.ops.wm.stl_import(filepath="/tmp/rover_field.stl") \
    if hasattr(bpy.ops.wm, "stl_import") else bpy.ops.import_mesh.stl(filepath="/tmp/rover_field.stl")
rover = bpy.context.selected_objects[0]
rover.name = "RoverMesh"
bpy.ops.object.select_all(action="DESELECT")
rover.select_set(True)
bpy.context.view_layer.objects.active = rover
bpy.ops.object.transform_apply(scale=True)
bb = [Vector(c) for c in rover.bound_box]
zmin = min(c.z for c in bb); zmax = max(c.z for c in bb)
xmin = min(c.x for c in bb); xmax = max(c.x for c in bb)
ymin = min(c.y for c in bb); ymax = max(c.y for c in bb)
k = ROVER_TGT_LEN / (xmax - xmin)
rover.scale = (k, k, k)
rover.location = (-(xmin + xmax) / 2 * k, -(ymin + ymax) / 2 * k, -zmin * k)
TURRET_Z = (zmax - zmin) * k           # tallest point above the ground
paint = bpy.data.materials.new("roverPaint")
paint.use_nodes = True
rb = paint.node_tree.nodes["Principled BSDF"]
rb.inputs["Base Color"].default_value = (0.55, 0.17, 0.03, 1)  # field-robot orange
rb.inputs["Roughness"].default_value = 0.45
rb.inputs["Metallic"].default_value = 0.25
rover.data.materials.clear()
rover.data.materials.append(paint)
root = bpy.data.objects.new("RoverRoot", None)
bpy.context.scene.collection.objects.link(root)
rover.parent = root

# ---------------------------------------------------------------- path/anim
def leg_state(s):
    s = max(0.0, min(s, TOTAL_S))
    lane = min(int(s // LEG_LEN), LEGS - 1)
    u = s - lane * LEG_LEN
    if lane % 2 == 0:
        x = -ENDS + u
        heading = math.pi if False else 0.0     # +X
    else:
        x = ENDS - u
        heading = math.pi                        # -X
    return x, LANES[lane], heading

rover_frames = []
for f in range(FRAMES):
    s = V * (f / fps)
    x, y, h = leg_state(s)
    rover_frames.append((x, y, h))

turret_empty = bpy.data.objects.new("Turret", None)
bpy.context.scene.collection.objects.link(turret_empty)
turret_empty.parent = root
turret_empty.location = (0, 0.10, TURRET_Z)

look = bpy.data.objects.new("LookTarget", None)
bpy.context.scene.collection.objects.link(look)
cam = bpy.data.cameras.new("cam")
cam.lens = 35.0
cam_ob = bpy.data.objects.new("Camera", cam)
bpy.context.scene.collection.objects.link(cam_ob)
scene.camera = cam_ob
cam_constr = cam_ob.constraints.new("TRACK_TO")
cam_constr.target = look
cam_constr.track_axis = "TRACK_NEGATIVE_Z"
cam_constr.up_axis = "UP_Y"

CAM_OFF = Vector((-1.9, -2.7, 2.0))
for f in range(FRAMES):
    x, y, h = rover_frames[f]
    root.location = (x, y, 0.0)
    root.rotation_euler = (0, 0, h)
    root.keyframe_insert("location", frame=f)
    root.keyframe_insert("rotation_euler", frame=f)
    look.location = (x, y, 0.12)
    look.keyframe_insert("location", frame=f)
    cam_ob.location = (x + CAM_OFF.x, y + CAM_OFF.y, CAM_OFF.z)
    cam_ob.keyframe_insert("location", frame=f)

# ---------------------------------------------------------------- laser zaps
LASER_MAT = bpy.data.materials.new("laser")
LASER_MAT.use_nodes = True
lnt = LASER_MAT.node_tree
for n in list(lnt.nodes):
    lnt.nodes.remove(n)
out = lnt.nodes.new("ShaderNodeOutputMaterial")
emis = lnt.nodes.new("ShaderNodeEmission")
emis.inputs["Color"].default_value = (1.0, 0.05, 0.02, 1)
emis.inputs["Strength"].default_value = 4.0
lnt.links.new(emis.outputs[0], out.inputs["Surface"])

killed = 0
for z in weed_obs:
    fk = z["frame"]
    ob = z["ob"]
    if fk is None:
        continue
    killed += 1
    # weed collapse
    s0 = z["base"]
    ob.scale = (s0, s0, s0)
    ob.keyframe_insert("scale", frame=fk - 2)
    ob.scale = (0.001, 0.001, 0.001)
    ob.keyframe_insert("scale", frame=fk + 4)
    # beam position: from the rover turret at the zap frame to the weed top
    x, y, h = rover_frames[fk]
    dx = 0.10 if abs(h) < 0.1 else -0.10
    p1 = Vector((x + dx, y, TURRET_Z * 0.7))
    p2 = Vector((ob.location.x, ob.location.y, 0.05))
    mid = (p1 + p2) / 2
    d = (p2 - p1)
    bpy.ops.mesh.primitive_cylinder_add(vertices=10, radius=0.006,
                                        depth=d.length, location=mid)
    beam = bpy.context.object
    beam.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
    beam.data.materials.append(LASER_MAT)
    beam.scale = (0.001, 0.001, 0.001)
    beam.keyframe_insert("scale", frame=fk - 2)
    beam.scale = (1, 1, 1)
    beam.keyframe_insert("scale", frame=fk)
    beam.scale = (0.001, 0.001, 0.001)
    beam.keyframe_insert("scale", frame=fk + 3)

print(f"[build] weeds zapped {killed}/{len(WEEDS)}")

# ---------------------------------------------------------------- render
scene.render.engine = "BLENDER_EEVEE"
scene.render.fps = fps
scene.frame_start = 0
scene.frame_end = FRAMES - 1
import os as _os
if _os.environ.get("SMOKE") == "1":
    scene.frame_start = int(_os.environ.get("SMOKE_FRAME", "0"))
    scene.frame_end = scene.frame_start
scene.render.resolution_x = 960
scene.render.resolution_y = 540
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = os.path.join(OUT_DIR, "frame_")

scene.eevee.use_shadows = True

json.dump({"frames": FRAMES, "fps": fps, "lanes": LEGS, "weeds": len(WEEDS),
           "killed": killed, "crops_per_row": int((2 * ENDS - 0.1) / 0.34)},
          open("/tmp/blender_stats.json", "w"))
REPO = "/run/media/bayazid/5f064a08-e294-4745-9a41-3920c208ef17/home/sword/Documents/projects/weed-laser-robot"
os.makedirs(f"{REPO}/Navigation/sim", exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=f"{REPO}/Navigation/sim/blender_field_sim.blend")
print("[build] rendering...")
bpy.ops.render.render(animation=True)
print("[build] done")
