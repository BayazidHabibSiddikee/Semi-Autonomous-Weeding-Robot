"""Blender digital-twin field: real Poly Haven plants + CAD rover + zap anim.

Usage:
  blender -b --factory-startup --python blender_field_build.py -- \
      <spec.json> <assets_dir> <frames_out_dir>
"""
import bpy, bmesh, json, math, os, random, sys
from mathutils import Vector, Euler

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

fps = int(os.environ.get("TWIN_FPS", "12"))
V = float(os.environ.get("TWIN_SPEED", "3.2"))   # visual m/s (slow rover)
LASER_RANGE = float(os.environ.get("TWIN_LASER", "0.35"))
LEGS = len(LANES)
R_MAX = max((LANES[i + 1] - LANES[i]) / 2.0 for i in range(LEGS - 1)) if LEGS > 1 else 0.0
X_END = ENDS - R_MAX          # keep the U-turn bulge inside the headland
LEG_LEN = 2.0 * X_END
# path model: straight legs + semicircular U-turns between lanes
SEGMENTS = []
leg_start_s = []
def build_path():
    s = 0.0
    for i in range(LEGS):
        leg_start_s.append(s)
        SEGMENTS.append(("leg", s, s + LEG_LEN, i))
        s += LEG_LEN
        if i < LEGS - 1:
            r = (LANES[i + 1] - LANES[i]) / 2.0
            SEGMENTS.append(("arc", s, s + math.pi * r, (i, r)))
            s += math.pi * r
    return s
TOTAL_S = build_path()
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
row_facing = X_END - 0.15                       # rows stop before the turn zone
for row_y in ROWS:
    x = -(row_facing)
    while x <= row_facing + 1e-6:
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
    u = (wx + X_END) if lane % 2 == 0 else (X_END - wx)
    if not (-0.05 <= u <= LEG_LEN + 0.05):
        return None
    s = leg_start_s[lane] + u
    if s > TOTAL_S:
        return None
    f = int(round(s / V * fps))
    if 3 <= f <= FRAMES - 5:
        return f
    return None

WEED_DRY = {}                            # src material name -> dried copy
def dry_tint(ob):
    """Pale, dry, sun-bleached look so weeds pop against the green crop."""
    for slot, mat in enumerate(ob.data.materials):
        if mat is None:
            continue
        key = mat.name
        if key not in WEED_DRY:
            m2 = mat.copy()
            nt = m2.node_tree
            bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
            if bsdf is not None:
                b_in = bsdf.inputs["Base Color"]
                hs = nt.nodes.new("ShaderNodeHueSaturation")
                hs.inputs["Saturation"].default_value = 0.35
                hs.inputs["Value"].default_value = 1.35
                if b_in.is_linked:
                    src = b_in.links[0].from_socket
                    nt.links.remove(b_in.links[0])
                    nt.links.new(src, hs.inputs["Color"])
                else:
                    hs.inputs["Color"].default_value = tuple(b_in.default_value)
                nt.links.new(hs.outputs["Color"], b_in)
            WEED_DRY[key] = m2
        ob.data.materials[slot] = WEED_DRY[key]

for uid, (wx, wy) in enumerate(WEEDS):
    f = zap_frame_for((wx, wy))
    scale = random.uniform(1.05, 1.55)
    ob = instance(
        "nettle_" if random.random() < 0.45 else "rosette_",
        loc=(wx + random.uniform(-0.05, 0.05),
             wy + random.uniform(-0.04, 0.04), 0.0),
        rot_z=random.uniform(0, math.tau),
        scale=scale,
    )
    dry_tint(ob)
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
    for kind, s0, s1, d in SEGMENTS:
        if s0 <= s <= s1:
            if kind == "leg":
                lane = d
                u = s - s0
                if lane % 2 == 0:
                    return -X_END + u, LANES[lane], 0.0
                return X_END - u, LANES[lane], math.pi
            i, r = d
            th = (s - s0) / r          # arc angle 0..pi
            y0 = LANES[i]
            sgn = 1.0 if i % 2 == 0 else -1.0
            cx = X_END if i % 2 == 0 else -X_END
            x = cx + sgn * r * math.sin(th)
            y = y0 + r * (1.0 - math.cos(th))
            h = th if i % 2 == 0 else math.pi - th
            return x, y, h
    return -X_END, LANES[0], 0.0

