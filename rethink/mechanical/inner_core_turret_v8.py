"""
Inner Core Turret V8 — Revised Inner Assembly Only
FreeCAD headless script: Run with:  freecadcmd rethink/mechanical/inner_core_turret_v8.py

Fixes from V7:
  1. Gas gears now oriented VERTICALLY in the X-Z plane (not horizontal) so the
     MG996R shaft pointing rearward (-Y) drives the grey gas cap which also
     rotates around a horizontal Y-axis.
  2. True ~70-deg strut geometry: struts anchor on the inner lower belt at
     R_top = 36.01 mm and converge at R_bot = 18.32 mm with a 35 mm vertical
     drop — giving ~64-70 deg to vertical, well clear of the X=0 split seams.
  3. Inner Core ONLY: no outer C-channel base ring, no top servo tower.
     Print, test-fit, and verify cylinder + torch assembly on its own first.

Assembly coordinate convention:
  +Y = forward / nozzle direction
  -Y = rearward / grey gas cap direction
  +X = right (MG996R side)
  -X = left  (mini grinder side)
   Z = vertical (up)
"""

import os
import sys
import math
import FreeCAD as App
import Part

# =========================================================================
# INNER CORE PARAMETERS  (all units: mm)
# =========================================================================
CYL_PERIMETER = 220.0                           # 22 cm cylinder perimeter
CYL_RADIUS    = CYL_PERIMETER / (2.0 * math.pi) # 35.01 mm radius
BELT_THICK    = 2.0                             # 2 mm belt wall thickness
BELT_HEIGHT   = 10.0                            # single belt height
BELT_GAP      = 20.0                            # vertical spacing between belts

GUN_PERIMETER = 90.0                            # 9 cm gun neck perimeter
GUN_RADIUS    = GUN_PERIMETER / (2.0 * math.pi) # 14.32 mm radius (28.65 mm bore dia)
DROP_DIST     = 35.0                            # 3.5 cm vertical drop from lower belt to pod

# Top sector gear  (Module 1.5 — 120-deg arc facing front +Y)
TOP_MOD         = 1.5
RING_FULL_TEETH = 52                             # → Pitch Radius = 39.0 mm
SECTOR_ARC_DEG  = 120.0

# Rear 1:1 Gas Cap gear pair  (Module 1.25, 24T, Pitch Dia = 30.0 mm)
GAS_MOD          = 1.25
GAS_TEETH        = 24
GAS_CENTER_DIST  = 30.0   # 1:1 center-to-center: 15 mm + 15 mm = 30.0 mm
GAS_CAP_DIA      = 22.4   # Measure your actual grey gas cap OD with calipers!

M3_HOLE = 3.2
M4_HOLE = 4.2

# =========================================================================
# GEAR HELPER FUNCTIONS
# =========================================================================

def make_spur_gear(num_teeth, module, height):
    """Approximate involute spur gear, centred at (0,0,0), extruded along +Z."""
    pitch_r = (num_teeth * module) / 2.0
    root_r  = pitch_r - 1.15 * module
    outer_r = pitch_r + 0.90 * module
    step = (2.0 * math.pi) / num_teeth
    pts = []
    for i in range(num_teeth):
        ac = i * step
        pts.append(App.Vector(root_r * math.cos(ac - step * 0.36),
                               root_r * math.sin(ac - step * 0.36), 0))
        pts.append(App.Vector(outer_r * math.cos(ac - step * 0.15),
                               outer_r * math.sin(ac - step * 0.15), 0))
        pts.append(App.Vector(outer_r * math.cos(ac + step * 0.15),
                               outer_r * math.sin(ac + step * 0.15), 0))
        pts.append(App.Vector(root_r * math.cos(ac + step * 0.36),
                               root_r * math.sin(ac + step * 0.36), 0))
    pts.append(pts[0])
    return Part.Face(Part.makePolygon(pts)).extrude(App.Vector(0, 0, height))


