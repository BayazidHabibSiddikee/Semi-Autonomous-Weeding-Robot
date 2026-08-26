"""
Camera-to-gantry calibration using homography.
Maps pixel coordinates (u,v) → gantry coordinates (X,Y,Z mm).
Z is estimated via flat ground assumption (constant height from ground plane).
"""
import cv2
import numpy as np
import json
import os

class CameraCalibrator:
    def __init__(self, checkerboard=(9, 6), aruco_markers=12, camera_height_mm=500):
        self.checkerboard = checkerboard
        self.aruco_markers = aruco_markers
        self.camera_height_mm = camera_height_mm  # Z: fixed distance from camera to ground
        self.camera_matrix = None
        self.dist_coeffs = None
        self.homography = None
        self.H = None  # alias

    def calibrate_intrinsic(self, images, save_path="models/camera_intrinsic.npz"):
        """
        Intrinsic calibration using checkerboard photos.
        images: list of file paths or BGR images
        """
        print("Running intrinsic calibration...")
        obj_points = []
        img_points = []
        objp = np.zeros((self.checkerboard[0] * self.checkerboard[1], 3), np.float32)
        objp[:, :2] = np.mgrid[0:self.checkerboard[0], 0:self.checkerboard[1]].T.reshape(-1, 2)

        for i, img in enumerate(images):
            if isinstance(img, str):
                img = cv2.imread(img)
            gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

            ret, corners = cv2.findChessboardCorners(gray, self.checkerboard, None)
            if ret:
                criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.001)
                corners2 = cv2.cornerSubPix(gray, corners, (11, 11), (-1, -1), criteria)
                obj_points.append(objp)
                img_points.append(corners2)
                print(f"  Image {i+1}: checkerboard found")
            else:
                print(f"  Image {i+1}: no checkerboard detected, skipping")

        if len(obj_points) < 3:
            raise ValueError("Need at least 3 valid checkerboard images")

        ret, self.camera_matrix, self.dist_coeffs, rvecs, tvecs = cv2.calibrateCamera(
            obj_points, img_points, gray.shape[::-1], None, None
        )
        print(f"  Reprojection error: {ret:.4f} pixels")

        os.makedirs(os.path.dirname(save_path), exist_ok=True)
        np.savez(save_path,
                 camera_matrix=self.camera_matrix,
                 dist_coeffs=self.dist_coeffs,
                 reprojection_error=ret)
        print(f"  Saved to: {save_path}")
        return self.camera_matrix, self.dist_coeffs

    def load_intrinsic(self, path="models/camera_intrinsic.npz"):
        """Load pre-computed intrinsic calibration."""
        data = np.load(path)
        self.camera_matrix = data["camera_matrix"]
        self.dist_coeffs = data["dist_coeffs"]
        print(f"Loaded intrinsic calibration from {path}")
        return self.camera_matrix, self.dist_coeffs

    def calibrate_extrinsic(self, image, pixel_points, world_points,
                           save_path="models/calibration.npz"):
        """
        Compute homography from pixel coords to gantry coords.
        pixel_points: Nx2 array of (u, v) pixel coordinates
        world_points: Nx2 array of (X, Y) in mm on gantry
        """
        pixel_pts = np.array(pixel_points, dtype=np.float32)
        world_pts = np.array(world_points, dtype=np.float32)

        self.H, mask = cv2.findHomography(pixel_pts, world_pts, cv2.RANSAC, 5.0)
        inliers = mask.ravel().sum()
        print(f"Homography computed: {inliers}/{len(pixel_pts)} inliers")

        os.makedirs(os.path.dirname(save_path), exist_ok=True)
        np.savez(save_path, homography=self.H,
                 pixel_points=pixel_pts,
                 world_points=world_pts)
        self.homography = self.H
        print(f"  Saved to: {save_path}")
        return self.H

    def load_calibration(self, path="models/calibration.npz"):
        """Load pre-computed homography."""
        data = np.load(path)
        self.H = data["homography"]
        self.homography = self.H
        print(f"Loaded homography from {path}")
        return self.H

    def pixel_to_gantry(self, u, v):
        """Convert pixel coordinates to gantry coordinates (X, Y, Z mm).
        Z is constant (flat ground assumption) = camera_height_mm.
        """
        if self.H is None:
            raise ValueError("Calibration not loaded. Run calibrate_extrinsic() first.")
        pt = self.H @ np.array([u, v, 1.0])
        pt /= pt[2]
        return float(pt[0]), float(pt[1]), self.camera_height_mm

    def pixel_to_gantry_2d(self, u, v):
        """Convert pixel coordinates to gantry coordinates (X, Y mm) — 2D only."""
        x, y, _ = self.pixel_to_gantry(u, v)
        return x, y

    def gantry_to_pixel(self, x_mm, y_mm):
        """Convert gantry coordinates (X, Y mm) back to pixel coordinates."""
        if self.H is None:
            raise ValueError("Calibration not loaded.")
        H_inv = np.linalg.inv(self.H)
        pt = H_inv @ np.array([x_mm, y_mm, 1.0])
        pt /= pt[2]
        return float(pt[0]), float(pt[1])

    def estimate_weed_height(self, bbox_height_px, known_weed_width_mm=30):
        """Estimate weed height (Z offset from ground) based on apparent size.
        bbox_height_px: bounding box height in pixels
        known_weed_width_mm: estimated real-world width of weed in mm
        Returns: height offset in mm (0 = on ground surface)
        """
        if self.camera_matrix is None:
            return 0.0
        # Approximate: weed closer to camera appears larger
        # At camera_height_mm, a weed of known_weed_width_mm spans some pixels
        # Deviation from expected pixel size indicates height difference
        focal_px = self.camera_matrix[0, 0]
        expected_px = (known_weed_width_mm * focal_px) / self.camera_height_mm
        if bbox_height_px > 0:
            ratio = expected_px / bbox_height_px
            height_offset = self.camera_height_mm * (1 - 1/ratio)
            return max(0.0, height_offset)
        return 0.0

    def verify_calibration(self, test_pairs):
        """Verify accuracy with known test points."""
        errors = []
        for (u, v), (x_expected, y_expected) in test_pairs:
            x_pred, y_pred = self.pixel_to_gantry(u, v)
            error = np.sqrt((x_pred - x_expected)**2 + (y_pred - y_expected)**2)
            errors.append(error)
            print(f"  Pixel({u},{v}) → Gantry({x_pred:.1f},{y_pred:.1f}) "
                  f"expected ({x_expected},{y_expected}) error={error:.2f}mm")
        mean_error = np.mean(errors)
        print(f"\nMean error: {mean_error:.2f}mm")
        return mean_error

    def auto_calibrate_with_aruco(self, image_path, marker_positions, save_path="models/calibration.npz"):
        """
        Automatic calibration using ArUco markers.
        marker_positions: dict of {marker_id: (x_mm, y_mm)} known positions
        """
        img = cv2.imread(image_path)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        aruco_dict = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_6X6_250)
        parameters = cv2.aruco.DetectorParameters()
        detector = cv2.aruco.ArucoDetector(aruco_dict, parameters)

        corners, ids, rejected = detector.detectMarkers(gray)

        if ids is None or len(ids) < 4:
            raise ValueError(f"Found {len(ids) if ids else 0} markers, need at least 4")

        pixel_pts = []
        world_pts = []
        for i, marker_id in enumerate(ids.flatten()):
            if marker_id in marker_positions:
                center = corners[i][0].mean(axis=0)
                pixel_pts.append(center)
                world_pts.append(marker_positions[marker_id])

        pixel_pts = np.array(pixel_pts, dtype=np.float32)
        world_pts = np.array(world_pts, dtype=np.float32)

        print(f"Using {len(pixel_pts)} ArUco markers for calibration")
        return self.calibrate_extrinsic(image_path, pixel_pts, world_pts, save_path)