rover_frames = []
for f in range(FRAMES):
    s = V * (f / fps)
    x, y, h = leg_state(s)
    rover_frames.append((x, y, h))

turret_empty = bpy.data.objects.new("Turret", None)
bpy.context.scene.collection.objects.link(turret_empty)
turret_empty.parent = root
turret_empty.location = (0, 0.0, TURRET_Z)

# ------------------------------------------------------------ rover add-ons
def mate(name, col, rough=0.5, metallic=0.0, emis=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*col, 1.0)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metallic
    if emis > 0:
        b.inputs["Emission Color"].default_value = (*col, 1.0)
        b.inputs["Emission Strength"].default_value = emis
    return m

def prim(kind, name, loc, sx=0.02, sy=0.02, sz=0.02, mat=None, rot=None):
    if kind == "cube":
        bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    elif kind == "sphere":
        bpy.ops.mesh.primitive_uv_sphere_add(radius=sx, location=loc, segments=12)
    elif kind == "cyl":
        bpy.ops.mesh.primitive_cylinder_add(radius=sx, depth=sy, location=loc, vertices=14)
    ob = bpy.context.object
    ob.name = name
    if kind == "cube":
        ob.scale = (sx, sy, sz)
    if rot:
        ob.rotation_euler = rot
    if mat:
        ob.data.materials.clear()
        ob.data.materials.append(mat)
    ob.parent = root
    return ob

PC5 = (0.148, 0.030)                      # Pi 5 centre on the deck
ESP = (-0.118, -0.098)                    # ESP32 DevKit centre
CAMPOS = (0.198, -0.090)                  # CSI camera module centre
M_PI5 = mate("pi5PcbDark", (0.045, 0.048, 0.052), rough=0.45)
M_SIL = mate("silver", (0.72, 0.73, 0.76), rough=0.28, metallic=0.9)
M_GLD = mate("gold", (0.85, 0.65, 0.2), rough=0.3, metallic=0.9)
M_BLK = mate("mattBlack", (0.03, 0.03, 0.033), rough=0.6)
M_STRAP = mate("strap", (0.25, 0.25, 0.28), rough=0.8)
M_ARM = mate("armGrey", (0.13, 0.13, 0.145), rough=0.42, metallic=0.75)
M_LED = mate("ledCyan", (0.1, 0.8, 0.9), rough=0.3, emis=3.0)
M_IMUPCB = mate("imuPcb", (0.05, 0.26, 0.09), rough=0.4)
M_LENS = mate("lensGlass", (0.07, 0.09, 0.14), rough=0.08)
M_ESP = mate("espPcb", (0.015, 0.02, 0.09), rough=0.5)

