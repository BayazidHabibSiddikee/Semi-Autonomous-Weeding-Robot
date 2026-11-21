/**
 * row_end_detection Service
 *
 * Implements ROS 2 `/navigation/row_end_detection` vision service semantics:
 * runs real-time video frame analysis (ExG + Otsu foliage segmentation +
 * pinhole ground-plane projection) to calculate distance to the furrow end (m),
 * applies multi-frame temporal debounce, raises Turn Execution Alerts, and
 * emits explicit state transitions (FOLLOW_CROP_ROW -> ROW_END_STOP ->
 * NAV2_HEADLAND_TURN -> FOLLOW_CROP_ROW / MISSION_COMPLETE).
 */

import { detectCropRowFromFrame, RealRowObservation } from '../vision/cropRowVision';

export type TurnDirection = 'RIGHT_U_TURN' | 'LEFT_U_TURN' | 'FINAL_ROW_STOP';

export type RowEndServiceState =
  | 'SCANNING'
  | 'APPROACHING_ROW_END'
  | 'ROW_END_DETECTED'
  | 'TURN_EXECUTING'
  | 'COOLDOWN'
  | 'DISABLED';

export type TurnDispatchMode = 'alert_and_confirm' | 'auto_execute';

export type NavTurnState =
  | 'FOLLOW_CROP_ROW'
  | 'ROW_END_STOP'
  | 'NAV2_HEADLAND_TURN'
  | 'MISSION_COMPLETE';

export interface RowEndDetectionConfig {
  enabled: boolean;
  triggerDistanceM: number; // Vision-calculated distance threshold to trigger turn transition (m)
  confidenceThreshold: number; // 0.55..0.95
  confirmFrames: number; // Consecutive vision frames required
  farGreenCutoff: number; // 0.01..0.12 far-ROI green ratio ceiling
  turnDispatchMode: TurnDispatchMode;
  cooldownMs: number;
  audioAlert: boolean;
}

export interface RowEndVisionInput {
  rowEndConfidence: number; // 0..1 from cropRowVision / vision node
  distanceToFurrowEndM: number; // Projected distance to furrow end (m)
  furrowEndYPx?: number; // Topmost foliage horizon Y pixel in analyzed frame
  greenRatioFar: number; // 0..1 top 1/3 ROI ExG foliage ratio
  greenRatioNear: number; // 0..1 bottom 1/2 ROI ExG foliage ratio
  roverSpeedMps: number; // Current linear speed for ETA calculation
  trackingLocked: boolean;
  missedFrames: number;
  currentRow: number; // 1-indexed
  totalRows: number;
  direction: 1 | -1; // +1 eastbound, -1 westbound
  sourceLabel: string;
  isLiveCamera: boolean;
  timestampMs: number;
}

export interface RowEndStateTransition {
  id: string;
  fromState: NavTurnState;
  toState: NavTurnState;
  row: number;
  distanceToFurrowEndM: number;
  confidence: number;
  reason: string;
  timestamp: string;
}

export interface RowEndTurnAlert {
  id: string;
  row: number;
  nextRow: number | null;
  recommendedTurn: TurnDirection;
  distanceToFurrowEndM: number;
  confidence: number;
  farGreenPct: number;
  nearGreenPct: number;
  sourceLabel: string;
  triggeredAt: string;
  status: 'PENDING_TURN' | 'EXECUTING' | 'COMPLETED' | 'DISMISSED';
  reason: string;
}

export interface RowEndServiceResponse {
  serviceName: '/navigation/row_end_detection';
  rowEndDetected: boolean;
  distanceToFurrowEndM: number;
  triggerDistanceM: number;
  etaSeconds: number | null;
  confidence: number;
  farGreenPct: number;
  nearGreenPct: number;
  confirmCount: number;
  confirmRequired: number;
  recommendedTurn: TurnDirection;
  nextRow: number | null;
  state: RowEndServiceState;
  targetNavState: NavTurnState;
  reason: string;
  timestamp: string;
}

