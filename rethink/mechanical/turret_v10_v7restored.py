"""
turret_v10_v7restored.py — Weed-Laser-Robot Inner Core V10 (V7 Top Cage Restored)
====================================================================================
Changes over V9:
  1. V7 upper cylinder cage restored exactly (dual belt, 120° sector gear, rear screw lug)
  2. 625zz bearings rotated 90° onto radial axle pins — stand like wheels on lower belt
  3. Both 24T gas gears turned 90° into X-Z vertical plane, identical 6.0 mm rotor bore
  4. 70° struts from gun-collar outer wall (Z=-35) to lower cylinder belt (Z=0)
  5. RS-385 C-clamp (28 mm bore, split slit, M3 pinch bolt) on left pod
  6. MG996R pass-through horizontal cradle on right pod, shaft pointing -Y

Run headless:
    freecadcmd /path/to/turret_v10_v7restored.py

Exports:
    rethink/mechanical/stl/  (one STL per printable part)
    rethink/mechanical/step/ (one STEP per part + combined assembly STEP)
    rethink/mechanical/Turret_V10_V7Restored.FCStd
"""

import os
import math

import FreeCAD as App
import Part

# =========================================================================
# HARDWARE MODELS & V7 RESTORED PARAMETERS (in mm)
# =========================================================================
CYL_PERIMETER = 220.0                        # 22 cm cylinder perimeter
CYL_RADIUS = CYL_PERIMETER / (2.0 * math.pi) # 35.01 mm radius (70.03 mm dia)
BELT_THICK = 2.0                             # 0.2 cm / 2 mm belt wall thickness
BELT_HEIGHT = 10.0                           # Height of each belt
BELT_GAP = 20.0                              # 2 cm spacing between upper & lower belt

GUN_PERIMETER = 90.0                         # 9 cm inner perimeter for gun neck
GUN_RADIUS = GUN_PERIMETER / (2.0 * math.pi) # 14.32 mm inner radius (28.65 mm ID)
GUN_WALL = 4.2                               # Wall thickness of 9cm collar (OD = 37.05 mm)
DROP_DIST = 35.0                             # 3.5 cm clear vertical drop

# STANDARD HARDWARE MODELS
# Bearing: 625zz (ID=5mm, OD=16mm, Width=5mm) -> Or set 8.0, 22.0, 7.0 for 608zz
BEARING_ID = 5.0
BEARING_OD = 16.0
BEARING_W  = 5.0

# Mini Grinder Motor: Standard 12V RS-385 / RS-390 DC Motor (28.0 mm OD)
GRINDER_DIA = 28.0

# Top 120-Deg Sector Gear (V7 exact spec: Module 1.5, 52 full teeth, Pitch R = 39.0 mm)
TOP_MOD = 1.5
RING_FULL_TEETH = 52
SECTOR_ARC_DEG = 120.0

# Rear 1:1 Gas Flow Gears (Turned 90 deg vertical, BOTH use 6.0mm rotor bore!)
GAS_MOD = 1.25
GAS_TEETH = 24                               # Pitch Dia = 30.0 mm (1:1 mesh at X = +30.0 mm)
ROTOR_SHAFT_DIA = 6.0                        # Same 6.0 mm rotor bore for Gun Stem & MG996R!
M3_HOLE = 3.2


def make_spur_gear(num_teeth, module, height):
    """Generates a 3D-printable spur gear centered at origin along +Z."""
    pitch_r = (num_teeth * module) / 2.0
    root_r = pitch_r - 1.15 * module
    outer_r = pitch_r + 0.90 * module
    step = (2.0 * math.pi) / num_teeth
    pts = []
    for i in range(num_teeth):
        ac = i * step
        pts.append(App.Vector(root_r  * math.cos(ac - step * 0.36), root_r  * math.sin(ac - step * 0.36), 0))
        pts.append(App.Vector(outer_r * math.cos(ac - step * 0.15), outer_r * math.sin(ac - step * 0.15), 0))
        pts.append(App.Vector(outer_r * math.cos(ac + step * 0.15), outer_r * math.sin(ac + step * 0.15), 0))
        pts.append(App.Vector(root_r  * math.cos(ac + step * 0.36), root_r  * math.sin(ac + step * 0.36), 0))
    pts.append(pts[0])
    return Part.Face(Part.makePolygon(pts)).extrude(App.Vector(0, 0, height))


