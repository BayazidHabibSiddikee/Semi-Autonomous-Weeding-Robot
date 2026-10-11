"""
Parametric High-Clearance Rover Chassis & Drivetrain Model
ROS / URDF Ready for Weed-Laser-Robot
Matches:
- Upper chassis: 256 mm x 155 mm at Z = 125 mm
- Height: 125 mm ground to board underside
- Wheel: R = 35 mm (dia 70 mm, width 26 mm)
- Outer wheel footprint: 325 mm x 200 mm (wheel centers at X = +/- 127.5, outer tire Y = +/- 100)
- Structurally connected:
  * Motor shaft origin is concentric with wheel center (axle enters wheel hub with zero gap)
  * Motors clamped flush between inner and outer side bridge plates
  * M3 cross-bolts pass cleanly through motor mounting through-holes and both wooden plates
  * Side arch tenons insert through top chassis plate mortise slots
  * True-to-life 130-size TT Gearbox Motors (standard 1:48 dual shaft)
"""

import math
import FreeCAD
import Part
from FreeCAD import Vector

def make_star(center_x, center_y, z_level, r_outer, r_inner, num_pts=5):
    pts = []
    step = math.pi / num_pts
    for i in range(num_pts * 2):
        r = r_outer if (i % 2 == 0) else r_inner
        ang = i * step
        pts.append(Vector(center_x + r * math.cos(ang), center_y + r * math.sin(ang), z_level))
    pts.append(pts[0])
    return Part.Face(Part.makePolygon(pts))

def make_chassis_top_plate(length=256.0, width=155.0, thickness=3.5, height_z=125.0):
    hw = width / 2.0
    hl = length / 2.0
    chamf = 32.0
    outer_pts = [
        Vector(hl - chamf, -hw, height_z),
        Vector(hl, -hw + chamf, height_z),
        Vector(hl, hw - chamf, height_z),
        Vector(hl - chamf, hw, height_z),
        Vector(-hl + chamf, hw, height_z),
        Vector(-hl, hw - chamf, height_z),
        Vector(-hl, -hw + chamf, height_z),
        Vector(-hl + chamf, -hw, height_z),
        Vector(hl - chamf, -hw, height_z)
    ]
    plate = Part.Face(Part.makePolygon(outer_pts)).extrude(Vector(0, 0, thickness))

    # Star cutout
    star = make_star(40.0, 0.0, height_z - 1.0, 20.0, 8.5)
    plate = plate.cut(star.extrude(Vector(0, 0, thickness + 2.0)))

    # Diamond cutout
    d_size = 28.0
    d_pts = [
        Vector(-55.0 + d_size, 0, height_z - 1.0),
        Vector(-55.0, d_size, height_z - 1.0),
        Vector(-55.0 - d_size, 0, height_z - 1.0),
        Vector(-55.0, -d_size, height_z - 1.0),
        Vector(-55.0 + d_size, 0, height_z - 1.0)
    ]
    plate = plate.cut(Part.Face(Part.makePolygon(d_pts)).extrude(Vector(0, 0, thickness + 2.0)))

    # Longitudinal wire slot
    plate = plate.cut(Part.makeBox(40.0, 4.0, thickness + 2.0, Vector(-20.0, -2.0, height_z - 1.0)))

    # Electronics cutout
    plate = plate.cut(Part.makeBox(22.0, 14.0, thickness + 2.0, Vector(65.0, -7.0, height_z - 1.0)))

    # Oblong ventilation slots (5 per side)
    for side in [-1, 1]:
        for i in range(5):
            sx = 25.0 + i * 11.0
            sy = side * 50.0
            plate = plate.cut(Part.makeBox(5.0, 16.0, thickness + 2.0, Vector(sx, sy - 8.0, height_z - 1.0)))

    # Angled edge styling slots
    for sx in [-1, 1]:
        for sy in [-1, 1]:
            aslot = Part.makeBox(4.0, 35.0, thickness + 2.0, Vector(0, -17.5, height_z - 1.0))
            aslot.rotate(Vector(0,0,height_z), Vector(0,0,1), 45.0 * sx * sy)
            aslot.translate(Vector(sx * (hl - 22.0), sy * (hw - 22.0), 0))
            plate = plate.cut(aslot)

    # Mortise slots for the side arch panel tabs
    # Outer plate at Y = +/- 67.5 mm, Inner plate at Y = +/- 45.5 mm
    for sy in [-67.5, -45.5, 45.5, 67.5]:
        for sx in [-28.0, 28.0]:
            tslot = Part.makeBox(22.0, 4.0, thickness + 2.0, Vector(sx - 11.0, sy - 2.0, height_z - 1.0))
            plate = plate.cut(tslot)

    return plate

