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
  ArrowRight,
  Ruler,
} from 'lucide-react';
import {
  NavTurnState,
  RowEndDetectionConfig,
  RowEndDetectionSnapshot,
  formatTurnLabel,
} from '../services/rowEndDetectionService';

interface Props {
  snapshot: RowEndDetectionSnapshot;
  config: RowEndDetectionConfig;
  currentMissionPhase: string;
  estopActive: boolean;
  isFaulted: boolean;
  onUpdateConfig: (patch: Partial<RowEndDetectionConfig>) => void;
  onExecuteTurn: () => void;
  onDismissAlert: () => void;
  onInvokeServiceCheck: () => void;
  onJumpToRowEndTest: () => void;
}

const MAX_DISPLAY_DIST_M = 2.4;

const STATE_PIPELINE: Array<{ id: NavTurnState; label: string }> = [
  { id: 'FOLLOW_CROP_ROW', label: 'FOLLOW_CROP_ROW' },
  { id: 'ROW_END_STOP', label: 'ROW_END_STOP' },
  { id: 'NAV2_HEADLAND_TURN', label: 'NAV2_HEADLAND_TURN' },
];

export const RowEndDetectionPanel: React.FC<Props> = ({
  snapshot,
  config,
  currentMissionPhase,
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
    distanceToFurrowEndM,
    rawDistanceToFurrowEndM,
    etaSeconds,
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
    stateTransitions,
    lastServiceResponse,
  } = snapshot;

  const confPct = Math.round(confidence * 100);
  const threshPct = Math.round(config.confidenceThreshold * 100);

  // Calibrated proximity bar: 0% = far (>2.4 m), 100% = at furrow end (0.0 m)
  const clampedDistM = Math.max(0, Math.min(MAX_DISPLAY_DIST_M, distanceToFurrowEndM));
  const proximityFillPct = Math.round(((MAX_DISPLAY_DIST_M - clampedDistM) / MAX_DISPLAY_DIST_M) * 100);
  const triggerLinePct = Math.round(
    ((MAX_DISPLAY_DIST_M - Math.min(MAX_DISPLAY_DIST_M, config.triggerDistanceM)) /
      MAX_DISPLAY_DIST_M) *
      100
  );
  const withinTriggerDist = distanceToFurrowEndM <= config.triggerDistanceM;

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
                      ? 'FURROW END REACHED — FINAL ROW COMPLETE'
                      : 'FURROW END DETECTED — STATE TRANSITION TO TURN EXECUTION'
                    : 'STATE TRANSITION ACTIVE — NAV2 HEADLAND TURN EXECUTING'}
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
                Furrow End Dist: {activeAlert.distanceToFurrowEndM.toFixed(2)} m · Vision Conf:{' '}
                {Math.round(activeAlert.confidence * 100)}% · Far-ROI Green:{' '}
                {activeAlert.farGreenPct.toFixed(1)}% · {activeAlert.sourceLabel}
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
            /navigation/row_end_detection · Real-Time Video Furrow-End Distance &amp; Turn Transition
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
        {/* Left: Real-Time Distance to Furrow End + State Machine Pipeline */}
        <div className="lg:col-span-7 space-y-3.5">
          {/* Primary Vision-Calculated Furrow-End Distance Card */}
          <div className="bg-[#F8FBF9] border border-emerald-900/10 rounded-md p-3.5 space-y-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="flex items-center gap-2">
                <Ruler className="w-4 h-4 text-emerald-600 shrink-0" />
                <span className="text-xs font-semibold text-slate-800">
                  Distance to Furrow End (Video Ground-Plane Projection)
                </span>
              </div>
              <div className="flex items-baseline gap-2 font-mono tabular-nums">
                <span
                  className={`text-xl font-bold ${
                    withinTriggerDist
                      ? 'text-amber-700'
                      : distanceToFurrowEndM <= config.triggerDistanceM * 2
                      ? 'text-amber-600'
                      : 'text-emerald-700'
                  }`}
                >
                  {distanceToFurrowEndM >= 4.0 ? '>4.00' : distanceToFurrowEndM.toFixed(2)} m
                </span>
                <span className="text-[11px] text-slate-500">
                  {etaSeconds !== null ? `ETA ${etaSeconds.toFixed(1)}s` : 'STOPPED'} · Raw{' '}
                  {rawDistanceToFurrowEndM >= 4.0 ? '>4.0' : rawDistanceToFurrowEndM.toFixed(2)}m
                </span>
              </div>
            </div>

            {/* Calibrated Furrow-End Approach Gauge (2.4m -> 0.0m) */}
            <div className="space-y-1">
              <div className="relative h-4 rounded bg-[#EDF5F0] border border-emerald-900/15 overflow-hidden">
                <div
                  className={`h-full transition-all duration-100 ${
                    withinTriggerDist
                      ? 'bg-amber-500'
                      : distanceToFurrowEndM <= config.triggerDistanceM * 2
                      ? 'bg-amber-400/80'
                      : 'bg-emerald-600'
                  }`}
                  style={{ width: `${Math.max(3, proximityFillPct)}%` }}
                />
                {/* Trigger Distance Marker */}
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-slate-900"
                  style={{ left: `${triggerLinePct}%` }}
                  title={`Turn transition trigger: ≤ ${config.triggerDistanceM.toFixed(2)} m`}
                />
              </div>
              <div className="flex justify-between text-[10px] font-mono text-slate-500 tabular-nums">
                <span>2.40 m (In Row)</span>
                <span className="text-slate-700 font-semibold">
                  Trigger ≤ {config.triggerDistanceM.toFixed(2)} m · Debounce {confirmCount}/
                  {confirmRequired} fr
                </span>
                <span>0.00 m (Headland)</span>
              </div>
            </div>

            {/* Secondary Confidence + Far/Near Foliage Inline Telemetry */}
            <div className="grid grid-cols-3 gap-2 pt-2 border-t border-emerald-900/10 text-[11px] font-mono tabular-nums">
              <div>
                <div className="text-slate-500">Row-End Conf</div>
                <div
                  className={`font-semibold ${
                    confPct >= threshPct ? 'text-amber-700' : 'text-emerald-700'
                  }`}
                >
                  {confPct}% (≥{threshPct}%)
                </div>
              </div>
              <div>
                <div className="text-slate-500">Far-ROI Foliage</div>
                <div
                  className={`font-semibold ${
                    farGreenPct <= config.farGreenCutoff * 100
                      ? 'text-amber-700'
                      : 'text-emerald-700'
                  }`}
                >
                  {farGreenPct.toFixed(1)}% green
                </div>
              </div>
              <div>
                <div className="text-slate-500">Near-ROI Foliage</div>
                <div className="font-semibold text-emerald-700">{nearGreenPct.toFixed(1)}% green</div>
              </div>
            </div>
          </div>

          {/* State Transition Pipeline */}
          <div className="bg-[#F8FBF9] border border-emerald-900/10 rounded-md p-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono">
              <span className="text-slate-700 font-semibold">
                Turn Execution State Transition Pipeline
              </span>
              <span className="text-slate-500 tabular-nums">
                Queued:{' '}
                <strong className="text-slate-800">
                  {nextRow !== null
                    ? `Row ${currentRow}→${nextRow} (${recommendedTurn})`
                    : 'FINAL_ROW_STOP'}
                </strong>
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {STATE_PIPELINE.map((step, idx) => {
                const isCurrent = currentMissionPhase === step.id;
                return (
                  <React.Fragment key={step.id}>
                    <div
                      className={`px-2.5 py-1 rounded border text-[11px] font-mono transition-colors ${
                        isCurrent
                          ? step.id === 'ROW_END_STOP'
                            ? 'bg-amber-50 border-amber-400 text-amber-900 font-semibold'
                            : 'bg-emerald-50 border-emerald-500 text-emerald-900 font-semibold'
                          : 'bg-white border-emerald-900/10 text-slate-500'
                      }`}
                    >
                      {step.label}
                    </div>
                    {idx < STATE_PIPELINE.length - 1 && (
                      <ArrowRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                    )}
                  </React.Fragment>
                );
              })}
            </div>
            <div className="text-[11px] font-mono text-slate-500 truncate">
              Vision Source: {sourceLabel}
            </div>
          </div>

          {/* Last Manual Service Call Response */}
          {lastServiceResponse && (
            <div className="bg-[#F8FBF9] border border-emerald-900/10 rounded-md px-3 py-2 text-[11px] font-mono text-slate-600 tabular-nums">
              Last RPC ({lastServiceResponse.timestamp}):{' '}
              <strong
                className={
                  lastServiceResponse.rowEndDetected ? 'text-amber-700' : 'text-emerald-700'
                }
              >
                row_end_detected={String(lastServiceResponse.rowEndDetected)}
              </strong>{' '}
              · dist={lastServiceResponse.distanceToFurrowEndM.toFixed(2)}m ·{' '}
              {lastServiceResponse.reason}
            </div>
          )}
        </div>

        {/* Right: Service Configuration, Actions & State Transition Log */}
        <div className="lg:col-span-5 bg-[#F8FBF9] border border-emerald-900/10 rounded-md p-3.5 flex flex-col justify-between gap-3.5">
          <div className="space-y-3">
            {/* Turn Dispatch Mode */}
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-slate-700">Turn Transition Policy</div>
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

            {/* Trigger Distance, Confidence & Debounce Sliders */}
            <div className="space-y-2">
              <div className="space-y-1">
                <div className="flex justify-between text-[11px] font-mono text-slate-600 tabular-nums">
                  <span>Trigger Distance to Furrow End</span>
                  <span className="text-emerald-700 font-semibold">
                    ≤ {config.triggerDistanceM.toFixed(2)} m
                  </span>
                </div>
                <input
                  type="range"
                  min={0.25}
                  max={1.3}
                  step={0.05}
                  value={config.triggerDistanceM}
                  onChange={(e) =>
                    onUpdateConfig({ triggerDistanceM: parseFloat(e.target.value) })
                  }
                  className="w-full accent-emerald-600 cursor-pointer"
                />
              </div>

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
                <span>Test Furrow-End</span>
              </button>
            </div>
          </div>

          {/* Recent State Transitions Log */}
          <div className="pt-2.5 border-t border-emerald-900/10 space-y-1.5">
            <div className="flex items-center justify-between text-[11px] font-mono text-slate-500">
              <span>State Transitions (Turn Execution)</span>
              <span className="tabular-nums">{stateTransitions.length} logged</span>
            </div>
            {stateTransitions.length === 0 ? (
              <div className="text-[11px] font-mono text-slate-400">
                Awaiting furrow-end approach (≤ {config.triggerDistanceM.toFixed(2)} m) or click
                Test Furrow-End.
              </div>
            ) : (
              <div className="space-y-1 max-h-24 overflow-y-auto">
                {stateTransitions.slice(0, 4).map((tr) => (
                  <div
                    key={tr.id}
                    className="flex items-center justify-between gap-2 text-[11px] font-mono tabular-nums text-slate-600 bg-white border border-emerald-900/10 rounded px-2 py-1"
                  >
                    <span className="truncate">
                      {tr.timestamp} · {tr.fromState.replace('FOLLOW_CROP_ROW', 'FOLLOW')}→
                      <strong
                        className={
                          tr.toState === 'ROW_END_STOP'
                            ? 'text-amber-700'
                            : 'text-emerald-700'
                        }
                      >
                        {tr.toState}
                      </strong>
                    </span>
                    <span className="text-slate-500 shrink-0">
                      {tr.distanceToFurrowEndM.toFixed(2)}m
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
