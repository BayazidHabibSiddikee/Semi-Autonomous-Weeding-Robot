import React, { useEffect, useRef, useState } from 'react';
import {
  Play,
  Pause,
  StepForward,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Radio,
  Film,
} from 'lucide-react';
import { AppLanguage } from '../i18n/strings';
import {
  LaunchMissionConfig,
  LiveRoverSnapshot,
  PiRoverLiveEngine,
  RelayMode,
} from '../domain/roverLiveEngine';

interface Props {
  lang: AppLanguage;
  piHost: string;
  onPiHostChange: (host: string) => void;
  launchConfig: LaunchMissionConfig | null;
}

type StreamMode = 'SIMULATOR' | 'LIVE_PI';

interface LivePiCutPlanJson {
  state?: string;
  running?: boolean;
  e_stopped?: boolean;
  heading_deg?: number;
  esp32_drive_deg?: number | null;
  lateral_offset_mm?: number;
  wall_distance_mm?: number;
  turret_angle_deg?: number;
  relay1_grinder?: boolean;
  relay2_flame?: boolean;
  weeds_eliminated?: number;
  cut_queue?: {
    weed_id: number;
    x_ground_mm: number;
    y_fwd_mm: number;
    band_mm: number;
    turret_angle_deg: number;
    confidence: number;
  }[];
  chlorosis_clips?: {
    clip_id: number;
    side: string;
    row_index: number;
    filename: string;
    duration_s: number;
  }[];
}

