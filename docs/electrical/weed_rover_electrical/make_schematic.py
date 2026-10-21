#!/usr/bin/env python3
"""Generate weed_rover_electrical.kicad_sch — block-style KiCad 9 schematic.

KiCad geometry facts used here:
- lib symbol coords: +y = screen UP; instance maps (px,py) -> sheet (cx+px, cy-py)
- pin (at x y rot) = the CONNECT (outer) point; rot = direction from the
  connect point into the symbol body (0=+x, 90=+y(up), 180=-x, 270=-y(down))
- everything snapped to the 1.27 mm connection grid

v2: every pin is wired *physically*. A cell-grid router (1.27 mm cells)
connects all pins of a net with orthogonal wires routed around the symbol
bodies, the label text bands and the title block; branch points get KiCad
junction dots. Net labels stay at the pin stubs, so the file stays ERC-correct
even if a route falls back to label-only.
"""
import uuid
from collections import deque

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
    dict(ref="U1", val="Raspberry Pi 5", pos=(170, 120), w=64, pins=[
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
        ("PWM_YAW",   "out", "l"), ("PWM_SH", "out", "l"),
        ("PWM_EL",    "out", "l"),
        ("BAT_ADC",   "x", "r"), ("MTR_ERR", "x", "r"),
    ], descr="Real-time wheel loop + safety gating + 3-DOF arm PWM"),

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
        ("M_L_A", "in", "l"), ("M_L_B", "in", "l"),
        ("M_R_A", "in", "l"), ("M_R_B", "in", "l"),
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

    dict(ref="U15", val="UBEC 6V 10A", pos=(160, 282), w=32, pins=[
        ("+12VL", "x", "l"), ("GND", "p", "l"),
        ("+6VS",  "P", "r"), ("GND", "p", "r"),
    ], descr="Dedicated servo rail - keeps browns off the Pi"),

    dict(ref="U12", val="Servo yaw MG996R", pos=(230, 252), w=30, pins=[
        ("PWM_YAW", "in", "l"), ("+6VS", "x", "l"), ("GND", "p", "l"),
    ], descr="Turret yaw at the arm base"),

    dict(ref="U13", val="Servo shoulder DS3218", pos=(288, 252), w=30, pins=[
        ("PWM_SH", "in", "l"), ("+6VS", "x", "l"), ("GND", "p", "l"),
    ], descr="Shoulder pitch, 20 kg-cm"),

    dict(ref="U14", val="Servo elbow DS3218", pos=(346, 252), w=30, pins=[
        ("PWM_EL", "in", "l"), ("+6VS", "x", "l"), ("GND", "p", "l"),
    ], descr="Elbow pitch + laser head at the tip"),
]


def geom(c):
    pins = c["pins"]
    by_edge = {}
    for i, (net, tty, edge) in enumerate(pins):
        by_edge.setdefault(edge, []).append(i)
    n = max(len(v) for v in by_edge.values())
    h = (n - 1) * PITCH + 5.08
    w = round(c["w"] / PITCH) * PITCH   # multiple of 2.54 so half-width is on grid
    x0, y0 = -w / 2, -h / 2
    x1, y1 = w / 2, h / 2
    edge_pos = {}
    for edge, idxs in by_edge.items():
        m = len(idxs)
        for k, i in enumerate(idxs):
            edge_pos[i] = ((m - 1) * PITCH / 2 - k * PITCH)
    return x0, y0, x1, y1, edge_pos


# ---------------------------------------------------------------- geometry map
# sheet coords: y grows DOWN; multiples of 1.27 everywhere
CELL = GRID
NX, NY = int(420 / CELL), int(297 / CELL)

def cell(x, y):          # mm -> cell index
    return (int(round(x / CELL)), int(round(y / CELL)))

def mm(cpt):             # cell index -> mm
    return (cpt[0] * CELL, cpt[1] * CELL)

pinsheet = []            # dicts: net/type/ref/pos/stub/dx
bodies = []              # (x0,y0,x1,y1) sheet mm, symbol bodies

for c in COMPONENTS:
    x0, y0, x1, y1, edge_pos = geom(c)
    cx, cy = g(c["pos"][0]), g(c["pos"][1])
    bodies.append((cx + x0, cy - y1, cx + x1, cy - y0))   # y flips
    for i, (net, tty, edge) in enumerate(c["pins"]):
        py = edge_pos[i]
        xe = x0 if edge == "l" else x1
        ox, oy = cx + xe, cy - py
        dx = -1 if edge == "l" else 1
        pinsheet.append(dict(ref=c["ref"], net=net, tty=tty, edge=edge,
                             i=i, pin=(ox, oy), stub=(ox + dx * STUB, oy), dx=dx))

