import { FIELD_ROW_Z } from './environmentBuilder';
import {
  ControlMode,
  FieldObstacle3D,
  FieldPlant3D,
  FieldRoverState,
  FieldWeed3D,
  GameHudSnapshot,
  GamePhase,
  PartId,
  TreatmentToolType,
} from './types';

function createRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizeAngleRad(a: number): number {
  let r = a;
  while (r > Math.PI) r -= Math.PI * 2;
  while (r < -Math.PI) r += Math.PI * 2;
  return r;
}

export interface ManualInputState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  fire: boolean;
}

export interface MissionStepEvents {
  weedEliminated?: { x: number; z: number; tool: TreatmentToolType };
  treatmentTick?: { x: number; z: number; tool: TreatmentToolType };
  obstacleTriggered?: boolean;
  cropHit?: boolean;
  missionComplete?: boolean;
}

const WHEEL_RADIUS_M = 0.035;
const WHEEL_TRACK_M = 0.174;
const TICKS_PER_REV = 17280;
const ROW_START_X = -1.68;
const ROW_END_X = 1.68;

type TurnStage = 'ROTATE_1' | 'CROSS_GAP' | 'ROTATE_2';

export class FieldMissionEngine {
  // Rover world pose (meters, Y-up, +X heading = 0 rad, rotating CCW around +Y)
  x = ROW_START_X;
  z = FIELD_ROW_Z[0];
  headingRad = 0; // 0 = +X, -PI/2 = +Z (turning right), +PI/2 = -Z

  linearVelMps = 0;
  angularVelRadS = 0;
  leftWheelAngle = 0;
  rightWheelAngle = 0;
  leftEncoderTicks = 0;
  rightEncoderTicks = 0;

  state: FieldRoverState = 'IDLE';
  controlMode: ControlMode = 'auto';
  running = false;

  currentRow = 0; // 0..3
  turnStage: TurnStage = 'ROTATE_1';
  turnTargetHeading = 0;
  turnTargetZ = FIELD_ROW_Z[0];

  crops: FieldPlant3D[] = [];
  weeds: FieldWeed3D[] = [];
  obstacle: FieldObstacle3D = { active: false, x: 0.4, z: FIELD_ROW_Z[0], radius: 0.12 };

  activeWeedId: number | null = null;
  activeWeedLocal: { x: number; z: number } | null = null;
  stateTimer = 0;
  tofDistanceMm = 1800;
  distanceTravelledM = 0;
  missionTimeS = 0;
  score = 0;
  statusNote = 'Ready on Row 1 headland. Start Mission or switch to Manual Drive.';

  private seed = 42;
  private toolFiring = false;
  private particleCooldown = 0;

  constructor(seed = 42) {
    this.resetField(seed);
  }

  resetField(seed = this.seed) {
    this.seed = seed;
    const rng = createRng(seed);

    this.x = ROW_START_X;
    this.z = FIELD_ROW_Z[0];
    this.headingRad = 0;
    this.linearVelMps = 0;
    this.angularVelRadS = 0;
    this.leftEncoderTicks = 0;
    this.rightEncoderTicks = 0;
    this.currentRow = 0;
    this.turnStage = 'ROTATE_1';
    this.state = 'IDLE';
    this.running = false;
    this.activeWeedId = null;
    this.activeWeedLocal = null;
    this.stateTimer = 0;
    this.tofDistanceMm = 1850;
    this.distanceTravelledM = 0;
    this.missionTimeS = 0;
    this.score = 0;
    this.toolFiring = false;
    this.obstacle = { active: false, x: 0.35, z: FIELD_ROW_Z[0], radius: 0.11 };
    this.statusNote = 'Ready on Row 1. Click Start Mission for autonomous Boustrophedon weeding.';

    // Generate 4 raised rows of young tomato crops (straddled safely under 110mm arch)
    this.crops = [];
    let cropId = 1;
    FIELD_ROW_Z.forEach((rz, rowIndex) => {
      for (let cx = -1.42; cx <= 1.44; cx += 0.34) {
        this.crops.push({
          id: cropId++,
          x: cx + (rng() - 0.5) * 0.04,
          z: rz + (rng() - 0.5) * 0.012,
          rowIndex,
          radius: 0.036,
          damaged: false,
        });
      }
    });

    // Generate 16–20 broadleaf weeds scattered inside row corridors near crop rows
    this.weeds = [];
    let weedId = 1;
    FIELD_ROW_Z.forEach((rz, rowIndex) => {
      const weedsPerRow = 4 + (rowIndex % 2);
      for (let i = 0; i < weedsPerRow; i++) {
        for (let attempt = 0; attempt < 30; attempt++) {
          const wx = -1.35 + ((i + 0.5 + (rng() - 0.5) * 0.65) / weedsPerRow) * 2.7;
          const lateralSign = rng() > 0.5 ? 1 : -1;
          const wz = rz + lateralSign * (0.045 + rng() * 0.095);
          const nearCrop = this.crops.some((c) => Math.hypot(c.x - wx, c.z - wz) < 0.075);
          const nearWeed = this.weeds.some((w) => Math.hypot(w.x - wx, w.z - wz) < 0.18);
          if (!nearCrop && !nearWeed) {
            this.weeds.push({
              id: weedId++,
              x: wx,
              z: wz,
              rowIndex,
              radius: 0.032,
              eliminated: false,
              treatProgress: 0,
            });
            break;
          }
        }
      }
    });
  }

