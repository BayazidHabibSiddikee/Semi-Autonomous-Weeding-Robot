"""
turret_fixed_realworld.py — Real-World Fixed Turret (Conical Struts & 15cm Center Pod)
======================================================================================
Key Fixes:
  1. No-Notch Conical Struts: 30mm (3cm) shaft length at ~70°, generated from conical
     frustum shell matching exact inner (35.01mm) and outer (37.01mm) lower belt curvature.
     Cylinder bore cut stops strictly at Z=0.0 to prevent notch/overhang at strut root.
  2. Lower Pod Dimensions:
     - Center Hole Perimeter: 15cm (150mm) -> Radius = 23.87mm (47.75mm dia).
     - Pod Height: 1cm (10mm) tall.
     - Narrow Hole Perimeter: 7cm (70mm) -> Radius = 11.14mm (22.28mm dia) for grinder.
     - MG996R Shaft Center: X = +37.5mm (clears 15cm center hole).
  3. Rear 1:1 Vertical Gas Gears: 30T, Module 1.25, 37.5mm center distance.

Run headless:
    freecadcmd /path/to/turret_fixed_realworld.py

Exports:
    rethink/mechanical/stl/  (one STL per printable part)
    rethink/mechanical/step/ (one STEP per part + combined assembly STEP)
    rethink/mechanical/Turret_Fixed_RealWorld.FCStd
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
BELT_HEIGHT = 10.0                           # 10 mm (1 cm) height per belt
BELT_GAP = 20.0                              # 20 mm (2 cm) vertical gap between belts

# Bearing Pin (625zz: 5mm ID, 16mm OD, 5mm W)
BEARING_ID = 5.0
BEARING_OD = 16.0
BEARING_W  = 5.0

# Top 120-Deg Sector Gear (Module 1.5, 52 full teeth -> Pitch R = 39.0 mm)
TOP_MOD = 1.5
RING_FULL_TEETH = 52
SECTOR_ARC_DEG = 120.0

# =========================================================================
# 2. 70-DEGREE 3CM SHAFT & 1CM LOWER POD PARAMETERS (in mm)
# =========================================================================
CENTER_PERIMETER = 150.0                        # 15 cm center hole perimeter
CENTER_RADIUS = CENTER_PERIMETER / (2.0 * math.pi) # 23.87 mm radius (47.75 mm dia)
COLLAR_WALL = 3.5                               # 3.5 mm wall around 15 cm center bore

NARROW_PERIMETER = 70.0                         # 7 cm narrow hole perimeter (grinder side)
NARROW_RADIUS = NARROW_PERIMETER / (2.0 * math.pi) # 11.14 mm radius (22.28 mm dia)

POD_HEIGHT = 10.0                               # 1 cm (10.0 mm) lower pod height
SHAFT_LEN = 30.0                                # 3 cm (30.0 mm) angled strut length
# Radial step from upper belt (37.01 mm) to lower collar (27.37 mm) is 9.64 mm (~71 deg angle)
DROP_DIST = math.sqrt(SHAFT_LEN**2 - (CYL_RADIUS + BELT_THICK - (CENTER_RADIUS + COLLAR_WALL))**2) # 28.41 mm

# Rear Gas Cap 1:1 Vertical Gear Pair (Module 1.25, 30T -> Center Dist = 37.5 mm to clear 15cm hole)
GAS_MOD = 1.25
GAS_TEETH = 30
GAS_CENTER_DIST = 37.5                          # Exact 1:1 center distance (X = +37.5 mm)
GAS_CAP_DIA = 22.4                              # Grey gas cap rotor bore diameter
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
        pts.append(App.Vector(outer_r * math.cos(ac - step * 0.15), outer_r * math.sin(ac - step * 0.15), 0 + z0))
        pts.append(App.Vector(outer_r * math.cos(ac + step * 0.15), outer_r * math.sin(ac + step * 0.15), 0 + z0))
        pts.append(App.Vector(root_r * math.cos(ac + step * 0.36), root_r * math.sin(ac + step * 0.36), z0))
    end_a = start_a + num_arc * step
    pts.append(App.Vector(radius_in * math.cos(end_a), radius_in * math.sin(end_a), z0))
    pts.append(pts[0])
    return Part.Face(Part.makePolygon(pts)).extrude(App.Vector(0, 0, height))


def make_conical_strut(r_bot_in, r_bot_out, r_top_in, r_top_out, z_bot, z_top, ang_center, arc_deg):
    """
    Creates a curved conical strut that matches the exact cylinder curvature
    at both the upper belt (Z=0) and lower collar (Z=z_pod_top) with ZERO notch.
    """
    h = z_top - z_bot
    cone_out = Part.makeCone(r_bot_out, r_top_out, h, App.Vector(0, 0, z_bot), App.Vector(0, 0, 1), arc_deg)
    cone_in  = Part.makeCone(r_bot_in,  r_top_in,  h, App.Vector(0, 0, z_bot), App.Vector(0, 0, 1), arc_deg)
    shell = cone_out.cut(cone_in)

    # Top and bottom vertical anchor rings inside the belt and collar walls for solid boolean fusion
    top_tab = Part.makeCylinder(r_top_out, 4.0, App.Vector(0, 0, z_top), App.Vector(0, 0, 1), arc_deg).cut(
              Part.makeCylinder(r_top_in,  4.0, App.Vector(0, 0, z_top), App.Vector(0, 0, 1), arc_deg))
    bot_tab = Part.makeCylinder(r_bot_out, 3.0, App.Vector(0, 0, z_bot - 3.0), App.Vector(0, 0, 1), arc_deg).cut(
              Part.makeCylinder(r_bot_in,  3.0, App.Vector(0, 0, z_bot - 3.0), App.Vector(0, 0, 1), arc_deg))

    strut = shell.fuse([top_tab, bot_tab])
    strut.rotate(App.Vector(0, 0, 0), App.Vector(0, 0, 1), ang_center - arc_deg / 2.0)
    return strut


def build_realworld_turret():
    doc = App.newDocument("Turret_Fixed_RealWorld")

    def add_part(shape, name, color=(0.8, 0.8, 0.8)):
        obj = doc.addObject("Part::Feature", name)
        obj.Shape = shape.removeSplitter()
        if App.GuiUp:
            obj.ViewObject.ShapeColor = color
        return obj

    r_in = CYL_RADIUS                           # 35.01 mm
    r_out = CYL_RADIUS + BELT_THICK             # 37.01 mm
    z_low_belt = 0.0
    z_up_belt = BELT_HEIGHT + BELT_GAP          # +30.0 mm
    z_top = z_up_belt + BELT_HEIGHT             # +40.0 mm

    z_pod_top = -DROP_DIST                      # -28.41 mm (3 cm shaft at ~70 deg)
    z_pod_bot = z_pod_top - POD_HEIGHT          # -38.41 mm (1 cm pod height)
    z_pod_center = z_pod_bot + POD_HEIGHT / 2.0 # -33.41 mm

    r_collar_in = CENTER_RADIUS                 # 23.87 mm (15 cm perimeter)
    r_collar_out = CENTER_RADIUS + COLLAR_WALL  # 27.37 mm

    # =========================================================================
    # PART 1: CLEAN UPPER CYLINDER CAGE + FLUSH 3CM 70-DEG CONICAL STRUTS
    # =========================================================================
    low_belt = Part.makeCylinder(r_out, BELT_HEIGHT, App.Vector(0, 0, z_low_belt))
    up_belt = Part.makeCylinder(r_out, BELT_HEIGHT, App.Vector(0, 0, z_up_belt))

    outer_cyl_bound = Part.makeCylinder(r_out, z_top, App.Vector(0, 0, z_low_belt))
    ribs_and_pins = []
    bearings_90deg = []

    for ang_deg in [0.0, 120.0, 240.0]:
        raw_rib = Part.makeBox(BELT_THICK + 4.0, 10.0, z_top, App.Vector(r_in - 1.0, -5.0, z_low_belt))
        raw_rib.rotate(App.Vector(0, 0, 0), App.Vector(0, 0, 1), ang_deg)
        curved_rib = raw_rib.common(outer_cyl_bound)

        pin = Part.makeCylinder(BEARING_ID / 2.0, BEARING_W + 2.0,
                                App.Vector(r_in, 0, 5.0), App.Vector(1, 0, 0))
        pin.rotate(App.Vector(0, 0, 0), App.Vector(0, 0, 1), ang_deg)
        ribs_and_pins.append(curved_rib.fuse(pin))

        b_cyl = Part.makeCylinder(BEARING_OD / 2.0, BEARING_W,
                                  App.Vector(r_out + 0.5, 0, 5.0), App.Vector(1, 0, 0))
        b_hole = Part.makeCylinder(BEARING_ID / 2.0, BEARING_W + 1.0,
                                   App.Vector(r_out, 0, 5.0), App.Vector(1, 0, 0))
        b_part = b_cyl.cut(b_hole)
        b_part.rotate(App.Vector(0, 0, 0), App.Vector(0, 0, 1), ang_deg)
        bearings_90deg.append(b_part)

    slit_bridge_raw = Part.makeBox(16.0, BELT_THICK + 4.0, z_top, App.Vector(-8.0, -r_out - 2.0, z_low_belt))
    slit_bridge_curved = slit_bridge_raw.common(outer_cyl_bound)

    z_lug_bottom = 20.0
    clamp_lug_upper = Part.makeBox(12.0, 14.0, z_top - z_lug_bottom,
                                   App.Vector(-6.0, -r_out - 12.0, z_lug_bottom))

    sec_gear = make_sector_gear(r_in + 0.5, 39.0, RING_FULL_TEETH, TOP_MOD,
                                SECTOR_ARC_DEG, BELT_HEIGHT, z_up_belt)

    # 4 Conical Struts (3cm long, ~70 deg) placed at 52, 128, 232, 308 deg (clear of bearings & mounts)
    struts = []
    for s_ang in [52.0, 128.0, 232.0, 308.0]:
        struts.append(make_conical_strut(
            r_collar_in, r_collar_out,
            r_in, r_out,
            z_pod_top, z_low_belt,
            s_ang, 16.0
        ))

    # Bore cut starts strictly at Z = 0.0 so it NEVER notches the struts below Z = 0
    upper_cage = low_belt.fuse([up_belt, slit_bridge_curved, clamp_lug_upper, sec_gear] + ribs_and_pins)
    cyl_bore = Part.makeCylinder(r_in, z_top + 5.0, App.Vector(0, 0, z_low_belt))
    slit = Part.makeBox(2.5, 30.0, z_top + 5.0, App.Vector(-1.25, -r_out - 18.0, z_low_belt))

    screw_green_1 = Part.makeCylinder(M3_HOLE / 2.0, 20.0,
                                      App.Vector(-10.0, -r_out - 6.5, 25.0), App.Vector(1, 0, 0))
    screw_green_2 = Part.makeCylinder(M3_HOLE / 2.0, 20.0,
                                      App.Vector(-10.0, -r_out - 6.5, 34.0), App.Vector(1, 0, 0))

    upper_cage = upper_cage.cut(cyl_bore).cut(slit).cut(screw_green_1).cut(screw_green_2)
    upper_cage = upper_cage.fuse(struts)

    add_part(upper_cage, "Upper_Cage_With_3cm_70deg_Struts", (0.90, 0.50, 0.10))
    add_part(bearings_90deg[0].fuse(bearings_90deg[1:]), "Three_Bearings_90deg", (0.72, 0.78, 0.85))

    # =========================================================================
    # PART 2: 1CM TALL LOWER POD (15cm Center + 7cm Grinder Left + MG996R Right)
    # =========================================================================
    center_collar = Part.makeCylinder(r_collar_out, POD_HEIGHT, App.Vector(0, 0, z_pod_bot))

    # Front (+Y) and Rear (-Y) clamping lugs (1 cm tall)
    f_tab = Part.makeBox(12.0, 12.0, POD_HEIGHT, App.Vector(-6.0, r_collar_in + 1.5, z_pod_bot))
    r_tab = Part.makeBox(12.0, 12.0, POD_HEIGHT, App.Vector(-6.0, -r_collar_in - 13.5, z_pod_bot))

    # RIGHT SIDE (+X): 1cm Tall MG996R Base (Centered at X = +37.5 mm to clear 15cm center hole)
    mg_x_start = r_collar_out - 2.0               # 25.37 mm (fuses into right collar wall)
    mg_width_x = 25.0                             # Outer X width (spans 25.37 to 50.37 mm)
    mg_len_y = 45.0                               # Outer Y length for MG996R body
    mg_base = Part.makeBox(mg_width_x, mg_len_y, POD_HEIGHT,
                           App.Vector(mg_x_start, -mg_len_y / 2.0, z_pod_bot))
    # MG996R cradle pocket (20.5 mm wide x 41.0 mm long, 2.0 mm bottom floor)
    mg_pocket = Part.makeBox(20.5, 41.0, POD_HEIGHT,
                             App.Vector(GAS_CENTER_DIST - 10.25, -20.5, z_pod_bot + 2.0))
    # Rear shaft slot/pass-through at X = +37.5 mm so servo shaft reaches rear gear
    mg_shaft_slot = Part.makeCylinder(6.0, 10.0,
                                      App.Vector(GAS_CENTER_DIST, -mg_len_y / 2.0 - 2.0, z_pod_center + 2.0),
                                      App.Vector(0, 1, 0))
    mg_mount = mg_base.cut(mg_pocket).cut(mg_shaft_slot)

    # LEFT SIDE (-X): 1cm Tall Grinding Motor Holder with 7cm Perimeter Narrow Hole (R = 11.14 mm)
    gr_wall = 3.5
    gr_outer_w = 2.0 * (NARROW_RADIUS + gr_wall)  # 29.28 mm square block
    gr_center_x = -(r_collar_out + NARROW_RADIUS + 1.5) # -40.01 mm
    gr_box = Part.makeBox(gr_outer_w + 3.0, gr_outer_w, POD_HEIGHT,
                          App.Vector(gr_center_x - gr_outer_w / 2.0, -gr_outer_w / 2.0, z_pod_bot))
    gr_narrow_bore = Part.makeCylinder(NARROW_RADIUS, POD_HEIGHT + 4.0,
                                       App.Vector(gr_center_x, 0, z_pod_bot - 2.0))
    gr_mount = gr_box.cut(gr_narrow_bore)

    lower_pod = center_collar.fuse([f_tab, r_tab, mg_mount, gr_mount])

    # Cut 15cm Center Hole + X=0 Split Seam + Front/Rear Clamping Screw Holes
    center_bore = Part.makeCylinder(r_collar_in, POD_HEIGHT + 10.0, App.Vector(0, 0, z_pod_bot - 5.0))
    p_split = Part.makeBox(1.5, 100.0, POD_HEIGHT + 10.0, App.Vector(-0.75, -50.0, z_pod_bot - 5.0))
    f_screw = Part.makeCylinder(M3_HOLE / 2.0, 20.0,
                                App.Vector(-10.0, r_collar_in + 8.0, z_pod_center), App.Vector(1, 0, 0))
    r_screw = Part.makeCylinder(M3_HOLE / 2.0, 20.0,
                                App.Vector(-10.0, -r_collar_in - 8.0, z_pod_center), App.Vector(1, 0, 0))

    lower_pod = lower_pod.cut(center_bore).cut(p_split).cut(f_screw).cut(r_screw)

    rm = Part.makeBox(120.0, 120.0, 100.0, App.Vector(0.0, -60.0, z_pod_bot - 20.0))
    lm = Part.makeBox(120.0, 120.0, 100.0, App.Vector(-120.0, -60.0, z_pod_bot - 20.0))
    add_part(lower_pod.common(rm), "Lower_Right_Pod_MG996R_1cm", (0.20, 0.60, 0.85))
    add_part(lower_pod.common(lm), "Lower_Left_Pod_Grinder7cm_1cm", (0.25, 0.75, 0.40))

    # =========================================================================
    # PART 3: VERTICAL 1:1 GAS CAP GEARS (30T Mod 1.25 at Rear Y = -35 mm)
    # =========================================================================
    y_gear = -r_collar_out - 8.0
    g_cap = make_spur_gear(GAS_TEETH, GAS_MOD, 8.0)
    g_cap.rotate(App.Vector(0, 0, 0), App.Vector(1, 0, 0), 90.0)
    g_cap.translate(App.Vector(0, y_gear, z_pod_center))
    cap_bore = Part.makeCylinder(GAS_CAP_DIA / 2.0, 14.0,
                                 App.Vector(0, y_gear - 10.0, z_pod_center), App.Vector(0, 1, 0))
    add_part(g_cap.cut(cap_bore), "Vertical_Gas_Cap_Gear_30T", (0.95, 0.25, 0.25))

    g_srv = make_spur_gear(GAS_TEETH, GAS_MOD, 8.0)
    g_srv.rotate(App.Vector(0, 0, 0), App.Vector(1, 0, 0), 90.0)
    g_srv.translate(App.Vector(GAS_CENTER_DIST, y_gear, z_pod_center))
    srv_bore = Part.makeCylinder(3.0, 14.0,
                                 App.Vector(GAS_CENTER_DIST, y_gear - 10.0, z_pod_center), App.Vector(0, 1, 0))
    add_part(g_srv.cut(srv_bore), "Vertical_MG996R_Gear_30T", (0.95, 0.75, 0.15))

    doc.recompute()

    # ── Validation report ──────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("Real-World Turret — Validation Report")
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
        "Upper_Cage_With_3cm_70deg_Struts",
        "Lower_Right_Pod_MG996R_1cm",
        "Lower_Left_Pod_Grinder7cm_1cm",
        "Vertical_Gas_Cap_Gear_30T",
        "Vertical_MG996R_Gear_30T",
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
        assy_path = os.path.join(step_dir, "Turret_Fixed_RealWorld_Assembly.step")
        try:
            Part.export(exported_objs, assy_path)
            print(f"  [OK] Combined: Turret_Fixed_RealWorld_Assembly.step")
        except Exception as e:
            print(f"  [ERR] Combined STEP: {e}")

    # Save FCStd
    fcstd_path = os.path.join(script_dir, "Turret_Fixed_RealWorld.FCStd")
    try:
        doc.saveAs(fcstd_path)
        print(f"  [FCStd OK] {fcstd_path}")
    except Exception as e:
        print(f"  [FCStd ERR] {e}")

    if App.GuiUp:
        import FreeCADGui as Gui
        Gui.SendMsgToViews("ViewFit")
        Gui.activeDocument().activeView().viewIsometric()

    print("\nTurret Fixed RealWorld build complete.")


# ─── Entry point ───────────────────────────────────────────────────────────────
build_realworld_turret()
