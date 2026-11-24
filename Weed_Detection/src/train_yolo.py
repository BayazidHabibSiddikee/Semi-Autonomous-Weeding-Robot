"""
Train, validate, and export YOLO26 (or YOLOv8) for weed detection & Pi 4 NCNN deployment.

Usage:
  Train primary:  python src/train_yolo.py --model yolo26s.pt --data configs/weed_data.yaml
  Train fallback: python src/train_yolo.py --model yolo26n.pt --data configs/weed_data.yaml
  Validate:       python src/train_yolo.py --mode val --model runs/weed/yolo26s/weights/best.pt --data configs/weed_data.yaml
  Export NCNN:    python src/train_yolo.py --mode export --model runs/weed/yolo26s/weights/best.pt --half
"""
import argparse
import shutil
from pathlib import Path
from ultralytics import YOLO


def export_ncnn(model_path: str, imgsz: int = 640, half: bool = True, out_dir: str = "models/weed_detector_ncnn_model") -> Path:
    """Export a trained YOLO checkpoint to NCNN and stage it under models/."""
    print(f"Exporting {model_path} to NCNN (imgsz={imgsz}, half={half})...")
    yolo = YOLO(model_path)
    exported = Path(yolo.export(format="ncnn", imgsz=imgsz, half=half))

    target = Path(out_dir)
    if exported.resolve() != target.resolve():
        if target.exists():
            shutil.rmtree(target)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(exported, target)
    print(f"NCNN model ready at: {target}")
    return target


def train(
    data_yaml: str,
    model: str = "yolo26s.pt",
    epochs: int = 200,
    imgsz: int = 640,
    batch: int = -1,
    patience: int = 40,
    project: str = "runs/weed",
    name: str = None,
    half: bool = True,
):
    run_name = name or Path(model).stem
    print(f"Training {model} on {data_yaml} -> {project}/{run_name}")
    yolo = YOLO(model)

    results = yolo.train(
        data=data_yaml,
        epochs=epochs,
        imgsz=imgsz,
        batch=batch,
        project=project,
        name=run_name,
        patience=patience,
        augment=True,
        mosaic=1.0,
        mixup=0.1,
        copy_paste=0.1,
        degrees=10,
        translate=0.1,
        scale=0.5,
        fliplr=0.5,
        hsv_h=0.015,
        hsv_s=0.7,
        hsv_v=0.4,
    )

    best_pt = Path(project) / run_name / "weights" / "best.pt"
    print(f"\nTraining complete. Best weights: {best_pt}")
    if best_pt.exists():
        export_ncnn(str(best_pt), imgsz=imgsz, half=half)
    return results


def validate(data_yaml: str, model_path: str = "runs/weed/yolo26s/weights/best.pt", imgsz: int = 640):
    """Validate and print Recall, Precision, mAP50, mAP50-95, and per-class breakdown."""
    print(f"Validating model: {model_path} (imgsz={imgsz})")
    yolo = YOLO(model_path)
    results = yolo.val(data=data_yaml, imgsz=imgsz)

    print("\n=== Validation Metrics ===")
    print(f"  Precision (mp): {results.box.mp:.4f}")
    print(f"  Recall    (mr): {results.box.mr:.4f}")
    print(f"  mAP50:          {results.box.map50:.4f}")
    print(f"  mAP50-95:       {results.box.map:.4f}")

    if hasattr(results.box, "ap_class_index") and results.box.ap_class_index is not None:
        print("\nPer-class metrics (Precision / Recall / mAP50):")
        for i, cls_id in enumerate(results.box.ap_class_index):
            cls_name = yolo.names.get(int(cls_id), str(cls_id))
            p, r, ap50, _ = results.box.class_result(i)
            print(f"  [{int(cls_id):2d}] {cls_name:<16} P={p:.3f}  R={r:.3f}  mAP50={ap50:.3f}")

    return results


def predict(model_path: str, source: str, conf: float = 0.30, imgsz: int = 640):
    yolo = YOLO(model_path, task="detect")
    results = yolo.predict(source, conf=conf, imgsz=imgsz, save=True)
    for r in results:
        for box in r.boxes:
            cls = r.names[int(box.cls)]
            c = float(box.conf)
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            print(f"  {cls}: {c:.2f} at [{x1:.0f},{y1:.0f},{x2:.0f},{y2:.0f}]")
    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="YOLO26 Weed Detector Training & NCNN Export")
    parser.add_argument("--data", type=str, default="configs/weed_data.yaml")
    parser.add_argument("--model", type=str, default="yolo26s.pt")
    parser.add_argument("--epochs", type=int, default=200)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=-1)
    parser.add_argument("--patience", type=int, default=40)
    parser.add_argument("--project", type=str, default="runs/weed")
    parser.add_argument("--name", type=str, default=None)
    parser.add_argument("--out-dir", type=str, default="models/weed_detector_ncnn_model")
    parser.add_argument("--half", action="store_true", default=True)
    parser.add_argument("--no-half", dest="half", action="store_false")
    parser.add_argument("--conf", type=float, default=0.30)
    parser.add_argument("--mode", type=str, default="train", choices=["train", "val", "export", "predict"])
    parser.add_argument("--source", type=str, default=None)
    args = parser.parse_args()

    if args.mode == "train":
        train(args.data, args.model, args.epochs, args.imgsz, args.batch, args.patience, args.project, args.name, args.half)
    elif args.mode == "val":
        validate(args.data, args.model, args.imgsz)
    elif args.mode == "export":
        export_ncnn(args.model, imgsz=args.imgsz, half=args.half, out_dir=args.out_dir)
    elif args.mode == "predict":
        if not args.source:
            raise SystemExit("--source is required for predict mode")
        predict(args.model, args.source, conf=args.conf, imgsz=args.imgsz)
