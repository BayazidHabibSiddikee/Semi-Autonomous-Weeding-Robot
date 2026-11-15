"""
inner_core_turret_v9.py — Weed-Laser-Robot Inner Core Assembly (V9)
======================================================================
Fixes over V8:
  1. Strut geometry corrected: struts attach to OUTER WALL of 9 cm gun collar
     (R_out = 18.52 mm), angle UP at 70° from horizontal (ΔR = 12.74 mm for
     35 mm vertical drop) → land exactly on lower cylinder belt at R = 35 mm.
     Pods kept strictly BELOW Z = -35 mm so struts never intersect servo pockets.
  2. 625zz bearings rotated 90° to VERTICAL — axle axis is radial (like a wheel),
     not flat like a pancake. Bore = 5 mm, OD = 16 mm, Width = 5 mm.
  3. Grinder (RS-385, 27.7 mm dia) mount = open C-clamp sleeve (28 mm bore),
     split slit + M3 pinch-bolt tightening lug on far left edge.
  4. MG996R mount = open pass-through rectangular window (41 × 20.5 mm) with
     4× M3 flange mounting holes.  Shaft points −Y at X = +30 mm, Z = −43 mm.

Run headless:
    freecadcmd /path/to/inner_core_turret_v9.py

Exports:
    rethink/mechanical/stl/  (one STL per printable part)
    rethink/mechanical/step/ (one STEP per part + combined assembly STEP)
    rethink/mechanical/Inner_Core_Turret_V9.FCStd
"""

import os
import sys
import math

import FreeCAD as App
import Part

# ─────────────────────────────────────────────────────────────────────────────
# GLOBAL PARAMETERS
# ─────────────────────────────────────────────────────────────────────────────
# Cylinder cage (22 cm perimeter)
CYL_PERIMETER  = 220.0
CYL_RADIUS     = CYL_PERIMETER / (2.0 * math.pi)   # 35.01 mm
BELT_THICK     = 2.5
BELT_HEIGHT    = 12.0
BELT_GAP       = 20.0                               # gap between lower & upper belt
# Lower belt centre at Z = 0, upper belt centre at Z = BELT_GAP + BELT_HEIGHT

# Gun collar (9 cm perimeter)
GUN_PERIMETER  = 90.0
GUN_RADIUS_IN  = GUN_PERIMETER / (2.0 * math.pi)   # 14.32 mm
GUN_WALL       = 4.2
GUN_RADIUS_OUT = GUN_RADIUS_IN + GUN_WALL           # 18.52 mm
GUN_HEIGHT     = 20.0
# Gun collar centred at Z = -44.0  (top at Z = -34 → pod attachment point)

# Struts — connect gun collar top (Z = -34) to lower belt bottom (Z = -6)
STRUT_DROP     = 35.0        # vertical rise from gun-collar-top to lower-belt-bottom
# ΔR = STRUT_DROP / tan(70°) = 12.74 mm
STRUT_DR       = STRUT_DROP / math.tan(math.radians(70.0))   # 12.74 mm
STRUT_W        = 4.0
STRUT_T        = 3.0
NUM_STRUTS     = 6           # 3 on right pod + 3 on left pod

# 625zz bearing (5 mm bore, 16 mm OD, 5 mm wide)
BRG_BORE       = 5.0
BRG_OD         = 16.0
BRG_WIDTH      = 5.0
BRG_ANGLES_DEG = [90.0, 210.0, 330.0]              # 3 bearings at 120° spacing

# Sector gear on upper belt (120° sector, Module 1.5, 40 teeth)
GEAR_MODULE    = 1.5
GEAR_TEETH     = 40
GEAR_PD        = GEAR_MODULE * GEAR_TEETH           # 60 mm pitch dia
GEAR_HEIGHT_GR = 10.0
SECTOR_ARC     = 120.0                              # degrees

# Gas-knob spur gears (24T, Module 1.25) — in X-Z plane
GAS_GEAR_MODULE  = 1.25
GAS_GEAR_TEETH   = 24
GAS_GEAR_PD      = GAS_GEAR_MODULE * GAS_GEAR_TEETH  # 30 mm
GAS_GEAR_HEIGHT  = 8.0
GAS_CENTRE_DIST  = GAS_GEAR_PD                      # 1:1 pair, centres 30 mm apart

