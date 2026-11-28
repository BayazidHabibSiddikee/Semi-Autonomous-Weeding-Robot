import React, { useState } from 'react';
import {
  BatteryCharging,
  Camera,
  ExternalLink,
  Flame,
  MapPin,
  OctagonAlert,
  Pause,
  Play,
  Radar,
  Smartphone,
  Sparkles,
  Square,
  Thermometer,
  Wifi,
} from 'lucide-react';
import { CROP_FIELDS } from '../game/fieldTypesCatalog';
import { FieldWaypoint, NavRouteMode } from './WaypointEditorPanel';
import { HUGGING_FACE_MODELS, MaixSenseThermalState } from './MaixSenseThermalCornerPanel';

interface MobileAppPreviewProps {
  roverX: number;
  roverY: number;
  roverYawDeg: number;
  phase: string;
  currentRow: number;
  totalRows: number;
  coveragePct: number;
  running: boolean;
  estopActive: boolean;
  piMode: string;
  waypoints: FieldWaypoint[];
  activeWaypointIdx: number;
  navRouteMode: NavRouteMode;
  diagnostics: MaixSenseThermalState | null;
  worldW: number;
  worldH: number;
  onStartOrResume: () => void;
  onPause: () => void;
  onStop: () => void;
  onRunWaypoints: () => void;
}

type PhoneTab = 'plan' | 'live' | 'maixsense' | 'models';

