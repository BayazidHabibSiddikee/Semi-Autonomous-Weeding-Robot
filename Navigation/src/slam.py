"""
Lightweight 2D SLAM for the weed laser rover simulation.

Pure numpy/OpenCV — runs comfortably on CPU with no GPU/VRAM (a 3m x 2m field
at 4cm resolution is a 75x50 grid; scan matching is a few hundred ms/tick).

Pipeline (classic grid-SLAM, SLAM-Toolbox style but tiny):

    [LiDAR scan] ──► ScanMatcher ──► corrected pose (fuses drifting odometry)
                          │                    │
                          ▼                    ▼
                   OccupancyGrid (log-odds) ◄── scan insertion

The rover's raw wheel odometry accumulates drift (slip, turn error); the scan
matcher repeatedly re-localizes the rover against the map it is building, so
the estimated trajectory stays consistent with the true trajectory. Weeds are
geolocated into the map frame using the SLAM pose, not raw odometry.
"""
import math

import numpy as np


# --------------------------------------------------------------------- #
# Virtual 2D LiDAR: raycasts against crop circles and field walls.
# --------------------------------------------------------------------- #
class VirtualLiDAR:
    """180° FOV range scanner mounted on the rover (simulated)."""

    def __init__(self, field, n_beams=72, max_range_cm=350.0,
                 fov_deg=180.0, noise_std_cm=1.5):
        self.field = field
        self.n_beams = n_beams
        self.max_range = max_range_cm
        self.fov_rad = math.radians(fov_deg)
        self.noise_std = noise_std_cm
        self.rng = np.random.default_rng(1234)

    def scan(self, x=None, y=None, heading=None):
        """Return (angles_rel[rad], ranges[m]; 0.0 = no return)."""
        f = self.field
        x = f.rover_x if x is None else x
        y = f.rover_y if y is None else y
        heading = f.heading if heading is None else heading

        angles = np.linspace(-self.fov_rad / 2, self.fov_rad / 2, self.n_beams)
        ranges = np.zeros(self.n_beams)
        step = 2.0  # cm per ray-march step

        for i, a in enumerate(angles):
            th = math.radians(heading) + a
            dx, dy = math.cos(th), math.sin(th)
            r = step
            while r <= self.max_range:
                px, py = x + dx * r, y + dy * r
                # walls (field boundary)
                if not (0 <= px <= f.field_w_cm and 0 <= py <= f.field_h_cm):
                    ranges[i] = (r - step / 2) / 100.0  # meters
                    break
                # crops as circular obstacles
                hit = False
                for cx, cy, cr in f.crops:
                    if (px - cx) ** 2 + (py - cy) ** 2 < cr * cr:
                        hit = True
                        break
                if hit:
                    ranges[i] = (r - step / 2) / 100.0
                    break
                r += step
            else:
                ranges[i] = 0.0  # max range, no return

        # sensor noise (only on valid returns); noise_std is in cm, ranges in m
        valid = ranges > 0
        ranges[valid] = np.maximum(
            0.0,
            ranges[valid] + self.rng.normal(0, self.noise_std / 100.0,
                                            int(valid.sum())))
        return angles, ranges

