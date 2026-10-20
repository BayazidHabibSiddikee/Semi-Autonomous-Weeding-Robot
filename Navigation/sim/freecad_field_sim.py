#!/usr/bin/env python3
"""
FreeCAD field simulation: the real field (from the phone photo) + the rover
+ the boustrophedon coverage path, animated.

Can be run three ways:

  1. inside FreeCAD's GUI through the FreeCAD MCP server:

         import sys
         sys.path.append("<repo>/Navigation/sim")
         import freecad_field_sim as sim
         sim.build_scene_and_animate()

  2. headless (geometry only, no rendering):

         FreeCAD.AppImage --console freecad_field_sim.py

  3. as a plain script inside FreeCAD's Python console.

The scene is built from the real data:
  * row count / spacing from the detected crop rows (field_analyzer_reference)
  * rover from the FreeCAD model in the repo (weed_robot_chassis.FCStd)
  * coverage path = the boustrophedon plan the Pi generates
"""

import math
import os
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(REPO, "Navigation", "src"))

FIELD_WIDTH_M = 6.0     # across the rows
FIELD_LENGTH_M = 8.0    # along the rows
N_ROWS = 9
ROW_SPACING_M = FIELD_WIDTH_M / N_ROWS
PLANT_SPACING_M = 0.35
# The rover (0.33 m long, 0.20 m wide) is much narrower than the crop rows
# are tall, so it drives in the LANES between the rows - that is also where
# the weeds grow. Lanes sit half a row spacing away from the plant centres.
LANE_OFFSET_M = ROW_SPACING_M / 2.0
WEED_RADIUS_M = 0.022   # small grass-like tufts
WEEDS_PER_LANE = 14
FRAME_COUNT = 90
OUT_DIR = "/tmp/freecad_sim_frames"


# --------------------------------------------------------------------------
# scene construction
# --------------------------------------------------------------------------

def _soil_material():
    import FreeCAD as App
    mat = App.Material()
    mat.DiffuseColor = (0.55, 0.42, 0.28)
    mat.AmbientColor = (0.35, 0.28, 0.20)
    return mat


def _leaf_material():
    import FreeCAD as App
    mat = App.Material()
    mat.DiffuseColor = (0.12, 0.45, 0.15)
    mat.AmbientColor = (0.08, 0.30, 0.10)
    return mat


def _chassis_material():
    import FreeCAD as App
    mat = App.Material()
    mat.DiffuseColor = (0.15, 0.30, 0.75)
    mat.AmbientColor = (0.10, 0.20, 0.55)
    return mat


def _laser_material():
    import FreeCAD as App
    mat = App.Material()
    mat.DiffuseColor = (0.9, 0.1, 0.1)
    mat.AmbientColor = (0.6, 0.05, 0.05)
    return mat


def build_field(doc):
    """Soil plane + crop rows with plants, matching the real field."""
    import FreeCAD as App

    soil = doc.addObject("Part::Box", "Soil")
    soil.Length = FIELD_LENGTH_M
    soil.Width = FIELD_WIDTH_M
    soil.Height = 0.05
    soil.Placement = App.Placement(
        App.Vector(-FIELD_LENGTH_M / 2, -FIELD_WIDTH_M / 2, -0.025),
        App.Rotation(),
    )
    soil.ViewObject.ShapeColor = (0.62, 0.47, 0.30)

    plants = []
    for r in range(N_ROWS):
        y = -FIELD_WIDTH_M / 2 + (r + 0.5) * ROW_SPACING_M
        x = -FIELD_LENGTH_M / 2 + PLANT_SPACING_M
        idx = 0
        while x < FIELD_LENGTH_M / 2 - PLANT_SPACING_M / 2:
            plant = doc.addObject("Part::Sphere", f"Plant_{r}_{idx}")
            plant.Radius = 0.085
            plant.Placement = App.Placement(
                App.Vector(x, y, 0.085), App.Rotation(App.Vector(0, 0, 1), idx * 37)
            )
            plant.ViewObject.ShapeColor = (0.13, 0.5, 0.16)
            plants.append(plant)
            idx += 1
            x += PLANT_SPACING_M
    doc.recompute()
    return soil, plants