def interactive_calibration(camera_id=0):
    """Interactive calibration tool — click points on camera feed."""
    cap = cv2.VideoCapture(camera_id)
    if not cap.isOpened():
        print("Cannot open camera")
        return

    print("\n=== Interactive Calibration ===")
    print("1. Click 8-12 points on the image")
    print("2. For each point, enter the real-world (X, Y) position in mm")
    print("3. Press 'q' when done\n")

    pixel_points = []
    world_points = []

    def mouse_callback(event, x, y, flags, param):
        if event == cv2.EVENT_LBUTTONDOWN:
            pixel_points.append((x, y))
            print(f"  Point {len(pixel_points)}: pixel ({x}, {y})")

    cv2.namedWindow("Calibration")
    cv2.setMouseCallback("Calibration", mouse_callback)

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        for pt in pixel_points:
            cv2.circle(frame, pt, 5, (0, 255, 0), -1)

        cv2.putText(frame, f"Points: {len(pixel_points)}", (10, 30),
                   cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
        cv2.imshow("Calibration", frame)

        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

    cap.release()
    cv2.destroyAllWindows()

    if len(pixel_points) < 4:
        print("Need at least 4 points")
        return

    print("\nEnter real-world coordinates (mm) for each point:")
    for i, (u, v) in enumerate(pixel_points):
        x = float(input(f"  Point {i+1} pixel({u},{v}) → X_mm: "))
        y = float(input(f"  Point {i+1} pixel({u},{v}) → Y_mm: "))
        world_points.append((x, y))

    calibrator = CameraCalibrator()
    H = calibrator.calibrate_extrinsic(
        None, pixel_points, world_points, "models/calibration.npz"
    )
    print(f"\nHomography matrix:\n{H}")

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["intrinsic", "extrinsic", "interactive", "verify"],
                       default="interactive")
    parser.add_argument("--camera", type=int, default=0)
    parser.add_argument("--images", nargs="+", help="Checkerboard images for intrinsic")
    args = parser.parse_args()

    cal = CameraCalibrator()

    if args.mode == "intrinsic" and args.images:
        cal.calibrate_intrinsic(args.images)
    elif args.mode == "extrinsic":
        cal.load_calibration()
    elif args.mode == "interactive":
        interactive_calibration(args.camera)
    elif args.mode == "verify":
        cal.load_calibration()
        # Add your test pairs here