  toggleObstacleAhead() {
    if (this.obstacle.active) {
      this.obstacle.active = false;
      this.statusNote = 'Field obstacle cleared — ToF rangefinder path clear.';
      return;
    }
    const dirX = Math.cos(this.headingRad);
    const dirZ = -Math.sin(this.headingRad);
    this.obstacle = {
      active: true,
      x: Math.max(-1.6, Math.min(1.6, this.x + dirX * 0.62)),
      z: Math.max(-1.1, Math.min(1.1, this.z + dirZ * 0.62)),
      radius: 0.11,
    };
    this.statusNote = 'Dropped wooden crate ahead on row — testing VL53L0X ToF obstacle hold.';
  }

  triggerEstop() {
    this.state = 'ESTOP';
    this.running = false;
    this.linearVelMps = 0;
    this.angularVelRadS = 0;
    this.toolFiring = false;
    this.statusNote = 'GPIO 13 E-Stop latched (0 PWM). Click Recover to enter PAUSED state.';
  }

  recoverFromEstop() {
    if (this.state === 'ESTOP') {
      this.state = 'PAUSED';
      this.statusNote = 'Safety latch cleared into PAUSED. Press Start to resume.';
    }
  }

  startOrPause() {
    if (this.state === 'ESTOP') return;
    if (this.state === 'DONE') {
      this.resetField(this.seed + 1);
      this.running = true;
      this.state = 'NAVIGATING_ROW';
      this.statusNote = 'Executing fresh Boustrophedon crop-row mission.';
      return;
    }
    if (this.running) {
      this.running = false;
      this.state = 'PAUSED';
      this.linearVelMps = 0;
      this.angularVelRadS = 0;
      this.toolFiring = false;
      this.statusNote = 'Mission paused with checkpoint saved.';
    } else {
      this.running = true;
      if (this.state === 'IDLE' || this.state === 'PAUSED') {
        this.state = 'NAVIGATING_ROW';
      }
      this.statusNote = 'Autonomous closed-loop row tracking active.';
    }
  }

  private worldToRoverLocal(wx: number, wz: number): { x: number; z: number } {
    const dx = wx - this.x;
    const dz = wz - this.z;
    const c = Math.cos(this.headingRad);
    const s = Math.sin(this.headingRad);
    // Forward is (+cos, -sin), Right is (+sin, +cos)
    return {
      x: dx * c - dz * s,
      z: dx * s + dz * c,
    };
  }

  private measureTofDistanceMm(): number {
    if (!this.obstacle.active) return 1850;
    const loc = this.worldToRoverLocal(this.obstacle.x, this.obstacle.z);
    if (loc.x > 0.08 && Math.abs(loc.z) < 0.22) {
      return Math.max(80, Math.round((loc.x - 0.14 - this.obstacle.radius) * 1000));
    }
    return 1850;
  }