def build_weeds(doc, per_lane=WEEDS_PER_LANE):
    """
    Weeds to be eliminated: small grass-like tufts growing in the lanes
    between the crop rows (exactly where the rover drives).
    """
    import FreeCAD as App
    import random

    rng = random.Random(7)
    weeds = []
    lanes = lane_positions()
    for li, y in enumerate(lanes):
        for w in range(per_lane):
            x = -FIELD_LENGTH_M / 2 + 0.25 + (FIELD_LENGTH_M - 0.5) * (
                (w + rng.uniform(0.15, 0.85)) / per_lane
            )
            wy = y + rng.uniform(-0.16, 0.16)
            if not (-FIELD_WIDTH_M / 2 + 0.05 < wy < FIELD_WIDTH_M / 2 - 0.05):
                continue
            weed = doc.addObject("Part::Sphere", f"Weed_{li}_{w}")
            weed.Radius = WEED_RADIUS_M
            weed.Placement = App.Placement(
                App.Vector(x, wy, WEED_RADIUS_M),
                App.Rotation(),
            )
            weed.ViewObject.ShapeColor = (0.95, 0.35, 0.05)
            weeds.append(weed)
    doc.recompute()
    return weeds


def find_rover_model():
    """Locate the real FreeCAD rover model (the one designed in the repo)."""
    candidates = [
        os.path.join(REPO, "weed_robot_chassis.FCStd"),
        os.path.join(
            "/run/media/bayazid/5f064a08-e294-4745-9a41-3920c208ef17",
            "home/sword/Documents/projects/weed-laser-robot/weed_robot_chassis.FCStd",
        ),
    ]
    for path in candidates:
        if os.path.isfile(path):
            return path
    return None


def build_rover(doc):
    """
    Rover: the real FreeCAD chassis model (weed_robot_chassis.FCStd),
    scaled from millimetres to metres and placed on the field.

    Returns (container, wheel_objects, scaled_shapes) - the wheel objects are
    used to spin the wheels while the rover drives.
    """
    import FreeCAD as App

    model_path = find_rover_model()
    if model_path is None:
        print("[sim] real rover model not found - falling back to primitives")
        return build_rover_primitives(doc)

    src = App.openDocument(model_path)
    scale = 0.001  # millimetres -> metres

    container = doc.addObject("App::Part", "Rover")
    container.Label = "Rover (real CAD model)"

    wheels = []
    wheel_shapes = {}
    for obj in src.Objects:
        if obj.TypeId != "Part::Feature":
            continue
        try:
            shape = obj.Shape
        except Exception:
            continue
        if shape.isNull():
            continue

        copied = doc.copyObject(obj, True)
        matrix = App.Matrix()
        matrix.scale(scale)
        copied.Shape = shape.transformGeometry(matrix)
        copied.Visibility = True
        container.addObject(copied)

        if obj.Name.startswith(("Wheel_Tire", "Wheel_Rim")):
            wheels.append(copied)
            wheel_shapes[copied.Name] = copied.Shape.copy()

    App.closeDocument(src.Name)
    doc.recompute()
    return container, wheels, wheel_shapes


def build_rover_primitives(doc):
    """Fallback rover (chassis + 4 wheels + camera mast + laser arm)."""
    import FreeCAD as App

    root = doc.addObject("App::Part", "Rover")
    root.Label = "Rover (primitive fallback)"

    chassis = doc.addObject("Part::Box", "Chassis")
    chassis.Length = 0.6
    chassis.Width = 0.4
    chassis.Height = 0.12
    chassis.ViewObject.ShapeColor = (0.15, 0.30, 0.75)
    root.addObject(chassis)

    wheels = []
    for i, (wx, wy) in enumerate([(0.20, 0.24), (0.20, -0.24),
                                   (-0.20, 0.24), (-0.20, -0.24)]):
        wheel = doc.addObject("Part::Cylinder", f"Wheel_{i}")
        wheel.Radius = 0.08
        wheel.Height = 0.05
        wheel.Placement = App.Placement(
            App.Vector(wx, wy, 0.08), App.Rotation(App.Vector(1, 0, 0), 90)
        )
        wheel.ViewObject.ShapeColor = (0.12, 0.12, 0.12)
        root.addObject(wheel)
        wheels.append(wheel)

    doc.recompute()
    return root, wheels, {}