export interface RowEndDetectionSnapshot {
  state: RowEndServiceState;
  navState: NavTurnState;
  distanceToFurrowEndM: number;
  rawDistanceToFurrowEndM: number;
  etaSeconds: number | null;
  confidence: number;
  farGreenPct: number;
  nearGreenPct: number;
  confirmCount: number;
  confirmRequired: number;
  recommendedTurn: TurnDirection;
  nextRow: number | null;
  currentRow: number;
  sourceLabel: string;
  cooldownRemainingMs: number;
  activeAlert: RowEndTurnAlert | null;
  alertHistory: RowEndTurnAlert[];
  stateTransitions: RowEndStateTransition[];
  lastServiceResponse: RowEndServiceResponse | null;
  checksEvaluated: number;
}

export const DEFAULT_ROW_END_CONFIG: RowEndDetectionConfig = {
  enabled: true,
  triggerDistanceM: 0.55,
  confidenceThreshold: 0.78,
  confirmFrames: 4,
  farGreenCutoff: 0.045,
  turnDispatchMode: 'alert_and_confirm',
  cooldownMs: 3200,
  audioAlert: false,
};

export function computeRecommendedTurn(
  currentRow: number,
  totalRows: number,
  direction: 1 | -1
): { recommendedTurn: TurnDirection; nextRow: number | null } {
  if (currentRow >= totalRows) {
    return { recommendedTurn: 'FINAL_ROW_STOP', nextRow: null };
  }
  return {
    recommendedTurn: direction > 0 ? 'RIGHT_U_TURN' : 'LEFT_U_TURN',
    nextRow: currentRow + 1,
  };
}

export function formatTurnLabel(turn: TurnDirection): string {
  if (turn === 'RIGHT_U_TURN') return 'Right Headland U-Turn (180°)';
  if (turn === 'LEFT_U_TURN') return 'Left Headland U-Turn (180°)';
  return 'Final Row Stop (Mission Complete)';
}

export function playRowEndAlertChime(): void {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const tones = [
      { freq: 660, start: 0, dur: 0.11 },
      { freq: 880, start: 0.13, dur: 0.16 },
    ];

    for (const tone of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(tone.freq, now + tone.start);
      gain.gain.setValueAtTime(0.001, now + tone.start);
      gain.gain.exponentialRampToValueAtTime(0.08, now + tone.start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + tone.start + tone.dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + tone.start);
      osc.stop(now + tone.start + tone.dur + 0.02);
    }

    window.setTimeout(() => {
      void ctx.close().catch(() => undefined);
    }, 450);
  } catch {
    // Ignore autoplay restrictions
  }
}

export class RowEndDetectionService {
  private config: RowEndDetectionConfig;
  private state: RowEndServiceState = 'SCANNING';
  private navState: NavTurnState = 'FOLLOW_CROP_ROW';
  private confirmCount = 0;
  private cooldownUntilMs = 0;
  private smoothedDistanceM = 2.2;
  private rawDistanceM = 2.2;
  private hasDistanceSample = false;
  private lastEtaSec: number | null = null;
  private lastConfidence = 0;
  private lastFarGreenPct = 18.0;
  private lastNearGreenPct = 24.0;
  private lastRow = 1;
  private lastDirection: 1 | -1 = 1;
  private lastTotalRows = 4;
  private lastSourceLabel = 'FIELD SIM · /crop_row/alignment';
  private activeAlert: RowEndTurnAlert | null = null;
  private alertHistory: RowEndTurnAlert[] = [];
  private stateTransitions: RowEndStateTransition[] = [];
  private lastServiceResponse: RowEndServiceResponse | null = null;
  private checksEvaluated = 0;
  private alertSeq = 1;
  private transitionSeq = 1;

  constructor(initialConfig?: Partial<RowEndDetectionConfig>) {
    this.config = { ...DEFAULT_ROW_END_CONFIG, ...initialConfig };
    if (!this.config.enabled) {
      this.state = 'DISABLED';
    }
  }

