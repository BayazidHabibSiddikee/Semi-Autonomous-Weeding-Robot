import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  AlertOctagon,
  Compass,
  Radio,
  Plus,
  Trash2,
  ShieldCheck,
  ShieldAlert,
  BookmarkCheck,
  Unplug,
  Wrench,
  Camera,
  CameraOff,
  Wifi,
} from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { CropRowAlignmentGauge, VisionAlignmentData } from './CropRowAlignmentGauge';
import { RealTimeCameraStream, StreamTransportMode } from './RealTimeCameraStream';
import { CameraFeedTrigger, RealTimeCameraFeed } from './RealTimeCameraFeed';
import { RowEndDetectionPanel } from './RowEndDetectionPanel';
import {
  DEFAULT_ROW_END_CONFIG,
  RowEndDetectionConfig,
  RowEndDetectionService,
  RowEndDetectionSnapshot,
  RowEndVisionInput,
  formatTurnLabel,
} from '../services/rowEndDetectionService';
import {
  CompletedTurnRecord,
  INITIAL_LIVE_TURN_TELEMETRY,
  LiveTurnTelemetry,
  TurnAccuracyDashboard,
  TurnTrajectorySample,
} from './TurnAccuracyDashboard';

interface Props {
  estopActive: boolean;
  onLogEvent: (msg: string) => void;
}

interface Obstacle {
  id: number;
  x: number;
  y: number;
  r: number;
}

interface HookTarget {
  id: number;
  x: number;
  y: number;
  row: number;
  serviced: boolean;
}

type MissionPhase =
  | 'FOLLOW_CROP_ROW'
  | 'ROW_END_STOP'
  | 'NAV2_HEADLAND_TURN'
  | 'TREATMENT_HOOK_HOLD'
  | 'OBSTACLE_HOLD'
  | 'FAULT'
  | 'ESTOP_HALTED'
  | 'PAUSED'
  | 'MISSION_COMPLETE';

interface TelemetrySample {
  t: string;
  latErrorCm: number;
  ekfDriftCm: number;
  rawOdomDriftCm: number;
}

interface SavedCheckpoint {
  rowIdx: number;
  dir: number;
  x: number;
  y: number;
  yaw: number;
  rowProgress: number[];
  coveragePct: number;
  savedAt: string;
}

const FIELD_LEN_M = 8.0;
const ROW_START_X = 1.2;
const ROW_END_X = ROW_START_X + FIELD_LEN_M;
const NUM_ROWS = 4;

function rowCenterY(rowIdx: number, rowWidthM: number) {
  return 0.9 + rowIdx * rowWidthM;
}

function makeInitialHookTargets(rowWidthM: number): HookTarget[] {
  const spots: HookTarget[] = [];
  let id = 1;
  for (let r = 0; r < NUM_ROWS; r++) {
    const cy = rowCenterY(r, rowWidthM);
    for (const frac of [0.24, 0.56, 0.82]) {
      spots.push({
        id: id++,
        x: ROW_START_X + frac * FIELD_LEN_M,
        y: cy + ((id % 3) - 1) * 0.06,
        row: r + 1,
        serviced: false,
      });
    }
  }
  return spots;
}

interface VisionTelemetrySource {
  latErrM: number;
  headErrRad: number;
  rowEndConf: number;
  distToFurrowEndM: number;
  rowIdx: number;
  phase: MissionPhase;
  cmdWz: number;
}

/**
 * Custom hook simulating live ROS 2 vision node telemetry (/crop_row/alignment)
 * emitted by CropRowDetector (ExG + Otsu) -> CropRowTracker (EMA alpha=0.35/0.30).
 * Publishes continuous lateral offset (m) and heading error (rad) updates to drive the UI gauges.
 */
function useVisionNodeTelemetry(
  sourceRef: React.MutableRefObject<VisionTelemetrySource>,
  rowWidthM: number,
  publishIntervalMs = 100
) {
  const trackerRef = useRef({
    trackedLatM: 0.05,
    trackedYawRad: 0.06,
    missedFrames: 0,
    tickCount: 0,
  });

  const [alignment, setAlignment] = useState<VisionAlignmentData>(() => ({
    trackingLocked: true,
    lateralOffsetM: 0.05,
    rawLateralOffsetM: 0.05,
    headingErrorRad: 0.06,
    rawHeadingErrorRad: 0.06,
    rowWidthM,
    rowEndConfidence: 0,
    missedFrames: 0,
    cmdWzRadS: 0,
    currentRow: 1,
  }));

  const syncTracker = useCallback((latM: number, yawRad: number) => {
    trackerRef.current.trackedLatM = latM;
    trackerRef.current.trackedYawRad = yawRad;
    trackerRef.current.missedFrames = 0;
    setAlignment((prev) => ({
      ...prev,
      trackingLocked: true,
      lateralOffsetM: latM,
      rawLateralOffsetM: latM,
      headingErrorRad: yawRad,
      rawHeadingErrorRad: yawRad,
      missedFrames: 0,
    }));
  }, []);

  useEffect(() => {
    const ALPHA_LAT = 0.35;
    const ALPHA_YAW = 0.3;
    const MAX_MISSED_FRAMES = 12;

    const timerId = window.setInterval(() => {
      const src = sourceRef.current;
      const tr = trackerRef.current;
      tr.tickCount += 1;

      const inCropFoliage =
        (src.phase === 'FOLLOW_CROP_ROW' ||
          src.phase === 'TREATMENT_HOOK_HOLD' ||
          src.phase === 'OBSTACLE_HOLD' ||
          src.phase === 'FAULT' ||
          src.phase === 'PAUSED' ||
          src.phase === 'ESTOP_HALTED') &&
        src.rowEndConf < 0.92;

      const t = tr.tickCount * (publishIntervalMs / 1000);

      if (inCropFoliage) {
        // Realistic sub-centimeter optical ExG+Otsu frame jitter around live row geometry
        const latJitter =
          Math.sin(t * 4.7) * 0.0045 +
          Math.cos(t * 11.3) * 0.002 +
          (Math.random() - 0.5) * 0.003;
        const yawJitter =
          Math.cos(t * 3.9) * 0.0065 +
          Math.sin(t * 9.1) * 0.003 +
          (Math.random() - 0.5) * 0.004;

        const rawLatM = src.latErrM + latJitter;
        const rawYawRad = src.headErrRad + yawJitter;

        tr.trackedLatM = (1 - ALPHA_LAT) * tr.trackedLatM + ALPHA_LAT * rawLatM;
        tr.trackedYawRad = (1 - ALPHA_YAW) * tr.trackedYawRad + ALPHA_YAW * rawYawRad;
        tr.missedFrames = 0;

        const simGreenFar = Math.max(
          0.004,
          Math.min(0.32, 0.22 * (1 - src.rowEndConf) + Math.sin(t * 2.3) * 0.008)
        );
        const simGreenNear = Math.max(
          0.02,
          Math.min(0.36, 0.27 * (1 - src.rowEndConf * 0.35) + Math.cos(t * 1.9) * 0.008)
        );
        const distJitter = Math.sin(t * 3.1) * 0.014 + (Math.random() - 0.5) * 0.012;
        const projectedDistM = Math.max(0.18, src.distToFurrowEndM + distJitter);

        setAlignment({
          trackingLocked: true,
          lateralOffsetM: tr.trackedLatM,
          rawLateralOffsetM: rawLatM,
          headingErrorRad: tr.trackedYawRad,
          rawHeadingErrorRad: rawYawRad,
          rowWidthM,
          rowEndConfidence: src.rowEndConf,
          distanceToFurrowEndM: projectedDistM,
          greenRatioFar: simGreenFar,
          greenRatioNear: simGreenNear,
          missedFrames: 0,
          cmdWzRadS: src.cmdWz,
          currentRow: src.rowIdx + 1,
        });
      } else {
        tr.missedFrames = Math.min(20, tr.missedFrames + 1);
        const locked = tr.missedFrames <= MAX_MISSED_FRAMES;

        setAlignment({
          trackingLocked: locked,
          lateralOffsetM: tr.trackedLatM,
          rawLateralOffsetM: tr.trackedLatM,
          headingErrorRad: tr.trackedYawRad,
          rawHeadingErrorRad: tr.trackedYawRad,
          rowWidthM,
          rowEndConfidence: src.rowEndConf,
          distanceToFurrowEndM: Math.max(0.18, src.distToFurrowEndM),
          greenRatioFar: 0.005,
          greenRatioNear: 0.012,
          missedFrames: tr.missedFrames,
          cmdWzRadS: src.cmdWz,
          currentRow: src.rowIdx + 1,
        });
      }
    }, publishIntervalMs);

    return () => window.clearInterval(timerId);
  }, [sourceRef, rowWidthM, publishIntervalMs]);

  return { alignment, syncTracker };
}

