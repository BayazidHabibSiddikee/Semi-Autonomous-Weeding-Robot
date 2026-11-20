import {
  Field,
  FieldPoint,
  HomographyCalibration,
  Mission,
  PathSegment,
  RowDetectionResult,
  TurnDirection,
  attentionWindowForRowLength,
  pixelToField,
} from './models';

/**
 * Port of BoustrophedonGenerator.kt:
 * Generates an alternating serpentine coverage mission from detected crop row centers.
 */
export function generateBoustrophedonMission(
  field: Field,
  rows: RowDetectionResult,
  calibration: HomographyCalibration,
  rowLengthOverrideM?: number
): Mission {
  const rowLengthM = rowLengthOverrideM ?? field.lengthM;

  const rowYs = rows.rowCentersX
    .map((px) => pixelToField(calibration, px, 0).y)
    .sort((a, b) => a - b);

  const effectiveRowYs =
    rowYs.length >= field.totalRows
      ? rowYs.slice(0, field.totalRows)
      : generateEvenSpacing(rowYs, field.totalRows, field.widthM);

  const segments: PathSegment[] = [];
  let seq = 1;

  effectiveRowYs.forEach((rowY, index) => {
    const isLastRow = index === effectiveRowYs.length - 1;

    const startLateral = index % 2 === 0 ? 0.0 : rowLengthM;
    const endLateral = index % 2 === 0 ? rowLengthM : 0.0;

    const startPoint: FieldPoint = { x: startLateral, y: rowY };
    const endPoint: FieldPoint = { x: endLateral, y: rowY };

    const nextTurn: TurnDirection = index % 2 === 0 ? 'RIGHT' : 'LEFT';

    segments.push({
      type: 'FollowRow',
      seq: seq++,
      row: index + 1,
      expectedDistM: rowLengthM,
      turnAfter: nextTurn,
      startPoint,
      endPoint,
    });

    if (!isLastRow) {
      const nextRowY = effectiveRowYs[index + 1];
      const gapM = Math.abs(nextRowY - rowY);
      segments.push({
        type: 'Turn',
        seq: seq++,
        direction: nextTurn,
        gapM,
        startPoint: { x: endLateral, y: rowY },
        endPoint: { x: endLateral, y: nextRowY },
      });
    }
  });

  return {
    version: 1,
    field,
    path: segments,
    attentionWindow: attentionWindowForRowLength(rowLengthM),
    generatedAt: Date.now(),
  };
}

/**
 * Build a clean default Boustrophedon mission directly from Field dimensions
 * (used when launching the Field Simulator before planning a custom photo mission).
 */
export function buildDefaultFieldMission(field: Field): Mission {
  const nominalStep = field.widthM / Math.max(1, field.totalRows);
  const rowYs = Array.from({ length: field.totalRows }, (_, i) => (i + 0.5) * nominalStep);
  const segments: PathSegment[] = [];
  let seq = 1;

  rowYs.forEach((rowY, index) => {
    const isLastRow = index === rowYs.length - 1;
    const startLateral = index % 2 === 0 ? 0.0 : field.lengthM;
    const endLateral = index % 2 === 0 ? field.lengthM : 0.0;
    const nextTurn: TurnDirection = index % 2 === 0 ? 'RIGHT' : 'LEFT';

    segments.push({
      type: 'FollowRow',
      seq: seq++,
      row: index + 1,
      expectedDistM: field.lengthM,
      turnAfter: nextTurn,
      startPoint: { x: startLateral, y: rowY },
      endPoint: { x: endLateral, y: rowY },
    });

    if (!isLastRow) {
      const nextRowY = rowYs[index + 1];
      segments.push({
        type: 'Turn',
        seq: seq++,
        direction: nextTurn,
        gapM: Math.abs(nextRowY - rowY),
        startPoint: { x: endLateral, y: rowY },
        endPoint: { x: endLateral, y: nextRowY },
      });
    }
  });

  return {
    version: 1,
    field,
    path: segments,
    attentionWindow: attentionWindowForRowLength(field.lengthM),
    generatedAt: Date.now(),
  };
}

function generateEvenSpacing(detected: number[], totalRows: number, widthM: number): number[] {
  if (totalRows <= 0) return [];
  const nominalStep = widthM / totalRows;

  if (detected.length === 0) {
    return Array.from({ length: totalRows }, (_, i) => (i + 0.5) * nominalStep);
  }

  const offsets = detected
    .map((y) => {
      const slot = Math.max(0, Math.min(totalRows - 1, Math.floor(y / nominalStep - 0.5)));
      return y - (slot + 0.5) * nominalStep;
    })
    .sort((a, b) => a - b);

  const rawMedian = offsets[Math.floor(offsets.length / 2)];
  const medianOffset = Math.max(-nominalStep * 0.35, Math.min(nominalStep * 0.35, rawMedian));

  return Array.from({ length: totalRows }, (_, i) => {
    const nominal = (i + 0.5) * nominalStep + medianOffset;
    const close = detected.find((y) => Math.abs(y - nominal) < nominalStep * 0.4);
    const val = close ?? nominal;
    return Math.max(0.05, Math.min(widthM - 0.05, val));
  });
}