  public updateConfig(patch: Partial<RowEndDetectionConfig>): void {
    this.config = { ...this.config, ...patch };
    if (!this.config.enabled) {
      this.state = 'DISABLED';
      this.confirmCount = 0;
    } else if (this.state === 'DISABLED') {
      this.state = this.activeAlert
        ? this.activeAlert.status === 'EXECUTING'
          ? 'TURN_EXECUTING'
          : 'ROW_END_DETECTED'
        : 'SCANNING';
    }
  }

  public getConfig(): RowEndDetectionConfig {
    return { ...this.config };
  }

  /**
   * Direct real-time video frame analysis entry point:
   * runs ExG + Otsu foliage segmentation & pinhole furrow-end distance projection on raw RGBA pixels.
   */
  public analyzeVideoFrame(
    imageData: ImageData,
    options: { rowWidthM: number; minExgFloor?: number }
  ): RealRowObservation {
    const { observation } = detectCropRowFromFrame(imageData, options);
    return observation;
  }

  private recordStateTransition(
    fromState: NavTurnState,
    toState: NavTurnState,
    reason: string
  ): RowEndStateTransition {
    const transition: RowEndStateTransition = {
      id: `TRN-${String(this.transitionSeq++).padStart(3, '0')}`,
      fromState,
      toState,
      row: this.lastRow,
      distanceToFurrowEndM: this.smoothedDistanceM,
      confidence: this.lastConfidence,
      reason,
      timestamp: new Date().toLocaleTimeString(),
    };
    this.navState = toState;
    this.stateTransitions = [transition, ...this.stateTransitions].slice(0, 8);
    return transition;
  }

