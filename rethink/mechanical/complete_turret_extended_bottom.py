"""
complete_turret_extended_bottom.py — Complete Turret with Clean Cage & Extended Bottom Pod
==========================================================================================
Key Features:
  1. Upper Cage (Clean): Flush lower belt (lug only at Z=20..40mm), dual M3 screws at Z=25 & 34mm,
     smooth cylindrical 5mm bearing pins (no boss blocks), curved vertical straps.
  2. Extended Struts: 45mm drop (Z=0 down to Z=-45mm), upper strut ends trimmed flush with 
     the 35.01mm inner bore and 37.01mm outer cylinder radius.
  3. Extended Lower Pod: Full 28mm height (Z=-45 to -73mm) matching MG996R housing depth.
     Dual front/rear M3 clamping screws on split tabs.
  4. Rear Vertical 1:1 Gas Cap Gears: In X-Z plane at Y=-28mm, Z=-59mm.
     24T (Module 1.25, 30mm pitch dia). Cap gear with 22.4mm bore, servo gear with 6mm bore.

Run headless:
    freecadcmd /path/to/complete_turret_extended_bottom.py

Exports:
    rethink/mechanical/stl/  (one STL per printable part)
    rethink/mechanical/step/ (one STEP per part + combined assembly STEP)
    rethink/mechanical/Complete_Turret_Extended_Bottom.FCStd
"""

import os
import math

import FreeCAD as App
import Part

# =========================================================================
# 1. UPPER CYLINDER CAGE PARAMETERS (in mm)
# =========================================================================
CYL_PERIMETER = 220.0                        # 22 cm cylinder perimeter
CYL_RADIUS = CYL_PERIMETER / (2.0 * math.pi) # 35.01 mm inner radius
BELT_THICK = 2.0                             # 2.0 mm belt wall thickness
BELT_HEIGHT = 10.0                           # 10 mm height per belt
BELT_GAP = 20.0                              # 20 mm vertical gap between belts

# Bearing Pin (625zz: 5mm ID, 16mm OD, 5mm W)
BEARING_ID = 5.0
BEARING_OD = 16.0
BEARING_W  = 5.0

# Top 120-Deg Sector Gear (Module 1.5, 52 full teeth -> Pitch R = 39.0 mm)
TOP_MOD = 1.5
RING_FULL_TEETH = 52
SECTOR_ARC_DEG = 120.0

# =========================================================================
# 2. EXTENDED BOTTOM POD & REAR GAS CAP GEAR PARAMETERS (in mm)
# =========================================================================
GUN_PERIMETER = 90.0                         # 9 cm gun neck hole perimeter
GUN_RADIUS = GUN_PERIMETER / (2.0 * math.pi) # 14.32 mm radius (28.65 mm dia)
GUN_WALL = 4.5                               # Wall thickness around gun neck

DROP_DIST = 45.0                             # Extended vertical drop (4.5 cm) below lower belt
POD_HEIGHT = 28.0                            # Extended height of lower collar & mounts
STRUT_THICK = 3.5                            # Radial thickness of angled struts
STRUT_WIDTH = 5.0                            # Y-width of each angled strut

# Rear Gas Cap 1:1 Vertical Gear Pair (Module 1.25, 24T -> Pitch Dia = 30.0 mm)
GAS_MOD = 1.25
GAS_TEETH = 24
GAS_CENTER_DIST = 30.0                       # 1:1 center distance (Servo shaft at X = +30.0 mm)
GAS_CAP_DIA = 22.4                           # Grey gas cap rotor bore diameter
M3_HOLE = 3.2


def make_spur_gear(num_teeth, module, height):
    """Generates a spur gear centered at (0,0,0) extruded along +Z."""
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
    return Part.Face(Part.makePolygon(pts)).extrude(App.Vector(0, 0, height))


def make_sector_gear(radius_in, pitch_r, num_total_teeth, module, arc_deg, height, z0):
    """Generates the 120-degree sector gear on the upper belt."""
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