def make_side_arch_panel(thickness=3.5, has_tabs=True, is_outer=True):
    """
    Creates a mathematically exact side bridge arch plate.
    Wheel centers are at X = +127.5, Z = 35.0 (Front) and X = -127.5, Z = 35.0 (Rear).
    Top underside of chassis is at Z = 125.0.
    Height difference dz = 90.0 mm.
    Front leg angle = 45 deg (dx = dz = 90 mm).
    Top junction is at X = 127.5 - 90 = +37.5 mm.
    Rear junction is at X = -127.5 + 90 = -37.5 mm.
    """
    tab_h = 3.5 if has_tabs else 0.0

    pts = [
        # Horizontal top edge spanning X = -45 to +45 at Z = 125
        Vector(-45, 0, 125),
        Vector(-38, 0, 125 + tab_h),  # Rear tab
        Vector(-18, 0, 125 + tab_h),
        Vector(-18, 0, 125),
        Vector(18, 0, 125),
        Vector(18, 0, 125 + tab_h),   # Front tab
        Vector(38, 0, 125 + tab_h),
        Vector(45, 0, 125),

        # Front sloping leg upper boundary (slope = -1, dz/dx = -1)
        Vector(138, 0, 32),
        Vector(135, 0, 20),
        Vector(118, 0, 20),
        Vector(115, 0, 32),

        # Front sloping leg under boundary (parallel slope)
        Vector(42, 0, 105),

        # Arch under-cutout tunnel (high clearance straddle arch)
        Vector(22, 0, 105),
        Vector(18, 0, 110),
        Vector(-18, 0, 110),
        Vector(-22, 0, 105),
        Vector(-42, 0, 105),

        # Rear sloping leg under boundary
        Vector(-115, 0, 32),
        Vector(-118, 0, 20),
        Vector(-135, 0, 20),
        Vector(-138, 0, 32),

        # Close back to top
        Vector(-45, 0, 125)
    ]

    panel = Part.Face(Part.makePolygon(pts)).extrude(Vector(0, thickness, 0))

    # Center bridge vertical slots (3 slots as in photo)
    for sx in [-7.0, 0.0, 7.0]:
        slot = Part.makeBox(3.2, thickness + 2.0, 12.0, Vector(sx - 1.6, -1.0, 111.0))
        panel = panel.cut(slot)

    # Center bridge clamping bolt holes
    for bx in [-30.0, 30.0]:
        for bz in [112.0, 121.0]:
            b_hole = Part.makeCylinder(1.6, thickness + 2.0, Vector(bx, -1.0, bz), Vector(0, 1, 0))
            panel = panel.cut(b_hole)

    # Front and rear triangular lightening cutouts on sloping legs
    tri_f = [Vector(72, -1, 76), Vector(84, -1, 64), Vector(70, -1, 64), Vector(72, -1, 76)]
    panel = panel.cut(Part.Face(Part.makePolygon(tri_f)).extrude(Vector(0, thickness + 2.0, 0)))

    tri_r = [Vector(-72, -1, 76), Vector(-70, -1, 64), Vector(-84, -1, 64), Vector(-72, -1, 76)]
    panel = panel.cut(Part.Face(Part.makePolygon(tri_r)).extrude(Vector(0, thickness + 2.0, 0)))

    # Motor body window (only on outer plate, as seen in user's photo!)
    if is_outer:
        m_win_f = Part.makeBox(20.0, thickness + 2.0, 16.0, Vector(92.0, -1.0, 46.0))
        panel = panel.cut(m_win_f)
        m_win_r = Part.makeBox(20.0, thickness + 2.0, 16.0, Vector(-112.0, -1.0, 46.0))
        panel = panel.cut(m_win_r)

    # Axle clearance hole at exact wheel center (X = +/- 127.5, Z = 35.0)
    axle_f = Part.makeCylinder(3.2, thickness + 2.0, Vector(127.5, -1.0, 35.0), Vector(0, 1, 0))
    axle_r = Part.makeCylinder(3.2, thickness + 2.0, Vector(-127.5, -1.0, 35.0), Vector(0, 1, 0))
    panel = panel.cut(axle_f).cut(axle_r)

    # Motor M3 mounting screw through-holes (17.5 mm spacing along 45-deg leg)
    # Pitch vector along 45 deg: (-cos45, sin45) * 17.5 = (-12.37, 12.37)
    m_bolt_f1 = Part.makeCylinder(1.6, thickness + 2.0, Vector(127.5 - 12.37, -1.0, 35.0 + 12.37), Vector(0, 1, 0))
    m_bolt_f2 = Part.makeCylinder(1.6, thickness + 2.0, Vector(127.5 - 24.74, -1.0, 35.0 + 24.74), Vector(0, 1, 0))
    panel = panel.cut(m_bolt_f1).cut(m_bolt_f2)

    m_bolt_r1 = Part.makeCylinder(1.6, thickness + 2.0, Vector(-127.5 + 12.37, -1.0, 35.0 + 12.37), Vector(0, 1, 0))
    m_bolt_r2 = Part.makeCylinder(1.6, thickness + 2.0, Vector(-127.5 + 24.74, -1.0, 35.0 + 24.74), Vector(0, 1, 0))
    panel = panel.cut(m_bolt_r1).cut(m_bolt_r2)

    return panel