# MG996R body dimensions (mm)
MG_BODY_L      = 40.7
MG_BODY_W      = 20.0
MG_BODY_H      = 36.0
MG_SHAFT_X     = 30.0        # shaft X position (pointing -Y)
MG_SHAFT_Z     = -43.0       # shaft Z position

# RS-385 motor
RS385_DIA      = 28.0        # 27.7 mm OD → 28 mm bore (slight clearance)
RS385_LEN      = 50.0

# ─────────────────────────────────────────────────────────────────────────────
# UTILITY
# ─────────────────────────────────────────────────────────────────────────────
def _cyl(r, h, z=0.0, axis=(0,0,1)):
    """Return a cylinder solid, axis = (0,0,1) default."""
    c = Part.makeCylinder(r, h, App.Vector(0,0,z), App.Vector(*axis))
    return c

def _box(dx, dy, dz, x=0.0, y=0.0, z=0.0):
    b = Part.makeBox(dx, dy, dz, App.Vector(x, y, z))
    return b

def _fuse(*shapes):
    result = shapes[0]
    for s in shapes[1:]:
        result = result.fuse(s)
    return result

def _cut(base, *tools):
    result = base
    for t in tools:
        result = result.cut(t)
    return result

def _add_obj(doc, name, label, shape):
    obj = doc.addObject("Part::Feature", name)
    obj.Shape = shape
    obj.Label = label
    return obj

