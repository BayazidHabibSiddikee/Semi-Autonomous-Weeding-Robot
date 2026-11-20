import React, { useState } from 'react';
import { Crosshair } from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  Cell,
  ResponsiveContainer,
} from 'recharts';

export interface VisionAlignmentData {
  trackingLocked: boolean;
  lateralOffsetM: number; // EMA-filtered lateral_error_m (+ve = shifted right of centerline)
  rawLateralOffsetM: number; // Raw ExG+Otsu frame observation (m)
  headingErrorRad: number; // EMA-filtered heading_error_rad (+ve = pointed right of row tangent)
  rawHeadingErrorRad: number; // Raw ExG+Otsu frame observation (rad)
  rowWidthM: number;
  rowEndConfidence: number;
  greenRatioFar?: number; // Top 1/3 ROI ExG foliage density (0..1)
  greenRatioNear?: number; // Bottom 1/2 ROI ExG foliage density (0..1)
  missedFrames: number;
  cmdWzRadS: number;
  currentRow: number;
  sourceLabel?: string;
}

interface Props {
  alignment: VisionAlignmentData;
}

const LAT_TOL_M = 0.04; // +/- 0.04 m target acceptance band
const LAT_MAX_M = 0.25;
const YAW_TOL_RAD = 0.05; // +/- 0.05 rad (~2.9 deg) alignment band
const YAW_MAX_RAD = 0.35;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function formatSigned(v: number, digits: number): string {
  const fixed = Math.abs(v) < 0.0005 ? (0).toFixed(digits) : v.toFixed(digits);
  return v >= 0 && !fixed.startsWith('-') ? `+${fixed}` : fixed;
}

