export type OriginCorner = 'TOP_LEFT' | 'TOP_RIGHT' | 'BOTTOM_LEFT' | 'BOTTOM_RIGHT';

export interface Field {
  widthM: number;
  lengthM: number;
  totalRows: number;
  rowSpacingM: number;
  originCorner: OriginCorner;
}

export interface FieldPoint {
  x: number; // Meters along field length (0 to lengthM)
  y: number; // Meters along field width (0 to widthM)
}

export interface ImagePoint {
  x: number;
  y: number;
}

export interface FieldCorners {
  topLeft: ImagePoint;
  topRight: ImagePoint;
  bottomRight: ImagePoint;
  bottomLeft: ImagePoint;
}

export type TurnDirection = 'LEFT' | 'RIGHT';

export interface FollowRowSegment {
  type: 'FollowRow';
  seq: number;
  row: number;
  expectedDistM: number;
  turnAfter: TurnDirection;
  startPoint: FieldPoint;
  endPoint: FieldPoint;
}

export interface TurnSegment {
  type: 'Turn';
  seq: number;
  direction: TurnDirection;
  gapM: number;
  startPoint: FieldPoint;
  endPoint: FieldPoint;
}

export type PathSegment = FollowRowSegment | TurnSegment;

export interface AttentionWindow {
  startM: number;
  endM: number;
}

export function attentionWindowForRowLength(lengthM: number): AttentionWindow {
  return {
    startM: Math.max(0, lengthM - 1.0),
    endM: lengthM + 0.5,
  };
}

export interface Mission {
  version: number;
  field: Field;
  path: PathSegment[];
  attentionWindow: AttentionWindow;
  generatedAt: number;
}

export interface RowDetectionResult {
  rowCount: number;
  rowCentersX: number[];
  rowSpacingPx: number;
  confidence: number;
  bevWidth: number;
  bevHeight: number;
  detectedRowCount: number;
}

export interface HomographyCalibration {
  sourceCorners: FieldCorners;
  destWidth: number;
  destHeight: number;
  matrix: number[]; // 9 elements row-major 3x3
  fieldWidthM: number;
  fieldLengthM: number;
}

export interface BevSuccessOutcome {
  status: 'success';
  bevDataUrl: string;
  calibration: HomographyCalibration;
  rows: RowDetectionResult;
  mission: Mission;
}

export type BevOutcome =
  | { status: 'idle' }
  | { status: 'error'; message: string }
  | BevSuccessOutcome;

export function cornersToList(corners: FieldCorners): ImagePoint[] {
  return [corners.topLeft, corners.topRight, corners.bottomRight, corners.bottomLeft];
}

/**
 * Signed shoelace area in image coordinates (Y pointing downward).
 * Positive when points are ordered clockwise (TL -> TR -> BR -> BL).
 */
export function signedPolygonArea(points: ImagePoint[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  return area / 2;
}

export function polygonArea(points: ImagePoint[]): number {
  return Math.abs(signedPolygonArea(points));
}

function isConvexClockwise(pts: ImagePoint[]): boolean {
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    const c = pts[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross <= 1e-3) return false;
  }
  return true;
}

/**
 * Validates that the 4 corners are distinct, strictly convex, clockwise (TL->TR->BR->BL),
 * and non-degenerate. Mirrors FieldCorners.isValid() in Field.kt.
 */
export function areCornersValid(corners: FieldCorners): boolean {
  const pts = cornersToList(corners);
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) < 1) {
        return false;
      }
    }
  }
  return signedPolygonArea(pts) > 1000 && isConvexClockwise(pts);
}

/**
 * Validates corners against source image bounds and minimum 2% coverage area.
 * Mirrors FieldCorners.isValidForImage() in Field.kt.
 */
export function areCornersValidForImage(
  corners: FieldCorners,
  imageWidth: number,
  imageHeight: number
): boolean {
  if (imageWidth <= 0 || imageHeight <= 0) return false;
  if (!areCornersValid(corners)) return false;
  const pts = cornersToList(corners);
  const inBounds = pts.every(
    (p) => p.x >= 0 && p.x <= imageWidth && p.y >= 0 && p.y <= imageHeight
  );
  if (!inBounds) return false;
  const minArea = Math.max(1000, imageWidth * imageHeight * 0.02);
  return signedPolygonArea(pts) >= minArea;
}

export function pixelToField(calib: HomographyCalibration, px: number, py: number): FieldPoint {
  const scaleX = calib.fieldWidthM / calib.destWidth;
  const scaleY = calib.fieldLengthM / calib.destHeight;
  return {
    x: py * scaleY, // image Y -> field length X
    y: px * scaleX, // image X -> field width Y
  };
}

export function fieldToPixel(calib: HomographyCalibration, point: FieldPoint): ImagePoint {
  const scaleX = calib.destWidth / calib.fieldWidthM;
  const scaleY = calib.destHeight / calib.fieldLengthM;
  return {
    x: point.y * scaleX,
    y: point.x * scaleY,
  };
}

export function missionTotalDistanceM(mission: Mission): number {
  return mission.path.reduce((sum, seg) => {
    return sum + (seg.type === 'FollowRow' ? seg.expectedDistM : seg.gapM);
  }, 0);
}
