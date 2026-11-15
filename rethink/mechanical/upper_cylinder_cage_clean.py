"""
upper_cylinder_cage_clean.py — Clean Upper Cylinder Cage (V11/Clean Iteration)
=============================================================================
Fixes:
  1. Red Area Cut: Protruding screw lug completely removed from lower 20mm (Z=0..20mm).
     Lug sits strictly in upper half (Z=20..40mm) with dual M3 screws at Z=25mm and Z=34mm.
     Curved flush bridge at -Y keeps lower and upper belts moving together.
  2. Bearing Box Removed: Rectangular boss boxes deleted. 3x 5mm cylindrical bearing pins
     emerge directly from the smooth curved surface of the lower belt.
  3. Vertical straps curved flush to cylinder radius (no protruding box corners).

Run headless:
    freecadcmd /path/to/upper_cylinder_cage_clean.py

Exports:
    rethink/mechanical/stl/Upper_Cylinder_Cage_Clean.stl
    rethink/mechanical/step/Upper_Cylinder_Cage_Clean.step
    rethink/mechanical/Upper_Cylinder_Cage_Clean.FCStd
"""

import os
import math

import FreeCAD as App
import Part

# =========================================================================
# UPPER CYLINDER CAGE PARAMETERS (in mm)
# =========================================================================
CYL_PERIMETER = 220.0                        # 22 cm cylinder perimeter
CYL_RADIUS = CYL_PERIMETER / (2.0 * math.pi) # 35.01 mm inner radius
BELT_THICK = 2.0                             # 2.0 mm belt wall thickness
BELT_HEIGHT = 10.0                           # 10 mm height per belt
BELT_GAP = 20.0                              # 2 cm (20 mm) gap between belts

# Bearing Pin (625zz: 5mm pin, 16mm OD, 5mm thick | Or set 8.0 for 608zz)
BEARING_ID = 5.0
BEARING_OD = 16.0
BEARING_W  = 5.0

# Top 120-Deg Sector Gear (Module 1.5, 52 full teeth -> Pitch R = 39.0 mm)
TOP_MOD = 1.5
RING_FULL_TEETH = 52
SECTOR_ARC_DEG = 120.0
M3_HOLE = 3.2


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
        pts.append(App.Vector(root_r  * math.cos(ac - step * 0.36), root_r  * math.sin(ac - step * 0.36), z0))
        pts.append(App.Vector(outer_r * math.cos(ac - step * 0.15), outer_r * math.sin(ac - step * 0.15), z0))
        pts.append(App.Vector(outer_r * math.cos(ac + step * 0.15), outer_r * math.sin(ac + step * 0.15), z0))
        pts.append(App.Vector(root_r  * math.cos(ac + step * 0.36), root_r  * math.sin(ac + step * 0.36), z0))
    end_a = start_a + num_arc * step
    pts.append(App.Vector(radius_in * math.cos(end_a), radius_in * math.sin(end_a), z0))
    pts.append(pts[0])
    return Part.Face(Part.makePolygon(pts)).extrude(App.Vector(0, 0, height))