def make_sector_gear_v7(radius_in, pitch_r, num_total_teeth, module, arc_deg, height, z0):
    """Exact V7 120-degree sector gear on the upper belt."""
    root_r  = max(radius_in, pitch_r - 1.1 * module)
    outer_r = pitch_r + 0.9 * module
    step    = (2.0 * math.pi) / num_total_teeth
    num_arc = int((arc_deg / 360.0) * num_total_teeth)
    start_a = -math.radians(arc_deg / 2.0)
    pts = [App.Vector(radius_in * math.cos(start_a), radius_in * math.sin(start_a), z0)]
    for i in range(num_arc):
        ac = start_a + (i + 0.5) * step
        pts.append(App.Vector(root_r  * math.cos(ac - step * 0.36), root_r  * math.sin(ac - step * 0.36), z0))
        pts.append(App.Vector(outer_r * math.cos(ac - step * 0.15), outer_r * math.sin(ac - step * 0.15), z0))
        pts.append(App.Vector(outer_r * math.cos(ac + step * 0.15), outer_r * math.sin(ac + step * 0.15), z0))
        pts.append(App.Vector(root_r  * math.cos(ac + step * 0.36), root_r  * math.sin(ac + step * 0.36), z0))
    end_a = start_a + num_arc * step
    pts.append(App.Vector(radius_in * math.cos(end_a), radius_in * math.sin(end_a), z0))
    pts.append(pts[0])
    return Part.Face(Part.makePolygon(pts)).extrude(App.Vector(0, 0, height))


