"""
Master CAD Generator: Complete Weeding Turret V7 Assembly
Parametric FreeCAD Script for Robotic Weeding System
Includes:
- Two-sided split circular C-channel base with integrated vertical servo tower (+30mm)
- Upper cylinder cage with 120-deg sector gear (Mod 1.5, R=39mm) and 3 bearing axles
- Top rotation servo pinion gear (16T, Mod 1.5, R=12mm)
- Lower split pod with MG996R servo mount and mini grinder motor mount
- 1:1 flame control gear pair (24T Mod 1.25, R=15mm)
- Native STEP, STL, and FCStd export
"""

import os
import sys
import math
import FreeCAD as App
import Part

# =========================================================================
# MASTER PARAMETERS (all units in millimeters)
# =========================================================================
CYL_PERIMETER = 220.0                        # 22 cm cylinder perimeter
CYL_RADIUS = CYL_PERIMETER / (2.0 * math.pi) # 35.01 mm radius (70.03 mm dia)
BELT_THICK = 2.0                             # 2 mm belt wall thickness
BELT_HEIGHT = 10.0                           # Height of each belt band
BELT_GAP = 20.0                              # 20 mm vertical spacing between belts

GUN_PERIMETER = 90.0                         # 9 cm gun neck perimeter
GUN_RADIUS = GUN_PERIMETER / (2.0 * math.pi) # 14.32 mm radius (28.65 mm dia)
DROP_DIST = 35.0                             # 35 mm vertical drop from lower belt to pod

# Split C-Channel Base Parameters
BASE_INNER_R = 42.0                          # Clears rotating cage (37.01mm OD)
BASE_OUTER_R = 56.0                          # Outer radius of base ring (112mm OD)

# Upper Sector Gear & Pinion Gear (Module 1.5)
TOP_MOD = 1.5
RING_FULL_TEETH = 52                         # Full-pitch tooth equivalent -> Pitch Radius = 39.0 mm
PINION_TEETH = 16                            # Pinion Pitch Radius = (16 * 1.5)/2 = 12.0 mm
TOP_SERVO_X = 39.0 + 12.0                    # 51.0 mm center-to-center mesh distance
SECTOR_ARC_DEG = 120.0                       # 120-degree sector arc

# Rear Flame Control Gear Pair (Module 1.25, 1:1 ratio)
FLAME_GEAR_MOD = 1.25
FLAME_GEAR_TEETH = 24                        # Pitch Dia = 30.0 mm (Pitch R = 15.0 mm)
KNOB_BORE_DIA = 22.2                         # Torch rear knob diameter
M3_HOLE = 3.2                                # Clear M3 screw hole
M4_HOLE = 4.2                                # Clear M4 screw hole

def make_spur_gear(num_teeth, module, height, pos=(0,0,0)):
    """Generates an involute-approximated spur gear."""
    pitch_r = (num_teeth * module) / 2.0
    root_r = pitch_r - 1.15 * module
    outer_r = pitch_r + 0.90 * module
    step = (2.0 * math.pi) / num_teeth
    pts = []
    for i in range(num_teeth):
        ac = i * step
        pts.append(App.Vector(root_r * math.cos(ac - step * 0.36), root_r * math.sin(ac - step * 0.36), 0))
        pts.append(App.Vector(outer_r * math.cos(ac - step * 0.15), outer_r * math.sin(ac - step * 0.15), 0))
        pts.append(App.Vector(outer_r * math.cos(ac + step * 0.15), outer_r * math.sin(ac + step * 0.15), 0))
        pts.append(App.Vector(root_r * math.cos(ac + step * 0.36), root_r * math.sin(ac + step * 0.36), 0))
    pts.append(pts[0])
    gear = Part.Face(Part.makePolygon(pts)).extrude(App.Vector(0, 0, height))
    gear.translate(App.Vector(*pos))
    return gear