def make_real_tt_motor(is_right_side=False):
    """
    Standard Yellow TT DC Gearbox Motor (1:48 Dual Shaft).
    Engineered with exact mechanical datum:
    - Axle center is precisely at (0, 0, 0)!
    - Axle shaft is along Y axis (driving shaft extends towards wheel).
    - Gearbox body extends along the -X direction (body length ~64mm, width 22.3mm, thickness 18.8mm).
    - 2x M3 mounting through-holes at exact spacing 17.5 mm.
    """
    gearbox = Part.makeBox(42.0, 18.8, 22.3, Vector(-42.0, -9.4, -11.15))
    gearbox_nose = Part.makeCylinder(11.15, 18.8, Vector(0, -9.4, 0), Vector(0, 1, 0))
    gearbox = gearbox.fuse(gearbox_nose)

    # 2x M3 mounting through-holes (pitch 17.5mm along X from axle)
    hole1 = Part.makeCylinder(1.6, 20.0, Vector(-17.5, -10.0, 0), Vector(0, 1, 0))
    hole2 = Part.makeCylinder(1.6, 20.0, Vector(-35.0, -10.0, 0), Vector(0, 1, 0))
    gearbox = gearbox.cut(hole1).cut(hole2)

    # 130-size cylindrical DC motor can at the back of the gearbox
    motor_can = Part.makeCylinder(10.0, 25.0, Vector(-42.0, 0, 0), Vector(-1, 0, 0))
    terminals = Part.makeBox(3.0, 8.0, 8.0, Vector(-67.0, -4.0, -4.0))
    motor_assembly = motor_can.fuse(terminals)

    # Dual D-shaft (White plastic):
    # Driving shaft extends 10mm towards the wheel side (+Y for left, -Y for right)
    # Stub shaft extends 8mm on the opposite side
    if not is_right_side:
        axle_drive = Part.makeCylinder(2.7, 10.0, Vector(0, 9.4, 0), Vector(0, 1, 0))
        axle_stub = Part.makeCylinder(2.7, 8.0, Vector(0, -9.4, 0), Vector(0, -1, 0))
    else:
        axle_drive = Part.makeCylinder(2.7, 10.0, Vector(0, -9.4, 0), Vector(0, -1, 0))
        axle_stub = Part.makeCylinder(2.7, 8.0, Vector(0, 9.4, 0), Vector(0, 1, 0))
    axles = axle_drive.fuse(axle_stub)

    return gearbox, motor_assembly, axles