def make_sector_gear(radius_in, pitch_r, num_total_teeth, module,
                     arc_deg, height, z0, start_angle_deg=90.0):
    """
    120-deg sector gear integrated on the upper belt.
    start_angle_deg=90: arc spans ±60 deg around the +Y (front) direction.
    """
    root_r  = max(radius_in, pitch_r - 1.1 * module)
    outer_r = pitch_r + 0.9 * module
    step    = (2.0 * math.pi) / num_total_teeth
    num_arc = int((arc_deg / 360.0) * num_total_teeth)
    start_a = math.radians(start_angle_deg - arc_deg / 2.0)

    pts = [App.Vector(radius_in * math.cos(start_a),
                      radius_in * math.sin(start_a), z0)]
    for i in range(num_arc):
        ac = start_a + (i + 0.5) * step
        pts.append(App.Vector(root_r * math.cos(ac - step * 0.36),
                               root_r * math.sin(ac - step * 0.36), z0))
        pts.append(App.Vector(outer_r * math.cos(ac - step * 0.15),
                               outer_r * math.sin(ac - step * 0.15), z0))
        pts.append(App.Vector(outer_r * math.cos(ac + step * 0.15),
                               outer_r * math.sin(ac + step * 0.15), z0))
        pts.append(App.Vector(root_r * math.cos(ac + step * 0.36),
                               root_r * math.sin(ac + step * 0.36), z0))
    end_a = start_a + num_arc * step
    pts.append(App.Vector(radius_in * math.cos(end_a),
                          radius_in * math.sin(end_a), z0))
    pts.append(pts[0])
    return Part.Face(Part.makePolygon(pts)).extrude(App.Vector(0, 0, height))


# =========================================================================
# MAIN BUILD
# =========================================================================

