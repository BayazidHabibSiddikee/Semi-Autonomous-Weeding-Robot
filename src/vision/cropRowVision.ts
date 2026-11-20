/**
 * Real-Time Browser Computer Vision Pipeline
 * Ports ros2_ws/src/crop_row_navigation/row_detector.py & row_tracker.py
 * (Sowbot ExG + Otsu adaptive thresholding + PRBonn horizontal strip centerline fitting)
 * plus connected-component vegetation blob detection for downward weed inspection.
 *
 * Runs directly on live HTMLVideoElement / HTMLImageElement ImageData buffers.
 */

export interface StripDetection {
  y: number; // ROI-local Y in px
  leftX: number;
  rightX: number;
  centerX: number;
}

export interface RealRowObservation {
  valid: boolean;
  mode: 'dual_row' | 'single_band' | 'none';
  lateralErrorM: number; // +ve = rover shifted right of centerline
  headingErrorRad: number; // +ve = rover pointed right of row tangent
  rowEndConfidence: number; // 0..1
  leftRowXPx: number;
  rightRowXPx: number;
  centerBottomPx: number;
  centerTopPx: number;
  greenRatioNear: number;
  greenRatioFar: number;
  otsuThreshold: number;
  strips: StripDetection[];
  roiTopPx: number;
  roiBottomPx: number;
  processingMs: number;
}

export interface RealVisionTrackerState {
  trackingLocked: boolean;
  lateralOffsetM: number;
  rawLateralOffsetM: number;
  headingErrorRad: number;
  rawHeadingErrorRad: number;
  rowEndConfidence: number;
  missedFrames: number;
}

export interface FoliageBlob {
  id: number;
  // Normalized 0..1 coordinates within frame
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  pixelArea: number;
  meanExg: number;
  elongation: number;
  classification: 'crop_canopy' | 'weed_candidate';
  confidence: number;
  groundMm: [number, number];
}

export type CameraOverlayMode = 'overlay' | 'mask' | 'raw';

/**
 * Exact Otsu's Method threshold over an 8-bit grayscale buffer.
 */
function computeOtsuThreshold(gray: Uint8Array): number {
  const hist = new Int32Array(256);
  const total = gray.length;
  for (let i = 0; i < total; i++) {
    hist[gray[i]]++;
  }

  let sum = 0;
  for (let t = 0; t < 256; t++) {
    sum += t * hist[t];
  }

  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let threshold = 128;

  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;

    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const diff = mB - mF;
    const betweenVar = wB * wF * diff * diff;
    if (betweenVar > maxVar) {
      maxVar = betweenVar;
      threshold = t;
    }
  }

  return threshold;
}

/**
 * Fast 3x3 morphological opening (erode -> dilate) on a binary (0 | 255) mask
 * to remove isolated single-pixel camera noise.
 */
function morphOpen3x3(src: Uint8Array, w: number, h: number): Uint8Array {
  const eroded = new Uint8Array(w * h);
  const opened = new Uint8Array(w * h);

  // Erode: keep pixel if >= 5 of 9 neighbors are foreground (gentle 3x3 speckle filter)
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const idx = row + x;
      if (src[idx] === 0) continue;
      let count = 0;
      if (src[idx - w - 1]) count++;
      if (src[idx - w]) count++;
      if (src[idx - w + 1]) count++;
      if (src[idx - 1]) count++;
      count++; // self
      if (src[idx + 1]) count++;
      if (src[idx + w - 1]) count++;
      if (src[idx + w]) count++;
      if (src[idx + w + 1]) count++;
      if (count >= 5) eroded[idx] = 255;
    }
  }

  // Dilate: restore eroded foliage borders
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const idx = row + x;
      if (
        eroded[idx] ||
        eroded[idx - 1] ||
        eroded[idx + 1] ||
        eroded[idx - w] ||
        eroded[idx + w]
      ) {
        opened[idx] = 255;
      }
    }
  }

  return opened;
}

/**
 * Compute Excess Green (2G - R - B) + Otsu adaptive binary foliage mask on an RGBA frame ROI.
 * Also applies a physical ExG floor so scenes with zero green (e.g. indoor gray/white wall)
 * do not produce false Otsu foreground blobs.
 */
