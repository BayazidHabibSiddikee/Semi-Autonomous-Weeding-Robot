/**
 * Dynamic Animated Turn Trajectory Path Projection Overlay
 *
 * Computes a perspective-projected headland U-turn trajectory anchored to real-time
 * crop-row vision telemetry (centerline, furrow-end Y horizon, projected distance to furrow end)
 * and renders a smooth animated AR path corridor, traveling directional chevrons,
 * headland apex waypoints, and kinematic ghost pose marker directly onto the live camera canvas.
 */

export type ProjectedTurnDirection = 'right' | 'left';

export interface TurnTrajectoryOverlayParams {
  width: number;
  height: number;
  nowMs: number;
  turnDirection: ProjectedTurnDirection;
  turnRadiusM: number; // 0.35..0.90 m
  rowSpacingM: number; // 0.50..0.80 m
  centerBottomPx: number;
  centerTopPx: number;
  furrowEndYPx: number;
  distanceToFurrowEndM: number;
  rowEndConfidence: number;
  hasVisionLock: boolean;
  forceTurnAlertStyle: boolean;
}

interface Pt {
  x: number;
  y: number;
  nx: number; // unit normal x
  ny: number; // unit normal y
  tx: number; // unit tangent x
  ty: number; // unit tangent y
  t: number; // normalized arc progress 0..1
  halfWidthPx: number;
}

function cubicBezier(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
  u: number
): { x: number; y: number } {
  const m = 1 - u;
  const m2 = m * m;
  const u2 = u * u;
  return {
    x: m2 * m * p0.x + 3 * m2 * u * p1.x + 3 * m * u2 * p2.x + u2 * u * p3.x,
    y: m2 * m * p0.y + 3 * m2 * u * p1.y + 3 * m * u2 * p2.y + u2 * u * p3.y,
  };
}

/**
 * Sample a multi-segment perspective turn trajectory:
 *  Seg 1: Rover bumper -> Furrow-end exit point (following detected crop-row centerline)
 *  Seg 2: Furrow-end exit -> Headland turn apex (sweeping outward into open headland)
 *  Seg 3: Headland turn apex -> Adjacent crop-row re-entry alignment line
 */