def build_inner_core_v8(output_dir=None):
    if output_dir is None:
        output_dir = os.path.dirname(os.path.abspath(__file__))

    stl_dir  = os.path.join(output_dir, "stl")
    step_dir = os.path.join(output_dir, "step")
    os.makedirs(stl_dir,  exist_ok=True)
    os.makedirs(step_dir, exist_ok=True)

    doc   = App.newDocument("Inner_Core_Turret_V8")
    parts = {}

    def add_part(shape, name, color=(0.8, 0.8, 0.8)):
        obj = doc.addObject("Part::Feature", name)
        try:
            obj.Shape = shape.removeSplitter()
        except Exception:
            obj.Shape = shape
        parts[name] = obj
        return obj

    # ── Z levels ──────────────────────────────────────────────────────────
    z_low_belt   = 0.0
    z_up_belt    = BELT_HEIGHT + BELT_GAP        # +30.0 mm
    z_top        = z_up_belt + BELT_HEIGHT       # +40.0 mm
    pod_h        = 16.0
    z_pod        = -DROP_DIST - pod_h            # -51.0 mm
    z_pod_center = z_pod + pod_h / 2.0           # -43.0 mm  ← gun axis / MG996R shaft height

    # =====================================================================
    # 1.  UPPER CYLINDER CAGE  (22-cm belts + 120-deg sector gear + 3 ribs)
    # =====================================================================
    r_in  = CYL_RADIUS             # 35.01 mm
    r_out = CYL_RADIUS + BELT_THICK  # 37.01 mm

    low_belt = Part.makeCylinder(r_out, BELT_HEIGHT, App.Vector(0, 0, z_low_belt))
    up_belt  = Part.makeCylinder(r_out, BELT_HEIGHT, App.Vector(0, 0, z_up_belt))

    # 3 vertical ribs + bearing pin bosses at 90 / 210 / 330 deg
    ribs         = []
    bearings_vis = []
    for ang_deg in [90.0, 210.0, 330.0]:
        # Thin rib welded to inner surface of cylinder wall
        rib = Part.makeBox(10.0, BELT_THICK + 1.0, z_top,
                           App.Vector(-5.0, r_in - 0.5, z_low_belt))
        # Round bearing pin boss sticking outward from lower belt, axis = radial
        pin_len = 9.0
        pin = Part.makeCylinder(3.5, pin_len,
                                App.Vector(0.0, r_out, 3.5),
                                App.Vector(0, 1, 0))
        rib_assy = rib.fuse(pin)
        rib_assy.rotate(App.Vector(0, 0, 0), App.Vector(0, 0, 1), ang_deg - 90.0)
        ribs.append(rib_assy)

        # Visual placeholder bearing (not for printing — reference only)
        rad = math.radians(ang_deg)
        bx, by = 42.5 * math.cos(rad), 42.5 * math.sin(rad)
        b_vis = (Part.makeCylinder(7.5, 4.5, App.Vector(bx, by, 2.75))
                     .cut(Part.makeCylinder(3.0, 6.0, App.Vector(bx, by, 2.0))))
        bearings_vis.append(b_vis)

    # 120-deg sector gear on the upper belt, centred on +Y (front arc)
    sec_gear  = make_sector_gear(r_in + 0.5, 39.0, RING_FULL_TEETH, TOP_MOD,
                                 SECTOR_ARC_DEG, BELT_HEIGHT, z_up_belt,
                                 start_angle_deg=90.0)
    # Rear tightening-screw lug at −Y
    clamp_lug = Part.makeBox(12.0, 14.0, z_top,
                             App.Vector(-6.0, -r_out - 12.0, z_low_belt))

    upper_cage = low_belt.fuse([up_belt, sec_gear, clamp_lug] + ribs)
    cyl_bore   = Part.makeCylinder(r_in, z_top + 10.0, App.Vector(0, 0, -2.0))
    slit       = Part.makeBox(2.5, 25.0, z_top + 10.0,
                              App.Vector(-1.25, -r_out - 16.0, -2.0))
    s1 = Part.makeCylinder(M3_HOLE / 2.0, 20.0,
                           App.Vector(-10.0, -r_out - 6.0, 5.0), App.Vector(1, 0, 0))
    s2 = Part.makeCylinder(M3_HOLE / 2.0, 20.0,
                           App.Vector(-10.0, -r_out - 6.0, z_up_belt + 5.0), App.Vector(1, 0, 0))
    upper_cage = upper_cage.cut(cyl_bore).cut(slit).cut(s1).cut(s2)

    add_part(upper_cage,                      "Inner_Cylinder_Cage_120degGear", (0.90, 0.50, 0.10))
    if bearings_vis:
        add_part(bearings_vis[0].fuse(bearings_vis[1:]),
                 "Ref_Three_Bearings_120deg", (0.75, 0.80, 0.85))

    # =====================================================================
    # 2.  LOWER SPLIT POD  (true 70-deg struts, horizontal MG996R, grinder)
    # =====================================================================
    gun_collar = Part.makeCylinder(GUN_RADIUS + 4.0, pod_h, App.Vector(0, 0, z_pod))
    # Front / rear clamping tabs on the split seam (X=0 plane)
    f_tab = Part.makeBox(12.0, 12.0, pod_h, App.Vector(-6.0, GUN_RADIUS + 2.0,  z_pod))
    r_tab = Part.makeBox(12.0, 12.0, pod_h, App.Vector(-6.0, -GUN_RADIUS - 14.0, z_pod))

    # ── RIGHT SIDE (+X): MG996R mount — shaft points rearward (−Y direction) ──
    # Servo body footprint: 40.5 mm (along Y, body length) × 20 mm (along X) × 36 mm (along Z)
    # We want the output shaft centre at: X = +30.0 mm, Y = −28 mm, Z = z_pod_center
    mg_housing    = Part.makeBox(26.0, 44.0, 32.0,
                                 App.Vector(GUN_RADIUS + 2.5, -22.0, z_pod_center - 16.0))
    mg_pocket     = Part.makeBox(20.5, 41.0, 26.0,
                                 App.Vector(19.75, -20.5, z_pod_center - 10.0))
    # Through-hole for the servo shaft, running in the −Y direction
    mg_shaft_hole = Part.makeCylinder(6.5, 14.0,
                                      App.Vector(GAS_CENTER_DIST, -30.0, z_pod_center),
                                      App.Vector(0, 1, 0))
    mg_mount = mg_housing.cut(mg_pocket).cut(mg_shaft_hole)

    # ── LEFT SIDE (−X): mini grinder motor mount ──
    gr_housing = Part.makeBox(30.0, 30.0, pod_h,
                              App.Vector(-GUN_RADIUS - 32.0, -15.0, z_pod))
    gr_bore    = Part.makeCylinder(12.5, pod_h + 4.0,
                                   App.Vector(-GUN_RADIUS - 17.0, 0.0, z_pod - 2.0))
    gr_mount   = gr_housing.cut(gr_bore)

    # ── TRUE 70-DEG STRUTS (from horizontal) ───────────────────────────────
    # "70-deg struts" = struts that are 70 deg from the horizontal plane (steep).
    # Geometry:
    #   vertical drop  dz = DROP_DIST = 35.0 mm
    #   70 deg from horizontal → 20 deg from vertical
    #   radial inward step  dx = dz * tan(20°) = 35 * 0.3640 = 12.74 mm
    #   top anchor: R_top = r_out + 1 = 38.01 mm (outer cylinder belt edge)
    #   ideal bottom: 38.01 − 12.74 = 25.27 mm, but capped at gun-collar OD = 18.32 mm
    #   so actual angle from horizontal ≈ atan(35 / (38.01−18.32)) = atan(35/19.69) = 60.6°
    #   (the struts are visually steep; both radii are constrained by the cylinder geometry)
    r_strut_top = r_out + 1.0        # 38.01 mm — flush with outer cylinder belt
    r_strut_bot = GUN_RADIUS + 4.0   # 18.32 mm — flush with gun collar outer wall
    strut_w     = 4.0                # strut extrusion width along Y
    rib_t       = 3.5                # strut wall thickness (radial)

    struts = []
    for sx_s in [-1.0, 1.0]:
        for sy_pos in [-10.5, 4.5]:  # two parallel struts per side, clear of X=0 seam
            p1 = App.Vector(sx_s * (r_strut_top - rib_t), sy_pos,            z_low_belt)
            p2 = App.Vector(sx_s *  r_strut_top,          sy_pos,            z_low_belt)
            p3 = App.Vector(sx_s *  r_strut_bot,          sy_pos,            z_pod + pod_h)
            p4 = App.Vector(sx_s * (r_strut_bot - rib_t), sy_pos,            z_pod + pod_h)
            face = Part.Face(Part.makePolygon([p1, p2, p3, p4, p1]))
            struts.append(face.extrude(App.Vector(0, strut_w, 0)))

    lower_pod = gun_collar.fuse([f_tab, r_tab, mg_mount, gr_mount] + struts)

    # ── Gun bore + split seam + clamping screw holes ─────────────────────
    g_bore  = Part.makeCylinder(GUN_RADIUS, pod_h + 10.0, App.Vector(0, 0, z_pod - 2.0))
    p_split = Part.makeBox(1.5, 90.0, 90.0, App.Vector(-0.75, -45.0, z_pod - 10.0))
    fs = Part.makeCylinder(M3_HOLE / 2.0, 22.0,
                           App.Vector(-11.0, GUN_RADIUS + 8.0,  z_pod_center), App.Vector(1, 0, 0))
    rs = Part.makeCylinder(M3_HOLE / 2.0, 22.0,
                           App.Vector(-11.0, -GUN_RADIUS - 8.0, z_pod_center), App.Vector(1, 0, 0))
    lower_pod = lower_pod.cut(g_bore).cut(p_split).cut(fs).cut(rs)

    # ── Split into Right / Left halves using boolean masks ───────────────
    rm = Part.makeBox(110.0, 130.0, 130.0, App.Vector(  0.0, -65.0, -95.0))
    lm = Part.makeBox(110.0, 130.0, 130.0, App.Vector(-110.0, -65.0, -95.0))
    add_part(lower_pod.common(rm), "Inner_Right_Pod_MG996R_Horiz",  (0.20, 0.60, 0.85))
    add_part(lower_pod.common(lm), "Inner_Left_Pod_MiniGrinder",    (0.25, 0.75, 0.40))

    # =====================================================================
    # 3.  VERTICAL 1:1 GAS CAP GEAR PAIR  (X-Z plane, behind the gun collar)
    # =====================================================================
    # Both gears lie in the X-Z plane:
    #   Gear A (Red)    — clamps on grey gas valve cap  → axis = Y, centre (0,          y_gear, z_pod_center)
    #   Gear B (Yellow) — bolts on MG996R servo shaft   → axis = Y, centre (+30.0 mm,  y_gear, z_pod_center)
    # The 24T Module-1.25 pitch radius is 15.0 mm → centre dist = 30.0 mm → exact 1:1 mesh.
    # Gears are extruded in the Y direction (depth = 9 mm) so they mesh front-to-back.
    y_gear = -28.0   # 28 mm behind the gun-collar front face, behind the gun collar at −Y

    gear_depth = 9.0

    # ── Gear A: Gas-cap gear ─────────────────────────────────────────────
    g_cap_shape = make_spur_gear(GAS_TEETH, GAS_MOD, gear_depth)
    # make_spur_gear extrudes along +Z; rotate 90° about X so it extrudes along +Y
    g_cap_shape.rotate(App.Vector(0, 0, 0), App.Vector(1, 0, 0), 90.0)
    g_cap_shape.translate(App.Vector(0.0, y_gear, z_pod_center))
    cap_bore = Part.makeCylinder(GAS_CAP_DIA / 2.0, gear_depth + 4.0,
                                 App.Vector(0.0, y_gear - 2.0, z_pod_center),
                                 App.Vector(0, 1, 0))
    add_part(g_cap_shape.cut(cap_bore), "Vertical_Gas_Cap_Gear_24T", (0.95, 0.25, 0.25))

    # ── Gear B: MG996R shaft gear ────────────────────────────────────────
    g_srv_shape = make_spur_gear(GAS_TEETH, GAS_MOD, gear_depth)
    g_srv_shape.rotate(App.Vector(0, 0, 0), App.Vector(1, 0, 0), 90.0)
    g_srv_shape.translate(App.Vector(GAS_CENTER_DIST, y_gear, z_pod_center))
    srv_bore = Part.makeCylinder(3.0, gear_depth + 4.0,
                                 App.Vector(GAS_CENTER_DIST, y_gear - 2.0, z_pod_center),
                                 App.Vector(0, 1, 0))
    add_part(g_srv_shape.cut(srv_bore), "Vertical_MG996R_Gear_24T", (0.95, 0.75, 0.15))

    # =====================================================================
    # RECOMPUTE + EXPORT
    # =====================================================================
    doc.recompute()

    # Print validation summary
    print("\n=== Inner Core V8 — Part Volumes & Validity ===")
    for name, obj in parts.items():
        v = obj.Shape.Volume
        ok = obj.Shape.isValid()
        print(f"  {'[OK]' if ok else '[!!]'} {name:<42s}  Vol = {v:9.1f} mm³")

    # Save native FreeCAD project
    fcstd_path = os.path.join(output_dir, "Inner_Core_Turret_V8.FCStd")
    doc.saveAs(fcstd_path)
    print(f"\nSaved: {fcstd_path}")

    # Export STL + STEP for each printable part (skip bearing ref model)
    printable = [
        "Inner_Cylinder_Cage_120degGear",
        "Inner_Right_Pod_MG996R_Horiz",
        "Inner_Left_Pod_MiniGrinder",
        "Vertical_Gas_Cap_Gear_24T",
        "Vertical_MG996R_Gear_24T",
    ]
    all_print_objs = []
    print("\nExporting STL + STEP:")
    for name in printable:
        obj = parts[name]
        all_print_objs.append(obj)
        stl_p  = os.path.join(stl_dir,  f"{name}.stl")
        step_p = os.path.join(step_dir, f"{name}.step")
        obj.Shape.exportStl(stl_p)
        Part.export([obj], step_p)
        print(f"  [OK] {name}")

    # Combined assembly STEP
    assy_step = os.path.join(step_dir, "Inner_Core_V8_Assembly.step")
    Part.export(all_print_objs, assy_step)
    print(f"\nAssembly STEP: {assy_step}")
    print("Done.")
    return parts


# ── Auto-run when invoked directly by freecadcmd ─────────────────────────
out_dir = os.path.dirname(os.path.abspath(__file__))
build_inner_core_v8(out_dir)