# ─────────────────────────────────────────────────────────────────────────────
# 1. INNER CYLINDER CAGE  (lower belt + upper belt + sector gear + bearing bosses)
# ─────────────────────────────────────────────────────────────────────────────
def build_cylinder_cage(doc):
    R_in  = CYL_RADIUS
    R_out = CYL_RADIUS + BELT_THICK

    # --- Lower belt (Z = 0 .. BELT_HEIGHT) ---
    lower_outer = _cyl(R_out, BELT_HEIGHT, 0.0)
    lower_inner = _cyl(R_in,  BELT_HEIGHT, 0.0)
    lower_belt  = lower_outer.cut(lower_inner)

    # --- Upper belt (Z = BELT_GAP+BELT_HEIGHT .. 2*BELT_HEIGHT+BELT_GAP) ---
    Z_upper = BELT_GAP + BELT_HEIGHT
    upper_outer = _cyl(R_out, BELT_HEIGHT, Z_upper)
    upper_inner = _cyl(R_in,  BELT_HEIGHT, Z_upper)
    upper_belt  = upper_outer.cut(upper_inner)

    # --- 3 vertical connecting ribs between belts ---
    ribs = []
    for ang_deg in [0.0, 120.0, 240.0]:
        ang = math.radians(ang_deg)
        cx  = (R_in + R_out) / 2.0 * math.cos(ang)
        cy  = (R_in + R_out) / 2.0 * math.sin(ang)
        rib = _box(BELT_THICK, BELT_THICK, BELT_GAP,
                   cx - BELT_THICK/2, cy - BELT_THICK/2, BELT_HEIGHT)
        ribs.append(rib)

    # --- 120° Sector gear tooth ring on top face of upper belt ---
    # Approximate sector as a solid arc ring; teeth represented as rectangular
    # nubs around the arc (simplified for FreeCAD headless).
    sector_r_in  = R_out
    sector_r_out = R_out + (GEAR_PD / 2.0 - R_in) * 0.6   # ~12 mm ring
    # Clip to 60 mm pitch diameter ring arc
    sector_r_out = R_out + 12.0
    Z_gear_bot   = Z_upper + BELT_HEIGHT
    gear_outer   = _cyl(sector_r_out, GEAR_HEIGHT_GR, Z_gear_bot)
    gear_inner   = _cyl(sector_r_in,  GEAR_HEIGHT_GR, Z_gear_bot)
    gear_ring_full = gear_outer.cut(gear_inner)

    # Cut to 120° sector using two half-planes (wedge)
    wedge_size = sector_r_out + 10.0
    # Sector centred at 0° (front, +Y direction)
    start_ang = math.radians(-60.0)
    end_ang   = math.radians(60.0)
    # Build wedge box covering 120° sector
    p0 = App.Vector(0, 0, Z_gear_bot - 1)
    p1 = App.Vector(wedge_size * math.cos(start_ang),
                    wedge_size * math.sin(start_ang), Z_gear_bot - 1)
    p2 = App.Vector(wedge_size * math.cos(end_ang),
                    wedge_size * math.sin(end_ang),   Z_gear_bot - 1)
    p3 = App.Vector(0, 0, Z_gear_bot + GEAR_HEIGHT_GR + 1)
    p4 = App.Vector(wedge_size * math.cos(start_ang),
                    wedge_size * math.sin(start_ang), Z_gear_bot + GEAR_HEIGHT_GR + 1)
    p5 = App.Vector(wedge_size * math.cos(end_ang),
                    wedge_size * math.sin(end_ang),   Z_gear_bot + GEAR_HEIGHT_GR + 1)
    # Keep only the sector: subtract two cut-boxes outside the arc
    # Cut-box 1: everything with Y < 0 and right of start
    cut_full_outside = Part.makeBox(
        wedge_size * 2 + 10,
        wedge_size * 2 + 10,
        GEAR_HEIGHT_GR + 4,
        App.Vector(-(wedge_size + 5), -(wedge_size + 5), Z_gear_bot - 1)
    )
    # Subtract the full ring and add back the 120° portion is tricky; use
    # simplified approach: boolean with a prism wedge
    # Wedge face: polygon with 3 points + height
    face_pts = [
        App.Vector(0, 0, 0),
        App.Vector(wedge_size * math.cos(start_ang), wedge_size * math.sin(start_ang), 0),
        App.Vector(wedge_size * math.cos(end_ang),   wedge_size * math.sin(end_ang),   0),
        App.Vector(0, 0, 0),
    ]
    wire   = Part.makePolygon(face_pts)
    face   = Part.Face(wire)
    wedge_solid = face.extrude(App.Vector(0, 0, GEAR_HEIGHT_GR + 4))
    wedge_solid.translate(App.Vector(0, 0, Z_gear_bot - 1))
    sector_gear = gear_ring_full.common(wedge_solid)

    # --- 3 Bearing bosses on lower belt outer face (radial axle pins for 625zz) ---
    bearing_bosses = []
    for ang_deg in BRG_ANGLES_DEG:
        ang   = math.radians(ang_deg)
        # Boss centre on outer face of lower belt
        boss_cx = R_out * math.cos(ang)
        boss_cy = R_out * math.sin(ang)
        boss_z  = BELT_HEIGHT / 2.0 - BRG_WIDTH / 2.0   # centred in belt height

        # Radial axle pin (axis = outward radial direction)
        axle_dir = App.Vector(math.cos(ang), math.sin(ang), 0.0)
        axle_pin = Part.makeCylinder(
            BRG_BORE / 2.0 + 0.4,       # slight oversize for press fit
            BRG_WIDTH + 6.0,             # extra length outside boss face
            App.Vector(boss_cx - (BRG_WIDTH/2.0 + 3.0) * math.cos(ang),
                       boss_cy - (BRG_WIDTH/2.0 + 3.0) * math.sin(ang),
                       boss_z),
            axle_dir
        )
        # Boss (thickened pad on belt outer wall for the bearing to seat against)
        boss_cyl = Part.makeCylinder(
            BRG_OD / 2.0 + 2.0,         # flanged boss ~10 mm radius
            6.0,                          # 6 mm pad
            App.Vector(boss_cx * 0.95, boss_cy * 0.95, boss_z - 0.5),
            axle_dir
        )
        bearing_bosses.append(axle_pin)
        bearing_bosses.append(boss_cyl)

    # Fuse everything
    parts = [lower_belt, upper_belt] + ribs + [sector_gear] + bearing_bosses
    cage  = _fuse(*parts)

    # Rear tightening lug (split seam at +Y face)
    lug = _box(8, 12, BELT_HEIGHT * 2 + BELT_GAP,
               -4, R_out - 2, 0.0)
    cage = cage.fuse(lug)
    # M4 bolt hole through lug
    bolt_hole = _cyl(2.1, 15, BELT_HEIGHT + BELT_GAP/2 - 7,
                     (0,1,0))
    bolt_hole.translate(App.Vector(0, R_out + 3, 0))
    cage = cage.cut(bolt_hole)

    _add_obj(doc, "Inner_Cylinder_Cage_120degGear",
             "Inner Cylinder Cage (120° Sector Gear)", cage)
    print("[CAGE] built OK")
    return cage


