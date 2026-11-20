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
}

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
 * Minimum-area oriented bounding rectangle (cv2.minAreaRect equivalent)
 * ordered clockwise as TL -> TR -> BR -> BL.
 */
function computeMinAreaRect(points: ImagePoint[], maxW: number, maxH: number): FieldCorners {
  const hull = convexHull(points);
  if (hull.length < 3) {
    return {
      topLeft: { x: maxW * 0.08, y: maxH * 0.1 },
      topRight: { x: maxW * 0.92, y: maxH * 0.1 },
      bottomRight: { x: maxW * 0.92, y: maxH * 0.9 },
      bottomLeft: { x: maxW * 0.08, y: maxH * 0.9 },
    };
  }

  let bestArea = Number.POSITIVE_INFINITY;
  let bestBox: ImagePoint[] = [];

  for (let i = 0; i < hull.length; i++) {
    const p1 = hull[i];
    const p2 = hull[(i + 1) % hull.length];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-4) continue;

    const ux = dx / len;
    const uy = dy / len;
    const vx = -uy;
    const vy = ux;

    let minU = Number.POSITIVE_INFINITY;
    let maxU = Number.NEGATIVE_INFINITY;
    let minV = Number.POSITIVE_INFINITY;
    let maxV = Number.NEGATIVE_INFINITY;

    for (const p of hull) {
      const u = p.x * ux + p.y * uy;
      const v = p.x * vx + p.y * vy;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }

    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea) {
      bestArea = area;
      bestBox = [
        { x: minU * ux + minV * vx, y: minU * uy + minV * vy },
        { x: maxU * ux + minV * vx, y: maxU * uy + minV * vy },
        { x: maxU * ux + maxV * vx, y: maxU * uy + maxV * vy },
        { x: minU * ux + maxV * vx, y: minU * uy + maxV * vy },
      ];
    }
  }

  // Slight margin expansion so full outer rows & headlands are included, clipped to image bounds
  const cx = bestBox.reduce((s, p) => s + p.x, 0) / 4;
  const cy = bestBox.reduce((s, p) => s + p.y, 0) / 4;
  const expanded = bestBox.map((p) => ({
    x: Math.max(2, Math.min(maxW - 2, cx + (p.x - cx) * 1.03)),
    y: Math.max(2, Math.min(maxH - 2, cy + (p.y - cy) * 1.03)),
  }));

  // Order clockwise: TL, TR, BR, BL
  const tl = expanded.reduce((a, b) => (a.x + a.y < b.x + b.y ? a : b));
  const br = expanded.reduce((a, b) => (a.x + a.y > b.x + b.y ? a : b));
  const tr = expanded.reduce((a, b) => (a.y - a.x < b.y - b.x ? a : b));
  const bl = expanded.reduce((a, b) => (a.y - a.x > b.y - b.x ? a : b));

  return {
    topLeft: tl,
    topRight: tr,
    bottomRight: br,
    bottomLeft: bl,
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
 * Automatically finds field corners via ExG + minAreaRect, warps to 2D Top-Down BEV,
 * and segments Crop Ridges vs. Traversable Furrows.
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

  // 1. Sample ExG vegetation pixels for automatic boundary detection (minAreaRect)
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
  const detectedCorners =
    vegPoints.length >= 20
      ? computeMinAreaRect(vegPoints, srcW, srcH)
      : {
          topLeft: { x: srcW * 0.08, y: srcH * 0.1 },
          topRight: { x: srcW * 0.92, y: srcH * 0.1 },
          bottomRight: { x: srcW * 0.92, y: srcH * 0.9 },
          bottomLeft: { x: srcW * 0.08, y: srcH * 0.9 },
        };

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

  // Build normalized Ridges & Traversable Furrows (soil valleys between crop ridges)
  let ridgesNx = keptRidges.map((x) => Number((x / bevW).toFixed(4)));
  let furrowsNx: number[] = [];

  if (ridgesNx.length >= 2) {
    for (let i = 0; i < ridgesNx.length - 1; i++) {
      // Find deepest soil valley between ridge i and ridge i+1
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
  } else {
    // Clean default 5-ridge / 4-furrow layout if user uploads a low-contrast photo
    ridgesNx = [0.1, 0.3, 0.5, 0.7, 0.9];
    furrowsNx = [0.2, 0.4, 0.6, 0.8];
  }

  const furrowWidthNx =
    furrowsNx.length >= 2
      ? Math.min(0.14, (furrowsNx[furrowsNx.length - 1] - furrowsNx[0]) / (furrowsNx.length - 1) * 0.48)
      : 0.1;

  const confidence = Math.min(
    0.98,
    Math.max(0.15, Math.min(1, ridgesNx.length / 5) * 0.65 + Math.min(1, vegCoverage / 0.18) * 0.35)
  );

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
  };
}

/**
 * Step 3 on Pi:
 * Generates the optimal Boustrophedon serpentine furrow route strictly between
 * the farmer's tapped [Start] and [End] points.
 */
export function buildTwoPointSerpentineRoute(
  furrowsNx: number[],
  start: NormalizedPoint,
  end: NormalizedPoint | null
): FurrowWaypoint[] {
  const lanes = furrowsNx.length > 0 ? [...furrowsNx].sort((a, b) => a - b) : [0.2, 0.4, 0.6, 0.8];
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