def lane_positions():
    """Y positions of the driving lanes (between the crop rows)."""
    return [
        -FIELD_WIDTH_M / 2 + (r + 1) * ROW_SPACING_M
        for r in range(N_ROWS)
        if -FIELD_WIDTH_M / 2 + (r + 1) * ROW_SPACING_M < FIELD_WIDTH_M / 2 - 0.25
    ]


def build_path(doc):
    """The boustrophedon coverage path as a polyline."""
    import FreeCAD as App
    import Part

    points = []
    lanes = lane_positions()
    for r, y in enumerate(lanes):
        if r % 2 == 0:
            points += [
                App.Vector(-FIELD_LENGTH_M / 2 + 0.2, y, 0.30),
                App.Vector(FIELD_LENGTH_M / 2 - 0.2, y, 0.30),
            ]
        else:
            points += [
                App.Vector(FIELD_LENGTH_M / 2 - 0.2, y, 0.30),
                App.Vector(-FIELD_LENGTH_M / 2 + 0.2, y, 0.30),
            ]

    wire = Part.makePolygon(points)
    obj = doc.addObject("Part::Feature", "CoveragePath")
    obj.Shape = wire
    obj.ViewObject.LineColor = (1.0, 0.15, 0.1)
    obj.ViewObject.LineWidth = 4.0
    doc.recompute()
    return obj, points


def build_scene(doc_name="WeedingFieldSim"):
    """Create the whole document and return the interesting objects."""
    import FreeCAD as App

    if doc_name in App.listDocuments():
        App.closeDocument(doc_name)
    doc = App.newDocument(doc_name)
    soil, plants = build_field(doc)
    weeds = build_weeds(doc)
    rover, wheels, wheel_shapes = build_rover(doc)
    path, points = build_path(doc)
    doc.recompute()
    return {
        "doc": doc,
        "soil": soil,
        "plants": plants,
        "weeds": weeds,
        "rover": rover,
        "wheels": wheels,
        "wheel_shapes": wheel_shapes,
        "path": path,
        "points": points,
    }


# --------------------------------------------------------------------------
# animation
# --------------------------------------------------------------------------

def path_poses(points, total_length_m=None):
    """Sample the path into (x, y, heading_deg) poses, one per segment."""
    poses = []
    for a, b in zip(points, points[1:]):
        dx = b.x - a.x
        dy = b.y - a.y
        length = math.hypot(dx, dy)
        if length < 1e-6:
            continue
        heading = math.degrees(math.atan2(dy, dx))
        poses.append((a.x, a.y, heading, length))
    return poses