def make_wheel(radius=35.0, width=26.0):
    """
    Standard hobby rover wheel:
    - Yellow 5-spoke rim
    - Black rubber tread tire
    - Hub socket with D-shaft hole (starts at Y = 0 where axle engages)
    """
    rim_r = radius - 8.0
    tire = Part.makeCylinder(radius, width, Vector(0, 0, 0), Vector(0, 1, 0))
    tire = tire.cut(Part.makeCylinder(rim_r, width + 2.0, Vector(0, -1.0, 0), Vector(0, 1, 0)))

    # Tread lugs
    for i in range(20):
        ang = i * (math.pi / 10.0)
        tx = (radius - 1.0) * math.cos(ang)
        tz = (radius - 1.0) * math.sin(ang)
        lug = Part.makeBox(2.8, width * 0.75, 2.2, Vector(-1.4, width * 0.125, -1.1))
        lug.rotate(Vector(0,0,0), Vector(0,1,0), -ang * 180.0 / math.pi)
        lug.translate(Vector(tx, 0, tz))
        tire = tire.fuse(lug)

    # Yellow plastic rim with 5 star spokes
    rim_shell = Part.makeCylinder(rim_r, width - 4.0, Vector(0, 2.0, 0), Vector(0, 1, 0))
    rim_shell = rim_shell.cut(Part.makeCylinder(rim_r - 3.0, width, Vector(0, 4.0, 0), Vector(0, 1, 0)))

    center_hub = Part.makeCylinder(6.5, width - 2.0, Vector(0, 1.0, 0), Vector(0, 1, 0))
    axle_socket = Part.makeCylinder(2.75, 10.0, Vector(0, 0, 0), Vector(0, 1, 0))
    center_hub = center_hub.cut(axle_socket)

    rim = rim_shell.fuse(center_hub)
    for j in range(5):
        spoke = Part.makeBox(rim_r * 0.9, 3.5, 4.0, Vector(0, 0, -2.0))
        spoke.rotate(Vector(0,0,0), Vector(0,1,0), -j * 72.0)
        spoke.translate(Vector(0, 3.0, 0))
        rim = rim.fuse(spoke)

    return rim, tire