  /**
   * Process a continuous real-time vision frame observation and calculate smoothed distance
   * to the furrow end. Emits a Turn Execution Alert and FOLLOW_CROP_ROW -> ROW_END_STOP
   * transition when distance or confidence crosses thresholds for confirmFrames frames.
   */
  public processVisionFrame(input: RowEndVisionInput): {
    newlyTriggeredAlert: RowEndTurnAlert | null;
    transitionTriggered: RowEndStateTransition | null;
    snapshot: RowEndDetectionSnapshot;
  } {
    this.checksEvaluated += 1;
    this.lastRow = input.currentRow;
    this.lastTotalRows = input.totalRows;
    this.lastDirection = input.direction;
    this.lastSourceLabel = input.sourceLabel;

    const farPct = Math.max(0, Math.min(100, input.greenRatioFar * 100));
    const nearPct = Math.max(0, Math.min(100, input.greenRatioNear * 100));
    this.lastFarGreenPct = farPct;
    this.lastNearGreenPct = nearPct;

    // EMA filter on vision-projected furrow-end distance (alpha = 0.38)
    const clampedDistM = Math.max(0.15, Math.min(8.5, input.distanceToFurrowEndM));
    this.rawDistanceM = clampedDistM;
    if (!this.hasDistanceSample) {
      this.smoothedDistanceM = clampedDistM;
      this.hasDistanceSample = true;
    } else {
      this.smoothedDistanceM = 0.62 * this.smoothedDistanceM + 0.38 * clampedDistM;
    }

    this.lastEtaSec =
      input.roverSpeedMps > 0.02
        ? Math.max(0, Number((this.smoothedDistanceM / input.roverSpeedMps).toFixed(1)))
        : null;

    // Combine distance-to-furrow-end proximity cue with far-ROI ExG foliage depletion
    const distCue =
      this.smoothedDistanceM <= this.config.triggerDistanceM * 2.2
        ? Math.max(
            0,
            Math.min(
              1,
              (this.config.triggerDistanceM * 2.2 - this.smoothedDistanceM) /
                Math.max(this.config.triggerDistanceM * 1.2, 0.25)
            )
          )
        : 0;
    const farDepletedScore =
      input.greenRatioFar <= this.config.farGreenCutoff
        ? 1.0 - input.greenRatioFar / Math.max(this.config.farGreenCutoff, 1e-4)
        : 0;

    const effectiveConfidence = Math.max(
      0,
      Math.min(1, Math.max(input.rowEndConfidence, distCue * 0.92, farDepletedScore * 0.86))
    );
    this.lastConfidence = effectiveConfidence;

    if (!this.config.enabled) {
      this.state = 'DISABLED';
      return {
        newlyTriggeredAlert: null,
        transitionTriggered: null,
        snapshot: this.getSnapshot(input.timestampMs),
      };
    }

    if (this.state === 'TURN_EXECUTING') {
      return {
        newlyTriggeredAlert: null,
        transitionTriggered: null,
        snapshot: this.getSnapshot(input.timestampMs),
      };
    }
    if (this.state === 'ROW_END_DETECTED' && this.activeAlert?.status === 'PENDING_TURN') {
      return {
        newlyTriggeredAlert: null,
        transitionTriggered: null,
        snapshot: this.getSnapshot(input.timestampMs),
      };
    }

    if (input.timestampMs < this.cooldownUntilMs) {
      this.state = 'COOLDOWN';
      this.confirmCount = 0;
      return {
        newlyTriggeredAlert: null,
        transitionTriggered: null,
        snapshot: this.getSnapshot(input.timestampMs),
      };
    }

    const withinTriggerDistance = this.smoothedDistanceM <= this.config.triggerDistanceM;
    const approachingDistance = this.smoothedDistanceM <= this.config.triggerDistanceM * 2.1;
    const warningThreshold = Math.max(0.35, this.config.confidenceThreshold - 0.24);

    const meetsTrigger =
      withinTriggerDistance ||
      (effectiveConfidence >= this.config.confidenceThreshold &&
        (input.greenRatioFar <= this.config.farGreenCutoff * 1.6 || effectiveConfidence >= 0.84));

    if (meetsTrigger) {
      this.confirmCount = Math.min(this.config.confirmFrames, this.confirmCount + 1);
      if (this.confirmCount >= this.config.confirmFrames) {
        const alert = this.createAndLatchAlert(
          input,
          effectiveConfidence,
          this.smoothedDistanceM,
          farPct,
          nearPct
        );
        const transition = this.recordStateTransition(
          'FOLLOW_CROP_ROW',
          'ROW_END_STOP',
          `Furrow-end distance ${this.smoothedDistanceM.toFixed(2)} m ≤ ${this.config.triggerDistanceM.toFixed(
            2
          )} m (${Math.round(effectiveConfidence * 100)}% conf)`
        );
        return {
          newlyTriggeredAlert: alert,
          transitionTriggered: transition,
          snapshot: this.getSnapshot(input.timestampMs),
        };
      }
      this.state = 'APPROACHING_ROW_END';
    } else if (approachingDistance || effectiveConfidence >= warningThreshold) {
      this.confirmCount = Math.max(0, this.confirmCount - 1);
      this.state = 'APPROACHING_ROW_END';
    } else {
      this.confirmCount = 0;
      this.state = 'SCANNING';
    }

    return {
      newlyTriggeredAlert: null,
      transitionTriggered: null,
      snapshot: this.getSnapshot(input.timestampMs),
    };
  }

