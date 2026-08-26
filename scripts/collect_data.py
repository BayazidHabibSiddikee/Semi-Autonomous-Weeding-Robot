"""
Collect training images from USB camera.
Saves frames with keyboard shortcuts.
Usage: python scripts/collect_data.py --output data/train --class weed_grass
"""
import cv2
import os
import time
import argparse
from datetime import datetime

def collect(output_dir, class_name, camera_id=0, interval=0):
    save_dir = os.path.join(output_dir, class_name)
    os.makedirs(save_dir, exist_ok=True)

    cap = cv2.VideoCapture(camera_id)
    if not not cap.isOpened():
        print("Cannot open camera")
        return

    print(f"Collecting images for: {class_name}")
    print(f"  Save directory: {save_dir}")
    print(f"  Press SPACE to capture, 'a' for auto-capture, 'q' to quit\n")

    auto_mode = False
    count = len([f for f in os.listdir(save_dir) if f.endswith('.jpg')])

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        # Show info
        info = f"Class: {class_name} | Count: {count} | "
        info += "AUTO" if auto_mode else "MANUAL"
        cv2.putText(frame, info, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
        cv2.imshow("Collect Training Data", frame)

        key = cv2.waitKey(1) & 0xFF

        if key == ord('q'):
            break
        elif key == ord(' '):
            filename = f"{class_name}_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}.jpg"
            cv2.imwrite(os.path.join(save_dir, filename), frame)
            count += 1
            print(f"  Captured: {filename} (total: {count})")
        elif key == ord('a'):
            auto_mode = not auto_mode
            print(f"  Auto mode: {'ON' if auto_mode else 'OFF'}")

        if auto_mode and interval > 0:
            time.sleep(interval)
            filename = f"{class_name}_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}.jpg"
            cv2.imwrite(os.path.join(save_dir, filename), frame)
            count += 1
            print(f"  Auto-captured: {filename} (total: {count})")

    cap.release()
    cv2.destroyAllWindows()
    print(f"\nCollected {count} images for {class_name}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=str, default="data/train")
    parser.add_argument("--class", dest="class_name", type=str, required=True,
                       help="Class name (e.g., weed_grass, crop_tomato)")
    parser.add_argument("--camera", type=int, default=0)
    parser.add_argument("--interval", type=float, default=0.5,
                       help="Auto-capture interval in seconds")
    args = parser.parse_args()
    collect(args.output, args.class_name, args.camera, args.interval)