  private advanceWheelKinematics(dt: number) {
    const vLeft = this.linearVelMps - (this.angularVelRadS * WHEEL_TRACK_M) / 2;
    const vRight = this.linearVelMps + (this.angularVelRadS * WHEEL_TRACK_M) / 2;

    const dThetaLeft = (vLeft * dt) / WHEEL_RADIUS_M;
    const dThetaRight = (vRight * dt) / WHEEL_RADIUS_M;

    this.leftWheelAngle -= dThetaLeft;
    this.rightWheelAngle -= dThetaRight;

    this.leftEncoderTicks += Math.round((dThetaLeft / (Math.PI * 2)) * TICKS_PER_REV);
    this.rightEncoderTicks += Math.round((dThetaRight / (Math.PI * 2)) * TICKS_PER_REV);

    const stepDist = Math.abs(this.linearVelMps * dt);
    this.distanceTravelledM += stepDist;
  }

  private checkCropCollisions(): boolean {
    let hitAny = false;
    // Wheels run at local Z = ±0.087m (width ±0.02m). Young crops in the center tunnel (|localZ| < 0.045) pass safely!
    for (const crop of this.crops) {
      if (crop.damaged) continue;
      const loc = this.worldToRoverLocal(crop.x, crop.z);
      const underWheelX = Math.abs(loc.x) < 0.145;
      const underLeftOrRightWheelZ = Math.abs(Math.abs(loc.z) - 0.087) < 0.04;
      if (underWheelX && underLeftOrRightWheelZ) {
        crop.damaged = true;
        this.score = Math.max(0, this.score - 40);
        hitAny = true;
      }
    }
    return hitAny;
  }