export function computeExgOtsuMask(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  roiTopPx: number,
  roiBottomPx: number,
  minExgFloor = 22
): {
  mask: Uint8Array;
  exgRaw: Int16Array;
  roiW: number;
  roiH: number;
  otsuThreshold: number;
} {
  const roiW = width;
  const roiH = Math.max(1, roiBottomPx - roiTopPx);
  const count = roiW * roiH;
  const exgRaw = new Int16Array(count);
  const exgNorm = new Uint8Array(count);

  let minVal = 510;
  let maxVal = -510;

  let dstIdx = 0;
  for (let y = roiTopPx; y < roiBottomPx; y++) {
    let p = y * width * 4;
    for (let x = 0; x < width; x++) {
      const r = rgba[p];
      const g = rgba[p + 1];
      const b = rgba[p + 2];
      // Excess Green: 2G - R - B (range -510..+510)
      const exg = (g << 1) - r - b;
      exgRaw[dstIdx++] = exg;
      if (exg < minVal) minVal = exg;
      if (exg > maxVal) maxVal = exg;
      p += 4;
    }
  }

  const span = Math.max(1, maxVal - minVal);
  for (let i = 0; i < count; i++) {
    exgNorm[i] = Math.round(((exgRaw[i] - minVal) / span) * 255);
  }

  const otsuNorm = computeOtsuThreshold(exgNorm);
  const otsuExg = minVal + (otsuNorm / 255) * span;
  const effectiveExgThresh = Math.max(minExgFloor, otsuExg);

  const rawMask = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    if (exgRaw[i] >= effectiveExgThresh) {
      rawMask[i] = 255;
    }
  }

  const mask = morphOpen3x3(rawMask, roiW, roiH);

  return {
    mask,
    exgRaw,
    roiW,
    roiH,
    otsuThreshold: Math.round(effectiveExgThresh),
  };
}

/**
 * Simple least-squares linear regression: x = slope * y + intercept
 */
function fitLineXofY(ys: number[], xs: number[]): { slope: number; intercept: number } {
  const n = ys.length;
  let sumY = 0;
  let sumX = 0;
  let sumYY = 0;
  let sumYX = 0;
  for (let i = 0; i < n; i++) {
    sumY += ys[i];
    sumX += xs[i];
    sumYY += ys[i] * ys[i];
    sumYX += ys[i] * xs[i];
  }
  const denom = n * sumYY - sumY * sumY;
  if (Math.abs(denom) < 1e-6) {
    return { slope: 0, intercept: sumX / Math.max(1, n) };
  }
  const slope = (n * sumYX - sumY * sumX) / denom;
  const intercept = (sumX - slope * sumY) / n;
  return { slope, intercept };
}

/**
 * Real-time CropRowDetector running on RGBA ImageData from a live camera or video frame.
 */
