import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Compass,
  Copy,
  Cpu,
  Download,
  Flame,
  GitBranch,
  OctagonAlert,
  Radio,
  RotateCcw,
  RotateCw,
  Search,
  ShieldAlert,
  Sliders,
  Square,
  Wrench,
  Zap,
} from 'lucide-react';
import {
  CornerCalibrationThresholds,
  DEFAULT_CORNER_THRESHOLDS,
  SimplaBotCornerCalibration,
} from './SimplaBotCornerCalibration';

interface SimplaBotViewProps {
  estopActive: boolean;
  onLogEvent: (msg: string) => void;
}

type SensorSource = 'sim' | 'live_ws';
type WiringOption = 'gpio' | 'serial';
type CornerType =
  | 'NONE'
  | 'OBSTACLE_STOP'
  | 'LEFT_CORNER'
  | 'RIGHT_CORNER'
  | 'T_JUNCTION_LEFT'
  | 'T_JUNCTION_RIGHT'
  | 'DEAD_END'
  | 'ROW_END_HEADLAND';
type TurnAction = 'NONE' | 'HALT' | 'LEFT' | 'RIGHT' | 'UTURN';

interface MaixSenseTelemetryState {
  connected: boolean;
  ip: string;
  ipSource: string;
  frameId: number;
  fps: number;
  latencyMs: number;
  lastFrameAt: number;
  stale: boolean;
  hasLeftRight: boolean;
}

interface CommandRecord {
  id: number;
  ts: string;
  wire: string;
  ack: string;
  ok: boolean;
  detail: string;
}

const CAMERA_HEIGHT_MM = 420;
const CAMERA_PITCH_DEG = 28;
const MAX_FLAME_CAP_S = 2.5;
const FLAME_COOLDOWN_MS = 3000;
const SETTLE_BEFORE_FIRE_MS = 450;
const STALE_FRAME_WATCHDOG_MS = 1000;
const SPEED_MM_PER_SEC_AT_100 = 520;
const TURN_90_SEC_AT_50 = 1.35;

const PI_PINOUT = [
  { fn: 'Left Motor PWM', pin: 'GPIO 12', hdr: 'Pin 32', target: 'L298N ENA (or BTS7960 EN)' },
  { fn: 'Left Dir A / Dir B', pin: 'GPIO 5 / 6', hdr: 'Pin 29 / 31', target: 'L298N IN1 / IN2' },
  { fn: 'Right Motor PWM', pin: 'GPIO 13', hdr: 'Pin 33', target: 'L298N ENB' },
  { fn: 'Right Dir A / Dir B', pin: 'GPIO 20 / 21', hdr: 'Pin 38 / 40', target: 'L298N IN3 / IN4' },
  { fn: 'Grinder Relay (CH1)', pin: 'GPIO 17', hdr: 'Pin 11', target: '2-Ch Relay IN1 (Active-LOW)' },
  { fn: 'Flame Relay (CH2)', pin: 'GPIO 27', hdr: 'Pin 13', target: '2-Ch Relay IN2 (Active-LOW)' },
  { fn: 'Hardware E-Stop (NC)', pin: 'GPIO 22', hdr: 'Pin 15', target: 'NC Mushroom Switch -> GND' },
  { fn: 'Common Ground', pin: 'GND', hdr: 'Pin 6 / 9', target: 'Motor Driver + Relay + Battery -' },
];

const ARDUINO_PINOUT = [
  { fn: 'Left Motor PWM / IN1 / IN2', pin: 'D5 / D7 / D8', hdr: 'PWM + Dig', target: 'L298N ENA / IN1 / IN2' },
  { fn: 'Right Motor PWM / IN3 / IN4', pin: 'D6 / D9 / D10', hdr: 'PWM + Dig', target: 'L298N ENB / IN3 / IN4' },
  { fn: 'Grinder Relay (CH1)', pin: 'D3', hdr: 'Digital', target: '2-Ch Relay IN1 (Active-LOW)' },
  { fn: 'Flame Relay (CH2)', pin: 'D4', hdr: 'Digital', target: '2-Ch Relay IN2 (Active-LOW)' },
  { fn: 'Hardware E-Stop (NC)', pin: 'D2', hdr: 'INPUT_PULLUP', target: 'NC Mushroom Switch -> GND' },
  { fn: 'USB Link to Pi', pin: 'USB Serial', hdr: '115200 baud', target: '800ms Watchdog + 2.5s Flame Cap' },
];