def animate(scene, frames=FRAME_COUNT, out_dir=OUT_DIR, laser_range=0.30):
    """
    Move the rover along the coverage path, firing the laser at every weed it
    passes, saving one screenshot per frame.

    Requires the FreeCAD GUI (screenshots); returns (image_paths, stats).
    """
    import os
    import FreeCAD as App
    import FreeCADGui as Gui

    os.makedirs(out_dir, exist_ok=True)
    try:
        import FreeCADGui as Gui
        Gui.ActiveDocument.ActiveView.setCameraType("Orthographic")
        Gui.SendMsgToActiveView("ViewTop")
        Gui.ActiveDocument.ActiveView.fitAll()
    except Exception:
        pass
    poses = path_poses(scene["points"])
    if not poses:
        return [], {"killed": 0}

    total_len = sum(p[3] for p in poses)
    step = total_len / max(frames - 1, 1)

    rover = scene["rover"]
    doc = scene["doc"]
    weeds = list(scene.get("weeds", []))
    written = []
    killed = 0
    travelled = 0.0
    pose_i = 0
    pose_pos = 0.0

    # laser beam helper (a thin red cylinder from the nozzle to the target)
    beam = doc.addObject("Part::Cylinder", "LaserBeam")
    beam.Radius = 0.008
    beam.Height = 1.0
    beam.ViewObject.ShapeColor = (1.0, 0.05, 0.05)
    beam.Visibility = False

    for f in range(frames):
        # advance along the path
        while pose_i < len(poses) - 1 and travelled > pose_pos + poses[pose_i][3]:
            pose_pos += poses[pose_i][3]
            pose_i += 1
        x, y, heading, seg_len = poses[pose_i]
        nxt = poses[min(pose_i + 1, len(poses) - 1)]
        frac = min(max((travelled - pose_pos) / max(seg_len, 1e-6), 0.0), 1.0)
        nx = x + (nxt[0] - x) * frac
        ny = y + (nxt[1] - y) * frac
        nheading = nxt[2]

        rover.Placement = App.Placement(
            App.Vector(nx, ny, 0.0),
            App.Rotation(App.Vector(0, 0, 1), nheading),
        )

        # spin the wheels according to the distance travelled
        wheel_angle = -travelled / 0.035  # wheel radius 35 mm
        for wheel in scene.get("wheels", []):
            base = scene.get("wheel_shapes", {}).get(wheel.Name)
            if base is None:
                continue
            try:
                centre = base.BoundBox.Center
                spun = base.copy().rotate(centre, App.Vector(0, 1, 0), wheel_angle)
                wheel.Shape = spun
            except Exception:
                pass

        # fire at any weed within range
        target = None
        for weed in weeds:
            if not weed.Visibility:
                continue
            wx = weed.Placement.Base.x
            wy = weed.Placement.Base.y
            if math.hypot(wx - nx, wy - ny) < laser_range:
                target = (wx, wy, weed)
                break

        if target is not None:
            wx, wy, weed = target
            start = App.Vector(nx - 0.28, ny, 0.24)
            end = App.Vector(wx, wy, 0.10)
            d = end.sub(start)
            length = d.Length
            mid = App.Vector((start.x + end.x) / 2, (start.y + end.y) / 2, (start.z + end.z) / 2)
            beam.Height = max(length, 0.01)
            beam.Placement = App.Placement(
                mid,
                App.Rotation(App.Vector(0, 0, 1), 0).multiply(
                    App.Rotation(App.Vector(0, 1, 0), 90)
                ),
            )
            beam.Visibility = True
            doc.recompute()
            weed.Visibility = False
            killed += 1
        else:
            beam.Visibility = False

        doc.recompute()

        path = os.path.join(out_dir, f"frame_{f:04d}.png")
        try:
            Gui.ActiveDocument.ActiveView.saveImage(path, 1280, 800, "White")
            written.append(path)
        except Exception as exc:  # pragma: no cover
            App.Console.PrintWarning(f"frame {f} not saved: {exc}\n")
        travelled += step

    return written, {"killed": killed, "weeds": len(weeds), "frames": len(written)}


def build_scene_and_animate(frames=FRAME_COUNT, out_dir=OUT_DIR):
    scene = build_scene()
    files, stats = animate(scene, frames=frames, out_dir=out_dir)
    return {
        "objects": len(scene["plants"]) + len(scene.get("weeds", [])) + 5,
        "frames": len(files),
        "dir": out_dir,
        **stats,
    }


if __name__ == "__main__":
    # headless mode: build the scene and save the document
    import FreeCAD as App

    scene = build_scene()
    out = os.path.join(REPO, "Navigation", "sim", "weeding_field_sim.FCStd")
    scene["doc"].saveAs(out)
    print("saved", out)
    print("plants:", len(scene["plants"]), "path points:", len(scene["points"]))