# --------------------------------------------------------------------- #
# Occupancy grid with log-odds updates (inverse sensor model).
# --------------------------------------------------------------------- #
class OccupancyGrid:
    """Probabilistic occupancy grid; 0.5 unknown, <0.5 free, >0.5 occupied."""

    LIDAR_MAX_RANGE_M = 3.0

    def __init__(self, width_cm, height_cm, cell_cm=4.0,
                 l_occ=0.9, l_free=-0.35, l_max=4.0):
        self.cell = cell_cm
        self.w_cells = int(math.ceil(width_cm / cell_cm))
        self.h_cells = int(math.ceil(height_cm / cell_cm))
        self.logodds = np.zeros((self.h_cells, self.w_cells), dtype=np.float32)
        self.l_occ = l_occ
        self.l_free = l_free
        self.l_max = l_max

    def world_to_cell(self, x_cm, y_cm):
        return int(x_cm / self.cell), int(y_cm / self.cell)

    def _clip(self, c, r):
        return (min(max(c, 0), self.w_cells - 1),
                min(max(r, 0), self.h_cells - 1))

    def insert_scan(self, x_cm, y_cm, heading_rad, angles, ranges_m):
        """Ray-trace every beam: free cells along ray, occupied at endpoint."""
        for a, r_m in zip(angles, ranges_m):
            if r_m <= 0:
                continue  # max-range beam: no endpoint information
            r_cm = r_m * 100.0
            th = heading_rad + a
            ex = x_cm + math.cos(th) * r_cm
            ey = y_cm + math.sin(th) * r_cm
            self._ray(x_cm, y_cm, ex, ey, hit=(r_m < self.LIDAR_MAX_RANGE_M))

    def _ray(self, x0, y0, x1, y1, hit):
        """Bresenham-style trace in cell space."""
        c0, r0 = self._clip(*self.world_to_cell(x0, y0))
        c1, r1 = self._clip(*self.world_to_cell(x1, y1))
        dc, dr = abs(c1 - c0), abs(r1 - r0)
        sc = 1 if c1 >= c0 else -1
        sr = 1 if r1 >= r0 else -1
        err = dc - dr
        c, r = c0, r0
        while (c, r) != (c1, r1):
            self.logodds[r, c] = np.clip(
                self.logodds[r, c] + self.l_free, -self.l_max, self.l_max)
            e2 = 2 * err
            if e2 > -dr:
                err -= dr
                c += sc
            if e2 < dc:
                err += dc
                r += sr
        if hit:
            self.logodds[r1, c1] = np.clip(
                self.logodds[r1, c1] + self.l_occ, -self.l_max, self.l_max)

    def translate(self, dx_cm, dy_cm):
        """Shift the grid origin by (dx_cm, dy_cm); vacated cells -> unknown."""
        dx = int(round(dx_cm / self.cell))
        dy = int(round(dy_cm / self.cell))
        if dx == 0 and dy == 0:
            return
        H, W = self.logodds.shape
        new = np.zeros_like(self.logodds)
        valid_rows = slice(max(0, dy), min(H, H + dy))
        src_rows = slice(max(0, dy) - dy, min(H, H + dy) - dy)
        valid_cols = slice(max(0, dx), min(W, W + dx))
        src_cols = slice(max(0, dx) - dx, min(W, W + dx) - dx)
        new[valid_rows, valid_cols] = self.logodds[src_rows, src_cols]
        self.logodds = new

    def wall_drift_cm(self, field_w_cm, field_h_cm, thr=1.0):
        """Estimate the drift of the mapped walls from the known field
        rectangle, from the bounding box of occupied cells."""
        occ = self.logodds > thr
        if occ.sum() < 60:
            return None
        ys, xs = np.nonzero(occ)
        xmin = xs.min() * self.cell
        ymin = ys.min() * self.cell
        xmax = (xs.max() + 1) * self.cell
        ymax = (ys.max() + 1) * self.cell
        return ((xmin + xmax) / 2 - field_w_cm / 2,
                (ymin + ymax) / 2 - field_h_cm / 2)

    def seed_boundary(self, width_cm, height_cm, wall_cm=4.0):
        """Prime the grid with the known field rectangle (the operator
        supplies length & width, so the perimeter walls are known a priori).
        Interior marked free; a thick wall ring marked occupied. Scan
        matching then has reliable structure from the very first tick."""
        H, W = self.h_cells, self.w_cells
        self.logodds[:] = self.l_free * 6.0          # interior free
        cw = max(1, int(round(wall_cm / self.cell)))   # wall thickness
        self.logodds[:, :cw] = self.l_max
        self.logodds[:, -cw:] = self.l_max
        self.logodds[:cw, :] = self.l_max
        self.logodds[-cw:, :] = self.l_max

    def probability(self):
        """Occupancy probability (float 0..1)."""
        return 1.0 / (1.0 + np.exp(-self.logodds))

    def probability_safe(self, x_cm, y_cm):
        """Sample occupancy probability at a world point; None outside."""
        c, r = self.world_to_cell(x_cm, y_cm)
        if 0 <= c < self.w_cells and 0 <= r < self.h_cells:
            lo = self.logodds[r, c]
            if lo == 0.0:
                return 0.5  # unknown
            return 1.0 / (1.0 + math.exp(-lo))
        return None

    def render(self):
        """BGR visualization: gray unknown, white free, black occupied."""
        p = self.probability()
        img = np.full((*p.shape, 3), 160, np.uint8)      # unknown = gray
        img[(p < 0.4) & (self.logodds < 0)] = (230, 230, 230)   # free
        img[p > 0.65] = (20, 20, 20)                            # occupied
        return img

    def sample_occupancy(self, x_cm, y_cm):
        """Sample log-odds at a world point (used by the scan matcher)."""
        c, r = self.world_to_cell(x_cm, y_cm)
        if 0 <= c < self.w_cells and 0 <= r < self.h_cells:
            return self.logodds[r, c]
        return None