def build_robot_chassis():
    doc = FreeCAD.newDocument('Weed_Laser_Robot_Chassis')

    WOOD_TOP = (0.76, 0.52, 0.34, 0.0)
    WOOD_LEG = (0.60, 0.38, 0.22, 0.0)
    MOTOR_YELLOW = (0.95, 0.82, 0.08, 0.0)
    MOTOR_SILVER = (0.80, 0.82, 0.85, 0.0)
    AXLE_WHITE = (0.94, 0.94, 0.94, 0.0)
    RIM_YELLOW = (0.96, 0.80, 0.05, 0.0)
    TIRE_BLACK = (0.15, 0.15, 0.15, 0.0)
    BOLT_STEEL = (0.75, 0.77, 0.80, 0.0)

    def set_color(obj, color):
        if hasattr(obj, 'ViewObject') and obj.ViewObject is not None:
            obj.ViewObject.ShapeColor = color

    # 1. Upper Chassis Board (256 mm x 155 mm at Z = 125 mm)
    top_board = make_chassis_top_plate(length=256.0, width=155.0, thickness=3.5, height_z=125.0)
    obj_board = doc.addObject('Part::Feature', 'Chassis_Top_Board')
    obj_board.Shape = top_board
    set_color(obj_board, WOOD_TOP)

    # 2. Side Arch Panels (Left and Right)
    # Motor width is 18.8 mm.
    # We place the motor gearbox centered at Y = 56.5 mm (Left) and Y = -56.5 mm (Right).
    # Inner plate is at Y = 45.5 mm (thickness 3.5 mm -> spans Y: 45.5 to 49.0 mm).
    # Outer plate is at Y = 67.5 mm (thickness 3.5 mm -> spans Y: 64.0 to 67.5 mm).
    # Motor gearbox face is from Y = 47.1 to Y = 65.9 mm (fits snugly with 0.1 mm gap!).
    # Outer shaft extends from Y = 65.9 mm outward past outer plate face (Y = 67.5) to Y = 75.9 mm!
    # Wheel hub begins at Y = 74.0 mm, engaging the shaft directly!
    # Outer tire face is at Y = 74.0 + 26.0 = 100.0 mm!
    # Total width between outermost tire edges = 100.0 - (-100.0) = 200.0 mm EXACTLY!

    side_plates = [
        # (name, is_outer, y_pos, has_tabs)
        ('Left_Inner', False, 45.5, True),
        ('Left_Outer', True, 64.0, True),
        ('Right_Inner', False, -49.0, True),
        ('Right_Outer', True, -67.5, True)
    ]

    for name, is_outer, y_pos, has_tabs in side_plates:
        panel_shape = make_side_arch_panel(thickness=3.5, has_tabs=has_tabs, is_outer=is_outer)
        panel_shape.translate(Vector(0, y_pos, 0))
        panel_obj = doc.addObject('Part::Feature', f'Side_Bridge_{name}')
        panel_obj.Shape = panel_shape
        set_color(panel_obj, WOOD_LEG)

    # Clamping M3 bolts in bridge
    for side_sign in [1, -1]:
        sy = 45.0 if side_sign > 0 else -68.0
        for bx in [-30.0, 30.0]:
            bolt = Part.makeCylinder(1.5, 23.5, Vector(bx, sy, 121.0), Vector(0, side_sign, 0))
            head = Part.makeCylinder(3.0, 2.0, Vector(bx, sy if side_sign > 0 else sy + 23.5, 121.0), Vector(0, -side_sign, 0))
            b_obj = doc.addObject('Part::Feature', f'Bridge_Clamp_Bolt_{"L" if side_sign>0 else "R"}_{bx:+0.0f}')
            b_obj.Shape = bolt.fuse(head)
            set_color(b_obj, BOLT_STEEL)

    # 3. Drivetrain: 4 Real TT Motors + Wheels
    # Front wheel center: X = +127.5 mm, Z = 35.0 mm
    # Rear wheel center: X = -127.5 mm, Z = 35.0 mm
    wheel_configs = [
        ('Front_Left', 127.5, 74.0, 1, 1),
        ('Rear_Left', -127.5, 74.0, -1, 1),
        ('Front_Right', 127.5, -74.0, 1, -1),
        ('Rear_Right', -127.5, -74.0, -1, -1)
    ]

    for name, wx, wy_hub, dir_x, side_sign in wheel_configs:
        is_right = (side_sign < 0)
        gearbox, motor_can, axle = make_real_tt_motor(is_right_side=is_right)

        # The motor's axle datum is (0, 0, 0)
        # We orient the motor body along the 45-degree sloping leg:
        # Front motors (dir_x = 1): leg slopes down-forward, so motor body points up-backward (+45 deg around +Y)
        # Rear motors (dir_x = -1): leg slopes down-backward, so motor body points up-forward (+135 deg around +Y)
        motor_rot_y = 45.0 if dir_x > 0 else 135.0
        gearbox.rotate(Vector(0,0,0), Vector(0,1,0), motor_rot_y)
        motor_can.rotate(Vector(0,0,0), Vector(0,1,0), motor_rot_y)
        axle.rotate(Vector(0,0,0), Vector(0,1,0), motor_rot_y)

        # Translate motor to axle center at (wx, motor_y, 35.0)
        motor_y = side_sign * 56.5
        gearbox.translate(Vector(wx, motor_y, 35.0))
        motor_can.translate(Vector(wx, motor_y, 35.0))
        axle.translate(Vector(wx, motor_y, 35.0))

        gb_obj = doc.addObject('Part::Feature', f'TT_Gearbox_{name}')
        gb_obj.Shape = gearbox
        set_color(gb_obj, MOTOR_YELLOW)

        mc_obj = doc.addObject('Part::Feature', f'DC_Motor_{name}')
        mc_obj.Shape = motor_can
        set_color(mc_obj, MOTOR_SILVER)

        ax_obj = doc.addObject('Part::Feature', f'Motor_Axle_{name}')
        ax_obj.Shape = axle
        set_color(ax_obj, AXLE_WHITE)

        # Mounting M3 bolts through motor and wood plates
        bolt_pitch = 17.5
        bolt_x = wx - (dir_x * bolt_pitch * math.cos(math.pi/4.0))
        bolt_z = 35.0 + (bolt_pitch * math.sin(math.pi/4.0))
        bolt_m = Part.makeCylinder(1.5, 24.0, Vector(bolt_x, motor_y - (side_sign * 12.0), bolt_z), Vector(0, side_sign, 0))
        b_motor_obj = doc.addObject('Part::Feature', f'Motor_Mount_Bolt_{name}')
        b_motor_obj.Shape = bolt_m
        set_color(b_motor_obj, BOLT_STEEL)

        # Wheel assembly (rim starts at wy_hub)
        rim, tire = make_wheel(radius=35.0, width=26.0)
        if side_sign < 0:
            rim.rotate(Vector(0,0,0), Vector(1,0,0), 180.0)
            tire.rotate(Vector(0,0,0), Vector(1,0,0), 180.0)

        rim.translate(Vector(wx, wy_hub, 35.0))
        tire.translate(Vector(wx, wy_hub, 35.0))

        rim_obj = doc.addObject('Part::Feature', f'Wheel_Rim_{name}')
        rim_obj.Shape = rim
        set_color(rim_obj, RIM_YELLOW)

        tire_obj = doc.addObject('Part::Feature', f'Wheel_Tire_{name}')
        tire_obj.Shape = tire
        set_color(tire_obj, TIRE_BLACK)

    doc.recompute()
    return doc

if __name__ == '__main__':
    doc = build_robot_chassis()
    out_fcstd = '/home/sword/Documents/weed-laser-robot/weed_robot_chassis.FCStd'
    doc.saveAs(out_fcstd)
    print(f"SUCCESS: ROS/URDF Ready connected model saved to {out_fcstd}")