def build_clean_upper_cage():
    doc = App.newDocument("Upper_Cylinder_Cage_Clean")

    def add_part(shape, name, color=(0.8, 0.8, 0.8)):
        obj = doc.addObject("Part::Feature", name)
        obj.Shape = shape.removeSplitter()
        if App.GuiUp:
            obj.ViewObject.ShapeColor = color
        return obj

    r_in = CYL_RADIUS                      # 35.01 mm
    r_out = CYL_RADIUS + BELT_THICK        # 37.01 mm (exact 2mm wall)
    z_low_belt = 0.0
    z_up_belt = BELT_HEIGHT + BELT_GAP     # +30.0 mm
    z_top = z_up_belt + BELT_HEIGHT        # +40.0 mm

    # 1. Lower & Upper 2mm Belts
    low_belt = Part.makeCylinder(r_out, BELT_HEIGHT, App.Vector(0, 0, z_low_belt))
    up_belt  = Part.makeCylinder(r_out, BELT_HEIGHT, App.Vector(0, 0, z_up_belt))

    # 2. Curved Vertical Ribs (Trimmed to exact r_out cylinder so NO flat box edges stick out!)
    outer_cyl_bound = Part.makeCylinder(r_out, z_top, App.Vector(0, 0, z_low_belt))
    ribs_and_pins = []
    bearings_90deg = []

    for ang_deg in [0.0, 120.0, 240.0]:
        # Vertical strap curved flush with the 2mm belts
        raw_rib = Part.makeBox(BELT_THICK + 4.0, 10.0, z_top, App.Vector(r_in - 1.0, -5.0, z_low_belt))
        raw_rib.rotate(App.Vector(0, 0, 0), App.Vector(0, 0, 1), ang_deg)
        curved_rib = raw_rib.common(outer_cyl_bound)

        # Pure Cylindrical Bearing Pin (NO rectangular boss box behind it!)
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

    # 3. Flush Curved Bridge at -Y (270 deg) so lower & upper belts move together around the slit
    slit_bridge_raw = Part.makeBox(16.0, BELT_THICK + 4.0, z_top, App.Vector(-8.0, -r_out - 2.0, z_low_belt))
    slit_bridge_curved = slit_bridge_raw.common(outer_cyl_bound)

    # 4. UPPER-ONLY Screw Lug (Red lower area Z=0..20mm removed! Sits at Z=20..40mm with 2 Green-Dot Screws)
    z_lug_bottom = 20.0
    clamp_lug_upper = Part.makeBox(12.0, 14.0, z_top - z_lug_bottom,
                                   App.Vector(-6.0, -r_out - 12.0, z_lug_bottom))

    # 5. 120-Deg Sector Gear on Top Belt
    sec_gear = make_sector_gear(r_in + 0.5, 39.0, RING_FULL_TEETH, TOP_MOD,
                                SECTOR_ARC_DEG, BELT_HEIGHT, z_up_belt)

    # Fuse & Cut Center Cylinder Bore + Expansion Slit + 2 Green-Dot Screw Holes (Z=25mm & Z=34mm)
    upper_cage = low_belt.fuse([up_belt, slit_bridge_curved, clamp_lug_upper, sec_gear] + ribs_and_pins)
    cyl_bore = Part.makeCylinder(r_in, z_top + 10.0, App.Vector(0, 0, -2.0))
    slit = Part.makeBox(2.5, 30.0, z_top + 10.0, App.Vector(-1.25, -r_out - 18.0, -2.0))

    # Two tightening screws at the green marked spots (Z = 25.0 mm and Z = 34.0 mm)
    screw_green_1 = Part.makeCylinder(M3_HOLE / 2.0, 20.0,
                                      App.Vector(-10.0, -r_out - 6.5, 25.0), App.Vector(1, 0, 0))
    screw_green_2 = Part.makeCylinder(M3_HOLE / 2.0, 20.0,
                                      App.Vector(-10.0, -r_out - 6.5, 34.0), App.Vector(1, 0, 0))

    upper_cage = upper_cage.cut(cyl_bore).cut(slit).cut(screw_green_1).cut(screw_green_2)

    cage_obj = add_part(upper_cage, "Upper_Cylinder_Cage_Clean", (0.90, 0.50, 0.10))
    brg_obj = add_part(bearings_90deg[0].fuse(bearings_90deg[1:]), "Three_Bearings_90deg", (0.72, 0.78, 0.85))

    doc.recompute()

    # ── Validation report ──────────────────────────────────────────────────
    print("\n" + "=" * 60)
    print("Upper Cylinder Cage Clean — Validation Report")
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

    # Export STL & STEP for Upper_Cylinder_Cage_Clean
    try:
        stl_path = os.path.join(stl_dir, "Upper_Cylinder_Cage_Clean.stl")
        step_path = os.path.join(step_dir, "Upper_Cylinder_Cage_Clean.step")
        cage_obj.Shape.exportStl(stl_path)
        Part.export([cage_obj], step_path)
        print(f"  [STL  OK] Upper_Cylinder_Cage_Clean.stl")
        print(f"  [STEP OK] Upper_Cylinder_Cage_Clean.step")
    except Exception as e:
        print(f"  [EXPORT ERR] {e}")

    # Also export bearings STEP for CAD reference
    try:
        brg_step_path = os.path.join(step_dir, "Three_Bearings_Clean_Reference.step")
        Part.export([brg_obj], brg_step_path)
        print(f"  [STEP OK] Three_Bearings_Clean_Reference.step")
    except Exception as e:
        print(f"  [BRG STEP ERR] {e}")

    # Save FCStd
    fcstd_path = os.path.join(script_dir, "Upper_Cylinder_Cage_Clean.FCStd")
    try:
        doc.saveAs(fcstd_path)
        print(f"  [FCStd OK] {fcstd_path}")
    except Exception as e:
        print(f"  [FCStd ERR] {e}")

    if App.GuiUp:
        import FreeCADGui as Gui
        Gui.SendMsgToViews("ViewFit")
        Gui.activeDocument().activeView().viewLeft()

    print("\nUpper Cylinder Cage Clean build complete.")


# ─── Entry point ───────────────────────────────────────────────────────────────
build_clean_upper_cage()
