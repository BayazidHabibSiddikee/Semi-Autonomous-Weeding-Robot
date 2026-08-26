"""
CLIP zero-shot weed classification.
Identify weed types using text prompts without training.
"""
import torch
import clip
from PIL import Image
import numpy as np

class CLIPWeedClassifier:
    def __init__(self, model_name="ViT-B/32", device=None):
        self.device = device or ("cuda" if torch.cuda.is_available() else "cpu")
        print(f"Loading CLIP: {model_name}")
        self.model, self.preprocess = clip.load(model_name, device=self.device)
        self.model.eval()

        # Default text prompts for our classes
        self.class_prompts = [
            "a photo of a tomato plant with green leaves",
            "a photo of a chili pepper plant",
            "a photo of a flower plant with colorful petals",
            "a photo of grass weed growing in soil",
            "a photo of dandelion weed with yellow flower or white puffball",
            "a photo of purslane weed with thick succulent leaves",
            "a photo of amaranth weed with broad leaves",
            "bare brown soil with no plants",
        ]
        self.class_names = [
            "crop_tomato", "crop_chili", "crop_flower",
            "weed_grass", "weed_dandelion", "weed_purslane",
            "weed_amaranth", "soil"
        ]

        # Pre-encode text prompts
        self.text_tokens = clip.tokenize(self.class_prompts).to(self.device)
        with torch.no_grad():
            self.text_features = self.model.encode_text(self.text_tokens)
            self.text_features = torch.nn.functional.normalize(self.text_features, dim=-1)

        print(f"  Classes: {len(self.class_names)}")

    @torch.no_grad()
    def classify(self, image, top_k=3):
        """
        Classify a PIL image.
        Returns list of (class_name, confidence) tuples.
        """
        image_input = self.preprocess(image).unsqueeze(0).to(self.device)
        image_features = self.model.encode_image(image_input)
        image_features = torch.nn.functional.normalize(image_features, dim=-1)

        similarities = (image_features @ self.text_features.T).squeeze(0)
        probs = similarities.softmax(dim=0).cpu().numpy()

        top_indices = probs.argsort()[::-1][:top_k]
        results = [(self.class_names[i], float(probs[i])) for i in top_indices]
        return results

    def is_weed(self, image, threshold=0.3):
        """Quick check: is this image likely a weed?"""
        results = self.classify(image, top_k=1)
        name, conf = results[0]
        return name.startswith("weed_") and conf >= threshold

    def classify_region(self, image, bbox, top_k=3):
        """Classify a specific region (x1,y1,x2,y2) of an image."""
        x1, y1, x2, y2 = [int(v) for v in bbox]
        cropped = image.crop((x1, y1, x2, y2))
        return self.classify(cropped, top_k)

    def embed_image(self, image):
        """Get CLIP embedding for an image (useful for similarity search)."""
        image_input = self.preprocess(image).unsqueeze(0).to(self.device)
        with torch.no_grad():
            features = self.model.encode_image(image_input)
            features = torch.nn.functional.normalize(features, dim=-1)
        return features.cpu().numpy().flatten()

    def compare_images(self, img1, img2):
        """Compare two images using CLIP embeddings."""
        feat1 = self.embed_image(img1)
        feat2 = self.embed_image(img2)
        return float(np.dot(feat1, feat2))

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", type=str, required=True)
    parser.add_argument("--top_k", type=int, default=3)
    args = parser.parse_args()

    classifier = CLIPWeedClassifier()
    image = Image.open(args.image).convert("RGB")
    results = classifier.classify(image, top_k=args.top_k)

    print(f"\nClassification results for: {args.image}")
    for name, conf in results:
        marker = " [WEED]" if name.startswith("weed_") else ""
        print(f"  {name}: {conf:.3f}{marker}")
