import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Check,
  Copy,
  Pause,
  Play,
  RotateCcw,
  Sliders,
  Sparkles,
  Zap,
} from 'lucide-react';

export interface CornerCalibrationThresholds {
  cornerStopMm: number;
  obstacleStopMm: number;
  cornerOpenSideMm: number;
  sideAsymmetryMm: number;
  headlandOpenMm: number;
  confirmFramesRequired: number;
}

export interface CornerTelemetrySample {
  seq: number;
  ts: number;
  leftMm: number;
  centerMm: number;
  minCenterMm: number;
  rightMm: number;
  rawCorner: string;
  confirmedCorner: string;
}

interface SimplaBotCornerCalibrationProps {
  sensorSource: 'sim' | 'live_ws';
  liveConnected: boolean;
  liveFrameId: number;
  liveFps: number;
  leftMm: number;
  centerMm: number;
  minCenterMm: number;
  rightMm: number;
  rawCorner: string;
  confirmedCorner: string;
  confirmStreak: number;
  suggestedTurn: string;
  recommendedTravelMm: number;
  thresholds: CornerCalibrationThresholds;
  onChangeThresholds: (next: CornerCalibrationThresholds) => void;
  onInjectSample: (sample: {
    leftMm: number;
    centerMm: number;
    minCenterMm: number;
    rightMm: number;
  }) => void;
  onLogEvent: (msg: string) => void;
}

export const DEFAULT_CORNER_THRESHOLDS: CornerCalibrationThresholds = {
  cornerStopMm: 520,
  obstacleStopMm: 320,
  cornerOpenSideMm: 1050,
  sideAsymmetryMm: 280,
  headlandOpenMm: 1850,
  confirmFramesRequired: 3,
};

const SENSITIVITY_PRESETS: Array<{
  id: string;
  label: string;
  desc: string;
  values: CornerCalibrationThresholds;
}> = [
  {
    id: 'indoor',
    label: 'Tight Bench / Indoor',
    desc: 'Shorter stop distances for narrow lab corridors',
    values: {
      cornerStopMm: 460,
      obstacleStopMm: 280,
      cornerOpenSideMm: 900,
      sideAsymmetryMm: 220,
      headlandOpenMm: 1650,
      confirmFramesRequired: 2,
    },
  },
  {
    id: 'standard',
    label: 'Standard Field (Default)',
    desc: 'Balanced defaults matching simpla_bot/config.yaml',
    values: DEFAULT_CORNER_THRESHOLDS,
  },
  {
    id: 'conservative',
    label: 'Noisy Sunlight / Outdoor',
    desc: 'Higher margins + 4-frame debounce for bright sun',
    values: {
      cornerStopMm: 620,
      obstacleStopMm: 380,
      cornerOpenSideMm: 1200,
      sideAsymmetryMm: 340,
      headlandOpenMm: 2050,
      confirmFramesRequired: 4,
    },
  },
];

const MAX_SAMPLES = 48;
const MAX_DEPTH_MM = 2400;

