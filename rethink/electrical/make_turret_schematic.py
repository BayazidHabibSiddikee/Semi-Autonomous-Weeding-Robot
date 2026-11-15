#!/usr/bin/env python3
"""
Generate weeding_turret_electrical.kicad_sch
KiCad schematic generator for the Complete Weeding Turret & Rover Circuit Architecture.

Features:
- ESP32 central MCU with dedicated peripheral groups
- 4WD base drive via L298N Dual H-Bridge (parallel motor pairs)
- HC-SR04 ultrasonic obstacle sensor with 5V->3.3V resistor divider
- Dual servo actuation (Top 180° cylinder rotation servo + MG996R gas valve servo)
- Heatsinked LM7805CV linear regulator with input/output filtering for servos
- 2-Channel Optocoupler Relay with isolated JD-VCC power domain
- High-Voltage Electric Arc Ignitor Module with 1N4007 flyback suppression
- Mini Grinding Motor (12V) with 1N4007 diode and 0.1uF RF snubbing
- L298N onboard 5V logic rail with 1000uF bulk reservoir capacitor
- Full electrical isolation between 10kV arc ignition spikes and digital logic
"""

import os
import sys
import uuid
import subprocess

ROOT = str(uuid.uuid4())
GRID = 1.27
STUB = 2.54
PITCH = 2.54

TYPE = {
    "p": "power_in",
    "P": "power_out",
    "x": "passive",
    "io": "bidirectional",
    "in": "input",
    "out": "output"
}

def g(v):
    return round(v / GRID) * GRID

def U():
    return str(uuid.uuid4())

