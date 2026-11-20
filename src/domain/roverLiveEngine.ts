/**
 * Onboard Raspberry Pi 5 + MaixSense-A075V + YOLOv8 + Bad-Chili Surveillance + ESP32 Simulation Engine.
 *
 * Executes the exact autonomous field pipeline from the user's system architecture:
 *   - Localizes rover at the farmer's tapped [Start] point on the auto-warped BEV map
 *   - Step 4: Live 3D Furrow Guidance (MaixSense-A075V Depth @ 30°)
 *       * Slices left/right crop ridge walls (>60mm elevation) to center rover (±25mm)
 *       * Detects row ends (<520mm wall) for corner U-turns
 *   - Step 5: Edge AI Weed Targeting (YOLOv8 best.pt)
 *       * Pinpoints stem base (X_ground, Y_fwd) in 3D ground coordinates (mm)
 *       * Groups targets into 30mm forward bands sorted by minimum MG996R turret slew (-35°..+35°)
 *   - Step 6: Passive Bad-Chili Surveillance
 *       * Inspects flanking chili crop canopy walls for chlorosis; auto-records 3s MP4 clips
 *   - Step 7: Live Stream Telemetry (/video_feed, /map_feed, /cut_plan)
 *   - ESP32 UART Controller (/dev/ttyUSB0 @ 115200):
 *       * 8-Way Drive: 0° (Fwd), 45°/315° (Steer), 90°/270° (U-Turn Pivot), 180° (Rev)
 *       * Cylinder Turret: MG996R sector gear (-35° to +35°)
 *       * Dual Relay Board: Relay 1 (Grinder Motor) / Relay 2 (Thermal Flame Valve)
 */

import {
  AutoFieldAnalysis,
  FurrowWaypoint,
  NormalizedPoint,
  buildTwoPointSerpentineRoute,
} from './autoFieldPipeline';

export type RelayMode = 'grinder' | 'flame' | 'both';

export type Esp32DriveDeg = 0 | 45 | 90 | 180 | 270 | 315 | null;

export type PiRoverState =
  | 'IDLE'
  | 'FURROW_GUIDANCE'
  | 'FURROW_CENTERING'
  | 'WEED_TARGETING'
  | 'CUT_BAND_ACTIVE'
  | 'ROW_END_DETECTED'
  | 'U_TURN_PIVOT'
  | 'DONE';

export interface FieldWeed {
  id: number;
  nx: number;
  ny: number;
  furrowIndex: number;
  stemRadiusMm: number;
  eliminated: boolean;
}

export interface BadChiliPlant {
  id: number;
  nx: number;
  ny: number;
  side: 'LEFT' | 'RIGHT';
  furrowIndex: number;
  severity: number; // 0.65..0.96 chlorosis index
  recorded: boolean;
}

export interface CutBandTarget {
  weedId: number;
  xGroundMm: number; // lateral offset from rover centerline (-180..+180mm)
  yFwdMm: number; // forward distance ahead of turret (60..420mm)
  bandMm: number; // 30mm band bucket (60, 90, 120, ...)
  turretAngleDeg: number; // -35°..+35° MG996R sector gear angle
  confidence: number;
}

export interface ChlorosisClipRecord {
  clipId: number;
  timestamp: string;
  furrowIndex: number;
  side: 'LEFT' | 'RIGHT';
  severity: number;
  filename: string;
  durationS: number;
  nx: number;
  ny: number;
}

export interface VisibleCameraWeed {
  weedId: number;
  xGroundMm: number;
  yFwdMm: number;
  bandMm: number;
  turretAngleDeg: number;
  confidence: number;
  isCurrentTarget: boolean;
}

export interface LiveRoverSnapshot {
  tick: number;
  state: PiRoverState;
  running: boolean;
  eStopped: boolean;
  relayMode: RelayMode;

