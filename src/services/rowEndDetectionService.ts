/**
 * row_end_detection Service
 *
 * Implements ROS 2 `/navigation/row_end_detection` vision service semantics:
 * evaluates real-time ExG + Otsu far-ROI vs near-ROI foliage density and
 * row-end confidence from the active vision source (live <video> feed,
 * WebRTC/CameraX stream, or field simulator camera), applies multi-frame
 * temporal debounce to prevent outdoor lighting false positives, and raises
 * structured Turn Execution Alerts for headland U-turn dispatch.
 */

export type TurnDirection = 'RIGHT_U_TURN' | 'LEFT_U_TURN' | 'FINAL_ROW_STOP';

export type RowEndServiceState =
  | 'SCANNING'
  | 'APPROACHING_ROW_END'
  | 'ROW_END_DETECTED'
  | 'TURN_EXECUTING'
  | 'COOLDOWN'
  | 'DISABLED';

export type TurnDispatchMode = 'alert_and_confirm' | 'auto_execute';

export interface RowEndDetectionConfig {
  enabled: boolean;
  confidenceThreshold: number; // 0.55..0.95
  confirmFrames: number; // consecutive vision frames required
  farGreenCutoff: number; // 0.01..0.12 far-ROI green ratio ceiling
  turnDispatchMode: TurnDispatchMode;
  cooldownMs: number;
  audioAlert: boolean;
}

export interface RowEndVisionInput {
  rowEndConfidence: number; // 0..1 from cropRowVision / vision node
  greenRatioFar: number; // 0..1 top 1/3 ROI ExG foliage ratio
  greenRatioNear: number; // 0..1 bottom 1/2 ROI ExG foliage ratio
  trackingLocked: boolean;
  missedFrames: number;
  currentRow: number; // 1-indexed
  totalRows: number;
  direction: 1 | -1; // +1 eastbound, -1 westbound
  sourceLabel: string;
  isLiveCamera: boolean;
  timestampMs: number;
}

export interface RowEndTurnAlert {
  id: string;
  row: number;
  nextRow: number | null;
  recommendedTurn: TurnDirection;
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
  confidence: number;
  farGreenPct: number;
  nearGreenPct: number;
  confirmCount: number;
  confirmRequired: number;
  recommendedTurn: TurnDirection;
  nextRow: number | null;
  state: RowEndServiceState;
  reason: string;
  timestamp: string;
}

export interface RowEndDetectionSnapshot {
  state: RowEndServiceState;
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
  lastServiceResponse: RowEndServiceResponse | null;
  checksEvaluated: number;
}