DECK = TURRET_Z
HULL_X = 0.235                            # front face of the scaled hull
HULL_Y = 0.150
# -- Raspberry Pi 5: dark PCB, silver CPU cap, GPIO, USB stack, WiFi shield
prim("cube", "pi5_pcb", (PC5[0], PC5[1], DECK + 0.0013), 0.085, 0.056, 0.0026, M_PI5)
prim("cube", "pi5_cpu_bcm2712", (PC5[0] + 0.026, PC5[1] - 0.006, DECK + 0.003), 0.017, 0.017, 0.0026, M_SIL)
prim("cube", "pi5_gpio_header", (PC5[0] - 0.014, PC5[1] + 0.024, DECK + 0.004), 0.051, 0.005, 0.0045, M_GLD)
prim("cube", "pi5_usb_a1", (PC5[0] + 0.0435, PC5[1] + 0.017, DECK + 0.006), 0.009, 0.0135, 0.009, M_SIL)
prim("cube", "pi5_usb_a2", (PC5[0] + 0.0435, PC5[1] + 0.001, DECK + 0.006), 0.009, 0.0135, 0.009, M_SIL)
prim("cube", "pi5_usb_c_pwr", (PC5[0] + 0.0435, PC5[1] - 0.0145, DECK + 0.005), 0.011, 0.009, 0.007, M_BLK)
prim("cube", "pi5_wifi_shield", (PC5[0] - 0.031, PC5[1] + 0.002, DECK + 0.0028), 0.013, 0.013, 0.0012, M_SIL)
prim("cube", "pi5_microsd", (PC5[0] - 0.0285, PC5[1] + 0.039, DECK + 0.002), 0.012, 0.008, 0.0015, M_BLK)
# -- ESP32 DevKit: blue-black PCB, metal RF shield, USB, boot/EN buttons
prim("cube", "esp32_pcb", (ESP[0], ESP[1], DECK + 0.0013), 0.055, 0.028, 0.0026, M_ESP)
prim("cube", "esp32_rf_shield", (ESP[0] - 0.012, ESP[1], DECK + 0.0045), 0.028, 0.021, 0.0032, M_SIL)
prim("cube", "esp32_usb", (ESP[0] + 0.0245, ESP[1], DECK + 0.005), 0.008, 0.008, 0.006, M_SIL)
prim("cube", "esp32_btn_boot", (ESP[0] + 0.018, ESP[1] - 0.008, DECK + 0.0035), 0.004, 0.004, 0.004, M_BLK)
prim("cube", "esp32_btn_en", (ESP[0] + 0.010, ESP[1] - 0.008, DECK + 0.0035), 0.004, 0.004, 0.004, M_BLK)
# -- battery (rear-left, clears the centered arm)
prim("cube", "battery_pack", (-0.112, -0.022, DECK + 0.026), 0.150, 0.080, 0.050, M_BLK)
prim("cube", "battery_strap", (-0.112, -0.022, DECK + 0.0535), 0.154, 0.020, 0.004, M_STRAP)
prim("sphere", "battery_led", (0.042, -0.054, DECK + 0.053), 0.004, mat=M_LED)
# -- IMU, CSI camera module with lens facing forward
prim("cube", "imu_board", (0.068, -0.108, DECK + 0.008), 0.028, 0.022, 0.012, M_IMUPCB)
prim("cube", "cam_pcb", (CAMPOS[0], CAMPOS[1], DECK + 0.0012), 0.025, 0.025, 0.0024, M_IMUPCB)
prim("cyl", "cam_lens", (CAMPOS[0] + 0.007, CAMPOS[1], DECK + 0.0035), 0.0085, 0.014, None, M_BLK,
     rot=(0, math.pi / 2, 0))
prim("cyl", "cam_glass", (CAMPOS[0] + 0.0125, CAMPOS[1], DECK + 0.0035), 0.007, 0.003, None, M_LENS,
     rot=(0, math.pi / 2, 0))
# -- hull sensors stay on the bumper
prim("sphere", "tof_dome_front", (HULL_X - 0.012, 0.088, DECK * 0.45), 0.018, mat=M_BLK)
for sgn in (-1, 1):
    prim("cube", f"ultra_{'L' if sgn > 0 else 'R'}",
         (HULL_X - 0.025, sgn * HULL_Y * 0.93, DECK * 0.45), 0.026, 0.020, 0.014, M_IMUPCB)
    prim("cyl", f"ultra_xducer_{'L' if sgn > 0 else 'R'}",
         (HULL_X - 0.009, sgn * HULL_Y * 0.93, DECK * 0.45), 0.0075, 0.004, None, M_SIL,
         rot=(0, math.pi / 2, 0))

# ------------------------------------------------------------- 3-DOF arm
def tube(name, r, p0, p1, mat):
    d = Vector(p1) - Vector(p0)
    mid = (Vector(p0) + Vector(p1)) / 2
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=d.length,
                                        location=mid, vertices=14)
    ob = bpy.context.object
    ob.name = name
    ob.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
    ob.data.materials.clear()
    ob.data.materials.append(mat)
    ob.parent = turret_empty
    return ob

