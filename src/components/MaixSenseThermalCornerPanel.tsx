import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Cpu,
  ExternalLink,
  Flame,
  Radar,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Thermometer,
} from 'lucide-react';

export interface MaixSenseThermalState {
  leftMm: number;
  centerMm: number;
  minCenterMm: number;
  rightMm: number;
  cornerClass:
    | 'CLEAR_CORRIDOR'
    | 'LEFT_CORNER'
    | 'RIGHT_CORNER'
    | 'T_JUNCTION'
    | 'ROW_END_HEADLAND'
    | 'OBSTACLE_STOP';
  suggestedAction: string;
  nozzleTempC: number;
  cropMarginTempC: number;
  piCpuTempC: number;
  driverTempC: number;
  thermalAlert: boolean;
}

interface MaixSenseThermalCornerPanelProps {
  roverX: number;
  roverY: number;
  roverYawDeg: number;
  roverPhase: string;
  collisionState: string;
  rowEndConf: number;
  onDiagnosticsChange?: (state: MaixSenseThermalState) => void;
  onLogEvent: (msg: string) => void;
}

type BenchScenario = 'live_sim' | 'left_corner' | 'right_corner' | 't_junction' | 'headland' | 'obstacle';

export interface HuggingFaceModelInfo {
  id: string;
  name: string;
  role: string;
  repoFile: string;
  url: string;
  whyNeeded: string;
  targetHardware: string;
}

export const HUGGING_FACE_MODELS: HuggingFaceModelInfo[] = [
  {
    id: 'dinov2',
    name: 'facebook/dinov2-small',
    role: 'Self-Supervised Plant Texture & Morphology Extractor (384-D)',
    repoFile: 'Weed_Detection/src/dino_features.py',
    url: 'https://huggingface.co/facebook/dinov2-small',
    whyNeeded:
      'Separates visually similar broadleaf weeds from young tomato seedlings under harsh outdoor shadows, wet soil, and mud without requiring tens of thousands of hand-labeled farm images.',
    targetHardware: 'Training / Verification + Embedding Index',
  },
  {
    id: 'clip',
    name: 'openai/clip-vit-base-patch32',
    role: 'Zero-Shot Weed Species Classifier via Text Prompts',
    repoFile: 'Weed_Detection/src/clip_classifier.py',
    url: 'https://huggingface.co/openai/clip-vit-base-patch32',
    whyNeeded:
      'Lets farmers identify new regional weed species (purslane, amaranth, dandelion, grass) using plain text descriptions immediately—preventing the flame/laser from misclassifying unfamiliar crops.',
    targetHardware: 'Zero-Shot Verification Stage',
  },
  {
    id: 'yolov8',
    name: 'Ultralytics/YOLOv8 (yolov8n.pt)',
    role: 'Real-Time Weed Bounding-Box & Coordinate Detector',
    repoFile: 'Weed_Detection/src/train_yolo.py',
    url: 'https://huggingface.co/Ultralytics/YOLOv8',
    whyNeeded:
      'Produces fast (u, v) pixel bounding boxes at field framerate on Raspberry Pi 4/5 (via NCNN export) so the homography matrix can lock the butane flame barrel or gantry right onto the weed stem.',
    targetHardware: 'Raspberry Pi 4/5 (NCNN Live Inference)',
  },
  {
    id: 'efficientnet',
    name: 'timm/efficientnet_b0.ra_in1k',
    role: 'Fine-Tuned Crop-Protection Safety Verifier',
    repoFile: 'Weed_Detection/src/train_weed_model.py',
    url: 'https://huggingface.co/timm/efficientnet_b0.ra_in1k',
    whyNeeded:
      'Acts as a lightweight second-stage safety gate on every detected plant crop box: the valve servo and HV arc igniter only fire when both YOLO and EfficientNet agree the target is a weed, not a tomato/chili crop.',
    targetHardware: 'Edge Safety Verification Gate',
  },
];

