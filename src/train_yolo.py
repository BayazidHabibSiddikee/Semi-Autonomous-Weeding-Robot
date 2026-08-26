"""
Train YOLOv8 for weed detection with bounding boxes.
Usage: python src/train_yolo.py --data configs/weed_data.yaml
"""
import argparse
from ultralytics import YOLO

def train(data_yaml, model="yolov8n.pt", epochs=100, imgsz=640, batch=16):
    print(f"Training YOLOv8 from: {model}")

    yolo = YOLO(model)

    results = yolo.train(
        data=data_yaml,
        epochs=epochs,
        imgsz=imgsz,
        batch=batch,
        name="weed_detector",
        patience=20,
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

    print(f"\nTraining complete. Results saved to: runs/detect/weed_detector/")

    # Export to NCNN for Raspberry Pi
    print("Exporting to NCNN format...")
    yolo.export(format="ncnn")
    print("NCNN export complete.")

    return results

def validate(data_yaml, model_path="runs/detect/weed_detector/weights/best.pt"):
    print(f"Validating model: {model_path}")
    yolo = YOLO(model_path)
    results = yolo.val(data=data_yaml)
    print(f"mAP50: {results.box.map50:.4f}")
    print(f"mAP50-95: {results.box.map:.4f}")
    return results

def predict(model_path, source, conf=0.25):
    yolo = YOLO(model_path)
    results = yolo.predict(source, conf=conf, save=True)
    for r in results:
        for box in r.boxes:
            cls = r.names[int(box.cls)]
            conf = float(box.conf)
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            print(f"  {cls}: {conf:.2f} at [{x1:.0f},{y1:.0f},{x2:.0f},{y2:.0f}]")
    return results

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=str, default="configs/weed_data.yaml")
    parser.add_argument("--model", type=str, default="yolov8n.pt")
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument("--mode", type=str, default="train", choices=["train", "val", "predict"])
    parser.add_argument("--source", type=str, default=None)
    args = parser.parse_args()

    if args.mode == "train":
        train(args.data, args.model, args.epochs)
    elif args.mode == "val":
        validate(args.data)
    elif args.mode == "predict":
        predict("runs/detect/weed_detector/weights/best.pt", args.source)