  step(
    dt: number,
    installed: Set<PartId>,
    selectedTool: TreatmentToolType,
    manualInput: ManualInputState
  ): MissionStepEvents {
    const events: MissionStepEvents = {};
    const clampedDt = Math.min(0.05, Math.max(0.001, dt));
    this.particleCooldown = Math.max(0, this.particleCooldown - clampedDt);

    const hasImuTof = installed.has('imu_tof');
    const hasCamera = installed.has('maixsense_cam');
    const hasTool = installed.has('estop_tool');

    this.tofDistanceMm = hasImuTof ? this.measureTofDistanceMm() : 1999;

    if (this.state === 'ESTOP') {
      this.linearVelMps = 0;
      this.angularVelRadS = 0;
      this.toolFiring = false;
      return events;
    }

    // =========================================================================
    // MANUAL OPERATOR DRIVE MODE
    // =========================================================================
    if (this.controlMode === 'manual') {
      this.missionTimeS += clampedDt;
      const throttle = (manualInput.forward ? 1 : 0) - (manualInput.backward ? 1 : 0);
      const steer = (manualInput.left ? 1 : 0) - (manualInput.right ? 1 : 0);

      const maxSpeed = 0.58;
      const maxTurn = 1.95;

      const blockedByObstacle =
        hasImuTof && this.tofDistanceMm <= 350 && throttle > 0;

      const targetLin = blockedByObstacle ? 0 : throttle * maxSpeed;
      const targetAng = steer * maxTurn;

      this.linearVelMps += (targetLin - this.linearVelMps) * Math.min(1, clampedDt * 8);
      this.angularVelRadS += (targetAng - this.angularVelRadS) * Math.min(1, clampedDt * 10);

      this.headingRad = normalizeAngleRad(this.headingRad + this.angularVelRadS * clampedDt);
      this.x += Math.cos(this.headingRad) * this.linearVelMps * clampedDt;
      this.z += -Math.sin(this.headingRad) * this.linearVelMps * clampedDt;

      // Stay inside farm fence perimeter
      this.x = Math.max(-2.1, Math.min(2.1, this.x));
      this.z = Math.max(-1.45, Math.min(1.45, this.z));

      this.advanceWheelKinematics(clampedDt);

      if (blockedByObstacle) {
        this.state = 'OBSTACLE_HOLD';
        this.statusNote = `VL53L0X ToF obstacle stop (${this.tofDistanceMm} mm). Reverse or clear obstacle.`;
      } else {
        this.state = Math.abs(this.linearVelMps) > 0.02 || Math.abs(this.angularVelRadS) > 0.05
          ? 'NAVIGATING_ROW'
          : 'IDLE';
      }

      if (this.checkCropCollisions()) {
        events.cropHit = true;
        this.statusNote = 'Crop contact warning! Keep young tomato stems centered under the 110 mm arch.';
      }

      // Manual weed treatment when pressing Fire (F)
      this.toolFiring = false;
      this.activeWeedLocal = null;
      if (manualInput.fire && hasTool) {
        this.toolFiring = true;
        // Find closest active weed under rover / camera swath
        let closest: FieldWeed3D | null = null;
        let closestDist = 0.24;
        for (const w of this.weeds) {
          if (w.eliminated) continue;
          const d = Math.hypot(w.x - this.x, w.z - this.z);
          if (d < closestDist) {
            closestDist = d;
            closest = w;
          }
        }
        if (closest) {
          this.activeWeedLocal = this.worldToRoverLocal(closest.x, closest.z);
          closest.treatProgress = Math.min(1, closest.treatProgress + clampedDt * 1.9);
          if (this.particleCooldown <= 0) {
            events.treatmentTick = { x: closest.x, z: closest.z, tool: selectedTool };
            this.particleCooldown = 0.09;
          }
          if (closest.treatProgress >= 1) {
            closest.eliminated = true;
            this.score += 100;
            events.weedEliminated = { x: closest.x, z: closest.z, tool: selectedTool };
            this.statusNote = `Eliminated Weed #${closest.id} via ${selectedTool.toUpperCase()}!`;
          }
        } else if (this.particleCooldown <= 0) {
          events.treatmentTick = { x: this.x, z: this.z, tool: selectedTool };
          this.particleCooldown = 0.14;
        }
      } else if (manualInput.fire && !hasTool) {
        this.statusNote = 'Nav-Only build: install E-Stop + Weeding Tool in Workshop to treat weeds.';
      }

      return events;
    }

    // =========================================================================
    // AUTONOMOUS BOUSTROPHEDON STATE MACHINE
    // =========================================================================
    if (!this.running || this.state === 'IDLE' || this.state === 'PAUSED' || this.state === 'DONE') {
      this.linearVelMps = 0;
      this.angularVelRadS = 0;
      this.toolFiring = false;
      return events;
    }

    this.missionTimeS += clampedDt;

    // Obstacle check before motion (VL53L0X ToF <= 350 mm)
    if (this.state === 'OBSTACLE_HOLD') {
      this.linearVelMps = 0;
      this.angularVelRadS = 0;
      this.toolFiring = false;
      if (!this.obstacle.active || this.tofDistanceMm > 400) {
        this.state = 'NAVIGATING_ROW';
        this.statusNote = 'Obstacle cleared — resuming closed-loop row tracking.';
      }
      return events;
    }

    if (
      hasImuTof &&
      this.tofDistanceMm <= 350 &&
      (this.state === 'NAVIGATING_ROW' || this.state === 'HEADLAND_TURN')
    ) {
      this.state = 'OBSTACLE_HOLD';
      this.linearVelMps = 0;
      this.angularVelRadS = 0;
      this.toolFiring = false;
      this.statusNote = `OBSTACLE_HOLD (${this.tofDistanceMm} mm) — halted safely without blind-dodging crops.`;
      events.obstacleTriggered = true;
      return events;
    }

    if (this.state === 'NAVIGATING_ROW') {
      this.toolFiring = false;
      const goingEast = this.currentRow % 2 === 0;
      const targetHeading = goingEast ? 0 : Math.PI;
      const targetZ = FIELD_ROW_Z[this.currentRow];
      const endX = goingEast ? ROW_END_X : ROW_START_X;

      // Closed-loop row centering + IMU heading hold
      const zErr = targetZ - this.z;
      const lateralSteer = goingEast ? -zErr * 1.4 : zErr * 1.4;
      const desiredHeading = normalizeAngleRad(targetHeading + Math.max(-0.22, Math.min(0.22, lateralSteer)));
      const headingErr = normalizeAngleRad(desiredHeading - this.headingRad);

      this.angularVelRadS = Math.max(-1.6, Math.min(1.6, headingErr * (hasImuTof ? 4.2 : 2.2)));
      this.linearVelMps = 0.42;

      this.headingRad = normalizeAngleRad(this.headingRad + this.angularVelRadS * clampedDt);
      this.x += Math.cos(this.headingRad) * this.linearVelMps * clampedDt;
      this.z += -Math.sin(this.headingRad) * this.linearVelMps * clampedDt;
      this.advanceWheelKinematics(clampedDt);

      // Scan downward MaixSense camera footprint for untreated weeds
      if (hasCamera) {
        for (const weed of this.weeds) {
          if (weed.eliminated || weed.rowIndex !== this.currentRow) continue;
          const loc = this.worldToRoverLocal(weed.x, weed.z);
          if (loc.x >= -0.05 && loc.x <= 0.14 && Math.abs(loc.z) <= 0.17) {
            if (hasTool) {
              this.activeWeedId = weed.id;
              this.activeWeedLocal = loc;
              this.state = 'STOP_SCAN';
              this.stateTimer = 0.24;
              this.linearVelMps = 0;
              this.angularVelRadS = 0;
              this.statusNote = `MaixSense ExG detected Weed #${weed.id} — stopping & shielding tomato crops.`;
              return events;
            }
          }
        }
      }

      // Check row-end Attention Window
      const reachedEnd = goingEast ? this.x >= endX : this.x <= endX;
      if (reachedEnd) {
        this.x = endX;
        this.linearVelMps = 0;
        this.angularVelRadS = 0;
        if (this.currentRow >= FIELD_ROW_Z.length - 1) {
          this.state = 'DONE';
          this.running = false;
          this.score += 250;
          this.statusNote = 'Mission Complete! All 4 tomato rows covered safely inside boundary margins.';
          events.missionComplete = true;
          return events;
        }
        // Start 3-stage closed-loop headland turn to next row
        this.turnStage = 'ROTATE_1';
        this.turnTargetHeading = -Math.PI / 2; // Face +Z across furrow
        this.turnTargetZ = FIELD_ROW_Z[this.currentRow + 1];
        this.state = 'HEADLAND_TURN';
        this.statusNote = `Row ${this.currentRow + 1} complete — starting 3-stage IMU headland turn.`;
      }
      return events;
    }

    if (this.state === 'STOP_SCAN') {
      this.linearVelMps = 0;
      this.angularVelRadS = 0;
      this.toolFiring = false;
      this.stateTimer -= clampedDt;
      if (this.stateTimer <= 0) {
        this.state = 'TREATMENT_HOOK';
        this.stateTimer = selectedTool === 'laser' ? 0.52 : selectedTool === 'flame' ? 0.68 : 0.78;
        const w = this.weeds.find((item) => item.id === this.activeWeedId);
        if (w) {
          this.activeWeedLocal = this.worldToRoverLocal(w.x, w.z);
        }
        this.statusNote = `Stationary TREATMENT_HOOK active (${selectedTool.toUpperCase()}) on Weed #${this.activeWeedId}.`;
      }
      return events;
    }

    if (this.state === 'TREATMENT_HOOK') {
      this.linearVelMps = 0;
      this.angularVelRadS = 0;
      this.toolFiring = true;

      const weed = this.weeds.find((item) => item.id === this.activeWeedId);
      if (!weed || weed.eliminated) {
        this.toolFiring = false;
        this.state = 'NAVIGATING_ROW';
        return events;
      }

      this.activeWeedLocal = this.worldToRoverLocal(weed.x, weed.z);
      const totalDur = selectedTool === 'laser' ? 0.52 : selectedTool === 'flame' ? 0.68 : 0.78;
      this.stateTimer -= clampedDt;
      weed.treatProgress = Math.max(0, Math.min(1, 1 - this.stateTimer / totalDur));

      if (this.particleCooldown <= 0) {
        events.treatmentTick = { x: weed.x, z: weed.z, tool: selectedTool };
        this.particleCooldown = 0.08;
      }

      if (this.stateTimer <= 0) {
        weed.eliminated = true;
        weed.treatProgress = 1;
        this.toolFiring = false;
        this.activeWeedId = null;
        this.activeWeedLocal = null;
        this.score += 100;
        events.weedEliminated = { x: weed.x, z: weed.z, tool: selectedTool };
        this.state = 'NAVIGATING_ROW';
        this.statusNote = `Weed #${weed.id} eliminated — resuming Row ${this.currentRow + 1}.`;
      }
      return events;
    }

    if (this.state === 'HEADLAND_TURN') {
      this.toolFiring = false;
      const turnRate = 1.65;

      if (this.turnStage === 'ROTATE_1') {
        const err = normalizeAngleRad(this.turnTargetHeading - this.headingRad);
        if (Math.abs(err) <= 0.04) {
          this.headingRad = this.turnTargetHeading;
          this.angularVelRadS = 0;
          this.turnStage = 'CROSS_GAP';
          this.statusNote = `Headland Stage 2/3: Crossing 60 cm furrow to Row ${this.currentRow + 2}.`;
        } else {
          this.angularVelRadS = Math.sign(err) * Math.min(turnRate, Math.abs(err) * 4.5 + 0.35);
          this.headingRad = normalizeAngleRad(this.headingRad + this.angularVelRadS * clampedDt);
          this.linearVelMps = 0;
          this.advanceWheelKinematics(clampedDt);
        }
      } else if (this.turnStage === 'CROSS_GAP') {
        const dz = this.turnTargetZ - this.z;
        if (dz <= 0.015) {
          this.z = this.turnTargetZ;
          this.linearVelMps = 0;
          this.currentRow += 1;
          this.turnTargetHeading = this.currentRow % 2 === 0 ? 0 : Math.PI;
          this.turnStage = 'ROTATE_2';
          this.statusNote = `Headland Stage 3/3: Aligning 90° into Row ${this.currentRow + 1}.`;
        } else {
          this.linearVelMps = 0.32;
          this.angularVelRadS = 0;
          this.z += this.linearVelMps * clampedDt;
          this.advanceWheelKinematics(clampedDt);
        }
      } else {
        const err = normalizeAngleRad(this.turnTargetHeading - this.headingRad);
        if (Math.abs(err) <= 0.04) {
          this.headingRad = this.turnTargetHeading;
          this.angularVelRadS = 0;
          this.state = 'NAVIGATING_ROW';
          this.statusNote = `Aligned on Row ${this.currentRow + 1} — tracking crop corridor.`;
        } else {
          this.angularVelRadS = Math.sign(err) * Math.min(turnRate, Math.abs(err) * 4.5 + 0.35);
          this.headingRad = normalizeAngleRad(this.headingRad + this.angularVelRadS * clampedDt);
          this.linearVelMps = 0;
          this.advanceWheelKinematics(clampedDt);
        }
      }
      return events;
    }

    return events;
  }

