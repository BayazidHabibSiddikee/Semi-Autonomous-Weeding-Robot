#!/usr/bin/env python3
"""
FreeCAD digital twin: build the weeding field FROM THE PHONE PHOTO and drive
the real CAD rover over it.

Input:  /tmp/photo_scene.json (written by Navigation/sim/scene_spec.py)
Run:    inside FreeCAD (GUI or MCP execute_code):

    import sys
    sys.path.append("/run/media/bayazid/.../weed-laser-robot/Navigation/sim")
    import photo_scene
    result = photo_scene.build_and_animate(frames=90, out_dir="/tmp/photo_sim_frames")

Reuses freecad_field_sim for the rover model (weed_robot_chassis.FCStd) and the
animation loop; only the field geometry comes from the photo analysis instead
of procedural lane math.
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "src")
for p in (HERE, SRC):
    if p not in sys.path:
        sys.path.append(p)

DEFAULT_SPEC = "/tmp/photo_scene.json"


# --------------------------------------------------------------------------
# scene from spec
# --------------------------------------------------------------------------

def build_field_from_spec(doc, spec):
    """Soil plane + plant rows exactly where the photo put them (world Y)."""
    import FreeCAD as App

    W = spec["width_m"]
    L = spec["length_m"]
    spacing = spec.get("plant_spacing_m", 0.35)

    soil = doc.addObject("Part::Box", "Soil")
    soil.Length = L
    soil.Width = W
    soil.Height = 0.05
    soil.Placement = App.Placement(
        App.Vector(-L / 2, -W / 2, -0.025), App.Rotation(),
    )
    soil.ViewObject.ShapeColor = (0.62, 0.47, 0.30)

    plants = []
    for ri, y in enumerate(spec["row_y_m"]):
        x = -L / 2 + spacing
        idx = 0
        while x < L / 2 - spacing / 2:
            plant = doc.addObject("Part::Sphere", f"Plant_{ri}_{idx}")
            plant.Radius = 0.085
            plant.Placement = App.Placement(
                App.Vector(x, y, 0.085),
                App.Rotation(App.Vector(0, 0, 1), idx * 37),
            )
            plant.ViewObject.ShapeColor = (0.13, 0.5, 0.16)
            plants.append(plant)
            idx += 1
            x += spacing
    doc.recompute()
    return soil, plants


def build_weeds_from_spec(doc, spec):
    """Weeds at the spot the photo shows them (r=0.022 tufts, orange)."""
    import FreeCAD as App

    weeds = []
    for i, (wx, wy) in enumerate(spec.get("weeds", [])):
        weed = doc.addObject("Part::Sphere", f"Weed_{i}")
        weed.Radius = 0.022
        weed.Placement = App.Placement(App.Vector(wx, wy, 0.022), App.Rotation())
        weed.ViewObject.ShapeColor = (0.95, 0.35, 0.05)
        weeds.append(weed)
    doc.recompute()
    return weeds


def build_path_from_spec(doc, spec):
    """Boustrophedon path along the lane midpoints (between the crop rows)."""
    import FreeCAD as App
    import Part

    W = spec["width_m"]
    L = spec["length_m"]
    margin = float(spec.get("headland_m", 0.2))
    ends = L / 2.0 - margin
    points = []
    for r, y in enumerate(spec["lanes_y_m"]):
        if r % 2 == 0:
            points += [
                App.Vector(-ends, y, 0.30),
                App.Vector(ends, y, 0.30),
            ]
        else:
            points += [
                App.Vector(ends, y, 0.30),
                App.Vector(-ends, y, 0.30),
            ]

    wire = Part.makePolygon(points)
    obj = doc.addObject("Part::Feature", "CoveragePath")
    obj.Shape = wire
    obj.ViewObject.LineColor = (1.0, 0.15, 0.1)
    obj.ViewObject.LineWidth = 4.0
    doc.recompute()
    return obj, points


def build_scene_from_spec(doc_name="PhotoFieldSim", spec_path=DEFAULT_SPEC):
    """Create the photo-derived digital twin, reusing the real rover model."""
    import FreeCAD as App
    import freecad_field_sim as sim

    if not os.path.isfile(spec_path):
        raise ValueError(f"scene spec not found: run scene_spec.py first ({spec_path})")
    with open(spec_path) as fh:
        spec = json.load(fh)
    spec.setdefault("headland_m", 0.2)

    if doc_name in App.listDocuments():
        App.closeDocument(doc_name)
    doc = App.newDocument(doc_name)

    soil, plants = build_field_from_spec(doc, spec)
    weeds = build_weeds_from_spec(doc, spec)
    rover, wheels, wheel_shapes = sim.build_rover(doc)
    path, points = build_path_from_spec(doc, spec)
    doc.recompute()
    return {
        "doc": doc,
        "spec": spec,
        "soil": soil,
        "plants": plants,
        "weeds": weeds,
        "rover": rover,
        "wheels": wheels,
        "wheel_shapes": wheel_shapes,
        "path": path,
        "points": points,
    }


def build_and_animate(frames=90, out_dir="/tmp/photo_sim_frames",
                      spec_path=DEFAULT_SPEC, doc_name="PhotoFieldSim"):
    """Build the twin from the photo + run the weeding animation."""
    import freecad_field_sim as sim

    scene = build_scene_from_spec(doc_name=doc_name, spec_path=spec_path)
    files, stats = sim.animate(scene, frames=frames, out_dir=out_dir)

    doc = scene["doc"]
    out_fcstd = os.path.join(HERE, "photo_field_sim.FCStd")
    doc.saveAs(out_fcstd)

    return {
        "rows": len(scene["spec"]["row_y_m"]),
        "lanes": len(scene["spec"]["lanes_y_m"]),
        "weeds": len(scene["weeds"]),
        "killed": stats.get("killed", 0),
        "frames": len(files),
        "dir": out_dir,
        "saved": out_fcstd,
    }


if __name__ == "__main__":
    info = build_and_animate()
    print("photo digital twin:", info)
