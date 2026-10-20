#!/usr/bin/env python3
"""Generate weed_rover_electrical.kicad_sch — block-style KiCad 9 schematic.

KiCad geometry facts used here:
- lib symbol coords: +y = screen UP; instance maps (px,py) -> sheet (cx+px, cy-py)
- pin (at x y rot) = the CONNECT (outer) point; rot = direction from the
  connect point into the symbol body (0=+x, 90=+y(up), 180=-x, 270=-y(down))
- everything snapped to the 1.27 mm connection grid
Wiring: each pin gets a stub wire outward + a net label (labels merge nets).
"""
import uuid

ROOT = str(uuid.uuid4())
PITCH = 2.54
STUB = 2.54
GRID = 1.27

TYPE = {"p": "power_in", "P": "power_out", "x": "passive",
        "io": "bidirectional", "in": "input", "out": "output"}
LIBPFX = ""

def g(v):  # snap to connection grid
    return round(v / GRID) * GRID

def U(): return str(uuid.uuid4())

# pins: (net, type, edge)  edges: l / r
COMPONENTS = [
    dict(ref="U1", val="Raspberry Pi 5", pos=(140, 120), w=64, pins=[
        ("+5V",      "p", "l"), ("GND", "p", "l"),
        ("SDA",      "x", "l"), ("SCL", "x", "l"),
        ("UART_TX", "out", "l"), ("UART_RX", "in", "l"),
        ("PWM_L",    "x", "l"), ("PWM_R", "x", "l"),
        ("DIR_L",    "x", "l"), ("DIR_R", "x", "l"),
        ("LASER_EN", "x", "l"), ("XSHUT_L", "out", "l"),
        ("XSHUT_R", "out", "l"), ("BAT_ADC", "x", "l"),
        ("TRIG_L", "out", "l"), ("TRIG_R", "out", "l"),
        ("ECHO_L", "in", "l"), ("ECHO_R", "in", "l"),
        ("MTR_ERR", "in", "l"),
        ("ESTOP_N",  "in", "l"), ("BUZZ", "out", "l"),
        ("3V3",      "P", "r"), ("GND", "p", "r"),
    ], descr="SBC: CV, mission planner, boustrophedon state machine"),

    dict(ref="BT1", val="3S LiPo 11.1V 6Ah", pos=(40, 58), w=34, pins=[
        ("+12V_B", "P", "r"), ("GND", "P", "r"),
    ], descr="Main pack, switched + fused"),

    dict(ref="SW1", val="Main switch", pos=(96, 58), w=22, pins=[
        ("+12V_B", "x", "l"), ("+12V_S", "x", "r"),
    ], descr="Power switch"),

    dict(ref="F1", val="15 A fuse", pos=(140, 58), w=22, pins=[
        ("+12V_S", "x", "l"), ("+12V", "x", "r"),
    ], descr="Pack protection"),

    dict(ref="U4", val="INA219", pos=(40, 106), w=34, pins=[
        ("+12V", "x", "l"), ("+12VL", "x", "r"),
        ("GND",  "p", "l"), ("SDA", "x", "r"),
        ("SCL",  "x", "r"), ("3V3", "p", "r"),
    ], descr="Battery bus monitor over I2C (0x40)"),

    dict(ref="U3", val="Mini560 5V/5A", pos=(96, 106), w=32, pins=[
        ("+12VL", "x", "l"), ("GND", "p", "l"),
        ("+5V",   "P", "r"), ("GND", "p", "r"),
    ], descr="5 V buck, powers the Pi"),

    dict(ref="U2", val="ESP32-WROOM-32E", pos=(252, 116), w=44, pins=[
        ("3V3",       "p", "l"), ("GND", "p", "l"),
        ("UART_TX",   "in", "l"), ("UART_RX", "out", "l"),
        ("ESTOP_N",   "in", "l"), ("PWM_L", "out", "l"),
        ("PWM_R",     "out", "l"), ("DIR_L", "out", "l"),
        ("DIR_R",     "out", "l"), ("LASER_EN", "out", "l"),
        ("BAT_ADC",   "x", "r"), ("MTR_ERR", "x", "r"),
    ], descr="Real-time wheel loop + safety gating"),

    dict(ref="U5", val="MD13S left", pos=(330, 58), w=34, pins=[
        ("+12VL", "x", "l"), ("GND", "p", "l"),
        ("PWM_L", "in", "l"), ("DIR_L", "in", "l"),
        ("M_L_A",  "out", "r"), ("M_L_B", "out", "r"),
    ], descr="Left wheel group"),

    dict(ref="U6", val="MD13S right", pos=(330, 110), w=34, pins=[
        ("+12VL", "x", "l"), ("GND", "p", "l"),
        ("PWM_R", "in", "l"), ("DIR_R", "in", "l"),
        ("M_R_A",  "out", "r"), ("M_R_B", "out", "r"),
    ], descr="Right wheel group"),

    dict(ref="J1", val="Motors JST", pos=(386, 84), w=22, pins=[
        ("M_L_A", "in", "r"), ("M_L_B", "in", "r"),
        ("M_R_A", "in", "r"), ("M_R_B", "in", "r"),
    ], descr="To the 8-wheel drive"),

    dict(ref="U7", val="Laser driver + nFET", pos=(330, 168), w=38, pins=[
        ("+12VL",     "x", "l"), ("GND", "p", "l"),
        ("LASER_EN",  "in", "l"), ("LASER_ON_HW", "in", "l"),
        ("LASER_P",   "out", "r"), ("LASER_N", "x", "r"),
    ], descr="Pi AND hardware key must both agree"),

    dict(ref="D1", val="445 nm 2 W diode", pos=(386, 168), w=26, pins=[
        ("LASER_P", "in", "l"), ("LASER_N", "in", "l"),
    ], descr="Cutting head at the arm tip"),

    dict(ref="SW2", val="Key lock", pos=(330, 214), w=28, pins=[
        ("3V3", "p", "l"), ("LASER_ON_HW", "out", "r"),
    ], descr="Hardware laser interlock"),

    dict(ref="U8", val="HC-SR04 front-left", pos=(78, 200), w=34, pins=[
        ("+5V", "p", "l"), ("GND", "p", "l"),
        ("TRIG_L", "in", "r"), ("ECHO_L", "out", "r"),
    ], descr="Ultrasonic 2-400 cm"),

    dict(ref="U9", val="HC-SR04 front-right", pos=(78, 238), w=34, pins=[
        ("+5V", "p", "l"), ("GND", "p", "l"),
        ("TRIG_R", "in", "r"), ("ECHO_R", "out", "r"),
    ], descr="Ultrasonic 2-400 cm"),

    dict(ref="U10", val="VL53L0X front", pos=(160, 200), w=34, pins=[
        ("3V3", "p", "l"), ("GND", "p", "l"),
        ("SDA", "x", "r"), ("SCL", "x", "r"), ("XSHUT_L", "in", "r"),
    ], descr="ToF 30-1200 mm, I2C 0x29"),

    dict(ref="U11", val="VL53L0X rear", pos=(160, 238), w=34, pins=[
        ("3V3", "p", "l"), ("GND", "p", "l"),
        ("SDA", "x", "r"), ("SCL", "x", "r"), ("XSHUT_R", "in", "r"),
    ], descr="ToF 30-1200 mm, I2C 0x2A"),

    dict(ref="LS1", val="Buzzer", pos=(240, 200), w=22, pins=[
        ("BUZZ", "in", "l"), ("3V3", "p", "r"), ("GND", "p", "r"),
    ], descr="Audible start/stop/fault"),

    dict(ref="D2", val="Power LED", pos=(240, 238), w=22, pins=[
        ("+5V", "p", "r"), ("GND", "p", "r"),
    ], descr="Panel light"),

    dict(ref="SW3", val="Emergency stop", pos=(78, 280), w=30, pins=[
        ("3V3", "p", "l"), ("ESTOP_N", "out", "r"), ("GND", "p", "r"),
    ], descr="Breaks LASER_EN and motor chain"),
]

