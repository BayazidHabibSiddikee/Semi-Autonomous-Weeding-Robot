import React from 'react';
import {
  Compass,
  CheckCircle2,
  AlertTriangle,
  CornerUpRight,
  Activity,
  Gauge,
  Navigation2,
} from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';

export interface TurnTrajectorySample {
  progressPct: number;
  label: string;
  calculatedDeg: number;
  imuDeg: number;
  rawOdomDeg: number;
  errorDeg: number;
  crossTrackCm: number;
}

export interface CompletedTurnRecord {
  id: number;
  fromRow: number;
  toRow: number;
  direction: 'RIGHT' | 'LEFT';
  targetDeltaDeg: number;
  imuDeltaDeg: number;
  rawOdomDeltaDeg: number;
  finalHeadingErrorDeg: number;
  rmsHeadingErrorDeg: number;
  maxCrossTrackCm: number;
  accuracyPct: number;
  durationSec: number;
  passed: boolean;
  completedAt: string;
}

export interface LiveTurnTelemetry {
  active: boolean;
  fromRow: number;
  toRow: number;
  direction: 'RIGHT' | 'LEFT';
  progressPct: number;
  calculatedYawDeg: number;
  imuYawDeg: number;
  rawOdomYawDeg: number;
  headingErrorDeg: number;
  imuWzRadS: number;
  imuGyroBiasDegS: number;
  crossTrackCm: number;
  liveAccuracyPct: number;
}

interface TurnAccuracyDashboardProps {
  liveTurn: LiveTurnTelemetry;
  samples: TurnTrajectorySample[];
  completedTurns: CompletedTurnRecord[];
  onTestHeadlandTurn: () => void;
  disabled?: boolean;
}