COMPONENTS = [
    # Power Source & Protection
    dict(ref="BT1", val="3S LiPo 11.1V-12.6V", pos=(35, 45), w=36, pins=[
        ("+12V_BAT", "P", "r"), ("GND", "P", "r")
    ], descr="Main Battery Pack 3S LiPo"),

    dict(ref="SW1", val="Main Toggle Switch", pos=(80, 45), w=26, pins=[
        ("+12V_BAT", "x", "l"), ("+12V_SW", "x", "r")
    ], descr="System Main Power Switch"),

    dict(ref="F1", val="15A Blade Fuse", pos=(120, 45), w=24, pins=[
        ("+12V_SW", "x", "l"), ("+12V_MAIN", "x", "r")
    ], descr="Overcurrent Protection Fuse"),

    # Microcontroller & Decoupling
    dict(ref="C5", val="1000uF 25V Low-ESR", pos=(175, 45), w=28, pins=[
        ("+5V_LOGIC", "x", "l"), ("GND", "x", "r")
    ], descr="ESP32 VIN Voltage Stabilizer Capacitor"),

    dict(ref="U1", val="ESP32 NodeMCU DevKit", pos=(210, 115), w=56, pins=[
        ("+5V_LOGIC", "p", "l"), ("GND", "p", "l"),
        ("TRIG", "out", "l"), ("ECHO_3V3", "in", "l"),
        ("PWM_CYL", "out", "r"), ("PWM_GAS", "out", "r"),
        ("RELAY_ARC", "out", "r"), ("RELAY_GRD", "out", "r"),
        ("ENA", "out", "r"), ("IN1", "out", "r"), ("IN2", "out", "r"),
        ("ENB", "out", "r"), ("IN3", "out", "r"), ("IN4", "out", "r")
    ], descr="ESP32 Microcontroller 38-pin DevKit"),

    # Group 4: Base Drive
    dict(ref="U2", val="L298N Dual H-Bridge", pos=(330, 115), w=44, pins=[
        ("+12V_MAIN", "p", "l"), ("GND", "p", "l"),
        ("ENA", "in", "l"), ("IN1", "in", "l"), ("IN2", "in", "l"),
        ("ENB", "in", "l"), ("IN3", "in", "l"), ("IN4", "in", "l"),
        ("+5V_LOGIC", "P", "r"),
        ("OUT1", "out", "r"), ("OUT2", "out", "r"),
        ("OUT3", "out", "r"), ("OUT4", "out", "r")
    ], descr="L298N Motor Driver with 5V Logic Out"),

    dict(ref="M1_M2", val="Left 2x TT Motors", pos=(395, 90), w=26, pins=[
        ("OUT1", "x", "l"), ("OUT2", "x", "l")
    ], descr="Left Side Drive Motors (Wired Parallel)"),

    dict(ref="M3_M4", val="Right 2x TT Motors", pos=(395, 140), w=26, pins=[
        ("OUT3", "x", "l"), ("OUT4", "x", "l")
    ], descr="Right Side Drive Motors (Wired Parallel)"),

    # Group 1: High-Power Switched Loads & Isolation
    dict(ref="U3", val="Isolated 5V Buck (0.5A)", pos=(45, 125), w=36, pins=[
        ("+12V_MAIN", "p", "l"), ("GND", "p", "l"),
        ("+5V_BUCK", "P", "r"), ("GND_BUCK", "P", "r")
    ], descr="Dedicated Buck Converter for Arc Module"),

    dict(ref="U4", val="2-Ch Optocoupler Relay", pos=(125, 195), w=46, pins=[
        ("+5V_LOGIC", "p", "l"), ("GND", "p", "l"),
        ("RELAY_ARC", "in", "l"), ("RELAY_GRD", "in", "l"),
        ("+5V_BUCK", "p", "r"), ("GND_BUCK", "p", "r"),
        ("+5V_BUCK", "x", "r"), ("ARC_PWR+", "x", "r"),
        ("+12V_MAIN", "x", "r"), ("GRINDER_PWR+", "x", "r")
    ], descr="2-Channel 5V Relay with Opto-Isolation (JD-VCC)"),

    dict(ref="U5", val="High-Voltage Arc Ignitor", pos=(235, 195), w=38, pins=[
        ("ARC_PWR+", "p", "l"), ("GND_BUCK", "p", "l"),
        ("HV_SPARK+", "out", "r"), ("HV_SPARK-", "out", "r")
    ], descr="10kV Electric Arc Pulse Ignitor Module"),

    dict(ref="D1", val="1N4007 Arc Snubber", pos=(190, 240), w=24, pins=[
        ("ARC_PWR+", "x", "l"), ("GND_BUCK", "x", "r")
    ], descr="Flyback Diode across Arc Module Input"),

    dict(ref="M5", val="Mini Grinding Motor (12V)", pos=(325, 195), w=34, pins=[
        ("GRINDER_PWR+", "p", "l"), ("GND", "p", "l")
    ], descr="High-RPM Mechanical Weed Cutter Motor"),

    dict(ref="D2", val="1N4007 Motor Diode", pos=(375, 195), w=22, pins=[
        ("GRINDER_PWR+", "x", "l"), ("GND", "x", "r")
    ], descr="Flyback Diode across Grinder Motor"),

    dict(ref="C1", val="0.1uF 50V Ceramic", pos=(375, 225), w=22, pins=[
        ("GRINDER_PWR+", "x", "l"), ("GND", "x", "r")
    ], descr="Brush Noise Suppression Capacitor"),

    # Group 3: Dual Servo Actuation & LM7805 Power Stage
    dict(ref="U6", val="LM7805CV + Heatsink", pos=(50, 215), w=36, pins=[
        ("+12V_MAIN", "p", "l"), ("GND", "p", "l"),
        ("+5V_SERVO", "P", "r")
    ], descr="5V 1.5A Linear Regulator for Servos"),

    dict(ref="C2", val="10uF 25V Electrolytic", pos=(20, 215), w=20, pins=[
        ("+12V_MAIN", "x", "l"), ("GND", "x", "r")
    ], descr="LM7805 Input Filter Capacitor"),

    dict(ref="C3", val="100uF 16V Electrolytic", pos=(95, 235), w=22, pins=[
        ("+5V_SERVO", "x", "l"), ("GND", "x", "r")
    ], descr="LM7805 Output Buffer Capacitor"),

    dict(ref="C4", val="0.1uF 50V Ceramic", pos=(95, 260), w=22, pins=[
        ("+5V_SERVO", "x", "l"), ("GND", "x", "r")
    ], descr="High-Frequency Decoupling Capacitor"),

    dict(ref="U7", val="Servo 180deg (Turret)", pos=(160, 275), w=36, pins=[
        ("PWM_CYL", "in", "l"), ("+5V_SERVO", "p", "l"), ("GND", "p", "l")
    ], descr="180-Degree Top Turret Rotation Servo"),

    dict(ref="U8", val="Servo MG996R (Gas)", pos=(235, 275), w=36, pins=[
        ("PWM_GAS", "in", "l"), ("+5V_SERVO", "p", "l"), ("GND", "p", "l")
    ], descr="Metal Gear Servo for Torch Gas Valve"),

    # Group 2: Front Ultrasonic Sensor
    dict(ref="U9", val="HC-SR04 Ultrasonic", pos=(310, 275), w=34, pins=[
        ("+5V_LOGIC", "p", "l"), ("GND", "p", "l"),
        ("TRIG", "in", "r"), ("ECHO", "out", "r")
    ], descr="Ultrasonic Distance Ranging Sensor"),

    dict(ref="R1_R2", val="1k / 2k Divider", pos=(375, 275), w=28, pins=[
        ("ECHO", "in", "l"), ("GND", "p", "l"),
        ("ECHO_3V3", "out", "r")
    ], descr="Resistor Divider: 5V Echo to 3.3V ESP32 GPIO")
]

def geom(c):
    w = c["w"]
    pins = c["pins"]
    nl = sum(1 for p in pins if p[2] == "l")
    nr = len(pins) - nl
    h = max(nl, nr) * PITCH + 2 * PITCH
    hw, hh = w / 2.0, h / 2.0
    x0, y0 = -hw, -hh
    x1, y1 = hw, hh
    pos = []
    il = ir = 0
    for p in pins:
        if p[2] == "l":
            pos.append(hh - PITCH - il * PITCH)
            il += 1
        else:
            pos.append(hh - PITCH - ir * PITCH)
            ir += 1
    return x0, y0, x1, y1, pos