  isToolFiring(): boolean {
    return this.toolFiring;
  }

  getHudSnapshot(
    phase: GamePhase,
    installed: Set<PartId>,
    selectedTool: TreatmentToolType,
    canDeploy: boolean
  ): GameHudSnapshot {
    const weedsEliminated = this.weeds.filter((w) => w.eliminated).length;
    const cropsSafe = this.crops.filter((c) => !c.damaged).length;
    const headingDeg = ((Math.round((-this.headingRad * 180) / Math.PI) % 360) + 360) % 360;

    let activeWeedDistCm: number | null = null;
    for (const w of this.weeds) {
      if (w.eliminated) continue;
      const d = Math.hypot(w.x - this.x, w.z - this.z) * 100;
      if (activeWeedDistCm === null || d < activeWeedDistCm) {
        activeWeedDistCm = Math.round(d);
      }
    }

    return {
      phase,
      controlMode: this.controlMode,
      roverState: this.state,
      installedCount: installed.size,
      totalParts: 10,
      selectedTool,
      canDeploy,
      hasImuTof: installed.has('imu_tof'),
      hasCamera: installed.has('maixsense_cam'),
      hasTool: installed.has('estop_tool'),
      speedCmS: Math.round(Math.abs(this.linearVelMps) * 100),
      headingDeg,
      leftEncoderTicks: this.leftEncoderTicks,
      rightEncoderTicks: this.rightEncoderTicks,
      tofDistanceMm: this.tofDistanceMm,
      currentRow: this.currentRow + 1,
      totalRows: FIELD_ROW_Z.length,
      weedsEliminated,
      totalWeeds: this.weeds.length,
      cropsSafe,
      totalCrops: this.crops.length,
      distanceTravelledM: this.distanceTravelledM,
      missionTimeS: this.missionTimeS,
      score: this.score,
      obstacleActive: this.obstacle.active,
      toolFiring: this.toolFiring,
      activeWeedDistCm,
      statusNote: this.statusNote,
    };
  }
}
