# FreeCAD headless script: 3-DOF laser arm for the weeding rover.
# Run: cd ~/Downloads && ./FreeCAD.AppImage -c /tmp/build_arm.py
# Units: mm. Origin = deck mount plate top-center, X = forward, Z = up.

import FreeCAD as App
import Part

doc = App.newDocument("RoverArm")
GEOM = []       # (name, shape)
def box(name, cx, cy, cz, dx, dy, dz):
    s = Part.makeBox(dx, dy, dz)
    s.translate(App.Vector(cx - dx/2.0, cy - dy/2.0, cz - dz/2.0))
    GEOM.append((name, s)); return s
def cyl(name, cx, cy, cz, r, h, axis="Z"):
    s = Part.makeCylinder(r, h)
    if axis == "Y":
        s.rotate(App.Vector(0,0,0), App.Vector(1,0,0), 90)
        s.translate(App.Vector(cx, cy - h/2.0, cz))
    elif axis == "X":
        s.rotate(App.Vector(0,0,0), App.Vector(0,1,0), 90)
        s.translate(App.Vector(cx - h/2.0, cy, cz))
    else:
        s.translate(App.Vector(cx, cy, cz - h/2.0))
    GEOM.append((name, s)); return s

# ---------------- 1. deck mount plate ----------------
box("deck_mount_plate", 0, 0, 3, 100, 80, 6)          # 100x80x6
cyl("mount_hole_ring_F",  38, 0, 6, 9, 3)             # boss over front bolt
cyl("mount_hole_ring_B", -38, 0, 6, 9, 3)             # boss over rear bolt

# ---------------- 2. yaw stage (turret) ----------------
box("yaw_servo_MG996R", 0, 0, 27.0, 40.8, 19.9, 42.0) # standing on plate
cyl("yaw_horn_disc", 0, 0, 49.6, 10.5, 3.0)           # 25T horn
cyl("turret_plate", 0, 0, 54.1, 32, 5.0)              # rotating platform
box("turret_brace", 0, 0, 58.1, 44, 8, 8)             # stiffener across plate

# ---------------- 3. shoulder joint ----------------
# servo lies across the turret, output axis lateral (Y)
box("shoulder_servo_DS3218", -14, 0, 79.2, 40.8, 19.9, 42.0)  # top face 100.2 -> pivot z 84
cyl("shoulder_shaft", 7, -14, 84.0, 4.0, 14.0, axis="Y")      # shaft outboard
cyl("shoulder_horn", 7, 7, 84.0, 12.0, 2.5, axis="Y")         # horn drives the link
cyl("shoulder_pivot_hub", 7, -7, 84.0, 12.0, 2.5, axis="Y")   # idler side

# ---------------- 4. upper link (shoulder -> elbow) ----------------
SH = (7.0, 84.0); EL = (167.0, 84.0)                   # 160 mm link, horizontal pose
box("upper_link", (SH[0]+EL[0])/2, 0, SH[1], EL[0]-SH[0], 8, 30)
cyl("upper_link_end_A", SH[0], 0, SH[1], 15, 8, axis="Y")
cyl("upper_link_end_B", EL[0], 0, EL[1], 15, 8, axis="Y")
# lightening channel through the bar
cyl("upper_link_lighten", (SH[0]+EL[0])/2, 0, SH[1], 8, 100, axis="X")
box("elbow_servo_DS3218", EL[0], 0, 62.5, 42.0, 19.9, 40.8)   # hangs below joint face
cyl("elbow_shaft", EL[0], -14, 84.0, 4.0, 14.0, axis="Y")
cyl("elbow_horn",  EL[0],  7, 84.0, 12.0, 2.5, axis="Y")

# ---------------- 5. forearm (elbow -> wrist) ----------------
W = (307.0, 84.0)                                       # 140 mm link
box("forearm", (EL[0]+W[0])/2, 0, 84.0, W[0]-EL[0], 8, 30)
cyl("forearm_end_A", EL[0], 0, 84.0, 13, 8, axis="Y")
cyl("forearm_end_B", W[0],  0, 84.0, 13, 8, axis="Y")
cyl("forearm_lighten", (EL[0]+W[0])/2, 0, 84.0, 7, 100, axis="X")
# cable channel on top of the forearm (servo + laser wiring)
box("forearm_cable_channel", (EL[0]+W[0])/2, -10, 103.0, W[0]-EL[0]-20, 8, 6)

# ---------------- 6. wrist: laser head mount ----------------
box("laser_mount_plate", W[0]+6, 0, 78.0, 36, 40, 6)
cyl("laser_clamp_ring",  W[0]+6, 0, 78.0, 14, 46, axis="X")   # module holder tube
cyl("laser_module_445nm", W[0]+14, 0, 78.0, 10.5, 48, axis="X")# diode housing
cyl("laser_lens_ring",   W[0]+42, 0, 78.0, 6.5, 4, axis="X")   # focus ring at tip
box("Harness_clip", W[0]-12, -14, 100.0, 24, 10, 4)

# ---------------- export ----------------
shapes = [s for _, s in GEOM]
comp = Part.makeCompound(shapes)
comp.exportStl("/tmp/arm_assembly.stl")

# STEP per named part into one document
for name, s in GEOM:
    obj = doc.addObject("Part::Feature", name)
    obj.Shape = s
doc.recompute()

out_dir = "/tmp/arm_parts_step"
import os
os.makedirs(out_dir, exist_ok=True)
for name in GEOM and [n for n, _ in GEOM]:
    o = doc.getObject(name)
    Part.export([o], out_dir + "/" + name + ".step")

# dimension report for README
print("PARTS:", len(GEOM))
bb = comp.BoundBox
print("BOUNDS X %.1f..%.1f  Y %.1f..%.1f  Z %.1f..%.1f" % (bb.XMin, bb.XMax, bb.YMin, bb.YMax, bb.ZMin, bb.ZMax))
print("TIP at X=%.1f Z=%.1f (reach %.0f mm from yaw axis)" % (bb.XMax, 78.0, bb.XMax - 0.0))
