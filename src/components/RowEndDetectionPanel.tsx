import React from 'react';
import {
  CornerDownRight,
  CornerDownLeft,
  Flag,
  Bell,
  BellOff,
  ScanEye,
  CheckCircle2,
  X,
  FastForward,
  Power,
  Activity,
} from 'lucide-react';
import {
  RowEndDetectionConfig,
  RowEndDetectionSnapshot,
  formatTurnLabel,
} from '../services/rowEndDetectionService';

interface Props {
  snapshot: RowEndDetectionSnapshot;
  config: RowEndDetectionConfig;
  estopActive: boolean;
  isFaulted: boolean;
  onUpdateConfig: (patch: Partial<RowEndDetectionConfig>) => void;
  onExecuteTurn: () => void;
  onDismissAlert: () => void;
  onInvokeServiceCheck: () => void;
  onJumpToRowEndTest: () => void;
}

export const RowEndDetectionPanel: React.FC<Props> = ({
  snapshot,
  config,
  estopActive,
  isFaulted,
  onUpdateConfig,
  onExecuteTurn,
  onDismissAlert,
  onInvokeServiceCheck,
  onJumpToRowEndTest,
}) => {
  const {
    state,
    confidence,
    farGreenPct,
    nearGreenPct,
    confirmCount,
    confirmRequired,
    recommendedTurn,
    nextRow,
    currentRow,
    sourceLabel,
    cooldownRemainingMs,
    activeAlert,
    alertHistory,
    lastServiceResponse,
  } = snapshot;

  const confPct = Math.round(confidence * 100);
  const threshPct = Math.round(config.confidenceThreshold * 100);

  const stateDisplay =
    state === 'ROW_END_DETECTED'
      ? { label: '■ ROW END ALERT', tone: 'text-amber-700' }
      : state === 'TURN_EXECUTING'
      ? { label: '↻ EXECUTING TURN', tone: 'text-emerald-700' }
      : state === 'APPROACHING_ROW_END'
      ? { label: '▲ APPROACHING END', tone: 'text-amber-700' }
      : state === 'COOLDOWN'
      ? { label: `○ COOLDOWN (${(cooldownRemainingMs / 1000).toFixed(1)}s)`, tone: 'text-slate-500' }
      : state === 'DISABLED'
      ? { label: '○ SERVICE PAUSED', tone: 'text-slate-500' }
      : { label: '● SCANNING ROW', tone: 'text-emerald-700' };

  const TurnIcon =
    recommendedTurn === 'LEFT_U_TURN'
      ? CornerDownLeft
      : recommendedTurn === 'FINAL_ROW_STOP'
      ? Flag
      : CornerDownRight;

  return (
    <section
      aria-label="Row-End Detection Service"
      className="bg-white border border-emerald-900/10 rounded-lg p-4 space-y-4"
    >
      {/* Active Turn Execution Alert Banner */}
      {activeAlert && (activeAlert.status === 'PENDING_TURN' || activeAlert.status === 'EXECUTING') && (
        <div
          role="alert"
          className={`rounded-md border p-3.5 flex flex-col md:flex-row md:items-center justify-between gap-3 ${
            activeAlert.status === 'PENDING_TURN'
              ? 'bg-amber-50 border-amber-300 text-amber-950'
              : 'bg-emerald-50 border-emerald-300 text-emerald-950'
          }`}
        >
          <div className="flex items-start gap-3">
            <div
              className={`w-9 h-9 rounded-md flex items-center justify-center shrink-0 border ${
                activeAlert.status === 'PENDING_TURN'
                  ? 'bg-white border-amber-300 text-amber-700'
                  : 'bg-white border-emerald-300 text-emerald-700'
              }`}
            >
              <TurnIcon className="w-5 h-5" />
            </div>
            <div className="space-y-0.5">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
                <span className="text-xs font-mono font-bold tracking-wide uppercase">
                  {activeAlert.status === 'PENDING_TURN'
                    ? activeAlert.recommendedTurn === 'FINAL_ROW_STOP'
                      ? 'ROW END DETECTED — FINAL ROW COMPLETE'
                      : 'ROW END DETECTED — TURN EXECUTION ALERT'
                    : 'HEADLAND U-TURN EXECUTING (NAV2)'}
                </span>
                <span className="text-[11px] font-mono opacity-80 tabular-nums">
                  {activeAlert.id} · {activeAlert.triggeredAt}
                </span>
              </div>
              <div className="text-xs font-medium">
                {activeAlert.nextRow !== null
                  ? `Row ${activeAlert.row} → Row ${activeAlert.nextRow} · ${formatTurnLabel(
                      activeAlert.recommendedTurn
                    )}`
                  : `Row ${activeAlert.row} finished · Safe headland stop ready`}
              </div>
              <div className="text-[11px] font-mono opacity-80 tabular-nums">
                Vision Conf: {Math.round(activeAlert.confidence * 100)}% · Far-ROI Green:{' '}
                {activeAlert.farGreenPct.toFixed(1)}% · Near-ROI: {activeAlert.nearGreenPct.toFixed(1)}% ·{' '}
                {activeAlert.sourceLabel}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {activeAlert.status === 'PENDING_TURN' ? (
              <>
                <button
                  onClick={onExecuteTurn}
                  disabled={estopActive || isFaulted}
                  className="px-3.5 py-2 text-xs font-semibold rounded-md bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 disabled:text-slate-600 text-white transition-colors flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
                >
                  <TurnIcon className="w-3.5 h-3.5" />
                  <span>
                    {activeAlert.recommendedTurn === 'FINAL_ROW_STOP'
                      ? 'Complete Mission'
                      : 'Execute Headland Turn'}
                  </span>
                </button>
                <button
                  onClick={onDismissAlert}
                  className="px-2.5 py-2 text-xs font-medium rounded-md bg-white hover:bg-amber-100/70 border border-amber-300 text-amber-900 transition-colors flex items-center gap-1 cursor-pointer whitespace-nowrap"
                >
                  <X className="w-3.5 h-3.5" />
                  <span>Dismiss</span>
                </button>
              </>
            ) : (
              <span className="text-xs font-mono font-semibold text-emerald-800 flex items-center gap-1.5 px-2.5 py-1.5 bg-white border border-emerald-200 rounded-md">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                <span>Executing Waypoint U-Turn...</span>
              </span>
            )}
          </div>
        </div>
      )}

      {/* Service Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-emerald-900/10 pb-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <div className="flex items-center gap-2">
            <ScanEye className="w-4 h-4 text-emerald-600 shrink-0" />
            <h3 className="text-sm font-semibold text-slate-900">
              Vision Service: <span className="font-mono text-emerald-800">row_end_detection</span>
            </h3>
          </div>
          <span className="text-xs font-mono text-slate-500">
            /navigation/row_end_detection · Far-ROI ExG Depletion + Debounce
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-xs font-mono font-semibold tabular-nums ${stateDisplay.tone}`}>
            {stateDisplay.label}
          </span>

          <button
            onClick={() => onUpdateConfig({ audioAlert: !config.audioAlert })}
            title="Toggle subtle audio chime on row-end turn alert"
            className={`px-2 py-1.5 text-xs font-medium rounded-md border flex items-center gap-1 cursor-pointer transition-colors ${
              config.audioAlert
                ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                : 'bg-[#F8FBF9] border-slate-200 text-slate-600 hover:border-emerald-300'
            }`}
          >
            {config.audioAlert ? (
              <Bell className="w-3.5 h-3.5 text-emerald-600" />
            ) : (
              <BellOff className="w-3.5 h-3.5 text-slate-400" />
            )}
            <span>Chime</span>
          </button>

          <button
            onClick={() => onUpdateConfig({ enabled: !config.enabled })}
            className={`px-2.5 py-1.5 text-xs font-semibold rounded-md border flex items-center gap-1.5 cursor-pointer transition-colors ${
              config.enabled
                ? 'bg-emerald-50 border-emerald-300 text-emerald-800 hover:bg-emerald-100'
                : 'bg-slate-100 border-slate-300 text-slate-600 hover:bg-slate-200'
            }`}
          >
            <Power className="w-3.5 h-3.5" />
            <span>{config.enabled ? 'Active' : 'Paused'}</span>
          </button>
        </div>
      </div>

      {/* Main 12-Column Diagnostics & Controls */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
        {/* Left: Live Vision Row-End Metrics */}
        <div className="lg:col-span-7 space-y-3.5">
          {/* Confidence Bar with Threshold Marker */}
          <div className="bg-[#F8FBF9] border border-emerald-900/10 rounded-md p-3 space-y-2">
            <div className="flex items-center justify-between text-xs font-mono tabular-nums">
              <span className="text-slate-700 font-medium">
                Row-End Confidence (Trigger ≥ {threshPct}%)
              </span>
              <span
                className={`font-semibold ${
                  confPct >= threshPct
                    ? 'text-amber-700'
                    : confPct >= threshPct - 20
                    ? 'text-amber-600'
                    : 'text-emerald-700'
                }`}
              >
                {confPct}% · Confirm {confirmCount}/{confirmRequired} frames
              </span>
            </div>

            <div className="relative h-4 rounded bg-[#EDF5F0] border border-emerald-900/15 overflow-hidden">
              <div
                className={`h-full transition-all duration-100 ${
                  confPct >= threshPct
                    ? 'bg-amber-500'
                    : confPct >= threshPct - 20
                    ? 'bg-amber-400/80'
                    : 'bg-emerald-600'
                }`}
                style={{ width: `${Math.max(2, confPct)}%` }}
              />
              {/* Threshold tick line */}
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-slate-900"
                style={{ left: `${threshPct}%` }}
                title={`Trigger threshold: ${threshPct}%`}
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-slate-500 tabular-nums">
              <span>Source: {sourceLabel}</span>
              <span>
                Queued Maneuver:{' '}
                <strong className="text-slate-800">
                  {nextRow !== null ? `Row ${currentRow}→${nextRow} (${recommendedTurn})` : 'FINAL_ROW_STOP'}
                </strong>
              </span>
            </div>
          </div>

          {/* Far-ROI vs Near-ROI Foliage Density Breakdown */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="bg-[#F8FBF9] border border-emerald-900/10 rounded-md p-3 space-y-1.5">
              <div className="flex items-center justify-between text-xs font-mono tabular-nums">
                <span className="text-slate-600">Far-ROI Foliage (Top 1/3)</span>
                <span
                  className={
                    farGreenPct <= config.farGreenCutoff * 100
                      ? 'text-amber-700 font-semibold'
                      : 'text-emerald-700 font-semibold'
                  }
                >
                  {farGreenPct.toFixed(1)}%
                </span>
              </div>
              <div className="h-2.5 rounded bg-[#EDF5F0] overflow-hidden">
                <div
                  className={`h-full transition-all duration-100 ${
                    farGreenPct <= config.farGreenCutoff * 100 ? 'bg-amber-500' : 'bg-emerald-600'
                  }`}
                  style={{ width: `${Math.min(100, farGreenPct * 3)}%` }}
                />
              </div>
              <div className="text-[10px] font-mono text-slate-500">
                Headland cutoff ≤ {(config.farGreenCutoff * 100).toFixed(1)}% ExG green
              </div>
            </div>

            <div className="bg-[#F8FBF9] border border-emerald-900/10 rounded-md p-3 space-y-1.5">
              <div className="flex items-center justify-between text-xs font-mono tabular-nums">
                <span className="text-slate-600">Near-ROI Foliage (Bottom 1/2)</span>
                <span className="text-emerald-700 font-semibold">{nearGreenPct.toFixed(1)}%</span>
              </div>
              <div className="h-2.5 rounded bg-[#EDF5F0] overflow-hidden">
                <div
                  className="h-full bg-emerald-500 transition-all duration-100"
                  style={{ width: `${Math.min(100, nearGreenPct * 3)}%` }}
                />
              </div>
              <div className="text-[10px] font-mono text-slate-500">
                Baseline canopy reference for far-drop ratio
              </div>
            </div>
          </div>

          {/* Last Manual Service Call Response */}
          {lastServiceResponse && (
            <div className="bg-[#F8FBF9] border border-emerald-900/10 rounded-md px-3 py-2 text-[11px] font-mono text-slate-600 flex flex-wrap items-center justify-between gap-2 tabular-nums">
              <span>
                Last RPC ({lastServiceResponse.timestamp}):{' '}
                <strong
                  className={
                    lastServiceResponse.rowEndDetected ? 'text-amber-700' : 'text-emerald-700'
                  }
                >
                  row_end_detected={String(lastServiceResponse.rowEndDetected)}
                </strong>{' '}
                · {lastServiceResponse.reason}
              </span>
            </div>
          )}
        </div>

        {/* Right: Service Configuration & Actions */}
        <div className="lg:col-span-5 bg-[#F8FBF9] border border-emerald-900/10 rounded-md p-3.5 flex flex-col justify-between gap-3.5">
          <div className="space-y-3">
            {/* Turn Dispatch Mode */}
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-slate-700">Turn Dispatch Policy</div>
              <div className="grid grid-cols-2 gap-1.5 p-0.5 bg-[#EDF5F0] border border-emerald-900/10 rounded-md">
                <button
                  onClick={() => onUpdateConfig({ turnDispatchMode: 'alert_and_confirm' })}
                  className={`py-1.5 px-2 text-[11px] font-medium rounded transition-colors cursor-pointer ${
                    config.turnDispatchMode === 'alert_and_confirm'
                      ? 'bg-white text-emerald-800 border border-emerald-200 font-semibold'
                      : 'text-slate-600 hover:text-emerald-800 border border-transparent'
                  }`}
                >
                  Alert &amp; Confirm
                </button>
                <button
                  onClick={() => onUpdateConfig({ turnDispatchMode: 'auto_execute' })}
                  className={`py-1.5 px-2 text-[11px] font-medium rounded transition-colors cursor-pointer ${
                    config.turnDispatchMode === 'auto_execute'
                      ? 'bg-white text-emerald-800 border border-emerald-200 font-semibold'
                      : 'text-slate-600 hover:text-emerald-800 border border-transparent'
                  }`}
                >
                  Auto-Execute Turn
                </button>
              </div>
            </div>

            {/* Trigger Threshold & Debounce Sliders */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <div className="flex justify-between text-[11px] font-mono text-slate-600 tabular-nums">
                  <span>Conf Thresh</span>
                  <span className="text-emerald-700 font-semibold">{threshPct}%</span>
                </div>
                <input
                  type="range"
                  min={0.55}
                  max={0.95}
                  step={0.01}
                  value={config.confidenceThreshold}
                  onChange={(e) =>
                    onUpdateConfig({ confidenceThreshold: parseFloat(e.target.value) })
                  }
                  className="w-full accent-emerald-600 cursor-pointer"
                />
              </div>

              <div className="space-y-1">
                <div className="flex justify-between text-[11px] font-mono text-slate-600 tabular-nums">
                  <span>Debounce</span>
                  <span className="text-emerald-700 font-semibold">{config.confirmFrames} fr</span>
                </div>
                <input
                  type="range"
                  min={2}
                  max={10}
                  step={1}
                  value={config.confirmFrames}
                  onChange={(e) =>
                    onUpdateConfig({ confirmFrames: parseInt(e.target.value, 10) })
                  }
                  className="w-full accent-emerald-600 cursor-pointer"
                />
              </div>
            </div>

            {/* Service Actions */}
            <div className="grid grid-cols-2 gap-2 pt-1">
              <button
                onClick={onInvokeServiceCheck}
                className="px-2.5 py-1.5 text-xs font-medium rounded border border-emerald-900/15 bg-white hover:bg-emerald-50 text-slate-800 flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
              >
                <Activity className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                <span>Call Service</span>
              </button>
              <button
                onClick={onJumpToRowEndTest}
                disabled={estopActive || isFaulted}
                className="px-2.5 py-1.5 text-xs font-medium rounded border border-emerald-300 bg-emerald-50 hover:bg-emerald-100 disabled:opacity-45 text-emerald-900 flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
              >
                <FastForward className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
                <span>Test Row-End</span>
              </button>
            </div>
          </div>

          {/* Recent Turn Alert Audit Strip */}
          <div className="pt-2.5 border-t border-emerald-900/10 space-y-1.5">
            <div className="flex items-center justify-between text-[11px] font-mono text-slate-500">
              <span>Recent Turn Alerts</span>
              <span className="tabular-nums">{alertHistory.length} logged</span>
            </div>
            {alertHistory.length === 0 ? (
              <div className="text-[11px] font-mono text-slate-400">
                No row-end alerts triggered yet. Drive to headland or click Test Row-End.
              </div>
            ) : (
              <div className="space-y-1 max-h-20 overflow-y-auto">
                {alertHistory.slice(0, 3).map((item) => (
                  <div
                    key={item.id}
                    className="flex items-center justify-between gap-2 text-[11px] font-mono tabular-nums text-slate-600 bg-white border border-emerald-900/10 rounded px-2 py-1"
                  >
                    <span className="truncate">
                      {item.triggeredAt} · R{item.row}
                      {item.nextRow ? `→R${item.nextRow}` : ' END'} ·{' '}
                      {Math.round(item.confidence * 100)}%
                    </span>
                    <span
                      className={`font-semibold shrink-0 ${
                        item.status === 'PENDING_TURN'
                          ? 'text-amber-700'
                          : item.status === 'EXECUTING' || item.status === 'COMPLETED'
                          ? 'text-emerald-700'
                          : 'text-slate-500'
                      }`}
                    >
                      {item.status}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
};