function tempToThermalRgb(tempC: number): [number, number, number] {
  // Ironbow-inspired palette: 24°C (deep navy) -> 45°C (violet) -> 180°C (crimson) -> 420°C (amber) -> 600°C (white-yellow)
  const norm = Math.max(0, Math.min(1, (tempC - 24) / 480));
  if (norm < 0.2) {
    const t = norm / 0.2;
    return [Math.round(20 + 65 * t), Math.round(25 + 15 * t), Math.round(85 + 75 * t)];
  }
  if (norm < 0.48) {
    const t = (norm - 0.2) / 0.28;
    return [Math.round(85 + 145 * t), Math.round(40 + 20 * t), Math.round(160 - 115 * t)];
  }
  if (norm < 0.78) {
    const t = (norm - 0.48) / 0.3;
    return [Math.round(230 + 25 * t), Math.round(60 + 145 * t), Math.round(45 - 30 * t)];
  }
  const t = (norm - 0.78) / 0.22;
  return [255, Math.round(205 + 48 * t), Math.round(15 + 215 * t)];
}

export const MaixSenseThermalCornerPanel: React.FC<MaixSenseThermalCornerPanelProps> = ({
  roverX,
  roverY,
  roverPhase,
  collisionState,
  rowEndConf,
  onDiagnosticsChange,
  onLogEvent,
}) => {
  const [scenario, setScenario] = useState<BenchScenario>('live_sim');
  const [cornerStopMm, setCornerStopMm] = useState<number>(520);
  const [openSideMm, setOpenSideMm] = useState<number>(1050);
  const [sideAsymMm, setSideAsymMm] = useState<number>(280);
  const [maxNozzleTempC, setMaxNozzleTempC] = useState<number>(600);
  const [maxCropTempC, setMaxCropTempC] = useState<number>(42);
  const [overheatTest, setOverheatTest] = useState<boolean>(false);
  const [pulseTick, setPulseTick] = useState<number>(0);

  const thermalCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const id = window.setInterval(() => setPulseTick((t) => (t + 1) % 10000), 350);
    return () => window.clearInterval(id);
  }, []);

  const diagnostics: MaixSenseThermalState = useMemo(() => {
    const jitter = Math.round(Math.sin(pulseTick * 0.9) * 14);

    // 1. Compute MaixSense-A075V Left / Center / Right ToF depth zones
    let leftMm = 740 + jitter;
    let centerMm = 1480 - Math.round(rowEndConf * 350) + jitter;
    let rightMm = 760 - jitter;

    if (scenario === 'live_sim') {
      if (collisionState === 'STOP') {
        centerMm = 265 + jitter;
        leftMm = 720 + jitter;
        rightMm = 710 - jitter;
      } else if (roverPhase === 'ROW_END_STOP' || rowEndConf > 0.78) {
        leftMm = 1940 + jitter;
        centerMm = 2050 + jitter;
        rightMm = 1980 - jitter;
      } else if (roverPhase === 'NAV2_HEADLAND_TURN') {
        leftMm = 1620 + jitter;
        centerMm = 470 + jitter;
        rightMm = 610 - jitter;
      } else {
        // Use actual field position to reveal natural left/right boundary proximity
        const nearTopEdge = roverY < 1.05;
        const nearBottomEdge = roverY > 2.45;
        const nearEastEnd = roverX > 8.7;
        const nearWestEnd = roverX < 1.5;
        if (nearEastEnd || nearWestEnd) {
          centerMm = 480 + jitter;
          leftMm = nearTopEdge ? 580 + jitter : 1420 + jitter;
          rightMm = nearBottomEdge ? 580 - jitter : 1440 - jitter;
        }
      }
    } else if (scenario === 'left_corner') {
      leftMm = 1680 + jitter;
      centerMm = 440 + jitter;
      rightMm = 540 - jitter;
    } else if (scenario === 'right_corner') {
      leftMm = 530 + jitter;
      centerMm = 455 + jitter;
      rightMm = 1710 - jitter;
    } else if (scenario === 't_junction') {
      leftMm = 1520 + jitter;
      centerMm = 430 + jitter;
      rightMm = 1590 - jitter;
    } else if (scenario === 'headland') {
      leftMm = 2020 + jitter;
      centerMm = 2140 + jitter;
      rightMm = 2060 - jitter;
    } else if (scenario === 'obstacle') {
      leftMm = 690 + jitter;
      centerMm = 240 + jitter;
      rightMm = 720 - jitter;
    }

    const minCenterMm = Math.max(120, centerMm - 28);

    // 2. Classify MaixSense Corner Geometry
    let cornerClass: MaixSenseThermalState['cornerClass'] = 'CLEAR_CORRIDOR';
    let suggestedAction = 'Continue furrow tracking at nominal speed';

    if (minCenterMm <= 320) {
      cornerClass = 'OBSTACLE_STOP';
      suggestedAction = 'Immediate OBSTACLE_HOLD (< 320 mm)';
    } else if (leftMm >= 1850 && centerMm >= 1850 && rightMm >= 1850) {
      cornerClass = 'ROW_END_HEADLAND';
      suggestedAction = 'Row end open headland -> Stage 180° Boustrophedon U-Turn';
    } else if (centerMm <= cornerStopMm) {
      const leftOpen = leftMm >= openSideMm;
      const rightOpen = rightMm >= openSideMm;
      const asym = Math.abs(rightMm - leftMm);
      if (leftOpen && rightOpen && asym < sideAsymMm) {
        cornerClass = 'T_JUNCTION';
        suggestedAction = 'T-Junction detected -> Yield & follow mission turn side';
      } else if (leftOpen && (!rightOpen || leftMm > rightMm + sideAsymMm)) {
        cornerClass = 'LEFT_CORNER';
        suggestedAction = 'Left corridor open -> Execute 90° LEFT corner pivot';
      } else if (rightOpen && (!leftOpen || rightMm > leftMm + sideAsymMm)) {
        cornerClass = 'RIGHT_CORNER';
        suggestedAction = 'Right corridor open -> Execute 90° RIGHT corner pivot';
      } else {
        cornerClass = 'OBSTACLE_STOP';
        suggestedAction = 'Dead-end wall ahead -> Halt & await operator clearance';
      }
    }

    // 3. Thermal / Temperature Check (MLX90614 / AMG8833 IR + Pi 4 SoC + L298N)
    const treating = roverPhase === 'TREATMENT_HOOK_HOLD';
    const nozzleBase = overheatTest ? 645 : treating ? 495 : 58;
    const nozzleTempC = Number((nozzleBase + Math.sin(pulseTick * 0.7) * 8).toFixed(1));
    const cropMarginTempC = Number(
      ((overheatTest ? 46.5 : treating ? 34.8 : 28.4) + Math.cos(pulseTick * 0.5) * 0.9).toFixed(1)
    );
    const piCpuTempC = Number((54.2 + (treating ? 4.8 : 1.2) + Math.sin(pulseTick * 0.3) * 1.4).toFixed(1));
    const driverTempC = Number((43.5 + (roverPhase === 'FOLLOW_CROP_ROW' ? 5.2 : 1.1) + Math.cos(pulseTick * 0.4) * 1.1).toFixed(1));

    const thermalAlert = nozzleTempC >= maxNozzleTempC || cropMarginTempC >= maxCropTempC;

    return {
      leftMm,
      centerMm,
      minCenterMm,
      rightMm,
      cornerClass,
      suggestedAction,
      nozzleTempC,
      cropMarginTempC,
      piCpuTempC,
      driverTempC,
      thermalAlert,
    };
  }, [
    pulseTick,
    scenario,
    collisionState,
    roverPhase,
    rowEndConf,
    roverX,
    roverY,
    cornerStopMm,
    openSideMm,
    sideAsymMm,
    maxNozzleTempC,
    maxCropTempC,
    overheatTest,
  ]);

  useEffect(() => {
    onDiagnosticsChange?.(diagnostics);
  }, [diagnostics, onDiagnosticsChange]);

  // Draw live 8x8 AMG8833 / MLX90614 Thermal Matrix Canvas
  useEffect(() => {
    const canvas = thermalCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cols = 8;
    const rows = 8;
    const cellW = canvas.width / cols;
    const cellH = canvas.height / rows;
    const hotSpotX = 3.5 + Math.sin(pulseTick * 0.4) * 0.25;
    const hotSpotY = 3.5 + Math.cos(pulseTick * 0.35) * 0.25;
    const peak = diagnostics.nozzleTempC;
    const ambient = 29.0;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const d = Math.hypot(c - hotSpotX, r - hotSpotY);
        const falloff = Math.exp(-(d * d) / (peak > 150 ? 2.4 : 4.2));
        const cellTemp = ambient + (peak - ambient) * falloff + ((r + c) % 2) * 0.6;
        const [red, grn, blu] = tempToThermalRgb(cellTemp);
        ctx.fillStyle = `rgb(${red}, ${grn}, ${blu})`;
        ctx.fillRect(c * cellW, r * cellH, cellW + 0.5, cellH + 0.5);
      }
    }

    // Center nozzle crosshair
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 1.2;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    ctx.beginPath();
    ctx.moveTo(cx - 10, cy);
    ctx.lineTo(cx + 10, cy);
    ctx.moveTo(cx, cy - 10);
    ctx.lineTo(cx, cy + 10);
    ctx.stroke();

    // Crop thermal safety border rings (left & right ridges)
    ctx.strokeStyle = diagnostics.cropMarginTempC >= maxCropTempC ? '#FB7185' : '#6EE7B7';
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(4, 4, 24, canvas.height - 8);
    ctx.strokeRect(canvas.width - 28, 4, 24, canvas.height - 8);
    ctx.setLineDash([]);
  }, [diagnostics, maxCropTempC, pulseTick]);

  return (
    <div className="space-y-5">
      {/* Row 1: MaixSense-A075V Corner Check + Thermal/Temperature Guard */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* MaixSense-A075V Depth & Corner Diagnostics */}
        <section className="lg:col-span-6 bg-white border border-emerald-900/10 rounded-lg p-4 space-y-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Radar className="w-4 h-4 text-emerald-700" />
              <h3 className="text-sm font-semibold text-slate-900">
                MaixSense-A075V ToF &amp; Corner Verification
              </h3>
            </div>
            <span className="px-2 py-0.5 text-[10px] font-mono font-semibold rounded bg-emerald-50 border border-emerald-200 text-emerald-800">
              192.168.233.1 · /getdeep
            </span>
          </div>

          <p className="text-xs text-slate-600 leading-relaxed">
            Checks Left, Center, Min-p10, and Right 16-bit ToF depth zones simultaneously so the rover distinguishes true 90° field corners, T-junctions, and open headlands from sudden obstacles.
          </p>

          {/* Bench Corner Test Selector */}
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            {(
              [
                { id: 'live_sim', label: 'Live Rover Pose' },
                { id: 'left_corner', label: 'Test Left Corner' },
                { id: 'right_corner', label: 'Test Right Corner' },
                { id: 't_junction', label: 'T-Junction' },
                { id: 'headland', label: 'Headland End' },
                { id: 'obstacle', label: 'Obstacle 240mm' },
              ] as const
            ).map((btn) => (
              <button
                key={btn.id}
                type="button"
                onClick={() => {
                  setScenario(btn.id);
                  onLogEvent(`[MaixSense] Corner check scenario set to ${btn.label}.`);
                }}
                className={`px-2 py-1 rounded border font-medium cursor-pointer transition-colors ${
                  scenario === btn.id
                    ? 'bg-emerald-700 text-white border-emerald-700'
                    : 'bg-[#F8FBF9] text-slate-700 border-slate-200 hover:bg-emerald-50'
                }`}
              >
                {btn.label}
              </button>
            ))}
          </div>

          {/* 3-Zone ToF Millimeter Bars */}
          <div className="grid grid-cols-3 gap-2.5">
            {[
              { label: 'LEFT ZONE', mm: diagnostics.leftMm, open: diagnostics.leftMm >= openSideMm, color: 'bg-sky-600' },
              { label: 'CENTER / p10', mm: diagnostics.centerMm, open: diagnostics.centerMm > cornerStopMm, color: diagnostics.centerMm <= cornerStopMm ? 'bg-amber-600' : 'bg-emerald-600' },
              { label: 'RIGHT ZONE', mm: diagnostics.rightMm, open: diagnostics.rightMm >= openSideMm, color: 'bg-violet-600' },
            ].map((z) => {
              const pct = Math.min(100, Math.round((z.mm / 2200) * 100));
              return (
                <div key={z.label} className="rounded-md bg-[#F7FAF8] border border-emerald-900/10 p-2.5 space-y-1.5">
                  <div className="text-[10px] font-mono text-slate-500">{z.label}</div>
                  <div className="text-base font-mono font-bold tabular-nums text-slate-900">
                    {z.mm} <span className="text-[11px] font-normal text-slate-500">mm</span>
                  </div>
                  <div className="h-1.5 w-full bg-slate-200 rounded overflow-hidden">
                    <div className={`h-full ${z.color} transition-all`} style={{ width: `${pct}%` }} />
                  </div>
                  <div className="text-[10px] font-mono font-semibold text-slate-600">
                    {z.label === 'CENTER / p10'
                      ? z.mm <= cornerStopMm
                        ? 'WALL / CORNER'
                        : 'CLEAR AHEAD'
                      : z.open
                      ? 'OPEN CORRIDOR'
                      : 'WALL / CROP'}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Corner Classification Banner */}
          <div
            className={`rounded-md border px-3 py-2 flex items-center justify-between gap-2 text-xs ${
              diagnostics.cornerClass === 'OBSTACLE_STOP'
                ? 'bg-rose-50 border-rose-300 text-rose-900'
                : diagnostics.cornerClass === 'CLEAR_CORRIDOR'
                ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                : 'bg-amber-50 border-amber-300 text-amber-950'
            }`}
          >
            <div>
              <span className="font-mono font-bold">{diagnostics.cornerClass}</span>
              <span className="mx-1.5 opacity-40">·</span>
              <span>{diagnostics.suggestedAction}</span>
            </div>
          </div>

          {/* Inline Corner Sensitivity Tuners */}
          <div className="grid grid-cols-3 gap-2.5 pt-1 text-[11px]">
            <label className="space-y-1">
              <div className="flex justify-between font-mono text-slate-600">
                <span>Stop</span>
                <strong>{cornerStopMm}mm</strong>
              </div>
              <input
                type="range"
                min={340}
                max={900}
                step={20}
                value={cornerStopMm}
                onChange={(e) => setCornerStopMm(Number(e.target.value))}
                className="w-full accent-amber-600 cursor-pointer"
              />
            </label>
            <label className="space-y-1">
              <div className="flex justify-between font-mono text-slate-600">
                <span>Open Side</span>
                <strong>{openSideMm}mm</strong>
              </div>
              <input
                type="range"
                min={700}
                max={1600}
                step={25}
                value={openSideMm}
                onChange={(e) => setOpenSideMm(Number(e.target.value))}
                className="w-full accent-emerald-700 cursor-pointer"
              />
            </label>
            <label className="space-y-1">
              <div className="flex justify-between font-mono text-slate-600">
                <span>|R-L| Asym</span>
                <strong>{sideAsymMm}mm</strong>
              </div>
              <input
                type="range"
                min={120}
                max={500}
                step={20}
                value={sideAsymMm}
                onChange={(e) => setSideAsymMm(Number(e.target.value))}
                className="w-full accent-emerald-700 cursor-pointer"
              />
            </label>
          </div>
        </section>

        {/* Thermal & Temperature Safety Monitor */}
        <section className="lg:col-span-6 bg-white border border-emerald-900/10 rounded-lg p-4 space-y-3.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Thermometer className="w-4 h-4 text-orange-600" />
              <h3 className="text-sm font-semibold text-slate-900">
                IR Thermal &amp; Temperature Safety Monitor
              </h3>
            </div>
            <button
              type="button"
              onClick={() => {
                const next = !overheatTest;
                setOverheatTest(next);
                onLogEvent(
                  next
                    ? '[Thermal Guard] Simulated nozzle/crop overheat (> 600°C / 42°C) — butane valve safety interlock triggered!'
                    : '[Thermal Guard] Cleared overheat test — thermal probes nominal.'
                );
              }}
              className={`px-2.5 py-1 rounded text-[11px] font-semibold border cursor-pointer transition-colors ${
                overheatTest
                  ? 'bg-rose-600 text-white border-rose-600'
                  : 'bg-orange-50 hover:bg-orange-100 text-orange-800 border-orange-200'
              }`}
            >
              {overheatTest ? 'Clear Overheat Test' : 'Test Thermal Cutout'}
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-center">
            {/* Live 8x8 AMG8833 / MLX90614 Heatmap */}
            <div className="sm:col-span-5 space-y-1.5">
              <div className="rounded-lg overflow-hidden border border-slate-200 bg-slate-950 p-1">
                <canvas
                  ref={thermalCanvasRef}
                  width={160}
                  height={128}
                  className="w-full h-auto block rounded"
                />
              </div>
              <div className="flex items-center justify-between text-[10px] font-mono text-slate-500">
                <span>24°C Soil</span>
                <span>AMG8833 8×8 IR</span>
                <span>600°C Flame</span>
              </div>
            </div>

            {/* 4 Live Temperature Probes */}
            <div className="sm:col-span-7 grid grid-cols-2 gap-2">
              <div
                className={`p-2.5 rounded-md border ${
                  diagnostics.nozzleTempC >= maxNozzleTempC
                    ? 'bg-rose-50 border-rose-300'
                    : 'bg-[#F7FAF8] border-emerald-900/10'
                }`}
              >
                <div className="flex items-center gap-1 text-[10px] font-mono text-slate-500">
                  <Flame className="w-3 h-3 text-orange-600" />
                  <span>NOZZLE / WEED</span>
                </div>
                <div className="text-base font-mono font-bold tabular-nums text-slate-900 mt-0.5">
                  {diagnostics.nozzleTempC}°C
                </div>
                <div className="text-[10px] text-slate-500">Limit {maxNozzleTempC}°C</div>
              </div>

              <div
                className={`p-2.5 rounded-md border ${
                  diagnostics.cropMarginTempC >= maxCropTempC
                    ? 'bg-rose-50 border-rose-300'
                    : 'bg-[#F7FAF8] border-emerald-900/10'
                }`}
              >
                <div className="text-[10px] font-mono text-slate-500">CROP CANOPY EDGE</div>
                <div className="text-base font-mono font-bold tabular-nums text-emerald-800 mt-0.5">
                  {diagnostics.cropMarginTempC}°C
                </div>
                <div className="text-[10px] text-slate-500">Safe &lt; {maxCropTempC}°C</div>
              </div>

              <div className="p-2.5 rounded-md border bg-[#F7FAF8] border-emerald-900/10">
                <div className="flex items-center gap-1 text-[10px] font-mono text-slate-500">
                  <Cpu className="w-3 h-3 text-emerald-700" />
                  <span>PI 4 SOC TEMP</span>
                </div>
                <div className="text-base font-mono font-bold tabular-nums text-slate-900 mt-0.5">
                  {diagnostics.piCpuTempC}°C
                </div>
                <div className="text-[10px] text-slate-500">Throttle @ 80°C</div>
              </div>

              <div className="p-2.5 rounded-md border bg-[#F7FAF8] border-emerald-900/10">
                <div className="text-[10px] font-mono text-slate-500">L298N H-BRIDGE</div>
                <div className="text-base font-mono font-bold tabular-nums text-slate-900 mt-0.5">
                  {diagnostics.driverTempC}°C
                </div>
                <div className="text-[10px] text-slate-500">Heatsink Nominal</div>
              </div>
            </div>
          </div>

          {/* Thermal Safety Status + Cutout Sliders */}
          <div
            className={`rounded-md border px-3 py-2 flex items-center gap-2 text-xs ${
              diagnostics.thermalAlert
                ? 'bg-rose-50 border-rose-300 text-rose-900 font-semibold'
                : 'bg-emerald-50 border-emerald-200 text-emerald-900'
            }`}
          >
            {diagnostics.thermalAlert ? (
              <ShieldAlert className="w-4 h-4 text-rose-600 shrink-0" />
            ) : (
              <ShieldCheck className="w-4 h-4 text-emerald-600 shrink-0" />
            )}
            <span>
              {diagnostics.thermalAlert
                ? 'THERMAL INTERLOCK TRIPPED — Flame valve & HV igniter locked off to protect tomato canopy and deck.'
                : 'Thermal Interlock ARMED — MLX90614 IR verifies weed burn spot while keeping crop leaves below scorch limit.'}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3 text-[11px]">
            <label className="space-y-1">
              <div className="flex justify-between font-mono text-slate-600">
                <span>Nozzle Cutout</span>
                <strong>{maxNozzleTempC}°C</strong>
              </div>
              <input
                type="range"
                min={420}
                max={720}
                step={20}
                value={maxNozzleTempC}
                onChange={(e) => setMaxNozzleTempC(Number(e.target.value))}
                className="w-full accent-orange-600 cursor-pointer"
              />
            </label>
            <label className="space-y-1">
              <div className="flex justify-between font-mono text-slate-600">
                <span>Crop Margin Max</span>
                <strong>{maxCropTempC}°C</strong>
              </div>
              <input
                type="range"
                min={34}
                max={55}
                step={1}
                value={maxCropTempC}
                onChange={(e) => setMaxCropTempC(Number(e.target.value))}
                className="w-full accent-rose-600 cursor-pointer"
              />
            </label>
          </div>
        </section>
      </div>

      {/* Row 2: Hugging Face AI Model Stack & Why Each Model Is Needed */}
      <section className="bg-white border border-emerald-900/10 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-emerald-900/10 pb-3">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-amber-600" />
              <h3 className="text-sm font-semibold text-slate-900">
                Hugging Face Vision Models &amp; Why They Are Needed on the Rover
              </h3>
            </div>
            <p className="text-xs text-slate-600 mt-0.5">
              Direct links to the pretrained Hugging Face backbones wired into <span className="font-mono text-emerald-800">Weed_Detection/src/</span> that keep flame/laser targeting accurate while protecting real crops.
            </p>
          </div>
          <a
            href="https://huggingface.co/models?pipeline_tag=image-feature-extraction&search=dinov2"
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 rounded-md bg-amber-50 hover:bg-amber-100 border border-amber-300 text-amber-950 text-xs font-semibold inline-flex items-center gap-1.5"
          >
            <span>Browse on Hugging Face</span>
            <ExternalLink className="w-3.5 h-3.5" />
          </a>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
          {HUGGING_FACE_MODELS.map((m) => (
            <div
              key={m.id}
              className="rounded-lg border border-emerald-900/10 bg-[#FAFDFB] p-3.5 flex flex-col justify-between gap-2.5"
            >
              <div className="space-y-1.5">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <a
                      href={m.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-mono font-bold text-emerald-800 hover:text-emerald-600 inline-flex items-center gap-1 underline decoration-emerald-400/60"
                    >
                      <span>{m.name}</span>
                      <ExternalLink className="w-3 h-3 shrink-0" />
                    </a>
                    <div className="text-xs font-semibold text-slate-900 mt-0.5">{m.role}</div>
                  </div>
                  <span className="shrink-0 px-2 py-0.5 rounded bg-white border border-slate-200 font-mono text-[10px] text-slate-600">
                    HF Hub
                  </span>
                </div>

                <p className="text-xs text-slate-600 leading-relaxed">
                  <strong className="text-slate-800">Why it is needed:</strong> {m.whyNeeded}
                </p>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-emerald-900/10 text-[11px] font-mono text-slate-500">
                <span className="truncate">{m.repoFile}</span>
                <span className="text-emerald-700 font-medium">{m.targetHardware}</span>
              </div>
            </div>
          ))}
        </div>

        <div className="rounded-md bg-amber-50/70 border border-amber-200 px-3.5 py-2.5 flex items-start gap-2 text-xs text-amber-950">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <span>
            <strong>Why Combine Hugging Face Vision + MaixSense ToF + IR Thermal?</strong> Color-only thresholds fail under harsh sunlight or shadows; pairing <strong>DINOv2 / CLIP / YOLOv8n</strong> for species certainty with <strong>MaixSense-A075V</strong> for millimeter corner/depth geometry and <strong>MLX90614 IR Thermal</strong> for heat verification ensures weeds are eliminated safely without scorching nearby tomato stems.
          </span>
        </div>
      </section>
    </div>
  );
};
