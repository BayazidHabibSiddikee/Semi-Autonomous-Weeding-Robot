#!/bin/bash
# Setup script for Weed Laser Robot
# Run: bash scripts/setup.sh

set -e

echo "=== Weed Laser Robot Setup ==="

# Check Python version
python3 --version

# Create virtual environment
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
fi

source venv/bin/activate

# Install dependencies
echo "Installing Python packages..."
pip install --upgrade pip
pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu
pip install ultralytics
pip install transformers timm
pip install opencv-python opencv-contrib-python
pip install numpy Pillow pyyaml tqdm matplotlib scikit-learn
pip install pyserial
pip install "clip @ git+https://github.com/openai/CLIP.git"

# Try installing RPi.GPIO (only works on Raspberry Pi)
pip install RPi.GPIO 2>/dev/null || echo "RPi.GPIO skipped (not on Raspberry Pi)"

# Create data directories
echo "Creating data directories..."
mkdir -p data/train/{crop_tomato,crop_chili,crop_flower,weed_grass,weed_dandelion,weed_purslane,weed_amaranth,weed_other}
mkdir -p data/val/{crop_tomato,crop_chili,crop_flower,weed_grass,weed_dandelion,weed_purslane,weed_amaranth,weed_other}
mkdir -p models

# Create YOLO data config
cat > configs/weed_data.yaml << 'EOF'
train: data/train
val: data/val
nc: 8
names:
  - crop_tomato
  - crop_chili
  - crop_flower
  - weed_grass
  - weed_dandelion
  - weed_purslane
  - weed_amaranth
  - weed_other
EOF

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. source venv/bin/activate"
echo "  2. Collect training images: python scripts/collect_data.py"
echo "  3. Train models: python src/train_weed_model.py"
echo "  4. Calibrate camera: python src/calibration.py"
echo "  5. Run pipeline: python src/main.py --simulate"