def make_schematic(output_path):
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    
    # Calculate pin coordinates on sheet
    pinsheet = []
    for c in COMPONENTS:
        x0, y0, x1, y1, edge_pos = geom(c)
        cx, cy = g(c["pos"][0]), g(c["pos"][1])
        for i, (net, tty, edge) in enumerate(c["pins"]):
            y = edge_pos[i]
            px = cx + (x0 if edge == "l" else x1)
            py = cy - y
            dx = -STUB if edge == "l" else STUB
            sx = px + dx
            sy = py
            pinsheet.append({
                "ref": c["ref"],
                "net": net,
                "tty": tty,
                "edge": edge,
                "pin": (px, py),
                "stub": (sx, sy),
                "dx": -1 if edge == "l" else 1
            })

    L = []
    A = L.append
    A("(kicad_sch")
    A("  (version 20250114)")
    A('  (generator "eeschema")')
    A('  (generator_version "10.0")')
    A(f'  (uuid "{ROOT}")')
    A('  (paper "A3")')
    A('  (title_block (title "Autonomous Weeding Robot - Complete Turret & Base Circuit") (date "2026-11-15") (rev "2.0")')
    A('    (company "RUET Mechatronics / Autonomous Weeding Project")')
    A('    (comment 1 "Power: 3S 12V LiPo -> L298N 5V (Logic) + LM7805 (Servos) + Buck 5V (Isolated Arc)")')
    A('    (comment 2 "Actuation: L298N 4WD Motors, 180-deg Turret Servo, MG996R Gas Valve Servo")')
    A('    (comment 3 "Safety: Optical Relay Isolation for 10kV Arc Module, HC-SR04 Obstacle Braking")')
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

    # Stub wires + labels at every pin
    for p in pinsheet:
        ox, oy = p["pin"]
        ex, ey = p["stub"]
        just = "right bottom" if p["edge"] == "l" else "left bottom"
        A(f'  (wire (pts (xy {ox:.3f} {oy:.3f}) (xy {ex:.3f} {ey:.3f})) (stroke (width 0) (type solid)) (uuid "{U()}"))')
        A(f'  (label "{p["net"]}" (at {ex:.3f} {ey:.3f} 0) (effects (font (size 1.27 1.27)) (justify {just})) (uuid "{U()}"))')

    # Symbols placement
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
        A(f'    (instances (project "weeding_turret_electrical" (path "/{ROOT}" (reference "{c["ref"]}") (unit 1))))')
        A("  )")

    A('  (sheet_instances (path "/" (page "1")))')
    A('  (embedded_fonts no)')
    A(")")

    content = "\n".join(L) + "\n"
    with open(output_path, "w") as f:
        f.write(content)
    print(f"[OK] Wrote KiCad schematic: {output_path}")

def export_all(sch_path):
    sch_dir = os.path.dirname(os.path.abspath(sch_path))
    pdf_path = os.path.join(sch_dir, "weeding_turret_electrical.pdf")
    svg_dir = os.path.join(sch_dir, "svg")
    net_path = os.path.join(sch_dir, "weeding_turret.net")
    png_path = os.path.join(sch_dir, "weeding_turret_schematic.png")
    os.makedirs(svg_dir, exist_ok=True)

    # 1. Run ERC
    print("Running KiCad Electrical Rules Check (ERC)...")
    res = subprocess.run(["kicad-cli", "sch", "erc", sch_path], capture_output=True, text=True)
    print(res.stdout.strip())
    if res.stderr:
        print("ERC warnings/info:", res.stderr.strip())

    # 2. Export PDF
    print(f"Exporting PDF to {pdf_path}...")
    subprocess.run(["kicad-cli", "sch", "export", "pdf", sch_path, "-o", pdf_path], check=True)

    # 3. Export SVG
    print(f"Exporting SVG to {svg_dir}...")
    subprocess.run(["kicad-cli", "sch", "export", "svg", sch_path, "-o", svg_dir], check=True)

    # 4. Export Netlist
    print(f"Exporting Netlist to {net_path}...")
    subprocess.run(["kicad-cli", "sch", "export", "netlist", sch_path, "-o", net_path], check=True)

    # 5. Convert PDF to High-Res PNG
    print(f"Rendering high-res PNG to {png_path}...")
    subprocess.run(["pdftoppm", "-png", "-r", "200", "-singlefile", pdf_path, os.path.splitext(png_path)[0]], check=True)

    print("\n[SUCCESS] KiCad Schematic generation and all exports completed cleanly!")

if __name__ == "__main__":
    script_dir = os.path.dirname(os.path.abspath(__file__))
    sch_file = os.path.join(script_dir, "weeding_turret_electrical.kicad_sch")
    make_schematic(sch_file)
    export_all(sch_file)