export const SimplaBotView: React.FC<SimplaBotViewProps> = ({ estopActive, onLogEvent }) => {
  // --- 1. MaixSense-A075V Sensor Feedback State ---
  const [sensorSource, setSensorSource] = useState<SensorSource>('sim');
  const [wsRoom, setWsRoom] = useState<string>('rover-01');
  const [liveTelemetry, setLiveTelemetry] = useState<MaixSenseTelemetryState>({
    connected: false,
    ip: '192.168.233.1',
    ipSource: 'Default MaixSense-A075V IP',
    frameId: 0,
    fps: 0,
    latencyMs: 0,
    lastFrameAt: 0,
    stale: false,
    hasLeftRight: false,
  });
  const [discovering, setDiscovering] = useState<boolean>(false);

  // Depth zones (fed either from live WebSocket MaixSense frames or bench sliders)
  const [leftMm, setLeftMm] = useState<number>(820);
  const [centerMm, setCenterMm] = useState<number>(1380);
  const [rightMm, setRightMm] = useState<number>(880);
  const [minCenterMm, setMinCenterMm] = useState<number>(1320);

  // Weed RGB+ToF alignment inputs
  const [weedDetected, setWeedDetected] = useState<boolean>(true);
  const [weedSlantMm, setWeedSlantMm] = useState<number>(720);
  const [toolOffsetMm, setToolOffsetMm] = useState<number>(-120);

  // Sub-module switcher: Command Console vs. Real-Time Corner Calibration Lab
  const [activeSubModule, setActiveSubModule] = useState<'console' | 'calibration'>('console');
  const [injectedSampleSeq, setInjectedSampleSeq] = useState<number>(0);

  // Corner detection thresholds (matching simpla_bot/config.yaml, shared with Corner Calibration)
  const [cornerStopMm, setCornerStopMm] = useState<number>(DEFAULT_CORNER_THRESHOLDS.cornerStopMm);
  const [obstacleStopMm, setObstacleStopMm] = useState<number>(
    DEFAULT_CORNER_THRESHOLDS.obstacleStopMm
  );
  const [cornerOpenSideMm, setCornerOpenSideMm] = useState<number>(
    DEFAULT_CORNER_THRESHOLDS.cornerOpenSideMm
  );
  const [sideAsymmetryMm, setSideAsymmetryMm] = useState<number>(
    DEFAULT_CORNER_THRESHOLDS.sideAsymmetryMm
  );
  const [headlandOpenMm, setHeadlandOpenMm] = useState<number>(
    DEFAULT_CORNER_THRESHOLDS.headlandOpenMm
  );
  const [confirmFramesRequired, setConfirmFramesRequired] = useState<number>(
    DEFAULT_CORNER_THRESHOLDS.confirmFramesRequired
  );
  const [autoRespondCorners, setAutoRespondCorners] = useState<boolean>(false);

  const cornerThresholds: CornerCalibrationThresholds = useMemo(
    () => ({
      cornerStopMm,
      obstacleStopMm,
      cornerOpenSideMm,
      sideAsymmetryMm,
      headlandOpenMm,
      confirmFramesRequired,
    }),
    [
      cornerStopMm,
      obstacleStopMm,
      cornerOpenSideMm,
      sideAsymmetryMm,
      headlandOpenMm,
      confirmFramesRequired,
    ]
  );

  const handleUpdateThresholds = useCallback((next: CornerCalibrationThresholds) => {
    setCornerStopMm(next.cornerStopMm);
    setObstacleStopMm(next.obstacleStopMm);
    setCornerOpenSideMm(next.cornerOpenSideMm);
    setSideAsymmetryMm(next.sideAsymmetryMm);
    setHeadlandOpenMm(next.headlandOpenMm);
    setConfirmFramesRequired(next.confirmFramesRequired);
  }, []);

  const handleInjectCalibrationSample = useCallback(
    (sample: { leftMm: number; centerMm: number; minCenterMm: number; rightMm: number }) => {
      setLeftMm(sample.leftMm);
      setCenterMm(sample.centerMm);
      setMinCenterMm(sample.minCenterMm);
      setRightMm(sample.rightMm);
      setInjectedSampleSeq((s) => s + 1);
    },
    []
  );

  // Temporal corner confirmation / debounce state
  const [confirmedCorner, setConfirmedCorner] = useState<CornerType>('NONE');
  const [confirmStreak, setConfirmStreak] = useState<number>(0);
  const streakRef = useRef<{ candidate: CornerType; count: number }>({
    candidate: 'NONE',
    count: 0,
  });
  const lastAutoTurnRef = useRef<number>(0);
  const staleHaltedRef = useRef<boolean>(false);

  // --- 2. Motor Driver, Grinder (CH1) & Flame (CH2) Command State ---
  const [leftPwm, setLeftPwm] = useState<number>(0);
  const [rightPwm, setRightPwm] = useState<number>(0);
  const [driveSpeedPct, setDriveSpeedPct] = useState<number>(45);
  const [activeMotionLabel, setActiveMotionLabel] = useState<string>('STOPPED');
  const [lastStoppedAtMs, setLastStoppedAtMs] = useState<number>(Date.now() - 2000);

  const [dryRun, setDryRun] = useState<boolean>(true);
  const [safetyChecklistAck, setSafetyChecklistAck] = useState<boolean>(false);
  const [grinderOn, setGrinderOn] = useState<boolean>(false);
  const [flameOn, setFlameOn] = useState<boolean>(false);
  const [grinderDurationS, setGrinderDurationS] = useState<number>(2.0);
  const [flameDurationS, setFlameDurationS] = useState<number>(1.2);
  const [lastFlameEndMs, setLastFlameEndMs] = useState<number>(0);
  const [activeToolProgress, setActiveToolProgress] = useState<{
    tool: 'grinder' | 'flame' | null;
    remainingMs: number;
    totalMs: number;
  }>({ tool: null, remainingMs: 0, totalMs: 0 });
  const [nowMs, setNowMs] = useState<number>(Date.now());

  const [commandHistory, setCommandHistory] = useState<CommandRecord[]>([]);
  const [wiringTab, setWiringTab] = useState<WiringOption>('gpio');
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  const motionTimerRef = useRef<number | null>(null);
  const toolTimerRef = useRef<number | null>(null);
  const comboTimerRef = useRef<number | null>(null);
  const cmdSeqRef = useRef<number>(1);
  const estopRef = useRef<boolean>(estopActive);
  estopRef.current = estopActive;

  // Periodic 100ms UI clock for settle timer, flame cooldown bar, and live MaixSense watchdog
  useEffect(() => {
    const id = window.setInterval(() => {
      setNowMs(Date.now());
    }, 100);
    return () => window.clearInterval(id);
  }, []);

  const clearScheduledTimers = useCallback(() => {
    if (motionTimerRef.current !== null) {
      window.clearTimeout(motionTimerRef.current);
      motionTimerRef.current = null;
    }
    if (toolTimerRef.current !== null) {
      window.clearTimeout(toolTimerRef.current);
      toolTimerRef.current = null;
    }
    if (comboTimerRef.current !== null) {
      window.clearTimeout(comboTimerRef.current);
      comboTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => clearScheduledTimers();
  }, [clearScheduledTimers]);

  // --- Backend Command Dispatcher (POST /api/simpla-bot/command) ---
  const dispatchCommand = useCallback(
    async (
      payload: Record<string, unknown>,
      labelOverride?: string
    ): Promise<{ ok: boolean; wireCommand: string; ack: string }> => {
      try {
        const res = await fetch('/api/simpla-bot/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...payload,
            dryRun,
            estopActive: estopRef.current,
          }),
        });
        const data = await res.json().catch(() => ({}));
        const wire = String(data.wireCommand || 'STOP');
        const ack = String(data.ack || (res.ok ? 'OK' : `HTTP_${res.status}`));
        const ok = Boolean(res.ok && data.ok !== false);
        const detail = labelOverride || String(data.detail || ack);

        if (data.state && typeof data.state === 'object') {
          const st = data.state;
          const prevMoving = leftPwm !== 0 || rightPwm !== 0;
          const nextL = Number(st.leftPct ?? 0);
          const nextR = Number(st.rightPct ?? 0);
          setLeftPwm(nextL);
          setRightPwm(nextR);
          if (prevMoving && nextL === 0 && nextR === 0) {
            setLastStoppedAtMs(Date.now());
          }
          setGrinderOn(Boolean(st.grinderOn));
          setFlameOn(Boolean(st.flameOn));
        }

        const record: CommandRecord = {
          id: cmdSeqRef.current++,
          ts: new Date().toLocaleTimeString(),
          wire,
          ack,
          ok,
          detail,
        };
        setCommandHistory((prev) => [record, ...prev.slice(0, 11)]);
        onLogEvent(`[SimplaBot] TX "${wire}" -> ${ack} (${detail})`);
        return { ok, wireCommand: wire, ack };
      } catch {
        const fallbackWire = payload.kind === 'stop' ? 'STOP' : 'ERR';
        const record: CommandRecord = {
          id: cmdSeqRef.current++,
          ts: new Date().toLocaleTimeString(),
          wire: fallbackWire,
          ack: 'SERVER_UNREACHABLE',
          ok: false,
          detail: labelOverride || 'Command endpoint unreachable',
        };
        setCommandHistory((prev) => [record, ...prev.slice(0, 11)]);
        onLogEvent(`[SimplaBot] Command failed (server unreachable)`);
        return { ok: false, wireCommand: fallbackWire, ack: 'SERVER_UNREACHABLE' };
      }
    },
    [dryRun, leftPwm, rightPwm, onLogEvent]
  );

  // Instant STOP helper
  const sendEmergencyStop = useCallback(
    async (reason: string) => {
      clearScheduledTimers();
      setLeftPwm(0);
      setRightPwm(0);
      setGrinderOn(false);
      setFlameOn(false);
      setActiveMotionLabel('STOPPED');
      setActiveToolProgress({ tool: null, remainingMs: 0, totalMs: 0 });
      setLastStoppedAtMs(Date.now());
      await dispatchCommand({ kind: 'stop' }, reason);
    },
    [clearScheduledTimers, dispatchCommand]
  );

  // Immediately cut motors & tools whenever global Software E-Stop activates
  useEffect(() => {
    if (estopActive) {
      void sendEmergencyStop('Global E-Stop triggered');
    }
  }, [estopActive, sendEmergencyStop]);

  // --- Live MaixSense-A075V WebSocket Subscriber (/ws/camera) ---
  useEffect(() => {
    if (sensorSource !== 'live_ws') {
      setLiveTelemetry((prev) => ({ ...prev, connected: false, stale: false }));
      staleHaltedRef.current = false;
      return;
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws/camera?role=viewer&room=${encodeURIComponent(
      wsRoom
    )}&label=simpla-bot-ui`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setLiveTelemetry((prev) => ({ ...prev, connected: true, stale: false }));
      onLogEvent(`[SimplaBot] Subscribed to live MaixSense telemetry on /ws/camera (room=${wsRoom})`);
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type !== 'maixsense:telemetry') return;

      const c = typeof msg.centerDepthMm === 'number' ? Math.round(msg.centerDepthMm) : null;
      const l = typeof msg.leftDepthMm === 'number' ? Math.round(msg.leftDepthMm) : null;
      const r = typeof msg.rightDepthMm === 'number' ? Math.round(msg.rightDepthMm) : null;
      const m = typeof msg.minDepthMm === 'number' ? Math.round(msg.minDepthMm) : c;

      if (c !== null) setCenterMm(Math.max(180, Math.min(2400, c)));
      if (l !== null) setLeftMm(Math.max(180, Math.min(2400, l)));
      if (r !== null) setRightMm(Math.max(180, Math.min(2400, r)));
      if (m !== null) setMinCenterMm(Math.max(180, Math.min(2400, m)));

      if (typeof msg.weedDetected === 'boolean') {
        setWeedDetected(msg.weedDetected);
      }
      if (typeof msg.weedDepthMm === 'number' && msg.weedDepthMm > 180) {
        setWeedSlantMm(Math.round(msg.weedDepthMm));
      }

      staleHaltedRef.current = false;
      setLiveTelemetry({
        connected: true,
        ip: typeof msg.ip === 'string' && msg.ip ? msg.ip : '192.168.233.1',
        ipSource: typeof msg.ipSource === 'string' && msg.ipSource ? msg.ipSource : 'Live WebSocket',
        frameId: Number(msg.frameId ?? 0),
        fps: Number(msg.fps ?? 0),
        latencyMs: Number(msg.latencyMs ?? 0),
        lastFrameAt: Date.now(),
        stale: false,
        hasLeftRight: l !== null && r !== null,
      });
    };

    ws.onclose = () => {
      setLiveTelemetry((prev) => ({ ...prev, connected: false }));
    };

    ws.onerror = () => {
      setLiveTelemetry((prev) => ({ ...prev, connected: false }));
    };

    return () => {
      ws.close();
    };
  }, [sensorSource, wsRoom, onLogEvent]);

  // 1.0 s MaixSense Stale-Frame Watchdog in Live mode
  useEffect(() => {
    if (sensorSource !== 'live_ws' || liveTelemetry.lastFrameAt === 0) return;
    const age = nowMs - liveTelemetry.lastFrameAt;
    const isStale = age > STALE_FRAME_WATCHDOG_MS;
    if (isStale !== liveTelemetry.stale) {
      setLiveTelemetry((prev) => ({ ...prev, stale: isStale }));
    }
    if (isStale && !staleHaltedRef.current) {
      staleHaltedRef.current = true;
      void sendEmergencyStop(
        `MaixSense stale-frame watchdog (${(age / 1000).toFixed(2)}s > 1.0s)`
      );
    }
  }, [sensorSource, liveTelemetry.lastFrameAt, liveTelemetry.stale, nowMs, sendEmergencyStop]);

  // --- 3. Spatial Corner Detection & Distance-to-Go Computation ---
  const spatial = useMemo(() => {
    const effectiveMinCenter = Math.min(centerMm, minCenterMm);
    const obstacleBlocked = effectiveMinCenter <= obstacleStopMm;
    const recommendedTravelMm = Math.max(0, centerMm - cornerStopMm);

    let rawCorner: CornerType = 'NONE';
    let suggestedTurn: TurnAction = 'NONE';
    let reason = 'Clear forward path';

    if (centerMm <= cornerStopMm) {
      const leftOpen = leftMm >= cornerOpenSideMm;
      const rightOpen = rightMm >= cornerOpenSideMm;

      if (leftOpen && !rightOpen) {
        rawCorner = 'LEFT_CORNER';
        suggestedTurn = 'LEFT';
        reason = `Front wall ${centerMm}mm; LEFT open (${leftMm}mm) -> Pivot -90 deg`;
      } else if (rightOpen && !leftOpen) {
        rawCorner = 'RIGHT_CORNER';
        suggestedTurn = 'RIGHT';
        reason = `Front wall ${centerMm}mm; RIGHT open (${rightMm}mm) -> Pivot +90 deg`;
      } else if (leftOpen && rightOpen) {
        if (rightMm >= leftMm + sideAsymmetryMm) {
          rawCorner = 'T_JUNCTION_RIGHT';
          suggestedTurn = 'RIGHT';
          reason = `T-junction (${centerMm}mm); RIGHT wider (${rightMm} vs ${leftMm}mm)`;
        } else {
          rawCorner = 'T_JUNCTION_LEFT';
          suggestedTurn = 'LEFT';
          reason = `T-junction (${centerMm}mm); LEFT preferred (${leftMm} vs ${rightMm}mm)`;
        }
      } else {
        rawCorner = 'DEAD_END';
        suggestedTurn = 'UTURN';
        reason = `All 3 zones blocked (L=${leftMm}, C=${centerMm}, R=${rightMm}mm) -> 180 deg U-Turn`;
      }
    } else if (obstacleBlocked) {
      rawCorner = 'OBSTACLE_STOP';
      suggestedTurn = 'HALT';
      reason = `Narrow obstacle at ${effectiveMinCenter}mm <= ${obstacleStopMm}mm -> Immediate HALT`;
    } else if (
      centerMm >= headlandOpenMm &&
      leftMm >= headlandOpenMm &&
      rightMm >= headlandOpenMm
    ) {
      rawCorner = 'ROW_END_HEADLAND';
      suggestedTurn = 'UTURN';
      reason = `Open headland across all zones (>= ${headlandOpenMm}mm) -> Row-end U-Turn`;
    }

    const steerAdjustPct =
      rawCorner !== 'NONE'
        ? 0
        : Number(Math.max(-18, Math.min(18, (rightMm - leftMm) * 0.04)).toFixed(1));

    const recommendedLeftPwm =
      rawCorner !== 'NONE'
        ? 0
        : Math.max(-100, Math.min(100, Math.round(driveSpeedPct + steerAdjustPct)));
    const recommendedRightPwm =
      rawCorner !== 'NONE'
        ? 0
        : Math.max(-100, Math.min(100, Math.round(driveSpeedPct - steerAdjustPct)));

    // Weed-to-tool horizontal ground projection
    const pitchRad = (CAMERA_PITCH_DEG * Math.PI) / 180;
    const horizPitch = weedSlantMm * Math.cos(pitchRad);
    const forwardFromCamMm =
      weedSlantMm > CAMERA_HEIGHT_MM
        ? 0.5 *
          (horizPitch +
            Math.sqrt(Math.max(0, weedSlantMm * weedSlantMm - CAMERA_HEIGHT_MM * CAMERA_HEIGHT_MM)))
        : Math.max(0, horizPitch);
    const dxToToolMm = Math.round(forwardFromCamMm - toolOffsetMm);

    return {
      effectiveMinCenter,
      obstacleBlocked,
      recommendedTravelMm: Math.round(recommendedTravelMm),
      rawCorner,
      suggestedTurn,
      reason,
      steerAdjustPct,
      recommendedLeftPwm,
      recommendedRightPwm,
      forwardFromCamMm: Math.round(forwardFromCamMm),
      dxToToolMm,
    };
  }, [
    leftMm,
    centerMm,
    rightMm,
    minCenterMm,
    cornerStopMm,
    obstacleStopMm,
    cornerOpenSideMm,
    sideAsymmetryMm,
    headlandOpenMm,
    driveSpeedPct,
    weedSlantMm,
    toolOffsetMm,
  ]);

  // Multi-frame temporal debounce filter (prevents single-frame ToF false corners)
  const sampleFrameKey =
    sensorSource === 'live_ws'
      ? `ws:${liveTelemetry.frameId}`
      : injectedSampleSeq > 0
      ? `inj:${injectedSampleSeq}:${spatial.rawCorner}`
      : `sim:${leftMm}:${centerMm}:${rightMm}:${minCenterMm}:${spatial.rawCorner}`;

  useEffect(() => {
    const cand = spatial.rawCorner;
    // Hard obstacles bypass debounce for immediate safety
    if (cand === 'OBSTACLE_STOP') {
      streakRef.current = { candidate: cand, count: confirmFramesRequired };
      setConfirmStreak(confirmFramesRequired);
      setConfirmedCorner('OBSTACLE_STOP');
      return;
    }

    if (cand === 'NONE') {
      streakRef.current = { candidate: 'NONE', count: 0 };
      setConfirmStreak(0);
      setConfirmedCorner('NONE');
      return;
    }

    // Live WebSocket frames and calibration sweep/noise-spike frames step +1 per frame
    // so operators can verify debounce immunity; direct bench preset clicks confirm immediately.
    const stepOneFrame = sensorSource === 'live_ws' || activeSubModule === 'calibration';
    const increment = stepOneFrame ? 1 : confirmFramesRequired;
    if (streakRef.current.candidate === cand) {
      streakRef.current.count = Math.min(confirmFramesRequired, streakRef.current.count + increment);
    } else {
      streakRef.current = { candidate: cand, count: Math.min(confirmFramesRequired, increment) };
    }

    setConfirmStreak(streakRef.current.count);
    if (streakRef.current.count >= confirmFramesRequired) {
      setConfirmedCorner(cand);
    } else {
      setConfirmedCorner('NONE');
    }
  }, [sampleFrameKey, spatial.rawCorner, confirmFramesRequired, sensorSource, activeSubModule]);

  // --- 4. Motor Driver Command Actions ---
  const executeDirectDrive = useCallback(
    async (l: number, r: number, label: string) => {
      clearScheduledTimers();
      setActiveToolProgress({ tool: null, remainingMs: 0, totalMs: 0 });
      setActiveMotionLabel(l === 0 && r === 0 ? 'STOPPED' : label);
      await dispatchCommand({ kind: 'motor', leftPct: l, rightPct: r }, label);
    },
    [clearScheduledTimers, dispatchCommand]
  );

  const executeTimedMoveMm = useCallback(
    async (distanceMm: number, speedPct: number, label: string) => {
      if (estopRef.current) {
        onLogEvent('[SimplaBot] Move blocked: E-Stop active.');
        return;
      }
      if (Math.abs(distanceMm) < 5) {
        onLogEvent('[SimplaBot] Already aligned (< 5mm).');
        return;
      }
      clearScheduledTimers();
      const mmPerSec = SPEED_MM_PER_SEC_AT_100 * (speedPct / 100);
      const durationMs = Math.max(250, Math.min(8000, Math.round((Math.abs(distanceMm) / mmPerSec) * 1000)));
      setActiveMotionLabel(`${label} (${(durationMs / 1000).toFixed(1)}s)`);
      const res = await dispatchCommand(
        { kind: 'move_mm', distanceMm: Math.round(distanceMm), speedPct },
        `${label} (${Math.round(distanceMm)}mm)`
      );
      if (res.ok) {
        motionTimerRef.current = window.setTimeout(() => {
          motionTimerRef.current = null;
          setActiveMotionLabel('STOPPED');
          setLastStoppedAtMs(Date.now());
          void dispatchCommand({ kind: 'stop' }, `Completed ${label}`);
        }, durationMs);
      }
    },
    [clearScheduledTimers, dispatchCommand, onLogEvent]
  );

  const executePivotTurn = useCallback(
    async (angleDeg: number, reason: string) => {
      if (estopRef.current) {
        onLogEvent('[SimplaBot] Turn blocked: E-Stop active.');
        return;
      }
      clearScheduledTimers();
      const speedPct = Math.max(25, Math.min(70, driveSpeedPct));
      const speedScale = 50 / speedPct;
      const durationMs = Math.max(
        350,
        Math.min(6000, Math.round(TURN_90_SEC_AT_50 * (Math.abs(angleDeg) / 90) * speedScale * 1000))
      );
      setActiveMotionLabel(`TURN ${angleDeg > 0 ? '+' : ''}${angleDeg}° (${(durationMs / 1000).toFixed(1)}s)`);
      const res = await dispatchCommand(
        { kind: 'turn_deg', angleDeg, speedPct },
        `${reason} (${angleDeg > 0 ? '+' : ''}${angleDeg} deg)`
      );
      if (res.ok) {
        motionTimerRef.current = window.setTimeout(() => {
          motionTimerRef.current = null;
          setActiveMotionLabel('STOPPED');
          setLastStoppedAtMs(Date.now());
          void dispatchCommand({ kind: 'stop' }, `Completed pivot ${angleDeg}°`);
        }, durationMs);
      }
    },
    [clearScheduledTimers, dispatchCommand, driveSpeedPct, onLogEvent]
  );

  const executeConfirmedCornerAction = useCallback(async () => {
    if (confirmedCorner === 'NONE') return;
    if (confirmedCorner === 'OBSTACLE_STOP') {
      await sendEmergencyStop('MaixSense obstacle within 320mm');
      return;
    }
    if (spatial.suggestedTurn === 'LEFT') {
      await executePivotTurn(-90, `Corner response (${confirmedCorner})`);
    } else if (spatial.suggestedTurn === 'RIGHT') {
      await executePivotTurn(90, `Corner response (${confirmedCorner})`);
    } else if (spatial.suggestedTurn === 'UTURN') {
      await executePivotTurn(180, `Corner/Row-end response (${confirmedCorner})`);
    }
  }, [confirmedCorner, spatial.suggestedTurn, sendEmergencyStop, executePivotTurn]);

  // Optional Auto-Respond to confirmed MaixSense corners / obstacles
  useEffect(() => {
    if (!autoRespondCorners || estopActive || confirmedCorner === 'NONE') return;
    const now = Date.now();
    if (confirmedCorner === 'OBSTACLE_STOP' && (leftPwm !== 0 || rightPwm !== 0)) {
      void sendEmergencyStop('Auto-HALT: MaixSense obstacle');
      return;
    }
    if (now - lastAutoTurnRef.current < 3500) return;
    lastAutoTurnRef.current = now;
    void executeConfirmedCornerAction();
  }, [
    autoRespondCorners,
    estopActive,
    confirmedCorner,
    leftPwm,
    rightPwm,
    sendEmergencyStop,
    executeConfirmedCornerAction,
  ]);

  // --- 5. Grinder (CH1) & Flame (CH2) Safety-Interlocked Command Actions ---
  const isMoving = leftPwm !== 0 || rightPwm !== 0;
  const settleRemainingMs = isMoving
    ? SETTLE_BEFORE_FIRE_MS
    : Math.max(0, SETTLE_BEFORE_FIRE_MS - (nowMs - lastStoppedAtMs));
  const flameCooldownRemainingMs = Math.max(0, FLAME_COOLDOWN_MS - (nowMs - lastFlameEndMs));
  const cappedFlameS = Math.min(MAX_FLAME_CAP_S, Math.max(0.2, flameDurationS));

  const toolsBlockedReason = useMemo(() => {
    if (estopActive) return 'E-Stop active — relays locked OFF';
    if (isMoving) return 'Rover moving (PWM != 0) — stop motors first';
    if (settleRemainingMs > 0)
      return `Chassis settling (${(settleRemainingMs / 1000).toFixed(2)}s remaining)`;
    return null;
  }, [estopActive, isMoving, settleRemainingMs]);

  const runGrinderPulse = useCallback(async () => {
    if (toolsBlockedReason) {
      onLogEvent(`[SimplaBot] Grinder CH1 blocked: ${toolsBlockedReason}`);
      return false;
    }
    clearScheduledTimers();
    const totalMs = Math.round(Math.max(0.5, Math.min(4.0, grinderDurationS)) * 1000);
    const res = await dispatchCommand(
      { kind: 'relay', grinderOn: true, flameOn: false },
      `Grinder CH1 ON (${(totalMs / 1000).toFixed(1)}s)`
    );
    if (!res.ok) return false;

    const endAt = Date.now() + totalMs;
    setActiveToolProgress({ tool: 'grinder', remainingMs: totalMs, totalMs });
    toolTimerRef.current = window.setTimeout(() => {
      toolTimerRef.current = null;
      setActiveToolProgress({ tool: null, remainingMs: 0, totalMs: 0 });
      void dispatchCommand({ kind: 'relay', grinderOn: false, flameOn: false }, 'Grinder CH1 OFF');
    }, totalMs);

    // Update countdown smoothly using the existing 100ms clock
    const tick = () => {
      const rem = Math.max(0, endAt - Date.now());
      if (rem > 0 && toolTimerRef.current !== null) {
        setActiveToolProgress({ tool: 'grinder', remainingMs: rem, totalMs });
        window.setTimeout(tick, 100);
      }
    };
    window.setTimeout(tick, 100);
    return true;
  }, [toolsBlockedReason, clearScheduledTimers, grinderDurationS, dispatchCommand, onLogEvent]);

  const runFlamePulse = useCallback(async () => {
    if (toolsBlockedReason) {
      onLogEvent(`[SimplaBot] Flame CH2 blocked: ${toolsBlockedReason}`);
      return false;
    }
    if (flameCooldownRemainingMs > 0) {
      onLogEvent(
        `[SimplaBot] Flame CH2 blocked: cooldown ${(flameCooldownRemainingMs / 1000).toFixed(1)}s remaining`
      );
      return false;
    }
    clearScheduledTimers();
    const totalMs = Math.round(cappedFlameS * 1000);
    const res = await dispatchCommand(
      { kind: 'relay', grinderOn: false, flameOn: true, flameDurationMs: totalMs },
      `Flame CH2 ON (${(totalMs / 1000).toFixed(1)}s, capped <= 2.5s)`
    );
    if (!res.ok) return false;

    const endAt = Date.now() + totalMs;
    setActiveToolProgress({ tool: 'flame', remainingMs: totalMs, totalMs });
    toolTimerRef.current = window.setTimeout(() => {
      toolTimerRef.current = null;
      setLastFlameEndMs(Date.now());
      setActiveToolProgress({ tool: null, remainingMs: 0, totalMs: 0 });
      void dispatchCommand(
        { kind: 'relay', grinderOn: false, flameOn: false },
        'Flame CH2 OFF (3.0s cooldown started)'
      );
    }, totalMs);

    const tick = () => {
      const rem = Math.max(0, endAt - Date.now());
      if (rem > 0 && toolTimerRef.current !== null) {
        setActiveToolProgress({ tool: 'flame', remainingMs: rem, totalMs });
        window.setTimeout(tick, 100);
      }
    };
    window.setTimeout(tick, 100);
    return true;
  }, [
    toolsBlockedReason,
    flameCooldownRemainingMs,
    clearScheduledTimers,
    cappedFlameS,
    dispatchCommand,
    onLogEvent,
  ]);

  const runGrinderThenFlame = useCallback(async () => {
    if (toolsBlockedReason || flameCooldownRemainingMs > 0) {
      onLogEvent(
        `[SimplaBot] Combo blocked: ${
          toolsBlockedReason || `Flame cooldown ${(flameCooldownRemainingMs / 1000).toFixed(1)}s`
        }`
      );
      return;
    }
    const gMs = Math.round(Math.max(0.5, Math.min(4.0, grinderDurationS)) * 1000);
    const ok = await runGrinderPulse();
    if (!ok) return;
    comboTimerRef.current = window.setTimeout(() => {
      comboTimerRef.current = null;
      if (!estopRef.current) {
        void runFlamePulse();
      }
    }, gMs + 350);
  }, [toolsBlockedReason, flameCooldownRemainingMs, grinderDurationS, runGrinderPulse, runFlamePulse, onLogEvent]);

  const killToolsOnly = useCallback(async () => {
    if (toolTimerRef.current !== null) {
      window.clearTimeout(toolTimerRef.current);
      toolTimerRef.current = null;
    }
    if (comboTimerRef.current !== null) {
      window.clearTimeout(comboTimerRef.current);
      comboTimerRef.current = null;
    }
    if (flameOn) setLastFlameEndMs(Date.now());
    setActiveToolProgress({ tool: null, remainingMs: 0, totalMs: 0 });
    await dispatchCommand({ kind: 'relay', grinderOn: false, flameOn: false }, 'Manual Tool Cutoff (R 0 0)');
  }, [flameOn, dispatchCommand]);

  const discoverMaixsense = async () => {
    setDiscovering(true);
    try {
      const res = await fetch('/api/maixsense/discover');
      const data = await res.json();
      if (res.ok && data.ok) {
        setLiveTelemetry((prev) => ({
          ...prev,
          ip: data.detectedIp || '192.168.233.1',
          ipSource: data.ipSource || 'Default',
        }));
        onLogEvent(
          `[SimplaBot] MaixSense discover: IP=${data.detectedIp} (${data.ipSource}), active WS publishers=${
            Array.isArray(data.activePublishers) ? data.activePublishers.length : 0
          }`
        );
      }
    } catch {
      onLogEvent('[SimplaBot] MaixSense discovery request failed.');
    } finally {
      setDiscovering(false);
    }
  };

  const applyPreset = (
    preset: 'straight' | 'left_corner' | 'right_corner' | 't_junction' | 'dead_end' | 'headland' | 'obstacle'
  ) => {
    setSensorSource('sim');
    if (preset === 'straight') {
      setLeftMm(780);
      setCenterMm(1420);
      setMinCenterMm(1380);
      setRightMm(820);
    } else if (preset === 'left_corner') {
      setLeftMm(1620);
      setCenterMm(460);
      setMinCenterMm(440);
      setRightMm(600);
    } else if (preset === 'right_corner') {
      setLeftMm(590);
      setCenterMm(470);
      setMinCenterMm(450);
      setRightMm(1680);
    } else if (preset === 't_junction') {
      setLeftMm(1350);
      setCenterMm(480);
      setMinCenterMm(460);
      setRightMm(1720);
    } else if (preset === 'dead_end') {
      setLeftMm(540);
      setCenterMm(440);
      setMinCenterMm(420);
      setRightMm(560);
    } else if (preset === 'headland') {
      setLeftMm(2050);
      setCenterMm(2150);
      setMinCenterMm(2080);
      setRightMm(2000);
    } else {
      setLeftMm(920);
      setCenterMm(1120);
      setMinCenterMm(260);
      setRightMm(900);
    }
    onLogEvent(`[SimplaBot] Loaded MaixSense bench scenario: ${preset.toUpperCase()}`);
  };

  const copyCommand = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedCmd(id);
      setTimeout(() => setCopiedCmd(null), 1600);
    } catch {
      onLogEvent(`[SimplaBot] Command: ${text}`);
    }
  };

  // Scale helper for top-down MaixSense 3-zone beam SVG (2400mm -> 145px)
  const scaleDepth = (mm: number) => Math.max(18, Math.min(145, (mm / 2400) * 145));
  const leftBeamLen = scaleDepth(leftMm);
  const centerBeamLen = scaleDepth(centerMm);
  const rightBeamLen = scaleDepth(rightMm);
  const cornerArcR = scaleDepth(cornerStopMm);
  const obstacleArcR = scaleDepth(obstacleStopMm);

  const branchCmd = `bash simpla_bot/setup_simpla_bot_branch.sh\ngit push -u origin simpla_bot`;

  return (
    <div className="space-y-6">
      {/* Top Header & Quick Actions */}
      <section className="bg-white border border-emerald-900/10 rounded-lg p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-emerald-700">
            <GitBranch className="w-4 h-4" />
            <span>BRANCH: simpla_bot</span>
            <span className="text-slate-300">|</span>
            <span>MAIXSENSE-A075V + NORMAL MOTOR DRIVER + FLAME &amp; GRINDER</span>
          </div>
          <h1 className="text-xl font-semibold text-emerald-950">
            Simpla Bot Sensor Feedback &amp; Actuator Command Console
          </h1>
          <p className="text-sm text-slate-600 max-w-3xl">
            Handles live or bench MaixSense-A075V ToF feedback for multi-frame corner detection and
            exact millimeter travel, wired directly to the normal motor driver (L298N/BTS7960/Serial),
            grinding machine (CH1), and flame burner (CH2) command interface.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <a
            href="/SIMPLA_BOT_MANUAL.pdf"
            download="SIMPLA_BOT_MANUAL.pdf"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-emerald-700 hover:bg-emerald-800 text-white text-sm font-medium transition-colors"
          >
            <Download className="w-4 h-4" />
            <span>Manual PDF</span>
          </a>
          <button
            onClick={() => void sendEmergencyStop('Operator STOP button')}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-rose-600 hover:bg-rose-700 text-white text-sm font-semibold cursor-pointer"
          >
            <OctagonAlert className="w-4 h-4" />
            <span>ALL STOP</span>
          </button>
        </div>
      </section>

      {/* Sub-Module Switcher: Command & Control Console vs. Real-Time Corner Calibration */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white border border-emerald-900/10 rounded-lg px-4 py-2.5">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveSubModule('console')}
            className={`px-3.5 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer ${
              activeSubModule === 'console'
                ? 'bg-emerald-700 text-white'
                : 'bg-slate-50 text-slate-700 hover:bg-emerald-50 border border-slate-200'
            }`}
          >
            <Compass className="w-3.5 h-3.5" />
            <span>Command &amp; Control Console</span>
          </button>
          <button
            onClick={() => setActiveSubModule('calibration')}
            className={`px-3.5 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer ${
              activeSubModule === 'calibration'
                ? 'bg-emerald-700 text-white'
                : 'bg-slate-50 text-slate-700 hover:bg-emerald-50 border border-slate-200'
            }`}
          >
            <Sliders className="w-3.5 h-3.5" />
            <span>Corner Calibration Lab</span>
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono text-slate-600">
          <span>
            Corner Stop: <strong className="text-amber-700">{cornerStopMm}mm</strong>
          </span>
          <span>
            Obstacle: <strong className="text-rose-700">{obstacleStopMm}mm</strong>
          </span>
          <span>
            Open Side: <strong className="text-emerald-800">{cornerOpenSideMm}mm</strong>
          </span>
          <span>
            Debounce: <strong className="text-slate-900">{confirmFramesRequired}f</strong>
          </span>
        </div>
      </div>

      {/* Sub-Module 2: Real-Time MaixSense Corner Calibration Visualizer & Sensitivity Tuner */}
      {activeSubModule === 'calibration' && (
        <SimplaBotCornerCalibration
          sensorSource={sensorSource}
          liveConnected={liveTelemetry.connected}
          liveFrameId={liveTelemetry.frameId}
          liveFps={liveTelemetry.fps}
          leftMm={leftMm}
          centerMm={centerMm}
          minCenterMm={minCenterMm}
          rightMm={rightMm}
          rawCorner={spatial.rawCorner}
          confirmedCorner={confirmedCorner}
          confirmStreak={confirmStreak}
          suggestedTurn={spatial.suggestedTurn}
          recommendedTravelMm={spatial.recommendedTravelMm}
          thresholds={cornerThresholds}
          onChangeThresholds={handleUpdateThresholds}
          onInjectSample={handleInjectCalibrationSample}
          onLogEvent={onLogEvent}
        />
      )}

      {/* Sub-Module 1: Main Grid: MaixSense Corner Feedback (Left 7 cols) + Integrated Command Console (Right 5 cols) */}
      {activeSubModule === 'console' && (
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* LEFT COLUMN: MaixSense-A075V Feedback & Corner Detection Engine */}
        <section className="xl:col-span-7 bg-white border border-emerald-900/10 rounded-lg p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Compass className="w-4 h-4 text-emerald-700" />
              <h2 className="text-base font-semibold text-emerald-950">
                1. MaixSense-A075V Feedback &amp; Corner Detector
              </h2>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setSensorSource('sim')}
                className={`px-2.5 py-1 text-xs font-semibold rounded border cursor-pointer ${
                  sensorSource === 'sim'
                    ? 'bg-emerald-700 text-white border-emerald-700'
                    : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-emerald-50'
                }`}
              >
                Bench Simulator
              </button>
              <button
                onClick={() => setSensorSource('live_ws')}
                className={`px-2.5 py-1 text-xs font-semibold rounded border inline-flex items-center gap-1.5 cursor-pointer ${
                  sensorSource === 'live_ws'
                    ? 'bg-emerald-700 text-white border-emerald-700'
                    : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-emerald-50'
                }`}
              >
                <Radio className="w-3.5 h-3.5" />
                Live MaixSense
              </button>
              <button
                onClick={() => void discoverMaixsense()}
                disabled={discovering}
                className="px-2.5 py-1 text-xs font-medium rounded border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 inline-flex items-center gap-1 cursor-pointer disabled:opacity-50"
              >
                <Search className="w-3 h-3" />
                {discovering ? 'Scanning...' : 'Discover'}
              </button>
            </div>
          </div>

          {/* Live WebSocket Status Strip */}
          {sensorSource === 'live_ws' && (
            <div
              className={`rounded-md p-3 border text-xs flex flex-wrap items-center justify-between gap-2 ${
                liveTelemetry.stale
                  ? 'bg-rose-50 border-rose-300 text-rose-900'
                  : liveTelemetry.connected && liveTelemetry.frameId > 0
                  ? 'bg-emerald-50 border-emerald-300 text-emerald-950'
                  : 'bg-amber-50 border-amber-300 text-amber-950'
              }`}
            >
              <div className="font-mono space-y-0.5">
                <div className="font-semibold">
                  {liveTelemetry.stale
                    ? 'WATCHDOG HALT: MaixSense feed stale (> 1.0s)'
                    : liveTelemetry.frameId > 0
                    ? `LIVE STREAM: ${liveTelemetry.ip} · Frame #${liveTelemetry.frameId} · ${liveTelemetry.fps.toFixed(
                        1
                      )} fps · ${liveTelemetry.latencyMs.toFixed(0)} ms`
                    : `WAITING FOR PUBLISHER on /ws/camera (room=${wsRoom}, expected IP ${liveTelemetry.ip})`}
                </div>
                <div className="text-[11px] opacity-80">
                  Source: {liveTelemetry.ipSource}
                  {liveTelemetry.frameId > 0 && !liveTelemetry.hasLeftRight
                    ? ' · Legacy center-only telemetry detected (Left/Right sliders held for corner sim)'
                    : ''}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-[11px]">Room:</span>
                <input
                  type="text"
                  value={wsRoom}
                  onChange={(e) => setWsRoom(e.target.value)}
                  className="w-24 px-2 py-0.5 text-xs font-mono bg-white border border-slate-300 rounded"
                />
              </div>
            </div>
          )}

          {/* Scenario Presets */}
          <div className="flex flex-wrap gap-1.5">
            {(
              [
                ['straight', 'Straight Row'],
                ['left_corner', 'Left 90° Corner'],
                ['right_corner', 'Right 90° Corner'],
                ['t_junction', 'T-Junction'],
                ['dead_end', 'Dead End'],
                ['headland', 'Row End'],
                ['obstacle', 'Narrow Obstacle'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                onClick={() => applyPreset(id)}
                className="px-2.5 py-1 text-xs font-medium rounded border border-emerald-900/15 bg-[#F4F8F5] hover:bg-emerald-100 text-emerald-900 cursor-pointer"
              >
                {label}
              </button>
            ))}
          </div>

          {/* Overhead MaixSense 3-Zone Beam Visualizer + Corner Decision Box */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-stretch">
            <div className="md:col-span-6 bg-[#F4F8F5] border border-emerald-900/10 rounded-lg p-3 flex flex-col items-center justify-center">
              <div className="w-full flex items-center justify-between text-[11px] font-mono text-slate-600 mb-1">
                <span>TOP-DOWN ToF 3-ZONE CONE</span>
                <span>2400mm max</span>
              </div>
              <svg viewBox="0 0 260 195" className="w-full max-w-[260px] h-auto">
                {/* Range arcs */}
                <path
                  d={`M ${130 - cornerArcR} 170 A ${cornerArcR} ${cornerArcR} 0 0 1 ${
                    130 + cornerArcR
                  } 170`}
                  fill="none"
                  stroke="#d97706"
                  strokeWidth="1.2"
                  strokeDasharray="4 3"
                />
                <path
                  d={`M ${130 - obstacleArcR} 170 A ${obstacleArcR} ${obstacleArcR} 0 0 1 ${
                    130 + obstacleArcR
                  } 170`}
                  fill="none"
                  stroke="#e11d48"
                  strokeWidth="1.5"
                />

                {/* Left beam (-35 deg) */}
                <path
                  d={`M 130 170 L ${130 - leftBeamLen * 0.78} ${170 - leftBeamLen * 0.62} L ${
                    130 - leftBeamLen * 0.30
                  } ${170 - leftBeamLen * 0.95} Z`}
                  fill={leftMm >= cornerOpenSideMm ? 'rgba(16,185,129,0.28)' : 'rgba(245,158,11,0.35)'}
                  stroke={leftMm >= cornerOpenSideMm ? '#047857' : '#b45309'}
                  strokeWidth="1.2"
                />

                {/* Center beam (0 deg) */}
                <path
                  d={`M 130 170 L ${130 - centerBeamLen * 0.28} ${170 - centerBeamLen * 0.96} L ${
                    130 + centerBeamLen * 0.28
                  } ${170 - centerBeamLen * 0.96} Z`}
                  fill={
                    spatial.obstacleBlocked
                      ? 'rgba(225,29,72,0.32)'
                      : centerMm <= cornerStopMm
                      ? 'rgba(245,158,11,0.38)'
                      : 'rgba(16,185,129,0.28)'
                  }
                  stroke={
                    spatial.obstacleBlocked
                      ? '#be123c'
                      : centerMm <= cornerStopMm
                      ? '#b45309'
                      : '#047857'
                  }
                  strokeWidth="1.4"
                />

                {/* Right beam (+35 deg) */}
                <path
                  d={`M 130 170 L ${130 + rightBeamLen * 0.30} ${170 - rightBeamLen * 0.95} L ${
                    130 + rightBeamLen * 0.78
                  } ${170 - rightBeamLen * 0.62} Z`}
                  fill={rightMm >= cornerOpenSideMm ? 'rgba(16,185,129,0.28)' : 'rgba(245,158,11,0.35)'}
                  stroke={rightMm >= cornerOpenSideMm ? '#047857' : '#b45309'}
                  strokeWidth="1.2"
                />

                {/* Weed marker on ground */}
                {weedDetected && (
                  <g>
                    <circle
                      cx={130}
                      cy={170 - scaleDepth(spatial.forwardFromCamMm)}
                      r="5"
                      fill="#16a34a"
                      stroke="#ffffff"
                      strokeWidth="1.5"
                    />
                    <text
                      x={138}
                      y={173 - scaleDepth(spatial.forwardFromCamMm)}
                      fontSize="8.5"
                      fill="#14532d"
                      fontFamily="monospace"
                    >
                      WEED {spatial.dxToToolMm}mm
                    </text>
                  </g>
                )}

                {/* Rover chassis */}
                <rect x="114" y="162" width="32" height="24" rx="4" fill="#064e3b" />
                <circle cx="130" cy="166" r="3" fill="#34d399" />
                <text x="14" y="20" fontSize="9.5" fill="#334155" fontFamily="monospace">
                  L:{leftMm}mm
                </text>
                <text x="100" y="16" fontSize="9.5" fill="#0f172a" fontFamily="monospace" fontWeight="bold">
                  C:{centerMm}mm
                </text>
                <text x="192" y="20" fontSize="9.5" fill="#334155" fontFamily="monospace">
                  R:{rightMm}mm
                </text>
              </svg>
              <div className="w-full flex items-center justify-between text-[10px] font-mono text-slate-500 mt-1">
                <span className="text-rose-700">Red arc: Stop {obstacleStopMm}mm</span>
                <span className="text-amber-700">Amber arc: Corner {cornerStopMm}mm</span>
              </div>
            </div>

            {/* Corner Decision & Auto-Response Box */}
            <div className="md:col-span-6 flex flex-col justify-between gap-3">
              <div
                className={`rounded-lg p-3.5 border space-y-2 ${
                  confirmedCorner === 'OBSTACLE_STOP'
                    ? 'bg-rose-50 border-rose-300 text-rose-950'
                    : confirmedCorner !== 'NONE'
                    ? 'bg-amber-50 border-amber-300 text-amber-950'
                    : 'bg-emerald-50 border-emerald-200 text-emerald-950'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-mono uppercase tracking-wide opacity-80">
                    Corner Confirmation ({confirmStreak}/{confirmFramesRequired} frames)
                  </span>
                  <span className="px-2 py-0.5 rounded bg-white/80 font-mono text-[11px] font-bold">
                    {confirmedCorner}
                  </span>
                </div>
                <div className="text-sm font-semibold">{spatial.reason}</div>
                <div className="grid grid-cols-3 gap-2 pt-1 text-center">
                  <div className="bg-white/80 rounded p-1.5">
                    <div className="text-[10px] text-slate-500">Go Forward</div>
                    <div className="font-mono text-xs font-bold text-emerald-900">
                      {spatial.recommendedTravelMm} mm
                    </div>
                  </div>
                  <div className="bg-white/80 rounded p-1.5">
                    <div className="text-[10px] text-slate-500">Turn Cmd</div>
                    <div className="font-mono text-xs font-bold text-slate-900">
                      {spatial.suggestedTurn}
                    </div>
                  </div>
                  <div className="bg-white/80 rounded p-1.5">
                    <div className="text-[10px] text-slate-500">Steer Bias</div>
                    <div className="font-mono text-xs font-bold text-slate-900">
                      {spatial.steerAdjustPct > 0
                        ? `+${spatial.steerAdjustPct}%`
                        : `${spatial.steerAdjustPct}%`}
                    </div>
                  </div>
                </div>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2.5">
                <div className="flex items-center justify-between text-xs">
                  <label className="flex items-center gap-2 font-medium text-slate-800 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoRespondCorners}
                      onChange={(e) => setAutoRespondCorners(e.target.checked)}
                      className="accent-emerald-700"
                    />
                    Auto-execute confirmed corner turns
                  </label>
                  <span className="font-mono text-[11px] text-slate-500">
                    PWM: L{spatial.recommendedLeftPwm} R{spatial.recommendedRightPwm}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => void executeConfirmedCornerAction()}
                    disabled={confirmedCorner === 'NONE' || estopActive}
                    className="py-1.5 px-2.5 rounded bg-amber-600 hover:bg-amber-700 disabled:bg-slate-200 disabled:text-slate-500 text-white text-xs font-semibold cursor-pointer"
                  >
                    Execute Corner Action
                  </button>
                  <button
                    onClick={() =>
                      void executeTimedMoveMm(
                        spatial.recommendedTravelMm,
                        driveSpeedPct,
                        'Cruise Distance-to-Go'
                      )
                    }
                    disabled={spatial.recommendedTravelMm < 20 || estopActive}
                    className="py-1.5 px-2.5 rounded bg-emerald-700 hover:bg-emerald-800 disabled:bg-slate-200 disabled:text-slate-500 text-white text-xs font-semibold cursor-pointer"
                  >
                    Roll +{spatial.recommendedTravelMm} mm
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Interactive 4-Channel ToF Depth Sliders (Bench Input / Threshold Tuning) */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            {[
              { label: 'Left Zone', val: leftMm, set: setLeftMm },
              { label: 'Center Median', val: centerMm, set: setCenterMm },
              { label: 'Min Center (p10)', val: minCenterMm, set: setMinCenterMm },
              { label: 'Right Zone', val: rightMm, set: setRightMm },
            ].map((z) => (
              <div key={z.label} className="rounded border border-emerald-900/10 bg-[#F7FAF8] p-2.5">
                <div className="flex justify-between text-[11px] text-slate-600">
                  <span>{z.label}</span>
                  <span className="font-mono font-semibold text-slate-900">{z.val}mm</span>
                </div>
                <input
                  type="range"
                  min={200}
                  max={2400}
                  step={10}
                  value={z.val}
                  onChange={(e) => {
                    if (sensorSource !== 'sim') setSensorSource('sim');
                    z.set(Number(e.target.value));
                  }}
                  className="w-full mt-1.5 accent-emerald-700"
                />
              </div>
            ))}
          </div>

          {/* Corner Threshold Tuners & Weed Alignment Row */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
            <div className="rounded border border-slate-200 bg-slate-50 p-3 space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-700">
                Corner Detection Thresholds (config.yaml)
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <label className="space-y-0.5">
                  <span className="text-[11px] text-slate-500">Corner Stop (mm)</span>
                  <input
                    type="number"
                    min={300}
                    max={1200}
                    step={20}
                    value={cornerStopMm}
                    onChange={(e) => setCornerStopMm(Number(e.target.value) || 520)}
                    className="w-full px-2 py-1 font-mono bg-white border border-slate-300 rounded"
                  />
                </label>
                <label className="space-y-0.5">
                  <span className="text-[11px] text-slate-500">Open Side (mm)</span>
                  <input
                    type="number"
                    min={650}
                    max={2000}
                    step={50}
                    value={cornerOpenSideMm}
                    onChange={(e) => setCornerOpenSideMm(Number(e.target.value) || 1050)}
                    className="w-full px-2 py-1 font-mono bg-white border border-slate-300 rounded"
                  />
                </label>
                <label className="space-y-0.5">
                  <span className="text-[11px] text-slate-500">Obstacle Stop (mm)</span>
                  <input
                    type="number"
                    min={180}
                    max={600}
                    step={10}
                    value={obstacleStopMm}
                    onChange={(e) => setObstacleStopMm(Number(e.target.value) || 320)}
                    className="w-full px-2 py-1 font-mono bg-white border border-slate-300 rounded"
                  />
                </label>
                <label className="space-y-0.5">
                  <span className="text-[11px] text-slate-500">Debounce Frames</span>
                  <input
                    type="number"
                    min={1}
                    max={6}
                    step={1}
                    value={confirmFramesRequired}
                    onChange={(e) =>
                      setConfirmFramesRequired(Math.max(1, Math.min(6, Number(e.target.value) || 3)))
                    }
                    className="w-full px-2 py-1 font-mono bg-white border border-slate-300 rounded"
                  />
                </label>
              </div>
            </div>

            <div className="rounded border border-emerald-900/10 bg-[#F7FAF8] p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-emerald-950">
                  Weed Alignment Under Tool
                </span>
                <label className="flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={weedDetected}
                    onChange={(e) => setWeedDetected(e.target.checked)}
                    className="accent-emerald-700"
                  />
                  Detected
                </label>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <div className="flex justify-between text-[11px] text-slate-600">
                    <span>Weed Depth</span>
                    <span className="font-mono font-semibold">{weedSlantMm}mm</span>
                  </div>
                  <input
                    type="range"
                    min={430}
                    max={1500}
                    step={10}
                    value={weedSlantMm}
                    onChange={(e) => setWeedSlantMm(Number(e.target.value))}
                    className="w-full accent-emerald-700"
                  />
                </div>
                <div>
                  <div className="flex justify-between text-[11px] text-slate-600">
                    <span>Tool Offset</span>
                    <span className="font-mono font-semibold">{toolOffsetMm}mm</span>
                  </div>
                  <input
                    type="range"
                    min={-300}
                    max={250}
                    step={10}
                    value={toolOffsetMm}
                    onChange={(e) => setToolOffsetMm(Number(e.target.value))}
                    className="w-full accent-emerald-700"
                  />
                </div>
              </div>
              <button
                onClick={() =>
                  void executeTimedMoveMm(
                    Math.min(spatial.dxToToolMm, spatial.recommendedTravelMm),
                    28,
                    'Align Weed Under Tool'
                  )
                }
                disabled={!weedDetected || estopActive}
                className="w-full py-1.5 rounded bg-emerald-700 hover:bg-emerald-800 disabled:bg-slate-200 disabled:text-slate-500 text-white text-xs font-semibold cursor-pointer"
              >
                Roll +{Math.min(spatial.dxToToolMm, spatial.recommendedTravelMm)} mm to Center Weed
              </button>
            </div>
          </div>
        </section>

        {/* RIGHT COLUMN: Integrated Motor Driver + Grinder (CH1) + Flame (CH2) Command Interface */}
        <section className="xl:col-span-5 space-y-5">
          {/* A. Normal Motor Driver Command Interface */}
          <div className="bg-white border border-emerald-900/10 rounded-lg p-5 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Cpu className="w-4 h-4 text-emerald-700" />
                <h2 className="text-base font-semibold text-emerald-950">
                  2. Normal Motor Driver Command Interface
                </h2>
              </div>
              <span
                className={`px-2 py-0.5 rounded font-mono text-[11px] font-bold border ${
                  isMoving
                    ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                    : 'bg-slate-100 text-slate-700 border-slate-200'
                }`}
              >
                {activeMotionLabel}
              </span>
            </div>

            {/* Live Left / Right PWM Telemetry */}
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'LEFT MOTOR (ENA / D5)', val: leftPwm },
                { label: 'RIGHT MOTOR (ENB / D6)', val: rightPwm },
              ].map((ch) => (
                <div key={ch.label} className="rounded bg-[#F4F8F5] border border-emerald-900/10 p-2.5">
                  <div className="text-[10px] font-mono text-slate-500">{ch.label}</div>
                  <div className="text-lg font-bold font-mono text-slate-900">
                    {ch.val > 0 ? `+${ch.val}%` : `${ch.val}%`}
                  </div>
                  <div className="h-1.5 w-full bg-slate-200 rounded overflow-hidden mt-1">
                    <div
                      className={`h-full transition-all ${
                        ch.val >= 0 ? 'bg-emerald-600' : 'bg-amber-600'
                      }`}
                      style={{ width: `${Math.min(100, Math.abs(ch.val))}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>

            {/* Drive Speed Slider */}
            <div className="space-y-1">
              <div className="flex justify-between text-xs text-slate-700">
                <span className="font-medium">Motor PWM Speed</span>
                <span className="font-mono font-semibold">{driveSpeedPct}%</span>
              </div>
              <input
                type="range"
                min={15}
                max={100}
                step={5}
                value={driveSpeedPct}
                onChange={(e) => setDriveSpeedPct(Number(e.target.value))}
                className="w-full accent-emerald-700"
              />
            </div>

            {/* Directional & Pivot Command Pad */}
            <div className="grid grid-cols-3 gap-2">
              <button
                onClick={() => void executePivotTurn(-90, 'Manual Pivot Left')}
                disabled={estopActive}
                className="py-2 px-2 rounded border border-slate-200 bg-slate-50 hover:bg-emerald-50 text-slate-800 text-xs font-semibold flex flex-col items-center gap-1 cursor-pointer disabled:opacity-40"
              >
                <RotateCcw className="w-4 h-4 text-emerald-700" />
                <span>Pivot -90°</span>
              </button>
              <button
                onClick={() =>
                  void executeDirectDrive(
                    spatial.recommendedLeftPwm || driveSpeedPct,
                    spatial.recommendedRightPwm || driveSpeedPct,
                    'Forward (MaixSense Centered)'
                  )
                }
                disabled={estopActive || spatial.obstacleBlocked}
                className="py-2 px-2 rounded bg-emerald-700 hover:bg-emerald-800 disabled:bg-slate-200 disabled:text-slate-500 text-white text-xs font-semibold flex flex-col items-center gap-1 cursor-pointer"
              >
                <ArrowUp className="w-4 h-4" />
                <span>Forward</span>
              </button>
              <button
                onClick={() => void executePivotTurn(90, 'Manual Pivot Right')}
                disabled={estopActive}
                className="py-2 px-2 rounded border border-slate-200 bg-slate-50 hover:bg-emerald-50 text-slate-800 text-xs font-semibold flex flex-col items-center gap-1 cursor-pointer disabled:opacity-40"
              >
                <RotateCw className="w-4 h-4 text-emerald-700" />
                <span>Pivot +90°</span>
              </button>

              <button
                onClick={() => void executePivotTurn(180, 'Manual U-Turn')}
                disabled={estopActive}
                className="py-2 px-2 rounded border border-slate-200 bg-slate-50 hover:bg-emerald-50 text-slate-800 text-xs font-semibold cursor-pointer disabled:opacity-40"
              >
                U-Turn 180°
              </button>
              <button
                onClick={() => void sendEmergencyStop('Motor STOP button')}
                className="py-2 px-2 rounded bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold flex items-center justify-center gap-1 cursor-pointer"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                <span>STOP</span>
              </button>
              <button
                onClick={() =>
                  void executeDirectDrive(-driveSpeedPct, -driveSpeedPct, 'Reverse Drive')
                }
                disabled={estopActive}
                className="py-2 px-2 rounded border border-slate-200 bg-slate-50 hover:bg-emerald-50 text-slate-800 text-xs font-semibold flex items-center justify-center gap-1 cursor-pointer disabled:opacity-40"
              >
                <ArrowDown className="w-4 h-4 text-slate-600" />
                <span>Reverse</span>
              </button>
            </div>
          </div>

          {/* B. Grinding Machine (CH1) + Flame Controller (CH2) Command Panel */}
          <div className="bg-white border border-emerald-900/10 rounded-lg p-5 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Flame className="w-4 h-4 text-orange-600" />
                <h2 className="text-base font-semibold text-emerald-950">
                  3. Grinder (CH1) &amp; Flame (CH2) Relays
                </h2>
              </div>
              <button
                onClick={() => void dispatchCommand({ kind: 'ping' }, 'Hardware Watchdog PING')}
                className="px-2 py-1 text-[11px] font-mono rounded border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 cursor-pointer"
              >
                PING
              </button>
            </div>

            {/* Safe Arming Gate (DRY-RUN vs ARMED) */}
            <div
              className={`rounded-md p-3 border text-xs space-y-2 ${
                dryRun
                  ? 'bg-amber-50 border-amber-300 text-amber-950'
                  : 'bg-rose-50 border-rose-300 text-rose-950'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono font-bold flex items-center gap-1.5">
                  <ShieldAlert className="w-4 h-4 shrink-0" />
                  {dryRun ? 'SAFE MODE: DRY-RUN (Relays OFF)' : 'ARMED MODE: LIVE RELAY COMMANDS'}
                </span>
                <button
                  onClick={() => {
                    if (dryRun && !safetyChecklistAck) {
                      onLogEvent(
                        '[SimplaBot] Confirm physical E-Stop & flame clearance checkbox before arming relays.'
                      );
                      return;
                    }
                    setDryRun((d) => !d);
                    onLogEvent(`[SimplaBot] Switched tool relay mode -> ${dryRun ? 'ARMED' : 'DRY-RUN'}`);
                  }}
                  className={`px-2.5 py-1 rounded text-[11px] font-bold cursor-pointer ${
                    dryRun
                      ? 'bg-amber-700 hover:bg-amber-800 text-white'
                      : 'bg-slate-900 hover:bg-slate-800 text-white'
                  }`}
                >
                  {dryRun ? 'Arm Relays' : 'Return to Dry-Run'}
                </button>
              </div>
              {dryRun && (
                <label className="flex items-center gap-2 text-[11px] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={safetyChecklistAck}
                    onChange={(e) => setSafetyChecklistAck(e.target.checked)}
                    className="accent-rose-600"
                  />
                  <span>Physical NC E-Stop wired in series with 12V &amp; flame area verified clear</span>
                </label>
              )}
            </div>

            {/* Relay Live State Cards */}
            <div className="grid grid-cols-2 gap-3">
              {/* CH1 Grinder */}
              <div
                className={`rounded-md p-3 border space-y-2 ${
                  grinderOn
                    ? 'bg-emerald-50 border-emerald-400'
                    : 'bg-slate-50 border-slate-200'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-900">CH1: Grinder</span>
                  <span
                    className={`px-1.5 py-0.5 rounded font-mono text-[10px] font-bold ${
                      grinderOn ? 'bg-emerald-700 text-white' : 'bg-slate-200 text-slate-700'
                    }`}
                  >
                    {grinderOn ? (dryRun ? 'DRY ON' : 'LIVE ON') : 'OFF'}
                  </span>
                </div>
                <div className="text-[11px] text-slate-600 flex justify-between">
                  <span>Dwell Time</span>
                  <span className="font-mono font-semibold">{grinderDurationS.toFixed(1)}s</span>
                </div>
                <input
                  type="range"
                  min={0.5}
                  max={4.0}
                  step={0.1}
                  value={grinderDurationS}
                  onChange={(e) => setGrinderDurationS(Number(e.target.value))}
                  className="w-full accent-emerald-700"
                />
                <button
                  onClick={() => void runGrinderPulse()}
                  disabled={Boolean(toolsBlockedReason)}
                  className="w-full py-1.5 rounded bg-emerald-700 hover:bg-emerald-800 disabled:bg-slate-200 disabled:text-slate-500 text-white text-xs font-semibold cursor-pointer"
                >
                  Run Grinder ({grinderDurationS.toFixed(1)}s)
                </button>
              </div>

              {/* CH2 Flame */}
              <div
                className={`rounded-md p-3 border space-y-2 ${
                  flameOn
                    ? 'bg-orange-50 border-orange-400'
                    : 'bg-slate-50 border-slate-200'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-slate-900">CH2: Flame</span>
                  <span
                    className={`px-1.5 py-0.5 rounded font-mono text-[10px] font-bold ${
                      flameOn
                        ? 'bg-orange-600 text-white'
                        : flameCooldownRemainingMs > 0
                        ? 'bg-amber-200 text-amber-900'
                        : 'bg-slate-200 text-slate-700'
                    }`}
                  >
                    {flameOn
                      ? dryRun
                        ? 'DRY FIRE'
                        : 'FIRING'
                      : flameCooldownRemainingMs > 0
                      ? `COOL ${(flameCooldownRemainingMs / 1000).toFixed(1)}s`
                      : 'OFF'}
                  </span>
                </div>
                <div className="text-[11px] text-slate-600 flex justify-between">
                  <span>Burn (2.5s cap)</span>
                  <span className="font-mono font-semibold">{cappedFlameS.toFixed(1)}s</span>
                </div>
                <input
                  type="range"
                  min={0.3}
                  max={2.5}
                  step={0.1}
                  value={cappedFlameS}
                  onChange={(e) => setFlameDurationS(Number(e.target.value))}
                  className="w-full accent-orange-600"
                />
                <button
                  onClick={() => void runFlamePulse()}
                  disabled={Boolean(toolsBlockedReason) || flameCooldownRemainingMs > 0}
                  className="w-full py-1.5 rounded bg-orange-600 hover:bg-orange-700 disabled:bg-slate-200 disabled:text-slate-500 text-white text-xs font-semibold cursor-pointer"
                >
                  {flameCooldownRemainingMs > 0
                    ? `Cooldown ${(flameCooldownRemainingMs / 1000).toFixed(1)}s`
                    : `Fire Flame (${cappedFlameS.toFixed(1)}s)`}
                </button>
              </div>
            </div>

            {/* Active Pulse Progress / Interlock Status Bar */}
            {activeToolProgress.tool && (
              <div className="rounded bg-slate-900 text-white p-2.5 space-y-1">
                <div className="flex justify-between text-[11px] font-mono">
                  <span>
                    ACTIVE {activeToolProgress.tool.toUpperCase()} PULSE ({dryRun ? 'DRY-RUN' : 'LIVE'})
                  </span>
                  <span>{(activeToolProgress.remainingMs / 1000).toFixed(1)}s left</span>
                </div>
                <div className="h-1.5 w-full bg-slate-700 rounded overflow-hidden">
                  <div
                    className={
                      activeToolProgress.tool === 'flame' ? 'h-full bg-orange-500' : 'h-full bg-emerald-400'
                    }
                    style={{
                      width: `${Math.min(
                        100,
                        (activeToolProgress.remainingMs / Math.max(1, activeToolProgress.totalMs)) * 100
                      )}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {toolsBlockedReason && (
              <div className="text-xs font-mono text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-1.5">
                INTERLOCK: {toolsBlockedReason}
              </div>
            )}

            {/* Combo & Cutoff Row */}
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => void runGrinderThenFlame()}
                disabled={Boolean(toolsBlockedReason) || flameCooldownRemainingMs > 0}
                className="py-2 px-3 rounded bg-slate-900 hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-500 text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Zap className="w-3.5 h-3.5 text-amber-400" />
                <span>Grind → Flame</span>
              </button>
              <button
                onClick={() => void killToolsOnly()}
                className="py-2 px-3 rounded border border-rose-300 bg-rose-50 hover:bg-rose-100 text-rose-800 text-xs font-semibold cursor-pointer"
              >
                Cut Both Relays (R 0 0)
              </button>
            </div>

            {/* Wire Protocol Transcript */}
            <div className="space-y-1">
              <div className="text-[11px] font-mono text-slate-500 uppercase">
                Serial / GPIO Command Wire Log (simpla_motor_relay.ino)
              </div>
              <div className="bg-[#F4F8F5] border border-emerald-900/10 rounded p-2.5 h-24 overflow-y-auto font-mono text-[11px] space-y-1">
                {commandHistory.length === 0 ? (
                  <div className="text-slate-400">
                    No commands sent yet. Click Forward, Pivot, Grinder, or Flame to dispatch.
                  </div>
                ) : (
                  commandHistory.map((c) => (
                    <div key={c.id} className="flex items-center justify-between gap-2">
                      <span className={c.ok ? 'text-emerald-900' : 'text-rose-700'}>
                        [{c.ts}] <strong>{c.wire}</strong> → {c.ack}
                      </span>
                      <span className="text-slate-500 truncate max-w-[160px]">{c.detail}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </section>
      </div>
      )}

      {/* Bottom Row: Hardware Pinout Tables & CLI / Git Branch Setup */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <section className="lg:col-span-7 bg-white border border-emerald-900/10 rounded-lg p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Cpu className="w-4 h-4 text-emerald-700" />
              <h2 className="text-base font-semibold text-emerald-950">
                Normal Motor Driver &amp; 2-Ch Relay Wiring Reference
              </h2>
            </div>
            <div className="flex gap-1.5">
              <button
                onClick={() => setWiringTab('gpio')}
                className={`px-3 py-1 text-xs font-medium rounded border cursor-pointer ${
                  wiringTab === 'gpio'
                    ? 'bg-emerald-700 text-white border-emerald-700'
                    : 'bg-slate-50 text-slate-700 border-slate-200'
                }`}
              >
                Option A: Pi Direct GPIO
              </button>
              <button
                onClick={() => setWiringTab('serial')}
                className={`px-3 py-1 text-xs font-medium rounded border cursor-pointer ${
                  wiringTab === 'serial'
                    ? 'bg-emerald-700 text-white border-emerald-700'
                    : 'bg-slate-50 text-slate-700 border-slate-200'
                }`}
              >
                Option B: Arduino USB (Field)
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-emerald-900 text-white">
                  <th className="py-2 px-3 rounded-tl">Function</th>
                  <th className="py-2 px-3">Pin</th>
                  <th className="py-2 px-3">Header / Mode</th>
                  <th className="py-2 px-3 rounded-tr">Connect To</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {(wiringTab === 'gpio' ? PI_PINOUT : ARDUINO_PINOUT).map((row) => (
                  <tr key={row.fn} className="hover:bg-[#F7FAF8]">
                    <td className="py-2 px-3 font-medium text-slate-900">{row.fn}</td>
                    <td className="py-2 px-3 font-mono text-emerald-800 font-semibold">{row.pin}</td>
                    <td className="py-2 px-3 font-mono text-slate-600">{row.hdr}</td>
                    <td className="py-2 px-3 text-slate-700">{row.target}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="lg:col-span-5 bg-white border border-emerald-900/10 rounded-lg p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Wrench className="w-4 h-4 text-emerald-700" />
            <h2 className="text-base font-semibold text-emerald-950">
              CLI Commands &amp; Branch <span className="font-mono text-emerald-700">simpla_bot</span>
            </h2>
          </div>

          {[
            {
              id: 'sim',
              title: '1. Offline Bench Simulation (No Hardware)',
              cmd: 'python3 -m simpla_bot.run_simpla_bot --mode sim --tool both',
            },
            {
              id: 'ms',
              title: '2. Check Live MaixSense-A075V (192.168.233.1)',
              cmd: 'python3 -m simpla_bot.run_simpla_bot --check-maixsense',
            },
            {
              id: 'cal',
              title: '3. Calibrate 1000mm Straight & 90° Turn',
              cmd: 'python3 -m simpla_bot.run_simpla_bot --calibrate-drive 1000\npython3 -m simpla_bot.run_simpla_bot --calibrate-turn 90',
            },
            {
              id: 'live',
              title: '4. Live Field Run (Armed Flame + Grinder)',
              cmd: 'python3 -m simpla_bot.run_simpla_bot --mode live --tool both --arm-tools',
            },
            {
              id: 'git',
              title: '5. Create & Push Branch simpla_bot (Local Git)',
              cmd: branchCmd,
            },
          ].map((item) => (
            <div key={item.id} className="space-y-1">
              <div className="flex items-center justify-between text-xs font-medium text-slate-700">
                <span>{item.title}</span>
                <button
                  onClick={() => void copyCommand(item.id, item.cmd)}
                  className="inline-flex items-center gap-1 text-[11px] text-emerald-700 hover:text-emerald-900 cursor-pointer"
                >
                  {copiedCmd === item.id ? (
                    <>
                      <Check className="w-3 h-3" /> Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" /> Copy
                    </>
                  )}
                </button>
              </div>
              <pre className="bg-[#F4F8F5] border border-emerald-900/10 rounded p-2 text-[11px] font-mono text-slate-800 overflow-x-auto">
                {item.cmd}
              </pre>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
};