  // Map & auto-BEV context
  bevDataUrl: string | null;
  ridgesNx: number[];
  furrowsNx: number[];
  startPoint: NormalizedPoint;
  endPoint: NormalizedPoint | null;
  waypoints: FurrowWaypoint[];
  activeWaypointIdx: number;

  // Rover live pose (normalized 0..1 on BEV map)
  roverNx: number;
  roverNy: number;
  headingDeg: number; // 0 = North (-ny), 90 = East (+nx), 180 = South (+ny), 270 = West (-nx)
  currentFurrow: number;
  totalFurrows: number;
  trail: NormalizedPoint[];

  // Step 4: MaixSense-A075V 3D Furrow Guidance (@ 30°)
  leftWallHeightMm: number;
  rightWallHeightMm: number;
  lateralOffsetMm: number; // ±25mm target band
  frontWallDistanceMm: number; // <520mm triggers row-end U-turn

  // Step 5: YOLOv8 + 30mm Forward Cut-Band Queue
  visibleWeeds: VisibleCameraWeed[];
  cutQueue: CutBandTarget[];
  activeCutTarget: CutBandTarget | null;

  // Step 6: Passive Bad-Chili Chlorosis Surveillance
  recordingClip: {
    active: boolean;
    remainingS: number;
    side: 'LEFT' | 'RIGHT';
    severity: number;
    filename: string;
  } | null;
  badChiliPlants: BadChiliPlant[];
  chlorosisClips: ChlorosisClipRecord[];

  // ESP32 UART Controller (/dev/ttyUSB0 @ 115200)
  esp32DriveDeg: Esp32DriveDeg;
  esp32DriveLabel: string;
  turretAngleDeg: number; // -35..+35°
  relay1Grinder: boolean;
  relay2Flame: boolean;
  lastUartFrame: string;

  // Field entities & totals
  weeds: FieldWeed[];
  totalWeeds: number;
  weedsEliminated: number;
  uTurnsCompleted: number;
  distanceTravelledM: number;
  logs: { tick: number; state: PiRoverState; text: string }[];
}

export interface LaunchMissionConfig {
  analysis: AutoFieldAnalysis | null;
  startPoint: NormalizedPoint;
  endPoint: NormalizedPoint | null;
  relayMode: RelayMode;
  targetMode?: 'SIMULATOR' | 'LIVE_PI';
  seed?: number;
}

function createMulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function driveLabel(deg: Esp32DriveDeg): string {
  switch (deg) {
    case 0:
      return '0° FWD';
    case 45:
      return '45° STEER-R';
    case 315:
      return '315° STEER-L';
    case 90:
      return '90° PIVOT-R';
    case 270:
      return '270° PIVOT-L';
    case 180:
      return '180° REV';
    default:
      return 'HOLD / STOP';
  }
}

export class PiRoverLiveEngine {
  // Physical scale of the warped field plot (meters)
  readonly fieldWidthM = 4.2;
  readonly fieldLengthM = 7.2;
  readonly turretMountFwdMm = 210;

  private rng: () => number;
  private seed = 42;

  bevDataUrl: string | null = null;
  ridgesNx: number[] = [0.1, 0.3, 0.5, 0.7, 0.9];
  furrowsNx: number[] = [0.2, 0.4, 0.6, 0.8];
  startPoint: NormalizedPoint = { nx: 0.2, ny: 0.9 };
  endPoint: NormalizedPoint | null = { nx: 0.8, ny: 0.1 };
  waypoints: FurrowWaypoint[] = [];
  activeWaypointIdx = 1;

  relayMode: RelayMode = 'grinder';
  state: PiRoverState = 'IDLE';
  running = false;
  eStopped = false;
  tickCount = 0;

  roverNx = 0.2;
  roverNy = 0.9;
  headingDeg = 0;
  currentFurrow = 1;
  trail: NormalizedPoint[] = [];

  leftWallHeightMm = 142;
  rightWallHeightMm = 138;
  lateralOffsetMm = 0;
  frontWallDistanceMm = 3200;