export const INITIAL_LIVE_TURN_TELEMETRY: LiveTurnTelemetry = {
  active: false,
  fromRow: 1,
  toRow: 2,
  direction: 'RIGHT',
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

export const TurnAccuracyDashboard: React.FC<TurnAccuracyDashboardProps> = ({
  liveTurn,
  samples,
  completedTurns,
  onTestHeadlandTurn,
  disabled = false,
}) => {
  const latestCompleted = completedTurns.length > 0 ? completedTurns[0] : null;
  const passedCount = completedTurns.filter((t) => t.passed).length;
  const fleetAvgAccuracy =
    completedTurns.length > 0
      ? completedTurns.reduce((acc, t) => acc + t.accuracyPct, 0) / completedTurns.length
      : null;

  const displayAccuracy = liveTurn.active
    ? liveTurn.liveAccuracyPct
    : fleetAvgAccuracy;

  const displayCalcYaw = liveTurn.active
    ? liveTurn.calculatedYawDeg
    : latestCompleted
    ? latestCompleted.targetDeltaDeg
    : 0;

  const displayImuYaw = liveTurn.active
    ? liveTurn.imuYawDeg
    : latestCompleted
    ? latestCompleted.imuDeltaDeg
    : 0;

  const displayHeadingErr = liveTurn.active
    ? liveTurn.headingErrorDeg
    : latestCompleted
    ? latestCompleted.finalHeadingErrorDeg
    : 0;

  const displayOdomDivergence = liveTurn.active
    ? liveTurn.rawOdomYawDeg - liveTurn.imuYawDeg
    : latestCompleted
    ? latestCompleted.rawOdomDeltaDeg - latestCompleted.imuDeltaDeg
    : 0;

  const displayCrossTrack = liveTurn.active
    ? liveTurn.crossTrackCm
    : latestCompleted
    ? latestCompleted.maxCrossTrackCm
    : 0;

  const accuracyTone =
    displayAccuracy === null
      ? 'text-slate-400'
      : displayAccuracy >= 95
      ? 'text-emerald-700'
      : displayAccuracy >= 90
      ? 'text-amber-700'
      : 'text-rose-700';

  const errorTone =
    Math.abs(displayHeadingErr) <= 3.5
      ? 'text-emerald-700'
      : Math.abs(displayHeadingErr) <= 7.0
      ? 'text-amber-700'
      : 'text-rose-700';

  const cteTone =
    displayCrossTrack <= 8.0
      ? 'text-emerald-700'
      : displayCrossTrack <= 14.0
      ? 'text-amber-700'
      : 'text-rose-700';

  return (
    <div className="bg-white border border-emerald-900/10 rounded-lg p-4 space-y-4">
      {/* Header Row */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-emerald-900/10 pb-3">
        <div className="space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <Compass className="w-4 h-4 text-emerald-700 shrink-0" />
            <h3 className="text-sm font-semibold text-slate-900">
              Headland Turn-Completion Accuracy (IMU vs. Calculated Trajectory)
            </h3>
            {liveTurn.active ? (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-50 border border-emerald-200 text-[11px] font-mono font-semibold text-emerald-800">
                TURN IN PROGRESS · R{liveTurn.fromRow}→R{liveTurn.toRow} ({Math.round(liveTurn.progressPct)}%)
              </span>
            ) : latestCompleted ? (
              <span
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-mono font-semibold ${
                  latestCompleted.passed
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                    : 'bg-amber-50 border-amber-200 text-amber-800'
                }`}
              >
                {latestCompleted.passed ? (
                  <CheckCircle2 className="w-3 h-3" />
                ) : (
                  <AlertTriangle className="w-3 h-3" />
                )}
                LAST TURN {latestCompleted.passed ? 'PASS' : 'WARN'} · {latestCompleted.accuracyPct.toFixed(1)}%
              </span>
            ) : (
              <span className="inline-flex items-center px-2 py-0.5 rounded bg-slate-100 border border-slate-200 text-[11px] font-mono font-medium text-slate-600">
                STANDBY · ROW TRACKING
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500">
            Compares MEMS IMU integrated yaw &amp; angular rate against the calculated 3-segment headland U-turn trajectory and raw wheel odometry.
          </p>
        </div>

        <button
          type="button"
          onClick={onTestHeadlandTurn}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-emerald-600/25 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 disabled:opacity-45 disabled:cursor-not-allowed text-xs font-medium transition-colors"
        >
          <CornerUpRight className="w-3.5 h-3.5" />
          Test Headland Turn
        </button>
      </div>

      {/* 4-Column KPI Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div className="bg-[#F8FBF9] border border-emerald-900/10 rounded-md p-3">
          <div className="flex items-center justify-between text-[11px] text-slate-500">
            <span>{liveTurn.active ? 'Live Turn Accuracy' : 'Turn-Completion Accuracy'}</span>
            <Gauge className="w-3.5 h-3.5 text-emerald-700/70" />
          </div>
          <div className="flex items-baseline gap-1 mt-1">
            <span className={`text-xl font-mono font-semibold tabular-nums ${accuracyTone}`}>
              {displayAccuracy !== null ? displayAccuracy.toFixed(1) : '—'}
            </span>
            {displayAccuracy !== null && (
              <span className="text-xs font-mono text-slate-500">%</span>
            )}
          </div>
          <div className="text-[11px] font-mono text-slate-500 mt-1 tabular-nums">
            {completedTurns.length > 0
              ? `Gate ≥ 95.0% · ${passedCount}/${completedTurns.length} passed`
              : 'Gate ≥ 95.0% · Awaiting turn'}
          </div>
        </div>

        <div className="bg-[#F8FBF9] border border-emerald-900/10 rounded-md p-3">
          <div className="flex items-center justify-between text-[11px] text-slate-500">
            <span>IMU vs. Calculated ΔYaw</span>
            <Compass className="w-3.5 h-3.5 text-emerald-700/70" />
          </div>
          <div className="flex items-baseline gap-1.5 mt-1 font-mono tabular-nums">
            <span className="text-xl font-semibold text-slate-900">
              {liveTurn.active || latestCompleted ? `${displayImuYaw.toFixed(1)}°` : '—'}
            </span>
            {(liveTurn.active || latestCompleted) && (
              <span className="text-xs text-slate-500">/ {displayCalcYaw.toFixed(1)}°</span>
            )}
          </div>
          <div className={`text-[11px] font-mono mt-1 tabular-nums font-medium ${errorTone}`}>
            {liveTurn.active || latestCompleted
              ? `Heading Err: ${displayHeadingErr >= 0 ? '+' : ''}${displayHeadingErr.toFixed(2)}°`
              : 'Target U-Turn: 180.0°'}
          </div>
        </div>

        <div className="bg-[#F8FBF9] border border-emerald-900/10 rounded-md p-3">
          <div className="flex items-center justify-between text-[11px] text-slate-500">
            <span>IMU ω_z &amp; Odom Slip</span>
            <Activity className="w-3.5 h-3.5 text-emerald-700/70" />
          </div>
          <div className="flex items-baseline gap-1 mt-1 font-mono tabular-nums">
            <span className="text-xl font-semibold text-slate-900">
              {liveTurn.imuWzRadS >= 0 ? '+' : ''}
              {liveTurn.imuWzRadS.toFixed(2)}
            </span>
            <span className="text-xs text-slate-500">rad/s</span>
          </div>
          <div className="text-[11px] font-mono text-slate-500 mt-1 tabular-nums">
            Bias {liveTurn.imuGyroBiasDegS.toFixed(2)}°/s · Slip{' '}
            <span className="text-amber-700 font-medium">
              {displayOdomDivergence >= 0 ? '+' : ''}
              {displayOdomDivergence.toFixed(1)}°
            </span>
          </div>
        </div>

        <div className="bg-[#F8FBF9] border border-emerald-900/10 rounded-md p-3">
          <div className="flex items-center justify-between text-[11px] text-slate-500">
            <span>{liveTurn.active ? 'Trajectory Cross-Track' : 'Max Turn Cross-Track'}</span>
            <Navigation2 className="w-3.5 h-3.5 text-emerald-700/70" />
          </div>
          <div className="flex items-baseline gap-1 mt-1 font-mono tabular-nums">
            <span className={`text-xl font-semibold ${liveTurn.active || latestCompleted ? cteTone : 'text-slate-400'}`}>
              {liveTurn.active || latestCompleted ? displayCrossTrack.toFixed(1) : '—'}
            </span>
            {(liveTurn.active || latestCompleted) && (
              <span className="text-xs text-slate-500">cm</span>
            )}
          </div>
          <div className="text-[11px] font-mono text-slate-500 mt-1 tabular-nums">
            Limit ≤ 8.0 cm · {liveTurn.active ? `${liveTurn.direction} U-Turn` : latestCompleted ? `R${latestCompleted.fromRow}→R${latestCompleted.toRow}` : '3-segment arc'}
          </div>
        </div>
      </div>

      {/* Trajectory Comparison Chart */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-xs font-medium text-slate-700">
            {liveTurn.active
              ? `Active Turn Profile: Row ${liveTurn.fromRow} → Row ${liveTurn.toRow} (${liveTurn.direction} U-Turn)`
              : latestCompleted
              ? `Last Completed Turn Profile: Turn #${latestCompleted.id} (Row ${latestCompleted.fromRow} → Row ${latestCompleted.toRow})`
              : 'Turn Heading Progression (0% → 100% of Headland Arc)'}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono text-slate-600">
            <span className="text-slate-600 font-medium">-- Calculated Trajectory (°)</span>
            <span className="text-emerald-700 font-semibold">— IMU Fused Heading (°)</span>
            <span className="text-amber-600">··· Raw Wheel Odom (°)</span>
          </div>
        </div>

        {samples.length > 0 ? (
          <div className="h-48 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={samples} margin={{ top: 6, right: 14, left: -12, bottom: 0 }}>
                <CartesianGrid stroke="#E2ECE6" strokeDasharray="3 3" />
                <XAxis
                  dataKey="label"
                  stroke="#64748B"
                  fontSize={11}
                  tickLine={false}
                />
                <YAxis
                  domain={[0, 200]}
                  ticks={[0, 45, 90, 135, 180]}
                  stroke="#64748B"
                  fontSize={11}
                  tickLine={false}
                  unit="°"
                />
                <ReferenceLine y={90} stroke="#CBD5E1" strokeDasharray="2 2" />
                <ReferenceLine y={180} stroke="#059669" strokeOpacity={0.35} strokeDasharray="4 4" />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#FFFFFF',
                    borderColor: '#CBD5E1',
                    borderRadius: '6px',
                    fontSize: '12px',
                    fontFamily: 'IBM Plex Mono, monospace',
                    color: '#0F172A',
                  }}
                  formatter={(value: unknown, name: string) => {
                    const num = typeof value === 'number' ? value : Number(value);
                    return [`${Number.isFinite(num) ? num.toFixed(1) : value}°`, name];
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="calculatedDeg"
                  name="Calculated Trajectory"
                  stroke="#64748B"
                  strokeWidth={1.75}
                  strokeDasharray="5 4"
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="imuDeg"
                  name="IMU Fused Heading"
                  stroke="#059669"
                  strokeWidth={2.25}
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="rawOdomDeg"
                  name="Raw Wheel Odom"
                  stroke="#D97706"
                  strokeWidth={1.5}
                  strokeDasharray="2 3"
                  dot={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="h-36 rounded-md border border-dashed border-emerald-900/15 bg-[#F8FBF9] flex flex-col items-center justify-center gap-2 px-4 text-center">
            <p className="text-xs text-slate-600">
              No headland turn recorded in this session yet. Telemetry captures automatically whenever the rover enters{' '}
              <span className="font-mono font-medium text-emerald-800">NAV2_HEADLAND_TURN</span>.
            </p>
            <button
              type="button"
              onClick={onTestHeadlandTurn}
              disabled={disabled}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-45 text-xs font-medium transition-colors"
            >
              <CornerUpRight className="w-3.5 h-3.5" />
              Jump to Furrow End &amp; Measure Turn
            </button>
          </div>
        )}
      </div>

      {/* Completed Turns Ledger */}
      {completedTurns.length > 0 && (
        <div className="border-t border-emerald-900/10 pt-3">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-semibold text-slate-800">
              Completed Headland Turns Ledger
            </h4>
            <span className="text-[11px] font-mono text-slate-500 tabular-nums">
              {completedTurns.length} turn{completedTurns.length === 1 ? '' : 's'} logged
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse font-mono text-xs tabular-nums">
              <thead>
                <tr className="border-b border-emerald-900/10 text-[11px] text-slate-500 font-sans">
                  <th className="py-1.5 pr-3 font-medium">Turn</th>
                  <th className="py-1.5 pr-3 font-medium">Rows</th>
                  <th className="py-1.5 pr-3 font-medium">Dir</th>
                  <th className="py-1.5 pr-3 font-medium">Calc / IMU Δψ</th>
                  <th className="py-1.5 pr-3 font-medium">Final Err</th>
                  <th className="py-1.5 pr-3 font-medium">RMS Err</th>
                  <th className="py-1.5 pr-3 font-medium">Max CTE</th>
                  <th className="py-1.5 pr-3 font-medium">Time</th>
                  <th className="py-1.5 pr-3 font-medium">Accuracy</th>
                  <th className="py-1.5 text-right font-medium">Gate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-emerald-900/5 text-slate-700">
                {completedTurns.map((turn) => (
                  <tr key={turn.id} className="hover:bg-[#F8FBF9]">
                    <td className="py-1.5 pr-3 font-semibold text-slate-900">#{turn.id}</td>
                    <td className="py-1.5 pr-3">
                      R{turn.fromRow}→R{turn.toRow}
                    </td>
                    <td className="py-1.5 pr-3 text-slate-600">{turn.direction}</td>
                    <td className="py-1.5 pr-3">
                      {turn.targetDeltaDeg.toFixed(0)}° /{' '}
                      <span className="text-emerald-700 font-medium">
                        {turn.imuDeltaDeg.toFixed(1)}°
                      </span>
                    </td>
                    <td
                      className={`py-1.5 pr-3 font-medium ${
                        Math.abs(turn.finalHeadingErrorDeg) <= 3.5
                          ? 'text-emerald-700'
                          : 'text-amber-700'
                      }`}
                    >
                      {turn.finalHeadingErrorDeg >= 0 ? '+' : ''}
                      {turn.finalHeadingErrorDeg.toFixed(2)}°
                    </td>
                    <td className="py-1.5 pr-3">{turn.rmsHeadingErrorDeg.toFixed(2)}°</td>
                    <td className="py-1.5 pr-3">{turn.maxCrossTrackCm.toFixed(1)} cm</td>
                    <td className="py-1.5 pr-3 text-slate-500">{turn.durationSec.toFixed(1)}s</td>
                    <td
                      className={`py-1.5 pr-3 font-semibold ${
                        turn.accuracyPct >= 95 ? 'text-emerald-700' : 'text-amber-700'
                      }`}
                    >
                      {turn.accuracyPct.toFixed(1)}%
                    </td>
                    <td className="py-1.5 text-right">
                      <span
                        className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                          turn.passed
                            ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                            : 'bg-amber-50 text-amber-800 border border-amber-200'
                        }`}
                      >
                        {turn.passed ? 'PASS' : 'WARN'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};