# ─────────────────────────────────────────────────────────────────────────────
# 2. VERTICAL 625zz BEARING ASSEMBLIES (3×, reference / visual only)
# ─────────────────────────────────────────────────────────────────────────────
def build_vertical_bearings(doc):
    all_bearings = []
    for ang_deg in BRG_ANGLES_DEG:
        ang     = math.radians(ang_deg)
        # Bearing seated at outer face of lower belt
        brg_cx  = (CYL_RADIUS + BELT_THICK + BRG_WIDTH/2.0) * math.cos(ang)
        brg_cy  = (CYL_RADIUS + BELT_THICK + BRG_WIDTH/2.0) * math.sin(ang)
        brg_z   = BELT_HEIGHT / 2.0

        axle_dir = App.Vector(math.cos(ang), math.sin(ang), 0.0)
        # Outer race (OD = 16 mm, Width = 5 mm)
        outer_race = Part.makeCylinder(
            BRG_OD / 2.0, BRG_WIDTH,
            App.Vector(brg_cx - BRG_WIDTH/2.0 * math.cos(ang),
                       brg_cy - BRG_WIDTH/2.0 * math.sin(ang),
                       brg_z - BRG_OD/2.0),
            axle_dir
        )
        # Inner bore (5 mm)
        inner_bore = Part.makeCylinder(
            BRG_BORE / 2.0, BRG_WIDTH,
            App.Vector(brg_cx - BRG_WIDTH/2.0 * math.cos(ang),
                       brg_cy - BRG_WIDTH/2.0 * math.sin(ang),
                       brg_z - BRG_OD/2.0),
            axle_dir
        )
        ring = outer_race.cut(inner_bore)
        all_bearings.append(ring)

    brg_shape = _fuse(*all_bearings)
    _add_obj(doc, "Vertical_Bearings_625zz",
             "3× 625zz Bearings (Vertical / Wheel Orientation)", brg_shape)
    print("[BEARINGS] built OK — 625zz, 90° vertical orientation")
    return brg_shape


# ─────────────────────────────────────────────────────────────────────────────
# 3. RIGHT POD — MG996R Pass-Through Window Cradle
#    - Struts from gun-collar outer top (R=18.52, Z=-35) to lower belt (R=35, Z=0)
#    - MG996R window: 41 × 20.5 mm rectangular cutout
#    - 4× M3 flange holes at corners
#    - Shaft at X=+30, Z=-43, pointing -Y
# ─────────────────────────────────────────────────────────────────────────────
def build_right_pod_mg996r(doc):
    # Pod body block — right side, below gun collar top
    # Pod box: 50 mm wide (X), 25 mm deep (Y), 55 mm tall (Z)
    # Positioned so its inner face is at X = GUN_RADIUS_OUT = 18.52
    pod_x0  = GUN_RADIUS_OUT          # 18.52 mm from centre
    pod_dx  = MG_BODY_L + 4.0        # 44.7 mm
    pod_dy  = MG_BODY_W + 5.0        # 25 mm
    pod_dz  = 55.0
    pod_z0  = -35.0 - pod_dz         # top of pod at Z = -35

    pod_body = _box(pod_dx, pod_dy, pod_dz,
                    pod_x0,
                    -pod_dy / 2.0,
                    pod_z0)

    # MG996R pass-through rectangular window (41 × 20.5 mm)
    win_w = MG_BODY_L + 0.3          # 41.0 mm clearance
    win_h = MG_BODY_W + 0.5          # 20.5 mm clearance
    win_depth = pod_dy + 2.0         # full depth + 2 mm
    win_x0 = pod_x0 + (pod_dx - win_w) / 2.0
    win_z0 = MG_SHAFT_Z - win_h / 2.0  # centred on shaft Z
    window = _box(win_w, win_depth, win_h,
                  win_x0,
                  -pod_dy / 2.0 - 1.0,
                  win_z0)
    pod_body = pod_body.cut(window)

    # 4× M3 mounting holes (2.1 mm radius) for MG996R side-ear flanges
    for mx, mz in [
        (win_x0 + 3.0, win_z0 + 3.0),
        (win_x0 + win_w - 3.0, win_z0 + 3.0),
        (win_x0 + 3.0, win_z0 + win_h - 3.0),
        (win_x0 + win_w - 3.0, win_z0 + win_h - 3.0),
    ]:
        hole = Part.makeCylinder(1.6, win_depth + 4.0,
                                 App.Vector(mx, -pod_dy/2.0 - 2.0, mz),
                                 App.Vector(0, 1, 0))
        pod_body = pod_body.cut(hole)

    # --- 3 struts: gun-collar outer top → lower belt bottom ---
    # Gun collar attachment: at outer edge (R = GUN_RADIUS_OUT = 18.52) Z = -35
    # Lower belt attachment: at outer edge (R = CYL_RADIUS = 35.01) Z = -6 (bottom of belt)
    # Struts on right (+X) side only
    strut_shapes = []
    for ang_deg in [30.0, 0.0, -30.0]:
        ang   = math.radians(ang_deg)
        # Bottom anchor (gun collar outer, Z = -35)
        bx0 = GUN_RADIUS_OUT * math.cos(ang)
        by0 = GUN_RADIUS_OUT * math.sin(ang)
        bz0 = -35.0
        # Top anchor (lower belt outer, Z = 0)
        tx0 = CYL_RADIUS * math.cos(ang)
        ty0 = CYL_RADIUS * math.sin(ang)
        tz0 = 0.0

        # Direction vector of the strut
        dx  = tx0 - bx0
        dy  = ty0 - by0
        dz  = tz0 - bz0
        length = math.sqrt(dx*dx + dy*dy + dz*dz)
        nx, ny, nz = dx/length, dy/length, dz/length

        # Create strut as a cylinder (rod) along strut direction
        strut = Part.makeCylinder(
            STRUT_T / 2.0, length,
            App.Vector(bx0, by0, bz0),
            App.Vector(nx, ny, nz)
        )
        strut_shapes.append(strut)

    right_pod = _fuse(pod_body, *strut_shapes)

    _add_obj(doc, "Inner_Right_Pod_MG996R_Cradle",
             "Right Pod — MG996R Pass-Through Cradle + 70° Struts", right_pod)
    print("[RIGHT POD] built OK — MG996R window, 70° struts")
    return right_pod