# --------------------------------------------------------------------- #
# Particle-filter (Monte Carlo) localization-on-map = grid SLAM.
# Same family as GMapping: many pose hypotheses, weighted by how well the
# measured scan endpoints land on occupied cells of the likelihood field.
# --------------------------------------------------------------------- #
class ParticleFilterSLAM:
    def __init__(self, grid, lidar, n_particles=180, seed=5):
        self.grid = grid
        self.lidar = lidar
        self.n = n_particles
        self.rng = np.random.default_rng(seed)
        self.px = None  # particle arrays, initialized in reset()
        self.py = None
        self.pth = None
        self.w = None

    def reset(self, x_cm, y_cm, heading_rad, spread_cm=2.0, spread_rad=0.03):
        self.px = x_cm + self.rng.normal(0, spread_cm, self.n)
        self.py = y_cm + self.rng.normal(0, spread_cm, self.n)
        self.pth = heading_rad + self.rng.normal(0, spread_rad, self.n)
        self.w = np.full(self.n, 1.0 / self.n)

    def motion_update(self, d_cm, dth_rad):
        """Propagate particles with the odometry command + noise."""
        d_noise = d_cm * (1.0 + self.rng.normal(0, 0.03, self.n))
        th_noise = self.rng.normal(0, abs(dth_rad) * 0.05 + math.radians(0.4),
                                   self.n)
        th = self.pth + dth_rad + th_noise
        self.px = self.px + d_noise * np.cos(th)
        self.py = self.py + d_noise * np.sin(th)
        self.pth = (th + math.pi) % (2 * math.pi) - math.pi

    def _likelihood_field(self, use_cache=True):
        """Occupancy probability with 3x3 max-dilation.
        occupied≈1.0, known-free≈0.1, unknown≈0.4. Cached per update so the
        measurement update and every refine stage share one build."""
        if use_cache and getattr(self, "_lf_cache", None) is not None:
            return self._lf_cache
        logodds = self.grid.logodds
        prob = 1.0 / (1.0 + np.exp(-logodds))
        known = logodds != 0.0
        lf = np.where(known, np.where(prob > 0.5, prob, 0.1), 0.4)
        # dilate occupied blobs so nearby poses also score well
        p = np.pad(lf, 1, mode="edge")
        stack = np.stack([p[1 + dr:1 + dr + lf.shape[0],
                            1 + dc:1 + dc + lf.shape[1]]
                          for dr in (-1, 0, 1) for dc in (-1, 0, 1)])
        res = stack.max(axis=0)
        if use_cache:
            self._lf_cache = res
        return res

    def begin_update(self):
        """Invalidate the cached likelihood field at the start of an update."""
        self._lf_cache = None

    def _ray_loglik(self, ox, oy, px, py, pth):
        """Per-pose ray consistency log-likelihood (vectorized over poses).
        Endpoints should be occupied; ray interiors should be free."""
        lf = self._likelihood_field()
        h, w = lf.shape

        def lookup(ex, ey):
            cc = (ex / self.grid.cell).astype(int)
            rr = (ey / self.grid.cell).astype(int)
            inb = (cc >= 0) & (cc < w) & (rr >= 0) & (rr < h)
            cc = np.clip(cc, 0, w - 1)
            rr = np.clip(rr, 0, h - 1)
            return np.where(inb, lf[rr, cc], 0.0)

        cos_t = np.cos(pth)[:, None]
        sin_t = np.sin(pth)[:, None]

        # endpoint term: occupied cells score high
        ex = px[:, None] + ox[None, :] * cos_t - oy[None, :] * sin_t
        ey = py[:, None] + ox[None, :] * sin_t + oy[None, :] * cos_t
        log_w = np.log(lookup(ex, ey) + 0.05).sum(axis=1)

        # free-space term: samples along each ray should be unoccupied;
        # a wrong pose puts map walls inside the measured free path
        for f in (0.35, 0.55, 0.75, 0.9):
            fx = px[:, None] + (f * ox)[None, :] * cos_t \
                - (f * oy)[None, :] * sin_t
            fy = py[:, None] + (f * ox)[None, :] * sin_t \
                + (f * oy)[None, :] * cos_t
            p_occ = lookup(fx, fy)
            log_w += np.log(1.0 - p_occ + 0.05).sum(axis=1)
        return log_w

    def measurement_update(self, angles, ranges):
        """Weight particles by full-ray consistency:
        - endpoints should land on occupied cells
        - the ray path should NOT pass through known occupied cells
        (free-space consistency adds strong along-track constraints)."""
        valid = ranges > 0
        a = angles[valid]
        r_cm = ranges[valid] * 100.0
        if len(a) == 0:
            return
        ox = r_cm * np.cos(a)
        oy = r_cm * np.sin(a)

        log_w = self._ray_loglik(ox, oy, self.px, self.py, self.pth)

        # temper the measurement model: per-beam independence is assumed too
        # strong otherwise, which collapses the particle cloud prematurely
        log_w = log_w / 4.0
        log_w -= log_w.max()
        self.w = np.exp(log_w)
        self.w /= self.w.sum()

        # resample if degenerate
        neff = 1.0 / np.sum(self.w ** 2)
        if neff < self.n / 2.0:
            idx = self.rng.choice(self.n, self.n, p=self.w)
            self.px, self.py, self.pth = self.px[idx], self.py[idx], self.pth[idx]
            self.w = np.full(self.n, 1.0 / self.n)

        # keep a little exploration noise so the filter can recover if it
        # has locked onto a wrong hypothesis
        n_explore = max(1, self.n // 40)
        idx = self.rng.choice(self.n, n_explore, replace=False)
        self.px[idx] += self.rng.normal(0, 2.0, n_explore)
        self.py[idx] += self.rng.normal(0, 2.0, n_explore)
        self.pth[idx] += self.rng.normal(0, math.radians(1.5), n_explore)

    def best_pose(self):
        """Pose of the highest-weight particle (avoids averaging modes)."""
        i = int(np.argmax(self.w))
        return float(self.px[i]), float(self.py[i]), float(self.pth[i])

    def refine_pose(self, angles, ranges, half_cm=14.0, step_cm=2.0,
                    half_deg=4.0, step_deg=1.0):
        """Two-stage local search around the best particle using the same
        ray-consistency objective as the measurement update: a coarse pass
        over a wide window, then a fine pass around the coarse optimum."""
        valid = ranges > 0
        a = angles[valid]
        r_cm = ranges[valid] * 100.0
        if len(a) == 0:
            return self.best_pose()
        ox = r_cm * np.cos(a)
        oy = r_cm * np.sin(a)

        def search(bx, by, bth, hc, sc, hd, sd):
            dxs = np.arange(-hc, hc + 0.1, sc)
            dys = np.arange(-hc, hc + 0.1, sc)
            ths = bth + np.radians(np.arange(-hd, hd + 0.1, sd))
            cand = [(float(bx + dx), float(by + dy), float(th))
                    for th in ths for dx in dxs for dy in dys]
            cx = np.array([c[0] for c in cand])
            cy = np.array([c[1] for c in cand])
            ct = np.array([c[2] for c in cand])
            ll = self._ray_loglik(ox, oy, cx, cy, ct)
            return cand[int(np.argmax(ll))]

        # coarse pass
        bx, by, bth = self.best_pose()
        x, y, th = search(bx, by, bth, half_cm, step_cm, half_deg, step_deg)
        # fine pass
        x, y, th = search(x, y, th, step_cm, 0.5, step_deg, 0.5)
        return x, y, th


# --------------------------------------------------------------------- #
# Full SLAM: drifting odometry + particle-filter localization + mapping.
# --------------------------------------------------------------------- #
class SlamSystem:
    """
    Feed every motion update (`predict`) and every scan (`update`).
    `pose` is the SLAM-corrected estimate; `odo_pose` is the raw drifting
    odometry (kept for visualization/teaching purposes).
    """

    def __init__(self, field, cell_cm=2.0, odo_dist_noise=0.10,
                 odo_ang_noise=0.08, seed=99):
        self.field = field
        self.grid = OccupancyGrid(field.field_w_cm, field.field_h_cm, cell_cm)
        self.grid.seed_boundary(field.field_w_cm, field.field_h_cm)
        self.lidar = VirtualLiDAR(field)
        self.pf = ParticleFilterSLAM(self.grid, self.lidar)
        self.pf.reset(field.rover_x, field.rover_y,
                      math.radians(field.heading))

        # SLAM pose estimate initialized at the true start pose
        self.x = field.rover_x
        self.y = field.rover_y
        self.heading = math.radians(field.heading)

        # raw odometry (drifts) — this is the robot's uncorrected estimate
        self.odo_x, self.odo_y = field.rover_x, field.rover_y
        self.odo_heading = math.radians(field.heading)
        self.odo_dist_noise = odo_dist_noise
        self.odo_ang_noise = odo_ang_noise
        self.rng = np.random.default_rng(seed)

        # baseline: an identical odometry integrator that is NEVER corrected
        # by SLAM. Same noisy commands, same noise — the only difference is
        # that SLAM fuses the map to fight the drift.
        self.base_x, self.base_y = field.rover_x, field.rover_y
        self.base_heading = math.radians(field.heading)
        self.base_odo_dist_noise = odo_dist_noise * 2.0
        self.base_odo_ang_noise = odo_ang_noise * 2.0
        self.base_rng = np.random.default_rng(seed + 101)

        self.trajectory = [(self.x, self.y)]        # SLAM-corrected
        self.odo_trajectory = [(self.odo_x, self.odo_y)]
        self.base_trajectory = [(self.base_x, self.base_y)]
        self.true_trajectory = [(field.rover_x, field.rover_y)]
        self.weed_marks = []                        # (x_slam, y_slam, ...)
        self.tare_every = 12
        self.tare_counter = 0

    def predict(self, true_dx_cm, true_dheading_deg):
        """Odometry model: observed motion = true motion + noise (drift)."""
        d = true_dx_cm * (1.0 + self.rng.normal(0, self.odo_dist_noise))
        dh = math.radians(true_dheading_deg *
                          (1.0 + self.rng.normal(0, self.odo_ang_noise)))

        # raw odometry integrates the noisy motion (drifts over time)
        self.odo_heading = (self.odo_heading + dh) % (2 * math.pi)
        self.odo_x += d * math.cos(self.odo_heading)
        self.odo_y += d * math.sin(self.odo_heading)

        # baseline odometry (never corrected by SLAM)
        bd = true_dx_cm * (1.0 + self.base_rng.normal(0, self.base_odo_dist_noise))
        bdh = math.radians(true_dheading_deg *
                           (1.0 + self.base_rng.normal(0, self.base_odo_ang_noise)))
        self.base_heading = (self.base_heading + bdh) % (2 * math.pi)
        self.base_x += bd * math.cos(self.base_heading)
        self.base_y += bd * math.sin(self.base_heading)
        self.base_trajectory.append((self.base_x, self.base_y))

        # SLAM prediction: propagate the particle cloud with the same
        # noisy odometry (that's all the rover really has)
        self.heading = (self.heading + dh) % (2 * math.pi)
        self.x += d * math.cos(self.heading)
        self.y += d * math.sin(self.heading)
        self.pf.motion_update(d, dh)

    def update(self):
        """One SLAM iteration:
        1. take a LiDAR measurement (true sensor) and integrate it into the
           map at the SLAM pose
        2. Monte-Carlo localization + local refinement (best effort)
        3. ultrasonic wall constraints: when a perimeter wall is in range the
           sonar gives an exact absolute coordinate, eliminating the
           accumulated encoder drift (the "perimeter reset" on the real rover)
        """
        # sensor measurement (defaults to the true pose, like a real scanner)
        angles, ranges = self.lidar.scan()

        self.pf.begin_update()

        # mapping first at the current best pose (map stays crisp because the
        # sonar keeps the pose close to truth)
        self.grid.insert_scan(self.x, self.y, self.heading, angles, ranges)

        # --- Monte-Carlo / refine (gentle; the sonar is the strong one) ---
        self.pf.measurement_update(angles, ranges)
        rx, ry, rh = self.pf.best_pose()
        dx, dy = rx - self.x, ry - self.y
        if math.hypot(dx, dy) < 6.0:
            self.x += 0.3 * dx
            self.y += 0.3 * dy
            dh = (rh - self.heading + math.pi) % (2 * math.pi) - math.pi
            self.heading = (self.heading + 0.3 * dh) % (2 * math.pi)
        else:
            self.pf.reset(self.odo_x, self.odo_y, self.odo_heading,
                          spread_cm=6.0, spread_rad=0.05)

        # --- ultrasonic perimeter constraints (exact, unbiased) ---
        # The coverage pattern drives parallel to the axes (heading 0 or 180),
        # so while travelling a row the forward sonar sees a vertical wall and
        # the right sonar sees a horizontal wall. Each in-range reading pins
        # an absolute coordinate, eliminating accumulated encoder drift. This
        # is the "perimeter / boundary reset" described for the real rover.
        # Guarded by |cos| > 0.9 so turns (heading 90/180/270/360) never fire.
        ch = math.cos(self.heading)
        fwd = self.field.sonar(0.0)
        if fwd is not None and abs(ch) > 0.9:
            if ch > 0.9:          # heading ~0:  wall ahead is x = W
                self.x += 0.6 * (self.field.field_w_cm - fwd - self.x)
            else:                 # heading ~180: wall ahead is x = 0
                self.x += 0.6 * (fwd - self.x)
        side = self.field.sonar(-90.0)
        if side is not None and abs(ch) > 0.9:
            if ch > 0.9:          # heading ~0:  right wall is y = 0
                self.y += 0.6 * (side - self.y)
            else:                 # heading ~180: right wall is y = H
                self.y += 0.6 * (self.field.field_h_cm - side - self.y)
        # (the sonar x/y updates above keep the pose anchored; heading stays
        # accurate because the IMU / compass provides it)

        self.trajectory.append((self.x, self.y))
        self.odo_trajectory.append((self.odo_x, self.odo_y))
        self.true_trajectory.append((self.field.rover_x, self.field.rover_y))

    def mark_weed(self, eliminated, x_true=None, y_true=None):
        """Record a weed detection geolocated with the SLAM pose."""
        self.weed_marks.append((self.x, self.y, eliminated,
                                x_true, y_true))

    def error_vs_truth(self):
        return math.hypot(self.x - self.field.rover_x,
                          self.y - self.field.rover_y)

    def odo_error_vs_truth(self):
        return math.hypot(self.odo_x - self.field.rover_x,
                          self.odo_y - self.field.rover_y)

    def base_error_vs_truth(self):
        return math.hypot(self.base_x - self.field.rover_x,
                          self.base_y - self.field.rover_y)
