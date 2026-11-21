import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  CameraOff,
  Upload,
  RefreshCw,
  Activity,
  Crosshair,
  SlidersHorizontal,
  CornerDownRight,
  CornerDownLeft,
  Route,
} from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import {
  CameraOverlayMode,
  FoliageBlob,
  detectCropRowFromFrame,
  detectFoliageBlobsFromFrame,
} from '../vision/cropRowVision';
import {
  ProjectedTurnDirection,
  drawTurnTrajectoryOverlay,
} from '../vision/turnTrajectoryOverlay';

interface Props {
  mode: 'vision' | 'calibration';
  estopActive: boolean;
  onLogEvent: (msg: string) => void;
}

const PROC_W = 480;
const PROC_H = 270;

export const WeedVisionView: React.FC<Props> = ({ mode, estopActive, onLogEvent }) => {
  const [sourceState, setSourceState] = useState<'idle' | 'requesting' | 'webcam' | 'media' | 'error'>('idle');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [overlayMode, setOverlayMode] = useState<CameraOverlayMode>('overlay');
  const [minExgFloor, setMinExgFloor] = useState<number>(24);
  const [minBlobArea, setMinBlobArea] = useState<number>(50);
  const [sourceName, setSourceName] = useState<string>('No camera active');

  // Row-end turn trajectory overlay controls
  const [showTurnOverlay, setShowTurnOverlay] = useState<boolean>(true);
  const [turnDirection, setTurnDirection] = useState<ProjectedTurnDirection>('right');
  const [turnRadiusM, setTurnRadiusM] = useState<number>(0.55);
  const [rowSpacingM, setRowSpacingM] = useState<number>(0.6);
  const [forceTurnPreview, setForceTurnPreview] = useState<boolean>(false);

  const [blobs, setBlobs] = useState<FoliageBlob[]>([]);
  const [metrics, setMetrics] = useState({
    fps: 0,
    processingMs: 0,
    otsuThreshold: 24,
    greenCoveragePct: 0,
    distanceToFurrowEndM: 1.6,
    rowEndConfidence: 0,
    arcLengthM: 2.48,
    turnImminent: false,
  });

  const [latencyHistory, setLatencyHistory] = useState<
    Array<{ time: string; cvMs: number; blobs: number }>
  >(() =>
    Array.from({ length: 20 }, (_, i) => ({
      time: `-${(20 - i) * 1}s`,
      cvMs: 0,
      blobs: 0,
    }))
  );

  const [testU, setTestU] = useState<number>(640);
  const [testV, setTestV] = useState<number>(360);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const workCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const paramsRef = useRef({
    overlayMode,
    minExgFloor,
    minBlobArea,
    showTurnOverlay,
    turnDirection,
    turnRadiusM,
    rowSpacingM,
    forceTurnPreview,
  });
  useEffect(() => {
    paramsRef.current = {
      overlayMode,
      minExgFloor,
      minBlobArea,
      showTurnOverlay,
      turnDirection,
      turnRadiusM,
      rowSpacingM,
      forceTurnPreview,
    };
  }, [
    overlayMode,
    minExgFloor,
    minBlobArea,
    showTurnOverlay,
    turnDirection,
    turnRadiusM,
    rowSpacingM,
    forceTurnPreview,
  ]);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
      videoRef.current.removeAttribute('src');
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    imageRef.current = null;
  }, []);

  const startWebcam = useCallback(
    async (nextFacing?: 'environment' | 'user') => {
      stopStream();
      setCameraError(null);
      setSourceState('requesting');

      if (!navigator.mediaDevices?.getUserMedia) {
        setSourceState('error');
        setCameraError('Browser camera API (getUserMedia) unavailable. Upload a real image or video instead.');
        return;
      }

      const targetFacing = nextFacing ?? facingMode;
      try {
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: targetFacing },
              width: { ideal: 640 },
              height: { ideal: 360 },
            },
            audio: false,
          });
        } catch (constraintErr: unknown) {
          const errName = (constraintErr as { name?: string })?.name;
          if (errName === 'OverconstrainedError' || errName === 'ConstraintNotSatisfiedError') {
            stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          } else {
            throw constraintErr;
          }
        }
        streamRef.current = stream;

        if (!videoRef.current) {
          const vid = document.createElement('video');
          vid.playsInline = true;
          vid.muted = true;
          vid.autoplay = true;
          videoRef.current = vid;
        }
        const vid = videoRef.current;
        vid.srcObject = stream;
        await vid.play();

        const label = stream.getVideoTracks()[0]?.label || 'Live Webcam';
        setSourceName(label);
        setSourceState('webcam');
        onLogEvent(
          `[Weed Vision] Live webcam started (${label}) — ExG+Otsu CV & animated row-end turn trajectory overlay active.`
        );
      } catch (err: any) {
        const msg =
          err?.name === 'NotAllowedError'
            ? 'Camera permission denied. Allow camera access or upload a real photo/video.'
            : err?.name === 'NotFoundError'
            ? 'No camera hardware found. Upload a real photo or video to run CV.'
            : `Camera error: ${err?.message || 'Unable to access stream'}`;
        setCameraError(msg);
        setSourceState('error');
        onLogEvent(`[Weed Vision] ${msg}`);
      }
    },
    [facingMode, stopStream, onLogEvent]
  );

  const handleStopCamera = useCallback(() => {
    stopStream();
    setSourceState('idle');
    setSourceName('No camera active');
    setBlobs([]);
    setMetrics({
      fps: 0,
      processingMs: 0,
      otsuThreshold: minExgFloor,
      greenCoveragePct: 0,
      distanceToFurrowEndM: 1.6,
      rowEndConfidence: 0,
      arcLengthM: 2.48,
      turnImminent: false,
    });
    onLogEvent('[Weed Vision] Stopped live camera feed.');
  }, [stopStream, minExgFloor, onLogEvent]);

  const handleLoadFile = useCallback(
    (file: File) => {
      stopStream();
      setCameraError(null);
      const url = URL.createObjectURL(file);
      objectUrlRef.current = url;

      if (file.type.startsWith('video/')) {
        setSourceState('requesting');
        if (!videoRef.current) {
          const vid = document.createElement('video');
          vid.playsInline = true;
          vid.muted = true;
          vid.loop = true;
          videoRef.current = vid;
        }
        const vid = videoRef.current;
        vid.loop = true;
        vid.muted = true;
        vid.src = url;
        vid
          .play()
          .then(() => {
            setSourceName(file.name);
            setSourceState('media');
            onLogEvent(`[Weed Vision] Running real-time ExG blob segmentation on video: ${file.name}`);
          })
          .catch((e) => {
            setSourceState('error');
            setCameraError(`Could not play video: ${e?.message || 'unsupported format'}`);
          });
      } else if (file.type.startsWith('image/')) {
        setSourceState('requesting');
        const img = new Image();
        img.onload = () => {
          imageRef.current = img;
          setSourceName(file.name);
          setSourceState('media');
          onLogEvent(`[Weed Vision] Running ExG blob segmentation on image: ${file.name}`);
        };
        img.onerror = () => {
          setSourceState('error');
          setCameraError('Could not decode uploaded image.');
        };
        img.src = url;
      } else {
        setSourceState('error');
        setCameraError('Unsupported file type. Select a video or image.');
      }
    },
    [stopStream, onLogEvent]
  );

  useEffect(() => {
    return () => stopStream();
  }, [stopStream]);

  // Real-time pixel CV loop
  useEffect(() => {
    if (mode !== 'vision' || (sourceState !== 'webcam' && sourceState !== 'media')) return;

    if (!workCanvasRef.current) {
      const c = document.createElement('canvas');
      c.width = PROC_W;
      c.height = PROC_H;
      workCanvasRef.current = c;
    }

    let rafId = 0;
    let frameCount = 0;
    let fpsStart = performance.now();
    let currentFps = 0;
    let lastUiSync = 0;
    let lastChartSync = 0;

    // Smooth EMA tracker for row centerline & furrow-end horizon to keep path projection fluid
    const smoothGeo = {
      initialized: false,
      centerBottomPx: PROC_W * 0.5,
      centerTopPx: PROC_W * 0.5,
      furrowEndYPx: PROC_H * 0.46,
      distanceToFurrowEndM: 1.4,
      rowEndConfidence: 0,
    };

    const tick = (now: number) => {
      const displayCanvas = canvasRef.current;
      const workCanvas = workCanvasRef.current;
      if (!displayCanvas || !workCanvas) {
        rafId = requestAnimationFrame(tick);
        return;
      }

      const workCtx = workCanvas.getContext('2d', { willReadFrequently: true });
      const dispCtx = displayCanvas.getContext('2d');
      if (!workCtx || !dispCtx) {
        rafId = requestAnimationFrame(tick);
        return;
      }

      let hasFrame = false;
      const vid = videoRef.current;
      const img = imageRef.current;

      if (vid && vid.readyState >= 2 && vid.videoWidth > 0) {
        workCtx.drawImage(vid, 0, 0, PROC_W, PROC_H);
        hasFrame = true;
      } else if (img && img.complete && img.naturalWidth > 0) {
        workCtx.drawImage(img, 0, 0, PROC_W, PROC_H);
        hasFrame = true;
      }

      if (hasFrame) {
        const p = paramsRef.current;
        const frame = workCtx.getImageData(0, 0, PROC_W, PROC_H);
        const res = detectFoliageBlobsFromFrame(frame, p.minExgFloor, p.minBlobArea);
        const { observation: rowObs } = detectCropRowFromFrame(frame, {
          rowWidthM: p.rowSpacingM,
          minExgFloor: p.minExgFloor,
        });

        const alpha = 0.25;
        if (!smoothGeo.initialized) {
          smoothGeo.centerBottomPx = rowObs.valid ? rowObs.centerBottomPx : PROC_W * 0.5;
          smoothGeo.centerTopPx = rowObs.valid ? rowObs.centerTopPx : PROC_W * 0.5;
          smoothGeo.furrowEndYPx = rowObs.furrowEndYPx;
          smoothGeo.distanceToFurrowEndM = rowObs.distanceToFurrowEndM;
          smoothGeo.rowEndConfidence = rowObs.rowEndConfidence;
          smoothGeo.initialized = true;
        } else {
          if (rowObs.valid) {
            smoothGeo.centerBottomPx =
              (1 - alpha) * smoothGeo.centerBottomPx + alpha * rowObs.centerBottomPx;
            smoothGeo.centerTopPx =
              (1 - alpha) * smoothGeo.centerTopPx + alpha * rowObs.centerTopPx;
          }
          smoothGeo.furrowEndYPx =
            (1 - alpha) * smoothGeo.furrowEndYPx + alpha * rowObs.furrowEndYPx;
          smoothGeo.distanceToFurrowEndM =
            (1 - alpha) * smoothGeo.distanceToFurrowEndM + alpha * rowObs.distanceToFurrowEndM;
          smoothGeo.rowEndConfidence =
            (1 - alpha) * smoothGeo.rowEndConfidence + alpha * rowObs.rowEndConfidence;
        }

        frameCount++;
        const dtFps = now - fpsStart;
        if (dtFps >= 500) {
          currentFps = (frameCount * 1000) / dtFps;
          frameCount = 0;
          fpsStart = now;
        }

        if (displayCanvas.width !== PROC_W || displayCanvas.height !== PROC_H) {
          displayCanvas.width = PROC_W;
          displayCanvas.height = PROC_H;
        }

        // Draw frame / mask
        if (p.overlayMode === 'mask') {
          const out = dispCtx.createImageData(PROC_W, PROC_H);
          const dst = out.data;
          for (let i = 0; i < PROC_W * PROC_H; i++) {
            const o = i * 4;
            if (res.mask[i]) {
              dst[o] = 16;
              dst[o + 1] = 215;
              dst[o + 2] = 125;
              dst[o + 3] = 255;
            } else {
              dst[o] = 15;
              dst[o + 1] = 23;
              dst[o + 2] = 20;
              dst[o + 3] = 255;
            }
          }
          dispCtx.putImageData(out, 0, 0);
        } else if (p.overlayMode === 'overlay') {
          const out = dispCtx.createImageData(PROC_W, PROC_H);
          const dst = out.data;
          dst.set(frame.data);
          for (let i = 0; i < PROC_W * PROC_H; i++) {
            if (res.mask[i]) {
              const o = i * 4;
              dst[o] = Math.min(255, Math.round(frame.data[o] * 0.62 + 8));
              dst[o + 1] = Math.min(255, Math.round(frame.data[o + 1] * 0.65 + 88));
              dst[o + 2] = Math.min(255, Math.round(frame.data[o + 2] * 0.62 + 40));
            }
          }
          dispCtx.putImageData(out, 0, 0);
        } else {
          dispCtx.putImageData(frame, 0, 0);
        }

        let arcLengthM = Number((Math.PI * p.turnRadiusM + 0.75).toFixed(2));
        let turnImminent = p.forceTurnPreview;

        // Draw animated predicted row-end turn trajectory path projection over real-time camera feed
        if (p.showTurnOverlay && p.overlayMode !== 'raw') {
          const proj = drawTurnTrajectoryOverlay(dispCtx, {
            width: PROC_W,
            height: PROC_H,
            nowMs: now,
            turnDirection: p.turnDirection,
            turnRadiusM: p.turnRadiusM,
            rowSpacingM: p.rowSpacingM,
            centerBottomPx: smoothGeo.centerBottomPx,
            centerTopPx: smoothGeo.centerTopPx,
            furrowEndYPx: smoothGeo.furrowEndYPx,
            distanceToFurrowEndM: smoothGeo.distanceToFurrowEndM,
            rowEndConfidence: smoothGeo.rowEndConfidence,
            hasVisionLock: rowObs.valid,
            forceTurnAlertStyle: p.forceTurnPreview,
          });
          arcLengthM = proj.arcLengthM;
          turnImminent = proj.turnImminent;
        }

        // Draw real detected connected-component bounding boxes & ground projections
        if (p.overlayMode !== 'raw') {
          for (const b of res.blobs) {
            const bx = b.x * PROC_W;
            const by = b.y * PROC_H;
            const bw = b.width * PROC_W;
            const bh = b.height * PROC_H;
            const isWeed = b.classification === 'weed_candidate';

            dispCtx.strokeStyle = isWeed ? '#F43F5E' : '#10B981';
            dispCtx.lineWidth = 1.75;
            dispCtx.strokeRect(bx, by, bw, bh);

            // Centroid crosshair
            const cx = b.centerX * PROC_W;
            const cy = b.centerY * PROC_H;
            dispCtx.beginPath();
            dispCtx.moveTo(cx - 4, cy);
            dispCtx.lineTo(cx + 4, cy);
            dispCtx.moveTo(cx, cy - 4);
            dispCtx.lineTo(cx, cy + 4);
            dispCtx.stroke();

            // Label pill
            const tag = `#${b.id} ${isWeed ? 'WEED?' : 'CROP'} ${(b.confidence * 100).toFixed(0)}%`;
            dispCtx.font = '600 10px "IBM Plex Mono", monospace';
            const tw = dispCtx.measureText(tag).width + 8;
            const ly = Math.max(14, by);
            dispCtx.fillStyle = isWeed ? 'rgba(225, 29, 72, 0.88)' : 'rgba(5, 150, 105, 0.88)';
            dispCtx.fillRect(bx, ly - 14, tw, 14);
            dispCtx.fillStyle = '#FFFFFF';
            dispCtx.fillText(tag, bx + 4, ly - 3);
          }

          // Top status bar
          dispCtx.fillStyle = 'rgba(15, 23, 42, 0.76)';
          dispCtx.fillRect(8, 8, PROC_W - 16, 20);
          dispCtx.fillStyle = '#A7F3D0';
          dispCtx.font = '600 10px "IBM Plex Mono", monospace';
          dispCtx.fillText(
            `LIVE ExG CV + TURN PATH AR · ${currentFps.toFixed(0)} FPS · ${(
              res.processingMs + rowObs.processingMs
            ).toFixed(1)} ms · ${res.blobs.length} BLOBS`,
            14,
            21
          );
        }

        if (now - lastUiSync > 120) {
          lastUiSync = now;
          setBlobs(res.blobs);
          setMetrics({
            fps: currentFps,
            processingMs: res.processingMs + rowObs.processingMs,
            otsuThreshold: res.otsuThreshold,
            greenCoveragePct: res.greenCoveragePct,
            distanceToFurrowEndM: smoothGeo.distanceToFurrowEndM,
            rowEndConfidence: smoothGeo.rowEndConfidence,
            arcLengthM,
            turnImminent,
          });
        }

        if (now - lastChartSync > 900) {
          lastChartSync = now;
          setLatencyHistory((prev) => {
            const next = [
              ...prev.slice(1),
              {
                time: 'Now',
                cvMs: Number((res.processingMs + rowObs.processingMs).toFixed(1)),
                blobs: res.blobs.length,
              },
            ];
            return next.map((row, idx) => ({
              ...row,
              time: idx === next.length - 1 ? 'Now' : `-${next.length - 1 - idx}s`,
            }));
          });
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [mode, sourceState]);

  if (mode === 'calibration') {
    const xMm = 0.421 * testU - 0.012 * testV + 120.5;
    const yMm = 0.015 * testU + 0.418 * testV + 85.2;

    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-emerald-900/10 pb-4">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-slate-900">
              Downward Camera Homography &amp; Dual-Camera Calibration
            </h2>
            <p className="text-xs text-slate-600 mt-1">
              Preserved <span className="font-mono text-emerald-800">Weed_Detection/src/calibration.py</span> integrated via{' '}
              <span className="font-mono text-emerald-800">ros2_ws/src/weeding_controller/weed_localizer.py</span>
            </p>
          </div>
          <div className="text-xs font-mono text-emerald-700 font-semibold">
            ● Calibrated · RMS Reprojection Error: 0.28 px
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          <div className="bg-white border border-emerald-900/10 rounded-lg p-5 space-y-3">
            <h3 className="text-sm font-semibold text-slate-900">01. Intrinsic Camera Matrix</h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              9x6 checkerboard calibration removes radial distortion on the downward detection camera (mounted at 500 mm height).
            </p>
            <div className="bg-[#F8FBF9] border border-emerald-900/10 rounded p-3 font-mono text-xs text-slate-700 space-y-1 tabular-nums">
              <div>fx = 1245.80 px · fy = 1246.20 px</div>
              <div>cx = 640.00 px · cy = 360.00 px</div>
              <div>k1 = 0.084 · k2 = -0.192</div>
              <div>p1 = 0.001 · p2 = 0.002</div>
            </div>
          </div>

          <div className="bg-white border border-emerald-900/10 rounded-lg p-5 space-y-3">
            <h3 className="text-sm font-semibold text-slate-900">02. Extrinsic Homography (H)</h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              12 ArUco markers at known base_footprint offsets map downward camera pixels (u, v) into ground-plane millimeters.
            </p>
            <pre className="bg-[#F8FBF9] border border-emerald-900/10 rounded p-3 font-mono text-xs text-emerald-900 leading-relaxed tabular-nums">
{`H = [
  [ 0.421, -0.012, 120.5 ],
  [ 0.015,  0.418,  85.2 ],
  [ 0.000,  0.000,   1.0 ]
]`}
            </pre>
          </div>

          <div className="bg-white border border-emerald-900/10 rounded-lg p-5 space-y-4">
            <h3 className="text-sm font-semibold text-slate-900">03. Interactive Pixel-to-Ground Solver</h3>
            <div className="space-y-2.5 text-xs">
              <div>
                <div className="flex justify-between font-mono text-slate-600">
                  <span>Pixel u (0..1280)</span>
                  <span className="text-emerald-700 font-semibold tabular-nums">{testU} px</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={1280}
                  value={testU}
                  onChange={(e) => setTestU(Number(e.target.value))}
                  className="w-full accent-emerald-600 cursor-pointer"
                />
              </div>
              <div>
                <div className="flex justify-between font-mono text-slate-600">
                  <span>Pixel v (0..720)</span>
                  <span className="text-emerald-700 font-semibold tabular-nums">{testV} px</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={720}
                  value={testV}
                  onChange={(e) => setTestV(Number(e.target.value))}
                  className="w-full accent-emerald-600 cursor-pointer"
                />
              </div>
              <div className="bg-[#F8FBF9] border border-emerald-900/10 rounded p-3 font-mono tabular-nums space-y-1">
                <div className="text-slate-500">Computed Ground Target (base_footprint)</div>
                <div className="text-base text-emerald-700 font-semibold">
                  X = {xMm.toFixed(1)} mm · Y = {yMm.toFixed(1)} mm
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const isLive = sourceState === 'webcam' || sourceState === 'media';

  return (
    <div className="space-y-6">
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*,image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleLoadFile(f);
          e.target.value = '';
        }}
      />

      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-emerald-900/10 pb-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-slate-900">
            Real-Time Downward Camera Vision &amp; Foliage Localization
          </h2>
          <p className="text-xs text-slate-600 mt-1">
            Live Browser CV (ExG = 2G − R − B + Otsu + Connected Components + Homography H) · Zero mock boxes
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {sourceState === 'webcam' ? (
            <button
              onClick={handleStopCamera}
              className="px-3.5 py-2 text-xs font-semibold rounded-md bg-rose-600 hover:bg-rose-700 text-white flex items-center gap-1.5 cursor-pointer"
            >
              <CameraOff className="w-3.5 h-3.5" />
              <span>Stop Camera</span>
            </button>
          ) : (
            <button
              onClick={() => void startWebcam()}
              className="px-3.5 py-2 text-xs font-semibold rounded-md bg-emerald-600 hover:bg-emerald-700 text-white flex items-center gap-1.5 cursor-pointer"
            >
              <Camera className="w-3.5 h-3.5" />
              <span>Start Live Camera</span>
            </button>
          )}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-3 py-2 text-xs font-medium rounded-md bg-white hover:bg-emerald-50 border border-emerald-900/15 text-slate-700 flex items-center gap-1.5 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5 text-emerald-600" />
            <span>Upload Video / Photo</span>
          </button>
        </div>
      </div>

      {/* Real-Time Camera Viewport + Detected Blobs */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        <div className="lg:col-span-7 bg-white border border-emerald-900/10 rounded-lg p-4 flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Camera className="w-4 h-4 text-emerald-600" />
              <h3 className="text-sm font-semibold text-slate-900">
                Live Camera Pixel Pipeline ({sourceName})
              </h3>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                onClick={() => setShowTurnOverlay((v) => !v)}
                className={`px-2 py-1 text-[11px] font-mono rounded border transition-colors flex items-center gap-1 cursor-pointer ${
                  showTurnOverlay
                    ? 'bg-emerald-50 border-emerald-400 text-emerald-800 font-semibold'
                    : 'bg-[#F8FBF9] border-slate-200 text-slate-500 hover:border-emerald-300'
                }`}
              >
                <Route className="w-3 h-3 text-emerald-600" />
                <span>Turn Path AR</span>
              </button>
              {(['overlay', 'mask', 'raw'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setOverlayMode(m)}
                  className={`px-2 py-1 text-[11px] font-mono rounded border transition-colors cursor-pointer ${
                    overlayMode === m
                      ? 'bg-emerald-600 border-emerald-600 text-white font-semibold'
                      : 'bg-[#F8FBF9] border-slate-200 text-slate-600 hover:border-emerald-300'
                  }`}
                >
                  {m === 'overlay' ? 'Boxes + Mask' : m === 'mask' ? 'ExG Mask' : 'Raw'}
                </button>
              ))}
              {sourceState === 'webcam' && (
                <button
                  onClick={() => {
                    const next = facingMode === 'environment' ? 'user' : 'environment';
                    setFacingMode(next);
                    void startWebcam(next);
                  }}
                  className="px-2 py-1 text-[11px] font-mono rounded border border-slate-200 bg-[#F8FBF9] text-slate-700 hover:bg-emerald-50 flex items-center gap-1 cursor-pointer"
                >
                  <RefreshCw className="w-3 h-3 text-emerald-600" />
                  <span>{facingMode === 'environment' ? 'Rear' : 'Front'}</span>
                </button>
              )}
            </div>
          </div>

          <div className="relative aspect-video bg-[#F4F8F5] border border-emerald-900/15 rounded overflow-hidden flex items-center justify-center">
            <canvas
              ref={canvasRef}
              width={PROC_W}
              height={PROC_H}
              className={`w-full h-full object-contain bg-[#141A17] ${isLive ? 'block' : 'hidden'}`}
            />

            {sourceState === 'idle' && (
              <div className="p-6 text-center space-y-3 max-w-md bg-[#F8FBF9]">
                <div className="w-11 h-11 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center justify-center mx-auto">
                  <Camera className="w-5 h-5 text-emerald-700" />
                </div>
                <div className="text-sm font-semibold text-slate-900">
                  Real-Time Vision &amp; Animated Row-End Turn Projection Ready
                </div>
                <p className="text-xs text-slate-600 leading-relaxed">
                  Open your device camera or upload a crop-field video/photo to run live Excess Green + Otsu segmentation alongside the animated row-end turn trajectory path overlay.
                </p>
                <div className="flex items-center justify-center gap-2 pt-1">
                  <button
                    onClick={() => void startWebcam()}
                    className="px-4 py-2 text-xs font-semibold rounded-md bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer"
                  >
                    Open Live Camera
                  </button>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="px-4 py-2 text-xs font-medium rounded-md bg-white border border-emerald-900/15 text-slate-800 hover:bg-emerald-50 cursor-pointer"
                  >
                    Upload Video / Photo
                  </button>
                </div>
              </div>
            )}

            {sourceState === 'requesting' && (
              <div className="text-xs font-mono text-emerald-800">
                Initializing camera stream...
              </div>
            )}

            {sourceState === 'error' && (
              <div className="p-6 text-center space-y-3 max-w-md">
                <CameraOff className="w-7 h-7 text-rose-600 mx-auto" />
                <p className="text-xs font-mono text-rose-800">{cameraError}</p>
                <div className="flex items-center justify-center gap-2">
                  <button
                    onClick={() => void startWebcam()}
                    className="px-3 py-1.5 text-xs font-semibold rounded bg-emerald-600 text-white cursor-pointer"
                  >
                    Retry Camera
                  </button>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="px-3 py-1.5 text-xs font-medium rounded bg-white border border-emerald-900/15 text-slate-800 cursor-pointer"
                  >
                    Upload Video / Photo
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap justify-between gap-2 text-xs font-mono text-slate-600 tabular-nums">
            <span>
              FPS: <strong className="text-emerald-700">{metrics.fps.toFixed(0)}</strong> · Frame CV:{' '}
              <strong className="text-slate-900">{metrics.processingMs.toFixed(1)} ms</strong> · Otsu ≥{' '}
              {metrics.otsuThreshold}
            </span>
            <span>
              Furrow End:{' '}
              <strong className={metrics.turnImminent ? 'text-amber-700' : 'text-emerald-700'}>
                {isLive ? `${metrics.distanceToFurrowEndM.toFixed(2)} m` : '—'}
              </strong>{' '}
              · Canopy: <strong className="text-emerald-700">{metrics.greenCoveragePct.toFixed(1)}%</strong>
            </span>
          </div>
        </div>

        {/* Live CV Threshold Controls, Row-End Turn Trajectory Controls & Detected Blobs */}
        <div className="lg:col-span-5 bg-white border border-emerald-900/10 rounded-lg p-4 flex flex-col gap-4">
          {/* Predicted Turn Trajectory Overlay Controls */}
          <div className="space-y-2.5 pb-3 border-b border-emerald-900/10">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Route className="w-4 h-4 text-emerald-600" />
                <h3 className="text-sm font-semibold text-slate-900">
                  Row-End Turn Path Projection
                </h3>
              </div>
              <span
                className={`text-[11px] font-mono font-semibold ${
                  !showTurnOverlay
                    ? 'text-slate-400'
                    : metrics.turnImminent
                    ? 'text-amber-700'
                    : 'text-emerald-700'
                }`}
              >
                {!showTurnOverlay
                  ? '○ OFF'
                  : metrics.turnImminent
                  ? '▲ TURN IMMINENT'
                  : '● AR ACTIVE'}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              <button
                onClick={() => setTurnDirection('right')}
                className={`py-1.5 px-2 text-xs font-medium rounded border flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${
                  turnDirection === 'right'
                    ? 'bg-emerald-50 border-emerald-400 text-emerald-900 font-semibold'
                    : 'bg-[#F8FBF9] border-slate-200 text-slate-600 hover:border-emerald-300'
                }`}
              >
                <CornerDownRight className="w-3.5 h-3.5 text-emerald-600" />
                <span>Right U-Turn</span>
              </button>
              <button
                onClick={() => setTurnDirection('left')}
                className={`py-1.5 px-2 text-xs font-medium rounded border flex items-center justify-center gap-1.5 cursor-pointer transition-colors ${
                  turnDirection === 'left'
                    ? 'bg-emerald-50 border-emerald-400 text-emerald-900 font-semibold'
                    : 'bg-[#F8FBF9] border-slate-200 text-slate-600 hover:border-emerald-300'
                }`}
              >
                <CornerDownLeft className="w-3.5 h-3.5 text-emerald-600" />
                <span>Left U-Turn</span>
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div className="space-y-1">
                <div className="flex justify-between font-mono text-slate-600 tabular-nums">
                  <span>Turn Radius</span>
                  <span className="text-emerald-700 font-semibold">{turnRadiusM.toFixed(2)} m</span>
                </div>
                <input
                  type="range"
                  min={0.35}
                  max={0.9}
                  step={0.05}
                  value={turnRadiusM}
                  onChange={(e) => setTurnRadiusM(Number(e.target.value))}
                  className="w-full accent-emerald-600 cursor-pointer"
                />
              </div>

              <div className="space-y-1">
                <div className="flex justify-between font-mono text-slate-600 tabular-nums">
                  <span>Row Spacing</span>
                  <span className="text-emerald-700 font-semibold">
                    {Math.round(rowSpacingM * 100)} cm
                  </span>
                </div>
                <input
                  type="range"
                  min={0.5}
                  max={0.8}
                  step={0.05}
                  value={rowSpacingM}
                  onChange={(e) => setRowSpacingM(Number(e.target.value))}
                  className="w-full accent-emerald-600 cursor-pointer"
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 bg-[#F8FBF9] border border-emerald-900/10 rounded px-2.5 py-1.5 text-[11px] font-mono tabular-nums">
              <span className="text-slate-600">
                Arc: <strong className="text-slate-900">{metrics.arcLengthM.toFixed(2)} m</strong> ·
                End Conf:{' '}
                <strong className="text-emerald-700">
                  {Math.round(metrics.rowEndConfidence * 100)}%
                </strong>
              </span>
              <button
                onClick={() => setForceTurnPreview((v) => !v)}
                className={`px-2 py-0.5 rounded border text-[10px] font-semibold cursor-pointer transition-colors ${
                  forceTurnPreview
                    ? 'bg-amber-50 border-amber-300 text-amber-800'
                    : 'bg-white border-emerald-900/15 text-slate-600 hover:text-emerald-800'
                }`}
              >
                {forceTurnPreview ? 'Alert Style: ON' : 'Preview Turn Alert'}
              </button>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <SlidersHorizontal className="w-4 h-4 text-emerald-600" />
              <h3 className="text-sm font-semibold text-slate-900">Real-Time Segmentation Tuning</h3>
            </div>
            <div className="space-y-1.5 text-xs">
              <div className="flex justify-between font-mono text-slate-600 tabular-nums">
                <span>ExG Green Floor (2G − R − B)</span>
                <span className="text-emerald-700 font-semibold">{minExgFloor}</span>
              </div>
              <input
                type="range"
                min={6}
                max={65}
                value={minExgFloor}
                onChange={(e) => setMinExgFloor(Number(e.target.value))}
                className="w-full accent-emerald-600 cursor-pointer"
              />
            </div>
            <div className="space-y-1.5 text-xs">
              <div className="flex justify-between font-mono text-slate-600 tabular-nums">
                <span>Minimum Blob Area</span>
                <span className="text-emerald-700 font-semibold">{minBlobArea} px²</span>
              </div>
              <input
                type="range"
                min={20}
                max={300}
                step={5}
                value={minBlobArea}
                onChange={(e) => setMinBlobArea(Number(e.target.value))}
                className="w-full accent-emerald-600 cursor-pointer"
              />
            </div>
          </div>

          <div className="pt-3 border-t border-emerald-900/10 space-y-2.5 flex-1">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Crosshair className="w-4 h-4 text-emerald-600" />
                <h3 className="text-sm font-semibold text-slate-900">Live Localized Blobs</h3>
              </div>
              <span className="text-xs font-mono text-slate-500 tabular-nums">
                {blobs.length} detected
              </span>
            </div>

            {blobs.length === 0 ? (
              <div className="bg-[#F8FBF9] border border-emerald-900/10 rounded p-4 text-xs font-mono text-slate-500 text-center">
                {isLive
                  ? 'No green vegetation clusters above ExG threshold in current frame.'
                  : 'Start live camera or upload an image/video to detect real foliage targets.'}
              </div>
            ) : (
              <div className="space-y-2 max-h-[245px] overflow-y-auto pr-1">
                {blobs.map((b) => {
                  const isWeed = b.classification === 'weed_candidate';
                  return (
                    <div
                      key={b.id}
                      className="bg-[#F8FBF9] border border-emerald-900/10 rounded p-2.5 flex items-center justify-between gap-2 text-xs font-mono tabular-nums"
                    >
                      <div>
                        <div className={isWeed ? 'text-rose-700 font-semibold' : 'text-emerald-700 font-semibold'}>
                          #{b.id} {isWeed ? 'weed_candidate' : 'crop_canopy'}
                        </div>
                        <div className="text-[11px] text-slate-500">
                          Ground H: ({b.groundMm[0].toFixed(1)}, {b.groundMm[1].toFixed(1)}) mm
                        </div>
                      </div>
                      <div className="text-right text-[11px] text-slate-600">
                        <div>{(b.confidence * 100).toFixed(0)}% conf</div>
                        <div className="text-slate-400">{b.pixelArea} px²</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {estopActive && (
              <div className="text-[11px] font-mono text-rose-700">
                Hardware E-Stop engaged — treatment hook inhibited.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Real Measured CV Frame Processing Latency Chart */}
      <div className="bg-white border border-emerald-900/10 rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-emerald-600" />
            <h3 className="text-sm font-semibold text-slate-900">
              Measured Browser CV Processing Time (ms / frame)
            </h3>
          </div>
          <span className="text-xs font-mono text-slate-500">
            Actual performance.now() timing on live pixels
          </span>
        </div>
        <div className="h-48 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={latencyHistory} margin={{ top: 5, right: 16, left: -14, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E2ECE6" />
              <XAxis dataKey="time" stroke="#64748B" fontSize={11} tickLine={false} />
              <YAxis stroke="#64748B" fontSize={11} tickLine={false} unit="ms" />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#FFFFFF',
                  borderColor: '#CBD5E1',
                  borderRadius: '6px',
                  fontSize: '12px',
                  fontFamily: 'IBM Plex Mono, monospace',
                  color: '#0F172A',
                }}
              />
              <Line
                type="monotone"
                dataKey="cvMs"
                name="ExG + Otsu + BFS (ms)"
                stroke="#059669"
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
};