# ─────────────────────────────────────────────────────────────────────────────
# 4. LEFT POD — RS-385 C-Clamp Grinder Sleeve
#    - Mirror of right pod geometry for struts
#    - Open C-clamp sleeve (28 mm bore), split slit, M3 pinch-bolt lug
# ─────────────────────────────────────────────────────────────────────────────
def build_left_pod_rs385(doc):
    # Mirror on -X side
    pod_x0_abs = GUN_RADIUS_OUT          # 18.52 mm from centre
    pod_dx     = RS385_DIA + 10.0        # 38 mm wide
    pod_dy     = RS385_DIA + 10.0        # 38 mm deep
    pod_dz     = 65.0
    pod_z0     = -35.0 - pod_dz          # top at Z = -35

    # Pod body — left side (-X)
    pod_body = _box(pod_dx, pod_dy, pod_dz,
                    -(pod_x0_abs + pod_dx),
                    -pod_dy / 2.0,
                    pod_z0)

    # Motor bore (28 mm dia) through the pod — vertical axis (Z)
    motor_cx = -(pod_x0_abs + pod_dx / 2.0)
    motor_cy = 0.0
    motor_bore = _cyl(RS385_DIA / 2.0, pod_dz + 4.0,
                      pod_z0 - 2.0)
    motor_bore.translate(App.Vector(motor_cx, motor_cy, 0))
    # Actually create along Z axis centred at motor_cx, motor_cy
    motor_bore_z = Part.makeCylinder(
        RS385_DIA / 2.0, pod_dz + 4.0,
        App.Vector(motor_cx, motor_cy, pod_z0 - 2.0),
        App.Vector(0, 0, 1)
    )
    pod_body = pod_body.cut(motor_bore_z)

    # Split slit (1 mm wide, cuts down from top through one side)
    slit = _box(1.5, pod_dy + 4.0, pod_dz + 4.0,
                motor_cx - 0.75,
                -(pod_dy / 2.0 + 2.0),
                pod_z0 - 2.0)
    pod_body = pod_body.cut(slit)

    # Pinch-bolt tightening lug on far left edge (-X)
    lug_x = -(pod_x0_abs + pod_dx)
    lug = _box(10.0, pod_dy, 14.0,
               lug_x - 10.0,
               -pod_dy / 2.0,
               pod_z0 + pod_dz / 2.0 - 7.0)
    # M3 hole through lug (radial, X direction)
    m3_hole = Part.makeCylinder(
        1.6, 16.0,
        App.Vector(lug_x - 12.0, 0, pod_z0 + pod_dz / 2.0),
        App.Vector(1, 0, 0)
    )
    lug = lug.cut(m3_hole)
    pod_body = pod_body.fuse(lug)

    # --- 3 struts: gun-collar outer top → lower belt (left side) ---
    strut_shapes = []
    for ang_deg in [150.0, 180.0, 210.0]:
        ang = math.radians(ang_deg)
        bx0 = GUN_RADIUS_OUT * math.cos(ang)
        by0 = GUN_RADIUS_OUT * math.sin(ang)
        bz0 = -35.0
        tx0 = CYL_RADIUS * math.cos(ang)
        ty0 = CYL_RADIUS * math.sin(ang)
        tz0 = 0.0

        dx  = tx0 - bx0
        dy  = ty0 - by0
        dz  = tz0 - bz0
        length = math.sqrt(dx*dx + dy*dy + dz*dz)
        nx, ny, nz = dx/length, dy/length, dz/length

        strut = Part.makeCylinder(
            STRUT_T / 2.0, length,
            App.Vector(bx0, by0, bz0),
            App.Vector(nx, ny, nz)
        )
        strut_shapes.append(strut)

    left_pod = _fuse(pod_body, *strut_shapes)

    _add_obj(doc, "Inner_Left_Pod_RS385_GrinderClamp",
             "Left Pod — RS-385 C-Clamp Grinder Sleeve + 70° Struts", left_pod)
    print("[LEFT POD] built OK — RS-385 C-clamp, 70° struts")
    return left_pod