# ---------------------------------------------------------------- router grid
FREE, BODY, USED = 0, -1, 1          # grid[r][c]: 0 free, -1 blocked, n>0 net id
grid = [[0] * NX for _ in range(NY)]

def mark_rect(x0, yy0, x1, yy1, val, pad=0):
    c0, r0 = cell(x0 - pad, yy0 - pad)
    c1, r1 = cell(x1 + pad, yy1 + pad)
    for r in range(max(0, r0), min(NY, r1 + 1)):
        for cc in range(max(0, c0), min(NX, c1 + 1)):
            grid[r][cc] = val

for (x0, yy0, x1, yy1) in bodies:
    mark_rect(x0, yy0, x1, yy1, BODY, pad=CELL)       # 1-cell margin around boxes
mark_rect(272, 262, 420, 297, BODY)                   # title block
mark_rect(0, 0, 14, 297, BODY)                        # sheet frame
mark_rect(0, 0, 420, 14, BODY)
mark_rect(406, 0, 420, 297, BODY)
mark_rect(0, 288, 420, 297, BODY)

# label text bands: cells strictly outward of the stub end, on the stub row
for p in pinsheet:
    sx, sy = p["stub"]
    ccell = cell(sx, sy)
    for k in range(1, 6):                              # names up to ~5 chars wide
        far = (ccell[0] - k) if p["dx"] < 0 else (ccell[0] + k)
        if 0 <= far < NX and p["dx"] * (far - ccell[0]) > 0:
            grid[ccell[1]][far] = BODY                  # stub row only

# claim every stub wire (stub end + the cell between stub end and pin) so
# no route ever crosses another net's stub; overwritten over the body pad
# cells the stub legitimately occupies
nidx = {}
for k, net in enumerate(sorted({p["net"] for p in pinsheet}), start=1):
    nidx[net] = k
for p in pinsheet:
    s0 = cell(*p["stub"])
    s1 = (s0[0] - p["dx"], s0[1])
    grid[s0[1]][s0[0]] = nidx[p["net"]]
    grid[s1[1]][s1[0]] = nidx[p["net"]]

def net_stub_cells():
    d = {}
    for p in pinsheet:
        d.setdefault(p["net"], []).append(cell(*p["stub"]))
    return d

STUBC = net_stub_cells()

def bfs(start, is_goal, netid):
    """4-neighbour BFS on the cell grid. First step out of a stub is
    vertical (keeps wires off the label text). Returns cell path or None."""
    sx, sy = start
    seen = {start: None}
    q = deque()
    for dstep in ((0, -1), (0, 1)):                    # vertical exit only
        n = (sx, sy + dstep[1])
        if 0 <= n[1] < NY and 0 <= n[0] < NX and grid[n[1]][n[0]] in (FREE,):
            seen[n] = start
            q.append(n)
    while q:
        cur = q.popleft()
        if is_goal(cur):
            path = []
            while cur is not None:
                path.append(cur)
                cur = seen[cur]
            return path[::-1]
        for dstep in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            n = (cur[0] + dstep[0], cur[1] + dstep[1])
            if not (0 <= n[0] < NX and 0 <= n[1] < NY):
                continue
            if n in seen:
                continue
            v = grid[n[1]][n[0]]
            if v == BODY:
                continue
            if v not in (FREE, netid):
                continue
            seen[n] = cur
            q.append(n)
    return None

def claim(path, netid):
    for cpt in path:
        r, cc = cpt[1], cpt[0]
        grid[r][cc] = netid          # overwrite: stub cells sit on the body pad

def run_cells_to_segments(cells):
    """Union of cells -> minimal orthogonal wire segments (set of point runs)."""
    cset = set(cells)
    segs = []
    # horizontal runs
    for (cxp, cyp) in sorted(cset):
        if (cxp - 1, cyp) in cset:
            continue                                    # not a run start
        cxp2 = cxp
        while (cxp2 + 1, cyp) in cset:
            cxp2 += 1
        if cxp2 > cxp:
            segs.append(((cxp, cyp), (cxp2, cyp)))
    # vertical runs
    for (cxp, cyp) in sorted(cset):
        if (cxp, cyp - 1) in cset:
            continue
        cyp2 = cyp
        while (cxp, cyp2 + 1) in cset:
            cyp2 += 1
        if cyp2 > cyp:
            segs.append(((cxp, cyp), (cxp, cyp2)))
    return segs

