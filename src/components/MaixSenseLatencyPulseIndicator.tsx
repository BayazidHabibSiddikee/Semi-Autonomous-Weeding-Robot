import React from 'react';
import { RefreshCw } from 'lucide-react';

export interface PingLatencySample {
  id: number;
  reachable: boolean;
  rttMs: number | null;
  tier: LatencyPulseTier;
  timestamp: string;
}

export type LatencyPulseTier = 'green' | 'yellow' | 'red' | 'probing';

export const LATENCY_GREEN_MAX_MS = 80;
export const LATENCY_YELLOW_MAX_MS = 249;

/**
 * Maps live MaixSense ping reachability and RTT latency (ms) to a pulse-light tier:
 *  - green  : reachable & latency < 80 ms (Optimal)
 *  - yellow : reachable & latency 80–249 ms (Degraded / Elevated)
 *  - red    : unreachable OR latency >= 250 ms (Critical / Offline)
 */
export function classifyMaixSenseLatency(
  reachable: boolean | null,
  rttMs: number | null
): LatencyPulseTier {
  if (reachable === null) return 'probing';
  if (!reachable) return 'red';
  if (rttMs === null) return 'green';
  if (rttMs < LATENCY_GREEN_MAX_MS) return 'green';
  if (rttMs <= LATENCY_YELLOW_MAX_MS) return 'yellow';
  return 'red';
}

const TIER_STYLES: Record<
  LatencyPulseTier,
  {
    coreBg: string;
    ringBg: string;
    glowShadow: string;
    badgeClasses: string;
    barBg: string;
    label: string;
    shortLabel: string;
    rangeLabel: string;
  }
> = {
  green: {
    coreBg: 'bg-emerald-500',
    ringBg: 'bg-emerald-400',
    glowShadow: 'shadow-[0_0_10px_rgba(16,185,129,0.7)]',
    badgeClasses: 'bg-emerald-50 border-emerald-300 text-emerald-800',
    barBg: 'bg-emerald-500',
    label: 'OPTIMAL LINK',
    shortLabel: 'OPTIMAL',
    rangeLabel: '< 80 ms',
  },
  yellow: {
    coreBg: 'bg-amber-400',
    ringBg: 'bg-amber-300',
    glowShadow: 'shadow-[0_0_10px_rgba(245,158,11,0.7)]',
    badgeClasses: 'bg-amber-50 border-amber-300 text-amber-800',
    barBg: 'bg-amber-400',
    label: 'ELEVATED LATENCY',
    shortLabel: 'ELEVATED',
    rangeLabel: '80–249 ms',
  },
  red: {
    coreBg: 'bg-rose-500',
    ringBg: 'bg-rose-400',
    glowShadow: 'shadow-[0_0_10px_rgba(244,63,94,0.7)]',
    badgeClasses: 'bg-rose-50 border-rose-300 text-rose-800',
    barBg: 'bg-rose-500',
    label: 'HIGH LATENCY / OFFLINE',
    shortLabel: 'CRITICAL',
    rangeLabel: '≥ 250 ms / Timeout',
  },
  probing: {
    coreBg: 'bg-slate-400',
    ringBg: 'bg-slate-300',
    glowShadow: 'shadow-none',
    badgeClasses: 'bg-[#F8FBF9] border-slate-200 text-slate-600',
    barBg: 'bg-slate-300',
    label: 'PROBING PING...',
    shortLabel: 'PROBING',
    rangeLabel: 'Measuring...',
  },
};

interface PulseLightProps {
  tier: LatencyPulseTier;
  size?: 'sm' | 'lg';
}

const PulseLightDot: React.FC<PulseLightProps> = ({ tier, size = 'sm' }) => {
  const style = TIER_STYLES[tier];
  const dims = size === 'lg' ? 'h-4 w-4' : 'h-2.5 w-2.5';
  const pulseDurationClass =
    tier === 'green'
      ? '[animation-duration:1.8s]'
      : tier === 'yellow'
      ? '[animation-duration:1.3s]'
      : '[animation-duration:0.95s]';
  return (
    <span
      className={`relative inline-flex ${dims} shrink-0 items-center justify-center`}
      aria-label={`MaixSense ping status: ${style.label}`}
    >
      <span
        className={`absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping transition-colors duration-300 ${pulseDurationClass} ${style.ringBg}`}
      />
      <span
        className={`relative inline-flex rounded-full ${dims} transition-all duration-300 ${style.coreBg} ${style.glowShadow}`}
      />
    </span>
  );
};