def make_sector_gear(radius_in, pitch_r, num_total_teeth, module, arc_deg, height, z0):
    """Generates the 120-degree sector gear integral with upper belt."""
    root_r = max(radius_in, pitch_r - 1.1 * module)
    outer_r = pitch_r + 0.9 * module
    step = (2.0 * math.pi) / num_total_teeth
    num_arc = int((arc_deg / 360.0) * num_total_teeth)
    start_a = -math.radians(arc_deg / 2.0)
    pts = [App.Vector(radius_in * math.cos(start_a), radius_in * math.sin(start_a), z0)]
    for i in range(num_arc):
        ac = start_a + (i + 0.5) * step
        pts.append(App.Vector(root_r * math.cos(ac - step * 0.36), root_r * math.sin(ac - step * 0.36), z0))
        pts.append(App.Vector(outer_r * math.cos(ac - step * 0.15), outer_r * math.sin(ac - step * 0.15), z0))
        pts.append(App.Vector(outer_r * math.cos(ac + step * 0.15), outer_r * math.sin(ac + step * 0.15), z0))
        pts.append(App.Vector(root_r * math.cos(ac + step * 0.36), root_r * math.sin(ac + step * 0.36), z0))
    end_a = start_a + num_arc * step
    pts.append(App.Vector(radius_in * math.cos(end_a), radius_in * math.sin(end_a), z0))
    pts.append(pts[0])
    return Part.Face(Part.makePolygon(pts)).extrude(App.Vector(0, 0, height))