  esp32DriveDeg: Esp32DriveDeg = null;
  turretAngleDeg = 0;
  relay1Grinder = false;
  relay2Flame = false;
  lastUartFrame = '{"drive":"STOP","turret":0.0,"r1_grinder":0,"r2_flame":0}';

  weeds: FieldWeed[] = [];
  badChiliPlants: BadChiliPlant[] = [];
  chlorosisClips: ChlorosisClipRecord[] = [];
  recordingClip: LiveRoverSnapshot['recordingClip'] = null;

  cutQueue: CutBandTarget[] = [];
  activeCutTarget: CutBandTarget | null = null;
  private cutDwellTicks = 0;
  private pivotDwellTicks = 0;

  weedsEliminated = 0;
  uTurnsCompleted = 0;
  distanceTravelledM = 0;
  logs: { tick: number; state: PiRoverState; text: string }[] = [];

  constructor(config?: LaunchMissionConfig) {
    this.rng = createMulberry32(42);
    this.configure(
      config ?? {
        analysis: null,
        startPoint: { nx: 0.2, ny: 0.9 },
        endPoint: { nx: 0.8, ny: 0.1 },
        relayMode: 'grinder',
        seed: 42,
      }
    );
  }

  private uniform(min: number, max: number): number {
    return min + this.rng() * (max - min);
  }

  private log(text: string) {
    this.logs.unshift({ tick: this.tickCount, state: this.state, text });
    if (this.logs.length > 45) this.logs.pop();
  }

  private buildUartFrame(): string {
    return JSON.stringify({
      drive: this.esp32DriveDeg === null ? 'STOP' : this.esp32DriveDeg,
      turret: Number(this.turretAngleDeg.toFixed(1)),
      r1_grinder: this.relay1Grinder ? 1 : 0,
      r2_flame: this.relay2Flame ? 1 : 0,
    });
  }

  configure(config: LaunchMissionConfig) {
    this.seed = config.seed ?? 42;
    this.rng = createMulberry32(this.seed);
    this.relayMode = config.relayMode;

    if (config.analysis) {
      this.bevDataUrl = config.analysis.bevDataUrl;
      this.ridgesNx = [...config.analysis.ridgesNx];
      this.furrowsNx = [...config.analysis.furrowsNx];
    } else {
      this.bevDataUrl = null;
      this.ridgesNx = [0.1, 0.3, 0.5, 0.7, 0.9];
      this.furrowsNx = [0.2, 0.4, 0.6, 0.8];
    }

    this.startPoint = { ...config.startPoint };
    this.endPoint = config.endPoint ? { ...config.endPoint } : null;
    this.waypoints = buildTwoPointSerpentineRoute(this.furrowsNx, this.startPoint, this.endPoint);
    this.activeWaypointIdx = this.waypoints.length > 1 ? 1 : 0;

    const first = this.waypoints[0] ?? { nx: this.startPoint.nx, ny: this.startPoint.ny, furrowIndex: 1 };
    this.roverNx = first.nx;
    this.roverNy = first.ny;
    this.currentFurrow = first.furrowIndex;
    const second = this.waypoints[1];
    this.headingDeg = second ? (second.ny < first.ny ? 0 : 180) : 0;

    this.state = 'IDLE';
    this.running = false;
    this.eStopped = false;
    this.tickCount = 0;
    this.trail = [{ nx: this.roverNx, ny: this.roverNy }];
    this.lateralOffsetMm = 0;
    this.frontWallDistanceMm = 4800;
    this.esp32DriveDeg = null;
    this.turretAngleDeg = 0;
    this.relay1Grinder = false;
    this.relay2Flame = false;
    this.cutQueue = [];
    this.activeCutTarget = null;
    this.cutDwellTicks = 0;
    this.pivotDwellTicks = 0;
    this.chlorosisClips = [];
    this.recordingClip = null;
    this.weedsEliminated = 0;
    this.uTurnsCompleted = 0;
    this.distanceTravelledM = 0;
    this.logs = [];
    this.lastUartFrame = this.buildUartFrame();

    this.populateFurrowWeedsAndChili();
    this.log(
      `Pi localized rover at Start (Furrow ${this.currentFurrow}) — ${this.waypoints.length} serpentine waypoints, ${this.weeds.length} furrow weeds, ${this.badChiliPlants.length} chlorosis lesions seeded`
    );
  }