  /**
   * Synchronous ROS 2 service invocation: `/navigation/row_end_detection`
   */
  public invokeServiceCheck(input: RowEndVisionInput): {
    response: RowEndServiceResponse;
    newlyTriggeredAlert: RowEndTurnAlert | null;
    transitionTriggered: RowEndStateTransition | null;
    snapshot: RowEndDetectionSnapshot;
  } {
    const farPct = Math.max(0, Math.min(100, input.greenRatioFar * 100));
    const nearPct = Math.max(0, Math.min(100, input.greenRatioNear * 100));
    const distM = Math.max(0.15, Math.min(8.5, input.distanceToFurrowEndM));
    this.smoothedDistanceM = distM;
    this.rawDistanceM = distM;
    this.hasDistanceSample = true;

    const { recommendedTurn, nextRow } = computeRecommendedTurn(
      input.currentRow,
      input.totalRows,
      input.direction
    );

    const detected =
      this.config.enabled &&
      (distM <= this.config.triggerDistanceM ||
        input.rowEndConfidence >= this.config.confidenceThreshold ||
        input.greenRatioFar <= this.config.farGreenCutoff);

    let newlyTriggeredAlert: RowEndTurnAlert | null = null;
    let transitionTriggered: RowEndStateTransition | null = null;

    if (
      detected &&
      this.state !== 'TURN_EXECUTING' &&
      this.activeAlert?.status !== 'PENDING_TURN'
    ) {
      this.confirmCount = this.config.confirmFrames;
      newlyTriggeredAlert = this.createAndLatchAlert(
        input,
        Math.max(input.rowEndConfidence, this.config.confidenceThreshold),
        distM,
        farPct,
        nearPct
      );
      transitionTriggered = this.recordStateTransition(
        'FOLLOW_CROP_ROW',
        'ROW_END_STOP',
        `RPC check confirmed furrow end at ${distM.toFixed(2)} m`
      );
    }

    const targetNavState: NavTurnState = detected ? 'ROW_END_STOP' : this.navState;
    const reason = !this.config.enabled
      ? 'Service paused by operator.'
      : detected
      ? `Furrow end at ${distM.toFixed(2)} m (≤ ${this.config.triggerDistanceM.toFixed(
          2
        )} m), Far-ROI ${farPct.toFixed(1)}% -> Transition to ROW_END_STOP (${formatTurnLabel(
          recommendedTurn
        )})`
      : `Furrow continues (${distM.toFixed(2)} m to end > ${this.config.triggerDistanceM.toFixed(
          2
        )} m threshold, Far-ROI ${farPct.toFixed(1)}%).`;

    const response: RowEndServiceResponse = {
      serviceName: '/navigation/row_end_detection',
      rowEndDetected: detected,
      distanceToFurrowEndM: distM,
      triggerDistanceM: this.config.triggerDistanceM,
      etaSeconds:
        input.roverSpeedMps > 0.02 ? Number((distM / input.roverSpeedMps).toFixed(1)) : null,
      confidence: input.rowEndConfidence,
      farGreenPct: farPct,
      nearGreenPct: nearPct,
      confirmCount: this.confirmCount,
      confirmRequired: this.config.confirmFrames,
      recommendedTurn,
      nextRow,
      state: this.state,
      targetNavState,
      reason,
      timestamp: new Date().toLocaleTimeString(),
    };

    this.lastServiceResponse = response;
    return {
      response,
      newlyTriggeredAlert,
      transitionTriggered,
      snapshot: this.getSnapshot(input.timestampMs),
    };
  }

  private createAndLatchAlert(
    input: RowEndVisionInput,
    confidence: number,
    distanceM: number,
    farPct: number,
    nearPct: number
  ): RowEndTurnAlert {
    const { recommendedTurn, nextRow } = computeRecommendedTurn(
      input.currentRow,
      input.totalRows,
      input.direction
    );

    const alert: RowEndTurnAlert = {
      id: `RED-${String(this.alertSeq++).padStart(3, '0')}`,
      row: input.currentRow,
      nextRow,
      recommendedTurn,
      distanceToFurrowEndM: distanceM,
      confidence,
      farGreenPct: farPct,
      nearGreenPct: nearPct,
      sourceLabel: input.sourceLabel,
      triggeredAt: new Date().toLocaleTimeString(),
      status: 'PENDING_TURN',
      reason: `Furrow end at ${distanceM.toFixed(2)} m (Far-ROI ${farPct.toFixed(1)}% green, ${
        this.config.confirmFrames
      }/${this.config.confirmFrames} frames)`,
    };

    this.state = 'ROW_END_DETECTED';
    this.activeAlert = alert;
    this.alertHistory = [alert, ...this.alertHistory].slice(0, 6);

    if (this.config.audioAlert) {
      playRowEndAlertChime();
    }

    return alert;
  }

