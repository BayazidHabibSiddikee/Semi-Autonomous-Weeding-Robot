import {
  FieldCorners,
  HomographyCalibration,
  ImagePoint,
  RowDetectionResult,
  areCornersValidForImage,
  cornersToList,
} from './models';

/**
 * Solve an 8x8 linear system A * x = b using Gaussian elimination with partial pivoting.
 */
function solveLinear8(A: number[][], b: number[]): number[] {
  const n = 8;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let maxRow = col;
    let maxVal = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r++) {
      const val = Math.abs(M[r][col]);
      if (val > maxVal) {
        maxVal = val;
        maxRow = r;
      }
    }
    if (maxVal < 1e-12) {
      throw new Error('Degenerate homography: corners may be collinear.');
    }
    if (maxRow !== col) {
      const tmp = M[col];
      M[col] = M[maxRow];
      M[maxRow] = tmp;
    }

    const pivot = M[col][col];
    for (let j = col; j <= n; j++) {
      M[col][j] /= pivot;
    }

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      for (let j = col; j <= n; j++) {
        M[r][j] -= factor * M[col][j];
      }
    }
  }

  return M.map((row) => row[n]);
}

/**
 * Compute 3x3 perspective transform (homography) mapping srcPts -> dstPts.
 */
export function computeHomography(srcPts: ImagePoint[], dstPts: ImagePoint[]): number[] {
  if (srcPts.length !== 4 || dstPts.length !== 4) {
    throw new Error('Need exactly 4 corner points');
  }

  const A: number[][] = [];
  const b: number[] = [];

  for (let i = 0; i < 4; i++) {
    const x = srcPts[i].x;
    const y = srcPts[i].y;
    const u = dstPts[i].x;
    const v = dstPts[i].y;

    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);

    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }

  const h = solveLinear8(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/**
 * Warp a source HTMLImageElement into a top-down Bird's Eye View using a
 * 4-point homography with bilinear interpolation.
 */
export function warpToBEV(
  image: HTMLImageElement,
  corners: FieldCorners,
  outputW: number,
  outputH: number,
  fieldWidthM: number,
  fieldLengthM: number
): { bevDataUrl: string; bevImageData: ImageData; calibration: HomographyCalibration } {
  const srcW = image.naturalWidth || image.width;
  const srcH = image.naturalHeight || image.height;
  if (srcW <= 0 || srcH <= 0) {
    throw new Error('Invalid source image dimensions');
  }
  if (!areCornersValidForImage(corners, srcW, srcH)) {
    throw new Error(
      'Invalid corners: select 4 clockwise convex corners (TL → TR → BR → BL) inside the image covering at least 2% area.'
    );
  }

  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = srcW;
  srcCanvas.height = srcH;
  const srcCtx = srcCanvas.getContext('2d');
  if (!srcCtx) throw new Error('Canvas 2D context unavailable');
  srcCtx.drawImage(image, 0, 0, srcW, srcH);
  const srcData = srcCtx.getImageData(0, 0, srcW, srcH).data;

  const srcPts = cornersToList(corners);
  const dstPts: ImagePoint[] = [
    { x: 0, y: 0 },
    { x: outputW, y: 0 },
    { x: outputW, y: outputH },
    { x: 0, y: outputH },
  ];

  // Forward homography (src -> dst) for calibration record
  const forwardH = computeHomography(srcPts, dstPts);
  // Inverse homography (dst -> src) for backward warp sampling
  const invH = computeHomography(dstPts, srcPts);

  const dstCanvas = document.createElement('canvas');
  dstCanvas.width = outputW;
  dstCanvas.height = outputH;
  const dstCtx = dstCanvas.getContext('2d');
  if (!dstCtx) throw new Error('Canvas 2D context unavailable');
  const dstImg = dstCtx.createImageData(outputW, outputH);
  const dstData = dstImg.data;

  const [h0, h1, h2, h3, h4, h5, h6, h7, h8] = invH;

  for (let y = 0; y < outputH; y++) {
    for (let x = 0; x < outputW; x++) {
      const w = h6 * x + h7 * y + h8;
      if (Math.abs(w) < 1e-8) continue;
      const sx = (h0 * x + h1 * y + h2) / w;
      const sy = (h3 * x + h4 * y + h5) / w;

      const dstIdx = (y * outputW + x) * 4;
      if (sx < 0 || sy < 0 || sx >= srcW - 1 || sy >= srcH - 1) {
        dstData[dstIdx] = 0;
        dstData[dstIdx + 1] = 0;
        dstData[dstIdx + 2] = 0;
        dstData[dstIdx + 3] = 255;
        continue;
      }

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const fx1 = 1 - fx;
      const fy1 = 1 - fy;

      const idx00 = (y0 * srcW + x0) * 4;
      const idx10 = idx00 + 4;
      const idx01 = idx00 + srcW * 4;
      const idx11 = idx01 + 4;

      const w00 = fx1 * fy1;
      const w10 = fx * fy1;
      const w01 = fx1 * fy;
      const w11 = fx * fy;

      dstData[dstIdx] =
        srcData[idx00] * w00 +
        srcData[idx10] * w10 +
        srcData[idx01] * w01 +
        srcData[idx11] * w11;
      dstData[dstIdx + 1] =
        srcData[idx00 + 1] * w00 +
        srcData[idx10 + 1] * w10 +
        srcData[idx01 + 1] * w01 +
        srcData[idx11 + 1] * w11;
      dstData[dstIdx + 2] =
        srcData[idx00 + 2] * w00 +
        srcData[idx10 + 2] * w10 +
        srcData[idx01 + 2] * w01 +
        srcData[idx11 + 2] * w11;
      dstData[dstIdx + 3] = 255;
    }
  }

  dstCtx.putImageData(dstImg, 0, 0);

  return {
    bevDataUrl: dstCanvas.toDataURL('image/jpeg', 0.92),
    bevImageData: dstImg,
    calibration: {
      sourceCorners: corners,
      destWidth: outputW,
      destHeight: outputH,
      matrix: forwardH,
      fieldWidthM,
      fieldLengthM,
    },
  };
}

/**
 * Exact TypeScript port of the fixed RowDetector.kt:
 * 1. Excess Green Index (ExG = 2*G - R - B > 0)
 * 2. HSV vegetation mask (H in [20, 100] OpenCV 0-180 scale, S >= 25, V >= 25)
 * 3. Directional morphological vertical closing (3x15)
 * 4. Smoothed column projection & non-maximum peak suppression
 * 5. Honest confidence [0.0, 0.98] without row fabrication when vegetation evidence is absent
 */
export function detectRowsFromImageData(
  imageData: ImageData,
  expectedCount?: number
): RowDetectionResult {
  const width = imageData.width;
  const height = imageData.height;
  const data = imageData.data;

  // 1 & 2: Combined ExG + HSV vegetation mask
  const vegMask = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    if (2 * g - r - b <= 0) continue;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    const v = max;
    const s = max === 0 ? 0 : (delta * 255) / max;

    let hDeg = 0;
    if (delta > 0) {
      if (max === r) {
        hDeg = 60 * (((g - b) / delta) % 6);
      } else if (max === g) {
        hDeg = 60 * ((b - r) / delta + 2);
      } else {
        hDeg = 60 * ((r - g) / delta + 4);
      }
      if (hDeg < 0) hDeg += 360;
    }
    const hOpenCv = hDeg / 2; // 0..180 scale

    if (hOpenCv >= 20 && hOpenCv <= 100 && s >= 25 && v >= 25) {
      vegMask[p] = 1;
    }
  }

  // 3. Separable morphological closing with 3x15 kernel (dilate then erode)
  const closed = morphCloseRect(vegMask, width, height, 1, 7);

  // 4. Column projection
  const colGreen = new Float32Array(width);
  for (let c = 0; c < width; c++) {
    let count = 0;
    for (let r = 0; r < height; r++) {
      if (closed[r * width + c] > 0) count++;
    }
    colGreen[c] = count / height;
  }

  // 5. 1D triangle-weighted smoothing
  const expectedN = Math.max(1, expectedCount ?? 10);
  const winR = Math.max(4, Math.min(24, Math.floor(width / (expectedN * 4))));
  const smoothed = new Float32Array(width);
  for (let i = 0; i < width; i++) {
    let sum = 0;
    let weight = 0;
    const r0 = Math.max(0, i - winR);
    const r1 = Math.min(width - 1, i + winR);
    for (let j = r0; j <= r1; j++) {
      const w = winR + 1 - Math.abs(i - j);
      sum += colGreen[j] * w;
      weight += w;
    }
    smoothed[i] = weight > 0 ? sum / weight : 0;
  }

  // 6. Prominent peak detection
  let meanSum = 0;
  for (let i = 0; i < width; i++) meanSum += smoothed[i];
  const meanGreen = meanSum / width;
  const peakThreshold = Math.max(meanGreen * 0.45, 0.03);
  const minDistance = Math.max(15, Math.floor((width / expectedN) * 0.5));

  const rawPeaks: number[] = [];
  for (let c = 1; c < width - 1; c++) {
    if (smoothed[c] > smoothed[c - 1] && smoothed[c] >= smoothed[c + 1] && smoothed[c] > peakThreshold) {
      rawPeaks.push(c);
    }
  }

  rawPeaks.sort((a, b) => smoothed[b] - smoothed[a]);
  const filteredPeaks: number[] = [];
  for (const p of rawPeaks) {
    if (filteredPeaks.every((existing) => Math.abs(existing - p) >= minDistance)) {
      filteredPeaks.push(p);
    }
  }
  const detectedCenters = filteredPeaks.sort((a, b) => a - b);

  // 7. Only align to expected grid when genuine crop-row evidence exists (>= 50% of expected and >= 2 peaks)
  const nominalStep = width / expectedN;
  const minRequiredForAlignment = Math.max(2, Math.ceil(expectedN / 2));
  let finalCenters: number[];

  if (meanGreen < 0.01 || detectedCenters.length === 0) {
    finalCenters = [];
  } else if (detectedCenters.length === expectedN) {
    finalCenters = detectedCenters;
  } else if (detectedCenters.length >= minRequiredForAlignment) {
    const offsets = detectedCenters
      .map((x) => {
        const slot = Math.max(0, Math.min(expectedN - 1, Math.floor(x / nominalStep - 0.5)));
        return x - (slot + 0.5) * nominalStep;
      })
      .sort((a, b) => a - b);

    const rawMedian = offsets[Math.floor(offsets.length / 2)];
    const medianOffset = Math.max(-nominalStep * 0.35, Math.min(nominalStep * 0.35, rawMedian));

    finalCenters = Array.from({ length: expectedN }, (_, i) => {
      const nominal = (i + 0.5) * nominalStep + medianOffset;
      const close = detectedCenters.find((x) => Math.abs(x - nominal) < nominalStep * 0.4);
      const val = close ?? nominal;
      return Math.max(4, Math.min(width - 4, val));
    });
  } else {
    // Do NOT fabricate rows when vegetation evidence is weak
    finalCenters = detectedCenters;
  }

  let spacing = 0;
  if (finalCenters.length >= 2) {
    let diffSum = 0;
    for (let i = 1; i < finalCenters.length; i++) {
      diffSum += Math.abs(finalCenters[i] - finalCenters[i - 1]);
    }
    spacing = diffSum / (finalCenters.length - 1);
  }

  const confidence = computeConfidence(detectedCenters, expectedN, meanGreen);

  return {
    rowCount: finalCenters.length,
    rowCentersX: finalCenters,
    rowSpacingPx: spacing,
    confidence,
    bevWidth: width,
    bevHeight: height,
    detectedRowCount: detectedCenters.length,
  };
}