def build_v7_restored_inner_core():
    doc = App.newDocument("Turret_V10_V7Restored")

    def add_part(shape, name, color=(0.8, 0.8, 0.8)):
        obj = doc.addObject("Part::Feature", name)
        obj.Shape = shape.removeSplitter()
        if App.GuiUp:
            obj.ViewObject.ShapeColor = color
        return obj

    z_low_belt = 0.0
    z_up_belt  = BELT_HEIGHT + BELT_GAP     # +30.0 mm
    z_top      = z_up_belt + BELT_HEIGHT    # +40.0 mm
    pod_h      = 20.0                       # Flush 20 mm height for collar, MG996R & Grinder
    z_pod_top  = -DROP_DIST                 # -35.0 mm (3.5 cm drop below lower belt)
    z_pod_bot  = z_pod_top - pod_h          # -55.0 mm
    z_pod_mid  = z_pod_bot + pod_h / 2.0   # -45.0 mm (Horizontal axis of gun stem & MG996R)

    # =========================================================================
    # 1. V7 UPPER CYLINDER CAGE + 3 BEARINGS TURNED 90 DEGREES ON LOWER BELT
    # =========================================================================
    r_in  = CYL_RADIUS                      # 35.01 mm
    r_out = CYL_RADIUS + BELT_THICK         # 37.01 mm (2 mm belt thickness)

    low_belt = Part.makeCylinder(r_out, BELT_HEIGHT, App.Vector(0, 0, z_low_belt))
    up_belt  = Part.makeCylinder(r_out, BELT_HEIGHT, App.Vector(0, 0, z_up_belt))

    ribs = []
    bearings_90deg = []
    for ang_deg in [0.0, 120.0, 240.0]:
        rib = Part.makeBox(BELT_THICK, 10.0, z_top, App.Vector(r_in, -5.0, z_low_belt))
        # Radial boss + axle pin sticking out horizontally from lower belt at Z = 5.0 mm
        boss = Part.makeBox(3.0, 10.0, BELT_HEIGHT, App.Vector(r_out - 0.5, -5.0, z_low_belt))
        pin  = Part.makeCylinder(BEARING_ID / 2.0, BEARING_W + 2.5,
                                 App.Vector(r_out + 1.5, 0, 5.0), App.Vector(1, 0, 0))
        rib_assy = rib.fuse(boss).fuse(pin)
        rib_assy.rotate(App.Vector(0, 0, 0), App.Vector(0, 0, 1), ang_deg)
        ribs.append(rib_assy)

        # Bearing turned 90 degrees (stands vertically like a wheel on the radial pin!)
        b_cyl  = Part.makeCylinder(BEARING_OD / 2.0, BEARING_W,
                                   App.Vector(r_out + 2.0, 0, 5.0), App.Vector(1, 0, 0))
        b_hole = Part.makeCylinder(BEARING_ID / 2.0, BEARING_W + 1.0,
                                   App.Vector(r_out + 1.5, 0, 5.0), App.Vector(1, 0, 0))
        b_part = b_cyl.cut(b_hole)
        b_part.rotate(App.Vector(0, 0, 0), App.Vector(0, 0, 1), ang_deg)
        bearings_90deg.append(b_part)

    # Exact V7 120-Deg Sector Gear on Top Belt + V7 Tightening Screw Lug at -Y
    sec_gear  = make_sector_gear_v7(r_in + 0.5, 39.0, RING_FULL_TEETH, TOP_MOD,
                                    SECTOR_ARC_DEG, BELT_HEIGHT, z_up_belt)
    clamp_lug = Part.makeBox(12.0, 14.0, z_top, App.Vector(-6.0, -r_out - 12.0, z_low_belt))

    upper_cage = low_belt.fuse([up_belt, sec_gear, clamp_lug] + ribs)
    cyl_bore   = Part.makeCylinder(r_in, z_top + 10.0, App.Vector(0, 0, -2.0))
    slit       = Part.makeBox(2.5, 25.0, z_top + 10.0, App.Vector(-1.25, -r_out - 16.0, -2.0))
    s1 = Part.makeCylinder(M3_HOLE / 2.0, 20.0,
                            App.Vector(-10.0, -r_out - 6.0, 5.0), App.Vector(1, 0, 0))
    s2 = Part.makeCylinder(M3_HOLE / 2.0, 20.0,
                            App.Vector(-10.0, -r_out - 6.0, z_up_belt + 5.0), App.Vector(1, 0, 0))
    upper_cage = upper_cage.cut(cyl_bore).cut(slit).cut(s1).cut(s2)

    add_part(upper_cage, "Upper_Cylinder_Cage_V7", (0.90, 0.50, 0.10))
    print("[CAGE] Upper_Cylinder_Cage_V7 built OK")

    brg_fused = bearings_90deg[0].fuse(bearings_90deg[1:])
    add_part(brg_fused, "Three_Bearings_90deg_625zz", (0.72, 0.78, 0.85))
    print("[BEARINGS] Three_Bearings_90deg_625zz built OK — 90° vertical / wheel orientation")

    # =========================================================================
    # 2. V7 LOWER SPLIT POD (Flush Z=-35mm Top + Horizontal MG996R + RS-385 Clamp)
    # =========================================================================
    r_gun_in  = GUN_RADIUS                  # 14.32 mm inner bore
    r_gun_out = GUN_RADIUS + GUN_WALL       # 18.52 mm outer wall where struts attach

    gun_collar = Part.makeCylinder(r_gun_out, pod_h, App.Vector(0, 0, z_pod_bot))
    f_tab = Part.makeBox(12.0, 12.0, pod_h, App.Vector(-6.0,  r_gun_in + 2.0,  z_pod_bot))
    r_tab = Part.makeBox(12.0, 12.0, pod_h, App.Vector(-6.0, -r_gun_in - 14.0, z_pod_bot))

    # RIGHT SIDE (+X): V7-Style Rectangular MG996R Box — shaft points rear (-Y)!
    mg_outer    = Part.makeBox(48.0, 28.0, pod_h,     App.Vector(r_gun_out - 1.5, -14.0, z_pod_bot))
    mg_pocket   = Part.makeBox(41.0, 32.0, 14.0,      App.Vector(19.5, -16.0,       z_pod_bot + 3.0))
    mg_slot_open= Part.makeBox(36.0, 32.0, pod_h + 4, App.Vector(22.0, -16.0,       z_pod_bot - 2.0))
    mg_mount    = mg_outer.cut(mg_pocket).cut(mg_slot_open)

    # LEFT SIDE (-X): RS-385 (28 mm OD) Grinder Motor Holder — split slit + M3 bolt
    gr_r_in = GRINDER_DIA / 2.0            # 14.0 mm radius
    gr_cx   = -r_gun_out - gr_r_in - 2.0   # X = -34.52 mm
    gr_box  = Part.makeBox(34.0, 34.0, pod_h,     App.Vector(gr_cx - 17.0, -17.0, z_pod_bot))
    gr_lug  = Part.makeBox(10.0, 14.0, pod_h,     App.Vector(gr_cx - 25.0, -7.0,  z_pod_bot))
    gr_bore = Part.makeCylinder(gr_r_in,  pod_h + 4.0, App.Vector(gr_cx, 0, z_pod_bot - 2.0))
    gr_slit = Part.makeBox(14.0, 2.5,     pod_h + 4.0, App.Vector(gr_cx - 27.0, -1.25, z_pod_bot - 2.0))
    gr_bolt = Part.makeCylinder(M3_HOLE / 2.0, 20.0,
                                App.Vector(gr_cx - 21.0, -10.0, z_pod_mid), App.Vector(0, 1, 0))
    gr_mount = gr_box.fuse(gr_lug).cut(gr_bore).cut(gr_slit).cut(gr_bolt)

    # =========================================================================
    # 3. 70-DEGREE STRUTS (outer 9cm collar wall Z=-35mm → lower belt Z=0mm)
    # =========================================================================
    struts = []
    for sx_s in [-1.0, 1.0]:
        for sy_ in [-9.0, 5.0]:
            p1 = App.Vector(sx_s * 33.5, sy_,       z_low_belt + 4.0)
            p2 = App.Vector(sx_s * 36.8, sy_,       z_low_belt + 4.0)
            p3 = App.Vector(sx_s * 18.3, sy_,       z_pod_top  - 3.0)
            p4 = App.Vector(sx_s * 14.8, sy_,       z_pod_top  - 3.0)
            struts.append(
                Part.Face(Part.makePolygon([p1, p2, p3, p4, p1])).extrude(App.Vector(0, 4.0, 0))
            )

    lower_pod = gun_collar.fuse([f_tab, r_tab, mg_mount, gr_mount] + struts)

    # Trim protrusions inside cylinder bore and gun bore
    lower_pod = lower_pod.cut(Part.makeCylinder(r_in, 20.0, App.Vector(0, 0, z_low_belt - 1.0)))
    g_bore  = Part.makeCylinder(r_gun_in, pod_h + 10.0, App.Vector(0, 0, z_pod_bot - 2.0))
    p_split = Part.makeBox(1.5, 80.0, 80.0, App.Vector(-0.75, -40.0, z_pod_bot - 5.0))
    fs = Part.makeCylinder(M3_HOLE / 2.0, 20.0,
                            App.Vector(-10.0,  r_gun_in + 8.0, z_pod_mid), App.Vector(1, 0, 0))
    rs = Part.makeCylinder(M3_HOLE / 2.0, 20.0,
                            App.Vector(-10.0, -r_gun_in - 8.0, z_pod_mid), App.Vector(1, 0, 0))
    lower_pod = lower_pod.cut(g_bore).cut(p_split).cut(fs).cut(rs)

    # Split into Right (MG996R) and Left (Grinder) printable halves
    rm = Part.makeBox(120.0, 120.0, 120.0, App.Vector(  0.0, -60.0, -80.0))
    lm = Part.makeBox(120.0, 120.0, 120.0, App.Vector(-120.0, -60.0, -80.0))
    r_part = lower_pod.common(rm)
    l_part = lower_pod.common(lm)
    add_part(r_part, "Lower_Right_MG996R_Part",  (0.20, 0.60, 0.85))
    add_part(l_part, "Lower_Left_Grinder_Part",  (0.25, 0.75, 0.40))
    print("[LOWER POD] Lower_Right_MG996R_Part + Lower_Left_Grinder_Part built OK")

    # =========================================================================
    # 4. REAR 1:1 GAS GEARS (Turned 90-Deg Vertical, Identical 6.0mm Rotor Bore!)
    # =========================================================================
    y_gear = -22.0   # Right behind the lower pod on the horizontal gas-stem axis

    # Gear 1: Gun Gas Stem Gear at (X=0.0, Y=-22.0, Z=-45.0)
    g1 = make_spur_gear(GAS_TEETH, GAS_MOD, 8.0)
    g1.rotate(App.Vector(0, 0, 0), App.Vector(1, 0, 0), 90.0)
    g1.translate(App.Vector(0.0, y_gear, z_pod_mid))
    b1 = Part.makeCylinder(ROTOR_SHAFT_DIA / 2.0, 14.0,
                            App.Vector(0.0, y_gear - 10.0, z_pod_mid), App.Vector(0, 1, 0))
    add_part(g1.cut(b1), "Gas_Stem_Gear_24T_6mmBore",  (0.95, 0.25, 0.25))
    print("[GEAR] Gas_Stem_Gear_24T_6mmBore built OK")

    # Gear 2: MG996R Gear at (X=+30.0, Y=-22.0, Z=-45.0) — exact 1:1 mesh
    g2 = make_spur_gear(GAS_TEETH, GAS_MOD, 8.0)
    g2.rotate(App.Vector(0, 0, 0), App.Vector(1, 0, 0), 90.0)
    g2.translate(App.Vector(30.0, y_gear, z_pod_mid))
    b2 = Part.makeCylinder(ROTOR_SHAFT_DIA / 2.0, 14.0,
                            App.Vector(30.0, y_gear - 10.0, z_pod_mid), App.Vector(0, 1, 0))
    add_part(g2.cut(b2), "MG996R_Gear_24T_6mmBore",    (0.95, 0.75, 0.15))
    print("[GEAR] MG996R_Gear_24T_6mmBore built OK")

    doc.recompute()

    # ── Validation report ──────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("V10 Validation Report")
    print("=" * 60)
    for obj in doc.Objects:
        try:
            valid = obj.Shape.isValid()
            vol   = obj.Shape.Volume
            print(f"  {obj.Name:<45} isValid={valid}  vol={vol:.1f} mm³")
        except Exception as e:
            print(f"  {obj.Name:<45} [ERROR: {e}]")

    # ── Export ─────────────────────────────────────────────────────────────
    script_dir = os.path.dirname(os.path.abspath(__file__))
    stl_dir  = os.path.join(script_dir, "stl")
    step_dir = os.path.join(script_dir, "step")
    os.makedirs(stl_dir,  exist_ok=True)
    os.makedirs(step_dir, exist_ok=True)

    printable_names = [
        "Upper_Cylinder_Cage_V7",
        "Lower_Right_MG996R_Part",
        "Lower_Left_Grinder_Part",
        "Gas_Stem_Gear_24T_6mmBore",
        "MG996R_Gear_24T_6mmBore",
    ]
    # Reference-only (exported as STEP for clearance checks, not for printing)
    reference_names = ["Three_Bearings_90deg_625zz"]

    all_export = printable_names + reference_names
    exported_objs = []

    print("\n--- Exporting STL + STEP ---")
    for name in all_export:
        obj = doc.getObject(name)
        if obj is None:
            print(f"  [SKIP] {name} not found")
            continue
        step_path = os.path.join(step_dir, f"{name}.step")
        try:
            Part.export([obj], step_path)
            print(f"  [STEP OK]  {name}")
            exported_objs.append(obj)
        except Exception as e:
            print(f"  [STEP ERR] {name}: {e}")

        if name in printable_names:
            stl_path = os.path.join(stl_dir, f"{name}.stl")
            try:
                obj.Shape.exportStl(stl_path)
                print(f"  [STL  OK]  {name}")
            except Exception as e:
                print(f"  [STL  ERR] {name}: {e}")

    # Combined STEP assembly
    if exported_objs:
        assy_path = os.path.join(step_dir, "Inner_Core_V10_Assembly.step")
        try:
            Part.export(exported_objs, assy_path)
            print(f"  [OK]  Combined: Inner_Core_V10_Assembly.step")
        except Exception as e:
            print(f"  [ERR] Combined STEP: {e}")

    # Save FCStd
    fcstd_path = os.path.join(script_dir, "Turret_V10_V7Restored.FCStd")
    try:
        doc.saveAs(fcstd_path)
        print(f"  [OK]  FCStd: {fcstd_path}")
    except Exception as e:
        print(f"  [ERR] FCStd save: {e}")

    if App.GuiUp:
        import FreeCADGui as Gui
        Gui.SendMsgToViews("ViewFit")
        Gui.activeDocument().activeView().viewIsometric()

    print("\nV10 build complete.")


# ─── Entry point ───────────────────────────────────────────────────────────────
build_v7_restored_inner_core()