  setRelayMode(mode: RelayMode) {
    this.relayMode = mode;
    this.log(`Dual Relay Board mode switched to ${mode.toUpperCase()}`);
  }

  private populateFurrowWeedsAndChili() {
    this.weeds = [];
    this.badChiliPlants = [];

    // Seed weeds directly inside the traversable furrows covered by the route
    const visitedFurrows = Array.from(new Set(this.waypoints.map((w) => w.furrowIndex)));
    let weedId = 1;
    const lateralHalfNx = 0.14 / this.fieldWidthM; // ±140mm inside turret reach

    visitedFurrows.forEach((fIdx) => {
      const fx = this.furrowsNx[fIdx - 1] ?? 0.5;
      const weedsPerFurrow = 6;
      for (let k = 0; k < weedsPerFurrow; k++) {
        const ny = this.uniform(0.14, 0.86);
        const nx = Math.max(0.04, Math.min(0.96, fx + this.uniform(-lateralHalfNx, lateralHalfNx)));
        // Don't spawn right on top of rover start
        if (Math.hypot(nx - this.roverNx, ny - this.roverNy) < 0.06) continue;
        this.weeds.push({
          id: weedId++,
          nx,
          ny,
          furrowIndex: fIdx,
          stemRadiusMm: this.uniform(14, 24),
          eliminated: false,
        });
      }
    });

    // Seed 3–5 bad-chili chlorosis spots on flanking crop ridges for passive surveillance
    let chiliId = 1;
    const spotCount = Math.min(5, Math.max(3, visitedFurrows.length));
    for (let i = 0; i < spotCount; i++) {
      const fIdx = visitedFurrows[i % visitedFurrows.length];
      const fx = this.furrowsNx[fIdx - 1] ?? 0.5;
      const side: 'LEFT' | 'RIGHT' = i % 2 === 0 ? 'LEFT' : 'RIGHT';
      const offset = side === 'LEFT' ? -0.065 : 0.065;
      this.badChiliPlants.push({
        id: chiliId++,
        nx: Math.max(0.03, Math.min(0.97, fx + offset)),
        ny: this.uniform(0.22, 0.78),
        side,
        furrowIndex: fIdx,
        severity: Number(this.uniform(0.72, 0.95).toFixed(2)),
        recorded: false,
      });
    }
  }

  /**
   * Convert normalized BEV field coordinates into rover-relative ground mm:
   *   xGroundMm: +Right, -Left relative to rover heading
   *   yFwdMm:    +Ahead of rover centerline
   */
  private toRoverGroundMm(nx: number, ny: number): { xGroundMm: number; yFwdMm: number } {
    const dxMm = (nx - this.roverNx) * this.fieldWidthM * 1000;
    const dyMm = (ny - this.roverNy) * this.fieldLengthM * 1000;
    // headingDeg: 0 = North (-ny), 90 = East (+nx), 180 = South (+ny), 270 = West (-nx)
    const rad = (this.headingDeg * Math.PI) / 180;
    const fwdX = Math.sin(rad);
    const fwdY = -Math.cos(rad);
    const rightX = Math.cos(rad);
    const rightY = Math.sin(rad);

    return {
      xGroundMm: dxMm * rightX + dyMm * rightY,
      yFwdMm: dxMm * fwdX + dyMm * fwdY,
    };
  }