export const DEFAULT_ROW_END_CONFIG: RowEndDetectionConfig = {
  enabled: true,
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

/**
 * Play a subtle dual-tone operator alert chime via Web Audio API when audioAlert is enabled.
 */
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
  private confirmCount = 0;
  private cooldownUntilMs = 0;
  private lastConfidence = 0;
  private lastFarGreenPct = 18.0;
  private lastNearGreenPct = 24.0;
  private lastRow = 1;
  private lastDirection: 1 | -1 = 1;
  private lastTotalRows = 4;
  private lastSourceLabel = 'FIELD SIM · /crop_row/alignment';
  private activeAlert: RowEndTurnAlert | null = null;
  private alertHistory: RowEndTurnAlert[] = [];
  private lastServiceResponse: RowEndServiceResponse | null = null;
  private checksEvaluated = 0;
  private alertSeq = 1;

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
   * Process a continuous vision frame update from the active camera or vision node.
   * Returns a newly triggered RowEndTurnAlert on the exact frame transition into ROW_END_DETECTED.
   */
  public processVisionFrame(input: RowEndVisionInput): {
    newlyTriggeredAlert: RowEndTurnAlert | null;
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

    // Combine explicit rowEndConfidence with far-ROI foliage depletion cue
    const farDepletedScore =
      input.greenRatioFar <= this.config.farGreenCutoff
        ? 1.0 - input.greenRatioFar / Math.max(this.config.farGreenCutoff, 1e-4)
        : 0;

    const effectiveConfidence = Math.max(
      0,
      Math.min(1, Math.max(input.rowEndConfidence, farDepletedScore * 0.88))
    );
    this.lastConfidence = effectiveConfidence;

    if (!this.config.enabled) {
      this.state = 'DISABLED';
      return { newlyTriggeredAlert: null, snapshot: this.getSnapshot(input.timestampMs) };
    }

    // Hold state while a turn alert is pending or a headland turn is executing
    if (this.state === 'TURN_EXECUTING') {
      return { newlyTriggeredAlert: null, snapshot: this.getSnapshot(input.timestampMs) };
    }
    if (this.state === 'ROW_END_DETECTED' && this.activeAlert?.status === 'PENDING_TURN') {
      return { newlyTriggeredAlert: null, snapshot: this.getSnapshot(input.timestampMs) };
    }

    // Post-turn cooldown guard
    if (input.timestampMs < this.cooldownUntilMs) {
      this.state = 'COOLDOWN';
      this.confirmCount = 0;
      return { newlyTriggeredAlert: null, snapshot: this.getSnapshot(input.timestampMs) };
    }

    const warningThreshold = Math.max(0.35, this.config.confidenceThreshold - 0.24);
    const meetsTrigger =
      effectiveConfidence >= this.config.confidenceThreshold &&
      (input.greenRatioFar <= this.config.farGreenCutoff * 1.6 || effectiveConfidence >= 0.84);

    if (meetsTrigger) {
      this.confirmCount = Math.min(this.config.confirmFrames, this.confirmCount + 1);
      if (this.confirmCount >= this.config.confirmFrames) {
        const alert = this.createAndLatchAlert(input, effectiveConfidence, farPct, nearPct);
        return { newlyTriggeredAlert: alert, snapshot: this.getSnapshot(input.timestampMs) };
      }
      this.state = 'APPROACHING_ROW_END';
    } else if (effectiveConfidence >= warningThreshold) {
      this.confirmCount = Math.max(0, this.confirmCount - 1);
      this.state = 'APPROACHING_ROW_END';
    } else {
      this.confirmCount = 0;
      this.state = 'SCANNING';
    }

    return { newlyTriggeredAlert: null, snapshot: this.getSnapshot(input.timestampMs) };
  }

  /**
   * Synchronous ROS 2 service invocation: `/navigation/row_end_detection`
   * Evaluates current vision observation immediately and triggers an alert if confirmed.
   */
  public invokeServiceCheck(input: RowEndVisionInput): {
    response: RowEndServiceResponse;
    newlyTriggeredAlert: RowEndTurnAlert | null;
    snapshot: RowEndDetectionSnapshot;
  } {
    const farPct = Math.max(0, Math.min(100, input.greenRatioFar * 100));
    const nearPct = Math.max(0, Math.min(100, input.greenRatioNear * 100));
    const { recommendedTurn, nextRow } = computeRecommendedTurn(
      input.currentRow,
      input.totalRows,
      input.direction
    );

    const detected =
      this.config.enabled &&
      (input.rowEndConfidence >= this.config.confidenceThreshold ||
        input.greenRatioFar <= this.config.farGreenCutoff);

    let newlyTriggeredAlert: RowEndTurnAlert | null = null;
    if (
      detected &&
      this.state !== 'TURN_EXECUTING' &&
      this.activeAlert?.status !== 'PENDING_TURN'
    ) {
      this.confirmCount = this.config.confirmFrames;
      newlyTriggeredAlert = this.createAndLatchAlert(
        input,
        Math.max(input.rowEndConfidence, this.config.confidenceThreshold),
        farPct,
        nearPct
      );
    }

    const reason = !this.config.enabled
      ? 'Service disabled by operator.'
      : detected
      ? `Far-ROI foliage depleted (${farPct.toFixed(1)}% green, conf ${Math.round(
          input.rowEndConfidence * 100
        )}%) -> ${formatTurnLabel(recommendedTurn)}`
      : `Crop row foliage continuous ahead (Far-ROI ${farPct.toFixed(1)}% green, conf ${Math.round(
          input.rowEndConfidence * 100
        )}% < ${Math.round(this.config.confidenceThreshold * 100)}%).`;

    const response: RowEndServiceResponse = {
      serviceName: '/navigation/row_end_detection',
      rowEndDetected: detected,
      confidence: input.rowEndConfidence,
      farGreenPct: farPct,
      nearGreenPct: nearPct,
      confirmCount: this.confirmCount,
      confirmRequired: this.config.confirmFrames,
      recommendedTurn,
      nextRow,
      state: this.state,
      reason,
      timestamp: new Date().toLocaleTimeString(),
    };

    this.lastServiceResponse = response;
    return {
      response,
      newlyTriggeredAlert,
      snapshot: this.getSnapshot(input.timestampMs),
    };
  }

  private createAndLatchAlert(
    input: RowEndVisionInput,
    confidence: number,
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
      confidence,
      farGreenPct: farPct,
      nearGreenPct: nearPct,
      sourceLabel: input.sourceLabel,
      triggeredAt: new Date().toLocaleTimeString(),
      status: 'PENDING_TURN',
      reason: `Vision Far-ROI green dropped to ${farPct.toFixed(1)}% (${this.config.confirmFrames}/${this.config.confirmFrames} frames ≥ ${Math.round(
        this.config.confidenceThreshold * 100
      )}%)`,
    };

    this.state = 'ROW_END_DETECTED';
    this.activeAlert = alert;
    this.alertHistory = [alert, ...this.alertHistory].slice(0, 6);

    if (this.config.audioAlert) {
      playRowEndAlertChime();
    }

    return alert;
  }

  public acknowledgeTurnStart(): RowEndDetectionSnapshot {
    if (this.activeAlert) {
      this.activeAlert = { ...this.activeAlert, status: 'EXECUTING' };
      this.alertHistory = this.alertHistory.map((item) =>
        item.id === this.activeAlert?.id ? { ...item, status: 'EXECUTING' } : item
      );
    }
    this.state = 'TURN_EXECUTING';
    this.confirmCount = 0;
    return this.getSnapshot(performance.now());
  }

  public notifyTurnComplete(nowMs = performance.now()): RowEndDetectionSnapshot {
    if (this.activeAlert) {
      const doneId = this.activeAlert.id;
      this.alertHistory = this.alertHistory.map((item) =>
        item.id === doneId ? { ...item, status: 'COMPLETED' } : item
      );
      this.activeAlert = null;
    }
    this.confirmCount = 0;
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
    this.confirmCount = 0;
    this.cooldownUntilMs = nowMs + this.config.cooldownMs;
    this.state = this.config.enabled ? 'COOLDOWN' : 'DISABLED';
    return this.getSnapshot(nowMs);
  }

  public reset(): RowEndDetectionSnapshot {
    this.state = this.config.enabled ? 'SCANNING' : 'DISABLED';
    this.confirmCount = 0;
    this.cooldownUntilMs = 0;
    this.lastConfidence = 0;
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
      lastServiceResponse: this.lastServiceResponse ? { ...this.lastServiceResponse } : null,
      checksEvaluated: this.checksEvaluated,
    };
  }
}
