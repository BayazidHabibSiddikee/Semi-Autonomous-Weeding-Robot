"""
DINOv2 feature extraction for weed understanding.
Extracts rich visual features from plant images without labels.
Can be used to cluster similar weeds or augment training data.
"""
import torch
import numpy as np
from PIL import Image
from transformers import AutoImageProcessor, AutoModel
from pathlib import Path

class DINOv2Extractor:
    def __init__(self, model_name="facebook/dinov2-small", device=None):
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        print(f"Loading DINOv2: {model_name}")
        self.processor = AutoImageProcessor.from_pretrained(model_name)
        self.model = AutoModel.from_pretrained(model_name).to(self.device)
        self.model.eval()
        self.feature_dim = self.model.config.hidden_size
        print(f"  Feature dimension: {self.feature_dim}")

    @torch.no_grad()
    def extract(self, image):
        """Extract features from a single PIL image."""
        inputs = self.processor(images=image, return_tensors="pt").to(self.device)
        outputs = self.model(**inputs)
        # Use CLS token as global feature
        features = outputs.last_hidden_state[:, 0, :]
        features = torch.nn.functional.normalize(features, dim=-1)
        return features.cpu().numpy().flatten()

    def extract_batch(self, images):
        """Extract features from a list of PIL images."""
        features = []
        for img in images:
            feat = self.extract(img)
            features.append(feat)
        return np.array(features)

    def extract_from_path(self, image_path):
        """Extract features from an image file path."""
        img = Image.open(image_path).convert("RGB")
        return self.extract(img)

    def similarity(self, feat1, feat2):
        """Cosine similarity between two feature vectors."""
        return float(np.dot(feat1, feat2))

    def find_similar(self, query_feat, database_feats, top_k=5):
        """Find most similar images in database."""
        sims = database_feats @ query_feat
        top_indices = np.argsort(sims)[::-1][:top_k]
        return [(idx, sims[idx]) for idx in top_indices]

    def extract_dataset(self, data_dir, output_path="models/dino_features.npz"):
        """Extract features from all images in a directory."""
        data_path = Path(data_dir)
        features = {}
        for img_path in data_path.rglob("*.{jpg,jpeg,png,webp}"):
            try:
                feat = self.extract_from_path(str(img_path))
                features[str(img_path)] = feat
                print(f"  + {img_path.name}: {feat.shape}")
            except Exception as e:
                print(f"  ! {img_path.name}: {e}")

        np.savez(output_path, **features)
        print(f"\nSaved {len(features)} feature vectors to {output_path}")
        return features

def cluster_weeds(features_dict):
    """Cluster similar weed features using simple k-means."""
    from sklearn.cluster import KMeans

    names = list(features_dict.keys())
    feats = np.array(list(features_dict.values()))

    kmeans = KMeans(n_clusters=8, random_state=42, n_init=10)
    labels = kmeans.fit_predict(feats)

    clusters = {}
    for name, label in zip(names, labels):
        clusters.setdefault(label, []).append(name)

    return clusters

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--data_dir", type=str, default="data/train")
    parser.add_argument("--image", type=str, default=None)
    parser.add_argument("--output", type=str, default="models/dino_features.npz")
    args = parser.parse_args()

    extractor = DINOv2Extractor()

    if args.image:
        feat = extractor.extract_from_path(args.image)
        print(f"Feature vector (dim={len(feat)}): {feat[:10]}...")
    else:
        features = extractor.extract_dataset(args.data_dir, args.output)
        clusters = cluster_weeds(features)
        for cid, images in clusters.items():
            print(f"\nCluster {cid}:")
            for img in images[:3]:
                print(f"  {Path(img).name}")
