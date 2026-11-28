import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  Check,
  ChevronLeft,
  ChevronRight,
  Compass,
  Crosshair,
  Eye,
  ShieldAlert,
  Sprout,
  Wrench,
  X,
} from 'lucide-react';
import { CROP_FIELDS, CROP_FIELD_BY_ID } from '../game/fieldTypesCatalog';
import { CameraViewEntity, FieldMissionEngine } from '../game/fieldMissionEngine';
import { canInstallPart, PART_BY_ID, ROVER_PARTS } from '../game/roverPartsCatalog';
import { CropFieldId, GameHudSnapshot, GamePhase, PartId, RoverPartSpec } from '../game/types';

export type RightPanelTab = 'camera' | 'specs';

interface RoverRightPanelProps {
  open: boolean;
  activeTab: RightPanelTab;
  onChangeTab: (tab: RightPanelTab) => void;
  onClose: () => void;
  phase: GamePhase;
  hud: GameHudSnapshot;
  engineRef: React.MutableRefObject<FieldMissionEngine>;
  fieldType: CropFieldId;
  onSelectFieldType: (fieldType: CropFieldId) => void;
  selectedPartId: PartId;
  onSelectPart: (partId: PartId) => void;
  installedSet: Set<PartId>;
  onInstallPart: (partId: PartId) => void;
  onFocusPartIn3D: (partId: PartId) => void;
  servoTestActive: boolean;
  onToggleServoTest: () => void;
}

type CategoryFilter = 'All' | RoverPartSpec['category'];

const CATEGORIES: CategoryFilter[] = [
  'All',
  'Structure',
  'Drivetrain',
  'Electronics',
  'Perception',
  'Safety & Tool',
];