export const NavigationWorkbench: React.FC<Props> = ({ estopActive, onLogEvent }) => {
  const [missionMode, setMissionMode] = useState<'nav_only' | 'treatment_hook'>('nav_only');
  const [running, setRunning] = useState<boolean>(true);
  const [speedLimit, setSpeedLimit] = useState<number>(0.18);
  const [stanleyGain, setStanleyGain] = useState<number>(1.8);
  const [rowWidthCm, setRowWidthCm] = useState<number>(60);
  const [obstacles, setObstacles] = useState<Obstacle[]>([]);
  const [sensorFaultInjected, setSensorFaultInjected] = useState<boolean>(false);
  const [faultReason, setFaultReason] = useState<string | null>(null);
  const [checkpoint, setCheckpoint] = useState<SavedCheckpoint | null>(null);
  const [streamMode, setStreamMode] = useState<StreamTransportMode>('sim');
  const [liveVisionState, setLiveVisionState] = useState<{
    active: boolean;
    alignment: VisionAlignmentData | null;
  }>({ active: false, alignment: null });
  const [streamAction, setStreamAction] = useState<{
    type: 'start_local' | 'start_webrtc' | 'start_ws' | 'stop_to_sim';
    seq: number;
  } | null>(null);

  const [telemetry, setTelemetry] = useState({
    phase: 'FOLLOW_CROP_ROW' as MissionPhase,
    currentRow: 1,
    x: ROW_START_X + 0.25,
    y: rowCenterY(0, 0.6),
    yawDeg: 0,
    rowEndConf: 0,
    ekfDriftCm: 0.8,
    rawOdomDriftCm: 1.2,
    slipResidualCm: 0.6,
    collisionState: 'CLEAR' as 'CLEAR' | 'SLOWDOWN' | 'STOP' | 'SENSOR_FAULT',
    coveragePct: 0,
    completedRows: 0,
    hooksServiced: 0,
    totalHooks: 12,
    cmdVx: 0.18,
    cmdWz: 0,
    boundaryOk: true,
  });

  const [history, setHistory] = useState<TelemetrySample[]>(() =>
    Array.from({ length: 24 }, (_, idx) => ({
      t: `-${24 - idx}s`,
      latErrorCm: 0,
      ekfDriftCm: 0.6,
      rawOdomDriftCm: 0.8,
    }))
  );

  const [liveTurnTelemetry, setLiveTurnTelemetry] = useState<LiveTurnTelemetry>(
    INITIAL_LIVE_TURN_TELEMETRY
  );
  const [turnSamples, setTurnSamples] = useState<TurnTrajectorySample[]>([]);
  const [completedTurns, setCompletedTurns] = useState<CompletedTurnRecord[]>([]);

  const onLogEventRef = useRef(onLogEvent);
  onLogEventRef.current = onLogEvent;

  const turnTrackerRef = useRef<{
    active: boolean;
    turnCounter: number;
    fromRow: number;
    toRow: number;
    direction: 'RIGHT' | 'LEFT';
    turnSign: number;
    startYaw: number;
    targetEndYaw: number;
    startSimSec: number;
    waypoints: Array<{ x: number; y: number }>;
    segLengths: number[];
    totalLen: number;
    prevImuYaw: number;
    prevRawYaw: number;
    imuCumRad: number;
    rawCumRad: number;
    calcCumRad: number;
    calcHeadingRad: number;
    sqErrorDegSum: number;
    sampleCount: number;
    maxCrossTrackCm: number;
    lastSampleProgress: number;
    samples: TurnTrajectorySample[];
    latestTelemetry: LiveTurnTelemetry;
  }>({
    active: false,
    turnCounter: 0,
    fromRow: 1,
    toRow: 2,
    direction: 'RIGHT',
    turnSign: 1,
    startYaw: 0,
    targetEndYaw: Math.PI,
    startSimSec: 0,
    waypoints: [],
    segLengths: [],
    totalLen: 1,
    prevImuYaw: 0,
    prevRawYaw: 0,
    imuCumRad: 0,
    rawCumRad: 0,
    calcCumRad: 0,
    calcHeadingRad: 0,
    sqErrorDegSum: 0,
    sampleCount: 0,
    maxCrossTrackCm: 0,
    lastSampleProgress: -10,
    samples: [],
    latestTelemetry: INITIAL_LIVE_TURN_TELEMETRY,
  });

  const fieldCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const camCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const simRef = useRef({
    x: ROW_START_X + 0.25,
    y: rowCenterY(0, 0.6) + 0.05,
    yaw: 0.06,
    rawX: ROW_START_X + 0.25,
    rawY: rowCenterY(0, 0.6) + 0.05,
    rawYaw: 0.06,
    ekfPath: [] as Array<{ x: number; y: number }>,
    rawPath: [] as Array<{ x: number; y: number }>,
    rowIdx: 0,
    dir: 1,
    rowProgress: [0, 0, 0, 0] as number[],
    phase: 'FOLLOW_CROP_ROW' as MissionPhase,
    phaseTimer: 0,
    turnWaypoints: [] as Array<{ x: number; y: number; yaw: number }>,
    turnWpIdx: 0,
    targets: makeInitialHookTargets(0.6),
    activeTargetId: null as number | null,
    simSeconds: 0,
    lastTelemetrySync: 0,
    lastChartSync: 0,
    latErrM: 0.05,
    headErrRad: 0.06,
    rowEndConf: 0,
    distToFurrowEndM: FIELD_LEN_M - 0.25,
    slipResidualCm: 0.6,
    collisionState: 'CLEAR' as 'CLEAR' | 'SLOWDOWN' | 'STOP' | 'SENSOR_FAULT',
    cmdVx: 0.18,
    cmdWz: 0,
    boundaryOk: true,
  });

  // Live vision node telemetry hook for Field Simulator mode
  const { alignment: simVisionAlignment, syncTracker: syncVisionTracker } = useVisionNodeTelemetry(
    simRef,
    rowWidthCm / 100,
    100
  );

  const handleLiveAlignmentChange = useCallback(
    (nextAlignment: VisionAlignmentData, isLive: boolean) => {
      setLiveVisionState({ active: isLive, alignment: isLive ? nextAlignment : null });
    },
    []
  );

  const triggerStreamAction = (type: 'start_local' | 'start_webrtc' | 'start_ws' | 'stop_to_sim') => {
    setStreamAction((prev) => ({ type, seq: (prev?.seq ?? 0) + 1 }));
  };

  const simAlignmentWithLabel: VisionAlignmentData = {
    ...simVisionAlignment,
    sourceLabel: `FIELD SIM · Row ${simVisionAlignment.currentRow} · /crop_row/alignment`,
  };

  const [cameraFeedState, setCameraFeedState] = useState<{
    active: boolean;
    alignment: VisionAlignmentData | null;
  }>({ active: false, alignment: null });
  const [cameraFeedTrigger, setCameraFeedTrigger] = useState<CameraFeedTrigger | null>(null);

  const triggerCameraFeed = (action: 'start' | 'stop') => {
    setCameraFeedTrigger((prev) => ({ action, seq: (prev?.seq ?? 0) + 1 }));
  };

  const handleCameraFeedAlignment = useCallback(
    (nextAlignment: VisionAlignmentData, active: boolean) => {
      setCameraFeedState({ active, alignment: active ? nextAlignment : null });
    },
    []
  );

  const visionAlignment: VisionAlignmentData =
    cameraFeedState.active && cameraFeedState.alignment
      ? cameraFeedState.alignment
      : liveVisionState.active && liveVisionState.alignment
      ? liveVisionState.alignment
      : simAlignmentWithLabel;

  // Dedicated row_end_detection vision service instance
  const rowEndServiceRef = useRef<RowEndDetectionService>(
    new RowEndDetectionService(DEFAULT_ROW_END_CONFIG)
  );
  const [rowEndConfig, setRowEndConfig] = useState<RowEndDetectionConfig>(DEFAULT_ROW_END_CONFIG);
  const [rowEndSnapshot, setRowEndSnapshot] = useState<RowEndDetectionSnapshot>(() =>
    rowEndServiceRef.current.getSnapshot()
  );

  const paramsRef = useRef({
    running,
    speedLimit,
    stanleyGain,
    rowWidthM: rowWidthCm / 100,
    missionMode,
    estopActive,
    obstacles,
    sensorFaultInjected,
    faultReason,
    visionSourceMode: streamMode,
    rowEndConfig,
  });

  useEffect(() => {
    paramsRef.current = {
      running,
      speedLimit,
      stanleyGain,
      rowWidthM: rowWidthCm / 100,
      missionMode,
      estopActive,
      obstacles,
      sensorFaultInjected,
      faultReason,
      visionSourceMode: streamMode,
      rowEndConfig,
    };
  }, [
    running,
    speedLimit,
    stanleyGain,
    rowWidthCm,
    missionMode,
    estopActive,
    obstacles,
    sensorFaultInjected,
    faultReason,
    streamMode,
    rowEndConfig,
  ]);

  const buildRowEndVisionInput = useCallback(
    (align: VisionAlignmentData): RowEndVisionInput => {
      const s = simRef.current;
      const isLiveCamera = cameraFeedState.active || liveVisionState.active;
      const fallbackDistM = Math.max(0.22, 1.8 * (1 - align.rowEndConfidence));
      return {
        rowEndConfidence: align.rowEndConfidence,
        distanceToFurrowEndM: align.distanceToFurrowEndM ?? fallbackDistM,
        furrowEndYPx: align.furrowEndYPx,
        greenRatioFar:
          align.greenRatioFar ?? Math.max(0.004, 0.2 * (1 - align.rowEndConfidence)),
        greenRatioNear: align.greenRatioNear ?? 0.22,
        roverSpeedMps: Math.abs(s.cmdVx),
        trackingLocked: align.trackingLocked,
        missedFrames: align.missedFrames,
        currentRow: s.rowIdx + 1,
        totalRows: NUM_ROWS,
        direction: s.dir >= 0 ? 1 : -1,
        sourceLabel: align.sourceLabel || 'Vision Node',
        isLiveCamera,
        timestampMs: performance.now(),
      };
    },
    [cameraFeedState.active, liveVisionState.active]
  );

  const initTurnTracker = useCallback(
    (
      s: typeof simRef.current,
      nextRowIdx: number,
      turnWaypoints: Array<{ x: number; y: number; yaw: number }>,
      nextYaw: number
    ) => {
      const pts = [{ x: s.x, y: s.y }, ...turnWaypoints.map((w) => ({ x: w.x, y: w.y }))];
      const segLengths: number[] = [];
      let totalLen = 0;
      for (let i = 0; i < pts.length - 1; i++) {
        const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
        segLengths.push(len);
        totalLen += len;
      }
      const direction: 'RIGHT' | 'LEFT' = s.dir > 0 ? 'RIGHT' : 'LEFT';
      const initialSample: TurnTrajectorySample = {
        progressPct: 0,
        label: '0%',
        calculatedDeg: 0,
        imuDeg: 0,
        rawOdomDeg: 0,
        errorDeg: 0,
        crossTrackCm: 0,
      };
      const initialLive: LiveTurnTelemetry = {
        active: true,
        fromRow: s.rowIdx + 1,
        toRow: nextRowIdx + 1,
        direction,
        progressPct: 0,
        calculatedYawDeg: 0,
        imuYawDeg: 0,
        rawOdomYawDeg: 0,
        headingErrorDeg: 0,
        imuWzRadS: 0,
        imuGyroBiasDegS: 0.04,
        crossTrackCm: 0,
        liveAccuracyPct: 100,
      };
      turnTrackerRef.current = {
        active: true,
        turnCounter: turnTrackerRef.current.turnCounter,
        fromRow: s.rowIdx + 1,
        toRow: nextRowIdx + 1,
        direction,
        turnSign: s.dir > 0 ? 1 : -1,
        startYaw: s.yaw,
        targetEndYaw: nextYaw,
        startSimSec: s.simSeconds,
        waypoints: pts,
        segLengths,
        totalLen: Math.max(0.2, totalLen),
        prevImuYaw: s.yaw,
        prevRawYaw: s.rawYaw,
        imuCumRad: 0,
        rawCumRad: 0,
        calcCumRad: 0,
        calcHeadingRad: s.yaw,
        sqErrorDegSum: 0,
        sampleCount: 0,
        maxCrossTrackCm: 0,
        lastSampleProgress: 0,
        samples: [initialSample],
        latestTelemetry: initialLive,
      };
      setTurnSamples([initialSample]);
      setLiveTurnTelemetry(initialLive);
    },
    []
  );

  const dispatchHeadlandTurn = useCallback(
    (triggerOrigin: 'operator' | 'auto') => {
      const s = simRef.current;
      const rw = paramsRef.current.rowWidthM;
      if (paramsRef.current.estopActive || paramsRef.current.faultReason !== null || paramsRef.current.sensorFaultInjected) {
        return;
      }

      if (s.rowIdx >= NUM_ROWS - 1) {
        s.rowProgress[s.rowIdx] = 1.0;
        s.phase = 'MISSION_COMPLETE';
        s.cmdVx = 0;
        s.cmdWz = 0;
        setRowEndSnapshot(rowEndServiceRef.current.notifyTurnComplete(true));
        onLogEvent(
          `[row_end_detection] State transition ROW_END_STOP → MISSION_COMPLETE (${triggerOrigin}) — Row ${NUM_ROWS} finished cleanly.`
        );
        return;
      }

      const nextRowIdx = s.rowIdx + 1;
      const yFrom = rowCenterY(s.rowIdx, rw);
      const yTo = rowCenterY(nextRowIdx, rw);
      const exitX = s.dir > 0 ? ROW_END_X + 0.62 : ROW_START_X - 0.62;
      const entryX = s.dir > 0 ? ROW_END_X - 0.1 : ROW_START_X + 0.1;
      const nextYaw = s.dir > 0 ? Math.PI : 0;

      s.rowProgress[s.rowIdx] = 1.0;
      const waypoints = [
        { x: exitX, y: yFrom, yaw: Math.PI / 2 },
        { x: exitX, y: yTo, yaw: nextYaw },
        { x: entryX, y: yTo, yaw: nextYaw },
      ];
      s.turnWaypoints = waypoints;
      s.turnWpIdx = 0;
      s.phase = 'NAV2_HEADLAND_TURN';
      initTurnTracker(s, nextRowIdx, waypoints, nextYaw);
      setRunning(true);
      setRowEndSnapshot(rowEndServiceRef.current.acknowledgeTurnStart(triggerOrigin));
      onLogEvent(
        `[row_end_detection] State transition ROW_END_STOP → NAV2_HEADLAND_TURN (${triggerOrigin}): Row ${s.rowIdx + 1} → Row ${nextRowIdx + 1} (${s.dir > 0 ? 'RIGHT_U_TURN' : 'LEFT_U_TURN'}).`
      );
    },
    [onLogEvent, initTurnTracker]
  );

  // Continuously feed active vision frames (Live <video>, WebRTC/WS, or Field Sim) into row_end_detection
  useEffect(() => {
    const s = simRef.current;
    const isLiveCamera = cameraFeedState.active || liveVisionState.active;
    if (!isLiveCamera && (s.phase === 'MISSION_COMPLETE' || s.phase === 'NAV2_HEADLAND_TURN')) {
      return;
    }

    const input = buildRowEndVisionInput(visionAlignment);
    const { newlyTriggeredAlert, snapshot } = rowEndServiceRef.current.processVisionFrame(input);
    setRowEndSnapshot(snapshot);

    if (newlyTriggeredAlert) {
      onLogEvent(
        `[row_end_detection] TURN ALERT ${newlyTriggeredAlert.id} (FOLLOW_CROP_ROW → ROW_END_STOP): Furrow end at ${newlyTriggeredAlert.distanceToFurrowEndM.toFixed(
          2
        )} m (${Math.round(newlyTriggeredAlert.confidence * 100)}% conf) → ${formatTurnLabel(
          newlyTriggeredAlert.recommendedTurn
        )}.`
      );

      if (s.phase === 'FOLLOW_CROP_ROW') {
        s.rowProgress[s.rowIdx] = 1.0;
        s.phase = 'ROW_END_STOP';
        s.phaseTimer = 1.3;
        s.cmdVx = 0;
        s.cmdWz = 0;
      }
    }
  }, [
    visionAlignment,
    cameraFeedState.active,
    liveVisionState.active,
    buildRowEndVisionInput,
    onLogEvent,
  ]);

  const handleUpdateRowEndConfig = useCallback(
    (patch: Partial<RowEndDetectionConfig>) => {
      rowEndServiceRef.current.updateConfig(patch);
      const nextCfg = rowEndServiceRef.current.getConfig();
      setRowEndConfig(nextCfg);
      setRowEndSnapshot(rowEndServiceRef.current.getSnapshot());
      if (patch.enabled !== undefined) {
        onLogEvent(
          `[row_end_detection] Service ${patch.enabled ? 'ENABLED' : 'PAUSED'} by operator.`
        );
      } else if (patch.turnDispatchMode !== undefined) {
        onLogEvent(
          `[row_end_detection] Turn dispatch policy set to ${
            patch.turnDispatchMode === 'auto_execute' ? 'AUTO-EXECUTE' : 'ALERT & CONFIRM'
          }.`
        );
      }
    },
    [onLogEvent]
  );

  const handleDismissRowEndAlert = useCallback(() => {
    const snap = rowEndServiceRef.current.dismissAlert();
    setRowEndSnapshot(snap);
    const s = simRef.current;
    if (s.phase === 'ROW_END_STOP') {
      const distToEnd = s.dir > 0 ? ROW_END_X - s.x : s.x - ROW_START_X;
      if (distToEnd > 0.25) {
        s.phase = 'FOLLOW_CROP_ROW';
      } else {
        setRunning(false);
      }
    }
    onLogEvent('[row_end_detection] Operator dismissed turn alert — entered post-alert cooldown.');
  }, [onLogEvent]);

  const handleInvokeRowEndCheck = useCallback(() => {
    const input = buildRowEndVisionInput(visionAlignment);
    const { response, newlyTriggeredAlert, snapshot } =
      rowEndServiceRef.current.invokeServiceCheck(input);
    setRowEndSnapshot(snapshot);
    onLogEvent(
      `[RPC /navigation/row_end_detection] row_end_detected=${response.rowEndDetected} (conf ${Math.round(
        response.confidence * 100
      )}%, Far-ROI ${response.farGreenPct.toFixed(1)}%) — ${response.reason}`
    );
    if (newlyTriggeredAlert && simRef.current.phase === 'FOLLOW_CROP_ROW') {
      simRef.current.rowProgress[simRef.current.rowIdx] = 1.0;
      simRef.current.phase = 'ROW_END_STOP';
      simRef.current.phaseTimer = 1.3;
      simRef.current.cmdVx = 0;
      simRef.current.cmdWz = 0;
    }
  }, [buildRowEndVisionInput, visionAlignment, onLogEvent]);

  const handleJumpToRowEndTest = useCallback(() => {
    if (estopActive || faultReason !== null || sensorFaultInjected) return;
    const s = simRef.current;
    const rw = rowWidthCm / 100;
    if (s.phase === 'MISSION_COMPLETE' || s.rowIdx >= NUM_ROWS - 1) {
      s.rowIdx = 0;
      s.dir = 1;
      s.rowProgress = [0, 0, 0, 0];
    }
    const targetY = rowCenterY(s.rowIdx, rw);
    s.x = s.dir > 0 ? ROW_END_X - 1.15 : ROW_START_X + 1.15;
    s.y = targetY;
    s.yaw = s.dir > 0 ? 0 : Math.PI;
    s.rawX = s.x;
    s.rawY = s.y;
    s.rawYaw = s.yaw;
    s.phase = 'FOLLOW_CROP_ROW';
    s.turnWaypoints = [];
    s.rowEndConf = 0.08;
    s.distToFurrowEndM = 1.15;
    turnTrackerRef.current.active = false;
    setLiveTurnTelemetry((prev) => ({ ...prev, active: false, imuWzRadS: 0 }));
    setRowEndSnapshot(rowEndServiceRef.current.reset());
    setRunning(true);
    onLogEvent(
      `[row_end_detection] Positioned rover 1.15 m from Row ${s.rowIdx + 1} furrow end to test real-time distance projection & turn state transition.`
    );
  }, [estopActive, faultReason, sensorFaultInjected, rowWidthCm, onLogEvent]);

  const resetSimulation = (newRowWidthCm = rowWidthCm) => {
    const rw = newRowWidthCm / 100;
    const startY = rowCenterY(0, rw) + 0.05;
    setSensorFaultInjected(false);
    setFaultReason(null);
    setObstacles([]);
    setRunning(true);
    simRef.current = {
      x: ROW_START_X + 0.25,
      y: startY,
      yaw: 0.06,
      rawX: ROW_START_X + 0.25,
      rawY: startY,
      rawYaw: 0.06,
      ekfPath: [{ x: ROW_START_X + 0.25, y: startY }],
      rawPath: [{ x: ROW_START_X + 0.25, y: startY }],
      rowIdx: 0,
      dir: 1,
      rowProgress: [0, 0, 0, 0],
      phase: 'FOLLOW_CROP_ROW',
      phaseTimer: 0,
      turnWaypoints: [],
      turnWpIdx: 0,
      targets: makeInitialHookTargets(rw),
      activeTargetId: null,
      simSeconds: 0,
      lastTelemetrySync: 0,
      lastChartSync: 0,
      latErrM: 0.05,
      headErrRad: 0.06,
      rowEndConf: 0,
      distToFurrowEndM: FIELD_LEN_M - 0.25,
      slipResidualCm: 0.6,
      collisionState: 'CLEAR',
      cmdVx: speedLimit,
      cmdWz: 0,
      boundaryOk: true,
    };
    syncVisionTracker(0.05, 0.06);
    setRowEndSnapshot(rowEndServiceRef.current.reset());
    turnTrackerRef.current.active = false;
    turnTrackerRef.current.turnCounter = 0;
    turnTrackerRef.current.samples = [];
    turnTrackerRef.current.latestTelemetry = INITIAL_LIVE_TURN_TELEMETRY;
    setLiveTurnTelemetry(INITIAL_LIVE_TURN_TELEMETRY);
    setTurnSamples([]);
    setCompletedTurns([]);
    setHistory(
      Array.from({ length: 24 }, (_, idx) => ({
        t: `-${24 - idx}s`,
        latErrorCm: 0,
        ekfDriftCm: 0.5,
        rawOdomDriftCm: 0.5,
      }))
    );
    onLogEvent('[Navigation] Workbench reset to Row 1 start pose inside FieldBoundaryGuard margin.');
  };

  const injectSensorMinusOneFault = () => {
    setSensorFaultInjected(true);
    setFaultReason('OBSTACLE_SENSOR_FAULT (-1 invalid reading)');
    simRef.current.phase = 'FAULT';
    simRef.current.cmdVx = 0;
    simRef.current.cmdWz = 0;
    onLogEvent(
      '[NAV-05] Injected ultrasonic/ToF -1 reading -> Immediate SENSOR_FAULT halt. Plain Resume locked until Validate & Recover.'
    );
  };

  const injectSoilSlip = () => {
    const s = simRef.current;
    const rw = rowWidthCm / 100;
    const sideShift = (Math.random() > 0.5 ? 1 : -1) * 0.14;
    const yawKick = (Math.random() > 0.5 ? 1 : -1) * 0.22;
    s.y += sideShift;
    s.yaw += yawKick;
    s.rawYaw -= yawKick * 0.7;
    const targetRowY = rowCenterY(s.rowIdx, rw);
    const targetRowYaw = s.dir > 0 ? 0 : Math.PI;
    const newLat = (s.y - targetRowY) * (s.dir > 0 ? -1 : 1);
    const newHead = Math.atan2(Math.sin(s.yaw - targetRowYaw), Math.cos(s.yaw - targetRowYaw));
    s.latErrM = newLat;
    s.headErrRad = newHead;
    syncVisionTracker(newLat, newHead);
    s.slipResidualCm = Number((s.slipResidualCm + 13.4).toFixed(1));
    if (s.slipResidualCm > 12.0) {
      setFaultReason(`SLIP_RESIDUAL_FAULT (${s.slipResidualCm.toFixed(1)} cm > 12.0 cm limit)`);
      s.phase = 'FAULT';
      s.cmdVx = 0;
      s.cmdWz = 0;
      onLogEvent(
        `[NAV-03/10] Wheel slip residual ${s.slipResidualCm.toFixed(1)} cm exceeded 12.0 cm threshold -> Entered FAULT. Landmark re-localization required.`
      );
    } else {
      onLogEvent(
        `[Disturbance] Soil slip (${(sideShift * 100).toFixed(1)} cm lateral). Fused IMU+Visual servoing compensating.`
      );
    }
  };

  const recoverFromFault = () => {
    const s = simRef.current;
    const rw = rowWidthCm / 100;
    setSensorFaultInjected(false);
    setFaultReason(null);
    s.slipResidualCm = 0.5;
    s.y = rowCenterY(s.rowIdx, rw);
    s.yaw = s.dir > 0 ? 0 : Math.PI;
    s.rawX = s.x;
    s.rawY = s.y;
    s.rawYaw = s.yaw;
    s.latErrM = 0;
    s.headErrRad = 0;
    syncVisionTracker(0, 0);
    s.collisionState = 'CLEAR';
    s.phase = 'FOLLOW_CROP_ROW';
    setRunning(true);
    onLogEvent(
      `[NAV-10] Explicit recover() succeeded: Obstacle sensor validated + ArUco/RTK landmark pose re-localized on Row ${s.rowIdx + 1}.`
    );
  };

  const toggleSampleObstacle = () => {
    if (obstacles.length > 0) {
      setObstacles([]);
      onLogEvent('[NAV-09] Cleared unknown field obstacle. Releasing OBSTACLE_HOLD safely.');
      return;
    }
    const s = simRef.current;
    const obsX = Math.max(ROW_START_X + 0.5, Math.min(ROW_END_X - 0.5, s.x + Math.cos(s.yaw) * 0.85));
    const obsY = s.y + Math.sin(s.yaw) * 0.15;
    setObstacles([{ id: Date.now(), x: obsX, y: obsY, r: 0.13 }]);
    onLogEvent(
      `[NAV-09] Placed unknown obstacle ahead at (${obsX.toFixed(2)} m, ${obsY.toFixed(2)} m) -> Rover will enter safe OBSTACLE_HOLD.`
    );
  };

  const saveMissionCheckpoint = () => {
    const s = simRef.current;
    const avgCov = (s.rowProgress.reduce((a, b) => a + b, 0) / NUM_ROWS) * 100;
    const snap: SavedCheckpoint = {
      rowIdx: s.rowIdx,
      dir: s.dir,
      x: s.x,
      y: s.y,
      yaw: s.yaw,
      rowProgress: [...s.rowProgress],
      coveragePct: avgCov,
      savedAt: new Date().toLocaleTimeString(),
    };
    setCheckpoint(snap);
    onLogEvent(
      `[NAV-12] Saved atomic checkpoint (Row ${snap.rowIdx + 1}, verified coverage ${snap.coveragePct.toFixed(1)}%).`
    );
  };

  const restoreMissionCheckpoint = () => {
    if (!checkpoint) return;
    const s = simRef.current;
    setSensorFaultInjected(false);
    setFaultReason(null);
    s.rowIdx = checkpoint.rowIdx;
    s.dir = checkpoint.dir;
    s.x = checkpoint.x;
    s.y = checkpoint.y;
    s.yaw = checkpoint.yaw;
    s.rawX = checkpoint.x;
    s.rawY = checkpoint.y;
    s.rawYaw = checkpoint.yaw;
    s.rowProgress = [...checkpoint.rowProgress];
    s.phase = 'FOLLOW_CROP_ROW';
    s.turnWaypoints = [];
    s.ekfPath = [{ x: checkpoint.x, y: checkpoint.y }];
    s.rawPath = [{ x: checkpoint.x, y: checkpoint.y }];
    setRowEndSnapshot(rowEndServiceRef.current.reset());
    setRunning(true);
    onLogEvent(
      `[NAV-12] Resumed mission from checkpoint (${checkpoint.savedAt}) at Row ${checkpoint.rowIdx + 1} (${checkpoint.coveragePct.toFixed(1)}% covered).`
    );
  };

  const handleFieldCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = fieldCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const py = ((e.clientY - rect.top) / rect.height) * canvas.height;

    const rw = paramsRef.current.rowWidthM;
    const worldW = ROW_END_X + 1.2;
    const worldH = 1.8 + (NUM_ROWS - 1) * rw;
    const wx = (px / canvas.width) * worldW;
    const wy = (py / canvas.height) * worldH;

    const existing = obstacles.find((o) => Math.hypot(o.x - wx, o.y - wy) < 0.35);
    if (existing) {
      setObstacles((prev) => prev.filter((o) => o.id !== existing.id));
      onLogEvent(`[NAV-09] Removed obstacle at (${existing.x.toFixed(2)} m, ${existing.y.toFixed(2)} m).`);
    } else {
      setObstacles((prev) => [...prev, { id: Date.now(), x: wx, y: wy, r: 0.13 }]);
      onLogEvent(`[NAV-09] Placed obstacle at (${wx.toFixed(2)} m, ${wy.toFixed(2)} m).`);
    }
  };

  useEffect(() => {
    let rafId = 0;
    let lastTime = performance.now();

    const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

    const tick = (now: number) => {
      const dtReal = Math.min(0.05, (now - lastTime) / 1000);
      lastTime = now;

      const p = paramsRef.current;
      const s = simRef.current;
      const dt = dtReal * 2.4;

      if (p.sensorFaultInjected) {
        s.collisionState = 'SENSOR_FAULT';
      } else {
        let minForwardObsDist = 99;
        for (const obs of p.obstacles) {
          const dx = obs.x - s.x;
          const dy = obs.y - s.y;
          const localX = dx * Math.cos(-s.yaw) - dy * Math.sin(-s.yaw);
          const localY = dx * Math.sin(-s.yaw) + dy * Math.cos(-s.yaw);
          if (localX > -0.18 && localX < 0.72 && Math.abs(localY) < 0.28 + obs.r) {
            minForwardObsDist = Math.min(minForwardObsDist, Math.max(0, localX - obs.r));
          }
        }
        if (minForwardObsDist <= 0.34) {
          s.collisionState = 'STOP';
        } else if (minForwardObsDist <= 0.68) {
          s.collisionState = 'SLOWDOWN';
        } else {
          s.collisionState = 'CLEAR';
        }
      }

      const rw = p.rowWidthM;
      const worldW = ROW_END_X + 1.2;
      const worldH = 1.8 + (NUM_ROWS - 1) * rw;
      const marginM = 0.28;
      s.boundaryOk =
        s.x >= marginM && s.x <= worldW - marginM && s.y >= marginM && s.y <= worldH - marginM;

      if (p.estopActive) {
        s.phase = 'ESTOP_HALTED';
        s.cmdVx = 0;
        s.cmdWz = 0;
      } else if (p.faultReason !== null || p.sensorFaultInjected) {
        s.phase = 'FAULT';
        s.cmdVx = 0;
        s.cmdWz = 0;
      } else if (!p.running) {
        s.cmdVx = 0;
        s.cmdWz = 0;
      } else if (s.phase !== 'MISSION_COMPLETE') {
        if (s.phase === 'ESTOP_HALTED' || s.phase === 'PAUSED' || s.phase === 'OBSTACLE_HOLD') {
          s.phase = 'FOLLOW_CROP_ROW';
        }

        s.simSeconds += dt;
        const targetRowY = rowCenterY(s.rowIdx, rw);
        const targetRowYaw = s.dir > 0 ? 0 : Math.PI;

        const latErr = (s.y - targetRowY) * (s.dir > 0 ? -1 : 1);
        const headErr = wrapAngle(s.yaw - targetRowYaw);
        s.latErrM = latErr;
        s.headErrRad = headErr;

        const distToEnd = s.dir > 0 ? ROW_END_X - s.x : s.x - ROW_START_X;
        s.distToFurrowEndM = Math.max(0.15, distToEnd);
        s.rowEndConf = Math.max(0, Math.min(1, 1 - (distToEnd - 0.15) / 0.85));

        let vx = 0;
        let wz = 0;

        if (s.collisionState === 'STOP') {
          vx = 0;
          wz = 0;
        } else if (s.phase === 'FOLLOW_CROP_ROW') {
          const progressFrac =
            s.dir > 0
              ? (s.x - ROW_START_X) / FIELD_LEN_M
              : (ROW_END_X - s.x) / FIELD_LEN_M;
          s.rowProgress[s.rowIdx] = Math.max(
            s.rowProgress[s.rowIdx],
            Math.max(0, Math.min(1, progressFrac))
          );

          const nearbyTarget =
            p.missionMode === 'treatment_hook'
              ? s.targets.find(
                  (t) =>
                    !t.serviced &&
                    t.row === s.rowIdx + 1 &&
                    Math.hypot(t.x - s.x, t.y - s.y) < 0.14
                )
              : undefined;

          if (nearbyTarget) {
            s.phase = 'TREATMENT_HOOK_HOLD';
            s.phaseTimer = 0.75;
            s.activeTargetId = nearbyTarget.id;
            vx = 0;
            wz = 0;
          } else if (s.rowEndConf >= 0.96) {
            // Hard boundary backstop if row_end_detection service is paused or not yet latched
            s.rowProgress[s.rowIdx] = 1.0;
            s.phase = 'ROW_END_STOP';
            s.phaseTimer = 1.1;
            vx = 0;
            wz = 0;
          } else {
            const crossTrack = Math.atan2(p.stanleyGain * (-latErr), p.speedLimit + 0.05);
            const rawWz = -(1.35 * headErr + crossTrack);
            wz = Math.max(-0.75, Math.min(0.75, rawWz));
            const turnRatio = Math.abs(wz) / 0.75;
            vx = Math.max(0.06, p.speedLimit * (1 - 0.45 * turnRatio));
            if (s.collisionState === 'SLOWDOWN') vx *= 0.45;
          }
        } else if (s.phase === 'TREATMENT_HOOK_HOLD') {
          s.phaseTimer -= dt;
          if (s.phaseTimer <= 0) {
            if (s.activeTargetId !== null) {
              const target = s.targets.find((t) => t.id === s.activeTargetId);
              if (target) target.serviced = true;
              s.activeTargetId = null;
            }
            s.phase = 'FOLLOW_CROP_ROW';
          }
        } else if (s.phase === 'ROW_END_STOP') {
          // Hold cleanly for operator turn confirmation in alert_and_confirm mode; auto-dispatch in auto_execute mode
          const autoDispatch =
            !p.rowEndConfig.enabled || p.rowEndConfig.turnDispatchMode === 'auto_execute';
          if (autoDispatch) {
            s.phaseTimer -= dt;
            if (s.phaseTimer <= 0) {
              if (s.rowIdx >= NUM_ROWS - 1) {
                s.phase = 'MISSION_COMPLETE';
                setRowEndSnapshot(rowEndServiceRef.current.notifyTurnComplete(true));
              } else {
                const nextRowIdx = s.rowIdx + 1;
                const yFrom = rowCenterY(s.rowIdx, rw);
                const yTo = rowCenterY(nextRowIdx, rw);
                const exitX = s.dir > 0 ? ROW_END_X + 0.62 : ROW_START_X - 0.62;
                const entryX = s.dir > 0 ? ROW_END_X - 0.1 : ROW_START_X + 0.1;
                const nextYaw = s.dir > 0 ? Math.PI : 0;
                const waypoints = [
                  { x: exitX, y: yFrom, yaw: Math.PI / 2 },
                  { x: exitX, y: yTo, yaw: nextYaw },
                  { x: entryX, y: yTo, yaw: nextYaw },
                ];
                s.turnWaypoints = waypoints;
                s.turnWpIdx = 0;
                s.phase = 'NAV2_HEADLAND_TURN';
                initTurnTracker(s, nextRowIdx, waypoints, nextYaw);
                setRowEndSnapshot(rowEndServiceRef.current.acknowledgeTurnStart('auto'));
              }
            }
          }
        } else if (s.phase === 'NAV2_HEADLAND_TURN') {
          const finalizeCompletedTurn = () => {
            const tr = turnTrackerRef.current;
            if (!tr.active) return;
            tr.active = false;
            tr.turnCounter += 1;
            const imuDeltaDeg = Number(((tr.imuCumRad * 180) / Math.PI).toFixed(1));
            const rawOdomDeltaDeg = Number(((tr.rawCumRad * 180) / Math.PI).toFixed(1));
            const finalHeadingErrorDeg = Number(
              ((tr.turnSign * wrapAngle(s.yaw - tr.targetEndYaw) * 180) / Math.PI).toFixed(2)
            );
            const rmsHeadingErrorDeg = Number(
              Math.sqrt(tr.sqErrorDegSum / Math.max(1, tr.sampleCount)).toFixed(2)
            );
            const maxCrossTrackCm = Number(tr.maxCrossTrackCm.toFixed(1));
            const accuracyPct = Number(
              Math.max(
                0,
                Math.min(
                  100,
                  100 -
                    Math.abs(finalHeadingErrorDeg) * 0.65 -
                    rmsHeadingErrorDeg * 0.45 -
                    Math.max(0, maxCrossTrackCm - 3.0) * 0.25
                )
              ).toFixed(1)
            );
            const durationSec = Number(Math.max(0.5, s.simSeconds - tr.startSimSec).toFixed(1));
            const passed =
              accuracyPct >= 95.0 &&
              Math.abs(finalHeadingErrorDeg) <= 5.0 &&
              maxCrossTrackCm <= 12.0;

            const finalSample: TurnTrajectorySample = {
              progressPct: 100,
              label: '100%',
              calculatedDeg: 180,
              imuDeg: Number(Math.max(0, imuDeltaDeg).toFixed(1)),
              rawOdomDeg: Number(Math.max(0, rawOdomDeltaDeg).toFixed(1)),
              errorDeg: finalHeadingErrorDeg,
              crossTrackCm: maxCrossTrackCm,
            };
            tr.samples = [...tr.samples.filter((pt) => pt.progressPct < 100), finalSample];

            const record: CompletedTurnRecord = {
              id: tr.turnCounter,
              fromRow: tr.fromRow,
              toRow: tr.toRow,
              direction: tr.direction,
              targetDeltaDeg: 180,
              imuDeltaDeg,
              rawOdomDeltaDeg,
              finalHeadingErrorDeg,
              rmsHeadingErrorDeg,
              maxCrossTrackCm,
              accuracyPct,
              durationSec,
              passed,
              completedAt: new Date().toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              }),
            };

            tr.latestTelemetry = {
              ...tr.latestTelemetry,
              active: false,
              progressPct: 100,
              calculatedYawDeg: 180,
              imuYawDeg: imuDeltaDeg,
              rawOdomYawDeg: rawOdomDeltaDeg,
              headingErrorDeg: finalHeadingErrorDeg,
              imuWzRadS: 0,
              crossTrackCm: maxCrossTrackCm,
              liveAccuracyPct: accuracyPct,
            };

            setTurnSamples([...tr.samples]);
            setLiveTurnTelemetry(tr.latestTelemetry);
            setCompletedTurns((prev) => [record, ...prev.slice(0, 11)]);
            onLogEventRef.current(
              `[Turn Accuracy] Turn #${record.id} (R${record.fromRow}→R${record.toRow} ${record.direction}): ${record.accuracyPct.toFixed(
                1
              )}% ${record.passed ? 'PASS' : 'WARN'} · IMU Δψ=${record.imuDeltaDeg.toFixed(
                1
              )}° vs 180.0° (err ${record.finalHeadingErrorDeg >= 0 ? '+' : ''}${record.finalHeadingErrorDeg.toFixed(
                2
              )}°, Max CTE ${record.maxCrossTrackCm.toFixed(1)} cm).`
            );
          };

          const wp = s.turnWaypoints[s.turnWpIdx];
          if (!wp) {
            finalizeCompletedTurn();
            s.rowIdx += 1;
            s.dir *= -1;
            s.phase = 'FOLLOW_CROP_ROW';
            setRowEndSnapshot(rowEndServiceRef.current.notifyTurnComplete(false));
          } else {
            const dx = wp.x - s.x;
            const dy = wp.y - s.y;
            const dist = Math.hypot(dx, dy);
            if (dist < 0.08) {
              s.turnWpIdx += 1;
              if (s.turnWpIdx >= s.turnWaypoints.length) {
                finalizeCompletedTurn();
                s.rowIdx += 1;
                s.dir *= -1;
                s.phase = 'FOLLOW_CROP_ROW';
                setRowEndSnapshot(rowEndServiceRef.current.notifyTurnComplete(false));
              }
            } else {
              const desiredYaw = Math.atan2(dy, dx);
              const yawErr = wrapAngle(desiredYaw - s.yaw);
              wz = Math.max(-0.95, Math.min(0.95, yawErr * 2.2));
              vx = Math.abs(yawErr) > 0.65 ? 0.04 : Math.min(p.speedLimit, 0.18);
              if (s.collisionState === 'SLOWDOWN') vx *= 0.45;
            }
          }
        }

        const nextX = s.x + vx * Math.cos(s.yaw) * dt;
        const nextY = s.y + vx * Math.sin(s.yaw) * dt;
        if (nextX < marginM || nextX > worldW - marginM || nextY < marginM || nextY > worldH - marginM) {
          vx = 0;
        }

        s.cmdVx = vx;
        s.cmdWz = wz;

        const microNoiseYaw = Math.abs(vx) > 0.01 ? Math.sin(s.simSeconds * 1.7) * 0.008 * dt : 0;
        s.yaw = wrapAngle(s.yaw + wz * dt + microNoiseYaw);
        s.x += vx * Math.cos(s.yaw) * dt;
        s.y += vx * Math.sin(s.yaw) * dt;

        s.slipResidualCm = Math.max(0.4, s.slipResidualCm * 0.992);

        const rawSlipBias = Math.abs(wz) > 0.12 ? 0.16 * wz * dt : 0.012 * vx * dt;
        s.rawYaw = wrapAngle(s.rawYaw + wz * dt + rawSlipBias);
        s.rawX += vx * 1.035 * Math.cos(s.rawYaw) * dt;
        s.rawY += vx * 1.035 * Math.sin(s.rawYaw) * dt;

        // Track live IMU vs. calculated trajectory progress during active headland turn
        if (s.phase === 'NAV2_HEADLAND_TURN' && turnTrackerRef.current.active) {
          const tr = turnTrackerRef.current;
          const dImu = wrapAngle(s.yaw - tr.prevImuYaw);
          const dRaw = wrapAngle(s.rawYaw - tr.prevRawYaw);
          tr.prevImuYaw = s.yaw;
          tr.prevRawYaw = s.rawYaw;

          // Integrate IMU gyro with minor realistic MEMS bias/jitter (rad)
          const imuGyroBiasRadS = (0.04 + Math.sin(s.simSeconds * 0.5) * 0.015) * (Math.PI / 180);
          tr.imuCumRad += tr.turnSign * (dImu + imuGyroBiasRadS * dt);
          tr.rawCumRad += tr.turnSign * dRaw;

          // Compute ideal calculated trajectory heading along active segment
          const segIdx = Math.min(s.turnWpIdx, Math.max(0, tr.segLengths.length - 1));
          const pA = tr.waypoints[segIdx];
          const pB = tr.waypoints[segIdx + 1];
          let crossTrackCm = 0;
          let traversedLen = 0;
          for (let i = 0; i < segIdx; i++) {
            traversedLen += tr.segLengths[i];
          }
          if (pA && pB) {
            const segDx = pB.x - pA.x;
            const segDy = pB.y - pA.y;
            const segLen = Math.max(1e-4, tr.segLengths[segIdx]);
            const proj = Math.max(
              0,
              Math.min(1, ((s.x - pA.x) * segDx + (s.y - pA.y) * segDy) / (segLen * segLen))
            );
            traversedLen += proj * segLen;
            const footX = pA.x + proj * segDx;
            const footY = pA.y + proj * segDy;
            crossTrackCm = Math.hypot(s.x - footX, s.y - footY) * 100;

            const segYaw = Math.atan2(segDy, segDx);
            const calcErr = wrapAngle(segYaw - tr.calcHeadingRad);
            const calcWz = Math.max(-0.95, Math.min(0.95, calcErr * 2.35));
            tr.calcHeadingRad = wrapAngle(tr.calcHeadingRad + calcWz * dt);
            tr.calcCumRad = Math.min(Math.PI, Math.max(0, tr.calcCumRad + tr.turnSign * calcWz * dt));
          }

          const progressPct = Math.max(0, Math.min(99.5, (traversedLen / tr.totalLen) * 100));
          const calcDeg = Math.min(180, Math.max(0, (tr.calcCumRad * 180) / Math.PI));
          const imuDeg = Math.max(0, (tr.imuCumRad * 180) / Math.PI);
          const rawOdomDeg = Math.max(0, (tr.rawCumRad * 180) / Math.PI);
          const headingErrDeg = imuDeg - calcDeg;

          tr.sqErrorDegSum += headingErrDeg * headingErrDeg;
          tr.sampleCount += 1;
          if (crossTrackCm > tr.maxCrossTrackCm) {
            tr.maxCrossTrackCm = crossTrackCm;
          }

          const liveRms = Math.sqrt(tr.sqErrorDegSum / Math.max(1, tr.sampleCount));
          const liveAccuracyPct = Math.max(
            0,
            Math.min(
              100,
              100 -
                Math.abs(headingErrDeg) * 0.55 -
                liveRms * 0.45 -
                Math.max(0, tr.maxCrossTrackCm - 3.0) * 0.25
            )
          );

          tr.latestTelemetry = {
            active: true,
            fromRow: tr.fromRow,
            toRow: tr.toRow,
            direction: tr.direction,
            progressPct,
            calculatedYawDeg: calcDeg,
            imuYawDeg: imuDeg,
            rawOdomYawDeg: rawOdomDeg,
            headingErrorDeg: headingErrDeg,
            imuWzRadS: wz + imuGyroBiasRadS,
            imuGyroBiasDegS: Number(((imuGyroBiasRadS * 180) / Math.PI).toFixed(2)),
            crossTrackCm,
            liveAccuracyPct,
          };

          if (progressPct - tr.lastSampleProgress >= 4.5) {
            tr.lastSampleProgress = progressPct;
            tr.samples.push({
              progressPct: Number(progressPct.toFixed(0)),
              label: `${Math.round(progressPct)}%`,
              calculatedDeg: Number(calcDeg.toFixed(1)),
              imuDeg: Number(imuDeg.toFixed(1)),
              rawOdomDeg: Number(rawOdomDeg.toFixed(1)),
              errorDeg: Number(headingErrDeg.toFixed(2)),
              crossTrackCm: Number(crossTrackCm.toFixed(1)),
            });
          }
        }

        const lastEkf = s.ekfPath[s.ekfPath.length - 1];
        if (!lastEkf || Math.hypot(s.x - lastEkf.x, s.y - lastEkf.y) > 0.06) {
          s.ekfPath.push({ x: s.x, y: s.y });
          s.rawPath.push({ x: s.rawX, y: s.rawY });
          if (s.ekfPath.length > 500) {
            s.ekfPath.shift();
            s.rawPath.shift();
          }
        }
      }

      drawFieldCanvas(fieldCanvasRef.current, s, p);
      if (p.visionSourceMode === 'sim') {
        drawForwardCamCanvas(camCanvasRef.current, s, p);
      }

      if (now - s.lastTelemetrySync > 125) {
        s.lastTelemetrySync = now;
        const rawDriftCm = Math.hypot(s.rawX - s.x, s.rawY - s.y) * 100;
        const ekfDriftCm = 0.7 + Math.abs(Math.sin(s.simSeconds * 0.8)) * 0.6;
        const coveragePct = (s.rowProgress.reduce((a, b) => a + b, 0) / NUM_ROWS) * 100;
        const completedRows = s.rowProgress.filter((v) => v >= 0.95).length;

        const displayPhase: MissionPhase = p.estopActive
          ? 'ESTOP_HALTED'
          : p.faultReason !== null || p.sensorFaultInjected
          ? 'FAULT'
          : !p.running
          ? 'PAUSED'
          : s.collisionState === 'STOP'
          ? 'OBSTACLE_HOLD'
          : s.phase;

        setTelemetry({
          phase: displayPhase,
          currentRow: s.rowIdx + 1,
          x: s.x,
          y: s.y,
          yawDeg: (s.yaw * 180) / Math.PI,
          rowEndConf: s.rowEndConf,
          ekfDriftCm,
          rawOdomDriftCm: rawDriftCm,
          slipResidualCm: s.slipResidualCm,
          collisionState: s.collisionState,
          coveragePct,
          completedRows,
          hooksServiced: s.targets.filter((t) => t.serviced).length,
          totalHooks: s.targets.length,
          cmdVx: s.cmdVx,
          cmdWz: s.cmdWz,
          boundaryOk: s.boundaryOk,
        });

        if (turnTrackerRef.current.active) {
          setLiveTurnTelemetry({ ...turnTrackerRef.current.latestTelemetry });
          setTurnSamples([...turnTrackerRef.current.samples]);
        }

        if (now - s.lastChartSync > 650) {
          s.lastChartSync = now;
          setHistory((prev) => [
            ...prev.slice(1),
            {
              t: `${Math.round(s.simSeconds)}s`,
              latErrorCm: Number((Math.abs(s.latErrM) * 100).toFixed(1)),
              ekfDriftCm: Number(ekfDriftCm.toFixed(1)),
              rawOdomDriftCm: Number(Math.min(45, rawDriftCm).toFixed(1)),
            },
          ]);
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const isFaulted = faultReason !== null || sensorFaultInjected;

  return (
    <div className="space-y-6">
      {/* Top Telemetry Ribbon */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-emerald-900/10 pb-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">
            Navigation Sector Commissioning &amp; Fail-Safe Workbench
          </h2>
          <p className="text-xs text-slate-600 mt-1">
            Closed-Loop Encoder + IMU Fusion (NAV-01..03) · FieldBoundaryGuard (NAV-08) · Fail-Safe Sensor &amp; Obstacle Hold (NAV-05/09) · Verified Coverage Checkpoints (NAV-11/12)
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Quick Real-Time Video Stream Controls */}
          {cameraFeedState.active || streamMode !== 'sim' ? (
            <button
              onClick={() => {
                if (cameraFeedState.active) triggerCameraFeed('stop');
                if (streamMode !== 'sim') triggerStreamAction('stop_to_sim');
              }}
              className="px-3.5 py-2 text-xs font-semibold rounded-md bg-rose-600 hover:bg-rose-700 text-white transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer"
            >
              <CameraOff className="w-3.5 h-3.5" />
              <span>Stop Camera Feed</span>
            </button>
          ) : (
            <>
              <button
                onClick={() => triggerCameraFeed('start')}
                className="px-3.5 py-2 text-xs font-semibold rounded-md bg-emerald-600 hover:bg-emerald-700 text-white transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer"
              >
                <Camera className="w-3.5 h-3.5" />
                <span>Live Camera Check</span>
              </button>
              <button
                onClick={() => triggerStreamAction('start_webrtc')}
                className="px-3 py-2 text-xs font-medium rounded-md bg-white hover:bg-emerald-50 border border-emerald-900/15 text-slate-700 transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer"
              >
                <Wifi className="w-3.5 h-3.5 text-emerald-600" />
                <span>WebRTC / CameraX WS</span>
              </button>
            </>
          )}

          <div className="flex items-center p-1 bg-[#EDF5F0] border border-emerald-900/10 rounded-lg">
            <button
              onClick={() => {
                setMissionMode('nav_only');
                onLogEvent(
                  '[Mode] Navigation-Only (Treatment Decoupled) — Legacy laser detached; pure navigation commissioning.'
                );
              }}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer ${
                missionMode === 'nav_only'
                  ? 'bg-white text-emerald-800 border border-emerald-200'
                  : 'text-slate-600 hover:text-emerald-800 border border-transparent'
              }`}
            >
              <Unplug className="w-3.5 h-3.5" />
              <span>Nav-Only (Decoupled)</span>
            </button>
            <button
              onClick={() => {
                setMissionMode('treatment_hook');
                onLogEvent(
                  '[Mode] Modular Treatment Hook Window enabled (stationary pause ready for future Flame/Grinder module).'
                );
              }}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer ${
                missionMode === 'treatment_hook'
                  ? 'bg-white text-emerald-800 border border-emerald-200'
                  : 'text-slate-600 hover:text-emerald-800 border border-transparent'
              }`}
            >
              <Wrench className="w-3.5 h-3.5" />
              <span>Treatment Hook (Flame/Grinder)</span>
            </button>
          </div>
        </div>
      </div>

      {/* Asymmetric Split Console */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-stretch">
        {/* Left Control, Fault-Injection & Checkpoint Column */}
        <aside className="xl:col-span-3 bg-white border border-emerald-900/10 rounded-lg p-5 flex flex-col justify-between gap-5">
          <div className="space-y-5">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">Navigation Tuning</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Live parameters for <span className="font-mono text-emerald-800">RowNavigator</span> &amp; Stanley loop
              </p>
            </div>

            {/* Speed Limit Slider */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-600">Closed-Loop Speed</span>
                <span className="font-mono tabular-nums text-emerald-700 font-semibold">{speedLimit.toFixed(2)} m/s</span>
              </div>
              <input
                type="range"
                min={0.08}
                max={0.3}
                step={0.01}
                value={speedLimit}
                onChange={(e) => setSpeedLimit(parseFloat(e.target.value))}
                className="w-full accent-emerald-600 cursor-pointer"
              />
            </div>

            {/* Stanley Gain Slider */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-600">Row Alignment Gain (k)</span>
                <span className="font-mono tabular-nums text-emerald-700 font-semibold">{stanleyGain.toFixed(1)}</span>
              </div>
              <input
                type="range"
                min={0.6}
                max={3.0}
                step={0.1}
                value={stanleyGain}
                onChange={(e) => setStanleyGain(parseFloat(e.target.value))}
                className="w-full accent-emerald-600 cursor-pointer"
              />
            </div>

            {/* Row Width Selector */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-600">Crop Row Spacing</span>
                <span className="font-mono tabular-nums text-slate-800">{rowWidthCm} cm</span>
              </div>
              <div className="grid grid-cols-3 gap-1.5">
                {[50, 60, 75].map((w) => (
                  <button
                    key={w}
                    onClick={() => {
                      setRowWidthCm(w);
                      resetSimulation(w);
                    }}
                    className={`py-1.5 text-xs font-mono rounded border transition-colors cursor-pointer ${
                      rowWidthCm === w
                        ? 'bg-emerald-50 border-emerald-500 text-emerald-800 font-semibold'
                        : 'bg-[#F8FBF9] border-slate-200 text-slate-600 hover:text-emerald-800 hover:border-emerald-300'
                    }`}
                  >
                    {w} cm
                  </button>
                ))}
              </div>
            </div>

            {/* Audit Fault-Injection Tests */}
            <div className="pt-4 border-t border-emerald-900/10 space-y-2">
              <div className="text-xs font-semibold text-slate-800">Audit Fault-Injection Tests</div>
              <button
                onClick={injectSensorMinusOneFault}
                className="w-full px-3 py-2 text-xs font-medium bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-800 rounded-md flex items-center justify-between transition-colors cursor-pointer"
              >
                <span>Inject Sensor -1 Fault (NAV-05)</span>
                <ShieldAlert className="w-3.5 h-3.5 text-rose-600" />
              </button>
              <button
                onClick={injectSoilSlip}
                className="w-full px-3 py-2 text-xs font-medium bg-[#F8FBF9] hover:bg-emerald-50 border border-slate-200 text-slate-700 rounded-md flex items-center justify-between transition-colors cursor-pointer"
              >
                <span>Inject Wheel Slip (NAV-03/10)</span>
                <Radio className="w-3.5 h-3.5 text-amber-600" />
              </button>
              <button
                onClick={toggleSampleObstacle}
                className="w-full px-3 py-2 text-xs font-medium bg-[#F8FBF9] hover:bg-emerald-50 border border-slate-200 text-slate-700 rounded-md flex items-center justify-between transition-colors cursor-pointer"
              >
                <span>
                  {obstacles.length > 0 ? 'Clear Unknown Obstacle' : 'Place Obstacle (NAV-09 Hold)'}
                </span>
                {obstacles.length > 0 ? (
                  <Trash2 className="w-3.5 h-3.5 text-slate-500" />
                ) : (
                  <Plus className="w-3.5 h-3.5 text-rose-600" />
                )}
              </button>

              {isFaulted && (
                <button
                  onClick={recoverFromFault}
                  className="w-full px-3 py-2 text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white rounded-md flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                >
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>Validate &amp; Recover (NAV-10)</span>
                </button>
              )}
            </div>

            {/* Mission Checkpoint (NAV-12) */}
            <div className="pt-4 border-t border-emerald-900/10 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-slate-800">Checkpoint (NAV-12)</span>
                <span className="font-mono text-[11px] text-slate-500">
                  {checkpoint ? `Row ${checkpoint.rowIdx + 1} · ${checkpoint.coveragePct.toFixed(0)}%` : 'None'}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={saveMissionCheckpoint}
                  className="px-2.5 py-1.5 text-xs font-medium bg-[#F8FBF9] hover:bg-emerald-50 border border-slate-200 text-slate-700 rounded flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <BookmarkCheck className="w-3.5 h-3.5 text-emerald-600" />
                  <span>Save</span>
                </button>
                <button
                  onClick={restoreMissionCheckpoint}
                  disabled={!checkpoint}
                  className="px-2.5 py-1.5 text-xs font-medium bg-[#F8FBF9] hover:bg-emerald-50 disabled:opacity-40 border border-slate-200 text-slate-700 rounded flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5 text-emerald-600" />
                  <span>Restore</span>
                </button>
              </div>
            </div>
          </div>

          {/* Bottom Execution Controls */}
          <div className="pt-4 border-t border-emerald-900/10 flex items-center gap-2">
            <button
              onClick={() => {
                if (isFaulted) return;
                setRunning((r) => {
                  const next = !r;
                  onLogEvent(
                    next
                      ? '[Navigation] Operator resumed mission.'
                      : '[NAV-12] Operator paused mission — zero velocity commanded.'
                  );
                  return next;
                });
              }}
              disabled={estopActive || isFaulted}
              className="flex-1 px-4 py-2 text-xs font-semibold rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-500 text-white transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
            >
              {running ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              <span>{isFaulted ? 'Locked (Fault)' : running ? 'Pause' : 'Resume'}</span>
            </button>
            <button
              onClick={() => resetSimulation()}
              className="px-3 py-2 text-xs font-medium rounded-md bg-[#F8FBF9] hover:bg-emerald-50 border border-slate-200 text-slate-700 transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset</span>
            </button>
          </div>
        </aside>

        {/* Main Viewport Stage */}
        <div className="xl:col-span-9 flex flex-col gap-5">
          {/* Dedicated Vision Node Crop-Row Alignment Visualization Block (Prominent Top Band) */}
          <CropRowAlignmentGauge alignment={visionAlignment} />

          {/* Vision-Based row_end_detection Service & Turn Execution Alert Console */}
          <RowEndDetectionPanel
            snapshot={rowEndSnapshot}
            config={rowEndConfig}
            currentMissionPhase={telemetry.phase}
            estopActive={estopActive}
            isFaulted={isFaulted}
            onUpdateConfig={handleUpdateRowEndConfig}
            onExecuteTurn={() => dispatchHeadlandTurn('operator')}
            onDismissAlert={handleDismissRowEndAlert}
            onInvokeServiceCheck={handleInvokeRowEndCheck}
            onJumpToRowEndTest={handleJumpToRowEndTest}
          />

          {/* Live Device Camera Crop-Row Feed (<video> via getUserMedia) */}
          <RealTimeCameraFeed
            rowWidthM={rowWidthCm / 100}
            stanleyGain={stanleyGain}
            speedLimit={speedLimit}
            externalTrigger={cameraFeedTrigger}
            onAlignmentUpdate={handleCameraFeedAlignment}
            onLogEvent={onLogEvent}
          />

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* Top-Down Field + Boundary Polygon + EKF + LiDAR Map */}
            <div className="lg:col-span-8 bg-white border border-emerald-900/10 rounded-lg p-4 flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Compass className="w-4 h-4 text-emerald-600" />
                  <h3 className="text-sm font-semibold text-slate-900">
                    Field Map, Boundary Guard (NAV-08) &amp; Fused Pose
                  </h3>
                </div>
                <div className="flex items-center gap-3 text-[11px] font-mono text-slate-500">
                  <span className="text-emerald-700 font-medium">— Fused Pose</span>
                  <span className="text-amber-600">-- Raw Odom</span>
                  <span className="text-emerald-600">□ Boundary</span>
                  <span className="text-rose-600">■ Hold Zone</span>
                </div>
              </div>

              <div className="relative rounded border border-emerald-900/10 bg-[#F8FBF9] overflow-hidden">
                <canvas
                  ref={fieldCanvasRef}
                  width={760}
                  height={370}
                  onClick={handleFieldCanvasClick}
                  className="w-full h-auto block cursor-crosshair"
                />
                {estopActive && (
                  <div className="absolute inset-0 bg-rose-900/25 backdrop-blur-[1px] flex items-center justify-center p-4">
                    <div className="bg-white border border-rose-400 px-5 py-3 rounded-md flex items-center gap-2.5 text-rose-800 font-mono text-xs sm:text-sm shadow-sm">
                      <AlertOctagon className="w-5 h-5 text-rose-600 shrink-0" />
                      <span>HARDWARE E-STOP ENGAGED (GPIO 13) — MOTOR RAIL DE-ENERGIZED</span>
                    </div>
                  </div>
                )}
                {!estopActive && isFaulted && (
                  <div className="absolute inset-0 bg-amber-900/20 backdrop-blur-[1px] flex items-center justify-center p-4">
                    <div className="bg-white border border-amber-400 px-5 py-3.5 rounded-md flex flex-col sm:flex-row items-center gap-3 text-amber-900 font-mono text-xs shadow-sm">
                      <div className="flex items-center gap-2">
                        <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0" />
                        <span>FAULT HALT: {faultReason}</span>
                      </div>
                      <button
                        onClick={recoverFromFault}
                        className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-semibold whitespace-nowrap cursor-pointer"
                      >
                        Validate &amp; Recover
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono tabular-nums text-slate-600">
                <span>
                  Pose: X={telemetry.x.toFixed(2)} m · Y={telemetry.y.toFixed(2)} m · Yaw={telemetry.yawDeg.toFixed(1)}°
                </span>
                <span>
                  Slip Residual:{' '}
                  <span className={telemetry.slipResidualCm > 8 ? 'text-amber-700 font-semibold' : 'text-emerald-700 font-semibold'}>
                    {telemetry.slipResidualCm.toFixed(1)} cm
                  </span>{' '}
                  · /cmd_vel_safe: vx={telemetry.cmdVx.toFixed(2)} m/s
                </span>
              </div>
            </div>

            {/* Real-Time Crop-Row Video Stream Component (Device Camera + WebRTC + CameraX WebSocket) */}
            <RealTimeCameraStream
              simCanvasRef={camCanvasRef}
              rowWidthM={rowWidthCm / 100}
              stanleyGain={stanleyGain}
              speedLimit={speedLimit}
              simRowEndConf={telemetry.rowEndConf}
              simBoundaryOk={telemetry.boundaryOk}
              simAlignment={simAlignmentWithLabel}
              onAlignmentChange={handleLiveAlignmentChange}
              onStreamModeChange={setStreamMode}
              onLogEvent={onLogEvent}
              externalAction={streamAction}
            />
          </div>

          {/* 4-Column Tabular KPI Strip */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white border border-emerald-900/10 rounded-lg p-4">
              <div className="text-xs text-slate-500">Navigation State Machine</div>
              <div
                className={`text-base font-mono font-semibold mt-1 truncate ${
                  telemetry.phase === 'FAULT' || telemetry.phase === 'ESTOP_HALTED'
                    ? 'text-rose-700'
                    : telemetry.phase === 'OBSTACLE_HOLD'
                    ? 'text-amber-700'
                    : 'text-emerald-700'
                }`}
              >
                {telemetry.phase}
              </div>
              <div className="text-xs font-mono text-slate-500 mt-1 tabular-nums">
                Row {telemetry.currentRow} of {NUM_ROWS} · Single ESP32 Bus
              </div>
            </div>

            <div className="bg-white border border-emerald-900/10 rounded-lg p-4">
              <div className="text-xs text-slate-500">Fused vs Raw Odom Drift</div>
              <div className="flex items-baseline gap-1.5 mt-1">
                <span className="text-2xl font-mono font-semibold tabular-nums text-emerald-700">
                  {telemetry.ekfDriftCm.toFixed(1)}
                </span>
                <span className="text-xs font-mono text-slate-500">cm</span>
              </div>
              <div className="text-xs font-mono tabular-nums text-amber-700 mt-1">
                Raw Wheel Odom: {telemetry.rawOdomDriftCm.toFixed(1)} cm
              </div>
            </div>

            <div className="bg-white border border-emerald-900/10 rounded-lg p-4">
              <div className="text-xs text-slate-500">Obstacle Sensor (NAV-05/09)</div>
              <div
                className={`text-base font-mono font-semibold mt-1 ${
                  telemetry.collisionState === 'SENSOR_FAULT' || telemetry.collisionState === 'STOP'
                    ? 'text-rose-700'
                    : telemetry.collisionState === 'SLOWDOWN'
                    ? 'text-amber-700'
                    : 'text-emerald-700'
                }`}
              >
                {telemetry.collisionState === 'SENSOR_FAULT'
                  ? '✖ SENSOR_FAULT (-1)'
                  : telemetry.collisionState === 'STOP'
                  ? '■ OBSTACLE_HOLD'
                  : telemetry.collisionState === 'SLOWDOWN'
                  ? '▲ SLOWDOWN (45%)'
                  : '● CLEAR'}
              </div>
              <div className="text-xs font-mono text-slate-500 mt-1">
                VL53L0X + LiDAR · Zero Auto-Dodge
              </div>
            </div>

            <div className="bg-white border border-emerald-900/10 rounded-lg p-4">
              <div className="text-xs text-slate-500">Verified Coverage (NAV-11)</div>
              <div className="flex items-baseline gap-1.5 mt-1">
                <span className="text-2xl font-mono font-semibold tabular-nums text-slate-900">
                  {telemetry.coveragePct.toFixed(1)}
                </span>
                <span className="text-xs font-mono text-slate-500">%</span>
              </div>
              <div className="text-xs font-mono text-slate-500 mt-1 tabular-nums">
                Rows Complete: {telemetry.completedRows}/{NUM_ROWS} ·{' '}
                {missionMode === 'nav_only'
                  ? 'Treatment Off'
                  : `Hook ${telemetry.hooksServiced}/${telemetry.totalHooks}`}
              </div>
            </div>
          </div>

          {/* Bottom Time-Series Telemetry Chart */}
          <div className="bg-white border border-emerald-900/10 rounded-lg p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Localization Drift &amp; Row-Tracking Error (cm)
                </h3>
                <p className="text-xs text-slate-500">
                  Compares uncorrected raw wheel odometry drift against Encoder+IMU fusion and visual row centerline error.
                </p>
              </div>
              <div className="flex items-center gap-4 text-xs font-mono text-slate-600">
                <span className="text-emerald-700 font-medium">— Centerline |e_y|</span>
                <span className="text-teal-600">— Fused Drift</span>
                <span className="text-amber-600">-- Raw Wheel Drift</span>
              </div>
            </div>
            <div className="h-44 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={history} margin={{ top: 4, right: 12, left: -16, bottom: 0 }}>
                  <CartesianGrid stroke="#E2ECE6" strokeDasharray="3 3" />
                  <XAxis dataKey="t" stroke="#64748B" fontSize={11} tickLine={false} />
                  <YAxis stroke="#64748B" fontSize={11} tickLine={false} unit="cm" />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#FFFFFF',
                      borderColor: '#CBD5E1',
                      borderRadius: '6px',
                      fontSize: '12px',
                      fontFamily: 'IBM Plex Mono, monospace',
                      color: '#0F172A',
                    }}
                  />
                  <Line type="monotone" dataKey="latErrorCm" name="Centerline |e_y|" stroke="#059669" strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="ekfDriftCm" name="Fused Drift" stroke="#0D9488" strokeWidth={2} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="rawOdomDriftCm" name="Raw Wheel Drift" stroke="#D97706" strokeWidth={1.75} strokeDasharray="4 4" dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Headland Turn-Completion Accuracy Telemetry Dashboard (IMU vs. Calculated Trajectory) */}
          <TurnAccuracyDashboard
            liveTurn={liveTurnTelemetry}
            samples={turnSamples}
            completedTurns={completedTurns}
            onTestHeadlandTurn={handleJumpToRowEndTest}
            disabled={estopActive || isFaulted}
          />
        </div>
      </div>
    </div>
  );
};

// ─── Canvas Renderers (White + Botanical Green Light Theme) ───────────────────

function drawFieldCanvas(
  canvas: HTMLCanvasElement | null,
  s: any,
  p: { rowWidthM: number; obstacles: Obstacle[]; missionMode: string }
) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;
  const rw = p.rowWidthM;
  const worldW = ROW_END_X + 1.2;
  const worldH = 1.8 + (NUM_ROWS - 1) * rw;

  const toX = (xm: number) => (xm / worldW) * W;
  const toY = (ym: number) => (ym / worldH) * H;
  const scaleX = W / worldW;

  // Crisp agronomic white-sage map canvas
  ctx.fillStyle = '#F8FBF9';
  ctx.fillRect(0, 0, W, H);

  // Metric grid
  ctx.strokeStyle = '#E5EFE9';
  ctx.lineWidth = 1;
  for (let gx = 0; gx <= worldW; gx += 1) {
    ctx.beginPath();
    ctx.moveTo(toX(gx), 0);
    ctx.lineTo(toX(gx), H);
    ctx.stroke();
  }
  for (let gy = 0; gy <= worldH; gy += 0.6) {
    ctx.beginPath();
    ctx.moveTo(0, toY(gy));
    ctx.lineTo(W, toY(gy));
    ctx.stroke();
  }

  // NAV-08 Inset Field Boundary Polygon Safety Margin
  const marginM = 0.28;
  ctx.strokeStyle = 'rgba(5, 150, 105, 0.55)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.strokeRect(
    toX(marginM),
    toY(marginM),
    toX(worldW - marginM) - toX(marginM),
    toY(worldH - marginM) - toY(marginM)
  );
  ctx.setLineDash([]);

  // Headland boundaries
  ctx.strokeStyle = '#CBD5E1';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(toX(ROW_START_X), toY(marginM));
  ctx.lineTo(toX(ROW_START_X), toY(worldH - marginM));
  ctx.moveTo(toX(ROW_END_X), toY(marginM));
  ctx.lineTo(toX(ROW_END_X), toY(worldH - marginM));
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#64748B';
  ctx.font = '10px "IBM Plex Mono", monospace';
  ctx.fillText('WEST HEADLAND', toX(marginM) + 6, toY(marginM) + 12);
  ctx.fillText('BOUNDARY GUARD MARGIN (NAV-08)', toX(ROW_START_X) + 8, toY(marginM) + 12);
  ctx.fillText('EAST HEADLAND', toX(ROW_END_X) + 8, toY(marginM) + 12);

  // Crop ridges
  for (let r = 0; r <= NUM_ROWS; r++) {
    const ridgeY = 0.9 + (r - 0.5) * rw;
    const py = toY(ridgeY);
    ctx.fillStyle = 'rgba(22, 163, 74, 0.14)';
    ctx.fillRect(toX(ROW_START_X), py - 9, toX(ROW_END_X) - toX(ROW_START_X), 18);

    for (let cx = ROW_START_X + 0.18; cx < ROW_END_X - 0.1; cx += 0.36) {
      ctx.beginPath();
      ctx.arc(toX(cx), py, 5.2, 0, Math.PI * 2);
      ctx.fillStyle = '#16A34A';
      ctx.fill();
      ctx.strokeStyle = '#15803D';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // Row centerlines & per-row verified coverage
  for (let r = 0; r < NUM_ROWS; r++) {
    const cy = rowCenterY(r, rw);
    ctx.strokeStyle = r === s.rowIdx ? 'rgba(5, 150, 105, 0.55)' : 'rgba(148, 163, 184, 0.45)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(toX(ROW_START_X), toY(cy));
    ctx.lineTo(toX(ROW_END_X), toY(cy));
    ctx.stroke();
    ctx.setLineDash([]);

    const pct = Math.round((s.rowProgress[r] || 0) * 100);
    ctx.fillStyle = r === s.rowIdx ? '#047857' : pct >= 95 ? '#15803D' : '#64748B';
    ctx.font = '600 10px "IBM Plex Mono", monospace';
    ctx.fillText(`ROW ${r + 1} (${pct}%)`, toX(ROW_START_X) + 6, toY(cy) - 5);
  }

  // Modular Treatment Hook stations
  if (p.missionMode === 'treatment_hook') {
    for (const t of s.targets as HookTarget[]) {
      ctx.beginPath();
      ctx.arc(toX(t.x), toY(t.y), t.serviced ? 3.5 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = t.serviced ? '#CBD5E1' : '#D97706';
      ctx.fill();
    }
  }

  // Raw wheel odometry path
  if (s.rawPath.length > 1) {
    ctx.strokeStyle = 'rgba(217, 119, 6, 0.72)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    s.rawPath.forEach((pt: { x: number; y: number }, i: number) => {
      if (i === 0) ctx.moveTo(toX(pt.x), toY(pt.y));
      else ctx.lineTo(toX(pt.x), toY(pt.y));
    });
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Fused localization trajectory
  if (s.ekfPath.length > 1) {
    ctx.strokeStyle = '#059669';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    s.ekfPath.forEach((pt: { x: number; y: number }, i: number) => {
      if (i === 0) ctx.moveTo(toX(pt.x), toY(pt.y));
      else ctx.lineTo(toX(pt.x), toY(pt.y));
    });
    ctx.stroke();
  }

  // Headland U-turn waypoints
  if (s.phase === 'NAV2_HEADLAND_TURN' && s.turnWaypoints.length > 0) {
    ctx.strokeStyle = '#0D9488';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(toX(s.x), toY(s.y));
    for (let i = s.turnWpIdx; i < s.turnWaypoints.length; i++) {
      ctx.lineTo(toX(s.turnWaypoints[i].x), toY(s.turnWaypoints[i].y));
    }
    ctx.stroke();
    s.turnWaypoints.forEach((wp: { x: number; y: number }) => {
      ctx.beginPath();
      ctx.arc(toX(wp.x), toY(wp.y), 4, 0, Math.PI * 2);
      ctx.fillStyle = '#0D9488';
      ctx.fill();
    });
  }

  // Obstacles
  for (const obs of p.obstacles) {
    ctx.beginPath();
    ctx.arc(toX(obs.x), toY(obs.y), obs.r * scaleX, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(225, 29, 72, 0.18)';
    ctx.fill();
    ctx.strokeStyle = '#E11D48';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // 2D LiDAR rays
  const rx = toX(s.x);
  const ry = toY(s.y);
  for (let i = 0; i < 36; i++) {
    const ang = s.yaw + (i / 36) * Math.PI * 2;
    let maxR = 1.15;
    for (const obs of p.obstacles) {
      const dx = obs.x - s.x;
      const dy = obs.y - s.y;
      const proj = dx * Math.cos(ang) + dy * Math.sin(ang);
      if (proj > 0 && proj < maxR) {
        const perp = Math.abs(-dx * Math.sin(ang) + dy * Math.cos(ang));
        if (perp < obs.r) maxR = Math.max(0.15, proj - obs.r);
      }
    }
    ctx.strokeStyle = maxR < 0.7 ? 'rgba(225, 29, 72, 0.55)' : 'rgba(5, 150, 105, 0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(rx, ry);
    ctx.lineTo(toX(s.x + Math.cos(ang) * maxR), toY(s.y + Math.sin(ang) * maxR));
    ctx.stroke();
  }

  // Rover chassis + Hold polygons
  ctx.save();
  ctx.translate(rx, ry);
  ctx.rotate(s.yaw);

  ctx.strokeStyle = s.collisionState === 'SLOWDOWN' ? 'rgba(217, 119, 6, 0.9)' : 'rgba(217, 119, 6, 0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(-0.22 * scaleX, -0.22 * scaleX, 0.87 * scaleX, 0.44 * scaleX);

  ctx.strokeStyle =
    s.collisionState === 'STOP' || s.collisionState === 'SENSOR_FAULT'
      ? 'rgba(225, 29, 72, 0.95)'
      : 'rgba(225, 29, 72, 0.4)';
  ctx.strokeRect(-0.18 * scaleX, -0.14 * scaleX, 0.48 * scaleX, 0.28 * scaleX);

  const bodyL = 26;
  const bodyW = 16;
  ctx.fillStyle = '#334155';
  ctx.fillRect(-bodyL / 2 + 2, -bodyW / 2 - 4, 8, 4);
  ctx.fillRect(bodyL / 2 - 10, -bodyW / 2 - 4, 8, 4);
  ctx.fillRect(-bodyL / 2 + 2, bodyW / 2, 8, 4);
  ctx.fillRect(bodyL / 2 - 10, bodyW / 2, 8, 4);

  ctx.fillStyle = '#FFFFFF';
  ctx.strokeStyle = '#047857';
  ctx.lineWidth = 2;
  ctx.fillRect(-bodyL / 2, -bodyW / 2, bodyL, bodyW);
  ctx.strokeRect(-bodyL / 2, -bodyW / 2, bodyL, bodyW);

  // Forward nav camera FOV cone
  ctx.fillStyle = 'rgba(16, 185, 129, 0.16)';
  ctx.beginPath();
  ctx.moveTo(bodyL / 2, 0);
  ctx.lineTo(bodyL / 2 + 46, -24);
  ctx.lineTo(bodyL / 2 + 46, 24);
  ctx.closePath();
  ctx.fill();

  if (s.phase === 'TREATMENT_HOOK_HOLD') {
    ctx.beginPath();
    ctx.arc(0, 0, 7, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(217, 119, 6, 0.75)';
    ctx.fill();
  }

  ctx.restore();
}

function drawForwardCamCanvas(
  canvas: HTMLCanvasElement | null,
  s: any,
  p: { rowWidthM: number }
) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const W = canvas.width;
  const H = canvas.height;
  const horizonY = Math.round(H * 0.28);

  // Clean daylight headland sky + natural field soil plane
  ctx.fillStyle = '#E8F3EC';
  ctx.fillRect(0, 0, W, horizonY);

  ctx.fillStyle = '#2B251F';
  ctx.fillRect(0, horizonY, W, H - horizonY);

  const inRow = s.phase === 'FOLLOW_CROP_ROW' || s.phase === 'TREATMENT_HOOK_HOLD' || s.phase === 'OBSTACLE_HOLD';
  const latPx = Math.max(-90, Math.min(90, s.latErrM * 360));
  const yawPx = Math.max(-75, Math.min(75, -s.headErrRad * 180));

  const vanishX = W / 2 + yawPx;
  const botCenterX = W / 2 + latPx;
  const halfSpanBot = 108 * (p.rowWidthM / 0.6);
  const halfSpanTop = 18;
  const farCutoffY = horizonY + Math.round(s.rowEndConf * (H - horizonY) * 0.72);

  if (inRow && farCutoffY < H - 15) {
    const drawCropBand = (side: -1 | 1) => {
      const t = (farCutoffY - horizonY) / (H - horizonY);
      const topX = vanishX + (botCenterX - vanishX) * t + side * (halfSpanTop + (halfSpanBot - halfSpanTop) * t);
      const botX = botCenterX + side * halfSpanBot;

      ctx.beginPath();
      ctx.moveTo(topX - 10, farCutoffY);
      ctx.lineTo(topX + 10, farCutoffY);
      ctx.lineTo(botX + 26, H);
      ctx.lineTo(botX - 26, H);
      ctx.closePath();
      ctx.fillStyle = 'rgba(34, 197, 94, 0.36)';
      ctx.fill();
      ctx.strokeStyle = '#22C55E';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      for (let i = 1; i <= 5; i++) {
        const sf = i / 6;
        const sy = farCutoffY + (H - farCutoffY) * sf;
        const sx = topX + (botX - topX) * sf;
        ctx.beginPath();
        ctx.arc(sx, sy, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = '#4ADE80';
        ctx.fill();
      }
    };

    drawCropBand(-1);
    drawCropBand(1);

    const t = (farCutoffY - horizonY) / (H - horizonY);
    const centerTopX = vanishX + (botCenterX - vanishX) * t;
    ctx.strokeStyle = '#34D399';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(centerTopX, farCutoffY);
    ctx.lineTo(botCenterX, H);
    ctx.stroke();

    ctx.strokeStyle = '#F59E0B';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(W / 2, H - 22);
    ctx.lineTo(botCenterX, H - 22);
    ctx.stroke();

    // Furrow-end distance horizon line & ground-projected distance label
    if (typeof s.distToFurrowEndM === 'number' && s.distToFurrowEndM < 2.2) {
      ctx.strokeStyle = s.distToFurrowEndM <= 0.6 ? '#F59E0B' : '#34D399';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.moveTo(0, farCutoffY);
      ctx.lineTo(W, farCutoffY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = s.distToFurrowEndM <= 0.6 ? 'rgba(217, 119, 6, 0.9)' : 'rgba(5, 150, 105, 0.85)';
      ctx.fillRect(W - 122, farCutoffY - 14, 116, 13);
      ctx.fillStyle = '#FFFFFF';
      ctx.font = '600 9px "IBM Plex Mono", monospace';
      ctx.fillText(`FURROW END ${s.distToFurrowEndM.toFixed(2)}m`, W - 118, farCutoffY - 5);
    }
  } else {
    ctx.fillStyle = '#E2E8F0';
    ctx.font = '11px "IBM Plex Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(
      s.phase === 'NAV2_HEADLAND_TURN'
        ? 'HEADLAND U-TURN (NAV2 ACTIVE)'
        : s.phase === 'FAULT'
        ? 'FAULT HALT — AWAITING RECOVERY'
        : 'ROW END — OPEN HEADLAND DETECTED',
      W / 2,
      H * 0.62
    );
    ctx.textAlign = 'left';
  }

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(0, horizonY);
  ctx.lineTo(W, horizonY);
  ctx.moveTo(0, horizonY + (H - horizonY) * 0.35);
  ctx.lineTo(W, horizonY + (H - horizonY) * 0.35);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  ctx.beginPath();
  ctx.moveTo(W / 2, horizonY);
  ctx.lineTo(W / 2, H);
  ctx.stroke();

  ctx.fillStyle = '#334155';
  ctx.font = '10px "IBM Plex Mono", monospace';
  ctx.fillText('/nav_camera/image_raw · 25° pitch', 8, 16);
  ctx.fillStyle = '#E2E8F0';
  ctx.fillText('FAR ROI (ROW-END)', 8, horizonY + 14);
}
