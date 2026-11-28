export type PartId =
  | 'chassis_deck'
  | 'arch_legs'
  | 'tt_motors'
  | 'rover_wheels'
  | 'power_driver'
  | 'esp32_mcu'
  | 'raspberry_pi'
  | 'camera_gantry'
  | 'fuel_valve_turret'
  | 'igniter_torch';

export type TreatmentToolType = 'flame' | 'grinder' | 'laser';

export type GamePhase = 'workshop' | 'field';

export type ControlMode = 'auto' | 'manual';

export type CameraPreset = 'orbit' | 'chase' | 'mast' | 'bev';

export type FieldRoverState =
  | 'IDLE'
  | 'NAVIGATING_ROW'
  | 'STOP_SCAN'
  | 'VALVE_SPARK'
  | 'TREATMENT_HOOK'
  | 'HEADLAND_TURN'
  | 'OBSTACLE_HOLD'
  | 'PAUSED'
  | 'ESTOP'
  | 'DONE';

export interface RoverPartSpec {
  id: PartId;
  step: number;
  name: string;
  shortName: string;
  category: 'Structure' | 'Drivetrain' | 'Electronics' | 'Perception' | 'Thermal Tool';
  specLine: string;
  description: string;
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
  controlMode: ControlMode;
  roverState: FieldRoverState;
  installedCount: number;
  totalParts: number;
  selectedTool: TreatmentToolType;
  canDeploy: boolean;
  hasCameraGantry: boolean;
  hasFuelTurret: boolean;
  hasIgniterTorch: boolean;
  // Field telemetry
  speedCmS: number;
  headingDeg: number;
  leftEncoderTicks: number;
  rightEncoderTicks: number;
  tofDistanceMm: number;
  valveOpenPct: number;
  sparkActive: boolean;
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