export function detectCropRowFromFrame(
  imageData: ImageData,
  options: {
    rowWidthM: number;
    minExgFloor?: number;
    roiTopFrac?: number;
    roiBottomFrac?: number;
    nStrips?: number;
    minGreenRatio?: number;
  }
): {
  observation: RealRowObservation;
  mask: Uint8Array;
  roiW: number;
  roiH: number;
} {
  const t0 = performance.now();
  const { width, height, data } = imageData;
  const roiTopFrac = options.roiTopFrac ?? 0.32;
  const roiBottomFrac = options.roiBottomFrac ?? 0.96;
  const nStrips = options.nStrips ?? 8;
  const minGreenRatio = options.minGreenRatio ?? 0.02;
  const minExgFloor = options.minExgFloor ?? 22;

  const roiTopPx = Math.floor(height * roiTopFrac);
  const roiBottomPx = Math.floor(height * roiBottomFrac);

  const { mask, roiW, roiH, otsuThreshold } = computeExgOtsuMask(
    data,
    width,
    height,
    roiTopPx,
    roiBottomPx,
    minExgFloor
  );

  const midX = roiW / 2;
  const farEndRow = Math.max(1, Math.floor(roiH / 3));
  const nearStartRow = Math.floor(roiH / 2);

  let farGreen = 0;
  for (let i = 0; i < farEndRow * roiW; i++) {
    if (mask[i]) farGreen++;
  }
  let nearGreen = 0;
  for (let i = nearStartRow * roiW; i < roiH * roiW; i++) {
    if (mask[i]) nearGreen++;
  }

  const greenFar = farGreen / Math.max(1, farEndRow * roiW);
  const greenNear = nearGreen / Math.max(1, (roiH - nearStartRow) * roiW);

  if (greenNear < minGreenRatio && greenFar < minGreenRatio) {
    return {
      observation: {
        valid: false,
        mode: 'none',
        lateralErrorM: 0,
        headingErrorRad: 0,
        rowEndConfidence: 1.0,
        leftRowXPx: width * 0.25,
        rightRowXPx: width * 0.75,
        centerBottomPx: midX,
        centerTopPx: midX,
        greenRatioNear: greenNear,
        greenRatioFar: greenFar,
        otsuThreshold,
        strips: [],
        roiTopPx,
        roiBottomPx,
        processingMs: performance.now() - t0,
      },
      mask,
      roiW,
      roiH,
    };
  }

  const stripH = Math.max(1, Math.floor(roiH / nStrips));
  const dualStrips: StripDetection[] = [];
  const singleStrips: StripDetection[] = [];
  const colHist = new Float32Array(roiW);
  const smoothHist = new Float32Array(roiW);

  const halfInt = Math.floor(midX);

  for (let idx = 0; idx < nStrips; idx++) {
    const sy0 = idx * stripH;
    const sy1 = Math.min(roiH, (idx + 1) * stripH);
    const syMid = 0.5 * (sy0 + sy1);
    colHist.fill(0);

    for (let y = sy0; y < sy1; y++) {
      const rowOff = y * roiW;
      for (let x = 0; x < roiW; x++) {
        if (mask[rowOff + x]) colHist[x] += 1;
      }
    }

    // 5-pixel box smoothing on horizontal column histogram to stabilize peak selection
    for (let x = 0; x < roiW; x++) {
      let acc = 0;
      let cnt = 0;
      for (let k = -2; k <= 2; k++) {
        const nx = x + k;
        if (nx >= 0 && nx < roiW) {
          acc += colHist[nx];
          cnt++;
        }
      }
      smoothHist[x] = acc / cnt;
    }

    // Dual-row peak search (left half vs right half, exact port of row_detector.py)
    let leftMax = 0;
    let leftIdx = 0;
    for (let x = 0; x < halfInt; x++) {
      if (smoothHist[x] > leftMax) {
        leftMax = smoothHist[x];
        leftIdx = x;
      }
    }

    let rightMax = 0;
    let rightIdx = halfInt;
    for (let x = halfInt; x < roiW; x++) {
      if (smoothHist[x] > rightMax) {
        rightMax = smoothHist[x];
        rightIdx = x;
      }
    }

    const minPeak = Math.max(1.2, (sy1 - sy0) * 0.08);
    if (leftMax >= minPeak && rightMax >= minPeak && rightIdx - leftIdx >= roiW * 0.16) {
      dualStrips.push({
        y: syMid,
        leftX: leftIdx,
        rightX: rightIdx,
        centerX: 0.5 * (leftIdx + rightIdx),
      });
    }

    // Fallback single-row / single green band centroid (helpful when bench-testing with one plant/line)
    let weightedSum = 0;
    let totalMass = 0;
    let minActiveX = roiW;
    let maxActiveX = 0;
    for (let x = 0; x < roiW; x++) {
      if (colHist[x] > 0) {
        weightedSum += x * colHist[x];
        totalMass += colHist[x];
        if (x < minActiveX) minActiveX = x;
        if (x > maxActiveX) maxActiveX = x;
      }
    }
    if (totalMass >= Math.max(6, (sy1 - sy0) * 1.2)) {
      const cx = weightedSum / totalMass;
      singleStrips.push({
        y: syMid,
        leftX: minActiveX,
        rightX: maxActiveX,
        centerX: cx,
      });
    }
  }

  const useDual = dualStrips.length >= 2;
  const activeStrips = useDual ? dualStrips : singleStrips;

  if (activeStrips.length < 2) {
    const rowEndConf = Math.max(0, Math.min(1, 1 - greenFar / Math.max(minGreenRatio, 1e-4)));
    return {
      observation: {
        valid: false,
        mode: 'none',
        lateralErrorM: 0,
        headingErrorRad: 0,
        rowEndConfidence: rowEndConf,
        leftRowXPx: width * 0.25,
        rightRowXPx: width * 0.75,
        centerBottomPx: midX,
        centerTopPx: midX,
        greenRatioNear: greenNear,
        greenRatioFar: greenFar,
        otsuThreshold,
        strips: activeStrips,
        roiTopPx,
        roiBottomPx,
        processingMs: performance.now() - t0,
      },
      mask,
      roiW,
      roiH,
    };
  }

  const ys = activeStrips.map((s) => s.y);
  const xs = activeStrips.map((s) => s.centerX);
  const { slope, intercept } = fitLineXofY(ys, xs);

  const centerTopPx = intercept;
  const centerBotPx = slope * roiH + intercept;

  const meanLeftX = activeStrips.reduce((a, s) => a + s.leftX, 0) / activeStrips.length;
  const meanRightX = activeStrips.reduce((a, s) => a + s.rightX, 0) / activeStrips.length;
  const meanSpanPx = useDual
    ? Math.max(24, meanRightX - meanLeftX)
    : Math.max(roiW * 0.45, meanRightX - meanLeftX);

  const mPerPx = options.rowWidthM / meanSpanPx;
  const lateralErrorM = Math.max(-0.35, Math.min(0.35, (midX - centerBotPx) * mPerPx));
  const headingErrorRad = Math.max(
    -0.55,
    Math.min(0.55, Math.atan2(centerTopPx - centerBotPx, roiH))
  );

  const farDrop = 1.0 - Math.min(1.0, greenFar / Math.max(greenNear, minGreenRatio));
  const rowEndConf = Math.max(
    0,
    Math.min(1, greenFar < minGreenRatio * 1.4 ? farDrop : 0)
  );

  return {
    observation: {
      valid: true,
      mode: useDual ? 'dual_row' : 'single_band',
      lateralErrorM,
      headingErrorRad,
      rowEndConfidence: rowEndConf,
      leftRowXPx: meanLeftX,
      rightRowXPx: meanRightX,
      centerBottomPx: centerBotPx,
      centerTopPx,
      greenRatioNear: greenNear,
      greenRatioFar: greenFar,
      otsuThreshold,
      strips: activeStrips,
      roiTopPx,
      roiBottomPx,
      processingMs: performance.now() - t0,
    },
    mask,
    roiW,
    roiH,
  };
}

