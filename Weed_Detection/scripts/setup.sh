#!/bin/bash
# Setup script for Weed Detection (YOLO26 + NCNN on Raspberry Pi 4)
# Run: bash scripts/setup.sh [--research]

set -e

echo "=== Weed Detection Setup ==="
python3 --version

if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

source venv/bin/activate

echo "Installing core Pi 4 / YOLO + NCNN packages..."
pip install --upgrade pip
pip install ultralytics ncnn onnxruntime
pip install opencv-python numpy Pillow pyyaml tqdm matplotlib pyserial

if [ "$1" = "--research" ]; then
    echo "Installing optional offline research packages (DINOv2 / CLIP)..."
    pip install transformers timm scikit-learn
    pip install "clip @ git+https://github.com/openai/CLIP.git"
fi

pip install RPi.GPIO 2>/dev/null || echo "RPi.GPIO skipped (not on Raspberry Pi)"

echo "Creating standard YOLO detection dataset structure..."
mkdir -p dataset/images/{train,val,test}
mkdir -p dataset/labels/{train,val,test}
mkdir -p models runs/weed

if [ ! -f "configs/weed_data.yaml" ]; then
cat > configs/weed_data.yaml << 'EOF'
path: dataset

train: images/train
val: images/val
test: images/test

names:
  0: crop_tomato
  1: crop_chili
  2: crop_flower
  3: weed_grass
  4: weed_dandelion
  5: weed_purslane
  6: weed_amaranth
  7: weed_other
EOF
fi

echo ""
echo "=== Setup Complete ==="
echo "Dataset layout ready at: dataset/{images,labels}/{train,val,test}"
echo "Next steps:"
echo "  1. source venv/bin/activate"
echo "  2. Add images & YOLO .txt labels to dataset/images/* and dataset/labels/*"
echo "  3. Train YOLO26s: python src/train_yolo.py --model yolo26s.pt --data configs/weed_data.yaml"
echo "  4. Export NCNN:   python src/train_yolo.py --mode export --model runs/weed/yolo26s/weights/best.pt"
echo "  5. Detect-only:   python src/main.py --detect-only"