function buildProjectedTurnPolyline(params: TurnTrajectoryOverlayParams): {
  points: Pt[];
  exitPt: { x: number; y: number };
  apexPt: { x: number; y: number };
  entryPt: { x: number; y: number };
  arcLengthM: number;
} {
  const {
    width: W,
    height: H,
    turnDirection,
    turnRadiusM,
    rowSpacingM,
    centerBottomPx,
    centerTopPx,
    furrowEndYPx,
    hasVisionLock,
  } = params;

  const sign = turnDirection === 'right' ? 1 : -1;

  // Anchor start at rover optical center near bottom edge, blending smoothly toward detected centerline
  const startX = hasVisionLock
    ? W * 0.5 + Math.max(-W * 0.16, Math.min(W * 0.16, (centerBottomPx - W * 0.5) * 0.65))
    : W * 0.5;
  const startY = H - 8;

  // Furrow-end horizon Y clamped into comfortable perspective band so full U-turn stays visible
  const exitY = Math.max(H * 0.36, Math.min(H * 0.68, furrowEndYPx));
  const rawExitX = hasVisionLock
    ? centerTopPx + (centerBottomPx - centerTopPx) * ((exitY - H * 0.32) / Math.max(1, H * 0.64))
    : W * 0.5;
  const exitX = Math.max(W * 0.28, Math.min(W * 0.72, rawExitX));

  // Perspective scale: row spacing & turn radius project into screen pixels at headland depth
  const depthFactor = 0.58 + ((exitY - H * 0.36) / Math.max(1, H * 0.32)) * 0.34;
  const lateralShiftPx = Math.min(W * 0.34, rowSpacingM * 175 * depthFactor);
  const headlandBulgePx = Math.min(exitY - 36, Math.max(28, turnRadiusM * 92 * depthFactor));

  const apexX = Math.max(24, Math.min(W - 24, exitX + sign * lateralShiftPx * 0.58));
  const apexY = Math.max(32, exitY - headlandBulgePx);

  const entryX = Math.max(28, Math.min(W - 28, exitX + sign * lateralShiftPx));
  const entryY = Math.min(H - 22, exitY + Math.max(32, headlandBulgePx * 0.72));

  const exitPt = { x: exitX, y: exitY };
  const apexPt = { x: apexX, y: apexY };
  const entryPt = { x: entryX, y: entryY };

  // Build 3 C1-smooth cubic Bezier segments
  const seg1 = {
    p0: { x: startX, y: startY },
    p1: { x: startX, y: startY - (startY - exitY) * 0.45 },
    p2: { x: exitX, y: exitY + (startY - exitY) * 0.35 },
    p3: exitPt,
  };

  const seg2 = {
    p0: exitPt,
    p1: { x: exitX, y: apexY + headlandBulgePx * 0.08 },
    p2: { x: apexX - sign * lateralShiftPx * 0.24, y: apexY },
    p3: apexPt,
  };

  const seg3 = {
    p0: apexPt,
    p1: { x: apexX + sign * lateralShiftPx * 0.32, y: apexY },
    p2: { x: entryX + sign * 8, y: exitY - headlandBulgePx * 0.08 },
    p3: entryPt,
  };

  const rawPts: Array<{ x: number; y: number }> = [];
  const samplesPerSeg = 22;
  const segs = [seg1, seg2, seg3];
  for (let sIdx = 0; sIdx < segs.length; sIdx++) {
    const seg = segs[sIdx];
    const startI = sIdx === 0 ? 0 : 1;
    for (let i = startI; i <= samplesPerSeg; i++) {
      rawPts.push(cubicBezier(seg.p0, seg.p1, seg.p2, seg.p3, i / samplesPerSeg));
    }
  }

  // Compute cumulative arc length, unit tangents, normals, and perspective wheel-track width
  const cumLen: number[] = [0];
  for (let i = 1; i < rawPts.length; i++) {
    cumLen.push(
      cumLen[i - 1] + Math.hypot(rawPts[i].x - rawPts[i - 1].x, rawPts[i].y - rawPts[i - 1].y)
    );
  }
  const totalPxLen = Math.max(1, cumLen[cumLen.length - 1]);

  const points: Pt[] = rawPts.map((pt, i) => {
    const prev = rawPts[Math.max(0, i - 1)];
    const next = rawPts[Math.min(rawPts.length - 1, i + 1)];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const mag = Math.max(1e-4, Math.hypot(dx, dy));
    const tx = dx / mag;
    const ty = dy / mag;
    const nx = -ty;
    const ny = tx;
    // Perspective wheel-track half-width: wider near bottom of frame, narrower near headland apex
    const yNorm = Math.max(0, Math.min(1, (pt.y - 24) / Math.max(1, H - 24)));
    const halfWidthPx = 8 + yNorm * 19;
    return {
      x: pt.x,
      y: pt.y,
      nx,
      ny,
      tx,
      ty,
      t: cumLen[i] / totalPxLen,
      halfWidthPx,
    };
  });

  // Physical estimated maneuver arc length (approach + 180° headland turn + re-entry)
  const arcLengthM = Number(
    (
      Math.max(0.25, Math.min(1.6, params.distanceToFurrowEndM)) +
      Math.PI * Math.max(turnRadiusM, rowSpacingM * 0.5) +
      0.35
    ).toFixed(2)
  );

  return { points, exitPt, apexPt, entryPt, arcLengthM };
}