interface MaixSenseLatencyPulseIndicatorProps {
  variant: 'compact' | 'detailed';
  targetIp: string;
  reachable: boolean | null;
  rttMs: number | null;
  pingMethod?: string;
  pinging: boolean;
  livePingEnabled: boolean;
  onToggleLivePing?: () => void;
  onPingNow?: () => void;
  history: PingLatencySample[];
  lastCheckedAt: string | null;
}

export const MaixSenseLatencyPulseIndicator: React.FC<MaixSenseLatencyPulseIndicatorProps> = ({
  variant,
  targetIp,
  reachable,
  rttMs,
  pingMethod,
  pinging,
  livePingEnabled,
  onToggleLivePing,
  onPingNow,
  history,
  lastCheckedAt,
}) => {
  const tier = classifyMaixSenseLatency(reachable, rttMs);
  const style = TIER_STYLES[tier];

  if (variant === 'compact') {
    const rttLabel =
      reachable === null
        ? 'Probing...'
        : !reachable
        ? 'Offline'
        : rttMs !== null
        ? `${rttMs} ms`
        : 'Bridge OK';

    return (
      <div
        className={`px-2.5 py-1 rounded-md border text-xs font-mono font-semibold flex items-center gap-2 tabular-nums transition-colors duration-300 ${style.badgeClasses}`}
        title={`MaixSense Ping Latency (${targetIp}): ${style.label} — Green <80ms, Yellow 80–249ms, Red ≥250ms/Offline`}
      >
        <PulseLightDot tier={tier} size="sm" />
        <span>
          MaixSense Ping: {rttLabel}
        </span>
      </div>
    );
  }

  const validRtts = history
    .map((s) => (s.reachable && s.rttMs !== null ? s.rttMs : null))
    .filter((v): v is number => v !== null);
  const avgRtt =
    validRtts.length > 0
      ? Math.round(validRtts.reduce((a, b) => a + b, 0) / validRtts.length)
      : null;
  const maxRtt = validRtts.length > 0 ? Math.max(...validRtts) : null;
  const minRtt = validRtts.length > 0 ? Math.min(...validRtts) : null;
  const reachablePct =
    history.length > 0
      ? Math.round((history.filter((s) => s.reachable).length / history.length) * 100)
      : null;

  return (
    <div className="bg-[#F8FBF9] border border-emerald-900/10 rounded-lg p-3.5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Left: Dedicated Pulse-Light Lamp + Live RTT Readout */}
        <div className="flex items-center gap-3.5 min-w-0">
          <div
            className={`w-11 h-11 rounded-lg border flex items-center justify-center shrink-0 transition-colors duration-300 ${
              tier === 'green'
                ? 'bg-emerald-50 border-emerald-200'
                : tier === 'yellow'
                ? 'bg-amber-50 border-amber-200'
                : tier === 'red'
                ? 'bg-rose-50 border-rose-200'
                : 'bg-white border-slate-200'
            }`}
          >
            <PulseLightDot tier={tier} size="lg" />
          </div>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-slate-900">
                Real-Time MaixSense Ping Pulse-Light
              </span>
              <span
                className={`px-2 py-0.5 rounded border text-[10px] font-mono font-semibold transition-colors duration-300 ${style.badgeClasses}`}
              >
                {style.label}
              </span>
            </div>

            <div className="flex flex-wrap items-baseline gap-2.5 mt-0.5 font-mono tabular-nums">
              <span
                className={`text-lg font-bold transition-colors duration-300 ${
                  tier === 'green'
                    ? 'text-emerald-700'
                    : tier === 'yellow'
                    ? 'text-amber-700'
                    : tier === 'red'
                    ? 'text-rose-700'
                    : 'text-slate-500'
                }`}
              >
                {reachable === null
                  ? '— ms'
                  : !reachable
                  ? 'TIMEOUT'
                  : rttMs !== null
                  ? `${rttMs} ms`
                  : '< 10 ms (WS)'}
              </span>
              <span className="text-[11px] text-slate-500">
                Target: <strong className="text-slate-700">{targetIp}</strong>
                {pingMethod ? ` · ${pingMethod}` : ''}
              </span>
            </div>
          </div>
        </div>

        {/* Right: Live Ping Controls */}
        <div className="flex flex-wrap items-center gap-2">
          {onToggleLivePing && (
            <button
              type="button"
              onClick={onToggleLivePing}
              className={`px-2.5 py-1.5 text-[11px] font-mono rounded-md border transition-colors cursor-pointer ${
                livePingEnabled
                  ? 'bg-emerald-50 border-emerald-300 text-emerald-800 font-semibold'
                  : 'bg-white border-slate-200 text-slate-600 hover:border-emerald-300'
              }`}
            >
              Live Ping (4s): {livePingEnabled ? 'ON' : 'OFF'}
            </button>
          )}
          {onPingNow && (
            <button
              type="button"
              onClick={onPingNow}
              disabled={pinging}
              className="px-2.5 py-1.5 text-[11px] font-mono font-semibold rounded-md bg-white hover:bg-emerald-50 border border-emerald-900/15 text-emerald-800 disabled:opacity-50 flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw className={`w-3 h-3 ${pinging ? 'animate-spin' : ''}`} />
              <span>Ping Now</span>
            </button>
          )}
        </div>
      </div>

      {/* Bottom: Threshold Legend + Rolling Latency Spark-Bars */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-emerald-900/10 pt-2.5 text-[11px] font-mono tabular-nums">
        {/* Explicit Green / Yellow / Red Transition Thresholds */}
        <div className="flex flex-wrap items-center gap-3 text-slate-600">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            <span>Green &lt;{LATENCY_GREEN_MAX_MS}ms</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-amber-400" />
            <span>Yellow {LATENCY_GREEN_MAX_MS}–{LATENCY_YELLOW_MAX_MS}ms</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-rose-500" />
            <span>Red ≥{LATENCY_YELLOW_MAX_MS + 1}ms / Offline</span>
          </span>
        </div>

        {/* Rolling Ping Sample Bars + Min/Avg/Max */}
        <div className="flex flex-wrap items-center gap-3">
          {history.length > 0 && (
            <div
              className="flex items-end gap-1 h-5"
              title="Recent MaixSense ping samples (left: oldest, right: latest)"
            >
              {history.map((sample) => {
                const barStyle = TIER_STYLES[sample.tier];
                const heightClass = !sample.reachable
                  ? 'h-5'
                  : sample.rttMs === null
                  ? 'h-1.5'
                  : sample.rttMs < 40
                  ? 'h-1.5'
                  : sample.rttMs < 80
                  ? 'h-2.5'
                  : sample.rttMs < 160
                  ? 'h-3.5'
                  : sample.rttMs < 250
                  ? 'h-4'
                  : 'h-5';
                return (
                  <span
                    key={sample.id}
                    title={`${sample.timestamp} — ${
                      sample.reachable
                        ? sample.rttMs !== null
                          ? `${sample.rttMs} ms`
                          : 'Bridge OK'
                        : 'Timeout / Unreachable'
                    }`}
                    className={`w-1.5 rounded-t-sm transition-all duration-300 ${heightClass} ${barStyle.barBg}`}
                  />
                );
              })}
            </div>
          )}

          <div className="text-slate-500">
            {avgRtt !== null ? (
              <span>
                Avg <strong className="text-slate-800">{avgRtt}ms</strong> · Min {minRtt}ms · Max {maxRtt}ms
              </span>
            ) : reachablePct !== null ? (
              <span>Uptime {reachablePct}% ({history.length} pings)</span>
            ) : (
              <span>Awaiting first ping...</span>
            )}
            {lastCheckedAt && <span className="ml-2 text-slate-400">· {lastCheckedAt}</span>}
          </div>
        </div>
      </div>
    </div>
  );
};