  /**
   * Step 5: YOLOv8 stem-base detection + 30mm forward cut-band grouping sorted by minimum turret slew.
   */
  private scanWeedsInCameraFov(): VisibleCameraWeed[] {
    const rawTargets: {
      weedId: number;
      xGroundMm: number;
      yFwdMm: number;
      bandMm: number;
      turretAngleDeg: number;
      confidence: number;
    }[] = [];

    for (const w of this.weeds) {
      if (w.eliminated) continue;
      const { xGroundMm, yFwdMm } = this.toRoverGroundMm(w.nx, w.ny);
      if (yFwdMm >= 50 && yFwdMm <= 620 && Math.abs(xGroundMm) <= 210) {
        const bandMm = Math.floor(yFwdMm / 30) * 30;
        const angleRad = Math.atan2(xGroundMm, Math.max(90, this.turretMountFwdMm));
        const turretAngleDeg = Math.max(-35, Math.min(35, (angleRad * 180) / Math.PI));
        rawTargets.push({
          weedId: w.id,
          xGroundMm: Number(xGroundMm.toFixed(1)),
          yFwdMm: Number(yFwdMm.toFixed(1)),
          bandMm,
          turretAngleDeg: Number(turretAngleDeg.toFixed(1)),
          confidence: Number(Math.min(0.99, Math.max(0.81, (w.stemRadiusMm / 24) * 0.96)).toFixed(2)),
        });
      }
    }

    // Group into 30mm forward bands and sort each band by minimum turret slew from current turretAngleDeg
    const byBand = new Map<number, typeof rawTargets>();
    rawTargets.forEach((t) => {
      const list = byBand.get(t.bandMm) ?? [];
      list.push(t);
      byBand.set(t.bandMm, list);
    });

    const sorted: VisibleCameraWeed[] = [];
    let curAngle = this.turretAngleDeg;
    Array.from(byBand.keys())
      .sort((a, b) => a - b)
      .forEach((band) => {
        const rem = [...(byBand.get(band) ?? [])];
        while (rem.length > 0) {
          rem.sort((a, b) => Math.abs(a.turretAngleDeg - curAngle) - Math.abs(b.turretAngleDeg - curAngle));
          const nxt = rem.shift()!;
          sorted.push({
            ...nxt,
            isCurrentTarget: this.activeCutTarget?.weedId === nxt.weedId,
          });
          curAngle = nxt.turretAngleDeg;
        }
      });

    return sorted;
  }

  /**
   * Step 6: Passive Bad-Chili Chlorosis Surveillance along side canopy walls.
   */
  private checkSideCanopyChlorosis() {
    if (this.recordingClip) {
      const nextRem = Number((this.recordingClip.remainingS - 0.25).toFixed(2));
      if (nextRem <= 0) {
        this.log(`Saved 3.0s chlorosis surveillance clip: ${this.recordingClip.filename}`);
        this.recordingClip = null;
      } else {
        this.recordingClip = { ...this.recordingClip, remainingS: nextRem };
      }
      return;
    }

    for (const plant of this.badChiliPlants) {
      if (plant.recorded) continue;
      const { xGroundMm, yFwdMm } = this.toRoverGroundMm(plant.nx, plant.ny);
      if (yFwdMm >= -60 && yFwdMm <= 460 && Math.abs(xGroundMm) <= 380) {
        plant.recorded = true;
        const clipId = this.chlorosisClips.length + 1;
        const filename = `bad_chili_r${plant.furrowIndex}_${plant.side.toLowerCase()}_${String(clipId).padStart(2, '0')}.mp4`;
        const ts = new Date().toLocaleTimeString([], { hour12: false });
        this.chlorosisClips.unshift({
          clipId,
          timestamp: ts,
          furrowIndex: plant.furrowIndex,
          side: plant.side,
          severity: plant.severity,
          filename,
          durationS: 3.0,
          nx: plant.nx,
          ny: plant.ny,
        });
        this.recordingClip = {
          active: true,
          remainingS: 3.0,
          side: plant.side,
          severity: plant.severity,
          filename,
        };
        this.log(
          `Passive Surveillance: Bad-Chili chlorosis (${Math.round(plant.severity * 100)}%) on ${plant.side} canopy — auto-recording 3s MP4`
        );
        break;
      }
    }
  }