function samplePointAtT(points: Pt[], targetT: number): Pt {
  if (points.length === 0) {
    return { x: 0, y: 0, nx: 0, ny: -1, tx: 1, ty: 0, t: 0, halfWidthPx: 12 };
  }
  const clamped = Math.max(0, Math.min(1, targetT));
  for (let i = 1; i < points.length; i++) {
    if (points[i].t >= clamped) {
      const a = points[i - 1];
      const b = points[i];
      const span = Math.max(1e-5, b.t - a.t);
      const f = (clamped - a.t) / span;
      return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        nx: a.nx + (b.nx - a.nx) * f,
        ny: a.ny + (b.ny - a.ny) * f,
        tx: a.tx + (b.tx - a.tx) * f,
        ty: a.ty + (b.ty - a.ty) * f,
        t: clamped,
        halfWidthPx: a.halfWidthPx + (b.halfWidthPx - a.halfWidthPx) * f,
      };
    }
  }
  return points[points.length - 1];
}

/**
 * Draw the animated row-end turn trajectory path projection directly onto a 2D canvas context.
 */
export function drawTurnTrajectoryOverlay(
  ctx: CanvasRenderingContext2D,
  params: TurnTrajectoryOverlayParams
): { arcLengthM: number; turnImminent: boolean } {
  const { width: W, nowMs, distanceToFurrowEndM, rowEndConfidence, turnDirection, turnRadiusM } =
    params;

  const turnImminent =
    params.forceTurnAlertStyle || rowEndConfidence >= 0.68 || distanceToFurrowEndM <= 0.65;

  const { points, exitPt, apexPt, entryPt, arcLengthM } = buildProjectedTurnPolyline(params);
  if (points.length < 4) {
    return { arcLengthM, turnImminent };
  }

  const primaryStroke = turnImminent ? '#F59E0B' : '#10B981';
  const brightStroke = turnImminent ? '#FDE68A' : '#6EE7B7';
  const ribbonFill = turnImminent ? 'rgba(245, 158, 11, 0.16)' : 'rgba(16, 185, 129, 0.17)';
  const railStroke = turnImminent ? 'rgba(251, 191, 36, 0.55)' : 'rgba(52, 211, 153, 0.55)';

  ctx.save();

  // 1. Furrow-end threshold horizon line across frame at exitPt.y
  ctx.strokeStyle = turnImminent ? 'rgba(245, 158, 11, 0.78)' : 'rgba(52, 211, 153, 0.58)';
  ctx.lineWidth = 1.25;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(10, exitPt.y);
  ctx.lineTo(W - 10, exitPt.y);
  ctx.stroke();
  ctx.setLineDash([]);

  // 2. Swept wheel-track corridor ribbon (left & right chassis boundary in perspective)
  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const lx = p.x + p.nx * p.halfWidthPx;
    const ly = p.y + p.ny * p.halfWidthPx;
    if (i === 0) ctx.moveTo(lx, ly);
    else ctx.lineTo(lx, ly);
  }
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    const rx = p.x - p.nx * p.halfWidthPx;
    const ry = p.y - p.ny * p.halfWidthPx;
    ctx.lineTo(rx, ry);
  }
  ctx.closePath();
  ctx.fillStyle = ribbonFill;
  ctx.fill();

  // Subtle left & right wheel-track rails
  ctx.strokeStyle = railStroke;
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const lx = p.x + p.nx * p.halfWidthPx;
    const ly = p.y + p.ny * p.halfWidthPx;
    if (i === 0) ctx.moveTo(lx, ly);
    else ctx.lineTo(lx, ly);
  }
  ctx.stroke();

  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const rx = p.x - p.nx * p.halfWidthPx;
    const ry = p.y - p.ny * p.halfWidthPx;
    if (i === 0) ctx.moveTo(rx, ry);
    else ctx.lineTo(rx, ry);
  }
  ctx.stroke();

  // 3. Soft glow under-stroke + solid projected centerline path
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    if (i === 0) ctx.moveTo(points[i].x, points[i].y);
    else ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.strokeStyle = turnImminent ? 'rgba(245, 158, 11, 0.32)' : 'rgba(16, 185, 129, 0.30)';
  ctx.lineWidth = 7;
  ctx.stroke();

  ctx.strokeStyle = primaryStroke;
  ctx.lineWidth = 2.4;
  ctx.stroke();

  // 4. Animated marching luminous flow dashes moving continuously along turn trajectory
  const dashPhase = -((nowMs * 0.048) % 24);
  ctx.strokeStyle = brightStroke;
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 16]);
  ctx.lineDashOffset = dashPhase;
  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    if (i === 0) ctx.moveTo(points[i].x, points[i].y);
    else ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;

  // 5. Traveling directional chevrons flowing along the predicted trajectory
  const chevronCount = 4;
  const baseProgress = (nowMs * 0.00032) % 1;
  for (let k = 0; k < chevronCount; k++) {
    const u = (baseProgress + k / chevronCount) % 1;
    // Fade smoothly near start and end of arc
    const edgeAlpha = Math.min(1, u * 6, (1 - u) * 6);
    const pt = samplePointAtT(points, u);
    const angle = Math.atan2(pt.ty, pt.tx);

    ctx.save();
    ctx.translate(pt.x, pt.y);
    ctx.rotate(angle);
    ctx.strokeStyle = turnImminent
      ? `rgba(255, 251, 235, ${(0.95 * edgeAlpha).toFixed(2)})`
      : `rgba(236, 253, 245, ${(0.95 * edgeAlpha).toFixed(2)})`;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(-5, -5.5);
    ctx.lineTo(3.5, 0);
    ctx.lineTo(-5, 5.5);
    ctx.stroke();
    ctx.restore();
  }

  // 6. Animated Ghost Rover Prediction Probe gliding along the headland curve
  const probeU = (nowMs * 0.00024) % 1;
  const probe = samplePointAtT(points, probeU);
  const probeAngle = Math.atan2(probe.ty, probe.tx);
  ctx.save();
  ctx.translate(probe.x, probe.y);
  ctx.rotate(probeAngle);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.strokeStyle = primaryStroke;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(7.5, 0);
  ctx.lineTo(-5, -5);
  ctx.lineTo(-2.5, 0);
  ctx.lineTo(-5, 5);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();

  // 7. Waypoint Nodes (WP1 Row Exit, WP2 Headland Apex, WP3 Next Row Entry)
  const drawWaypoint = (
    pt: { x: number; y: number },
    label: string,
    accent: string,
    alignRight = false
  ) => {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 4.2, 0, Math.PI * 2);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.font = '600 9px "IBM Plex Mono", monospace';
    const tw = ctx.measureText(label).width + 8;
    const lx = alignRight ? Math.max(8, pt.x - tw - 7) : Math.min(W - tw - 8, pt.x + 7);
    const ly = Math.max(32, pt.y - 7);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
    ctx.fillRect(lx, ly, tw, 13);
    ctx.fillStyle = '#ECFDF5';
    ctx.fillText(label, lx + 4, ly + 9.5);
  };

  drawWaypoint(
    exitPt,
    `WP1 EXIT (${distanceToFurrowEndM.toFixed(2)}m)`,
    primaryStroke,
    turnDirection === 'right'
  );
  drawWaypoint(apexPt, `WP2 APEX (R=${turnRadiusM.toFixed(2)}m)`, primaryStroke, false);
  drawWaypoint(entryPt, 'WP3 NEXT ROW', '#10B981', turnDirection === 'left');

  // 8. Compact Bottom-Right AR Trajectory Stamp
  const dirTag = turnDirection === 'right' ? 'RIGHT U-TURN' : 'LEFT U-TURN';
  const statusTag = turnImminent ? 'TURN IMMINENT' : 'PATH LOCKED';
  const hudText = `${statusTag} · ${dirTag} · ARC ${arcLengthM.toFixed(2)}m`;
  ctx.font = '600 9.5px "IBM Plex Mono", monospace';
  const hudW = ctx.measureText(hudText).width + 14;
  ctx.fillStyle = turnImminent ? 'rgba(180, 83, 9, 0.88)' : 'rgba(6, 78, 59, 0.85)';
  ctx.fillRect(W - hudW - 8, params.height - 24, hudW, 17);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(hudText, W - hudW - 1, params.height - 12);

  ctx.restore();

  return { arcLengthM, turnImminent };
}