  public acknowledgeTurnStart(origin: 'operator' | 'auto' = 'operator'): RowEndDetectionSnapshot {
    if (this.activeAlert) {
      this.activeAlert = { ...this.activeAlert, status: 'EXECUTING' };
      this.alertHistory = this.alertHistory.map((item) =>
        item.id === this.activeAlert?.id ? { ...item, status: 'EXECUTING' } : item
      );
    }
    this.recordStateTransition(
      this.navState,
      'NAV2_HEADLAND_TURN',
      `Turn execution dispatched (${origin}) -> Row ${this.lastRow + 1}`
    );
    this.state = 'TURN_EXECUTING';
    this.confirmCount = 0;
    return this.getSnapshot(performance.now());
  }

  public notifyTurnComplete(
    missionComplete = false,
    nowMs = performance.now()
  ): RowEndDetectionSnapshot {
    if (this.activeAlert) {
      const doneId = this.activeAlert.id;
      this.alertHistory = this.alertHistory.map((item) =>
        item.id === doneId ? { ...item, status: 'COMPLETED' } : item
      );
      this.activeAlert = null;
    }
    this.recordStateTransition(
      this.navState,
      missionComplete ? 'MISSION_COMPLETE' : 'FOLLOW_CROP_ROW',
      missionComplete
        ? `Final row (Row ${this.lastRow}) completed at headland`
        : `Headland U-turn finished — entered Row ${this.lastRow + 1}`
    );
    this.confirmCount = 0;
    this.hasDistanceSample = false;
    this.cooldownUntilMs = nowMs + this.config.cooldownMs;
    this.state = this.config.enabled ? 'COOLDOWN' : 'DISABLED';
    return this.getSnapshot(nowMs);
  }

  public dismissAlert(nowMs = performance.now()): RowEndDetectionSnapshot {
    if (this.activeAlert) {
      const dismissedId = this.activeAlert.id;
      this.alertHistory = this.alertHistory.map((item) =>
        item.id === dismissedId ? { ...item, status: 'DISMISSED' } : item
      );
      this.activeAlert = null;
    }
    this.recordStateTransition(
      this.navState,
      'FOLLOW_CROP_ROW',
      'Operator dismissed row-end turn alert'
    );
    this.confirmCount = 0;
    this.cooldownUntilMs = nowMs + this.config.cooldownMs;
    this.state = this.config.enabled ? 'COOLDOWN' : 'DISABLED';
    return this.getSnapshot(nowMs);
  }

  public reset(): RowEndDetectionSnapshot {
    this.state = this.config.enabled ? 'SCANNING' : 'DISABLED';
    this.navState = 'FOLLOW_CROP_ROW';
    this.confirmCount = 0;
    this.cooldownUntilMs = 0;
    this.lastConfidence = 0;
    this.hasDistanceSample = false;
    this.smoothedDistanceM = 2.2;
    this.rawDistanceM = 2.2;
    this.lastEtaSec = null;
    this.activeAlert = null;
    this.lastServiceResponse = null;
    return this.getSnapshot(performance.now());
  }

  public getSnapshot(nowMs = performance.now()): RowEndDetectionSnapshot {
    const { recommendedTurn, nextRow } = computeRecommendedTurn(
      this.lastRow,
      this.lastTotalRows,
      this.lastDirection
    );
    return {
      state: this.state,
      navState: this.navState,
      distanceToFurrowEndM: this.smoothedDistanceM,
      rawDistanceToFurrowEndM: this.rawDistanceM,
      etaSeconds: this.lastEtaSec,
      confidence: this.lastConfidence,
      farGreenPct: this.lastFarGreenPct,
      nearGreenPct: this.lastNearGreenPct,
      confirmCount: this.confirmCount,
      confirmRequired: this.config.confirmFrames,
      recommendedTurn,
      nextRow,
      currentRow: this.lastRow,
      sourceLabel: this.lastSourceLabel,
      cooldownRemainingMs: Math.max(0, Math.round(this.cooldownUntilMs - nowMs)),
      activeAlert: this.activeAlert ? { ...this.activeAlert } : null,
      alertHistory: this.alertHistory.map((a) => ({ ...a })),
      stateTransitions: this.stateTransitions.map((t) => ({ ...t })),
      lastServiceResponse: this.lastServiceResponse ? { ...this.lastServiceResponse } : null,
      checksEvaluated: this.checksEvaluated,
    };
  }
}