export const MobileAppPreview: React.FC<MobileAppPreviewProps> = ({
  roverX,
  roverY,
  roverYawDeg,
  phase,
  currentRow,
  totalRows,
  coveragePct,
  running,
  estopActive,
  piMode,
  waypoints,
  activeWaypointIdx,
  navRouteMode,
  diagnostics,
  worldW,
  worldH,
  onStartOrResume,
  onPause,
  onStop,
  onRunWaypoints,
}) => {
  const [phoneTab, setPhoneTab] = useState<PhoneTab>('plan');
  const [lang, setLang] = useState<'EN' | 'BN'>('EN');
  const [cropIdx, setCropIdx] = useState<number>(0);

  const isBn = lang === 'BN';
  const visitedCount = waypoints.filter((w) => w.visited).length;
  const activeCrop = CROP_FIELDS[cropIdx % CROP_FIELDS.length];
  const camShiftX = Math.sin(roverX * 2.1 + roverY * 1.4) * 18;
  const weedBoxX = 112 + Math.cos(roverX * 2.7) * 34;

  return (
    <aside className="xl:sticky xl:top-20 flex flex-col items-center">
      {/* Section caption above phone */}
      <div className="w-full max-w-[310px] flex items-center justify-between mb-2 px-1">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-800">
          <Smartphone className="w-3.5 h-3.5 text-emerald-700" />
          <span>Android Companion Preview</span>
        </div>
        <span className="text-[10px] font-mono text-emerald-800 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
          LIVE SYNC
        </span>
      </div>

      {/* Realistic Android Smartphone Frame */}
      <div className="w-full max-w-[310px] rounded-[34px] bg-slate-900 p-2.5 shadow-xl border-[3px] border-slate-700">
        {/* Inner Phone Screen */}
        <div className="rounded-[26px] bg-[#F7FAF8] overflow-hidden flex flex-col h-[610px] border border-slate-800/40">
          {/* Android Status Bar + Punch-hole Camera */}
          <div className="bg-emerald-950 text-white px-4 pt-2 pb-1.5 flex items-center justify-between text-[10px] font-mono">
            <span>09:41</span>
            <span className="w-2.5 h-2.5 rounded-full bg-slate-950 border border-slate-700" />
            <div className="flex items-center gap-1.5">
              <Wifi className="w-3 h-3 text-emerald-300" />
              <BatteryCharging className="w-3.5 h-3.5 text-emerald-300" />
              <span>94%</span>
            </div>
          </div>

          {/* Android App TopBar (mirrors BeMainScreen.kt) */}
          <div className="bg-white border-b border-emerald-900/10 px-3 py-2 flex items-center justify-between">
            <div className="min-w-0">
              <div className="text-xs font-bold text-emerald-950 truncate">
                {isBn ? 'আগাছা দমন রোভার অ্যাপ' : 'WeedLaser BEV App'}
              </div>
              <div className="text-[10px] font-mono text-slate-500">
                {piMode === 'pi_live' ? 'Pi 4 Wi-Fi Linked' : 'Sim Link · 192.168.4.1'}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setLang((l) => (l === 'EN' ? 'BN' : 'EN'))}
              className="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200 cursor-pointer"
            >
              {isBn ? 'English' : 'বাংলা'}
            </button>
          </div>

          {/* Phone Screen Body */}
          <div className="flex-1 overflow-y-auto p-3 space-y-2.5 text-xs">
            {/* E-Stop Banner if Active */}
            {estopActive && (
              <div className="rounded-lg bg-rose-600 text-white px-2.5 py-2 flex items-center gap-1.5 text-[11px] font-semibold">
                <OctagonAlert className="w-4 h-4 shrink-0" />
                <span>{isBn ? 'জরুরি স্টপ চালু আছে (GPIO 13)' : 'E-STOP ACTIVE — MOTORS LOCKED'}</span>
              </div>
            )}

            {phoneTab === 'plan' && (
              <>
                {/* Live Rover Camera Output inside Right-Side Mobile App */}
                <div className="rounded-xl bg-slate-950 border border-slate-800 overflow-hidden">
                  <div className="px-2.5 py-1.5 flex items-center justify-between text-[10px] font-mono bg-slate-900 border-b border-slate-800">
                    <span className="text-emerald-300 font-semibold flex items-center gap-1">
                      <Camera className="w-3 h-3" />
                      <span>{isBn ? 'লাইভ ক্যামেরা আউটপুট' : 'LIVE CAM0 OUTPUT'}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setCropIdx((i) => (i + 1) % CROP_FIELDS.length)}
                      className="text-amber-300 hover:text-amber-200 cursor-pointer"
                      title="Cycle 8 crop classifier classes"
                    >
                      {activeCrop.modelClass} ({cropIdx + 1}/8)
                    </button>
                  </div>
                  <svg viewBox="0 0 240 104" className="w-full h-auto block">
                    <rect x="0" y="0" width="240" height="20" fill="#7aa4bd" />
                    <rect x="0" y="20" width="240" height="84" fill={activeCrop.soilCss} />
                    <polygon points="94,20 146,20 176,104 64,104" fill="rgba(20,14,9,0.28)" />
                    {/* Crop canopy detection box */}
                    <g transform={`translate(${(116 + camShiftX * 0.4).toFixed(1)}, 48)`}>
                      <ellipse cx="0" cy="0" rx="18" ry="11" fill={activeCrop.cropLeafCss} />
                      <circle cx="-5" cy="-2" r="3" fill={activeCrop.cropAccentCss} />
                      <circle cx="6" cy="2" r="2.8" fill={activeCrop.cropAccentCss} />
                      <rect
                        x="-22"
                        y="-14"
                        width="44"
                        height="27"
                        fill="none"
                        stroke="#34d399"
                        strokeWidth="1.2"
                      />
                      <rect x="-22" y="-24" width="66" height="10" fill="rgba(6,78,59,0.9)" />
                      <text x="-19" y="-16.5" fill="#a7f3d0" fontSize="6.5" fontFamily="monospace">
                        {activeCrop.modelClass} 96%
                      </text>
                    </g>
                    {/* Targeted weed detection box */}
                    <g transform={`translate(${weedBoxX.toFixed(1)}, 78)`}>
                      <ellipse cx="0" cy="0" rx="11" ry="6.5" fill="#84cc16" />
                      <rect
                        x="-15"
                        y="-10"
                        width="30"
                        height="19"
                        fill="none"
                        stroke="#f97316"
                        strokeWidth="1.5"
                      />
                      <rect x="-15" y="-19" width="64" height="9" fill="rgba(154,52,18,0.92)" />
                      <text x="-12" y="-12.5" fill="#fef3c7" fontSize="6.2" fontFamily="monospace">
                        {activeCrop.dominantWeeds[0]} 93%
                      </text>
                    </g>
                    {/* Servo nozzle aiming line */}
                    <line
                      x1="120"
                      y1="104"
                      x2={weedBoxX.toFixed(1)}
                      y2="78"
                      stroke="#fbbf24"
                      strokeWidth="1.4"
                      strokeDasharray="3 2"
                    />
                  </svg>
                </div>

                {/* Mini Live Field + Waypoint Map */}
                <div className="rounded-xl bg-white border border-emerald-900/10 p-2.5 space-y-2">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-semibold text-slate-800">
                      {isBn ? 'লাইভ ফিল্ড ও ওয়েপয়েন্ট ম্যাপ' : 'Field & Waypoint Map'}
                    </span>
                    <span className="font-mono text-[10px] text-emerald-700 font-semibold">
                      {navRouteMode === 'waypoints'
                        ? `WP ${Math.min(waypoints.length, activeWaypointIdx + 1)}/${waypoints.length}`
                        : `ROW ${currentRow}/${totalRows}`}
                    </span>
                  </div>

                  {/* Live SVG Mini-Map */}
                  <div className="rounded-lg bg-[#EEF5F0] border border-emerald-900/10 p-1">
                    <svg viewBox="0 0 240 120" className="w-full h-auto block">
                      {/* Crop ridges */}
                      {[0.2, 0.4, 0.6, 0.8].map((frac, idx) => (
                        <line
                          key={idx}
                          x1="22"
                          y1={frac * 120}
                          x2="218"
                          y2={frac * 120}
                          stroke="#86EFAC"
                          strokeWidth="3"
                          strokeLinecap="round"
                        />
                      ))}

                      {/* Waypoint polyline */}
                      {waypoints.length > 1 && (
                        <polyline
                          fill="none"
                          stroke="#059669"
                          strokeWidth="1.8"
                          strokeDasharray="3 2"
                          points={waypoints
                            .map(
                              (w) =>
                                `${((w.x / Math.max(1, worldW)) * 240).toFixed(1)},${(
                                  (w.y / Math.max(1, worldH)) *
                                  120
                                ).toFixed(1)}`
                            )
                            .join(' ')}
                        />
                      )}

                      {/* Waypoint dots */}
                      {waypoints.map((w, idx) => {
                        const cx = (w.x / Math.max(1, worldW)) * 240;
                        const cy = (w.y / Math.max(1, worldH)) * 120;
                        const active = navRouteMode === 'waypoints' && idx === activeWaypointIdx && !w.visited;
                        return (
                          <g key={w.id}>
                            <circle
                              cx={cx}
                              cy={cy}
                              r={active ? 5 : 3.5}
                              fill={w.visited ? '#10B981' : w.treatWeed ? '#EA580C' : '#0284C7'}
                              stroke="#FFFFFF"
                              strokeWidth="1.2"
                            />
                          </g>
                        );
                      })}

                      {/* Live Rover Pose Marker */}
                      <g
                        transform={`translate(${((roverX / Math.max(1, worldW)) * 240).toFixed(1)}, ${(
                          (roverY / Math.max(1, worldH)) *
                          120
                        ).toFixed(1)}) rotate(${roverYawDeg.toFixed(1)})`}
                      >
                        <rect
                          x="-7"
                          y="-4.5"
                          width="14"
                          height="9"
                          rx="2"
                          fill="#0F172A"
                          stroke="#34D399"
                          strokeWidth="1.4"
                        />
                        <polygon points="7,0 12,-3 12,3" fill="#F59E0B" />
                      </g>
                    </svg>
                  </div>

                  {/* Pose & Coverage Row */}
                  <div className="grid grid-cols-2 gap-1.5 text-[10px] font-mono">
                    <div className="bg-[#F7FAF8] rounded p-1.5 border border-slate-200/70">
                      <div className="text-slate-500">POSE (X, Y)</div>
                      <div className="font-bold text-slate-900">
                        {roverX.toFixed(1)}m, {roverY.toFixed(1)}m
                      </div>
                    </div>
                    <div className="bg-[#F7FAF8] rounded p-1.5 border border-slate-200/70">
                      <div className="text-slate-500">COVERAGE</div>
                      <div className="font-bold text-emerald-700">{coveragePct.toFixed(0)}%</div>
                    </div>
                  </div>
                </div>

                {/* Mobile Mission Action Buttons (Live Connected!) */}
                <div className="rounded-xl bg-white border border-emerald-900/10 p-2.5 space-y-2">
                  <div className="text-[11px] font-semibold text-slate-800">
                    {isBn ? 'রোভার মিশন কন্ট্রোল' : 'Quick Mission Dispatch'}
                  </div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {running ? (
                      <button
                        type="button"
                        onClick={onPause}
                        disabled={estopActive}
                        className="py-2 rounded-lg bg-amber-500 hover:bg-amber-600 text-white text-[11px] font-semibold flex items-center justify-center gap-1 cursor-pointer disabled:opacity-50"
                      >
                        <Pause className="w-3.5 h-3.5" />
                        <span>{isBn ? 'বিরতি' : 'Pause'}</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={onStartOrResume}
                        disabled={estopActive}
                        className="py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-semibold flex items-center justify-center gap-1 cursor-pointer disabled:opacity-50"
                      >
                        <Play className="w-3.5 h-3.5" />
                        <span>{isBn ? 'চালু করুন' : 'Start'}</span>
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={onStop}
                      className="py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-[11px] font-semibold flex items-center justify-center gap-1 cursor-pointer"
                    >
                      <Square className="w-3 h-3 fill-current" />
                      <span>{isBn ? 'থামান' : 'Stop'}</span>
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={onRunWaypoints}
                    disabled={estopActive || waypoints.length === 0}
                    className="w-full py-2 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:bg-slate-200 disabled:text-slate-400 text-white text-[11px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <MapPin className="w-3.5 h-3.5 text-emerald-400" />
                    <span>
                      {isBn
                        ? `ওয়েপয়েন্ট চক্র চালান (${waypoints.length})`
                        : `Dispatch ${waypoints.length} Waypoints`}
                    </span>
                  </button>
                </div>

                {/* Compact Waypoint List inside Phone */}
                <div className="rounded-xl bg-white border border-emerald-900/10 p-2.5 space-y-1.5">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-semibold text-slate-800">
                      {isBn ? 'নির্ধারিত ওয়েপয়েন্ট' : 'Queued Coordinates'}
                    </span>
                    <span className="font-mono text-[10px] text-slate-500">
                      {visitedCount}/{waypoints.length}
                    </span>
                  </div>
                  {waypoints.length === 0 ? (
                    <div className="text-[11px] text-slate-500 py-1">
                      Add points in the editor to sync to mobile.
                    </div>
                  ) : (
                    <div className="space-y-1 max-h-28 overflow-y-auto">
                      {waypoints.slice(0, 6).map((w, i) => (
                        <div
                          key={w.id}
                          className="flex items-center justify-between text-[10px] font-mono px-2 py-1 rounded bg-[#F7FAF8] border border-slate-200/70"
                        >
                          <span className="truncate font-semibold text-slate-800">
                            #{i + 1} ({w.x.toFixed(1)}, {w.y.toFixed(1)})
                          </span>
                          <span
                            className={
                              w.visited
                                ? 'text-emerald-700 font-bold'
                                : w.treatWeed
                                ? 'text-orange-600 font-semibold'
                                : 'text-slate-500'
                            }
                          >
                            {w.visited ? 'DONE' : w.treatWeed ? 'FLAME' : 'GO'}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}

            {phoneTab === 'live' && (
              <div className="space-y-2.5">
                <div className="rounded-xl bg-slate-900 text-white p-3 space-y-2">
                  <div className="flex items-center justify-between text-[10px] font-mono">
                    <span className="text-emerald-300 font-semibold">LIVE ROVER TELEMETRY</span>
                    <span>{phase}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
                    <div className="bg-white/10 rounded p-2">
                      <div className="text-slate-400 text-[10px]">Nozzle Temp</div>
                      <div className="font-bold text-amber-300 flex items-center gap-1 mt-0.5">
                        <Flame className="w-3.5 h-3.5" />
                        {diagnostics ? `${diagnostics.nozzleTempC}°C` : '58.0°C'}
                      </div>
                    </div>
                    <div className="bg-white/10 rounded p-2">
                      <div className="text-slate-400 text-[10px]">Crop Margin</div>
                      <div className="font-bold text-emerald-300 mt-0.5">
                        {diagnostics ? `${diagnostics.cropMarginTempC}°C` : '28.5°C'}
                      </div>
                    </div>
                    <div className="bg-white/10 rounded p-2">
                      <div className="text-slate-400 text-[10px]">Pi 4 SoC</div>
                      <div className="font-bold text-white mt-0.5">
                        {diagnostics ? `${diagnostics.piCpuTempC}°C` : '55.0°C'}
                      </div>
                    </div>
                    <div className="bg-white/10 rounded p-2">
                      <div className="text-slate-400 text-[10px]">L298N Driver</div>
                      <div className="font-bold text-white mt-0.5">
                        {diagnostics ? `${diagnostics.driverTempC}°C` : '44.0°C'}
                      </div>
                    </div>
                  </div>
                </div>

                <div
                  className={`rounded-xl border p-2.5 text-[11px] ${
                    diagnostics?.thermalAlert
                      ? 'bg-rose-50 border-rose-300 text-rose-900 font-semibold'
                      : 'bg-emerald-50 border-emerald-200 text-emerald-900'
                  }`}
                >
                  {diagnostics?.thermalAlert
                    ? 'OVERHEAT ALERT: Butane flame interlock engaged!'
                    : 'IR Thermal Check PASS: Tomato canopy safe & electronics cool.'}
                </div>
              </div>
            )}

            {phoneTab === 'maixsense' && (
              <div className="space-y-2.5">
                <div className="rounded-xl bg-white border border-emerald-900/10 p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-slate-900">MaixSense-A075V ToF</span>
                    <span className="text-[10px] font-mono text-emerald-700">192.168.233.1</span>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5 text-center font-mono">
                    <div className="rounded bg-sky-50 border border-sky-200 p-1.5">
                      <div className="text-[9px] text-sky-700">LEFT</div>
                      <div className="font-bold text-slate-900">{diagnostics?.leftMm ?? 740}</div>
                    </div>
                    <div className="rounded bg-emerald-50 border border-emerald-200 p-1.5">
                      <div className="text-[9px] text-emerald-700">CENTER</div>
                      <div className="font-bold text-slate-900">{diagnostics?.centerMm ?? 1450}</div>
                    </div>
                    <div className="rounded bg-violet-50 border border-violet-200 p-1.5">
                      <div className="text-[9px] text-violet-700">RIGHT</div>
                      <div className="font-bold text-slate-900">{diagnostics?.rightMm ?? 760}</div>
                    </div>
                  </div>
                  <div className="rounded-md bg-amber-50 border border-amber-200 p-2 text-[11px]">
                    <div className="font-mono font-bold text-amber-950">
                      {diagnostics?.cornerClass ?? 'CLEAR_CORRIDOR'}
                    </div>
                    <div className="text-amber-900 mt-0.5">
                      {diagnostics?.suggestedAction ?? 'Furrow clear — nominal navigation'}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {phoneTab === 'models' && (
              <div className="space-y-2">
                <div className="text-[11px] font-semibold text-slate-800 px-0.5">
                  Hugging Face Rover Vision Models
                </div>
                {HUGGING_FACE_MODELS.map((m) => (
                  <a
                    key={m.id}
                    href={m.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block rounded-lg bg-white border border-emerald-900/10 hover:border-emerald-400 p-2.5 space-y-1 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-1 text-[11px] font-mono font-bold text-emerald-800">
                      <span className="truncate">{m.name}</span>
                      <ExternalLink className="w-3 h-3 shrink-0" />
                    </div>
                    <div className="text-[10px] text-slate-600 leading-snug">{m.whyNeeded}</div>
                  </a>
                ))}
              </div>
            )}
          </div>

          {/* Android Material 3 Bottom Navigation Bar */}
          <div className="bg-white border-t border-emerald-900/10 grid grid-cols-4 px-1 py-1.5 text-[10px]">
            {(
              [
                { id: 'plan', label: isBn ? 'প্ল্যান' : 'Plan', Icon: MapPin },
                { id: 'live', label: isBn ? 'তাপমাত্রা' : 'Thermal', Icon: Thermometer },
                { id: 'maixsense', label: isBn ? 'কর্নার' : 'Corners', Icon: Radar },
                { id: 'models', label: 'HF AI', Icon: Sparkles },
              ] as const
            ).map(({ id, label, Icon }) => {
              const active = phoneTab === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setPhoneTab(id)}
                  className={`flex flex-col items-center gap-0.5 py-1 rounded-lg cursor-pointer transition-colors ${
                    active ? 'bg-emerald-50 text-emerald-800 font-semibold' : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </aside>
  );
};
