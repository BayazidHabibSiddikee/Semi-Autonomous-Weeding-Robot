/**
 * Automatic Field Boundary Detection (ExG + minAreaRect), Homography Auto-BEV,
 * Crop Ridge vs. Furrow Segmentation, and 2-Point Boustrophedon Route Generation.
 *
 * Mirrors Raspberry Pi 5 Onboard Pipeline Steps 1–3:
 *   1. Excess Green (ExG = 2G - R - B) + HSV mask -> convex hull -> rotating-calipers minAreaRect
 *      (Zero manual corner selection!)
 *   2. Homography auto-warp to 2D Top-Down BEV + Crop Ridge vs. Traversable Furrow segmentation
 *   3. Optimal Boustrophedon serpentine route from only 2 farmer-tapped points: [Start] & [End]
 */

import { FieldCorners, ImagePoint } from './models';
import { computeHomography } from './bevPipeline';

export interface NormalizedPoint {
  nx: number; // 0..1 across BEV width (across furrows)
  ny: number; // 0..1 along BEV height (along furrow length, 0 = top, 1 = bottom)
}

export interface FurrowWaypoint {
  nx: number;
  ny: number;
  kind: 'START' | 'FURROW_RUN' | 'U_TURN' | 'END';
  furrowIndex: number;
}

export interface AutoFieldAnalysis {
  sourceWidth: number;
  sourceHeight: number;
  detectedCorners: FieldCorners;
  bevDataUrl: string;
  bevWidth: number;
  bevHeight: number;
  ridgesNx: number[]; // Normalized X centers of crop ridges
  furrowsNx: number[]; // Normalized X centers of traversable furrows
  furrowWidthNx: number;
  vegetationCoverage: number;
  confidence: number;
  ready: boolean;
}

export const MIN_DETECTION_CONFIDENCE = 0.45;

/**
 * Andrew's monotone chain convex hull in 2D.
 */
function convexHull(points: ImagePoint[]): ImagePoint[] {
  const sorted = [...points].sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
  if (sorted.length <= 2) return sorted;

  const cross = (o: ImagePoint, a: ImagePoint, b: ImagePoint) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: ImagePoint[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: ImagePoint[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Isolate the dominant contiguous vegetation cluster on a coarse grid so scattered
 * border trees/weeds do not pull the field boundary out of shape, then extract
 * its 4 perspective quadrilateral corners (TL, TR, BR, BL).
 */
function computeDominantPlotQuad(
  points: ImagePoint[],
  maxW: number,
  maxH: number
): FieldCorners {
  const fallback: FieldCorners = {
    topLeft: { x: maxW * 0.08, y: maxH * 0.1 },
    topRight: { x: maxW * 0.92, y: maxH * 0.1 },
    bottomRight: { x: maxW * 0.92, y: maxH * 0.9 },
    bottomLeft: { x: maxW * 0.08, y: maxH * 0.9 },
  };
  if (points.length < 20) return fallback;

  // 1. Coarse grid occupancy + 1-cell morphological dilation to bridge furrows between crop rows
  const gridW = 36;
  const gridH = 28;
  const occ = new Uint8Array(gridW * gridH);
  for (const p of points) {
    const gx = Math.min(gridW - 1, Math.max(0, Math.floor((p.x / maxW) * gridW)));
    const gy = Math.min(gridH - 1, Math.max(0, Math.floor((p.y / maxH) * gridH)));
    occ[gy * gridW + gx] = 1;
  }

  const dilated = new Uint8Array(gridW * gridH);
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      let hit = 0;
      for (let dy = -1; dy <= 1 && !hit; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < gridW && ny >= 0 && ny < gridH && occ[ny * gridW + nx]) {
            hit = 1;
            break;
          }
        }
      }
      dilated[y * gridW + x] = hit;
    }
  }

  // 2. Flood-fill connected components to find the dominant contiguous field plot
  const labels = new Int32Array(gridW * gridH);
  let bestLabel = 0;
  let bestCount = 0;
  let nextLabel = 1;
  const queue: number[] = [];

  for (let i = 0; i < dilated.length; i++) {
    if (!dilated[i] || labels[i] !== 0) continue;
    const lbl = nextLabel++;
    let count = 0;
    queue.length = 0;
    queue.push(i);
    labels[i] = lbl;

    while (queue.length > 0) {
      const cur = queue.pop()!;
      count++;
      const cx = cur % gridW;
      const cy = Math.floor(cur / gridW);
      const neighbors = [
        [cx - 1, cy],
        [cx + 1, cy],
        [cx, cy - 1],
        [cx, cy + 1],
      ];
      for (const [nx, ny] of neighbors) {
        if (nx < 0 || nx >= gridW || ny < 0 || ny >= gridH) continue;
        const ni = ny * gridW + nx;
        if (dilated[ni] && labels[ni] === 0) {
          labels[ni] = lbl;
          queue.push(ni);
        }
      }
    }

    if (count > bestCount) {
      bestCount = count;
      bestLabel = lbl;
    }
  }

  const clusterPts = points.filter((p) => {
    const gx = Math.min(gridW - 1, Math.max(0, Math.floor((p.x / maxW) * gridW)));
    const gy = Math.min(gridH - 1, Math.max(0, Math.floor((p.y / maxH) * gridH)));
    return labels[gy * gridW + gx] === bestLabel;
  });

  const hull = convexHull(clusterPts.length >= 16 ? clusterPts : points);
  if (hull.length < 4) return fallback;

  // 3. Extract true perspective quadrilateral corners (handles trapezoids from oblique camera tilt)
  const tl = hull.reduce((a, b) => (a.x + a.y < b.x + b.y ? a : b));
  const br = hull.reduce((a, b) => (a.x + a.y > b.x + b.y ? a : b));
  const tr = hull.reduce((a, b) => (a.y - a.x < b.y - b.x ? a : b));
  const bl = hull.reduce((a, b) => (a.y - a.x > b.y - b.x ? a : b));

  const rawQuad = [tl, tr, br, bl];
  const cx = rawQuad.reduce((s, p) => s + p.x, 0) / 4;
  const cy = rawQuad.reduce((s, p) => s + p.y, 0) / 4;

  // Verify non-degenerate area before returning
  const area =
    0.5 *
    Math.abs(
      tl.x * tr.y -
        tr.x * tl.y +
        tr.x * br.y -
        br.x * tr.y +
        br.x * bl.y -
        bl.x * br.y +
        bl.x * tl.y -
        tl.x * bl.y
    );
  if (area < maxW * maxH * 0.04) return fallback;

  const expand = (p: ImagePoint): ImagePoint => ({
    x: Math.max(2, Math.min(maxW - 2, cx + (p.x - cx) * 1.03)),
    y: Math.max(2, Math.min(maxH - 2, cy + (p.y - cy) * 1.03)),
  });

  return {
    topLeft: expand(tl),
    topRight: expand(tr),
    bottomRight: expand(br),
    bottomLeft: expand(bl),
  };
}