def geom(c):
    pins = c["pins"]
    by_edge = {}
    for i, (net, tty, edge) in enumerate(pins):
        by_edge.setdefault(edge, []).append(i)
    n = max(len(v) for v in by_edge.values())
    h = (n - 1) * PITCH + 5.08
    w = round(c["w"] / PITCH) * PITCH   # must be a multiple of 2.54 so half-width stays on grid
    x0, x1 = -w / 2, w / 2
    y0, y1 = -h / 2, h / 2
    edge_pos = {}
    for edge, idxs in by_edge.items():
        m = len(idxs)
        for k, i in enumerate(idxs):
            edge_pos[i] = ((m - 1) * PITCH / 2 - k * PITCH)
    return x0, y0, x1, y1, edge_pos

def emit():
    A = (L := []).append
    A("(kicad_sch")
    A("  (version 20250114)")
    A('  (generator "eeschema")')
    A('  (generator_version "9.0")')
    A(f'  (uuid "{ROOT}")')
    A('  (paper "A3")')
    A('  (title_block (title "Weed rover electronics") (date "2026-10-21") (rev "1")')
    A('    (company "Semi-Autonomous Weeding Robot")')
    A('    (comment 1 "3S LiPo -> fuse/switch -> INA219 shunt -> buck 5V -> Pi 5 + ESP32")')
    A('    (comment 2 "Drive: 2x MD13S, 8 wheels; Sensors: 2x HC-SR04, 2x VL53L0X (I2C)")')
    A('    (comment 3 "Laser safety: Pi EN AND hardware key lock; e-stop kills motors+laser")')
    A("  )")
    A("  (lib_symbols")

    built = set()
    for c in COMPONENTS:
        if c["ref"] in built:
            continue
        built.add(c["ref"])
        x0, y0, x1, y1, edge_pos = geom(c)
        A(f'    (symbol "{c["ref"]}" (pin_names (offset 0.254)) (exclude_from_sim no) (in_bom yes) (on_board yes)')
        A(f'      (property "Reference" "U" (at 0 {y0 - 1.27:.3f} 0) (effects (font (size 1.27 1.27))))')
        A(f'      (property "Value" "{c["val"]}" (at 0 {y1 + 2.54:.3f} 0) (effects (font (size 1.27 1.27))))')
        A('      (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))')
        A('      (property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))')
        A(f'      (property "Description" "{c["descr"]}" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))')
        A(f'      (symbol "{c["ref"]}_0_1"')
        A(f'        (rectangle (start {x0:.3f} {y0:.3f}) (end {x1:.3f} {y1:.3f}) (stroke (width 0.254) (type default)) (fill (type background)))')
        A("      )")
        A(f'      (symbol "{c["ref"]}_1_1"')
        for i, (net, tty, edge) in enumerate(c["pins"]):
            y = edge_pos[i]
            xe = x0 if edge == "l" else x1
            rot = 0 if edge == "l" else 180
            A(f'        (pin {TYPE[tty]} line (at {xe:.3f} {y:.3f} {rot}) (length {STUB})')
            A(f'          (name "{net}" (effects (font (size 1.016 1.016))))')
            A(f'          (number "{i + 1}" (effects (font (size 1.016 1.016))))')
            A("        )")
        A("      )")
        A("    )")
    A("  )")

    for c in COMPONENTS:
        x0, y0, x1, y1, edge_pos = geom(c)
        cx, cy = g(c["pos"][0]), g(c["pos"][1])
        A(f'  (symbol (lib_id "{c["ref"]}") (at {cx:.3f} {cy:.3f} 0) (unit 1)')
        A('    (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)')
        A(f'    (uuid "{U()}")')
        A(f'    (property "Reference" "{c["ref"]}" (at {cx:.3f} {cy + y0 - 1.27:.3f} 0) (effects (font (size 1.27 1.27))))')
        A(f'    (property "Value" "{c["val"]}" (at {cx:.3f} {cy + y1 + 2.54:.3f} 0) (effects (font (size 1.27 1.27))))')
        A('    (property "Footprint" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))')
        A('    (property "Datasheet" "" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))')
        A(f'    (property "Description" "{c["descr"]}" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))')
        for i in range(len(c["pins"])):
            A(f'    (pin "{i + 1}" (uuid "{U()}"))')
        A(f'    (instances (project "weed_rover_electrical" (path "/{ROOT}" (reference "{c["ref"]}") (unit 1))))')
        A("  )")
        for i, (net, tty, edge) in enumerate(c["pins"]):
            py = edge_pos[i]
            xe = x0 if edge == "l" else x1
            ox = cx + xe
            oy = cy - py          # symbol +y is screen-up
            dx = -1 if edge == "l" else 1
            ex, ey = ox + dx * STUB, oy
            lx = ex + dx * 1.27
            just = "right bottom" if edge == "l" else "left bottom"
            A(f'  (wire (pts (xy {ox:.3f} {oy:.3f}) (xy {ex:.3f} {ey:.3f})) (stroke (width 0) (type solid)) (uuid "{U()}"))')
            A(f'  (label "{net}" (at {ex:.3f} {ey:.3f} 0) (effects (font (size 1.27 1.27)) (justify {just})) (uuid "{U()}"))')

    A('  (sheet_instances (path "/" (page "1")))')
    A('  (embedded_fonts no)')
    A(")")
    return "\n".join(L) + "\n"

out = "/tmp/weed_rover_electrical.kicad_sch"
open(out, "w").write(emit())
print("wrote", out)