export const CropRowAlignmentGauge: React.FC<Props> = ({ alignment }) => {
  const [vizMode, setVizMode] = useState<'gauges' | 'bar'>('gauges');

  const {
    trackingLocked,
    lateralOffsetM,
    rawLateralOffsetM,
    headingErrorRad,
    rawHeadingErrorRad,
    rowWidthM,
    missedFrames,
    cmdWzRadS,
    currentRow,
  } = alignment;

  const absLat = Math.abs(lateralOffsetM);
  const absYaw = Math.abs(headingErrorRad);

  const status = !trackingLocked
    ? { label: '○ Headland / Unlocked', tone: 'text-slate-500' }
    : absLat > 0.08 || absYaw > 0.14
    ? { label: '✖ Off-Center', tone: 'text-rose-700' }
    : absLat > LAT_TOL_M || absYaw > YAW_TOL_RAD
    ? { label: '▲ Correcting', tone: 'text-amber-700' }
    : { label: '● Centered', tone: 'text-emerald-700' };

  const latTone = !trackingLocked
    ? 'text-slate-500'
    : absLat > 0.08
    ? 'text-rose-700'
    : absLat > LAT_TOL_M
    ? 'text-amber-700'
    : 'text-emerald-700';

  const yawTone = !trackingLocked
    ? 'text-slate-500'
    : absYaw > 0.14
    ? 'text-rose-700'
    : absYaw > YAW_TOL_RAD
    ? 'text-amber-700'
    : 'text-emerald-700';

  const latDirection = !trackingLocked
    ? 'No foliage lock'
    : absLat < 0.005
    ? 'On centerline'
    : lateralOffsetM > 0
    ? 'Right of centerline'
    : 'Left of centerline';

  const yawDirection = !trackingLocked
    ? 'Awaiting row entry'
    : absYaw < 0.008
    ? 'Parallel to row'
    : headingErrorRad > 0
    ? 'Yawed right'
    : 'Yawed left';

  // SVG Reticle Geometry (320 x 204 px, centered at x=160, rover pivot at y=132)
  const svgW = 320;
  const svgH = 204;
  const cx = svgW / 2;
  const roverY = 132;
  const halfSpanM = rowWidthM / 2 + 0.1;
  const pxPerM = (svgW - 44) / (2 * halfSpanM);

  const leftRowX = cx - (rowWidthM / 2) * pxPerM;
  const rightRowX = cx + (rowWidthM / 2) * pxPerM;
  const tolHalfPx = LAT_TOL_M * pxPerM;

  const clampedLatM = clamp(lateralOffsetM, -(rowWidthM / 2 - 0.04), rowWidthM / 2 - 0.04);
  const roverX = cx + clampedLatM * pxPerM;
  const clampedYawRad = clamp(headingErrorRad, -0.45, 0.45);
  const roverYawDeg = (clampedYawRad * 180) / Math.PI;

  const rayLen = 74;
  const rayEndX = roverX + Math.sin(clampedYawRad) * rayLen;
  const rayEndY = roverY - Math.cos(clampedYawRad) * rayLen;

  const arcR = 46;
  const arcStartX = roverX;
  const arcStartY = roverY - arcR;
  const arcEndX = roverX + Math.sin(clampedYawRad) * arcR;
  const arcEndY = roverY - Math.cos(clampedYawRad) * arcR;
  const sweepFlag = clampedYawRad >= 0 ? 1 : 0;

  const ctrlX = roverX + Math.sin(clampedYawRad) * 38;
  const ctrlY = roverY - 46;
  const targetAheadX = cx + (roverX - cx) * 0.25;
  const targetAheadY = 22;

  // Linear gauge percentages (0..100, center = 50)
  const latNormPct = 50 + clamp(lateralOffsetM / LAT_MAX_M, -1, 1) * 50;
  const rawLatNormPct = 50 + clamp(rawLateralOffsetM / LAT_MAX_M, -1, 1) * 50;
  const latTolHalfPct = (LAT_TOL_M / LAT_MAX_M) * 50;

  const yawNormPct = 50 + clamp(headingErrorRad / YAW_MAX_RAD, -1, 1) * 50;
  const rawYawNormPct = 50 + clamp(rawHeadingErrorRad / YAW_MAX_RAD, -1, 1) * 50;
  const yawTolHalfPct = (YAW_TOL_RAD / YAW_MAX_RAD) * 50;

  // Dynamic bar chart data (% of full-scale limit so m and rad render cleanly on one calibrated axis)
  const barChartData = [
    {
      metric: 'Lateral Offset (m)',
      valuePct: Number(clamp((lateralOffsetM / LAT_MAX_M) * 100, -100, 100).toFixed(1)),
      formatted: `${formatSigned(lateralOffsetM, 3)} m`,
      rawFormatted: `${formatSigned(rawLateralOffsetM, 3)} m`,
      color: !trackingLocked
        ? '#94A3B8'
        : absLat > 0.08
        ? '#E11D48'
        : absLat > LAT_TOL_M
        ? '#D97706'
        : '#059669',
    },
    {
      metric: 'Heading Error (rad)',
      valuePct: Number(clamp((headingErrorRad / YAW_MAX_RAD) * 100, -100, 100).toFixed(1)),
      formatted: `${formatSigned(headingErrorRad, 3)} rad`,
      rawFormatted: `${formatSigned(rawHeadingErrorRad, 3)} rad`,
      color: !trackingLocked
        ? '#94A3B8'
        : absYaw > 0.14
        ? '#E11D48'
        : absYaw > YAW_TOL_RAD
        ? '#D97706'
        : '#059669',
    },
  ];

  return (
    <section
      aria-label="Crop-Row Alignment Vision Telemetry"
      className="bg-white border border-emerald-900/10 rounded-lg p-4 space-y-4"
    >
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-emerald-900/10 pb-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <div className="flex items-center gap-2">
            <Crosshair className="w-4 h-4 text-emerald-600 shrink-0" />
            <h3 className="text-sm font-semibold text-slate-900">
              Crop-Row Alignment (Vision Node)
            </h3>
          </div>
          <span className="text-xs font-mono text-slate-500">
            {alignment.sourceLabel
              ? alignment.sourceLabel
              : `Row ${currentRow} · /crop_row/alignment · ExG+Otsu + CropRowTracker`}
          </span>
        </div>

        <div className="flex items-center gap-3">
          <span className={`text-xs font-mono font-semibold tabular-nums ${status.tone}`}>
            {status.label}
          </span>
          <div className="flex items-center p-0.5 bg-[#F2F7F4] border border-emerald-900/10 rounded-md">
            <button
              onClick={() => setVizMode('gauges')}
              className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors cursor-pointer whitespace-nowrap ${
                vizMode === 'gauges'
                  ? 'bg-white text-emerald-800 border border-emerald-200'
                  : 'text-slate-600 hover:text-emerald-800 border border-transparent'
              }`}
            >
              Gauges
            </button>
            <button
              onClick={() => setVizMode('bar')}
              className={`px-2.5 py-1 text-[11px] font-medium rounded transition-colors cursor-pointer whitespace-nowrap ${
                vizMode === 'bar'
                  ? 'bg-white text-emerald-800 border border-emerald-200'
                  : 'text-slate-600 hover:text-emerald-800 border border-transparent'
              }`}
            >
              Bar Chart
            </button>
          </div>
        </div>
      </div>

      {/* 2-Column Instrument Body */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-center">
        {/* Left: Top-Down SVG Alignment Reticle */}
        <div className="lg:col-span-5 space-y-2">
          <div className="rounded border border-emerald-900/10 bg-[#F8FBF9] overflow-hidden">
            <svg
              viewBox={`0 0 ${svgW} ${svgH}`}
              role="img"
              aria-label={`Crop-row alignment reticle showing Lateral Offset ${formatSigned(lateralOffsetM, 3)} meters and Heading Error ${formatSigned(headingErrorRad, 3)} radians`}
              className="w-full h-auto block"
            >
              {/* Subtle vertical scale gridlines */}
              {[-0.2, -0.1, 0.1, 0.2].map((gm) => {
                const gx = cx + gm * pxPerM;
                return (
                  <line
                    key={gm}
                    x1={gx}
                    y1={12}
                    x2={gx}
                    y2={svgH - 22}
                    stroke="#E2ECE6"
                    strokeWidth="1"
                  />
                );
              })}

              {/* +/- 0.04 m acceptance corridor */}
              <rect
                x={cx - tolHalfPx}
                y={12}
                width={tolHalfPx * 2}
                height={svgH - 34}
                fill="rgba(16, 185, 129, 0.10)"
              />
              <line
                x1={cx - tolHalfPx}
                y1={12}
                x2={cx - tolHalfPx}
                y2={svgH - 22}
                stroke="rgba(5, 150, 105, 0.4)"
                strokeDasharray="3 3"
                strokeWidth="1"
              />
              <line
                x1={cx + tolHalfPx}
                y1={12}
                x2={cx + tolHalfPx}
                y2={svgH - 22}
                stroke="rgba(5, 150, 105, 0.4)"
                strokeDasharray="3 3"
                strokeWidth="1"
              />

              {/* Left & right crop foliage ridges */}
              {[leftRowX, rightRowX].map((rx, idx) => (
                <g key={idx}>
                  <rect
                    x={rx - 10}
                    y={12}
                    width={20}
                    height={svgH - 34}
                    fill={trackingLocked ? 'rgba(22, 163, 74, 0.14)' : 'rgba(148, 163, 184, 0.18)'}
                  />
                  {[26, 56, 86, 116, 146, 170].map((py) => (
                    <circle
                      key={py}
                      cx={rx}
                      cy={py}
                      r={5}
                      fill={trackingLocked ? '#16A34A' : '#CBD5E1'}
                      stroke={trackingLocked ? '#15803D' : '#94A3B8'}
                      strokeWidth="1"
                    />
                  ))}
                </g>
              ))}

              {/* Target row centerline */}
              <line
                x1={cx}
                y1={12}
                x2={cx}
                y2={svgH - 22}
                stroke="#059669"
                strokeOpacity="0.7"
                strokeWidth="1.25"
                strokeDasharray="5 4"
              />

              {/* Projected Stanley recovery path */}
              {trackingLocked && (
                <path
                  d={`M ${roverX.toFixed(1)} ${roverY.toFixed(1)} Q ${ctrlX.toFixed(1)} ${ctrlY.toFixed(1)} ${targetAheadX.toFixed(1)} ${targetAheadY.toFixed(1)}`}
                  fill="none"
                  stroke="#059669"
                  strokeWidth="1.5"
                  strokeDasharray="3 3"
                  opacity="0.75"
                />
              )}

              {/* Row-parallel reference tangent from rover pivot */}
              <line
                x1={roverX}
                y1={roverY}
                x2={roverX}
                y2={roverY - rayLen}
                stroke="#94A3B8"
                strokeWidth="1"
                strokeDasharray="2 3"
              />

              {/* Heading error wedge arc (e_psi) */}
              {Math.abs(clampedYawRad) > 0.012 && (
                <path
                  d={`M ${arcStartX.toFixed(1)} ${arcStartY.toFixed(1)} A ${arcR} ${arcR} 0 0 ${sweepFlag} ${arcEndX.toFixed(1)} ${arcEndY.toFixed(1)}`}
                  fill="none"
                  stroke={absYaw > 0.14 ? '#E11D48' : absYaw > YAW_TOL_RAD ? '#D97706' : '#059669'}
                  strokeWidth="2.2"
                />
              )}

              {/* Rover heading vector ray */}
              <line
                x1={roverX}
                y1={roverY}
                x2={rayEndX}
                y2={rayEndY}
                stroke={trackingLocked ? '#047857' : '#94A3B8'}
                strokeWidth="1.75"
              />
              <circle cx={rayEndX} cy={rayEndY} r={2.5} fill={trackingLocked ? '#047857' : '#94A3B8'} />

              {/* Lateral offset vector (e_y) between centerline and rover center */}
              {Math.abs(roverX - cx) > 1.5 && (
                <g>
                  <line
                    x1={cx}
                    y1={roverY}
                    x2={roverX}
                    y2={roverY}
                    stroke={absLat > 0.08 ? '#E11D48' : '#D97706'}
                    strokeWidth="2.2"
                  />
                  <line
                    x1={cx}
                    y1={roverY - 5}
                    x2={cx}
                    y2={roverY + 5}
                    stroke="#059669"
                    strokeWidth="1.5"
                  />
                </g>
              )}

              {/* Rover chassis footprint */}
              <g transform={`translate(${roverX.toFixed(1)}, ${roverY}) rotate(${roverYawDeg.toFixed(2)})`}>
                <rect x={-16} y={-16} width={5} height={11} rx={1} fill="#334155" />
                <rect x={11} y={-16} width={5} height={11} rx={1} fill="#334155" />
                <rect x={-16} y={5} width={5} height={11} rx={1} fill="#334155" />
                <rect x={11} y={5} width={5} height={11} rx={1} fill="#334155" />

                <rect
                  x={-11}
                  y={-20}
                  width={22}
                  height={40}
                  rx={2}
                  fill="#FFFFFF"
                  stroke={trackingLocked ? '#059669' : '#64748B'}
                  strokeWidth="1.8"
                />
                <polygon
                  points="0,-24 -4.5,-16 4.5,-16"
                  fill={trackingLocked ? '#059669' : '#64748B'}
                />
                <circle cx={0} cy={0} r={2.2} fill="#0F172A" />
              </g>

              {/* Bottom metric axis labels */}
              <line x1={16} y1={svgH - 22} x2={svgW - 16} y2={svgH - 22} stroke="#DCE7E0" strokeWidth="1" />
              <text
                x={leftRowX}
                y={svgH - 8}
                textAnchor="middle"
                fill="#64748B"
                fontSize="9.5"
                fontFamily="IBM Plex Mono, monospace"
              >
                -{(rowWidthM / 2).toFixed(2)}m
              </text>
              <text
                x={cx}
                y={svgH - 8}
                textAnchor="middle"
                fill="#047857"
                fontSize="9.5"
                fontWeight="600"
                fontFamily="IBM Plex Mono, monospace"
              >
                0.00m
              </text>
              <text
                x={rightRowX}
                y={svgH - 8}
                textAnchor="middle"
                fill="#64748B"
                fontSize="9.5"
                fontFamily="IBM Plex Mono, monospace"
              >
                +{(rowWidthM / 2).toFixed(2)}m
              </text>

              <text
                x={8}
                y={14}
                fill="#475569"
                fontSize="9"
                fontFamily="IBM Plex Mono, monospace"
              >
                CORRIDOR ±0.04m
              </text>
            </svg>
          </div>
          <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 tabular-nums">
            <span>Row width: {rowWidthM.toFixed(2)} m</span>
            <span>e_y amber · e_ψ green arc</span>
          </div>
        </div>

        {/* Right: Dynamic Gauges OR Real-Time Horizontal Bar Chart */}
        <div className="lg:col-span-7 space-y-4">
          {/* Primary Metric Readouts always visible */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-[#F8FBF9] border border-emerald-900/10 rounded-md p-3">
              <div className="flex items-center justify-between text-xs text-slate-600">
                <span className="font-medium">Lateral Offset</span>
                <span className="font-mono text-[11px] text-slate-500">lateral_error_m</span>
              </div>
              <div className="flex items-baseline gap-1.5 mt-1">
                <span className={`text-2xl font-mono font-semibold tabular-nums ${latTone}`}>
                  {formatSigned(lateralOffsetM, 3)}
                </span>
                <span className="text-xs font-mono text-slate-500">m</span>
              </div>
              <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 mt-1 tabular-nums">
                <span>{latDirection}</span>
                <span>Raw: {formatSigned(rawLateralOffsetM, 3)} m</span>
              </div>
            </div>

            <div className="bg-[#F8FBF9] border border-emerald-900/10 rounded-md p-3">
              <div className="flex items-center justify-between text-xs text-slate-600">
                <span className="font-medium">Heading Error</span>
                <span className="font-mono text-[11px] text-slate-500">heading_error_rad</span>
              </div>
              <div className="flex items-baseline gap-1.5 mt-1">
                <span className={`text-2xl font-mono font-semibold tabular-nums ${yawTone}`}>
                  {formatSigned(headingErrorRad, 3)}
                </span>
                <span className="text-xs font-mono text-slate-500">rad</span>
                <span className="text-[11px] font-mono text-slate-400 ml-1 tabular-nums">
                  ({formatSigned((headingErrorRad * 180) / Math.PI, 1)}°)
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 mt-1 tabular-nums">
                <span>{yawDirection}</span>
                <span>Raw: {formatSigned(rawHeadingErrorRad, 3)} rad</span>
              </div>
            </div>
          </div>

          {vizMode === 'gauges' ? (
            <div className="space-y-3.5">
              {/* Zero-Centered Lateral Offset Gauge */}
              <div className="space-y-1">
                <div className="flex justify-between text-[11px] font-mono text-slate-600">
                  <span>Lateral Offset Gauge (±0.04 m green corridor)</span>
                  <span className="tabular-nums text-slate-500">Range ±0.25 m</span>
                </div>
                <div className="relative h-5 rounded bg-[#F2F7F4] border border-emerald-900/15 overflow-hidden">
                  <div
                    className="absolute top-0 bottom-0 bg-emerald-500/20 border-x border-emerald-600/40"
                    style={{
                      left: `${50 - latTolHalfPct}%`,
                      width: `${latTolHalfPct * 2}%`,
                    }}
                  />
                  <div
                    className={`absolute top-1 bottom-1 transition-all duration-100 ${
                      !trackingLocked
                        ? 'bg-slate-400/50'
                        : absLat > 0.08
                        ? 'bg-rose-600/80'
                        : absLat > LAT_TOL_M
                        ? 'bg-amber-500/80'
                        : 'bg-emerald-600/85'
                    }`}
                    style={{
                      left: `${Math.min(50, latNormPct)}%`,
                      width: `${Math.abs(latNormPct - 50)}%`,
                    }}
                  />
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-slate-500/70"
                    style={{ left: `calc(${rawLatNormPct}% - 1px)` }}
                    title={`Raw frame: ${formatSigned(rawLateralOffsetM, 3)} m`}
                  />
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-slate-900"
                    style={{ left: `calc(${latNormPct}% - 1px)` }}
                  />
                  <div className="absolute top-0 bottom-0 left-1/2 w-px bg-emerald-900/40" />
                </div>
                <div className="flex justify-between text-[10px] font-mono text-slate-500 tabular-nums">
                  <span>-0.25 m</span>
                  <span>-0.04</span>
                  <span className="text-emerald-800 font-semibold">0.00 m</span>
                  <span>+0.04</span>
                  <span>+0.25 m</span>
                </div>
              </div>

              {/* Zero-Centered Heading Error Gauge */}
              <div className="space-y-1">
                <div className="flex justify-between text-[11px] font-mono text-slate-600">
                  <span>Heading Error Gauge (±0.05 rad green corridor)</span>
                  <span className="tabular-nums text-slate-500">Range ±0.35 rad</span>
                </div>
                <div className="relative h-5 rounded bg-[#F2F7F4] border border-emerald-900/15 overflow-hidden">
                  <div
                    className="absolute top-0 bottom-0 bg-emerald-500/20 border-x border-emerald-600/40"
                    style={{
                      left: `${50 - yawTolHalfPct}%`,
                      width: `${yawTolHalfPct * 2}%`,
                    }}
                  />
                  <div
                    className={`absolute top-1 bottom-1 transition-all duration-100 ${
                      !trackingLocked
                        ? 'bg-slate-400/50'
                        : absYaw > 0.14
                        ? 'bg-rose-600/80'
                        : absYaw > YAW_TOL_RAD
                        ? 'bg-amber-500/80'
                        : 'bg-emerald-600/85'
                    }`}
                    style={{
                      left: `${Math.min(50, yawNormPct)}%`,
                      width: `${Math.abs(yawNormPct - 50)}%`,
                    }}
                  />
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-slate-500/70"
                    style={{ left: `calc(${rawYawNormPct}% - 1px)` }}
                    title={`Raw frame: ${formatSigned(rawHeadingErrorRad, 3)} rad`}
                  />
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-slate-900"
                    style={{ left: `calc(${yawNormPct}% - 1px)` }}
                  />
                  <div className="absolute top-0 bottom-0 left-1/2 w-px bg-emerald-900/40" />
                </div>
                <div className="flex justify-between text-[10px] font-mono text-slate-500 tabular-nums">
                  <span>-0.35 rad</span>
                  <span>-0.05</span>
                  <span className="text-emerald-800 font-semibold">0.00 rad</span>
                  <span>+0.05</span>
                  <span>+0.35 rad</span>
                </div>
              </div>
            </div>
          ) : (
            /* Real-Time Signed Horizontal Bar Chart */
            <div className="bg-[#F8FBF9] border border-emerald-900/10 rounded-md p-3">
              <div className="flex justify-between text-[11px] font-mono text-slate-500 mb-1">
                <span>Signed Deviation (% of Full-Scale Limit)</span>
                <span>0% = Centered</span>
              </div>
              <div className="h-28 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={barChartData}
                    layout="vertical"
                    margin={{ top: 4, right: 16, left: 8, bottom: 0 }}
                  >
                    <CartesianGrid stroke="#DCE7E0" strokeDasharray="3 3" horizontal={false} />
                    <XAxis
                      type="number"
                      domain={[-100, 100]}
                      stroke="#64748B"
                      fontSize={10}
                      tickFormatter={(v) => `${v}%`}
                      tickLine={false}
                    />
                    <YAxis
                      type="category"
                      dataKey="metric"
                      stroke="#334155"
                      fontSize={11}
                      width={125}
                      tickLine={false}
                    />
                    <Tooltip
                      formatter={(_val: any, _name: any, item: any) => [
                        `${item.payload.formatted} (Raw: ${item.payload.rawFormatted})`,
                        item.payload.metric,
                      ]}
                      contentStyle={{
                        backgroundColor: '#FFFFFF',
                        borderColor: '#CBD5E1',
                        borderRadius: '6px',
                        fontSize: '12px',
                        fontFamily: 'IBM Plex Mono, monospace',
                        color: '#0F172A',
                      }}
                    />
                    <ReferenceLine x={0} stroke="#047857" strokeWidth={1.5} />
                    <ReferenceLine x={-16} stroke="#10B981" strokeDasharray="3 3" />
                    <ReferenceLine x={16} stroke="#10B981" strokeDasharray="3 3" />
                    <Bar dataKey="valuePct" radius={[3, 3, 3, 3]} barSize={16} isAnimationActive={false}>
                      {barChartData.map((entry) => (
                        <Cell key={entry.metric} fill={entry.color} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Clean unboxed vision node footer metadata */}
          <div className="pt-2.5 border-t border-emerald-900/10 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-slate-500 tabular-nums">
            <span>
              Tracker:{' '}
              <span className={trackingLocked ? 'text-emerald-700 font-semibold' : 'text-amber-700 font-semibold'}>
                {trackingLocked ? 'LOCKED' : 'UNLOCKED'}
              </span>{' '}
              · Missed: {missedFrames} frames
            </span>
            <span>
              EMA α=(0.35, 0.30) · Stanley ω_z: {formatSigned(cmdWzRadS, 2)} rad/s
            </span>
          </div>
        </div>
      </div>
    </section>
  );
};