function morphCloseRect(
  src: Uint8Array,
  w: number,
  h: number,
  rx: number,
  ry: number
): Uint8Array {
  // Dilate horizontal then vertical
  const dilH = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const rowOff = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - rx);
      const x1 = Math.min(w - 1, x + rx);
      let hit = 0;
      for (let k = x0; k <= x1; k++) {
        if (src[rowOff + k]) {
          hit = 1;
          break;
        }
      }
      dilH[rowOff + x] = hit;
    }
  }

  const dilV = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - ry);
      const y1 = Math.min(h - 1, y + ry);
      let hit = 0;
      for (let k = y0; k <= y1; k++) {
        if (dilH[k * w + x]) {
          hit = 1;
          break;
        }
      }
      dilV[y * w + x] = hit;
    }
  }

  // Erode horizontal then vertical
  const eroH = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const rowOff = y * w;
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - rx);
      const x1 = Math.min(w - 1, x + rx);
      let all = 1;
      for (let k = x0; k <= x1; k++) {
        if (!dilV[rowOff + k]) {
          all = 0;
          break;
        }
      }
      eroH[rowOff + x] = all;
    }
  }

  const out = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - ry);
      const y1 = Math.min(h - 1, y + ry);
      let all = 1;
      for (let k = y0; k <= y1; k++) {
        if (!eroH[k * w + x]) {
          all = 0;
          break;
        }
      }
      out[y * w + x] = all;
    }
  }

  return out;
}

function computeConfidence(detected: number[], expected: number, meanGreen: number): number {
  if (detected.length === 0 || meanGreen < 0.01) return 0.0;

  const detectionRatio = Math.max(0, Math.min(1, detected.length / Math.max(1, expected)));
  let uniformity = 0.35;
  if (detected.length >= 2) {
    const diffs: number[] = [];
    for (let i = 1; i < detected.length; i++) {
      diffs.push(Math.abs(detected[i] - detected[i - 1]));
    }
    const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const maxDev = diffs.reduce((m, d) => Math.max(m, Math.abs(d - avg)), 0);
    uniformity = 1 - Math.max(0, Math.min(1, maxDev / (avg + 0.001)));
  }
  const vegSignal = Math.max(0, Math.min(1, meanGreen / 0.12));

  const score = 0.5 * detectionRatio + 0.3 * uniformity + 0.2 * vegSignal;
  return Math.max(0.0, Math.min(0.98, score));
}