export const RoverRightPanel: React.FC<RoverRightPanelProps> = ({
  open,
  activeTab,
  onChangeTab,
  onClose,
  phase,
  hud,
  engineRef,
  fieldType,
  onSelectFieldType,
  selectedPartId,
  onSelectPart,
  installedSet,
  onInstallPart,
  onFocusPartIn3D,
  servoTestActive,
  onToggleServoTest,
}) => {
  const camCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [showExgMask, setShowExgMask] = useState(false);
  const [showBoxes, setShowBoxes] = useState(true);
  const [specSubTab, setSpecSubTab] = useState<'specs' | 'assembly'>('specs');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('All');
  const [liveDetections, setLiveDetections] = useState<CameraViewEntity[]>([]);

  const fieldSpec = CROP_FIELD_BY_ID[fieldType];
  const partSpec = PART_BY_ID[selectedPartId] ?? ROVER_PARTS[0];
  const isPartInstalled = installedSet.has(partSpec.id);
  const isPartInstallable = canInstallPart(partSpec.id, installedSet);

  const filteredParts = useMemo(
    () =>
      categoryFilter === 'All'
        ? ROVER_PARTS
        : ROVER_PARTS.filter((p) => p.category === categoryFilter),
    [categoryFilter]
  );

  // Live 18 FPS onboard rover camera renderer (reads real 3D world pose & entities from engineRef)
  useEffect(() => {
    if (!open || activeTab !== 'camera') return;

    let rafId = 0;
    let lastDraw = 0;

    const renderCameraFrame = (now: number) => {
      rafId = requestAnimationFrame(renderCameraFrame);
      if (now - lastDraw < 55) return;
      lastDraw = now;

      const canvas = camCanvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const W = canvas.width;
      const H = canvas.height;
      const engine = engineRef.current;
      const curField = CROP_FIELD_BY_ID[engine.fieldType];

      ctx.clearRect(0, 0, W, H);

      if (phase === 'workshop') {
        // Workshop bench optical calibration view
        ctx.fillStyle = '#0f2822';
        ctx.fillRect(0, 0, W, H);

        // Cutting mat perspective calibration grid
        ctx.strokeStyle = 'rgba(52, 211, 153, 0.22)';
        ctx.lineWidth = 1;
        for (let i = -5; i <= 5; i++) {
          ctx.beginPath();
          ctx.moveTo(W * 0.5 + i * 18, 22);
          ctx.lineTo(W * 0.5 + i * 52, H);
          ctx.stroke();
        }
        for (let y = 32; y < H; y += 26) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(W, y);
          ctx.stroke();
        }

        // Nozzle calibration arc + live servo yaw indicator
        const aimRad = (hud.turretYawDeg * Math.PI) / 180;
        const tipX = W * 0.5 - Math.sin(aimRad) * 95;
        const tipY = H - 30 - Math.cos(aimRad) * 95;

        ctx.strokeStyle = 'rgba(251, 191, 36, 0.45)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(W * 0.5, H - 14, 96, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.strokeStyle = '#fbbf24';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(W * 0.5, H - 14);
        ctx.lineTo(tipX, tipY);
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(tipX, tipY, 8, 0, Math.PI * 2);
        ctx.strokeStyle = '#34d399';
        ctx.stroke();

        ctx.fillStyle = 'rgba(15, 23, 21, 0.85)';
        ctx.fillRect(8, 8, W - 16, 22);
        ctx.fillStyle = '#d1fae5';
        ctx.font = '600 10px monospace';
        ctx.fillText(
          installedSet.has('maixsense_cam')
            ? 'WORKSHOP BENCH CAM · CALIBRATION RETICLE'
            : 'CAMERA GANTRY NOT MOUNTED (PREVIEW)',
          14,
          22
        );

        ctx.fillStyle = '#cbd5e1';
        ctx.font = '500 10px sans-serif';
        ctx.fillText('Deploy to Field to stream live 8-crop weed detection', 16, H - 10);
        setLiveDetections([]);
        return;
      }

      // =====================================================================
      // FIELD MODE: LIVE PERSPECTIVE ONBOARD CAMERA OUTPUT
      // =====================================================================
      const horizonY = 26;

      // Upper sky & distant foliage strip
      const skyGrad = ctx.createLinearGradient(0, 0, 0, horizonY);
      skyGrad.addColorStop(0, '#6c97b3');
      skyGrad.addColorStop(1, '#a9c7d4');
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, W, horizonY);

      // Soil ground plane with field-specific tint
      const soilGrad = ctx.createLinearGradient(0, horizonY, 0, H);
      soilGrad.addColorStop(0, showExgMask ? '#0b1411' : '#4a3829');
      soilGrad.addColorStop(1, showExgMask ? '#101d18' : curField.soilCss);
      ctx.fillStyle = soilGrad;
      ctx.fillRect(0, horizonY, W, H - horizonY);

      // Perspective helper: rover-local (localX forward 0..1.35m, localZ right + / left -) -> screen (sx, sy)
      const project = (lx: number, lz: number) => {
        const depth = Math.max(0.14, lx + 0.12);
        const inv = 1 / depth;
        const sy = horizonY + Math.min(H - horizonY + 10, (H - horizonY) * (0.28 * inv + 0.05));
        const sx = W * 0.5 + lz * inv * 135;
        const scale = Math.max(0.32, Math.min(2.2, 0.36 * inv));
        return { sx, sy, scale };
      };

      // Draw central raised crop ridge in perspective
      const ridgeTopL = project(1.3, -0.09);
      const ridgeTopR = project(1.3, 0.09);
      const ridgeBotL = project(0.05, -0.09);
      const ridgeBotR = project(0.05, 0.09);
      ctx.fillStyle = showExgMask ? 'rgba(16, 185, 129, 0.08)' : 'rgba(35, 22, 12, 0.28)';
      ctx.beginPath();
      ctx.moveTo(ridgeTopL.sx, ridgeTopL.sy);
      ctx.lineTo(ridgeTopR.sx, ridgeTopR.sy);
      ctx.lineTo(ridgeBotR.sx, ridgeBotR.sy);
      ctx.lineTo(ridgeBotL.sx, ridgeBotL.sy);
      ctx.closePath();
      ctx.fill();

      // Subtle motion furrow lines scrolling smoothly with rover wheel travel
      const travelPhase = (engine.distanceTravelledM * 4.5) % 1;
      ctx.strokeStyle = showExgMask ? 'rgba(52, 211, 153, 0.14)' : 'rgba(255, 245, 230, 0.09)';
      ctx.lineWidth = 1;
      for (let i = 0; i < 6; i++) {
        const lx = 0.12 + ((i + (1 - travelPhase)) / 6) * 1.15;
        const pL = project(lx, -0.55);
        const pR = project(lx, 0.55);
        ctx.beginPath();
        ctx.moveTo(pL.sx, pL.sy);
        ctx.lineTo(pR.sx, pR.sy);
        ctx.stroke();
      }

      // Strike zone trapezoid (direct nozzle kill envelope)
      const szTL = project(0.42, -0.18);
      const szTR = project(0.42, 0.18);
      const szBL = project(0.16, -0.18);
      const szBR = project(0.16, 0.18);
      ctx.strokeStyle = 'rgba(52, 211, 153, 0.45)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(szTL.sx, szTL.sy);
      ctx.lineTo(szTR.sx, szTR.sy);
      ctx.lineTo(szBR.sx, szBR.sy);
      ctx.lineTo(szBL.sx, szBL.sy);
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);

      // Project & render live crops, weeds, and obstacle crates from engineRef
      const entities = engine.getCameraViewEntities();
      for (const ent of entities) {
        const { sx, sy, scale } = project(ent.localX, ent.localZ);
        if (sx < -28 || sx > W + 28 || sy < horizonY - 8 || sy > H + 18) continue;

        if (ent.kind === 'obstacle') {
          const bw = 44 * scale;
          const bh = 38 * scale;
          ctx.fillStyle = '#b4834b';
          ctx.fillRect(sx - bw / 2, sy - bh, bw, bh);
          ctx.fillStyle = '#f59e0b';
          ctx.fillRect(sx - bw / 2, sy - bh * 0.72, bw, bh * 0.2);

          if (showBoxes) {
            ctx.strokeStyle = '#ef4444';
            ctx.lineWidth = 1.6;
            ctx.strokeRect(sx - bw / 2 - 2, sy - bh - 2, bw + 4, bh + 4);
            ctx.fillStyle = 'rgba(127, 29, 29, 0.9)';
            ctx.fillRect(sx - bw / 2 - 2, sy - bh - 15, 92, 13);
            ctx.fillStyle = '#fecaca';
            ctx.font = '600 9px monospace';
            ctx.fillText(`obstacle ${ent.confidence}%`, sx - bw / 2 + 1, sy - bh - 5);
          }
          continue;
        }

        if (ent.kind === 'crop') {
          const r = 13 * scale;
          // Foliage blob (or bright ExG segmentation mask)
          ctx.fillStyle = showExgMask ? '#10b981' : curField.cropLeafCss;
          ctx.beginPath();
          ctx.ellipse(sx, sy - r * 0.55, r * 1.15, r * 0.78, 0, 0, Math.PI * 2);
          ctx.fill();

          if (!showExgMask) {
            // Fruit / blossom accent dots
            ctx.fillStyle = curField.cropAccentCss;
            ctx.beginPath();
            ctx.arc(sx - r * 0.35, sy - r * 0.65, Math.max(2, r * 0.26), 0, Math.PI * 2);
            ctx.arc(sx + r * 0.32, sy - r * 0.45, Math.max(2, r * 0.24), 0, Math.PI * 2);
            ctx.fill();
          }

          if (showBoxes && ent.localX < 0.95) {
            const bx = sx - r * 1.25;
            const by = sy - r * 1.38;
            const bw = r * 2.5;
            const bh = r * 1.7;
            ctx.strokeStyle = '#34d399';
            ctx.lineWidth = 1.2;
            ctx.strokeRect(bx, by, bw, bh);

            const tag = `${ent.label} ${ent.confidence}%`;
            ctx.font = '600 8.5px monospace';
            const tw = ctx.measureText(tag).width + 6;
            ctx.fillStyle = 'rgba(6, 78, 59, 0.88)';
            ctx.fillRect(bx, Math.max(horizonY, by - 12), tw, 12);
            ctx.fillStyle = '#a7f3d0';
            ctx.fillText(tag, bx + 3, Math.max(horizonY + 9, by - 3));
          }
        } else {
          // Weed rosette
          const r = 10 * scale;
          ctx.fillStyle = showExgMask ? '#facc15' : '#84cc16';
          ctx.beginPath();
          ctx.ellipse(sx, sy - r * 0.35, r * 1.05, r * 0.62, 0, 0, Math.PI * 2);
          ctx.fill();

          if (!showExgMask && ent.label === 'weed_dandelion') {
            ctx.fillStyle = '#fde047';
            ctx.beginPath();
            ctx.arc(sx, sy - r * 0.72, Math.max(2, r * 0.32), 0, Math.PI * 2);
            ctx.fill();
          }

          if (showBoxes && ent.localX < 0.95) {
            const bx = sx - r * 1.2;
            const by = sy - r * 1.15;
            const bw = r * 2.4;
            const bh = r * 1.45;
            ctx.strokeStyle = ent.targeted ? '#f97316' : '#fbbf24';
            ctx.lineWidth = ent.targeted ? 2 : 1.3;
            ctx.strokeRect(bx, by, bw, bh);

            const tag = ent.targeted
              ? `${ent.label} LOCK`
              : `${ent.label} ${ent.confidence}%`;
            ctx.font = '600 8.5px monospace';
            const tw = ctx.measureText(tag).width + 6;
            ctx.fillStyle = ent.targeted ? 'rgba(154, 52, 18, 0.92)' : 'rgba(120, 53, 15, 0.88)';
            ctx.fillRect(bx, Math.max(horizonY, by - 12), tw, 12);
            ctx.fillStyle = '#fef3c7';
            ctx.fillText(tag, bx + 3, Math.max(horizonY + 9, by - 3));
          }
        }
      }

      // Draw live steel flame barrel tip & servo aim vector from bottom-center of camera frame
      const aimRad = (hud.turretYawDeg * Math.PI) / 180;
      const aimEndX = W * 0.5 - Math.sin(aimRad) * 76;
      const aimEndY = H - 8 - Math.cos(aimRad) * 62;

      ctx.strokeStyle = hud.toolFiring ? '#f97316' : 'rgba(251, 191, 36, 0.75)';
      ctx.lineWidth = hud.toolFiring ? 3.2 : 1.8;
      ctx.beginPath();
      ctx.moveTo(W * 0.5, H);
      ctx.lineTo(aimEndX, aimEndY);
      ctx.stroke();

      if (hud.toolFiring) {
        const flameGrad = ctx.createRadialGradient(aimEndX, aimEndY, 2, aimEndX, aimEndY, 22);
        flameGrad.addColorStop(0, 'rgba(254, 240, 138, 0.95)');
        flameGrad.addColorStop(0.5, 'rgba(249, 115, 22, 0.72)');
        flameGrad.addColorStop(1, 'rgba(239, 68, 68, 0)');
        ctx.fillStyle = flameGrad;
        ctx.beginPath();
        ctx.arc(aimEndX, aimEndY, 22, 0, Math.PI * 2);
        ctx.fill();
      }

      // Top camera telemetry HUD bar inside feed
      ctx.fillStyle = 'rgba(11, 18, 16, 0.82)';
      ctx.fillRect(0, 0, W, 20);
      ctx.fillStyle = '#34d399';
      ctx.font = '600 9.5px monospace';
      ctx.fillText(
        `CAM0 · ${curField.modelClass.toUpperCase()} · ${showExgMask ? 'ExG' : 'RGB+AI'}`,
        7,
        13
      );
      ctx.fillStyle = '#fde68a';
      ctx.fillText(`ToF ${hud.tofDistanceMm}mm`, W - 78, 13);

      // Update top visible detections summary (~every 3 frames)
      setLiveDetections(entities.filter((e) => e.localX < 0.95).slice(0, 4));
    };

    rafId = requestAnimationFrame(renderCameraFrame);
    return () => cancelAnimationFrame(rafId);
  }, [open, activeTab, phase, showExgMask, showBoxes, hud.turretYawDeg, hud.toolFiring, hud.tofDistanceMm, installedSet, engineRef]);

  if (!open) return null;

  const currentIdx = ROVER_PARTS.findIndex((p) => p.id === partSpec.id);
  const goPrevPart = () => {
    const prev = ROVER_PARTS[(currentIdx - 1 + ROVER_PARTS.length) % ROVER_PARTS.length];
    onSelectPart(prev.id);
  };
  const goNextPart = () => {
    const next = ROVER_PARTS[(currentIdx + 1) % ROVER_PARTS.length];
    onSelectPart(next.id);
  };

  return (
    <aside
      aria-label="Rover Camera and Part Inspector"
      className="pointer-events-auto absolute top-4 right-4 z-20 w-[min(352px,92vw)] max-h-[calc(100vh-192px)] flex flex-col rounded-xl bg-[#111917]/95 border border-white/14 text-white shadow-2xl overflow-hidden"
    >
      {/* Top Tab Switcher + Close Button */}
      <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-1 p-0.5 bg-white/8 rounded-lg">
          <button
            type="button"
            onClick={() => onChangeTab('camera')}
            className={`px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 cursor-pointer transition-colors whitespace-nowrap ${
              activeTab === 'camera'
                ? 'bg-emerald-600 text-white'
                : 'text-slate-300 hover:text-white'
            }`}
          >
            <Camera className="w-3.5 h-3.5" />
            <span>Live Camera</span>
          </button>
          <button
            type="button"
            onClick={() => onChangeTab('specs')}
            className={`px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 cursor-pointer transition-colors whitespace-nowrap ${
              activeTab === 'specs'
                ? 'bg-emerald-600 text-white'
                : 'text-slate-300 hover:text-white'
            }`}
          >
            <Wrench className="w-3.5 h-3.5" />
            <span>Part Specs</span>
          </button>
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="Close right panel"
          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 cursor-pointer transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Scrollable Body */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {activeTab === 'camera' ? (
          <>
            {/* Live Onboard Rover Camera Canvas */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-slate-300">
                <span className="font-medium text-white">Gantry Vision Output</span>
                <span className="font-mono tabular-nums text-slate-400">
                  Aim {hud.turretYawDeg > 0 ? `+${hud.turretYawDeg}` : hud.turretYawDeg}° · {hud.nozzleTempC}°C
                </span>
              </div>

              <div className="rounded-lg overflow-hidden border border-white/12 bg-black">
                <canvas
                  ref={camCanvasRef}
                  width={324}
                  height={196}
                  className="w-full h-auto block"
                />
              </div>

              {/* Camera View Controls */}
              <div className="flex items-center justify-between gap-2 pt-0.5">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setShowBoxes((v) => !v)}
                    className={`px-2 py-1 rounded-md text-[11px] font-medium cursor-pointer whitespace-nowrap ${
                      showBoxes
                        ? 'bg-emerald-700/80 text-white'
                        : 'bg-white/8 text-slate-300 hover:text-white'
                    }`}
                  >
                    AI Boxes
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowExgMask((v) => !v)}
                    className={`px-2 py-1 rounded-md text-[11px] font-medium cursor-pointer whitespace-nowrap ${
                      showExgMask
                        ? 'bg-emerald-700/80 text-white'
                        : 'bg-white/8 text-slate-300 hover:text-white'
                    }`}
                  >
                    ExG Mask
                  </button>
                </div>
                <span className="text-[11px] font-mono tabular-nums text-slate-400">
                  YOLOv8n + CLIP
                </span>
              </div>
            </div>

            {/* Active Vision Detections List */}
            <div className="pt-2 border-t border-white/10 space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="font-semibold text-white">Live 8-Class Detections</span>
                <span className="font-mono tabular-nums text-[11px] text-slate-400">
                  {liveDetections.length} in FOV
                </span>
              </div>

              {liveDetections.length === 0 ? (
                <p className="text-[11px] text-slate-400 leading-snug">
                  {phase === 'workshop'
                    ? 'Switch to Field mode to classify crops and weeds in real time.'
                    : 'Scanning row corridor — move rover forward to lock nearby weeds.'}
                </p>
              ) : (
                <div className="divide-y divide-white/8 text-xs font-mono tabular-nums">
                  {liveDetections.map((d) => (
                    <div
                      key={`${d.kind}-${d.id}`}
                      className="py-1 flex items-center justify-between gap-2"
                    >
                      <span
                        className={
                          d.kind === 'weed'
                            ? d.targeted
                              ? 'text-orange-300 font-semibold'
                              : 'text-amber-300'
                            : d.kind === 'obstacle'
                            ? 'text-red-300 font-semibold'
                            : 'text-emerald-300'
                        }
                      >
                        {d.label}
                        {d.targeted ? ' · LOCK' : ''}
                      </span>
                      <span className="text-slate-400">
                        {Math.round(d.localX * 100)} cm · {d.confidence}%
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 8 Crop Field Selector Grid */}
            <div className="pt-2.5 border-t border-white/10 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-white flex items-center gap-1.5">
                  <Sprout className="w-3.5 h-3.5 text-emerald-400" />
                  <span>8 Crop Fields</span>
                </span>
                <span className="text-[11px] font-mono tabular-nums text-emerald-300">
                  {fieldSpec.modelClass}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                {CROP_FIELDS.map((cf) => {
                  const active = cf.id === fieldType;
                  return (
                    <button
                      key={cf.id}
                      type="button"
                      onClick={() => onSelectFieldType(cf.id)}
                      className={`px-2.5 py-1.5 rounded-lg text-left text-xs transition-colors cursor-pointer border ${
                        active
                          ? 'bg-emerald-600/25 border-emerald-400/70 text-white'
                          : 'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10 hover:text-white'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="font-medium truncate">
                          {cf.index}. {cf.shortName}
                        </span>
                        <span
                          className="w-2.5 h-2.5 rounded-sm shrink-0 border border-white/25"
                          style={{ backgroundColor: cf.cropAccentCss }}
                        />
                      </div>
                    </button>
                  );
                })}
              </div>

              <p className="text-[11px] text-slate-400 leading-relaxed">
                {fieldSpec.description}
              </p>
            </div>
          </>
        ) : (
          /* ===================================================================
             INTERACTIVE PART SPECIFICATIONS & ASSEMBLY INSTRUCTIONS TAB
          =================================================================== */
          <>
            {/* Quick Category Filter */}
            <div className="flex items-center gap-1 overflow-x-auto pb-1">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategoryFilter(cat)}
                  className={`shrink-0 px-2 py-1 rounded-md text-[11px] font-medium cursor-pointer transition-colors whitespace-nowrap ${
                    categoryFilter === cat
                      ? 'bg-white text-slate-950'
                      : 'bg-white/8 text-slate-300 hover:text-white'
                  }`}
                >
                  {cat === 'Safety & Tool' ? 'Tool' : cat}
                </button>
              ))}
            </div>

            {/* Quick Clickable Part List */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
              {filteredParts.map((p) => {
                const isSelected = p.id === partSpec.id;
                const isDone = installedSet.has(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => onSelectPart(p.id)}
                    className={`shrink-0 px-2 py-1 rounded-md text-[11px] font-medium flex items-center gap-1 cursor-pointer border whitespace-nowrap ${
                      isSelected
                        ? 'bg-emerald-600/30 border-emerald-400 text-white'
                        : 'bg-white/5 border-white/10 text-slate-300 hover:text-white'
                    }`}
                  >
                    {isDone && <Check className="w-3 h-3 text-emerald-400 shrink-0" />}
                    <span>{p.shortName}</span>
                  </button>
                );
              })}
            </div>

            {/* Selected Part Header */}
            <div className="pt-2 border-t border-white/10 space-y-1">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-white leading-snug">
                    {partSpec.step}. {partSpec.name}
                  </h3>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-slate-400 font-mono tabular-nums">
                    <span>{partSpec.partNumber}</span>
                    <span aria-hidden="true">·</span>
                    <span>{partSpec.category}</span>
                    <span aria-hidden="true">·</span>
                    <span className={isPartInstalled ? 'text-emerald-300' : 'text-amber-300'}>
                      {isPartInstalled ? 'Mounted' : 'Unmounted'}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={goPrevPart}
                    aria-label="Previous part"
                    className="p-1 rounded-md bg-white/8 hover:bg-white/15 text-slate-200 cursor-pointer"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={goNextPart}
                    aria-label="Next part"
                    className="p-1 rounded-md bg-white/8 hover:bg-white/15 text-slate-200 cursor-pointer"
                  >
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <p className="text-xs text-slate-300 leading-relaxed pt-1">
                {partSpec.description}
              </p>
            </div>

            {/* Sub-Tabs: Technical Specs vs Assembly Guide */}
            <div className="grid grid-cols-2 gap-1 p-0.5 bg-white/8 rounded-lg">
              <button
                type="button"
                onClick={() => setSpecSubTab('specs')}
                className={`py-1.5 rounded-md text-xs font-medium cursor-pointer transition-colors ${
                  specSubTab === 'specs'
                    ? 'bg-emerald-600 text-white'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                Technical Specs
              </button>
              <button
                type="button"
                onClick={() => setSpecSubTab('assembly')}
                className={`py-1.5 rounded-md text-xs font-medium cursor-pointer transition-colors ${
                  specSubTab === 'assembly'
                    ? 'bg-emerald-600 text-white'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                Assembly Guide
              </button>
            </div>

            {specSubTab === 'specs' ? (
              <div className="space-y-2.5">
                <dl className="divide-y divide-white/8 text-xs">
                  {partSpec.specs.map((row) => (
                    <div
                      key={row.label}
                      className="py-1.5 flex items-baseline justify-between gap-3"
                    >
                      <dt className="text-slate-400 shrink-0">{row.label}</dt>
                      <dd className="text-right font-mono tabular-nums text-slate-100">
                        {row.value}
                      </dd>
                    </div>
                  ))}
                </dl>

                {partSpec.requires.length > 0 && (
                  <div className="pt-2 border-t border-white/10 space-y-1.5">
                    <div className="text-[11px] font-medium text-slate-400">
                      Depends On
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {partSpec.requires.map((reqId) => {
                        const req = PART_BY_ID[reqId];
                        const reqMet = installedSet.has(reqId);
                        return (
                          <button
                            key={reqId}
                            type="button"
                            onClick={() => onSelectPart(reqId)}
                            className={`px-2 py-1 rounded-md text-[11px] font-medium flex items-center gap-1 cursor-pointer border ${
                              reqMet
                                ? 'bg-emerald-950/60 border-emerald-500/40 text-emerald-200'
                                : 'bg-amber-500/15 border-amber-400/50 text-amber-200'
                            }`}
                          >
                            {reqMet && <Check className="w-3 h-3" />}
                            <span>
                              {req.step}. {req.shortName}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-2.5">
                <ol className="space-y-2 text-xs text-slate-200 leading-relaxed">
                  {partSpec.assemblySteps.map((stepText, idx) => (
                    <li key={idx} className="flex items-start gap-2">
                      <span className="font-mono tabular-nums text-emerald-400 font-semibold shrink-0">
                        0{idx + 1}.
                      </span>
                      <span>{stepText}</span>
                    </li>
                  ))}
                </ol>

                <div className="pt-2 border-t border-white/10 text-[11px] text-slate-300">
                  <span className="text-slate-400">Tools needed: </span>
                  <span>{partSpec.toolsRequired}</span>
                </div>

                {partSpec.safetyNote && (
                  <div className="rounded-lg bg-amber-500/12 border border-amber-400/35 p-2.5 flex items-start gap-2 text-[11px] text-amber-200 leading-snug">
                    <ShieldAlert className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
                    <span>{partSpec.safetyNote}</span>
                  </div>
                )}
              </div>
            )}

            {/* Interactive Part Actions */}
            <div className="pt-2.5 border-t border-white/10 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => onFocusPartIn3D(partSpec.id)}
                className="flex-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-white/10 hover:bg-white/18 text-white flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
              >
                <Crosshair className="w-3.5 h-3.5 text-emerald-300" />
                <span>Focus in 3D</span>
              </button>

              {phase === 'workshop' && !isPartInstalled && (
                <button
                  type="button"
                  onClick={() => onInstallPart(partSpec.id)}
                  disabled={!isPartInstallable}
                  title={
                    isPartInstallable
                      ? `Mount ${partSpec.name}`
                      : 'Mount prerequisite parts listed above first'
                  }
                  className="flex-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-500 hover:bg-amber-400 disabled:bg-white/8 disabled:text-slate-400 text-slate-950 flex items-center justify-center gap-1.5 cursor-pointer disabled:cursor-not-allowed whitespace-nowrap"
                >
                  <Wrench className="w-3.5 h-3.5" />
                  <span>{isPartInstallable ? 'Mount Part' : 'Locked'}</span>
                </button>
              )}

              {phase === 'workshop' && partSpec.id === 'estop_tool' && isPartInstalled && (
                <button
                  type="button"
                  onClick={onToggleServoTest}
                  className={`flex-1 px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap ${
                    servoTestActive
                      ? 'bg-orange-500 text-slate-950'
                      : 'bg-emerald-600 hover:bg-emerald-500 text-white'
                  }`}
                >
                  <Compass className="w-3.5 h-3.5" />
                  <span>{servoTestActive ? 'Stop Sweep' : 'Test Servo'}</span>
                </button>
              )}
            </div>

            <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
              <Eye className="w-3.5 h-3.5 shrink-0 text-slate-500" />
              <span>Click any part directly on the 3D rover to inspect it here.</span>
            </div>
          </>
        )}
      </div>
    </aside>
  );
};