export const LiveRoverStreamScreen: React.FC<Props> = ({
  lang,
  piHost,
  onPiHostChange,
  launchConfig,
}) => {
  const isBn = lang === 'BN';

  const engineRef = useRef<PiRoverLiveEngine>(new PiRoverLiveEngine(launchConfig ?? undefined));
  const [snap, setSnap] = useState<LiveRoverSnapshot>(() => engineRef.current.getSnapshot());
  const [running, setRunning] = useState<boolean>(Boolean(launchConfig));
  const [speedMs, setSpeedMs] = useState(140);
  const [streamMode, setStreamMode] = useState<StreamMode>('SIMULATOR');

  // Live Pi FastAPI state when switched to LIVE_PI mode
  const [piConnected, setPiConnected] = useState(false);
  const [piError, setPiError] = useState<string | null>(null);
  const [liveCutPlan, setLiveCutPlan] = useState<LivePiCutPlanJson | null>(null);

  const videoCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const mapCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const bevBgRef = useRef<HTMLImageElement | null>(null);

  // Re-configure onboard engine whenever user sends a new photo + Start/End from Capture screen
  useEffect(() => {
    if (!launchConfig) return;
    engineRef.current.configure(launchConfig);
    setSnap(engineRef.current.getSnapshot());
    setStreamMode('SIMULATOR');
    setRunning(true);
  }, [launchConfig]);

  // Cache warped BEV image for /map_feed background rendering
  useEffect(() => {
    if (!snap.bevDataUrl) {
      bevBgRef.current = null;
      return;
    }
    const img = new Image();
    img.onload = () => {
      bevBgRef.current = img;
    };
    img.src = snap.bevDataUrl;
  }, [snap.bevDataUrl]);

  // Onboard Pi Simulator tick loop
  useEffect(() => {
    if (streamMode !== 'SIMULATOR' || !running) return;
    const timer = window.setInterval(() => {
      const eng = engineRef.current;
      eng.running = true;
      eng.tick();
      const next = eng.getSnapshot();
      setSnap(next);
      if (next.state === 'DONE' || next.eStopped) {
        setRunning(false);
      }
    }, speedMs);
    return () => window.clearInterval(timer);
  }, [streamMode, running, speedMs]);

  // Live Raspberry Pi FastAPI /cut_plan polling when streamMode === 'LIVE_PI'
  useEffect(() => {
    if (streamMode !== 'LIVE_PI') return;
    let active = true;
    const base = piHost.replace(/\/+$/, '');

    const poll = async () => {
      try {
        const res = await fetch(`${base}/cut_plan`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as LivePiCutPlanJson;
        if (active) {
          setLiveCutPlan(data);
          setPiConnected(true);
          setPiError(null);
        }
      } catch (err) {
        if (active) {
          setPiConnected(false);
          setPiError(err instanceof Error ? err.message : 'Pi unreachable from browser');
        }
      }
    };

    poll();
    const timer = window.setInterval(poll, 450);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [streamMode, piHost]);

  // Render Live /video_feed (30° Forward/Downward Furrow Camera + MaixSense Depth + YOLOv8 + MG996R Turret)
  useEffect(() => {
    if (streamMode !== 'SIMULATOR') return;
    const canvas = videoCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const horizonY = Math.round(h * 0.22);

    // Sky / distant field canopy backdrop
    const skyGrad = ctx.createLinearGradient(0, 0, 0, horizonY);
    skyGrad.addColorStop(0, '#1E293B');
    skyGrad.addColorStop(1, '#334155');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, w, horizonY);

    // Perspective furrow corridor soil
    const soilGrad = ctx.createLinearGradient(0, horizonY, 0, h);
    soilGrad.addColorStop(0, '#44352C');
    soilGrad.addColorStop(1, '#614B3F');
    ctx.fillStyle = soilGrad;
    ctx.fillRect(0, horizonY, w, h - horizonY);

    // Project rover-frame ground mm (xGroundMm, yFwdMm) into 30° perspective camera pixels
    const projectGround = (xMm: number, yFwdMm: number) => {
      // Shift perspective slightly by lateralOffsetMm so rover drift is visibly felt
      const xRel = xMm - snap.lateralOffsetMm;
      const depthNorm = Math.max(0.05, Math.min(1.0, (yFwdMm - 40) / 620));
      const py = h - 36 - depthNorm * (h - horizonY - 46);
      const halfCorridorPx = (1 - depthNorm * 0.68) * (w * 0.34);
      const px = w / 2 + (xRel / 220) * halfCorridorPx;
      return { px, py, scale: 1 - depthNorm * 0.64 };
    };

    // Scrolling soil texture streaks for realistic forward motion
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    const scrollPhase = (snap.distanceTravelledM * 180) % 60;
    for (let d = 60; d <= 600; d += 60) {
      const yDist = Math.max(50, d - scrollPhase);
      const left = projectGround(-210, yDist);
      const right = projectGround(210, yDist);
      ctx.beginPath();
      ctx.moveTo(left.px, left.py);
      ctx.lineTo(right.px, right.py);
      ctx.stroke();
    }

    // Left & Right Raised Chili Crop Ridge Walls (>60mm MaixSense depth slices)
    const drawCropWall = (side: -1 | 1) => {
      const nearInner = projectGround(side * 195, 50);
      const farInner = projectGround(side * 195, 640);
      const edgeX = side < 0 ? 0 : w;

      ctx.fillStyle = '#1E4620';
      ctx.beginPath();
      ctx.moveTo(edgeX, horizonY);
      ctx.lineTo(farInner.px, farInner.py);
      ctx.lineTo(nearInner.px, nearInner.py);
      ctx.lineTo(edgeX, h);
      ctx.closePath();
      ctx.fill();

      // Textured chili canopy foliage bumps along wall
      for (let step = 0; step < 9; step++) {
        const yDist = 70 + step * 65 - (scrollPhase * 0.8);
        if (yDist < 45 || yDist > 630) continue;
        const p = projectGround(side * 245, yDist);
        const r = Math.max(10, 32 * p.scale);
        ctx.fillStyle = step % 2 === 0 ? '#2E6B2E' : '#255825';
        ctx.beginPath();
        ctx.arc(p.px, p.py - r * 0.2, r, 0, Math.PI * 2);
        ctx.fill();

        // Highlight chlorosis yellowing on side canopy when actively recording clip
        if (snap.recordingClip && ((side < 0 && snap.recordingClip.side === 'LEFT') || (side > 0 && snap.recordingClip.side === 'RIGHT')) && step === 3) {
          ctx.fillStyle = 'rgba(250, 204, 21, 0.85)';
          ctx.beginPath();
          ctx.arc(p.px, p.py - r * 0.2, r * 0.72, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = '#FACC15';
          ctx.lineWidth = 2;
          ctx.strokeRect(p.px - r, p.py - r * 1.1, r * 2, r * 1.8);
          ctx.fillStyle = '#FACC15';
          ctx.font = '700 10px "IBM Plex Mono", monospace';
          ctx.fillText('CHLOROSIS', p.px - r, p.py - r * 1.25);
        }
      }

      // MaixSense-A075V >60mm wall slice cyan guide line
      ctx.strokeStyle = 'rgba(6, 182, 212, 0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(farInner.px, farInner.py);
      ctx.lineTo(nearInner.px, nearInner.py);
      ctx.stroke();
    };

    drawCropWall(-1);
    drawCropWall(1);

    // Approaching Row-End Headland Wall Indicator (<1400mm visible, <520mm triggers U-turn)
    if (snap.frontWallDistanceMm < 1400 || snap.state === 'U_TURN_PIVOT') {
      const wallY = Math.max(horizonY + 12, Math.min(h * 0.56, horizonY + (1 - snap.frontWallDistanceMm / 1400) * 140));
      const isTrigger = snap.frontWallDistanceMm < 520 || snap.state === 'U_TURN_PIVOT';
      ctx.fillStyle = isTrigger ? 'rgba(245, 158, 11, 0.28)' : 'rgba(6, 182, 212, 0.14)';
      ctx.fillRect(w * 0.24, wallY - 14, w * 0.52, 28);
      ctx.strokeStyle = isTrigger ? '#F59E0B' : '#06B6D4';
      ctx.lineWidth = 2;
      ctx.strokeRect(w * 0.24, wallY - 14, w * 0.52, 28);
      ctx.fillStyle = isTrigger ? '#FEF3C7' : '#CFFAFE';
      ctx.font = '700 11px "IBM Plex Mono", monospace';
      ctx.fillText(
        snap.state === 'U_TURN_PIVOT'
          ? `ESP32 ${snap.esp32DriveLabel} — CROSSING TO NEXT FURROW`
          : `ROW-END WALL: ${snap.frontWallDistanceMm}mm ${isTrigger ? '(<520mm U-TURN)' : ''}`,
        w * 0.26,
        wallY + 4
      );
    }

    // 30mm Forward Cut-Band Horizontal Guides inside Turret Reach (60..270mm)
    for (let band = 90; band <= 270; band += 60) {
      const l = projectGround(-175, band);
      const r = projectGround(175, band);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(l.px, l.py);
      ctx.lineTo(r.px, r.py);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // YOLOv8 Weed Stem-Base Detections (X_ground, Y_fwd)
    snap.visibleWeeds.forEach((weed) => {
      const { px, py, scale } = projectGround(weed.xGroundMm, weed.yFwdMm);
      const rad = Math.max(8, 18 * scale);

      // Weed plant foliage
      ctx.fillStyle = '#84CC16';
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const ang = (Math.PI * i) / 4;
        const mult = i % 2 === 0 ? 1 : 0.45;
        const x = px + rad * mult * Math.cos(ang);
        const y = py + rad * 0.72 * mult * Math.sin(ang);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();

      // Stem base bounding box & (X_ground, Y_fwd) label
      const box = Math.max(16, rad * 1.45);
      ctx.strokeStyle = weed.isCurrentTarget ? '#EF4444' : '#FACC15';
      ctx.lineWidth = weed.isCurrentTarget ? 2.5 : 1.75;
      ctx.strokeRect(px - box, py - box, box * 2, box * 2);

      // Stem crosshair
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(px - 5, py);
      ctx.lineTo(px + 5, py);
      ctx.moveTo(px, py - 5);
      ctx.lineTo(px, py + 5);
      ctx.stroke();

      ctx.fillStyle = weed.isCurrentTarget ? '#FCA5A5' : '#FEF08A';
      ctx.font = '600 10px "IBM Plex Mono", monospace';
      ctx.fillText(
        `W#${weed.weedId} B${weed.bandMm} (${weed.xGroundMm > 0 ? '+' : ''}${weed.xGroundMm.toFixed(0)},${weed.yFwdMm.toFixed(0)})mm`,
        Math.max(8, Math.min(w - 190, px - box)),
        Math.max(44, py - box - 5)
      );
    });

    // Bottom Foreground: MG996R Cylinder Turret Sector Gear (-35°..+35°) + Dual Relay Visualizer
    const pivotX = w / 2;
    const pivotY = h - 10;
    const turretRad = ((snap.turretAngleDeg - 90) * Math.PI) / 180;
    const armLen = 88;
    const tipX = pivotX + Math.cos(turretRad) * armLen;
    const tipY = pivotY + Math.sin(turretRad) * armLen;

    // -35°..+35° sector arc
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(pivotX, pivotY, armLen, ((-90 - 35) * Math.PI) / 180, ((-90 + 35) * Math.PI) / 180);
    ctx.stroke();

    // Turret arm
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(pivotX, pivotY);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();

    // Actuator head: Relay 1 Grinder / Relay 2 Thermal Flame
    if (snap.relay2Flame) {
      const flameGrad = ctx.createRadialGradient(tipX, tipY, 2, tipX, tipY, 28);
      flameGrad.addColorStop(0, 'rgba(254, 240, 138, 0.95)');
      flameGrad.addColorStop(0.5, 'rgba(249, 115, 22, 0.8)');
      flameGrad.addColorStop(1, 'rgba(239, 68, 68, 0)');
      ctx.fillStyle = flameGrad;
      ctx.beginPath();
      ctx.arc(tipX, tipY, 28, 0, Math.PI * 2);
      ctx.fill();
    }
    if (snap.relay1Grinder) {
      ctx.strokeStyle = '#38BDF8';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(tipX, tipY, 15, 0, Math.PI * 2);
      ctx.stroke();
      const spin = (snap.tick * 0.9) % (Math.PI * 2);
      ctx.beginPath();
      ctx.moveTo(tipX + Math.cos(spin) * 14, tipY + Math.sin(spin) * 14);
      ctx.lineTo(tipX - Math.cos(spin) * 14, tipY - Math.sin(spin) * 14);
      ctx.stroke();
    }

    ctx.fillStyle = snap.relay1Grinder || snap.relay2Flame ? '#EF4444' : '#06B6D4';
    ctx.beginPath();
    ctx.arc(tipX, tipY, 6, 0, Math.PI * 2);
    ctx.fill();

    // Top Camera HUD Ribbon
    ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
    ctx.fillRect(0, 0, w, 30);
    ctx.fillStyle = '#38BDF8';
    ctx.font = '600 11px "IBM Plex Mono", monospace';
    ctx.fillText(
      `/video_feed | ${snap.state} | DRIVE ${snap.esp32DriveLabel} | OFFSET ${snap.lateralOffsetMm >= 0 ? '+' : ''}${snap.lateralOffsetMm.toFixed(0)}mm | TURRET ${snap.turretAngleDeg >= 0 ? '+' : ''}${snap.turretAngleDeg.toFixed(1)}°`,
      10,
      19
    );

    // Passive Bad-Chili 3s MP4 Recording Indicator (only when actively recording a real detected lesion)
    if (snap.recordingClip) {
      ctx.fillStyle = 'rgba(180, 83, 9, 0.92)';
      ctx.fillRect(w - 236, 38, 226, 26);
      ctx.fillStyle = '#FEF3C7';
      ctx.font = '700 11px "IBM Plex Mono", monospace';
      ctx.fillText(
        `REC 3s MP4 · BAD-CHILI ${snap.recordingClip.side} (${snap.recordingClip.remainingS.toFixed(1)}s)`,
        w - 228,
        55
      );
    }
  }, [snap, streamMode]);

  // Render Live /map_feed (Auto-Warped BEV Field Map + Serpentine Route + Rover Live Pose + Weeds + Chlorosis Pins)
  useEffect(() => {
    if (streamMode !== 'SIMULATOR') return;
    const canvas = mapCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    if (bevBgRef.current) {
      ctx.drawImage(bevBgRef.current, 0, 0, w, h);
      ctx.fillStyle = 'rgba(11, 17, 23, 0.42)';
      ctx.fillRect(0, 0, w, h);
    } else {
      ctx.fillStyle = '#1E251F';
      ctx.fillRect(0, 0, w, h);
      snap.ridgesNx.forEach((rx) => {
        ctx.fillStyle = 'rgba(34, 197, 94, 0.22)';
        ctx.fillRect(rx * w - 18, 0, 36, h);
      });
    }

    // Traversable furrows
    snap.furrowsNx.forEach((fx, idx) => {
      const x = fx * w;
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.35)';
      ctx.lineWidth = 1.25;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(x, 18);
      ctx.lineTo(x, h - 18);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(253, 230, 138, 0.75)';
      ctx.font = '600 10px "IBM Plex Mono", monospace';
      ctx.fillText(`F${idx + 1}`, x - 6, h - 6);
    });

    // Planned Boustrophedon route
    for (let i = 0; i < snap.waypoints.length - 1; i++) {
      const a = snap.waypoints[i];
      const b = snap.waypoints[i + 1];
      const isTurn = Math.abs(b.nx - a.nx) > Math.abs(b.ny - a.ny);
      const completed = i < snap.activeWaypointIdx - 1 || snap.state === 'DONE';
      ctx.strokeStyle = isTurn
        ? completed
          ? 'rgba(245, 158, 11, 0.4)'
          : 'rgba(245, 158, 11, 0.85)'
        : completed
        ? 'rgba(6, 182, 212, 0.35)'
        : 'rgba(6, 182, 212, 0.85)';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(a.nx * w, a.ny * h);
      ctx.lineTo(b.nx * w, b.ny * h);
      ctx.stroke();
    }

    // Rover live trail
    if (snap.trail.length > 1) {
      ctx.strokeStyle = '#38BDF8';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      snap.trail.forEach((p, idx) => {
        if (idx === 0) ctx.moveTo(p.nx * w, p.ny * h);
        else ctx.lineTo(p.nx * w, p.ny * h);
      });
      ctx.stroke();
    }

    // Weeds (remaining lime dots, eliminated red X)
    snap.weeds.forEach((weed) => {
      const wx = weed.nx * w;
      const wy = weed.ny * h;
      if (weed.eliminated) {
        ctx.strokeStyle = 'rgba(248, 113, 113, 0.8)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(wx - 3.5, wy - 3.5);
        ctx.lineTo(wx + 3.5, wy + 3.5);
        ctx.moveTo(wx + 3.5, wy - 3.5);
        ctx.lineTo(wx - 3.5, wy + 3.5);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#A3E635';
        ctx.beginPath();
        ctx.arc(wx, wy, 4, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    // Recorded Bad-Chili Chlorosis pins (yellow diamonds)
    snap.chlorosisClips.forEach((clip) => {
      const cx = clip.nx * w;
      const cy = clip.ny * h;
      ctx.fillStyle = '#FACC15';
      ctx.beginPath();
      ctx.moveTo(cx, cy - 6);
      ctx.lineTo(cx + 6, cy);
      ctx.lineTo(cx, cy + 6);
      ctx.lineTo(cx - 6, cy);
      ctx.closePath();
      ctx.fill();
    });

    // Start & End markers
    const drawPin = (pt: { nx: number; ny: number }, color: string, label: string) => {
      const px = pt.nx * w;
      const py = pt.ny * h;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(px, py, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.font = '700 10px "IBM Plex Sans", sans-serif';
      ctx.fillText(label, px - 3, py + 3.5);
    };
    drawPin(snap.startPoint, '#16A34A', 'S');
    if (snap.endPoint) drawPin(snap.endPoint, '#DC2626', 'E');

    // Rover body & forward MaixSense FOV wedge
    const rx = snap.roverNx * w;
    const ry = snap.roverNy * h;
    const rad = ((snap.headingDeg - 90) * Math.PI) / 180;
    ctx.save();
    ctx.translate(rx, ry);
    ctx.rotate(rad);

    // Camera + MaixSense 30° forward FOV cone
    ctx.fillStyle = 'rgba(56, 189, 248, 0.22)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(36, -15);
    ctx.lineTo(36, 15);
    ctx.closePath();
    ctx.fill();

    // Chassis rectangle
    ctx.fillStyle = '#F8FAFC';
    ctx.strokeStyle = '#EF4444';
    ctx.lineWidth = 2.5;
    ctx.fillRect(-9, -7, 18, 14);
    ctx.strokeRect(-9, -7, 18, 14);
    ctx.restore();

    // Top Map HUD Ribbon
    ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
    ctx.fillRect(0, 0, w, 30);
    ctx.fillStyle = '#A7F3D0';
    ctx.font = '600 11px "IBM Plex Mono", monospace';
    ctx.fillText(
      `/map_feed | FURROW ${snap.currentFurrow}/${snap.totalFurrows} | HDG ${snap.headingDeg.toFixed(0)}° | WEEDS ${snap.weedsEliminated}/${snap.totalWeeds} | CLIPS ${snap.chlorosisClips.length}`,
      10,
      19
    );
  }, [snap, streamMode]);

  const handleToggleEStop = async () => {
    if (streamMode === 'LIVE_PI') {
      const base = piHost.replace(/\/+$/, '');
      try {
        await fetch(`${base}/stop`, { method: 'POST' });
      } catch {
        // ignore network failure
      }
      return;
    }
    if (snap.eStopped) {
      engineRef.current.clearEmergencyStop();
    } else {
      setRunning(false);
      engineRef.current.emergencyStop();
    }
    setSnap(engineRef.current.getSnapshot());
  };

  const handleReset = () => {
    setRunning(false);
    engineRef.current.configure(
      launchConfig ?? {
        analysis: null,
        startPoint: snap.startPoint,
        endPoint: snap.endPoint,
        relayMode: snap.relayMode,
        seed: 42,
      }
    );
    setSnap(engineRef.current.getSnapshot());
  };

  const handleRelaySwitch = (mode: RelayMode) => {
    engineRef.current.setRelayMode(mode);
    setSnap(engineRef.current.getSnapshot());
  };

  // Unified telemetry display (Live Pi JSON if connected in LIVE_PI mode, otherwise Simulator)
  const displayState =
    streamMode === 'LIVE_PI' ? liveCutPlan?.state ?? (piConnected ? 'IDLE' : 'OFFLINE') : snap.state;
  const displayDrive =
    streamMode === 'LIVE_PI'
      ? liveCutPlan?.esp32_drive_deg != null
        ? `${liveCutPlan.esp32_drive_deg}°`
        : 'STOP'
      : snap.esp32DriveLabel;
  const displayOffsetMm =
    streamMode === 'LIVE_PI' ? liveCutPlan?.lateral_offset_mm ?? 0 : snap.lateralOffsetMm;
  const displayWallMm =
    streamMode === 'LIVE_PI' ? liveCutPlan?.wall_distance_mm ?? 0 : snap.frontWallDistanceMm;
  const displayTurretDeg =
    streamMode === 'LIVE_PI' ? liveCutPlan?.turret_angle_deg ?? 0 : snap.turretAngleDeg;
  const displayRelay1 =
    streamMode === 'LIVE_PI' ? Boolean(liveCutPlan?.relay1_grinder) : snap.relay1Grinder;
  const displayRelay2 =
    streamMode === 'LIVE_PI' ? Boolean(liveCutPlan?.relay2_flame) : snap.relay2Flame;
  const displayWeedsCleared =
    streamMode === 'LIVE_PI' ? liveCutPlan?.weeds_eliminated ?? 0 : snap.weedsEliminated;

  const cleanPiBase = piHost.replace(/\/+$/, '');

  return (
    <div className="space-y-5">
      {/* Control & Stream Mode Header */}
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold tracking-tight text-slate-900">
              {isBn ? 'লাইভ রোভার ভিডিও ও টেলিমেট্রি স্ট্রিম' : 'Live Rover Stream & Telemetry'}
            </h1>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-slate-600 font-mono tabular-nums">
              <span>State: {displayState}</span>
              <span aria-hidden="true">·</span>
              <span>Furrow {snap.currentFurrow}/{snap.totalFurrows}</span>
              <span aria-hidden="true">·</span>
              <span>ESP32: {displayDrive}</span>
              <span aria-hidden="true">·</span>
              <span>Turret: {displayTurretDeg >= 0 ? '+' : ''}{displayTurretDeg.toFixed(1)}°</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Stream Source Toggle */}
            <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
              <button
                type="button"
                onClick={() => setStreamMode('SIMULATOR')}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition whitespace-nowrap ${
                  streamMode === 'SIMULATOR'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Pi Simulator
              </button>
              <button
                type="button"
                onClick={() => {
                  setRunning(false);
                  setStreamMode('LIVE_PI');
                }}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition whitespace-nowrap ${
                  streamMode === 'LIVE_PI'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Radio className="h-3.5 w-3.5" />
                Live Pi FastAPI
              </button>
            </div>

            {streamMode === 'SIMULATOR' && (
              <>
                <button
                  type="button"
                  disabled={snap.eStopped || snap.state === 'DONE'}
                  onClick={() => setRunning((r) => !r)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-3.5 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50 whitespace-nowrap"
                >
                  {running ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                  {running ? (isBn ? 'বিরতি' : 'Pause') : isBn ? 'চালান' : 'Run'}
                </button>
                <button
                  type="button"
                  disabled={snap.eStopped || snap.state === 'DONE'}
                  onClick={() => {
                    setRunning(false);
                    engineRef.current.tick();
                    setSnap(engineRef.current.getSnapshot());
                  }}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
                >
                  <StepForward className="h-3.5 w-3.5" />
                  Step
                </button>
                <button
                  type="button"
                  onClick={handleReset}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 whitespace-nowrap"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Reset
                </button>
              </>
            )}

            <button
              type="button"
              onClick={handleToggleEStop}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-bold text-white whitespace-nowrap ${
                snap.eStopped && streamMode === 'SIMULATOR'
                  ? 'bg-amber-600 hover:bg-amber-700'
                  : 'bg-red-600 hover:bg-red-700'
              }`}
            >
              {snap.eStopped && streamMode === 'SIMULATOR' ? (
                <ShieldCheck className="h-3.5 w-3.5" />
              ) : (
                <ShieldAlert className="h-3.5 w-3.5" />
              )}
              {snap.eStopped && streamMode === 'SIMULATOR' ? 'Reset E-Stop' : 'E-STOP'}
            </button>
          </div>
        </div>

        {/* Secondary Utility Row: Speed + Relay Mode (Simulator) OR Pi Host URL (Live Pi) */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-4 border-t border-slate-100 pt-3 text-xs">
          {streamMode === 'SIMULATOR' ? (
            <>
              <label className="flex items-center gap-2 font-medium text-slate-700">
                Tick Rate:
                <input
                  type="range"
                  min={50}
                  max={320}
                  step={15}
                  value={370 - speedMs}
                  onChange={(e) => setSpeedMs(370 - Number(e.target.value))}
                  className="accent-emerald-700"
                />
              </label>
              <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-0.5">
                {(
                  [
                    ['grinder', 'Relay 1: Grinder'],
                    ['flame', 'Relay 2: Thermal Flame'],
                    ['both', 'Dual Relay'],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => handleRelaySwitch(mode)}
                    className={`rounded-md px-2.5 py-1 text-xs font-semibold transition whitespace-nowrap ${
                      snap.relayMode === mode
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="flex w-full flex-wrap items-center gap-3">
              <span className="font-medium text-slate-700">Pi FastAPI URL:</span>
              <input
                type="text"
                value={piHost}
                onChange={(e) => onPiHostChange(e.target.value)}
                className="w-64 rounded-lg border border-slate-300 bg-slate-50 px-2.5 py-1.5 font-mono text-xs text-slate-900"
              />
              <span className={piConnected ? 'font-semibold text-emerald-700' : 'text-amber-700'}>
                {piConnected
                  ? '● Connected to Pi /video_feed, /map_feed, /cut_plan'
                  : `▲ ${piError ?? 'Run uvicorn Navigation.src.pi_server:app --host 0.0.0.0 --port 8000 on Pi'}`}
              </span>
            </div>
          )}
        </div>
      </section>

      {/* Primary Split Viewports: /video_feed (What the Rover Sees) + /map_feed (Live Field Map) */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 items-stretch">
        <section className="rounded-xl border border-slate-200 bg-white p-3.5 flex flex-col">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-semibold text-slate-900">
              Live Rover Vision (/video_feed)
            </h2>
            <span className="font-mono text-[11px] text-slate-500">
              MaixSense-A075V @ 30° · YOLOv8 best.pt · MG996R Turret
            </span>
          </div>
          {streamMode === 'SIMULATOR' ? (
            <canvas
              ref={videoCanvasRef}
              width={640}
              height={400}
              className="w-full rounded-lg bg-slate-950"
            />
          ) : (
            <div className="flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-lg bg-slate-950">
              <img
                src={`${cleanPiBase}/video_feed`}
                alt="Live Raspberry Pi rover camera feed"
                referrerPolicy="no-referrer"
                className="h-full w-full object-contain"
              />
            </div>
          )}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-3.5 flex flex-col">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-semibold text-slate-900">
              Live Field Map (/map_feed)
            </h2>
            <span className="font-mono text-[11px] text-slate-500">
              Auto-BEV · Serpentine Route · Rover Pose &amp; Weeds
            </span>
          </div>
          {streamMode === 'SIMULATOR' ? (
            <canvas
              ref={mapCanvasRef}
              width={640}
              height={400}
              className="w-full rounded-lg bg-slate-950"
            />
          ) : (
            <div className="flex aspect-[16/10] w-full items-center justify-center overflow-hidden rounded-lg bg-slate-950">
              <img
                src={`${cleanPiBase}/map_feed`}
                alt="Live Raspberry Pi BEV field map"
                referrerPolicy="no-referrer"
                className="h-full w-full object-contain"
              />
            </div>
          )}
        </section>
      </div>

      {/* 4-Column Hardware & Sensor Instrument Readouts (/cut_plan) */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">ESP32 8-Way Drive</div>
          <div className="mt-1 font-mono text-xl font-bold text-slate-900 tabular-nums">
            {displayDrive}
          </div>
          <div className="mt-2 truncate font-mono text-[11px] text-slate-500" title={snap.lastUartFrame}>
            UART: {snap.lastUartFrame}
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">MaixSense-A075V Depth (30°)</div>
          <div className="mt-1 flex items-baseline gap-2 font-mono tabular-nums">
            <span
              className={`text-xl font-bold ${
                Math.abs(displayOffsetMm) > 25 ? 'text-amber-600' : 'text-slate-900'
              }`}
            >
              {displayOffsetMm >= 0 ? '+' : ''}
              {displayOffsetMm.toFixed(1)}
            </span>
            <span className="text-xs text-slate-500">mm offset (±25mm)</span>
          </div>
          <div className="mt-2 font-mono text-[11px] text-slate-600 tabular-nums">
            Wall: {displayWallMm.toFixed(0)}mm (&lt;520 turn) · Ridges: {snap.leftWallHeightMm}/{snap.rightWallHeightMm}mm
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">MG996R Turret &amp; Dual Relay</div>
          <div className="mt-1 flex items-baseline gap-2 font-mono tabular-nums">
            <span className="text-xl font-bold text-slate-900">
              {displayTurretDeg >= 0 ? '+' : ''}
              {displayTurretDeg.toFixed(1)}°
            </span>
            <span className="text-xs text-slate-500">-35°..+35°</span>
          </div>
          <div className="mt-2 flex items-center gap-3 font-mono text-[11px]">
            <span className={displayRelay1 ? 'font-bold text-sky-700' : 'text-slate-400'}>
              R1 Grinder: {displayRelay1 ? 'ACTIVE' : 'OFF'}
            </span>
            <span aria-hidden="true">·</span>
            <span className={displayRelay2 ? 'font-bold text-orange-600' : 'text-slate-400'}>
              R2 Flame: {displayRelay2 ? 'ACTIVE' : 'OFF'}
            </span>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-xs font-medium text-slate-500">Weeding &amp; Surveillance</div>
          <div className="mt-1 flex items-baseline gap-2 font-mono tabular-nums">
            <span className="text-xl font-bold text-emerald-700">
              {displayWeedsCleared} / {snap.totalWeeds}
            </span>
            <span className="text-xs text-slate-500">weeds cut</span>
          </div>
          <div className="mt-2 font-mono text-[11px] text-slate-600 tabular-nums">
            U-Turns: {snap.uTurnsCompleted} · Dist: {snap.distanceTravelledM.toFixed(1)}m · 3s Clips: {snap.chlorosisClips.length}
          </div>
        </div>
      </div>

      {/* Bottom 2-Column Queues: 30mm Cut-Band Queue + Bad-Chili 3s MP4 Surveillance & Trace */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-xs font-semibold text-slate-900">
              30mm Forward Cut-Band Queue (/cut_plan — Min Turret Slew)
            </h3>
            <span className="font-mono text-xs text-slate-500 tabular-nums">
              {snap.cutQueue.length} in FOV
            </span>
          </div>
          {snap.cutQueue.length === 0 ? (
            <p className="py-4 text-xs text-slate-500">
              No weed stems currently inside 620mm camera lookahead — cruising furrow center.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left font-mono text-xs tabular-nums">
                <thead>
                  <tr className="border-b border-slate-200 text-[11px] text-slate-500">
                    <th className="pb-2 font-medium">Target</th>
                    <th className="pb-2 font-medium">30mm Band</th>
                    <th className="pb-2 font-medium">Stem (X, Y) mm</th>
                    <th className="pb-2 font-medium">Turret</th>
                    <th className="pb-2 font-medium">Conf</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {snap.cutQueue.slice(0, 6).map((item) => {
                    const isActive = snap.activeCutTarget?.weedId === item.weedId;
                    return (
                      <tr key={item.weedId} className={isActive ? 'bg-amber-50 font-semibold' : ''}>
                        <td className="py-1.5 text-slate-900">Weed #{item.weedId}</td>
                        <td className="py-1.5 text-slate-700">{item.bandMm}–{item.bandMm + 30}mm</td>
                        <td className="py-1.5 text-slate-700">
                          ({item.xGroundMm >= 0 ? '+' : ''}{item.xGroundMm.toFixed(0)}, {item.yFwdMm.toFixed(0)})
                        </td>
                        <td className="py-1.5 text-slate-900">
                          {item.turretAngleDeg >= 0 ? '+' : ''}{item.turretAngleDeg.toFixed(1)}°
                        </td>
                        <td className="py-1.5 text-emerald-700">{Math.round(item.confidence * 100)}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-4">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-900">
                <Film className="h-3.5 w-3.5 text-amber-600" />
                Passive Bad-Chili Chlorosis Surveillance (Auto 3s MP4)
              </h3>
              <span className="font-mono text-xs text-slate-500 tabular-nums">
                {snap.chlorosisClips.length} saved
              </span>
            </div>
            {snap.chlorosisClips.length === 0 ? (
              <p className="text-xs text-slate-500">
                Monitoring flanking chili canopy walls for yellowing/chlorosis lesions...
              </p>
            ) : (
              <div className="space-y-1.5 font-mono text-xs tabular-nums">
                {snap.chlorosisClips.slice(0, 4).map((clip) => (
                  <div
                    key={clip.clipId}
                    className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-1 text-slate-700"
                  >
                    <span className="font-semibold text-amber-800">{clip.filename}</span>
                    <span>
                      Furrow {clip.furrowIndex} · {clip.side} · {Math.round(clip.severity * 100)}% · {clip.durationS.toFixed(1)}s
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-slate-100 pt-3">
            <h3 className="mb-2 text-xs font-semibold text-slate-900">
              Onboard Pi 5 Pipeline Trace
            </h3>
            <div className="max-h-32 space-y-1 overflow-y-auto font-mono text-[11px] text-slate-600">
              {snap.logs.slice(0, 12).map((entry, idx) => (
                <div key={`${entry.tick}-${idx}`} className="flex gap-2">
                  <span className="shrink-0 text-slate-400">#{entry.tick}</span>
                  <span className="shrink-0 font-semibold text-slate-900">{entry.state}</span>
                  <span>{entry.text}</span>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};