def ball(name, r, p, mat):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=p, segments=14)
    ob = bpy.context.object
    ob.name = name
    ob.data.materials.clear()
    ob.data.materials.append(mat)
    ob.parent = turret_empty
    return ob

S = Vector((0.045, 0.0, 0.115))
DIR1 = Vector((0.766, 0.0, 0.643))            # shoulder raised ~40 deg
E = S + 0.150 * DIR1
DIR2 = Vector((0.342, 0.0, -0.940))           # elbow folds down ~70 deg
W = E + 0.130 * DIR2
TIP = W + 0.090 * DIR2
tube("arm_base_pillar", 0.034, (0.014, 0, 0.0), (0.018, 0, 0.10), M_ARM)
ball("shoulder_hub", 0.032, S, M_ARM)
tube("upper_arm", 0.020, S, E, M_ARM)
ball("elbow_hub", 0.027, E, M_ARM)
tube("forearm", 0.016, E, W, M_ARM)
ball("wrist_hub", 0.022, W, M_ARM)
tube("laser_head", 0.0115, W, TIP, M_ARM)
print(f"[build] arm tip local {TIP.x:.3f},{TIP.z:.3f}")

SWEEP_A = math.radians(12.0)                  # slow turret yaw sweep
SWEEP_T = 9.0                                 # seconds per cycle
def turret_yaw(f):
    return SWEEP_A * math.sin(2.0 * math.pi * (f / fps) / SWEEP_T)

def tip_world(f):
    x, y, h = rover_frames[f]
    rot = Euler((0, 0, h)).to_matrix()
    rot2 = Euler((0, 0, h + turret_yaw(f))).to_matrix()
    return (Vector((x, y, 0.0)) + rot @ Vector((0.0, 0.0, TURRET_Z))
            + rot2 @ TIP)

look = bpy.data.objects.new("LookTarget", None)
bpy.context.scene.collection.objects.link(look)
cam = bpy.data.cameras.new("cam")
cam.lens = 34.0
cam_ob = bpy.data.objects.new("Camera", cam)
bpy.context.scene.collection.objects.link(cam_ob)
scene.camera = cam_ob
cam_constr = cam_ob.constraints.new("TRACK_TO")
cam_constr.target = look
cam_constr.track_axis = "TRACK_NEGATIVE_Z"
cam_constr.up_axis = "UP_Y"

CAM_OFF = Vector((-1.0, -1.3, 1.15))
for f in range(FRAMES):
    x, y, h = rover_frames[f]
    root.location = (x, y, 0.0)
    root.rotation_euler = (0, 0, h)
    root.keyframe_insert("location", frame=f)
    root.keyframe_insert("rotation_euler", frame=f)
    turret_empty.rotation_euler = (0, 0, turret_yaw(f))
    turret_empty.keyframe_insert("rotation_euler", frame=f)
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
    # beam: from the ARM TIP (turret + sweep yaw) down to the weed top
    p1 = tip_world(fk)
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
scene.render.resolution_x = 840
scene.render.resolution_y = 470
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = os.path.join(OUT_DIR, "frame_")

scene.eevee.use_shadows = True

json.dump({"frames": FRAMES, "fps": fps, "lanes": LEGS, "weeds": len(WEEDS),
           "killed": killed, "crops_per_row": int((2 * row_facing) / 0.34),
           "path_m": round(TOTAL_S, 1), "v_mps": V,
           "leg_len": round(LEG_LEN, 2), "substance": "big_field"},
          open("/tmp/blender_stats.json", "w"))
REPO = "/run/media/bayazid/5f064a08-e294-4745-9a41-3920c208ef17/home/sword/Documents/projects/weed-laser-robot"
os.makedirs(f"{REPO}/Navigation/sim", exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=f"{REPO}/Navigation/sim/blender_field_sim.blend")
print("[build] rendering...")
bpy.ops.render.render(animation=True)
print("[build] done")
