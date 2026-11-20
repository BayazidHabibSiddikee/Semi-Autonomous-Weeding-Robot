import React, { useEffect, useRef, useState } from 'react';
import {
  Play,
  Pause,
  StepForward,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Route,
  CheckCircle2,
} from 'lucide-react';
import { AppLanguage } from '../i18n/strings';
import { Mission } from '../domain/models';
import { RoverFieldSimulation, RoverSimSnapshot, RoverState } from '../domain/fieldSimulator';

interface Props {
  lang: AppLanguage;
  activeMission: Mission | null;
  onUseDefaultMission: () => void;
}

const STATE_FLOW: RoverState[] = [
  'IDLE',
  'FOLLOW_ROW',
  'STOP',
  'SCAN',
  'AIM',
  'FIRE',
  'HEADLAND_TURN',
  'DONE',
];

export const FieldSimulatorScreen: React.FC<Props> = ({
  lang,
  activeMission,
  onUseDefaultMission,
}) => {
  const isBn = lang === 'BN';
  const simRef = useRef<RoverFieldSimulation>(new RoverFieldSimulation(42, activeMission));
  const [snap, setSnap] = useState<RoverSimSnapshot>(() => simRef.current.getSnapshot());
  const [running, setRunning] = useState(false);
  const [seedInput, setSeedInput] = useState('42');
  const [speedMs, setSpeedMs] = useState(110);

  const camCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const mapCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Reload simulation whenever a new mission is sent from Path Planner (or cleared to default)
  useEffect(() => {
    setRunning(false);
    const seed = parseInt(seedInput, 10) || 42;
    simRef.current.loadMission(activeMission, seed);
    setSnap(simRef.current.getSnapshot());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMission]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      const sim = simRef.current;
      sim.running = true;
      sim.tick();
      const next = sim.getSnapshot();
      setSnap(next);
      if (next.state === 'DONE' || next.eStopped) {
        setRunning(false);
      }
    }, speedMs);
    return () => window.clearInterval(timer);
  }, [running, speedMs]);

  // Draw downward camera canvas (40x30cm footprint)
  useEffect(() => {
    const canvas = camCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    // Brown soil background
    ctx.fillStyle = '#5A463C';
    ctx.fillRect(0, 0, w, h);

    // Subtle scrolling soil grain tied to world pose
    ctx.fillStyle = 'rgba(255,255,255,0.045)';
    for (let i = 0; i < 65; i++) {
      const gx = (((i * 97 - Math.round(snap.roverX * 6)) % w) + w) % w;
      const gy = (((i * 53 - Math.round(snap.roverY * 6)) % h) + h) % h;
      ctx.fillRect(gx, gy, 3, 3);
    }

    // Center row-alignment guide line in camera view
    ctx.strokeStyle = 'rgba(0, 230, 118, 0.22)';
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    const worldToCam = (wx: number, wy: number) => {
      const dx = wx - snap.roverX;
      const dy = wy - snap.roverY;
      const rad = (snap.heading * Math.PI) / 180;
      const rx = dx * Math.cos(rad) + dy * Math.sin(rad);
      const ry = -dx * Math.sin(rad) + dy * Math.cos(rad);
      return {
        u: (rx / snap.camViewWCm) * w + w / 2,
        v: (ry / snap.camViewHCm) * h + h / 2,
      };
    };

    // Draw tomato crops (protected — shield ring)
    snap.crops.forEach((c) => {
      const { u, v } = worldToCam(c.x, c.y);
      if (u < -50 || u > w + 50 || v < -50 || v > h + 50) return;
      const rx = (c.radiusCm / snap.camViewWCm) * w;
      const ry = (c.radiusCm / snap.camViewHCm) * h;

      ctx.fillStyle = '#2E6B24';
      ctx.beginPath();
      ctx.ellipse(u, v, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#439437';
      ctx.beginPath();
      ctx.ellipse(u, v, rx * 0.58, ry * 0.58, Math.PI / 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#D32F2F';
      ctx.beginPath();
      ctx.arc(u + rx * 0.28, v, Math.max(3, rx * 0.2), 0, Math.PI * 2);
      ctx.fill();

      // Subtle green crop-safe ring
      ctx.strokeStyle = 'rgba(129, 199, 132, 0.55)';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.ellipse(u, v, rx + 4, ry + 4, 0, 0, Math.PI * 2);
      ctx.stroke();
    });

    // Draw weeds (light green spiky star)
    snap.weeds.forEach((weed) => {
      const { u, v } = worldToCam(weed.x, weed.y);
      if (u < -40 || u > w + 40 || v < -40 || v > h + 40) return;
      const rx = (weed.radiusCm / snap.camViewWCm) * w;
      const ry = (weed.radiusCm / snap.camViewHCm) * h;

      ctx.fillStyle = '#9AE67E';
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const ang = (Math.PI * i) / 5;
        const mult = i % 2 === 0 ? 1 : 0.45;
        const px = u + rx * mult * Math.cos(ang);
        const py = v + ry * mult * Math.sin(ang);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = '#5AA05A';
      ctx.beginPath();
      ctx.arc(u, v, Math.max(2, rx * 0.24), 0, Math.PI * 2);
      ctx.fill();
    });

    // Detection bounding boxes
    snap.pendingWeeds.forEach((det) => {
      const su = (det.u / snap.frameW) * w;
      const sv = (det.v / snap.frameH) * h;
      const boxR = 26;
      ctx.strokeStyle = '#FFEB3B';
      ctx.lineWidth = 2;
      ctx.strokeRect(su - boxR, sv - boxR, boxR * 2, boxR * 2);
      ctx.fillStyle = '#FFEB3B';
      ctx.font = 'bold 11px monospace';
      ctx.fillText(`WEED ${(det.confidence * 100).toFixed(0)}%`, su - boxR, sv - boxR - 4);
    });

    // Gimbal aim reticle & laser beam
    if (snap.aimPixel) {
      const au = (snap.aimPixel.u / snap.frameW) * w;
      const av = (snap.aimPixel.v / snap.frameH) * h;
      ctx.strokeStyle = snap.laserFiring ? '#FF1744' : '#00E5FF';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(au, av, 14, 0, Math.PI * 2);
      ctx.moveTo(au - 20, av);
      ctx.lineTo(au + 20, av);
      ctx.moveTo(au, av - 20);
      ctx.lineTo(au, av + 20);
      ctx.stroke();

      if (snap.laserFiring) {
        ctx.strokeStyle = '#FF1744';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(w / 2, h);
        ctx.lineTo(au, av);
        ctx.stroke();

        ctx.fillStyle = 'rgba(255, 23, 68, 0.55)';
        ctx.beginPath();
        ctx.arc(au, av, 18, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // HUD top bar
    ctx.fillStyle = 'rgba(0,0,0,0.68)';
    ctx.fillRect(0, 0, w, 28);
    ctx.fillStyle = '#00E676';
    ctx.font = 'bold 12px monospace';
    ctx.fillText(
      `CAM 40×30cm | ${snap.state} | ROW ${snap.currentRow}/${snap.totalRows} | PAN ${snap.panDeg}° TILT ${snap.tiltDeg}° | ToF ${snap.tofDistanceMm}mm`,
      10,
      18
    );
  }, [snap]);

  // Draw top-down mission minimap with planned Boustrophedon path, Attention Window, crops & rover
  useEffect(() => {
    const canvas = mapCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const pad = 22;
    const innerW = w - pad * 2;
    const innerH = h - pad * 2;
    const sx = innerW / snap.fieldWCm;
    const sy = innerH / snap.fieldHCm;

    const toCanvasX = (cmX: number) => pad + cmX * sx;
    const toCanvasY = (cmY: number) => pad + cmY * sy;

    // Outer headland margin
    ctx.fillStyle = '#362A24';
    ctx.fillRect(0, 0, w, h);

    // Soil field plot
    ctx.fillStyle = '#4E3E35';
    ctx.fillRect(pad, pad, innerW, innerH);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(pad, pad, innerW, innerH);

    // Attention Window shaded end zones (row-end detection zones)
    const attnStartCm = Math.max(0, snap.mission.attentionWindow.startM * 100);
    const attnWidthCm = Math.max(0, snap.fieldWCm - attnStartCm);
    if (attnWidthCm > 0) {
      ctx.fillStyle = snap.inAttentionWindow
        ? 'rgba(255, 193, 7, 0.20)'
        : 'rgba(255, 193, 7, 0.08)';
      // Right-end attention zone (for +X rows)
      ctx.fillRect(toCanvasX(attnStartCm), pad, attnWidthCm * sx, innerH);
      // Left-end attention zone (for -X return rows)
      ctx.fillRect(pad, pad, attnWidthCm * sx, innerH);
    }

    // Planned Boustrophedon path segments
    snap.mission.path.forEach((seg, idx) => {
      const x1 = toCanvasX(seg.startPoint.x * 100);
      const y1 = toCanvasY(seg.startPoint.y * 100);
      const x2 = toCanvasX(seg.endPoint.x * 100);
      const y2 = toCanvasY(seg.endPoint.y * 100);

      const isActive = idx === snap.activeSegmentIndex && snap.state !== 'DONE';
      const isCompleted = idx < snap.activeSegmentIndex || snap.state === 'DONE';

      ctx.save();
      if (seg.type === 'FollowRow') {
        ctx.strokeStyle = isActive
          ? '#00E676'
          : isCompleted
          ? 'rgba(0, 230, 118, 0.45)'
          : 'rgba(255, 255, 255, 0.25)';
        ctx.lineWidth = isActive ? 3 : 1.75;
        if (!isCompleted && !isActive) ctx.setLineDash([5, 5]);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        // Row label on left side
        ctx.setLineDash([]);
        ctx.fillStyle = isActive ? '#00E676' : 'rgba(255,255,255,0.55)';
        ctx.font = 'bold 10px monospace';
        ctx.fillText(`R${seg.row}`, 4, y1 + 3);
      } else {
        ctx.strokeStyle = isActive
          ? '#F06292'
          : isCompleted
          ? 'rgba(224, 64, 251, 0.5)'
          : 'rgba(224, 64, 251, 0.35)';
        ctx.lineWidth = isActive ? 3 : 2;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      ctx.restore();
    });

    // Driven rover trail
    if (snap.trail.length > 1) {
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.72)';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      snap.trail.forEach((pt, idx) => {
        const px = toCanvasX(pt.x);
        const py = toCanvasY(pt.y);
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }

    // Crops along rows
    snap.crops.forEach((c) => {
      ctx.fillStyle = '#2E7D32';
      ctx.beginPath();
      ctx.arc(
        toCanvasX(c.x),
        toCanvasY(c.y),
        Math.max(2.5, Math.min(6, c.radiusCm * sx)),
        0,
        Math.PI * 2
      );
      ctx.fill();
    });

    // Eliminated weed markers
    snap.eliminatedPositions.forEach((pos) => {
      const px = toCanvasX(pos.x);
      const py = toCanvasY(pos.y);
      ctx.strokeStyle = 'rgba(255, 82, 82, 0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(px - 3, py - 3);
      ctx.lineTo(px + 3, py + 3);
      ctx.moveTo(px + 3, py - 3);
      ctx.lineTo(px - 3, py + 3);
      ctx.stroke();
    });

    // Active remaining weeds
    snap.weeds.forEach((weed) => {
      ctx.fillStyle = '#B2FF59';
      ctx.beginPath();
      ctx.arc(
        toCanvasX(weed.x),
        toCanvasY(weed.y),
        Math.max(2.8, Math.min(5.5, weed.radiusCm * sx)),
        0,
        Math.PI * 2
      );
      ctx.fill();
    });

    // Camera footprint box around rover
    const rx = toCanvasX(snap.roverX);
    const ry = toCanvasY(snap.roverY);
    const rad = (snap.heading * Math.PI) / 180;
    ctx.save();
    ctx.translate(rx, ry);
    ctx.rotate(rad);
    ctx.strokeStyle = 'rgba(255, 235, 59, 0.85)';
    ctx.lineWidth = 1.6;
    ctx.strokeRect(
      (-snap.camViewWCm / 2) * sx,
      (-snap.camViewHCm / 2) * sy,
      snap.camViewWCm * sx,
      snap.camViewHCm * sy
    );
    ctx.restore();

    // Rover body & heading arrow
    ctx.strokeStyle = '#FF3D00';
    ctx.fillStyle = '#FF3D00';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(rx, ry, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(rx, ry);
    ctx.lineTo(rx + 18 * Math.cos(rad), ry + 18 * Math.sin(rad));
    ctx.stroke();
  }, [snap]);

  const handleReset = () => {
    setRunning(false);
    const seed = parseInt(seedInput, 10) || 42;
    simRef.current.reset(seed);
    setSnap(simRef.current.getSnapshot());
  };

  const handleStep = () => {
    setRunning(false);
    simRef.current.tick();
    setSnap(simRef.current.getSnapshot());
  };

  const handleToggleEStop = () => {
    if (snap.eStopped) {
      simRef.current.clearEmergencyStop();
    } else {
      setRunning(false);
      simRef.current.emergencyStop();
    }
    setSnap(simRef.current.getSnapshot());
  };

  const activeSeg = snap.mission.path[snap.activeSegmentIndex];

  return (
    <div className="space-y-4">
      {/* Control Bar */}
      <section className="rounded-2xl border border-[#DCE5D7] bg-white p-4 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-bold text-[#1C1D1A]">
                {isBn
                  ? 'মিশন-চালিত বস্ট্রোফেডন ফিল্ড সিমুলেটর'
                  : 'Mission-Driven Boustrophedon Field Simulator'}
              </h2>
              <span
                className={`rounded-md px-2 py-0.5 text-[11px] font-bold ${
                  snap.isCustomMission
                    ? 'bg-[#E8F5E9] text-[#1B5E20]'
                    : 'bg-[#E2E7DD] text-[#43483F]'
                }`}
              >
                {snap.isCustomMission
                  ? `BEV Planner Mission (${snap.mission.field.lengthM}m × ${snap.mission.field.widthM}m)`
                  : `Default Field (${snap.mission.field.lengthM}m × ${snap.mission.field.widthM}m)`}
              </span>
              {snap.isCustomMission && (
                <button
                  type="button"
                  onClick={onUseDefaultMission}
                  className="text-xs font-semibold text-[#2E7D32] underline hover:text-[#1B5E20]"
                >
                  {isBn ? 'ডিফল্ট ফিল্ডে ফিরুন' : 'Switch to Default Field'}
                </button>
              )}
            </div>
            <p className="mt-0.5 text-xs text-[#43483F]">
              {isBn
                ? 'সারি-অনুসরণকারী (Boustrophedon) রোভার নেভিগেশন, হেডল্যান্ড টার্ন, Attention Window ও ক্যালিব্রেটেড লেজার নিড়ানি'
                : 'Structured serpentine row-following navigation with headland turns, Attention Window detection, and calibrated laser weeding'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={snap.eStopped || snap.state === 'DONE'}
              onClick={() => setRunning((r) => !r)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#2E7D32] px-3 py-1.5 text-xs font-bold text-white hover:bg-[#1B5E20] disabled:opacity-50"
            >
              {running ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {running ? (isBn ? 'বিরতি' : 'Pause') : isBn ? 'মিশন চালান' : 'Run Mission'}
            </button>

            <button
              type="button"
              disabled={snap.eStopped || snap.state === 'DONE'}
              onClick={handleStep}
              className="inline-flex items-center gap-1 rounded-lg border border-[#2E7D32] px-2.5 py-1.5 text-xs font-semibold text-[#2E7D32] hover:bg-[#2E7D32]/10 disabled:opacity-50"
            >
              <StepForward className="h-3.5 w-3.5" />
              {isBn ? 'এক ধাপ' : 'Step'}
            </button>

            <button
              type="button"
              onClick={handleReset}
              className="inline-flex items-center gap-1 rounded-lg border border-[#C6D3C1] px-2.5 py-1.5 text-xs font-semibold text-[#43483F] hover:bg-[#E2E7DD]/60"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {isBn ? 'রিসেট' : 'Reset'}
            </button>

            <button
              type="button"
              onClick={handleToggleEStop}
              className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-bold text-white ${
                snap.eStopped ? 'bg-amber-600 hover:bg-amber-700' : 'bg-red-600 hover:bg-red-700'
              }`}
            >
              {snap.eStopped ? (
                <ShieldCheck className="h-3.5 w-3.5" />
              ) : (
                <ShieldAlert className="h-3.5 w-3.5" />
              )}
              {snap.eStopped ? 'Reset E-Stop' : 'E-STOP'}
            </button>
          </div>
        </div>

        {/* Active Mission Segment Bar */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[#F4F8F2] px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-2 font-semibold text-[#1C1D1A]">
            {snap.state === 'DONE' ? (
              <CheckCircle2 className="h-4 w-4 text-[#2E7D32]" />
            ) : (
              <Route className="h-4 w-4 text-[#2E7D32]" />
            )}
            <span>
              {snap.state === 'DONE'
                ? `Mission Complete · ${snap.stats.rowsCompleted}/${snap.totalRows} rows swept`
                : activeSeg?.type === 'FollowRow'
                ? `Seg ${activeSeg.seq}/${snap.totalSegments} · FOLLOW_ROW #${activeSeg.row} · ${snap.rowProgressM.toFixed(2)}m / ${snap.rowLengthM.toFixed(1)}m`
                : activeSeg?.type === 'Turn'
                ? `Seg ${activeSeg.seq}/${snap.totalSegments} · HEADLAND TURN (${activeSeg.direction}, gap ${activeSeg.gapM.toFixed(2)}m)`
                : 'Mission Ready'}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded px-2 py-0.5 text-[11px] font-bold ${
                snap.inAttentionWindow
                  ? 'bg-amber-200 text-amber-900'
                  : 'bg-white text-[#43483F] border border-[#DCE5D7]'
              }`}
            >
              Attention Window [{snap.mission.attentionWindow.startM.toFixed(1)}–
              {snap.mission.attentionWindow.endM.toFixed(1)}m]:{' '}
              {snap.inAttentionWindow ? 'ACTIVE' : 'Standby'}
            </span>
          </div>
        </div>

        {/* Seed & Speed Controls + State Machine Chips */}
        <div className="mt-3 flex flex-wrap items-center gap-4 border-t border-[#E2E7DD] pt-3 text-xs">
          <label className="flex items-center gap-2 font-medium text-[#43483F]">
            Seed:
            <input
              type="number"
              value={seedInput}
              onChange={(e) => setSeedInput(e.target.value)}
              className="w-16 rounded border border-[#C6D3C1] bg-[#F9FBF7] px-2 py-1 text-xs"
            />
          </label>
          <label className="flex items-center gap-2 font-medium text-[#43483F]">
            Tick Speed:
            <input
              type="range"
              min={30}
              max={360}
              step={15}
              value={390 - speedMs}
              onChange={(e) => setSpeedMs(390 - Number(e.target.value))}
              className="accent-[#2E7D32]"
            />
          </label>
          <div className="ml-auto flex flex-wrap gap-1.5">
            {STATE_FLOW.map((st) => (
              <span
                key={st}
                className={`rounded px-2 py-0.5 text-[11px] font-bold ${
                  snap.state === st
                    ? 'bg-[#2E7D32] text-white'
                    : 'bg-[#E2E7DD] text-[#43483F]'
                }`}
              >
                {st}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* Camera + Minimap Canvases */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-[#DCE5D7] bg-white p-3 shadow-xs">
          <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-[#43483F]">
            {isBn ? 'ডাউনওয়ার্ড ক্যামেরা ভিউ (40×30cm)' : 'Downward Camera View (40×30cm FOV)'}
          </h3>
          <canvas
            ref={camCanvasRef}
            width={640}
            height={400}
            className="w-full rounded-xl bg-[#3D312B]"
          />
        </div>

        <div className="rounded-2xl border border-[#DCE5D7] bg-white p-3 shadow-xs">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-bold uppercase tracking-wide text-[#43483F]">
              {isBn
                ? `মিশন মিনিম্যাপ (${snap.mission.field.lengthM}m × ${snap.mission.field.widthM}m)`
                : `Boustrophedon Field Map (${snap.mission.field.lengthM}m × ${snap.mission.field.widthM}m)`}
            </h3>
            <div className="flex flex-wrap items-center gap-2.5 text-[11px] text-[#43483F]">
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-[#00E676]" /> Row Lane
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-[#F06292]" /> Headland
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-[#B2FF59]" /> Weed
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 rounded-full bg-[#2E7D32]" /> Tomato Crop
              </span>
            </div>
          </div>
          <canvas
            ref={mapCanvasRef}
            width={600}
            height={400}
            className="w-full rounded-xl bg-[#362A24]"
          />
        </div>
      </div>

      {/* Telemetry Metrics */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <div className="rounded-xl border border-[#DCE5D7] bg-white p-3">
          <div className="text-[11px] font-semibold text-[#43483F]">Weeds Eliminated</div>
          <div className="text-lg font-bold text-[#2E7D32]">
            {snap.stats.weedsFired} / {snap.initialWeedCount}
          </div>
        </div>
        <div className="rounded-xl border border-[#DCE5D7] bg-white p-3">
          <div className="text-[11px] font-semibold text-[#43483F]">Row / Turns</div>
          <div className="text-sm font-bold text-[#1C1D1A]">
            Row {snap.currentRow}/{snap.totalRows} · {snap.stats.headlandTurns} turns
          </div>
        </div>
        <div className="rounded-xl border border-[#DCE5D7] bg-white p-3">
          <div className="text-[11px] font-semibold text-[#43483F]">Rover Pose</div>
          <div className="text-sm font-bold text-[#1C1D1A]">
            ({(snap.roverX / 100).toFixed(2)}, {(snap.roverY / 100).toFixed(2)})m ·{' '}
            {snap.heading.toFixed(0)}°
          </div>
        </div>
        <div className="rounded-xl border border-[#DCE5D7] bg-white p-3">
          <div className="text-[11px] font-semibold text-[#43483F]">Gimbal (Pan / Tilt)</div>
          <div className="text-sm font-bold text-[#1C1D1A]">
            {snap.panDeg}° / {snap.tiltDeg}°
          </div>
        </div>
        <div className="rounded-xl border border-[#DCE5D7] bg-white p-3">
          <div className="text-[11px] font-semibold text-[#43483F]">Distance / ToF</div>
          <div className="text-sm font-bold text-[#1C1D1A]">
            {snap.stats.distanceTravelledM.toFixed(1)}m · {snap.tofDistanceMm}mm
          </div>
        </div>
      </div>

      {/* Event Log */}
      <section className="rounded-2xl border border-[#DCE5D7] bg-white p-4 shadow-xs">
        <h3 className="mb-2 text-xs font-bold uppercase tracking-wide text-[#43483F]">
          {isBn ? 'মিশন নেভিগেশন লগ' : 'Mission State Machine Trace'}
        </h3>
        <div className="max-h-40 space-y-1 overflow-y-auto font-mono text-xs text-[#43483F]">
          {snap.logs.map((entry, idx) => (
            <div key={`${entry.tick}-${idx}`} className="flex gap-2">
              <span className="text-[#2E7D32]">[#{entry.tick}]</span>
              <span className="font-bold text-[#1C1D1A]">{entry.state}</span>
              <span>{entry.message}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};