# ---------------------------------------------------------------- route nets
netid_of = {}
for k, net in enumerate(sorted(STUBC), start=1):
    netid_of[net] = k

ordered = sorted(STUBC.items(), key=lambda kv: (len(kv[1]), kv[0]))
wires = {}          # net -> {segment in cell coords}
trees = {}          # net -> set of routed cells (wires only)
failed = []
for net, stubs in ordered:
    nid = netid_of[net]
    tree = set()
    segs_cells = []
    # start from all stub ends; connect them one by one into a growing tree
    todo = list(stubs)
    tree.add(todo.pop(0))
    guard = 0
    while todo and guard < 200:
        guard += 1
        # source pin = stub nearest (in cell dist) to the current tree
        best = min(todo, key=lambda s: min(abs(s[0] - t[0]) + abs(s[1] - t[1])
                                           for t in tree))
        path = bfs(best, lambda cpt, tr=tree: cpt in tr, nid)
        if path is None:
            # try any other remaining stub as source (flexibility)
            done = False
            for alt in todo:
                if alt == best:
                    continue
                p2 = bfs(alt, lambda cpt, tr=tree: cpt in tr, nid)
                if p2 is not None:
                    path, best = p2, alt
                    done = True
                    break
            if not done:
                failed.append(net)
                break
        tree.update(path)
        claim(path, nid)          # block these cells for every other net
        segs_cells.extend(path)
        todo.remove(best)
        # did the path step over another stub of the same net? merge it
        for s in list(todo):
            if s in tree:
                todo.remove(s)
    if not todo:
        wires[net] = run_cells_to_segments(tree)
        trees[net] = tree
    # NOTE: failed nets stay label-connected (labels at every stub)

# junctions: a wire point where 3+ wire directions meet (T/X branch).
# Degree is computed on the routed cells plus each stub end + the first
# stub-line cell toward the pin (so stub corners don't need a dot but
# true branches do).
stubline = {}       # net -> {stub end cell, ...}
for p in pinsheet:
    sc = cell(*p["stub"])
    stubline.setdefault(p["net"], set()).add((sc[0] - p["dx"], sc[1]))

junction_cells = set()
for net, tree in trees.items():
    cells = tree | stubline.get(net, set())
    for (cxp, cyp) in cells:
        deg = sum(((cxp + 1, cyp) in cells, (cxp - 1, cyp) in cells,
                   (cxp, cyp + 1) in cells, (cxp, cyp - 1) in cells))
        if deg >= 3:
            junction_cells.add((cxp, cyp))

# ---------------------------------------------------------------- emit
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

# stub wires + labels at every pin
for p in pinsheet:
    ox, oy = p["pin"]
    ex, ey = p["stub"]
    dx = p["dx"]
    just = "right bottom" if p["edge"] == "l" else "left bottom"
    A(f'  (wire (pts (xy {ox:.3f} {oy:.3f}) (xy {ex:.3f} {ey:.3f})) (stroke (width 0) (type solid)) (uuid "{U()}"))')
    A(f'  (label "{p["net"]}" (at {ex:.3f} {ey:.3f} 0) (effects (font (size 1.27 1.27)) (justify {just})) (uuid "{U()}"))')

# routed wires
nseg = 0
for net in sorted(wires):
    for (a, b) in wires[net]:
        (ax, ay), (bx, by) = mm(a), mm(b)
        if (ax, ay) == (bx, by):
            continue
        A(f'  (wire (pts (xy {ax:.3f} {ay:.3f}) (xy {bx:.3f} {by:.3f})) (stroke (width 0) (type solid)) (uuid "{U()}"))')
        nseg += 1

# junctions where 3+ wire directions meet
for cpt in sorted(junction_cells):
    jx, jy = mm(cpt)
    A(f'  (junction (at {jx:.3f} {jy:.3f}) (diameter 0) (color 0 0 0 0) (uuid "{U()}"))')

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

A('  (sheet_instances (path "/" (page "1")))')
A('  (embedded_fonts no)')
A(")")

OUT = "/run/media/bayazid/5f064a08-e294-4745-9a41-3920c208ef17/home/sword/Documents/projects/weed-laser-robot/docs/electrical/weed_rover_electrical/weed_rover_electrical.kicad_sch"
open(OUT, "w").write("\n".join(L) + "\n")
print("wrote", OUT)
print(f"nets routed: {len(wires)}/{len(ordered)}   wire segments: {nseg}")
print("label-only fallback nets:", sorted(set(failed)) or "none")