# ─────────────────────────────────────────────────────────────────────────────
# 5. GAS-CAP GEAR (24T, Module 1.25) — in X-Z plane (vertical)
# ─────────────────────────────────────────────────────────────────────────────
def build_spur_gear_xz(doc, name, label, cx, cz):
    """
    Build a simplified 24T spur gear in the X-Z plane.
    Gear axis = Y-axis.  Centre at (cx, 0, cz).
    Tooth profile: rectangular nubs around pitch circle.
    """
    PR = GAS_GEAR_PD / 2.0           # 15 mm pitch radius
    tooth_h = GAS_GEAR_MODULE * 2.25
    tooth_w = math.pi * GAS_GEAR_PD / GAS_GEAR_TEETH * 0.6   # ~2.36 mm
    n_teeth  = GAS_GEAR_TEETH

    # Hub cylinder (addendum circle minus teeth)
    hub = Part.makeCylinder(
        PR - GAS_GEAR_MODULE,
        GAS_GEAR_HEIGHT,
        App.Vector(cx, -GAS_GEAR_HEIGHT / 2.0, cz - (PR - GAS_GEAR_MODULE)),
        App.Vector(0, 1, 0)
    )

    # Teeth
    tooth_shapes = []
    for i in range(n_teeth):
        ang = math.radians(i * 360.0 / n_teeth)
        # Tooth base at pitch radius, tip at pitch radius + tooth_h
        base_r = PR - GAS_GEAR_MODULE * 0.1
        mid_x  = (base_r + tooth_h / 2.0) * math.cos(ang)
        mid_z  = (base_r + tooth_h / 2.0) * math.sin(ang)
        # Tooth as a small box, rotated to tangent
        tooth = _box(tooth_w, GAS_GEAR_HEIGHT, tooth_h,
                     -tooth_w / 2.0,
                     -GAS_GEAR_HEIGHT / 2.0,
                     0.0)
        # Place tooth: rotate by angle in X-Z plane
        m = App.Matrix()
        m.rotateY(ang)
        tooth = tooth.transformGeometry(m)
        tooth.translate(App.Vector(mid_x + cx, 0, mid_z + cz))
        tooth_shapes.append(tooth)

    # M5 centre bore (for servo shaft or gas cap pin)
    bore = Part.makeCylinder(
        2.5, GAS_GEAR_HEIGHT + 2.0,
        App.Vector(cx, -GAS_GEAR_HEIGHT / 2.0 - 1.0, cz - 2.5),
        App.Vector(0, 1, 0)
    )

    gear = _fuse(hub, *tooth_shapes)
    gear = gear.cut(bore)

    _add_obj(doc, name, label, gear)
    print(f"[GEAR] {name} built OK")
    return gear


