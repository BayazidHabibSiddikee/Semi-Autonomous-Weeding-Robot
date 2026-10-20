import FreeCAD, Mesh, os
REPO = "/run/media/bayazid/5f064a08-e294-4745-9a41-3920c208ef17/home/sword/Documents/projects/weed-laser-robot"
doc = FreeCAD.openDocument(f"{REPO}/weed_robot_chassis.FCStd")
objs = [o for o in doc.Objects if hasattr(o, "Shape") and not o.Shape.isNull()]
print("objects with shape:", len(objs))
Mesh.export(objs, "/tmp/rover_field.stl")
bb = objs[0].Shape.BoundBox
for o in objs:
    bb.add(o.Shape.BoundBox)
print("stl size:", os.path.getsize("/tmp/rover_field.stl"))
print("bounds X", round(bb.XLength,3), "Y", round(bb.YLength,3), "Z", round(bb.ZLength,3))
FreeCAD.closeDocument(doc.Name)