export const SimplaBotCornerCalibration: React.FC<SimplaBotCornerCalibrationProps> = ({
  sensorSource,
  liveConnected,
  liveFrameId,
  liveFps,
  leftMm,
  centerMm,
  minCenterMm,
  rightMm,
  rawCorner,
  confirmedCorner,
  confirmStreak,
  suggestedTurn,
  recommendedTravelMm,
  thresholds,
  onChangeThresholds,
  onInjectSample,
  onLogEvent,
}) => {
  const [samples, setSamples] = useState<CornerTelemetrySample[]>(() => [
    {
      seq: 1,
      ts: Date.now(),
      leftMm,
      centerMm,
      minCenterMm,
      rightMm,
      rawCorner,
      confirmedCorner,
    },
  ]);
  const [streamPaused, setStreamPaused] = useState<boolean>(false);
  const [benchAutoSweep, setBenchAutoSweep] = useState<boolean>(false);
  const [sweepPhase, setSweepPhase] = useState<number>(0);
  const [copiedYaml, setCopiedYaml] = useState<boolean>(false);

  // Record every incoming sensor reading (live frame or bench update) into the oscilloscope buffer
  useEffect(() => {
    if (streamPaused) return;
    setSamples((prev) => {
      const nextSeq = (prev[prev.length - 1]?.seq ?? 0) + 1;
      const entry: CornerTelemetrySample = {
        seq: nextSeq,
        ts: Date.now(),
        leftMm,
        centerMm,
        minCenterMm,
        rightMm,
        rawCorner,
        confirmedCorner,
      };
      return [...prev.slice(-(MAX_SAMPLES - 1)), entry];
    });
  }, [leftMm, centerMm, minCenterMm, rightMm, rawCorner, confirmedCorner, liveFrameId, streamPaused]);

  // Optional synthetic corner-approach bench sweep so operator can test thresholds live without hardware
  useEffect(() => {
    if (!benchAutoSweep || sensorSource !== 'sim') return;
    const id = window.setInterval(() => {
      setSweepPhase((prev) => {
        const next = (prev + 1) % 60;
        const jitter = () => Math.round((Math.random() - 0.5) * 44);

        let nextLeft = 800;
        let nextCenter = 1500;
        let nextRight = 820;

        if (next < 18) {
          // Approaching a LEFT corner along a straight corridor
          nextCenter = Math.round(1650 - next * 68) + jitter();
          nextLeft = (next >= 12 ? 1580 : 810) + jitter();
          nextRight = 640 + jitter();
        } else if (next < 28) {
          // Holding inside confirmed LEFT_CORNER zone
          nextCenter = 450 + jitter();
          nextLeft = 1620 + jitter();
          nextRight = 590 + jitter();
        } else if (next < 44) {
          // Straight corridor again, approaching RIGHT_CORNER
          const step = next - 28;
          nextCenter = Math.round(1580 - step * 70) + jitter();
          nextLeft = 620 + jitter();
          nextRight = (step >= 10 ? 1680 : 820) + jitter();
        } else if (next < 52) {
          // Holding inside RIGHT_CORNER zone
          nextCenter = 465 + jitter();
          nextLeft = 580 + jitter();
          nextRight = 1710 + jitter();
        } else {
          // Exiting into open ROW_END_HEADLAND
          nextCenter = 2080 + jitter();
          nextLeft = 2020 + jitter();
          nextRight = 2040 + jitter();
        }

        const clamp = (v: number) => Math.max(200, Math.min(2380, v));
        const c = clamp(nextCenter);
        onInjectSample({
          leftMm: clamp(nextLeft),
          centerMm: c,
          minCenterMm: clamp(c - Math.abs(jitter())),
          rightMm: clamp(nextRight),
        });
        return next;
      });
    }, 240);
    return () => window.clearInterval(id);
  }, [benchAutoSweep, sensorSource, onInjectSample]);

  // Inject a single-frame ToF noise spike to verify debounce filter immunity
  const injectSingleFrameSpike = () => {
    const prev = { leftMm, centerMm, minCenterMm, rightMm };
    onInjectSample({
      leftMm: 1650,
      centerMm: Math.max(360, thresholds.cornerStopMm - 60),
      minCenterMm: Math.max(350, thresholds.cornerStopMm - 70),
      rightMm: 560,
    });
    onLogEvent(
      `[Calibration] Injected 1-frame ToF speckle spike (testing ${thresholds.confirmFramesRequired}-frame corner debounce).`
    );
    window.setTimeout(() => {
      onInjectSample(prev);
    }, 260);
  };

  // Build SVG polyline paths for the 48-sample oscilloscope
  const chartW = 560;
  const chartH = 210;
  const padL = 42;
  const padR = 14;
  const padT = 14;
  const padB = 24;
  const innerW = chartW - padL - padR;
  const innerH = chartH - padT - padB;

  const yForMm = (mm: number) => {
    const clamped = Math.max(0, Math.min(MAX_DEPTH_MM, mm));
    return padT + innerH - (clamped / MAX_DEPTH_MM) * innerH;
  };

  const xForIdx = (idx: number, count: number) => {
    if (count <= 1) return padL + innerW;
    return padL + (idx / (MAX_SAMPLES - 1)) * innerW;
  };

  const { leftPath, centerPath, rightPath, minPath, triggerBands } = useMemo(() => {
    const count = samples.length;
    const startOffset = MAX_SAMPLES - count;
    const toPath = (pick: (s: CornerTelemetrySample) => number) =>
      samples
        .map((s, i) => `${i === 0 ? 'M' : 'L'} ${xForIdx(startOffset + i, MAX_SAMPLES).toFixed(1)} ${yForMm(pick(s)).toFixed(1)}`)
        .join(' ');

    const bands = samples
      .map((s, i) => {
        if (s.confirmedCorner === 'NONE') return null;
        const x = xForIdx(startOffset + i, MAX_SAMPLES);
        const w = innerW / (MAX_SAMPLES - 1) + 1;
        const color =
          s.confirmedCorner === 'OBSTACLE_STOP'
            ? 'rgba(225,29,72,0.16)'
            : 'rgba(217,119,6,0.16)';
        return { key: s.seq, x: x - w / 2, w, color };
      })
      .filter(Boolean) as Array<{ key: number; x: number; w: number; color: string }>;

    return {
      leftPath: toPath((s) => s.leftMm),
      centerPath: toPath((s) => s.centerMm),
      rightPath: toPath((s) => s.rightMm),
      minPath: toPath((s) => s.minCenterMm),
      triggerBands: bands,
    };
  }, [samples, innerW]);

  // Real-time margin calculations for operator feedback
  const margins = useMemo(() => {
    const asym = Math.abs(rightMm - leftMm);
    return [
      {
        label: 'Front Wall Margin (Center - Corner Stop)',
        value: centerMm - thresholds.cornerStopMm,
        triggered: centerMm <= thresholds.cornerStopMm,
        detail: `${centerMm}mm vs <= ${thresholds.cornerStopMm}mm`,
      },
      {
        label: 'Obstacle Margin (Min p10 - Obstacle Stop)',
        value: minCenterMm - thresholds.obstacleStopMm,
        triggered: minCenterMm <= thresholds.obstacleStopMm,
        detail: `${minCenterMm}mm vs <= ${thresholds.obstacleStopMm}mm`,
      },
      {
        label: 'Left Corridor Openness (Left - Open Side)',
        value: leftMm - thresholds.cornerOpenSideMm,
        triggered: leftMm >= thresholds.cornerOpenSideMm,
        positiveIsOpen: true,
        detail: `${leftMm}mm vs >= ${thresholds.cornerOpenSideMm}mm`,
      },
      {
        label: 'Right Corridor Openness (Right - Open Side)',
        value: rightMm - thresholds.cornerOpenSideMm,
        triggered: rightMm >= thresholds.cornerOpenSideMm,
        positiveIsOpen: true,
        detail: `${rightMm}mm vs >= ${thresholds.cornerOpenSideMm}mm`,
      },
      {
        label: 'T-Junction Side Asymmetry (|R - L| vs Min)',
        value: asym - thresholds.sideAsymmetryMm,
        triggered: asym >= thresholds.sideAsymmetryMm,
        positiveIsOpen: true,
        detail: `${asym}mm vs >= ${thresholds.sideAsymmetryMm}mm`,
      },
    ];
  }, [leftMm, centerMm, minCenterMm, rightMm, thresholds]);

  const yamlSnippet = `navigation:
  obstacle_stop_mm: ${thresholds.obstacleStopMm}
  corner_stop_mm: ${thresholds.cornerStopMm}
  corner_open_side_mm: ${thresholds.cornerOpenSideMm}
  side_asymmetry_mm: ${thresholds.sideAsymmetryMm}
  headland_open_mm: ${thresholds.headlandOpenMm}
  # Debounce confirmation frames in dashboard/live loop: ${thresholds.confirmFramesRequired}`;

  const copyYamlConfig = async () => {
    try {
      await navigator.clipboard.writeText(yamlSnippet);
      setCopiedYaml(true);
      setTimeout(() => setCopiedYaml(false), 1800);
      onLogEvent('[Calibration] Copied calibrated corner thresholds YAML for simpla_bot/config.yaml.');
    } catch {
      onLogEvent('[Calibration] Ready to copy threshold values from YAML preview.');
    }
  };

  const updateThreshold = <K extends keyof CornerCalibrationThresholds>(
    key: K,
    value: CornerCalibrationThresholds[K]
  ) => {
    const next = { ...thresholds, [key]: value };
    // Enforce safe ordering: obstacleStopMm always stays <= cornerStopMm - 40
    if (key === 'obstacleStopMm' && next.obstacleStopMm > next.cornerStopMm - 40) {
      next.cornerStopMm = Math.min(1200, next.obstacleStopMm + 40);
    }
    if (key === 'cornerStopMm' && next.cornerStopMm < next.obstacleStopMm + 40) {
      next.obstacleStopMm = Math.max(180, next.cornerStopMm - 40);
    }
    onChangeThresholds(next);
  };

  return (
    <div className="space-y-6">
      {/* Calibration Sub-Module Header */}
      <section className="bg-white border border-emerald-900/10 rounded-lg p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-emerald-700">
            <Sliders className="w-4 h-4" />
            <span>MAIXSENSE-A075V CORNER CALIBRATION SUB-MODULE</span>
            <span className="text-slate-300">|</span>
            <span>
              {sensorSource === 'live_ws'
                ? liveConnected
                  ? `LIVE STREAM (${liveFps.toFixed(1)} fps · Frame #${liveFrameId})`
                  : 'LIVE STREAM WAITING'
                : benchAutoSweep
                ? 'BENCH AUTO-SWEEP ACTIVE'
                : 'BENCH SENSOR MONITOR'}
            </span>
          </div>
          <h2 className="text-lg font-semibold text-emerald-950">
            Real-Time Corner Detection Visualizer &amp; Sensitivity Threshold Tuning
          </h2>
          <p className="text-sm text-slate-600 max-w-3xl">
            Watch live Left, Center, Min-p10, and Right ToF millimeter streams against your trigger
            thresholds in real time. Tune sensitivity sliders until corners confirm cleanly without
            false triggers, then export directly into <span className="font-mono">simpla_bot/config.yaml</span>.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {sensorSource === 'sim' && (
            <button
              onClick={() => {
                setBenchAutoSweep((v) => !v);
                onLogEvent(
                  `[Calibration] ${!benchAutoSweep ? 'Started' : 'Stopped'} synthetic MaixSense corner-approach sweep.`
                );
              }}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer ${
                benchAutoSweep
                  ? 'bg-amber-600 hover:bg-amber-700 text-white'
                  : 'bg-emerald-700 hover:bg-emerald-800 text-white'
              }`}
            >
              {benchAutoSweep ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
              <span>{benchAutoSweep ? 'Stop Bench Sweep' : 'Run Corner Sweep'}</span>
            </button>
          )}
          <button
            onClick={injectSingleFrameSpike}
            className="px-3 py-1.5 rounded-md border border-amber-300 bg-amber-50 hover:bg-amber-100 text-amber-900 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
          >
            <Zap className="w-3.5 h-3.5" />
            <span>Test 1-Frame Noise</span>
          </button>
          <button
            onClick={() => setStreamPaused((p) => !p)}
            className="px-3 py-1.5 rounded-md border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 text-xs font-semibold cursor-pointer"
          >
            {streamPaused ? 'Resume Graph' : 'Freeze Graph'}
          </button>
        </div>
      </section>

      {/* Main 12-Col Layout: Real-Time Oscilloscope + Margin Bars (7 cols) | Threshold Sliders + Export (5 cols) */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* LEFT: Real-Time Corner Oscilloscope & Margin Diagnostics */}
        <section className="xl:col-span-7 bg-white border border-emerald-900/10 rounded-lg p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-emerald-700" />
              <h3 className="text-base font-semibold text-emerald-950">
                Real-Time MaixSense Depth Stream vs. Corner Thresholds
              </h3>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono">
              <span className="flex items-center gap-1 text-sky-700">
                <span className="w-2.5 h-0.5 bg-sky-600 inline-block" /> Left
              </span>
              <span className="flex items-center gap-1 text-emerald-800 font-semibold">
                <span className="w-2.5 h-0.5 bg-emerald-700 inline-block" /> Center
              </span>
              <span className="flex items-center gap-1 text-violet-700">
                <span className="w-2.5 h-0.5 bg-violet-600 inline-block" /> Right
              </span>
              <span className="flex items-center gap-1 text-rose-700">
                <span className="w-2.5 h-0.5 bg-rose-600 inline-block" /> Min p10
              </span>
            </div>
          </div>

          {/* Live SVG Oscilloscope */}
          <div className="bg-[#F7FAF8] border border-emerald-900/10 rounded-lg p-3">
            <svg viewBox={`0 0 ${chartW} ${chartH}`} className="w-full h-auto">
              {/* Horizontal depth grid lines */}
              {[0, 600, 1200, 1800, 2400].map((mm) => {
                const y = yForMm(mm);
                return (
                  <g key={mm}>
                    <line
                      x1={padL}
                      y1={y}
                      x2={chartW - padR}
                      y2={y}
                      stroke="#dce5df"
                      strokeWidth="0.8"
                    />
                    <text
                      x={padL - 5}
                      y={y + 3}
                      textAnchor="end"
                      fontSize="8.5"
                      fill="#64748b"
                      fontFamily="monospace"
                    >
                      {mm}
                    </text>
                  </g>
                );
              })}

              {/* Shaded corner/obstacle trigger windows */}
              {triggerBands.map((b) => (
                <rect
                  key={b.key}
                  x={b.x}
                  y={padT}
                  width={b.w}
                  height={innerH}
                  fill={b.color}
                />
              ))}

              {/* Interactive Threshold Lines */}
              {[
                {
                  mm: thresholds.headlandOpenMm,
                  color: '#64748b',
                  dash: '2 3',
                  tag: `HEADLAND ${thresholds.headlandOpenMm}`,
                },
                {
                  mm: thresholds.cornerOpenSideMm,
                  color: '#059669',
                  dash: '5 3',
                  tag: `OPEN SIDE ${thresholds.cornerOpenSideMm}`,
                },
                {
                  mm: thresholds.cornerStopMm,
                  color: '#d97706',
                  dash: '5 3',
                  tag: `CORNER STOP ${thresholds.cornerStopMm}`,
                },
                {
                  mm: thresholds.obstacleStopMm,
                  color: '#e11d48',
                  dash: '3 2',
                  tag: `OBSTACLE ${thresholds.obstacleStopMm}`,
                },
              ].map((t) => {
                const y = yForMm(t.mm);
                return (
                  <g key={t.tag}>
                    <line
                      x1={padL}
                      y1={y}
                      x2={chartW - padR}
                      y2={y}
                      stroke={t.color}
                      strokeWidth="1.2"
                      strokeDasharray={t.dash}
                    />
                    <text
                      x={chartW - padR - 3}
                      y={y - 3}
                      textAnchor="end"
                      fontSize="7.8"
                      fill={t.color}
                      fontFamily="monospace"
                      fontWeight="bold"
                    >
                      {t.tag}mm
                    </text>
                  </g>
                );
              })}

              {/* Live Sensor Depth Curves */}
              {samples.length > 1 && (
                <>
                  <path d={leftPath} fill="none" stroke="#0284c7" strokeWidth="1.5" opacity="0.85" />
                  <path d={rightPath} fill="none" stroke="#7c3aed" strokeWidth="1.5" opacity="0.85" />
                  <path
                    d={minPath}
                    fill="none"
                    stroke="#e11d48"
                    strokeWidth="1.2"
                    strokeDasharray="2 2"
                    opacity="0.85"
                  />
                  <path d={centerPath} fill="none" stroke="#047857" strokeWidth="2.3" />
                </>
              )}

              {/* Axis label */}
              <text
                x={padL}
                y={chartH - 6}
                fontSize="8.5"
                fill="#64748b"
                fontFamily="monospace"
              >
                ← Older frames ({samples.length}/{MAX_SAMPLES} buffered)
              </text>
              <text
                x={chartW - padR}
                y={chartH - 6}
                textAnchor="end"
                fontSize="8.5"
                fill="#0f172a"
                fontFamily="monospace"
              >
                NOW (mm) →
              </text>
            </svg>
          </div>

          {/* Live Classification & Debounce Strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
            <div className="p-2.5 rounded-md bg-slate-50 border border-slate-200">
              <div className="text-[10px] font-mono text-slate-500 uppercase">Raw Frame</div>
              <div className="text-xs font-mono font-bold text-slate-800 mt-0.5">{rawCorner}</div>
            </div>
            <div
              className={`p-2.5 rounded-md border ${
                confirmedCorner === 'OBSTACLE_STOP'
                  ? 'bg-rose-50 border-rose-300 text-rose-900'
                  : confirmedCorner !== 'NONE'
                  ? 'bg-amber-50 border-amber-300 text-amber-950'
                  : 'bg-emerald-50 border-emerald-200 text-emerald-950'
              }`}
            >
              <div className="text-[10px] font-mono opacity-75 uppercase">Confirmed State</div>
              <div className="text-xs font-mono font-bold mt-0.5">{confirmedCorner}</div>
            </div>
            <div className="p-2.5 rounded-md bg-slate-50 border border-slate-200">
              <div className="text-[10px] font-mono text-slate-500 uppercase">Debounce Streak</div>
              <div className="text-xs font-mono font-bold text-emerald-800 mt-0.5">
                {confirmStreak} / {thresholds.confirmFramesRequired} frames
              </div>
              <div className="h-1.5 w-full bg-slate-200 rounded overflow-hidden mt-1">
                <div
                  className="h-full bg-emerald-600 transition-all"
                  style={{
                    width: `${Math.min(
                      100,
                      (confirmStreak / Math.max(1, thresholds.confirmFramesRequired)) * 100
                    )}%`,
                  }}
                />
              </div>
            </div>
            <div className="p-2.5 rounded-md bg-slate-50 border border-slate-200">
              <div className="text-[10px] font-mono text-slate-500 uppercase">Turn / Travel</div>
              <div className="text-xs font-mono font-bold text-slate-900 mt-0.5">
                {suggestedTurn} · {recommendedTravelMm}mm
              </div>
            </div>
          </div>

          {/* Decision Margin Bars */}
          <div className="space-y-2 pt-1">
            <div className="text-xs font-semibold text-slate-800">
              Live Threshold Margin Diagnostics
            </div>
            <div className="space-y-2">
              {margins.map((m) => {
                const absDelta = Math.abs(m.value);
                const pct = Math.min(100, Math.round((absDelta / 1000) * 100));
                const badgeText = m.positiveIsOpen
                  ? m.triggered
                    ? 'OPEN / MET'
                    : 'CLOSED'
                  : m.triggered
                  ? 'TRIGGERED'
                  : 'CLEAR';
                const badgeClass = m.positiveIsOpen
                  ? m.triggered
                    ? 'bg-emerald-100 text-emerald-800'
                    : 'bg-slate-200 text-slate-700'
                  : m.triggered
                  ? 'bg-rose-100 text-rose-800'
                  : 'bg-emerald-100 text-emerald-800';
                return (
                  <div
                    key={m.label}
                    className="rounded border border-slate-200 bg-[#F9FBFA] px-3 py-2 space-y-1"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="font-medium text-slate-800">{m.label}</span>
                      <div className="flex items-center gap-2 font-mono text-[11px]">
                        <span className="text-slate-600">{m.detail}</span>
                        <span className={`px-1.5 py-0.5 rounded font-bold text-[10px] ${badgeClass}`}>
                          {badgeText} ({m.value >= 0 ? `+${m.value}` : m.value}mm)
                        </span>
                      </div>
                    </div>
                    <div className="h-1.5 w-full bg-slate-200 rounded overflow-hidden">
                      <div
                        className={`h-full transition-all ${
                          m.positiveIsOpen
                            ? m.triggered
                              ? 'bg-emerald-600'
                              : 'bg-slate-400'
                            : m.triggered
                            ? 'bg-rose-500'
                            : 'bg-emerald-600'
                        }`}
                        style={{ width: `${Math.max(8, pct)}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* RIGHT: Sensitivity Sliders, Presets & config.yaml Export */}
        <section className="xl:col-span-5 space-y-5">
          {/* Sensitivity Profile Presets */}
          <div className="bg-white border border-emerald-900/10 rounded-lg p-5 space-y-4">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-emerald-700" />
                <h3 className="text-base font-semibold text-emerald-950">
                  Corner Sensitivity Presets &amp; Thresholds
                </h3>
              </div>
              <button
                onClick={() => {
                  onChangeThresholds(DEFAULT_CORNER_THRESHOLDS);
                  onLogEvent('[Calibration] Reset corner thresholds to config.yaml defaults.');
                }}
                className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-emerald-800 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {SENSITIVITY_PRESETS.map((p) => {
                const isActive =
                  thresholds.cornerStopMm === p.values.cornerStopMm &&
                  thresholds.obstacleStopMm === p.values.obstacleStopMm &&
                  thresholds.cornerOpenSideMm === p.values.cornerOpenSideMm &&
                  thresholds.confirmFramesRequired === p.values.confirmFramesRequired;
                return (
                  <button
                    key={p.id}
                    onClick={() => {
                      onChangeThresholds(p.values);
                      onLogEvent(`[Calibration] Applied sensitivity preset: ${p.label}`);
                    }}
                    className={`p-2.5 rounded-md border text-left transition-colors cursor-pointer ${
                      isActive
                        ? 'bg-emerald-700 text-white border-emerald-700'
                        : 'bg-[#F7FAF8] text-slate-800 border-emerald-900/15 hover:bg-emerald-50'
                    }`}
                  >
                    <div className="text-xs font-semibold">{p.label}</div>
                    <div className={`text-[10px] mt-0.5 ${isActive ? 'text-emerald-100' : 'text-slate-500'}`}>
                      {p.desc}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* 6 Live Sensitivity Sliders */}
            <div className="space-y-3 pt-1">
              {[
                {
                  key: 'cornerStopMm' as const,
                  label: 'Corner Trigger Distance (corner_stop_mm)',
                  hint: 'Front depth where bot stops & inspects L/R for a corner',
                  min: 300,
                  max: 1200,
                  step: 10,
                  unit: 'mm',
                  accent: 'accent-amber-600',
                },
                {
                  key: 'obstacleStopMm' as const,
                  label: 'Hard Obstacle Halt (obstacle_stop_mm)',
                  hint: 'Immediate zero-debounce halt if Center p10 drops below this',
                  min: 180,
                  max: 600,
                  step: 10,
                  unit: 'mm',
                  accent: 'accent-rose-600',
                },
                {
                  key: 'cornerOpenSideMm' as const,
                  label: 'Open Side Clearance (corner_open_side_mm)',
                  hint: 'Minimum Left or Right depth to classify a side as OPEN for 90° turn',
                  min: 650,
                  max: 2000,
                  step: 25,
                  unit: 'mm',
                  accent: 'accent-emerald-700',
                },
                {
                  key: 'sideAsymmetryMm' as const,
                  label: 'T-Junction Asymmetry (side_asymmetry_mm)',
                  hint: 'Required |R - L| gap to prefer one branch at a T-junction',
                  min: 100,
                  max: 600,
                  step: 20,
                  unit: 'mm',
                  accent: 'accent-emerald-700',
                },
                {
                  key: 'headlandOpenMm' as const,
                  label: 'Row-End Headland Open (headland_open_mm)',
                  hint: 'All 3 zones above this triggers ROW_END_HEADLAND U-turn',
                  min: 1400,
                  max: 2300,
                  step: 25,
                  unit: 'mm',
                  accent: 'accent-slate-700',
                },
                {
                  key: 'confirmFramesRequired' as const,
                  label: 'Corner Debounce Frames',
                  hint: 'Consecutive confirming frames required to ignore ToF speckle',
                  min: 1,
                  max: 6,
                  step: 1,
                  unit: 'frames',
                  accent: 'accent-emerald-700',
                },
              ].map((ctrl) => (
                <div key={ctrl.key} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-slate-800">{ctrl.label}</span>
                    <span className="font-mono font-bold text-emerald-900">
                      {thresholds[ctrl.key]} {ctrl.unit}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={ctrl.min}
                    max={ctrl.max}
                    step={ctrl.step}
                    value={thresholds[ctrl.key]}
                    onChange={(e) => updateThreshold(ctrl.key, Number(e.target.value))}
                    className={`w-full ${ctrl.accent}`}
                  />
                  <div className="text-[11px] text-slate-500">{ctrl.hint}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Export Calibrated YAML Snippet */}
          <div className="bg-white border border-emerald-900/10 rounded-lg p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold text-emerald-950">
                Export to <span className="font-mono text-emerald-700">simpla_bot/config.yaml</span>
              </div>
              <button
                onClick={() => void copyYamlConfig()}
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-semibold cursor-pointer"
              >
                {copiedYaml ? (
                  <>
                    <Check className="w-3.5 h-3.5" />
                    Copied YAML
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    Copy YAML
                  </>
                )}
              </button>
            </div>
            <pre className="bg-[#F4F8F5] border border-emerald-900/10 rounded p-3 text-xs font-mono text-slate-800 overflow-x-auto leading-relaxed">
              {yamlSnippet}
            </pre>
          </div>
        </section>
      </div>
    </div>
  );
};