def build_complete_extended_turret():
    doc = App.newDocument("Turret_Clean_Cage_Extended_Bottom")

    def add_part(shape, name, color=(0.8, 0.8, 0.8)):
        obj = doc.addObject("Part::Feature", name)
        obj.Shape = shape.removeSplitter()
        if App.GuiUp:
            obj.ViewObject.ShapeColor = color
        return obj

    r_in = CYL_RADIUS                        # 35.01 mm
    r_out = CYL_RADIUS + BELT_THICK          # 37.01 mm
    z_low_belt = 0.0
    z_up_belt = BELT_HEIGHT + BELT_GAP       # +30.0 mm
    z_top = z_up_belt + BELT_HEIGHT          # +40.0 mm

    z_pod_top = -DROP_DIST                   # -45.0 mm
    z_pod_bot = z_pod_top - POD_HEIGHT       # -73.0 mm
    z_pod_center = z_pod_bot + POD_HEIGHT / 2.0  # -59.0 mm (Gun axis & MG996R shaft Z)

    # =========================================================================
    # PART 1: CLEAN UPPER CYLINDER CAGE (Z = 0 to +40 mm)
    # =========================================================================
    low_belt = Part.makeCylinder(r_out, BELT_HEIGHT, App.Vector(0, 0, z_low_belt))
    up_belt = Part.makeCylinder(r_out, BELT_HEIGHT, App.Vector(0, 0, z_up_belt))

    outer_cyl_bound = Part.makeCylinder(r_out, z_top, App.Vector(0, 0, z_low_belt))
    ribs_and_pins = []
    bearings_90deg = []

    for ang_deg in [0.0, 120.0, 240.0]:
        # Vertical strap curved flush with the 2mm belts
        raw_rib = Part.makeBox(BELT_THICK + 4.0, 10.0, z_top, App.Vector(r_in - 1.0, -5.0, z_low_belt))
        raw_rib.rotate(App.Vector(0, 0, 0), App.Vector(0, 0, 1), ang_deg)
        curved_rib = raw_rib.common(outer_cyl_bound)

        # Cylindrical Bearing Pin (no rectangular boss block)
        pin = Part.makeCylinder(BEARING_ID / 2.0, BEARING_W + 2.0,
                                App.Vector(r_in, 0, 5.0), App.Vector(1, 0, 0))
        pin.rotate(App.Vector(0, 0, 0), App.Vector(0, 0, 1), ang_deg)
        ribs_and_pins.append(curved_rib.fuse(pin))

        # Visual 90-degree bearing on the pin
        b_cyl = Part.makeCylinder(BEARING_OD / 2.0, BEARING_W,
                                  App.Vector(r_out + 0.5, 0, 5.0), App.Vector(1, 0, 0))
        b_hole = Part.makeCylinder(BEARING_ID / 2.0, BEARING_W + 1.0,
                                   App.Vector(r_out, 0, 5.0), App.Vector(1, 0, 0))
        b_part = b_cyl.cut(b_hole)
        b_part.rotate(App.Vector(0, 0, 0), App.Vector(0, 0, 1), ang_deg)
        bearings_90deg.append(b_part)

    # Flush Curved Bridge at -Y (270 deg)
    slit_bridge_raw = Part.makeBox(16.0, BELT_THICK + 4.0, z_top, App.Vector(-8.0, -r_out - 2.0, z_low_belt))
    slit_bridge_curved = slit_bridge_raw.common(outer_cyl_bound)

    # Upper-Only Screw Lug (Z = 20..40 mm, lower 20mm cut away)
    z_lug_bottom = 20.0
    clamp_lug_upper = Part.makeBox(12.0, 14.0, z_top - z_lug_bottom,
                                   App.Vector(-6.0, -r_out - 12.0, z_lug_bottom))

    # 120-Deg Sector Gear on Top Belt
    sec_gear = make_sector_gear(r_in + 0.5, 39.0, RING_FULL_TEETH, TOP_MOD,
                                SECTOR_ARC_DEG, BELT_HEIGHT, z_up_belt)

    # =========================================================================
    # PART 2: EXTENDED ANGLED STRUTS (Flush with Lower Belt & Lower Collar)
    # =========================================================================
    r_collar_out = GUN_RADIUS + GUN_WALL     # 18.82 mm
    struts = []

    # Envelope cylinder from z_pod_bot to z_top to trim upper strut ends flush with r_out
    strut_trim_env = Part.makeCylinder(r_out, z_top + 2.0, App.Vector(0, 0, z_low_belt))
    strut_lower_env = Part.makeCylinder(r_out + 50.0, DROP_DIST + POD_HEIGHT + 2.0,
                                        App.Vector(0, 0, z_pod_bot - 1.0))
    strut_bound = strut_trim_env.fuse(strut_lower_env)

    for sx_s in [-1.0, 1.0]:
        for sy_pos in [-10.0, 5.0]:
            # Top of strut anchors inside lower belt wall (Z=0..10) and angles down to collar (Z=z_pod_top)
            p1 = App.Vector(sx_s * (r_in - 0.5), sy_pos, z_low_belt)
            p2 = App.Vector(sx_s * (r_out + 1.5), sy_pos, z_low_belt)
            p3 = App.Vector(sx_s * r_collar_out, sy_pos, z_pod_top)
            p4 = App.Vector(sx_s * (r_collar_out - STRUT_THICK), sy_pos, z_pod_top)

            # Vertical anchor tab extending up into lower belt (Z=0..BELT_HEIGHT)
            p1_up = App.Vector(sx_s * (r_in - 0.5), sy_pos, z_low_belt + BELT_HEIGHT)
            p2_up = App.Vector(sx_s * (r_out + 1.5), sy_pos, z_low_belt + BELT_HEIGHT)

            # Vertical anchor tab extending down into gun collar (Z=z_pod_top - 8mm)
            p3_dn = App.Vector(sx_s * r_collar_out, sy_pos, z_pod_top - 8.0)
            p4_dn = App.Vector(sx_s * (r_collar_out - STRUT_THICK), sy_pos, z_pod_top - 8.0)

            poly = Part.makePolygon([p1_up, p2_up, p2, p3, p3_dn, p4_dn, p4, p1, p1_up])
            raw_strut = Part.Face(poly).extrude(App.Vector(0, STRUT_WIDTH, 0))
            struts.append(raw_strut.common(strut_bound))

    # Fuse Upper Cage + Flush Struts, then cut cylinder bore, rear slit, and green-dot screws
    upper_cage = low_belt.fuse([up_belt, slit_bridge_curved, clamp_lug_upper, sec_gear] + ribs_and_pins + struts)
    cyl_bore = Part.makeCylinder(r_in, z_top + 10.0, App.Vector(0, 0, -1.0))
    slit = Part.makeBox(2.5, 30.0, z_top + 10.0, App.Vector(-1.25, -r_out - 18.0, -1.0))

    screw_green_1 = Part.makeCylinder(M3_HOLE / 2.0, 20.0,
                                      App.Vector(-10.0, -r_out - 6.5, 25.0), App.Vector(1, 0, 0))
    screw_green_2 = Part.makeCylinder(M3_HOLE / 2.0, 20.0,
                                      App.Vector(-10.0, -r_out - 6.5, 34.0), App.Vector(1, 0, 0))

    upper_cage = upper_cage.cut(cyl_bore).cut(slit).cut(screw_green_1).cut(screw_green_2)
    add_part(upper_cage, "Upper_Cage_With_Extended_Struts", (0.90, 0.50, 0.10))
    add_part(bearings_90deg[0].fuse(bearings_90deg[1:]), "Three_Bearings_90deg", (0.72, 0.78, 0.85))

    # =========================================================================
    # PART 3: EXTENDED LOWER SPLIT POD (Gun Collar + MG996R + Mini Grinder)
    # =========================================================================
    gun_collar = Part.makeCylinder(r_collar_out, POD_HEIGHT, App.Vector(0, 0, z_pod_bot))

    # Front (+Y) and Rear (-Y) clamping tabs along the X=0 split line (2 screw holes per tab)
    f_tab = Part.makeBox(12.0, 12.0, POD_HEIGHT, App.Vector(-6.0, GUN_RADIUS + 2.0, z_pod_bot))
    r_tab = Part.makeBox(12.0, 12.0, POD_HEIGHT, App.Vector(-6.0, -GUN_RADIUS - 14.0, z_pod_bot))

    # RIGHT SIDE (+X): Horizontal MG996R Mount (Shaft at X = +30.0 mm, Z = z_pod_center)
    mg_housing = Part.makeBox(26.0, 44.0, POD_HEIGHT,
                              App.Vector(GUN_RADIUS + 2.5, -22.0, z_pod_bot))
    mg_pocket = Part.makeBox(20.5, 41.0, POD_HEIGHT - 4.0,
                             App.Vector(19.75, -20.5, z_pod_bot + 4.0))
    mg_shaft_hole = Part.makeCylinder(6.5, 14.0,
                                      App.Vector(GAS_CENTER_DIST, -25.0, z_pod_center),
                                      App.Vector(0, 1, 0))
    # M3 mounting holes on MG996R side tabs
    mg_mount = mg_housing.cut(mg_pocket).cut(mg_shaft_hole)

    # LEFT SIDE (-X): Extended Mini Grinder Motor Mount (Full POD_HEIGHT)
    gr_housing = Part.makeBox(30.0, 30.0, POD_HEIGHT,
                              App.Vector(-GUN_RADIUS - 32.0, -15.0, z_pod_bot))
    gr_bore = Part.makeCylinder(12.5, POD_HEIGHT + 4.0,
                                App.Vector(-GUN_RADIUS - 17.0, 0, z_pod_bot - 2.0))
    gr_mount = gr_housing.cut(gr_bore)

    lower_pod = gun_collar.fuse([f_tab, r_tab, mg_mount, gr_mount])

    # Cut 9cm Gun Neck Bore + Split Seam Along X=0 + Dual Front/Rear Clamping Screws
    g_bore = Part.makeCylinder(GUN_RADIUS, POD_HEIGHT + 20.0, App.Vector(0, 0, z_pod_bot - 5.0))
    p_split = Part.makeBox(1.5, 90.0, POD_HEIGHT + 20.0, App.Vector(-0.75, -45.0, z_pod_bot - 5.0))

    screw_cuts = []
    for z_sc in [z_pod_bot + 7.0, z_pod_top - 7.0]:
        # Front tab upper & lower M3 screws
        screw_cuts.append(Part.makeCylinder(M3_HOLE / 2.0, 20.0,
                          App.Vector(-10.0, GUN_RADIUS + 8.0, z_sc), App.Vector(1, 0, 0)))
        # Rear tab upper & lower M3 screws
        screw_cuts.append(Part.makeCylinder(M3_HOLE / 2.0, 20.0,
                          App.Vector(-10.0, -GUN_RADIUS - 8.0, z_sc), App.Vector(1, 0, 0)))

    lower_pod = lower_pod.cut(g_bore).cut(p_split)
    for sc in screw_cuts:
        lower_pod = lower_pod.cut(sc)

    rm = Part.makeBox(100.0, 120.0, 150.0, App.Vector(0.0, -60.0, z_pod_bot - 20.0))
    lm = Part.makeBox(100.0, 120.0, 150.0, App.Vector(-100.0, -60.0, z_pod_bot - 20.0))
    r_part = lower_pod.common(rm)
    l_part = lower_pod.common(lm)
    add_part(r_part, "Lower_Right_Pod_MG996R", (0.20, 0.60, 0.85))
    add_part(l_part, "Lower_Left_Pod_MiniGrinder", (0.25, 0.75, 0.40))

    # =========================================================================
    # PART 4: VERTICAL 1:1 GAS CAP GEARS (In X-Z Plane at Rear Y = -28 mm)
    # =========================================================================
    y_gear = -28.0
    # Gear 1: Fits over the Grey Gas Valve Cap at (0, -28, z_pod_center)
    g_cap = make_spur_gear(GAS_TEETH, GAS_MOD, 9.0)
    g_cap.rotate(App.Vector(0, 0, 0), App.Vector(1, 0, 0), 90.0)
    g_cap.translate(App.Vector(0, y_gear, z_pod_center))
    cap_bore = Part.makeCylinder(GAS_CAP_DIA / 2.0, 14.0,
                                 App.Vector(0, y_gear - 11.0, z_pod_center), App.Vector(0, 1, 0))
    add_part(g_cap.cut(cap_bore), "Vertical_Gas_Cap_Gear_24T", (0.95, 0.25, 0.25))

    # Gear 2: Driven by Horizontal MG996R Shaft at (X = +30.0, -28, z_pod_center)
    g_srv = make_spur_gear(GAS_TEETH, GAS_MOD, 9.0)
    g_srv.rotate(App.Vector(0, 0, 0), App.Vector(1, 0, 0), 90.0)
    g_srv.translate(App.Vector(GAS_CENTER_DIST, y_gear, z_pod_center))
    srv_bore = Part.makeCylinder(3.0, 14.0,
                                 App.Vector(GAS_CENTER_DIST, y_gear - 11.0, z_pod_center), App.Vector(0, 1, 0))
    add_part(g_srv.cut(srv_bore), "Vertical_MG996R_Gear_24T", (0.95, 0.75, 0.15))

    doc.recompute()

    # ── Validation report ──────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("Extended Bottom Turret — Validation Report")
    print("=" * 60)
    for obj in doc.Objects:
        try:
            valid = obj.Shape.isValid()
            vol   = obj.Shape.Volume
            print(f"  {obj.Name:<45} isValid={valid}  vol={vol:.1f} mm³")
        except Exception as e:
            print(f"  {obj.Name:<45} [ERROR: {e}]")

    # ── Auto-Export STL & STEP ─────────────────────────────────────────────
    script_dir = os.path.dirname(os.path.abspath(__file__))
    stl_dir  = os.path.join(script_dir, "stl")
    step_dir = os.path.join(script_dir, "step")
    os.makedirs(stl_dir,  exist_ok=True)
    os.makedirs(step_dir, exist_ok=True)

    printable_names = [
        "Upper_Cage_With_Extended_Struts",
        "Lower_Right_Pod_MG996R",
        "Lower_Left_Pod_MiniGrinder",
        "Vertical_Gas_Cap_Gear_24T",
        "Vertical_MG996R_Gear_24T",
    ]
    reference_names = ["Three_Bearings_90deg"]
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
            print(f"  [STEP OK] {name}.step")
            exported_objs.append(obj)
        except Exception as e:
            print(f"  [STEP ERR] {name}: {e}")

        if name in printable_names:
            stl_path = os.path.join(stl_dir, f"{name}.stl")
            try:
                obj.Shape.exportStl(stl_path)
                print(f"  [STL  OK] {name}.stl")
            except Exception as e:
                print(f"  [STL  ERR] {name}: {e}")

    # Combined Assembly STEP
    if exported_objs:
        assy_path = os.path.join(step_dir, "Complete_Turret_Extended_Bottom_Assembly.step")
        try:
            Part.export(exported_objs, assy_path)
            print(f"  [OK] Combined: Complete_Turret_Extended_Bottom_Assembly.step")
        except Exception as e:
            print(f"  [ERR] Combined STEP: {e}")

    # Save FCStd
    fcstd_path = os.path.join(script_dir, "Complete_Turret_Extended_Bottom.FCStd")
    try:
        doc.saveAs(fcstd_path)
        print(f"  [FCStd OK] {fcstd_path}")
    except Exception as e:
        print(f"  [FCStd ERR] {e}")

    if App.GuiUp:
        import FreeCADGui as Gui
        Gui.SendMsgToViews("ViewFit")
        Gui.activeDocument().activeView().viewRear()

    print("\nComplete Extended Turret build finished.")


# ─── Entry point ───────────────────────────────────────────────────────────────
build_complete_extended_turret()