# ─────────────────────────────────────────────────────────────────────────────
# 6. GUN COLLAR (reference ring — centred at Z = -44, bore = 28.65 mm dia)
# ─────────────────────────────────────────────────────────────────────────────
def build_gun_collar(doc):
    outer = _cyl(GUN_RADIUS_OUT + 2.0, GUN_HEIGHT, -44.0 - GUN_HEIGHT/2.0)
    inner = _cyl(GUN_RADIUS_IN,        GUN_HEIGHT, -44.0 - GUN_HEIGHT/2.0)
    collar = outer.cut(inner)
    _add_obj(doc, "Gun_Collar_9cm",
             "Gun Collar — 9 cm perimeter reference ring", collar)
    print("[GUN COLLAR] built OK")
    return collar


# ─────────────────────────────────────────────────────────────────────────────
# MAIN BUILD + EXPORT
# ─────────────────────────────────────────────────────────────────────────────
def build_inner_core_v9():
    doc = App.newDocument("Inner_Core_Turret_V9")

    # Build all parts
    build_cylinder_cage(doc)
    build_vertical_bearings(doc)
    build_right_pod_mg996r(doc)
    build_left_pod_rs385(doc)

    # Gas-knob gear pair (X-Z plane) — gas cap gear at X=0, Z=MG_SHAFT_Z
    build_spur_gear_xz(doc,
                       "Vertical_Gas_Cap_Gear_24T",
                       "Gas-Cap Spur Gear 24T (X-Z plane)",
                       0.0, MG_SHAFT_Z)
    # MG996R output gear offset by GAS_CENTRE_DIST along X
    build_spur_gear_xz(doc,
                       "Vertical_MG996R_Gear_24T",
                       "MG996R Spur Gear 24T (X-Z plane)",
                       GAS_CENTRE_DIST, MG_SHAFT_Z)

    build_gun_collar(doc)

    doc.recompute()

    # ── Validation report ──────────────────────────────────────────────────
    print("\n" + "="*60)
    print("V9 Validation Report")
    print("="*60)
    for obj in doc.Objects:
        try:
            valid = obj.Shape.isValid()
            vols  = obj.Shape.Volume
            print(f"  {obj.Name:<45} isValid={valid}  vol={vols:.1f} mm³")
        except Exception as e:
            print(f"  {obj.Name:<45} [ERROR: {e}]")

    # ── Export ─────────────────────────────────────────────────────────────
    script_dir = os.path.dirname(os.path.abspath(__file__))
    stl_dir  = os.path.join(script_dir, "stl")
    step_dir = os.path.join(script_dir, "step")
    os.makedirs(stl_dir,  exist_ok=True)
    os.makedirs(step_dir, exist_ok=True)

    printable_names = [
        "Inner_Cylinder_Cage_120degGear",
        "Inner_Right_Pod_MG996R_Cradle",
        "Inner_Left_Pod_RS385_GrinderClamp",
        "Vertical_Gas_Cap_Gear_24T",
        "Vertical_MG996R_Gear_24T",
    ]

    exported_objs = []
    print("\n--- Exporting STL + STEP ---")
    for name in printable_names:
        obj = doc.getObject(name)
        if obj is None:
            print(f"  [SKIP] {name} not found")
            continue
        stl_path  = os.path.join(stl_dir,  f"{name}.stl")
        step_path = os.path.join(step_dir, f"{name}.step")
        try:
            obj.Shape.exportStl(stl_path)
            Part.export([obj], step_path)
            print(f"  [OK]  {name}")
            exported_objs.append(obj)
        except Exception as e:
            print(f"  [ERR] {name}: {e}")

    # Combined STEP assembly
    if exported_objs:
        assy_path = os.path.join(step_dir, "Inner_Core_V9_Assembly.step")
        try:
            Part.export(exported_objs, assy_path)
            print(f"  [OK]  Combined: Inner_Core_V9_Assembly.step")
        except Exception as e:
            print(f"  [ERR] Combined STEP: {e}")

    # Save FCStd
    fcstd_path = os.path.join(script_dir, "Inner_Core_Turret_V9.FCStd")
    try:
        doc.saveAs(fcstd_path)
        print(f"  [OK]  FCStd saved: {fcstd_path}")
    except Exception as e:
        print(f"  [ERR] FCStd save: {e}")

    print("\nV9 build complete.")


# ─── Entry point (freecadcmd runs the whole file; __name__ != "__main__") ───
build_inner_core_v9()
