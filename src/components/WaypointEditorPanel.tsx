import React, { useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Crosshair,
  Flame,
  MapPin,
  Navigation,
  Play,
  Plus,
  Route,
  Trash2,
} from 'lucide-react';

export interface FieldWaypoint {
  id: number;
  x: number;
  y: number;
  label: string;
  treatWeed: boolean;
  visited: boolean;
}

export type NavRouteMode = 'rows' | 'waypoints';
export type MapClickMode = 'waypoint' | 'obstacle';

interface WaypointEditorPanelProps {
  waypoints: FieldWaypoint[];
  activeWaypointIdx: number;
  navRouteMode: NavRouteMode;
  mapClickMode: MapClickMode;
  maxX: number;
  maxY: number;
  rowWidthM: number;
  disabled?: boolean;
  onChangeNavRouteMode: (mode: NavRouteMode) => void;
  onChangeMapClickMode: (mode: MapClickMode) => void;
  onAddWaypoint: (x: number, y: number, treatWeed: boolean, label?: string) => void;
  onUpdateWaypoint: (id: number, patch: Partial<Omit<FieldWaypoint, 'id'>>) => void;
  onRemoveWaypoint: (id: number) => void;
  onMoveWaypoint: (index: number, delta: -1 | 1) => void;
  onClearWaypoints: () => void;
  onLoadPreset: (preset: 'weed_cycle' | 'corner_check' | 'spot_hotspots') => void;
  onRunWaypointCycle: () => void;
}