  emergencyStop() {
    this.eStopped = true;
    this.running = false;
    this.esp32DriveDeg = null;
    this.relay1Grinder = false;
    this.relay2Flame = false;
    this.state = 'IDLE';
    this.lastUartFrame = this.buildUartFrame();
    this.log('*** EMERGENCY STOP — ESP32 Drive & Dual Relays CUT ***');
  }

  clearEmergencyStop() {
    this.eStopped = false;
    this.log('E-STOP cleared — ready to resume furrow mission');
  }

  tick() {
    if (this.eStopped || this.state === 'DONE') {
      this.running = false;
      return;
    }

    this.tickCount++;
    this.relay1Grinder = false;
    this.relay2Flame = false;

    const targetWp = this.waypoints[this.activeWaypointIdx];
    if (!targetWp) {
      this.state = 'DONE';
      this.running = false;
      this.esp32DriveDeg = null;
      this.turretAngleDeg = 0;
      this.lastUartFrame = this.buildUartFrame();
      this.log(`MISSION COMPLETE — ${this.weedsEliminated}/${this.weeds.length} weeds cleared, ${this.chlorosisClips.length} bad-chili clips saved`);
      return;
    }

    // Passive side-canopy chlorosis monitoring runs continuously during travel
    this.checkSideCanopyChlorosis();

    // Update MaixSense-A075V 3D furrow wall depth slices (>60mm elevation)
    this.leftWallHeightMm = Math.round(136 + Math.sin(this.tickCount * 0.45) * 14);
    this.rightWallHeightMm = Math.round(140 + Math.cos(this.tickCount * 0.38) * 14);

    // 1. If actively dwelling on a weed stem cut target, complete cut & fire Dual Relay
    if (this.activeCutTarget) {
      const target = this.activeCutTarget;
      // Smoothly slew MG996R turret toward target angle
      const angleDiff = target.turretAngleDeg - this.turretAngleDeg;
      if (Math.abs(angleDiff) > 4.0) {
        this.state = 'WEED_TARGETING';
        this.esp32DriveDeg = null;
        this.turretAngleDeg = Number(
          (this.turretAngleDeg + Math.sign(angleDiff) * Math.min(18, Math.abs(angleDiff))).toFixed(1)
        );
        this.lastUartFrame = this.buildUartFrame();
        return;
      }

      this.turretAngleDeg = target.turretAngleDeg;
      this.state = 'CUT_BAND_ACTIVE';
      this.esp32DriveDeg = null;
      this.relay1Grinder = this.relayMode === 'grinder' || this.relayMode === 'both';
      this.relay2Flame = this.relayMode === 'flame' || this.relayMode === 'both';
      this.cutDwellTicks++;

      if (this.cutDwellTicks >= 2) {
        const weed = this.weeds.find((w) => w.id === target.weedId);
        if (weed && !weed.eliminated) {
          weed.eliminated = true;
          this.weedsEliminated++;
          const toolName =
            this.relayMode === 'both'
              ? 'Grinder+Flame'
              : this.relayMode === 'flame'
              ? 'Thermal Flame'
              : 'Grinder Motor';
          this.log(
            `CUT Band ${target.bandMm}mm → Weed #${weed.id} (${target.xGroundMm > 0 ? '+' : ''}${target.xGroundMm}mm, ${target.yFwdMm}mm) @ turret ${target.turretAngleDeg > 0 ? '+' : ''}${target.turretAngleDeg}° [${toolName}]`
          );
        }
        this.activeCutTarget = null;
        this.cutDwellTicks = 0;
      }
      this.lastUartFrame = this.buildUartFrame();
      return;
    }

    // 2. Determine whether current leg is a Furrow Run (vertical in BEV) or Headland U-Turn (horizontal)
    const dx = targetWp.nx - this.roverNx;
    const dy = targetWp.ny - this.roverNy;
    const dxM = dx * this.fieldWidthM;
    const dyM = dy * this.fieldLengthM;
    const distM = Math.hypot(dxM, dyM);
    const isHeadlandCross = Math.abs(dx) > Math.abs(dy) * 1.1;

    // Update front MaixSense wall distance along current furrow
    this.frontWallDistanceMm = isHeadlandCross
      ? 420
      : Math.round(Math.max(260, Math.min(4500, distM * 1000)));

    // 3. During Furrow Runs, check YOLOv8 30mm forward cut-band targets within immediate turret reach (55..250mm)
    const visible = this.scanWeedsInCameraFov();
    this.cutQueue = visible.map(({ isCurrentTarget: _, ...rest }) => rest);

    if (!isHeadlandCross) {
      const inCutZone = this.cutQueue.find((t) => t.yFwdMm >= 60 && t.yFwdMm <= 260);
      if (inCutZone) {
        this.activeCutTarget = inCutZone;
        this.cutDwellTicks = 0;
        this.state = 'WEED_TARGETING';
        this.esp32DriveDeg = null;
        this.log(
          `YOLOv8 Lock: Band ${inCutZone.bandMm}mm · Weed #${inCutZone.weedId} stem (${inCutZone.xGroundMm}mm, ${inCutZone.yFwdMm}mm) → slewing MG996R to ${inCutZone.turretAngleDeg > 0 ? '+' : ''}${inCutZone.turretAngleDeg}°`
        );
        this.lastUartFrame = this.buildUartFrame();
        return;
      }
    }

    // 4. Advance along furrow or execute 90°/270° headland U-turn pivot
    if (distM < 0.08) {
      this.roverNx = targetWp.nx;
      this.roverNy = targetWp.ny;
      this.currentFurrow = targetWp.furrowIndex;
      this.activeWaypointIdx++;
      const nextWp = this.waypoints[this.activeWaypointIdx];

      if (!nextWp) {
        this.state = 'DONE';
        this.running = false;
        this.esp32DriveDeg = null;
        this.turretAngleDeg = 0;
        this.log(
          `Arrived at End Point — Mission Complete (${this.weedsEliminated}/${this.weeds.length} weeds eliminated)`
        );
      } else {
        const nextIsCross = Math.abs(nextWp.nx - this.roverNx) > Math.abs(nextWp.ny - this.roverNy);
        if (nextIsCross) {
          this.state = 'ROW_END_DETECTED';
          this.pivotDwellTicks = 1;
          this.esp32DriveDeg = nextWp.nx > this.roverNx ? 90 : 270;
          this.log(
            `MaixSense-A075V detected row end (<520mm wall) — commanding ESP32 ${driveLabel(this.esp32DriveDeg)} U-turn to Furrow ${nextWp.furrowIndex}`
          );
        } else {
          this.uTurnsCompleted++;
          this.headingDeg = nextWp.ny < this.roverNy ? 0 : 180;
          this.state = 'FURROW_GUIDANCE';
          this.log(`Aligned into Furrow ${nextWp.furrowIndex} (heading ${this.headingDeg}°) — resuming 3D furrow guidance`);
        }
      }
      this.lastUartFrame = this.buildUartFrame();
      return;
    }

    if (this.pivotDwellTicks > 0) {
      this.pivotDwellTicks--;
      this.state = 'U_TURN_PIVOT';
      this.headingDeg = dx > 0 ? 90 : 270;
      this.esp32DriveDeg = dx > 0 ? 90 : 270;
      this.lastUartFrame = this.buildUartFrame();
      return;
    }

    // Move one step forward along planned leg
    const stepM = isHeadlandCross ? 0.16 : 0.14;
    const moveRatio = Math.min(1, stepM / Math.max(0.01, distM));
    this.roverNx += dx * moveRatio;
    this.roverNy += dy * moveRatio;
    this.distanceTravelledM += Math.min(stepM, distM);
    this.trail.push({ nx: this.roverNx, ny: this.roverNy });
    if (this.trail.length > 700) this.trail.shift();

    // Re-center MG996R turret gently toward 0° while cruising
    if (Math.abs(this.turretAngleDeg) > 2) {
      this.turretAngleDeg = Number((this.turretAngleDeg * 0.65).toFixed(1));
    } else {
      this.turretAngleDeg = 0;
    }

    if (isHeadlandCross) {
      this.headingDeg = dx > 0 ? 90 : 270;
      this.state = 'U_TURN_PIVOT';
      this.esp32DriveDeg = dx > 0 ? 90 : 270;
      this.lateralOffsetMm = 0;
    } else {
      this.headingDeg = dy < 0 ? 0 : 180;
      // Simulate real-world furrow drift & ±25mm MaixSense centering correction via ESP32 45°/315°
      const rawDrift = Math.sin(this.tickCount * 0.55) * 31;
      this.lateralOffsetMm = Number(rawDrift.toFixed(1));
      if (this.frontWallDistanceMm < 520) {
        this.state = 'ROW_END_DETECTED';
        this.esp32DriveDeg = 0;
      } else if (Math.abs(this.lateralOffsetMm) > 25) {
        this.state = 'FURROW_CENTERING';
        this.esp32DriveDeg = this.lateralOffsetMm > 0 ? 315 : 45;
      } else {
        this.state = 'FURROW_GUIDANCE';
        this.esp32DriveDeg = 0;
      }
    }

    this.lastUartFrame = this.buildUartFrame();
  }

