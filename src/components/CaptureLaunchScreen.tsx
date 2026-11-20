import React, { useEffect, useRef, useState } from 'react';
import { Camera, Upload, Image as ImageIcon, Play, RotateCcw, Crosshair } from 'lucide-react';
import { AppLanguage } from '../i18n/strings';
import {
  AutoFieldAnalysis,
  FurrowWaypoint,
  NormalizedPoint,
  buildTwoPointSerpentineRoute,
  runAutomaticFieldPipeline,
} from '../domain/autoFieldPipeline';
import { LaunchMissionConfig, RelayMode } from '../domain/roverLiveEngine';

interface Props {
  lang: AppLanguage;
  piHost: string;
  onPiHostChange: (host: string) => void;
  onLaunchRover: (config: LaunchMissionConfig) => void;
}

type PointSelectionMode = 'START' | 'END';

function fitRect(containerW: number, containerH: number, imgW: number, imgH: number) {
  const aspect = imgW / imgH;
  let drawW = containerW;
  let drawH = containerH;
  if (drawW / drawH > aspect) drawW = drawH * aspect;
  else drawH = drawW / aspect;
  return {
    drawW,
    drawH,
    dx: (containerW - drawW) / 2,
    dy: (containerH - drawH) / 2,
  };
}

export const CaptureLaunchScreen: React.FC<Props> = ({
  lang,
  piHost,
  onPiHostChange,
  onLaunchRover,
}) => {
  const isBn = lang === 'BN';

  const [imageUrl, setImageUrl] = useState<string>('/media/field_render.png');
  const [sourceImage, setSourceImage] = useState<HTMLImageElement | null>(null);
  const [analysis, setAnalysis] = useState<AutoFieldAnalysis | null>(null);
  const [bevImg, setBevImg] = useState<HTMLImageElement | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [pointMode, setPointMode] = useState<PointSelectionMode>('START');
  const [startPoint, setStartPoint] = useState<NormalizedPoint>({ nx: 0.2, ny: 0.9 });
  const [endPoint, setEndPoint] = useState<NormalizedPoint | null>({ nx: 0.8, ny: 0.1 });
  const [relayMode, setRelayMode] = useState<RelayMode>('grinder');
  const [sendStatus, setSendStatus] = useState<string | null>(null);

  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const bevCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);

  // Step 1 & 2: Whenever a new field photo is snapped/selected, run automatic ExG + minAreaRect BEV + Furrow segmentation immediately (ZERO manual corners!)
  useEffect(() => {
    let cancelled = false;
    setIsAnalyzing(true);
    setErrorMsg(null);
    setSendStatus(null);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (cancelled) return;
      setSourceImage(img);
      try {
        const result = runAutomaticFieldPipeline(img, 640, 440);
        if (cancelled) return;
        setAnalysis(result);

        // Place default Start at Furrow 1 entrance (bottom) & End at last furrow exit (top)
        const firstFurrow = result.furrowsNx[0] ?? 0.2;
        const lastFurrow = result.furrowsNx[result.furrowsNx.length - 1] ?? 0.8;
        setStartPoint({ nx: firstFurrow, ny: 0.89 });
        setEndPoint({ nx: lastFurrow, ny: 0.11 });

        const warped = new Image();
        warped.onload = () => {
          if (!cancelled) setBevImg(warped);
        };
        warped.src = result.bevDataUrl;
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : 'Failed to auto-detect field boundary');
        }
      } finally {
        if (!cancelled) setIsAnalyzing(false);
      }
    };
    img.onerror = () => {
      if (!cancelled) {
        setIsAnalyzing(false);
        setErrorMsg('Could not load selected field image.');
      }
    };
    img.src = imageUrl;

    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  const routeWaypoints: FurrowWaypoint[] = analysis
    ? buildTwoPointSerpentineRoute(analysis.furrowsNx, startPoint, endPoint)
    : [];

  // Draw Step 1 Source Photo with Auto-Detected ExG + minAreaRect Boundary (Read-Only)
  useEffect(() => {
    const canvas = sourceCanvasRef.current;
    if (!canvas || !sourceImage || !analysis) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = '#0F172A';
    ctx.fillRect(0, 0, w, h);

    const { drawW, drawH, dx, dy } = fitRect(w, h, sourceImage.naturalWidth, sourceImage.naturalHeight);
    ctx.drawImage(sourceImage, dx, dy, drawW, drawH);

    const c = analysis.detectedCorners;
    const pts = [c.topLeft, c.topRight, c.bottomRight, c.bottomLeft].map((p) => ({
      x: (p.x / sourceImage.naturalWidth) * drawW + dx,
      y: (p.y / sourceImage.naturalHeight) * drawH + dy,
    }));

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    pts.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.closePath();
    ctx.fillStyle = 'rgba(6, 182, 212, 0.12)';
    ctx.fill();
    ctx.strokeStyle = '#06B6D4';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    pts.forEach((p) => {
      ctx.fillStyle = '#06B6D4';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
    });

    // Subtle label overlay
    ctx.fillStyle = 'rgba(15, 23, 42, 0.8)';
    ctx.fillRect(8, 8, 250, 24);
    ctx.fillStyle = '#E2E8F0';
    ctx.font = '600 11px "IBM Plex Mono", monospace';
    ctx.fillText('AUTO ExG + minAreaRect BOUNDARY', 14, 24);
  }, [sourceImage, analysis]);

  // Draw Step 2 & 3 Interactive Auto-Warped BEV Map (Crop Ridges vs Furrows + 2-Point Start/End Route)
  useEffect(() => {
    const canvas = bevCanvasRef.current;
    if (!canvas || !analysis || !bevImg) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = '#0B1117';
    ctx.fillRect(0, 0, w, h);

    ctx.drawImage(bevImg, 0, 0, w, h);

    // Subtle contrast scrim so segmented furrows & serpentine route read crisply
    ctx.fillStyle = 'rgba(11, 17, 23, 0.28)';
    ctx.fillRect(0, 0, w, h);

    // Crop Ridges (green elevation bands)
    analysis.ridgesNx.forEach((rx, idx) => {
      const x = rx * w;
      ctx.fillStyle = 'rgba(34, 197, 94, 0.16)';
      ctx.fillRect(x - 12, 0, 24, h);
      ctx.fillStyle = 'rgba(187, 247, 208, 0.85)';
      ctx.font = '600 10px "IBM Plex Mono", monospace';
      ctx.fillText(`R${idx + 1}`, x - 7, 16);
    });

    // Traversable Furrows (dashed amber soil corridors)
    analysis.furrowsNx.forEach((fx, idx) => {
      const x = fx * w;
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(x, 22);
      ctx.lineTo(x, h - 18);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = 'rgba(253, 230, 138, 0.9)';
      ctx.font = '600 10px "IBM Plex Mono", monospace';
      ctx.fillText(`F${idx + 1}`, x - 7, h - 6);
    });

    // Generated Boustrophedon Serpentine Route from Start -> End
    if (routeWaypoints.length > 1) {
      for (let i = 0; i < routeWaypoints.length - 1; i++) {
        const a = routeWaypoints[i];
        const b = routeWaypoints[i + 1];
        const isUTurn = Math.abs(b.nx - a.nx) > Math.abs(b.ny - a.ny);
        ctx.strokeStyle = isUTurn ? '#F59E0B' : '#06B6D4';
        ctx.lineWidth = isUTurn ? 2.5 : 3.2;
        ctx.beginPath();
        ctx.moveTo(a.nx * w, a.ny * h);
        ctx.lineTo(b.nx * w, b.ny * h);
        ctx.stroke();

        // Direction chevron midpoint on furrow runs
        if (!isUTurn) {
          const mx = ((a.nx + b.nx) / 2) * w;
          const my = ((a.ny + b.ny) / 2) * h;
          const dir = b.ny < a.ny ? -1 : 1;
          ctx.fillStyle = '#06B6D4';
          ctx.beginPath();
          ctx.moveTo(mx, my + dir * 7);
          ctx.lineTo(mx - 5, my - dir * 5);
          ctx.lineTo(mx + 5, my - dir * 5);
          ctx.closePath();
          ctx.fill();
        }
      }
    }

    // Draw [Start] Pin (green)
    const sx = startPoint.nx * w;
    const sy = startPoint.ny * h;
    ctx.beginPath();
    ctx.arc(sx, sy, 13, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(22, 163, 74, 0.95)';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#FFFFFF';
    ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '700 11px "IBM Plex Sans", sans-serif';
    ctx.fillText('S', sx - 3.5, sy + 4);

    // Draw [End] Pin (red)
    if (endPoint) {
      const ex = endPoint.nx * w;
      const ey = endPoint.ny * h;
      ctx.beginPath();
      ctx.arc(ex, ey, 13, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(220, 38, 38, 0.95)';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#FFFFFF';
      ctx.stroke();
      ctx.fillStyle = '#FFFFFF';
      ctx.font = '700 11px "IBM Plex Sans", sans-serif';
      ctx.fillText('E', ex - 3.5, ey + 4);
    }
  }, [analysis, bevImg, startPoint, endPoint, routeWaypoints]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setImageUrl(reader.result);
    };
    reader.readAsDataURL(file);
  };

  const handleBevClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = bevCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const nx = Math.max(0.04, Math.min(0.96, (e.clientX - rect.left) / rect.width));
    const ny = Math.max(0.06, Math.min(0.94, (e.clientY - rect.top) / rect.height));

    if (pointMode === 'START') {
      setStartPoint({ nx, ny });
      setPointMode('END');
    } else {
      setEndPoint({ nx, ny });
      setPointMode('START');
    }
  };

  const handleSendAndStart = () => {
    if (!analysis) return;
    setSendStatus(
      `Dispatched photo + Start(${(startPoint.nx * 100).toFixed(0)}%, ${(startPoint.ny * 100).toFixed(0)}%) to Pi — opening live rover stream...`
    );
    onLaunchRover({
      analysis,
      startPoint,
      endPoint,
      relayMode,
      seed: 42,
    });
  };

  const coveredFurrows = new Set(routeWaypoints.map((w) => w.furrowIndex)).size;

  return (
    <div className="space-y-6">
      {/* Compact Page Heading */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900">
            {isBn
              ? '১ ছবি তুলুন, শুরু ও শেষ বিন্দু ট্যাপ করুন — Pi রোভার নিজেই পথ খুঁজে নেবে'
              : 'Snap 1 Field Photo & Tap Start / End — Zero Manual Corners'}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {isBn
              ? 'Pi স্বয়ংক্রিয়ভাবে ExG + minAreaRect দিয়ে জমির সীমানা ও ফসল-সারি আলাদা করে এবং লাইভ ভিডিও স্ট্রিম চালু করে।'
              : 'Pi automatically runs ExG + minAreaRect boundary detection, auto-warps to 2D Top-Down BEV, segments crop ridges vs. furrows, and streams live rover vision.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFileChange}
            className="hidden"
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => cameraInputRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            <Camera className="h-3.5 w-3.5" />
            {isBn ? 'ছবি তুলুন' : 'Snap Field Photo'}
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <Upload className="h-3.5 w-3.5" />
            {isBn ? 'ফটো আপলোড' : 'Upload Photo'}
          </button>
          <button
            type="button"
            onClick={() => setImageUrl('/media/field_render.png')}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-600 transition hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <ImageIcon className="h-3.5 w-3.5" />
            {isBn ? 'নমুনা জমি' : 'Sample Field'}
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {errorMsg}
        </div>
      )}

      {/* Main 2-Column Split: Left = Auto Boundary & Launch Controls, Right = Interactive 2-Point BEV Map */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
        {/* Left Column: Step 1 Auto Boundary Preview + Hardware Launch Config */}
        <div className="space-y-5 lg:col-span-5">
          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="mb-2.5 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">
                {isBn ? '১. স্বয়ংক্রিয় সীমানা শনাক্তকরণ' : '1. Automatic Field Boundary'}
              </h2>
              <span className="font-mono text-xs text-slate-500 tabular-nums">
                {isAnalyzing
                  ? 'Analyzing...'
                  : analysis
                  ? `${analysis.ridgesNx.length} ridges · ${analysis.furrowsNx.length} furrows`
                  : 'Waiting'}
              </span>
            </div>

            <canvas
              ref={sourceCanvasRef}
              width={520}
              height={310}
              className="w-full rounded-lg bg-slate-950"
            />

            <p className="mt-2.5 text-xs text-slate-600">
              {isBn
                ? 'কোনো কোণা টানতে হবে না — ExG + minAreaRect স্বয়ংক্রিয়ভাবে জমির ৪ কোণা খুঁজে ২ডি ম্যাপ তৈরি করেছে।'
                : 'Zero manual corner dragging — Excess Green (ExG) + minimum-area bounding box automatically locates the field boundary and computes the top-down homography.'}
            </p>
          </section>

          {/* Pi Connection + Dual Relay Board Mode + Primary Launch CTA */}
          <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                {isBn ? '৩. Pi 4/5 ও ESP32 লঞ্চ কনফিগারেশন' : '3. Pi 4/5 Hotspot & Actuator Relay'}
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                HTTP POST /image &amp; /start_mission → UART /dev/ttyUSB0 @ 115200
              </p>
            </div>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-700">
                Raspberry Pi FastAPI Host
              </span>
              <input
                type="text"
                value={piHost}
                onChange={(e) => onPiHostChange(e.target.value)}
                placeholder="http://192.168.4.1:8000"
                className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-900 focus:border-emerald-700 focus:bg-white focus:outline-none"
              />
            </label>

            <div>
              <span className="mb-1.5 block text-xs font-medium text-slate-700">
                ESP32 Dual Relay Board Mode
              </span>
              <div className="grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1">
                {(
                  [
                    ['grinder', 'R1: Grinder'],
                    ['flame', 'R2: Flame'],
                    ['both', 'Dual Relay'],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setRelayMode(mode)}
                    className={`rounded-md px-2.5 py-1.5 text-xs font-semibold transition whitespace-nowrap ${
                      relayMode === mode
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              disabled={!analysis || isAnalyzing}
              onClick={handleSendAndStart}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-700 px-4 py-3 text-sm font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Play className="h-4 w-4" />
              {isBn
                ? 'ছবি ও স্টার্ট পয়েন্ট Pi-তে পাঠান এবং লাইভ দেখুন'
                : 'Send Photo & Start Rover (Open Live Feed)'}
            </button>

            {sendStatus && <p className="text-xs font-medium text-emerald-700">{sendStatus}</p>}
          </section>
        </div>

        {/* Right Column (Focal Anchor): Step 2 Tap Only [Start] & [End] on Auto-Warped BEV Map */}
        <section className="rounded-xl border border-slate-200 bg-white p-4 lg:col-span-7">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                {isBn
                  ? '২. অটো-BEV ম্যাপে শুধু [Start] এবং [End] ট্যাপ করুন'
                  : '2. Tap Only 2 Points on Auto-BEV Map: Start & End'}
              </h2>
              <p className="text-xs text-slate-500">
                {isBn
                  ? 'রোবট যেখানে রাখা আছে সেখানে Start (S) ট্যাপ করুন — Pi স্বয়ংক্রিয়ভাবে সর্পিল (Boustrophedon) পথ তৈরি করবে।'
                  : 'Click where the rover is positioned (Start) and where it should finish (End).'}
              </p>
            </div>

            <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1">
              <button
                type="button"
                onClick={() => setPointMode('START')}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition whitespace-nowrap ${
                  pointMode === 'START'
                    ? 'bg-emerald-700 text-white'
                    : 'text-slate-700 hover:bg-white/70'
                }`}
              >
                <Crosshair className="h-3.5 w-3.5" />
                Set Start (S)
              </button>
              <button
                type="button"
                onClick={() => setPointMode('END')}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition whitespace-nowrap ${
                  pointMode === 'END'
                    ? 'bg-red-600 text-white'
                    : 'text-slate-700 hover:bg-white/70'
                }`}
              >
                <Crosshair className="h-3.5 w-3.5" />
                Set End (E)
              </button>
              <button
                type="button"
                onClick={() => {
                  const first = analysis?.furrowsNx[0] ?? 0.2;
                  const last = analysis?.furrowsNx[analysis.furrowsNx.length - 1] ?? 0.8;
                  setStartPoint({ nx: first, ny: 0.89 });
                  setEndPoint({ nx: last, ny: 0.11 });
                  setPointMode('START');
                }}
                title="Reset Start & End"
                className="rounded-md p-1.5 text-slate-600 hover:bg-white hover:text-slate-900"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <canvas
            ref={bevCanvasRef}
            width={640}
            height={440}
            onClick={handleBevClick}
            className="w-full cursor-crosshair rounded-lg bg-slate-950"
          />

          {/* Clean Unboxed Telemetry & Map Legend Strip */}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 text-xs text-slate-600">
            <div className="flex flex-wrap items-center gap-3 font-mono tabular-nums">
              <span>
                Start:{' '}
                <strong className="text-emerald-700">
                  ({(startPoint.nx * 100).toFixed(0)}%, {(startPoint.ny * 100).toFixed(0)}%)
                </strong>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                End:{' '}
                <strong className="text-red-700">
                  {endPoint
                    ? `(${(endPoint.nx * 100).toFixed(0)}%, ${(endPoint.ny * 100).toFixed(0)}%)`
                    : 'Auto'}
                </strong>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                Planned Route:{' '}
                <strong className="text-slate-900">
                  {coveredFurrows} furrows / {routeWaypoints.length} waypoints
                </strong>
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
              <span>Green: Crop Ridges</span>
              <span aria-hidden="true">/</span>
              <span>Amber: Furrows &amp; U-Turns</span>
              <span aria-hidden="true">/</span>
              <span>Cyan: Serpentine Route</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};
