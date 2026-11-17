
from ultralytics import YOLO
import cv2
from pathlib import Path

# ==========================================
# 1. Project paths
# ==========================================

BASE_DIR = Path(__file__).resolve().parent

# Check for model in yolo_models or current directory
if (BASE_DIR / "yolo_models" / "best.pt").exists():
    model_path = BASE_DIR / "yolo_models" / "best.pt"
elif (BASE_DIR / "best.pt").exists():
    model_path = BASE_DIR / "best.pt"
elif (BASE_DIR / "yolo_models" / "2best.pt").exists():
    model_path = BASE_DIR / "yolo_models" / "2best.pt"
else:
    model_path = BASE_DIR / "best.pt"

# Check for video in videos directory or current directory
if (BASE_DIR / "videos" / "test_video.mp4").exists():
    video_path = BASE_DIR / "videos" / "test_video.mp4"
elif (BASE_DIR / "videos" / "test_video.avi").exists():
    video_path = BASE_DIR / "videos" / "test_video.avi"
elif (BASE_DIR / "test_video.mp4").exists():
    video_path = BASE_DIR / "test_video.mp4"
elif (BASE_DIR / "test_video.avi").exists():
    video_path = BASE_DIR / "test_video.avi"
else:
    video_path = BASE_DIR / "test_video.mp4"

output_dir = BASE_DIR / "runs" / "weed_v1" / "video_test"
output_dir.mkdir(parents=True, exist_ok=True)

output_path = output_dir / "detected_video.mp4"


# ==========================================
# 2. Load trained YOLO model
# ==========================================

print("Loading YOLO model...")

model = YOLO(str(model_path))

print("Model loaded successfully!")
print("Classes:", model.names)


# ==========================================
# 3. Open input video
# ==========================================

cap = cv2.VideoCapture(str(video_path))

if not cap.isOpened():
    raise RuntimeError("Error: Cannot open input video!")


# ==========================================
# 4. Get video properties
# ==========================================

fps = cap.get(cv2.CAP_PROP_FPS)

if fps <= 0:
    fps = 30.0

width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

print("\nVideo Information:")
print("Resolution:", width, "x", height)
print("FPS:", fps)
print("Total Frames:", total_frames)


# ==========================================
# 5. Create MP4 video writer
# ==========================================

fourcc = cv2.VideoWriter_fourcc(*"mp4v")

out = cv2.VideoWriter(
    str(output_path),
    fourcc,
    fps,
    (width, height)
)

if not out.isOpened():
    cap.release()
    raise RuntimeError("Error: Cannot create MP4 output video!")

print("\nStarting Weed Detection...\n")


# ==========================================
# 6. Process video frame by frame
# ==========================================

frame_count = 0

while cap.isOpened():

    ret, frame = cap.read()

    if not ret:
        break

    # YOLO prediction
    results = model.predict(
        source=frame,
        conf=0.25,
        verbose=False
    )

    # Draw bounding boxes and labels
    annotated_frame = results[0].plot()

    # Save annotated frame into MP4
    out.write(annotated_frame)

    frame_count += 1

    # Display progress
    if frame_count % 100 == 0:
        print(
            f"Processed: {frame_count}/{total_frames} frames"
        )

    # Display detection
    cv2.imshow("Weed Detection", annotated_frame)

    # Press Q to stop
    if cv2.waitKey(1) & 0xFF == ord('q'):
        print("\nDetection stopped by user.")
        break


# ==========================================
# 7. Release resources
# ==========================================

cap.release()
out.release()

cv2.destroyAllWindows()


# ==========================================
# 8. Final output
# ==========================================

print("\n================================")
print("Video Processing Complete!")
print("================================")

print("Total frames processed:", frame_count)
print("Output video:", output_path)
print("Output format: MP4")