export const WaypointEditorPanel: React.FC<WaypointEditorPanelProps> = ({
  waypoints,
  activeWaypointIdx,
  navRouteMode,
  mapClickMode,
  maxX,
  maxY,
  disabled = false,
  onChangeNavRouteMode,
  onChangeMapClickMode,
  onAddWaypoint,
  onUpdateWaypoint,
  onRemoveWaypoint,
  onMoveWaypoint,
  onClearWaypoints,
  onLoadPreset,
  onRunWaypointCycle,
}) => {
  const [inputX, setInputX] = useState<string>('2.40');
  const [inputY, setInputY] = useState<string>('0.90');
  const [inputLabel, setInputLabel] = useState<string>('');
  const [inputTreat, setInputTreat] = useState<boolean>(true);

  const totalDistanceM = waypoints.reduce((acc, wp, idx) => {
    if (idx === 0) return 0;
    const prev = waypoints[idx - 1];
    return acc + Math.hypot(wp.x - prev.x, wp.y - prev.y);
  }, 0);

  const treatCount = waypoints.filter((w) => w.treatWeed).length;
  const visitedCount = waypoints.filter((w) => w.visited).length;

  const handleManualAdd = (e: React.FormEvent) => {
    e.preventDefault();
    const parsedX = Number.parseFloat(inputX);
    const parsedY = Number.parseFloat(inputY);
    if (Number.isNaN(parsedX) || Number.isNaN(parsedY)) return;
    const clampedX = Number(Math.max(0.35, Math.min(maxX - 0.35, parsedX)).toFixed(2));
    const clampedY = Number(Math.max(0.35, Math.min(maxY - 0.35, parsedY)).toFixed(2));
    onAddWaypoint(clampedX, clampedY, inputTreat, inputLabel.trim() || undefined);
    setInputLabel('');
    setInputX(Math.min(maxX - 0.45, clampedX + 1.2).toFixed(2));
  };

  return (
    <section className="bg-white border border-emerald-900/10 rounded-lg p-4 space-y-4">
      {/* Header + Route Execution Mode Toggle */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-emerald-900/10 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <Route className="w-4 h-4 text-emerald-700" />
            <h3 className="text-sm font-semibold text-slate-900">
              Weed-Clearing Waypoint Editor
            </h3>
            <span className="px-2 py-0.5 text-[10px] font-mono font-semibold rounded bg-emerald-50 text-emerald-800 border border-emerald-200">
              {waypoints.length} PTS · {totalDistanceM.toFixed(1)} m
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Define ordered (X, Y) field coordinates or click directly on the Field Map to build a custom weed-clearing path.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Map Click Action Mode */}
          <div className="inline-flex items-center p-0.5 rounded-md bg-[#F3F8F5] border border-emerald-900/10 text-xs">
            <button
              type="button"
              onClick={() => onChangeMapClickMode('waypoint')}
              className={`px-2.5 py-1 rounded font-medium flex items-center gap-1 cursor-pointer transition-colors ${
                mapClickMode === 'waypoint'
                  ? 'bg-emerald-600 text-white'
                  : 'text-slate-600 hover:text-emerald-800'
              }`}
            >
              <MapPin className="w-3 h-3" />
              <span>Map Click: Add WP</span>
            </button>
            <button
              type="button"
              onClick={() => onChangeMapClickMode('obstacle')}
              className={`px-2.5 py-1 rounded font-medium flex items-center gap-1 cursor-pointer transition-colors ${
                mapClickMode === 'obstacle'
                  ? 'bg-rose-600 text-white'
                  : 'text-slate-600 hover:text-rose-700'
              }`}
            >
              <Crosshair className="w-3 h-3" />
              <span>Map Click: Obstacle</span>
            </button>
          </div>

          {/* Route Mode Switch */}
          <div className="inline-flex items-center p-0.5 rounded-md bg-[#F3F8F5] border border-emerald-900/10 text-xs">
            <button
              type="button"
              onClick={() => onChangeNavRouteMode('rows')}
              className={`px-2.5 py-1 rounded font-medium cursor-pointer transition-colors ${
                navRouteMode === 'rows'
                  ? 'bg-white text-emerald-800 border border-emerald-200'
                  : 'text-slate-600 hover:text-emerald-800'
              }`}
            >
              Auto Rows
            </button>
            <button
              type="button"
              onClick={() => onChangeNavRouteMode('waypoints')}
              className={`px-2.5 py-1 rounded font-medium flex items-center gap-1 cursor-pointer transition-colors ${
                navRouteMode === 'waypoints'
                  ? 'bg-emerald-700 text-white'
                  : 'text-slate-600 hover:text-emerald-800'
              }`}
            >
              <Navigation className="w-3 h-3" />
              <span>Follow Waypoints</span>
            </button>
          </div>
        </div>
      </div>

      {/* Quick Presets + Run Cycle CTA */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-slate-500 font-medium mr-1">Presets:</span>
          <button
            type="button"
            onClick={() => onLoadPreset('weed_cycle')}
            className="px-2.5 py-1 rounded border border-emerald-200 bg-emerald-50/70 hover:bg-emerald-100 text-emerald-900 font-medium cursor-pointer"
          >
            4-Row Weed Cycle
          </button>
          <button
            type="button"
            onClick={() => onLoadPreset('corner_check')}
            className="px-2.5 py-1 rounded border border-slate-200 bg-[#F8FBF9] hover:bg-emerald-50 text-slate-700 font-medium cursor-pointer"
          >
            Corner Inspection Loop
          </button>
          <button
            type="button"
            onClick={() => onLoadPreset('spot_hotspots')}
            className="px-2.5 py-1 rounded border border-slate-200 bg-[#F8FBF9] hover:bg-emerald-50 text-slate-700 font-medium cursor-pointer"
          >
            Spot-Treat Hotspots
          </button>
          {waypoints.length > 0 && (
            <button
              type="button"
              onClick={onClearWaypoints}
              className="px-2 py-1 rounded border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-700 font-medium inline-flex items-center gap-1 cursor-pointer"
            >
              <Trash2 className="w-3 h-3" />
              <span>Clear</span>
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={onRunWaypointCycle}
          disabled={disabled || waypoints.length === 0}
          className="px-3.5 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-200 disabled:text-slate-500 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
        >
          <Play className="w-3.5 h-3.5" />
          <span>Run Waypoint Weed Cycle</span>
        </button>
      </div>

      {/* Add Coordinate Form */}
      <form
        onSubmit={handleManualAdd}
        className="grid grid-cols-2 sm:grid-cols-12 gap-2 items-end bg-[#F7FAF8] border border-emerald-900/10 rounded-lg p-3"
      >
        <label className="sm:col-span-2 space-y-1 text-xs">
          <span className="text-slate-600 font-medium block">X (m)</span>
          <input
            type="number"
            step="0.05"
            min="0.35"
            max={(maxX - 0.35).toFixed(2)}
            value={inputX}
            onChange={(e) => setInputX(e.target.value)}
            className="w-full px-2 py-1.5 rounded border border-slate-200 bg-white font-mono text-xs text-slate-900"
          />
        </label>
        <label className="sm:col-span-2 space-y-1 text-xs">
          <span className="text-slate-600 font-medium block">Y (m)</span>
          <input
            type="number"
            step="0.05"
            min="0.35"
            max={(maxY - 0.35).toFixed(2)}
            value={inputY}
            onChange={(e) => setInputY(e.target.value)}
            className="w-full px-2 py-1.5 rounded border border-slate-200 bg-white font-mono text-xs text-slate-900"
          />
        </label>
        <label className="col-span-2 sm:col-span-4 space-y-1 text-xs">
          <span className="text-slate-600 font-medium block">Label (optional)</span>
          <input
            type="text"
            placeholder="e.g. Row 2 Weed Patch"
            value={inputLabel}
            onChange={(e) => setInputLabel(e.target.value)}
            className="w-full px-2.5 py-1.5 rounded border border-slate-200 bg-white text-xs text-slate-900"
          />
        </label>
        <label className="sm:col-span-2 flex items-center gap-1.5 text-xs text-slate-700 py-1.5 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={inputTreat}
            onChange={(e) => setInputTreat(e.target.checked)}
            className="accent-orange-600 w-3.5 h-3.5"
          />
          <Flame className="w-3.5 h-3.5 text-orange-600 shrink-0" />
          <span className="font-medium">Clear Weed</span>
        </label>
        <div className="sm:col-span-2">
          <button
            type="submit"
            className="w-full px-3 py-1.5 rounded-md bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold inline-flex items-center justify-center gap-1 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Add Point</span>
          </button>
        </div>
      </form>

      {/* Coordinate Queue Table */}
      {waypoints.length === 0 ? (
        <div className="rounded-lg border border-dashed border-emerald-900/20 bg-[#FAFDFB] p-4 text-center text-xs text-slate-500">
          No waypoints defined yet. Click on the Field Map above (with <span className="font-semibold text-emerald-700">Add WP</span> active), enter X/Y coordinates, or load a preset cycle.
        </div>
      ) : (
        <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
          {waypoints.map((wp, idx) => {
            const isActive = navRouteMode === 'waypoints' && idx === activeWaypointIdx && !wp.visited;
            return (
              <div
                key={wp.id}
                className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-md border text-xs transition-colors ${
                  isActive
                    ? 'bg-emerald-50 border-emerald-400'
                    : wp.visited
                    ? 'bg-slate-50 border-slate-200 opacity-80'
                    : 'bg-white border-emerald-900/10 hover:border-emerald-300'
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`w-6 h-6 rounded-full font-mono text-[11px] font-bold flex items-center justify-center shrink-0 ${
                      wp.visited
                        ? 'bg-emerald-600 text-white'
                        : isActive
                        ? 'bg-amber-500 text-slate-950'
                        : 'bg-slate-200 text-slate-700'
                    }`}
                  >
                    {wp.visited ? <CheckCircle2 className="w-3.5 h-3.5" /> : idx + 1}
                  </span>
                  <div className="min-w-0">
                    <div className="font-semibold text-slate-900 truncate">{wp.label}</div>
                    <div className="text-[11px] font-mono text-slate-500">
                      {wp.visited ? 'CLEARED' : isActive ? 'ACTIVE TARGET' : 'QUEUED'}
                    </div>
                  </div>
                </div>

                {/* Inline X / Y Editors + Treat Toggle + Reorder */}
                <div className="flex flex-wrap items-center gap-1.5">
                  <label className="flex items-center gap-1 font-mono text-[11px] text-slate-600">
                    <span>X</span>
                    <input
                      type="number"
                      step="0.05"
                      min="0.35"
                      max={(maxX - 0.35).toFixed(2)}
                      value={wp.x}
                      onChange={(e) => {
                        const v = Number.parseFloat(e.target.value);
                        if (!Number.isNaN(v)) {
                          onUpdateWaypoint(wp.id, {
                            x: Number(Math.max(0.35, Math.min(maxX - 0.35, v)).toFixed(2)),
                          });
                        }
                      }}
                      className="w-16 px-1.5 py-0.5 rounded border border-slate-200 bg-white text-slate-900 font-mono text-xs"
                    />
                  </label>
                  <label className="flex items-center gap-1 font-mono text-[11px] text-slate-600">
                    <span>Y</span>
                    <input
                      type="number"
                      step="0.05"
                      min="0.35"
                      max={(maxY - 0.35).toFixed(2)}
                      value={wp.y}
                      onChange={(e) => {
                        const v = Number.parseFloat(e.target.value);
                        if (!Number.isNaN(v)) {
                          onUpdateWaypoint(wp.id, {
                            y: Number(Math.max(0.35, Math.min(maxY - 0.35, v)).toFixed(2)),
                          });
                        }
                      }}
                      className="w-16 px-1.5 py-0.5 rounded border border-slate-200 bg-white text-slate-900 font-mono text-xs"
                    />
                  </label>

                  <button
                    type="button"
                    onClick={() => onUpdateWaypoint(wp.id, { treatWeed: !wp.treatWeed })}
                    title="Toggle butane flame / treatment pause at this waypoint"
                    className={`px-2 py-1 rounded text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer border ${
                      wp.treatWeed
                        ? 'bg-orange-50 border-orange-300 text-orange-800'
                        : 'bg-slate-50 border-slate-200 text-slate-600'
                    }`}
                  >
                    <Flame className="w-3 h-3" />
                    <span>{wp.treatWeed ? 'Treat' : 'Transit'}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => onMoveWaypoint(idx, -1)}
                    disabled={idx === 0}
                    className="p-1 rounded border border-slate-200 text-slate-600 hover:bg-slate-100 disabled:opacity-30 cursor-pointer"
                    title="Move up"
                  >
                    <ArrowUp className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onMoveWaypoint(idx, 1)}
                    disabled={idx === waypoints.length - 1}
                    className="p-1 rounded border border-slate-200 text-slate-600 hover:bg-slate-100 disabled:opacity-30 cursor-pointer"
                    title="Move down"
                  >
                    <ArrowDown className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => onRemoveWaypoint(wp.id)}
                    className="p-1 rounded border border-rose-200 text-rose-600 hover:bg-rose-50 cursor-pointer"
                    title="Delete waypoint"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Compact Footer Stats */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-emerald-900/10 text-[11px] font-mono text-slate-600">
        <span>
          Progress: {visitedCount}/{waypoints.length} visited · {treatCount} weed-clear stops
        </span>
        <span>
          Active Controller:{' '}
          <strong className="text-emerald-800">
            {navRouteMode === 'waypoints' ? 'CUSTOM WAYPOINT CYCLE' : 'STANDARD ROW FOLLOWER'}
          </strong>
        </span>
      </div>
    </section>
  );
};