  getSnapshot(): LiveRoverSnapshot {
    const visibleWeeds = this.scanWeedsInCameraFov();
    const totalFurrows = new Set(this.waypoints.map((w) => w.furrowIndex)).size;

    return {
      tick: this.tickCount,
      state: this.state,
      running: this.running,
      eStopped: this.eStopped,
      relayMode: this.relayMode,
      bevDataUrl: this.bevDataUrl,
      ridgesNx: [...this.ridgesNx],
      furrowsNx: [...this.furrowsNx],
      startPoint: { ...this.startPoint },
      endPoint: this.endPoint ? { ...this.endPoint } : null,
      waypoints: [...this.waypoints],
      activeWaypointIdx: this.activeWaypointIdx,
      roverNx: this.roverNx,
      roverNy: this.roverNy,
      headingDeg: this.headingDeg,
      currentFurrow: this.currentFurrow,
      totalFurrows,
      trail: [...this.trail],
      leftWallHeightMm: this.leftWallHeightMm,
      rightWallHeightMm: this.rightWallHeightMm,
      lateralOffsetMm: this.lateralOffsetMm,
      frontWallDistanceMm: this.frontWallDistanceMm,
      visibleWeeds,
      cutQueue: [...this.cutQueue],
      activeCutTarget: this.activeCutTarget ? { ...this.activeCutTarget } : null,
      recordingClip: this.recordingClip ? { ...this.recordingClip } : null,
      badChiliPlants: this.badChiliPlants.map((b) => ({ ...b })),
      chlorosisClips: [...this.chlorosisClips],
      esp32DriveDeg: this.esp32DriveDeg,
      esp32DriveLabel: driveLabel(this.esp32DriveDeg),
      turretAngleDeg: this.turretAngleDeg,
      relay1Grinder: this.relay1Grinder,
      relay2Flame: this.relay2Flame,
      lastUartFrame: this.lastUartFrame,
      weeds: this.weeds.map((w) => ({ ...w })),
      totalWeeds: this.weeds.length,
      weedsEliminated: this.weedsEliminated,
      uTurnsCompleted: this.uTurnsCompleted,
      distanceTravelledM: this.distanceTravelledM,
      logs: [...this.logs],
    };
  }
}
