export type PartId =
  | 'chassis_deck'
  | 'arch_legs'
  | 'tt_motors'
  | 'rover_wheels'
  | 'power_driver'
  | 'esp32_mcu'
  | 'raspberry_pi'
  | 'imu_tof'
  | 'estop_tool'
  | 'maixsense_a075v'
  | 'thermal_sensor'
  | 'corner_guard'
  | 'maixsense_cam';

export type TreatmentToolType = 'flame' | 'grinder' | 'laser';

export type CropFieldId =
  | 'tomato'
  | 'chili'
  | 'flower'
  | 'eggplant'
  | 'cabbage'
  | 'corn'
  | 'strawberry'
  | 'lettuce';

export type GamePhase = 'workshop' | 'field';

export type ControlMode = 'auto' | 'manual';

export type CameraPreset = 'orbit' | 'chase' | 'mast' | 'bev';

export type FieldRoverState =
  | 'IDLE'
  | 'NAVIGATING_ROW'
  | 'STOP_SCAN'
  | 'TREATMENT_HOOK'
  | 'HEADLAND_TURN'
  | 'OBSTACLE_HOLD'
  | 'PAUSED'
  | 'ESTOP'
  | 'DONE';

export interface PartSpecItem {
  label: string;
  value: string;
}

export interface RoverPartSpec {
  id: PartId;
  step: number;
  partNumber: string;
  name: string;
  shortName: string;
  category: 'Structure' | 'Drivetrain' | 'Electronics' | 'Perception' | 'Safety & Tool';
  specLine: string;
  description: string;
  specs: PartSpecItem[];
  assemblySteps: string[];
  toolsRequired: string;
  safetyNote?: string;
  requires: PartId[];
  requiredForDrive: boolean;
  explodeOffset: [number, number, number];
  dropOffset: [number, number, number];
  focusOffset: [number, number, number];
}

export interface FieldPlant3D {
  id: number;
  x: number;
  z: number;
  rowIndex: number;
  radius: number;
  damaged: boolean;
}

export interface FieldWeed3D {
  id: number;
  x: number;
  z: number;
  rowIndex: number;
  radius: number;
  weedClass: string;
  eliminated: boolean;
  treatProgress: number; // 0..1
}

export interface FieldObstacle3D {
  active: boolean;
  x: number;
  z: number;
  radius: number;
}

export interface GameHudSnapshot {
  phase: GamePhase;
  fieldType: CropFieldId;
  controlMode: ControlMode;
  roverState: FieldRoverState;
  installedCount: number;
  totalParts: number;
  selectedTool: TreatmentToolType;
  canDeploy: boolean;
  hasImuTof: boolean;
  hasCamera: boolean;
  hasTool: boolean;
  hasMaixSense: boolean;
  hasThermal: boolean;
  hasCornerGuard: boolean;
  // Field telemetry
  speedCmS: number;
  headingDeg: number;
  leftEncoderTicks: number;
  rightEncoderTicks: number;
  tofDistanceMm: number;
  nozzleTempC: number;
  piTempC: number;
  cornerStatus: string;
  turretYawDeg: number;
  currentRow: number;
  totalRows: number;
  weedsEliminated: number;
  totalWeeds: number;
  cropsSafe: number;
  totalCrops: number;
  distanceTravelledM: number;
  missionTimeS: number;
  score: number;
  obstacleActive: boolean;
  toolFiring: boolean;
  activeWeedDistCm: number | null;
  statusNote: string;
}