/**
 * Draw real-time CV overlay (ExG foliage mask, ROI, strip centroids, fitted centerline, and offset vector)
 * directly onto the display canvas.
 */
export function renderVisionOverlay(
  ctx: CanvasRenderingContext2D,
  sourceFrame: ImageData,
  mask: Uint8Array,
  obs: RealRowObservation,
  overlayMode: CameraOverlayMode,
  fps: number
) {
  const { width: W, height: H } = sourceFrame;

  if (overlayMode === 'mask') {
    const out = ctx.createImageData(W, H);
    const dst = out.data;
    const src = sourceFrame.data;
    // Dim non-ROI bands, show pure Otsu ExG binary foliage mask inside ROI
    for (let y = 0; y < H; y++) {
      const inRoi = y >= obs.roiTopPx && y < obs.roiBottomPx;
      const roiRow = (y - obs.roiTopPx) * W;
      for (let x = 0; x < W; x++) {
        const p = (y * W + x) * 4;
        if (!inRoi) {
          dst[p] = src[p] * 0.35;
          dst[p + 1] = src[p + 1] * 0.35;
          dst[p + 2] = src[p + 2] * 0.35;
          dst[p + 3] = 255;
        } else if (mask[roiRow + x]) {
          dst[p] = 16;
          dst[p + 1] = 215;
          dst[p + 2] = 125;
          dst[p + 3] = 255;
        } else {
          dst[p] = 15;
          dst[p + 1] = 23;
          dst[p + 2] = 20;
          dst[p + 3] = 255;
        }
      }
    }
    ctx.putImageData(out, 0, 0);
  } else if (overlayMode === 'overlay') {
    const out = ctx.createImageData(W, H);
    const dst = out.data;
    const src = sourceFrame.data;
    dst.set(src);

    // Blend emerald tint over actual ExG-segmented foliage pixels inside ROI
    for (let y = obs.roiTopPx; y < obs.roiBottomPx; y++) {
      const roiRow = (y - obs.roiTopPx) * W;
      for (let x = 0; x < W; x++) {
        if (mask[roiRow + x]) {
          const p = (y * W + x) * 4;
          dst[p] = Math.min(255, Math.round(src[p] * 0.52 + 12));
          dst[p + 1] = Math.min(255, Math.round(src[p + 1] * 0.58 + 108));
          dst[p + 2] = Math.min(255, Math.round(src[p + 2] * 0.52 + 52));
        }
      }
    }
    ctx.putImageData(out, 0, 0);
  } else {
    ctx.putImageData(sourceFrame, 0, 0);
  }

  if (overlayMode === 'raw') {
    // Minimal telemetry stamp only
    ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
    ctx.fillRect(6, 6, 178, 20);
    ctx.fillStyle = '#ECFDF5';
    ctx.font = '600 10px "IBM Plex Mono", monospace';
    ctx.fillText(`RAW LIVE · ${fps.toFixed(0)} FPS`, 12, 19);
    return;
  }

  // ROI boundary lines
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(0, obs.roiTopPx);
  ctx.lineTo(W, obs.roiTopPx);
  ctx.moveTo(0, obs.roiBottomPx);
  ctx.lineTo(W, obs.roiBottomPx);
  // Far ROI divider
  const farY = obs.roiTopPx + Math.floor((obs.roiBottomPx - obs.roiTopPx) / 3);
  ctx.moveTo(0, farY);
  ctx.lineTo(W, farY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Camera optical center vertical line
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.beginPath();
  ctx.moveTo(W / 2, obs.roiTopPx);
  ctx.lineTo(W / 2, obs.roiBottomPx);
  ctx.stroke();

  if (obs.valid && obs.strips.length >= 2) {
    // Detected strip peaks (left/right foliage peaks + midpoints)
    for (const st of obs.strips) {
      const py = obs.roiTopPx + st.y;
      ctx.fillStyle = '#4ADE80';
      ctx.beginPath();
      ctx.arc(st.leftX, py, 3, 0, Math.PI * 2);
      ctx.arc(st.rightX, py, 3, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#FBBF24';
      ctx.beginPath();
      ctx.arc(st.centerX, py, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Fitted centerline
    ctx.strokeStyle = '#34D399';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(obs.centerTopPx, obs.roiTopPx);
    ctx.lineTo(obs.centerBottomPx, obs.roiBottomPx);
    ctx.stroke();

    // Lateral offset bar at bottom of ROI
    ctx.strokeStyle = Math.abs(obs.lateralErrorM) > 0.08 ? '#FB7185' : '#F59E0B';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(W / 2, obs.roiBottomPx - 12);
    ctx.lineTo(obs.centerBottomPx, obs.roiBottomPx - 12);
    ctx.stroke();
  } else {
    ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
    ctx.fillRect(W / 2 - 118, H * 0.56 - 14, 236, 26);
    ctx.fillStyle = '#FDE68A';
    ctx.font = '600 10px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText('NO GREEN CROP FOLIAGE LOCK IN ROI', W / 2, H * 0.56 + 3);
    ctx.textAlign = 'left';
  }

  // Top telemetry bar
  ctx.fillStyle = 'rgba(15, 23, 42, 0.76)';
  ctx.fillRect(6, 6, W - 12, 20);
  ctx.fillStyle = '#A7F3D0';
  ctx.font = '600 10px "IBM Plex Mono", monospace';
  const modeTag =
    obs.mode === 'dual_row' ? '2-ROW' : obs.mode === 'single_band' ? '1-BAND' : 'SEARCH';
  ctx.fillText(
    `LIVE CV · ${modeTag} · ${fps.toFixed(0)} FPS · ${obs.processingMs.toFixed(1)}ms · ExG≥${obs.otsuThreshold}`,
    12,
    19
  );
}

/**
 * Real-time Connected-Component Foliage Blob Extractor for Downward Weed Inspection.
 * Runs BFS connected components on the ExG + Otsu mask and projects centroids through
 * the calibrated downward homography matrix H into ground-plane millimeters.
 */
export function detectFoliageBlobsFromFrame(
  imageData: ImageData,
  minExgFloor = 24,
  minBlobAreaPx = 45
): {
  blobs: FoliageBlob[];
  mask: Uint8Array;
  otsuThreshold: number;
  greenCoveragePct: number;
  processingMs: number;
} {
  const t0 = performance.now();
  const { width: W, height: H, data } = imageData;
  const { mask, exgRaw, otsuThreshold } = computeExgOtsuMask(data, W, H, 0, H, minExgFloor);

  const visited = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  const blobs: FoliageBlob[] = [];
  let totalGreen = 0;

  // Stride by 1 for accurate contours on 320x180 working resolution
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const start = y * W + x;
      if (!mask[start]) continue;
      totalGreen++;
      if (visited[start]) continue;

      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      visited[start] = 1;

      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let area = 0;
      let sumX = 0;
      let sumY = 0;
      let sumExg = 0;

      while (head < tail) {
        const idx = queue[head++];
        const cx = idx % W;
        const cy = (idx - cx) / W;
        area++;
        sumX += cx;
        sumY += cy;
        sumExg += exgRaw[idx];
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        // 4-connected neighbors
        if (cx > 0) {
          const n = idx - 1;
          if (mask[n] && !visited[n]) {
            visited[n] = 1;
            queue[tail++] = n;
          }
        }
        if (cx < W - 1) {
          const n = idx + 1;
          if (mask[n] && !visited[n]) {
            visited[n] = 1;
            queue[tail++] = n;
          }
        }
        if (cy > 0) {
          const n = idx - W;
          if (mask[n] && !visited[n]) {
            visited[n] = 1;
            queue[tail++] = n;
          }
        }
        if (cy < H - 1) {
          const n = idx + W;
          if (mask[n] && !visited[n]) {
            visited[n] = 1;
            queue[tail++] = n;
          }
        }
      }

      if (area >= minBlobAreaPx) {
        const bw = Math.max(1, maxX - minX + 1);
        const bh = Math.max(1, maxY - minY + 1);
        const meanExg = sumExg / area;
        const centerXNorm = sumX / area / W;
        const centerYNorm = sumY / area / H;
        const elongation = Math.max(bw / bh, bh / bw);

        // Map normalized coords to 1280x720 downward camera homography (calibration.py)
        const u = centerXNorm * 1280;
        const v = centerYNorm * 720;
        const groundX = 0.421 * u - 0.012 * v + 120.5;
        const groundY = 0.015 * u + 0.418 * v + 85.2;

        // Large central/dense foliage clusters classified as crop canopy; smaller scattered clusters as weed candidates
        const areaFrac = area / (W * H);
        const isCrop = areaFrac > 0.045;
        const confidence = Math.max(0.55, Math.min(0.99, 0.55 + (meanExg / 140) * 0.44));

        blobs.push({
          id: blobs.length + 1,
          x: minX / W,
          y: minY / H,
          width: bw / W,
          height: bh / H,
          centerX: centerXNorm,
          centerY: centerYNorm,
          pixelArea: area,
          meanExg,
          elongation,
          classification: isCrop ? 'crop_canopy' : 'weed_candidate',
          confidence,
          groundMm: [groundX, groundY],
        });
      }
    }
  }

  // Sort largest first, keep top 12 blobs
  blobs.sort((a, b) => b.pixelArea - a.pixelArea);

  return {
    blobs: blobs.slice(0, 12),
    mask,
    otsuThreshold,
    greenCoveragePct: (totalGreen / Math.max(1, W * H)) * 100,
    processingMs: performance.now() - t0,
  };
}