def build_master_turret_v7(output_dir=None):
    if output_dir is None:
        output_dir = os.path.dirname(os.path.abspath(__file__))

    stl_dir = os.path.join(output_dir, "stl")
    step_dir = os.path.join(output_dir, "step")
    os.makedirs(stl_dir, exist_ok=True)
    os.makedirs(step_dir, exist_ok=True)

    doc = App.newDocument("Master_Turret_V7_Complete")
    parts = {}

    def add_part(shape, name, color=(0.8, 0.8, 0.8)):
        obj = doc.addObject("Part::Feature", name)
        obj.Shape = shape.removeSplitter()
        parts[name] = obj
        return obj

    z_low_belt = 0.0
    z_up_belt = BELT_HEIGHT + BELT_GAP     # +30.0 mm
    z_top = z_up_belt + BELT_HEIGHT        # +40.0 mm
    z_pod = -DROP_DIST - 16.0              # -51.0 mm (3.5 cm clear drop)

    # =========================================================================
    # 1. TWO-SIDED C-CHANNEL BASE + INTEGRATED TOP ROTATION SERVO TOWER
    # =========================================================================
    ch_z_bot = -1.0
    ch_h = 12.0  # Captures bearings in a 6mm internal slot with 4mm opening gap
    outer_cyl = Part.makeCylinder(BASE_OUTER_R, ch_h, App.Vector(0, 0, ch_z_bot))
    inner_cut = Part.makeCylinder(BASE_INNER_R, ch_h + 4.0, App.Vector(0, 0, ch_z_bot - 2.0))
    c_ring = outer_cyl.cut(inner_cut)

    # Internal C-channel bearing groove (R = 42 to 51 mm, Z = 2.0 to 8.0 mm)
    raceway_groove = Part.makeCylinder(51.0, 6.0, App.Vector(0, 0, 2.0)).cut(
                     Part.makeCylinder(BASE_INNER_R - 1.0, 6.0, App.Vector(0, 0, 2.0)))
    c_ring = c_ring.cut(raceway_groove)

    # 4 Inward-Facing Chassis Screw Tabs at 45, 135, 225, 315 deg (M4)
    for ang_deg in [45.0, 135.0, 225.0, 315.0]:
        tab = Part.makeBox(16.0, 16.0, ch_h, App.Vector(BASE_INNER_R - 8.0, -8.0, ch_z_bot))
        tab.rotate(App.Vector(0, 0, 0), App.Vector(0, 0, 1), ang_deg)
        c_ring = c_ring.fuse(tab)
        rad = math.radians(ang_deg)
        b_hole = Part.makeCylinder(M4_HOLE / 2.0, ch_h + 4.0,
                                   App.Vector(44.0 * math.cos(rad), 44.0 * math.sin(rad), ch_z_bot - 2.0))
        c_ring = c_ring.cut(b_hole)

    # Bolt Ears at Y = +BASE_OUTER_R and Y = -BASE_OUTER_R to lock Left & Right halves together
    for y_pos in [BASE_OUTER_R - 2.0, -BASE_OUTER_R - 12.0]:
        ear = Part.makeBox(16.0, 14.0, ch_h, App.Vector(-8.0, y_pos, ch_z_bot))
        ear_bolt = Part.makeCylinder(M3_HOLE / 2.0, 24.0,
                                     App.Vector(-12.0, y_pos + 7.0, ch_z_bot + ch_h / 2.0), App.Vector(1, 0, 0))
        c_ring = c_ring.fuse(ear).cut(ear_bolt)

    # Vertical Motor Riser Tower on Right Side (+X) for the 180-Deg Cylinder Rotation Servo
    # Positions Servo Output Shaft at exact X = +51.0 mm, Y = 0.0 mm, Z = +30.0 mm
    tower_pillar = Part.makeBox(26.0, 48.0, z_up_belt - ch_z_bot, App.Vector(44.0, -24.0, ch_z_bot))
    gear_clearance = Part.makeCylinder(42.5, z_top + 10.0, App.Vector(0, 0, ch_z_bot - 2.0))
    # Servo pocket (41.0 x 20.5 mm) positioned for 51mm shaft center
    servo_pocket = Part.makeBox(21.0, 41.0, 35.0, App.Vector(44.5, -10.5, z_up_belt - 28.0))
    tower_pillar = tower_pillar.cut(gear_clearance).cut(servo_pocket)
    c_ring = c_ring.fuse(tower_pillar)

    # Split Base Along X = 0 into Left and Right Halves
    base_slit = Part.makeBox(1.5, 160.0, z_top + 20.0, App.Vector(-0.75, -80.0, ch_z_bot - 2.0))
    c_ring = c_ring.cut(base_slit)

    mask_right = Part.makeBox(120.0, 160.0, 100.0, App.Vector(0.0, -80.0, -20.0))
    mask_left = Part.makeBox(120.0, 160.0, 100.0, App.Vector(-120.0, -80.0, -20.0))
    add_part(c_ring.common(mask_right), "Base_Right_Half_With_ServoTower", (0.25, 0.28, 0.32))
    add_part(c_ring.common(mask_left), "Base_Left_Half", (0.32, 0.35, 0.40))

    # =========================================================================
    # 2. UPPER CYLINDER CAGE (2mm Belts + 120-Deg Sector Gear + 3 Bearings)
    # =========================================================================
    r_in = CYL_RADIUS                      # 35.01 mm
    r_out = CYL_RADIUS + BELT_THICK        # 37.01 mm

    low_belt = Part.makeCylinder(r_out, BELT_HEIGHT, App.Vector(0, 0, z_low_belt))
    up_belt = Part.makeCylinder(r_out, BELT_HEIGHT, App.Vector(0, 0, z_up_belt))

    # 3 Vertical Straps + 3 Radial Bearing Axles attached to Lower Ring at 120 deg
    ribs = []
    bearings_vis = []
    for ang_deg in [0.0, 120.0, 240.0]:
        rib = Part.makeBox(BELT_THICK, 10.0, z_top, App.Vector(r_in, -5.0, z_low_belt))
        axle_boss = Part.makeBox(8.0, 8.0, 8.0, App.Vector(r_out - 1.0, -4.0, 1.0))
        rib_assy = rib.fuse(axle_boss)
        rib_assy.rotate(App.Vector(0, 0, 0), App.Vector(0, 0, 1), ang_deg)
        ribs.append(rib_assy)

        rad = math.radians(ang_deg)
        bx, by = 45.0 * math.cos(rad), 45.0 * math.sin(rad)
        b_ring = Part.makeCylinder(7.5, 4.5, App.Vector(bx, by, 2.75)).cut(
                 Part.makeCylinder(3.0, 6.0, App.Vector(bx, by, 2.0)))
        bearings_vis.append(b_ring)

    # 120-Deg Sector Gear on Top Belt (Z = +30 to +40 mm, Pitch R = 39.0 mm)
    sec_gear = make_sector_gear(r_in + 0.5, 39.0, RING_FULL_TEETH, TOP_MOD,
                                SECTOR_ARC_DEG, BELT_HEIGHT, z_up_belt)
    clamp_lug = Part.makeBox(12.0, 14.0, z_top, App.Vector(-6.0, -r_out - 12.0, z_low_belt))

    upper_cage = low_belt.fuse([up_belt, sec_gear, clamp_lug] + ribs)
    cyl_bore = Part.makeCylinder(r_in, z_top + 10.0, App.Vector(0, 0, -2.0))
    slit = Part.makeBox(2.5, 25.0, z_top + 10.0, App.Vector(-1.25, -r_out - 16.0, -2.0))
    s1 = Part.makeCylinder(M3_HOLE / 2.0, 20.0, App.Vector(-10.0, -r_out - 6.0, 5.0), App.Vector(1, 0, 0))
    s2 = Part.makeCylinder(M3_HOLE / 2.0, 20.0, App.Vector(-10.0, -r_out - 6.0, z_up_belt + 5.0), App.Vector(1, 0, 0))
    upper_cage = upper_cage.cut(cyl_bore).cut(slit).cut(s1).cut(s2)

    add_part(upper_cage, "Upper_Cylinder_Cage_120degGear", (0.90, 0.50, 0.10))
    if bearings_vis:
        add_part(bearings_vis[0].fuse(bearings_vis[1:]), "Three_Bearings_On_Lower_Ring", (0.75, 0.80, 0.85))

    # =========================================================================
    # 3. TOP ROTATION MOTOR PINION GEAR (16T, Meshes with 120-Deg Sector Gear)
    # =========================================================================
    top_pinion = make_spur_gear(PINION_TEETH, TOP_MOD, BELT_HEIGHT, (TOP_SERVO_X, 0, z_up_belt))
    tp_bore = Part.makeCylinder(3.0, BELT_HEIGHT + 4.0, App.Vector(TOP_SERVO_X, 0, z_up_belt - 2.0))
    top_pinion = top_pinion.cut(tp_bore)
    add_part(top_pinion, "Top_Rotation_Motor_Pinion_16T", (0.15, 0.80, 0.90))

    # =========================================================================
    # 4. LOWER SPLIT POD (9cm Gun Hole + MG996R on Right + Grinder on Left)
    # =========================================================================
    pod_h = 16.0
    gun_collar = Part.makeCylinder(GUN_RADIUS + 4.0, pod_h, App.Vector(0, 0, z_pod))
    f_tab = Part.makeBox(12.0, 12.0, pod_h, App.Vector(-6.0, GUN_RADIUS + 2.0, z_pod))
    r_tab = Part.makeBox(12.0, 12.0, pod_h, App.Vector(-6.0, -GUN_RADIUS - 14.0, z_pod))

    # Right Side (+X): MG996R Mount (Servo Shaft at X = +30.0 mm)
    mg_box = Part.makeBox(32.0, 46.0, pod_h, App.Vector(GUN_RADIUS + 2.0, -23.0, z_pod))
    mg_cut = Part.makeBox(20.5, 41.0, pod_h + 4.0, App.Vector(19.75, -20.5, z_pod - 2.0))
    mg_mount = mg_box.cut(mg_cut)

    # Left Side (-X): Mini Grinder Motor Mount
    gr_box = Part.makeBox(32.0, 32.0, pod_h, App.Vector(-GUN_RADIUS - 34.0, -16.0, z_pod))
    gr_cut = Part.makeCylinder(13.0, pod_h + 4.0, App.Vector(-GUN_RADIUS - 18.0, 0, z_pod - 2.0))
    gr_mount = gr_box.cut(gr_cut)

    # 70-Degree Struts Connecting Lower Belt (Z=0) down 3.5cm to Lower Pod (Z=-35)
    struts = []
    for sx_s in [-1.0, 1.0]:
        for sy_ in [-9.0, 5.0]:
            p1 = App.Vector(sx_s * r_in, sy_, z_low_belt)
            p2 = App.Vector(sx_s * (r_out + 1.0), sy_, z_low_belt)
            p3 = App.Vector(sx_s * (GUN_RADIUS + 4.0), sy_, z_pod + pod_h)
            p4 = App.Vector(sx_s * GUN_RADIUS, sy_, z_pod + pod_h)
            struts.append(Part.Face(Part.makePolygon([p1, p2, p3, p4, p1])).extrude(App.Vector(0, 4.0, 0)))

    lower_pod = gun_collar.fuse([f_tab, r_tab, mg_mount, gr_mount] + struts)
    g_bore = Part.makeCylinder(GUN_RADIUS, pod_h + 10.0, App.Vector(0, 0, z_pod - 2.0))
    p_split = Part.makeBox(1.5, 80.0, 80.0, App.Vector(-0.75, -40.0, z_pod - 5.0))
    fs = Part.makeCylinder(M3_HOLE / 2.0, 20.0, App.Vector(-10.0, GUN_RADIUS + 8.0, z_pod + 8.0), App.Vector(1, 0, 0))
    rs = Part.makeCylinder(M3_HOLE / 2.0, 20.0, App.Vector(-10.0, -GUN_RADIUS - 8.0, z_pod + 8.0), App.Vector(1, 0, 0))
    lower_pod = lower_pod.cut(g_bore).cut(p_split).cut(fs).cut(rs)

    rm = Part.makeBox(100.0, 120.0, 120.0, App.Vector(0.0, -60.0, -80.0))
    lm = Part.makeBox(100.0, 120.0, 120.0, App.Vector(-100.0, -60.0, -80.0))
    add_part(lower_pod.common(rm), "Lower_Right_MG996R_Part", (0.20, 0.60, 0.85))
    add_part(lower_pod.common(lm), "Lower_Left_Grinder_Part", (0.25, 0.75, 0.40))

    # =========================================================================
    # 5. 1:1 FLAME CONTROL GEARS AT GUN END (24T Servo Gear + 24T Gas Knob Gear)
    # =========================================================================
    z_gear = z_pod - 12.0
    knob_gear = make_spur_gear(FLAME_GEAR_TEETH, FLAME_GEAR_MOD, 8.0, (0, 0, z_gear))
    knob_bore = Part.makeCylinder(KNOB_BORE_DIA / 2.0, 12.0, App.Vector(0, 0, z_gear - 2.0))
    add_part(knob_gear.cut(knob_bore), "Gas_Knob_Gear_24T", (0.95, 0.25, 0.25))

    servo_gear = make_spur_gear(FLAME_GEAR_TEETH, FLAME_GEAR_MOD, 8.0, (30.0, 0, z_gear))
    s_bore = Part.makeCylinder(3.0, 12.0, App.Vector(30.0, 0, z_gear - 2.0))
    add_part(servo_gear.cut(s_bore), "MG996R_Flame_Gear_24T", (0.95, 0.75, 0.15))

    doc.recompute()

    # Save FreeCAD native project
    fcstd_path = os.path.join(output_dir, "Master_Turret_V7_Complete.FCStd")
    doc.saveAs(fcstd_path)
    print(f"Saved FreeCAD project: {fcstd_path}")

    # Export STL and STEP files
    printable_parts = [
        "Base_Right_Half_With_ServoTower",
        "Base_Left_Half",
        "Upper_Cylinder_Cage_120degGear",
        "Three_Bearings_On_Lower_Ring",
        "Top_Rotation_Motor_Pinion_16T",
        "Lower_Right_MG996R_Part",
        "Lower_Left_Grinder_Part",
        "Gas_Knob_Gear_24T",
        "MG996R_Flame_Gear_24T"
    ]

    all_objs = []
    print("\nExporting individual 3D printing STLs and CAD STEP files:")
    for name in printable_parts:
        obj = parts[name]
        all_objs.append(obj)
        stl_path = os.path.join(stl_dir, f"{name}.stl")
        step_path = os.path.join(step_dir, f"{name}.step")
        
        # Export STL
        obj.Shape.exportStl(stl_path)
        # Export STEP
        Part.export([obj], step_path)
        vol = obj.Shape.Volume
        print(f"  [OK] {name:35s} | Vol: {vol:8.1f} mm^3 | STL & STEP exported")

    # Export Full Combined Assembly STEP
    full_assy_step = os.path.join(step_dir, "Master_Turret_V7_Assembly.step")
    Part.export(all_objs, full_assy_step)
    print(f"\nSaved full assembly STEP: {full_assy_step}")

    return parts

# Execute build automatically
out_dir = os.path.dirname(os.path.abspath(__file__))
build_master_turret_v7(out_dir)