function isGreenVegetation(r: number, g: number, b: number): boolean {
  if (2 * g - r - b <= 10) return false;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (max < 25) return false;
  const s = (delta * 255) / max;
  if (s < 25) return false;

  let hDeg = 0;
  if (delta > 0) {
    if (max === r) hDeg = 60 * (((g - b) / delta) % 6);
    else if (max === g) hDeg = 60 * ((b - r) / delta + 2);
    else hDeg = 60 * ((r - g) / delta + 4);
    if (hDeg < 0) hDeg += 360;
  }
  const hOpenCv = hDeg / 2;
  return hOpenCv >= 18 && hOpenCv <= 102;
}

/**
 * Step 1 & 2 on Pi:
 * Automatically finds field corners via ExG + dominant-cluster perspective quadrilateral,
 * warps to 2D Top-Down BEV, and segments Crop Ridges vs. Traversable Furrows honestly
 * (never fabricating fake lanes when crop rows are missing).
 */
export function runAutomaticFieldPipeline(
  image: HTMLImageElement,
  bevW = 640,
  bevH = 440
): AutoFieldAnalysis {
  const srcW = image.naturalWidth || image.width;
  const srcH = image.naturalHeight || image.height;
  if (srcW <= 0 || srcH <= 0) {
    throw new Error('Invalid image dimensions');
  }

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = srcW;
  srcCanvas.height = srcH;
  const srcCtx = srcCanvas.getContext('2d');
  if (!srcCtx) throw new Error('Canvas 2D unavailable');
  srcCtx.drawImage(image, 0, 0, srcW, srcH);
  const srcImg = srcCtx.getImageData(0, 0, srcW, srcH);
  const srcData = srcImg.data;

  // 1. Sample ExG vegetation pixels for automatic boundary detection
  const stride = Math.max(2, Math.floor(Math.min(srcW, srcH) / 140));
  const vegPoints: ImagePoint[] = [];
  let totalSampled = 0;

  for (let y = 0; y < srcH; y += stride) {
    for (let x = 0; x < srcW; x += stride) {
      totalSampled++;
      const idx = (y * srcW + x) * 4;
      if (isGreenVegetation(srcData[idx], srcData[idx + 1], srcData[idx + 2])) {
        vegPoints.push({ x, y });
      }
    }
  }

  const vegCoverage = totalSampled > 0 ? vegPoints.length / totalSampled : 0;
  const detectedCorners = computeDominantPlotQuad(vegPoints, srcW, srcH);

  // 2. Auto-warp to 2D Top-Down BEV via inverse homography
  const srcPts = [
    detectedCorners.topLeft,
    detectedCorners.topRight,
    detectedCorners.bottomRight,
    detectedCorners.bottomLeft,
  ];
  const dstPts: ImagePoint[] = [
    { x: 0, y: 0 },
    { x: bevW, y: 0 },
    { x: bevW, y: bevH },
    { x: 0, y: bevH },
  ];

  const invH = computeHomography(dstPts, srcPts);
  const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = invH;

  const dstCanvas = document.createElement('canvas');
  dstCanvas.width = bevW;
  dstCanvas.height = bevH;
  const dstCtx = dstCanvas.getContext('2d')!;
  const dstImg = dstCtx.createImageData(bevW, bevH);
  const dstData = dstImg.data;

  // Simultaneously accumulate vertical vegetation profile for Crop Ridge vs. Furrow segmentation
  const colGreenCount = new Float32Array(bevW);

  for (let y = 0; y < bevH; y++) {
    for (let x = 0; x < bevW; x++) {
      const w = h6 * x + h7 * y + h8;
      if (Math.abs(w) < 1e-8) continue;
      const sx = (h0 * x + h1 * y + h2) / w;
      const sy = (h3 * x + h4 * y + h5) / w;

      const dstIdx = (y * bevW + x) * 4;
      if (sx < 0 || sy < 0 || sx >= srcW - 1 || sy >= srcH - 1) {
        dstData[dstIdx] = 22;
        dstData[dstIdx + 1] = 26;
        dstData[dstIdx + 2] = 24;
        dstData[dstIdx + 3] = 255;
        continue;
      }

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const fx1 = 1 - fx;
      const fy1 = 1 - fy;

      const i00 = (y0 * srcW + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + srcW * 4;
      const i11 = i01 + 4;

      const r =
        srcData[i00] * fx1 * fy1 +
        srcData[i10] * fx * fy1 +
        srcData[i01] * fx1 * fy +
        srcData[i11] * fx * fy;
      const g =
        srcData[i00 + 1] * fx1 * fy1 +
        srcData[i10 + 1] * fx * fy1 +
        srcData[i01 + 1] * fx1 * fy +
        srcData[i11 + 1] * fx * fy;
      const b =
        srcData[i00 + 2] * fx1 * fy1 +
        srcData[i10 + 2] * fx * fy1 +
        srcData[i01 + 2] * fx1 * fy +
        srcData[i11 + 2] * fx * fy;

      dstData[dstIdx] = r;
      dstData[dstIdx + 1] = g;
      dstData[dstIdx + 2] = b;
      dstData[dstIdx + 3] = 255;

      if (isGreenVegetation(r, g, b)) {
        colGreenCount[x] += 1;
      }
    }
  }
  dstCtx.putImageData(dstImg, 0, 0);

  // Smooth column vegetation profile to distinguish Crop Ridges (peaks) vs Furrows (valleys)
  const colProfile = new Float32Array(bevW);
  const win = 10;
  for (let x = 0; x < bevW; x++) {
    let sum = 0;
    let cnt = 0;
    for (let k = Math.max(0, x - win); k <= Math.min(bevW - 1, x + win); k++) {
      sum += colGreenCount[k] / bevH;
      cnt++;
    }
    colProfile[x] = cnt > 0 ? sum / cnt : 0;
  }

  let meanCol = 0;
  for (let x = 0; x < bevW; x++) meanCol += colProfile[x];
  meanCol /= bevW;

  // Detect Crop Ridges (local maxima of ExG)
  const minSep = Math.max(36, Math.floor(bevW / 12));
  const rawRidges: number[] = [];
  const ridgeThresh = Math.max(meanCol * 0.55, 0.03);
  for (let x = 14; x < bevW - 14; x++) {
    if (
      colProfile[x] > colProfile[x - 1] &&
      colProfile[x] >= colProfile[x + 1] &&
      colProfile[x] > ridgeThresh
    ) {
      rawRidges.push(x);
    }
  }
  rawRidges.sort((a, b) => colProfile[b] - colProfile[a]);
  const keptRidges: number[] = [];
  for (const r of rawRidges) {
    if (keptRidges.every((k) => Math.abs(k - r) >= minSep)) {
      keptRidges.push(r);
    }
  }
  keptRidges.sort((a, b) => a - b);

  // Build normalized Ridges & Traversable Furrows (NEVER fabricate fake lanes if <2 ridges exist)
  const ridgesNx = keptRidges.map((x) => Number((x / bevW).toFixed(4)));
  const furrowsNx: number[] = [];

  if (ridgesNx.length >= 2) {
    for (let i = 0; i < ridgesNx.length - 1; i++) {
      const xStart = Math.round(ridgesNx[i] * bevW) + 6;
      const xEnd = Math.round(ridgesNx[i + 1] * bevW) - 6;
      let bestX = Math.round(((ridgesNx[i] + ridgesNx[i + 1]) / 2) * bevW);
      let minVeg = Number.POSITIVE_INFINITY;
      for (let x = xStart; x <= xEnd; x++) {
        if (colProfile[x] < minVeg) {
          minVeg = colProfile[x];
          bestX = x;
        }
      }
      furrowsNx.push(Number((bestX / bevW).toFixed(4)));
    }
  }

  const furrowWidthNx =
    furrowsNx.length >= 2
      ? Math.min(0.14, ((furrowsNx[furrowsNx.length - 1] - furrowsNx[0]) / (furrowsNx.length - 1)) * 0.48)
      : 0.1;

  const confidence =
    ridgesNx.length < 2 || meanCol < 0.015
      ? Number(Math.min(0.25, vegCoverage * 1.2).toFixed(2))
      : Number(
          Math.min(
            0.98,
            Math.max(0.1, Math.min(1, ridgesNx.length / 5) * 0.65 + Math.min(1, vegCoverage / 0.18) * 0.35)
          ).toFixed(2)
        );

  const ready = confidence >= MIN_DETECTION_CONFIDENCE && furrowsNx.length >= 1;

  return {
    sourceWidth: srcW,
    sourceHeight: srcH,
    detectedCorners,
    bevDataUrl: dstCanvas.toDataURL('image/jpeg', 0.92),
    bevWidth: bevW,
    bevHeight: bevH,
    ridgesNx,
    furrowsNx,
    furrowWidthNx,
    vegetationCoverage: vegCoverage,
    confidence,
    ready,
  };
}

/**
 * Step 3 on Pi:
 * Generates the optimal Boustrophedon serpentine furrow route strictly between
 * the farmer's tapped [Start] and [End] points. Returns [] when no valid furrows exist.
 */
export function buildTwoPointSerpentineRoute(
  furrowsNx: number[],
  start: NormalizedPoint | null,
  end: NormalizedPoint | null
): FurrowWaypoint[] {
  if (furrowsNx.length === 0 || !start) return [];
  const lanes = [...furrowsNx].sort((a, b) => a - b);
  const resolvedEnd: NormalizedPoint = end ?? {
    nx: Math.abs(start.nx - lanes[0]) < Math.abs(start.nx - lanes[lanes.length - 1])
      ? lanes[lanes.length - 1]
      : lanes[0],
    ny: start.ny > 0.5 ? 0.1 : 0.9,
  };

  // Snap Start and End to nearest traversable furrow lanes
  const nearestIdx = (nx: number) => {
    let best = 0;
    let bestD = Number.POSITIVE_INFINITY;
    lanes.forEach((fx, i) => {
      const d = Math.abs(fx - nx);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };

  const sIdx = nearestIdx(start.nx);
  const eIdx = nearestIdx(resolvedEnd.nx);
  const step = eIdx >= sIdx ? 1 : -1;

  const chosenIndices: number[] = [];
  for (let i = sIdx; step > 0 ? i <= eIdx : i >= eIdx; i += step) {
    chosenIndices.push(i);
  }

  const topHeadland = 0.09;
  const botHeadland = 0.91;
  // Determine initial furrow travel direction from Start Y
  let goingNorth = start.ny >= 0.5;

  const waypoints: FurrowWaypoint[] = [];
  chosenIndices.forEach((laneIdx, idx) => {
    const fx = lanes[laneIdx];
    const isFirst = idx === 0;
    const isLast = idx === chosenIndices.length - 1;

    const entryY = isFirst ? Math.max(topHeadland, Math.min(botHeadland, start.ny)) : goingNorth ? botHeadland : topHeadland;
    const exitY = isLast
      ? Math.max(topHeadland, Math.min(botHeadland, resolvedEnd.ny))
      : goingNorth
      ? topHeadland
      : botHeadland;

    waypoints.push({
      nx: fx,
      ny: entryY,
      kind: isFirst ? 'START' : 'U_TURN',
      furrowIndex: laneIdx + 1,
    });
    waypoints.push({
      nx: fx,
      ny: exitY,
      kind: isLast ? 'END' : 'FURROW_RUN',
      furrowIndex: laneIdx + 1,
    });

    goingNorth = !goingNorth;
  });

  return waypoints;
}
