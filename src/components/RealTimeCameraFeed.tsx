import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  CameraOff,
  RefreshCw,
  Eye,
  EyeOff,
  FlipHorizontal2,
  AlertCircle,
} from 'lucide-react';
import type { VisionAlignmentData } from './CropRowAlignmentGauge';
import { detectCropRowFromFrame } from '../vision/cropRowVision';

export interface CameraFeedTrigger {
  action: 'start' | 'stop';
  seq: number;
}

interface Props {
  rowWidthM: number;
  stanleyGain: number;
  speedLimit: number;
  externalTrigger?: CameraFeedTrigger | null;
  onAlignmentUpdate?: (alignment: VisionAlignmentData, active: boolean) => void;
  onLogEvent?: (msg: string) => void;
}

const PROC_W = 320;
const PROC_H = 180;
const ALPHA_LAT = 0.35;
const ALPHA_YAW = 0.3;
const MAX_MISSED_FRAMES = 12;

export const RealTimeCameraFeed: React.FC<Props> = ({
  rowWidthM,
  stanleyGain,
  speedLimit,
  externalTrigger,
  onAlignmentUpdate,
  onLogEvent,
}) => {
  const [status, setStatus] = useState<'idle' | 'requesting' | 'active' | 'error'>('idle');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [showHudOverlay, setShowHudOverlay] = useState<boolean>(true);
  const [mirrored, setMirrored] = useState<boolean>(false);
  const [minExgFloor, setMinExgFloor] = useState<number>(22);
  const [cameraLabel, setCameraLabel] = useState<string>('Standby');
  const [resolution, setResolution] = useState<string>('—');

  const [telemetry, setTelemetry] = useState({
    fps: 0,
    processingMs: 0,
    otsuThreshold: 22,
    lateralOffsetM: 0,
    headingErrorRad: 0,
    rowEndConfidence: 0,
    distanceToFurrowEndM: 2.0,
    greenRatioNear: 0,
    greenRatioFar: 0,
    trackingLocked: false,
    detectionMode: 'none' as 'dual_row' | 'single_band' | 'none',
  });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hudCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const workCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const onAlignmentUpdateRef = useRef(onAlignmentUpdate);
  const onLogEventRef = useRef(onLogEvent);
  useEffect(() => {
    onAlignmentUpdateRef.current = onAlignmentUpdate;
    onLogEventRef.current = onLogEvent;
  }, [onAlignmentUpdate, onLogEvent]);

  const paramsRef = useRef({
    rowWidthM,
    stanleyGain,
    speedLimit,
    showHudOverlay,
    minExgFloor,
    cameraLabel,
  });

  useEffect(() => {
    paramsRef.current = {
      rowWidthM,
      stanleyGain,
      speedLimit,
      showHudOverlay,
      minExgFloor,
      cameraLabel,
    };
  }, [rowWidthM, stanleyGain, speedLimit, showHudOverlay, minExgFloor, cameraLabel]);

  const trackerRef = useRef({
    latM: 0,
    yawRad: 0,
    missedFrames: 0,
    hasEverLocked: false,
    lastUiEmit: 0,
    frameCount: 0,
    fpsWindowStart: performance.now(),
    currentFps: 0,
  });

  const refreshVideoDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === 'videoinput'));
    } catch {
      // Ignore device enumeration errors prior to permission grant
    }
  }, []);

  const stopCamera = useCallback(
    (emitLog = true) => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.srcObject = null;
      }
      const hud = hudCanvasRef.current;
      if (hud) {
        const ctx = hud.getContext('2d');
        ctx?.clearRect(0, 0, hud.width, hud.height);
      }

      trackerRef.current.missedFrames = 0;
      trackerRef.current.hasEverLocked = false;
      setStatus('idle');
      setErrorText(null);
      setCameraLabel('Standby');
      setResolution('—');
      setTelemetry({
        fps: 0,
        processingMs: 0,
        otsuThreshold: paramsRef.current.minExgFloor,
        lateralOffsetM: 0,
        headingErrorRad: 0,
        rowEndConfidence: 0,
        distanceToFurrowEndM: 2.0,
        greenRatioNear: 0,
        greenRatioFar: 0,
        trackingLocked: false,
        detectionMode: 'none',
      });

      onAlignmentUpdateRef.current?.(
        {
          trackingLocked: false,
          lateralOffsetM: 0,
          rawLateralOffsetM: 0,
          headingErrorRad: 0,
          rawHeadingErrorRad: 0,
          rowWidthM: paramsRef.current.rowWidthM,
          rowEndConfidence: 0,
          distanceToFurrowEndM: 2.0,
          greenRatioFar: 0,
          greenRatioNear: 0,
          missedFrames: 0,
          cmdWzRadS: 0,
          currentRow: 1,
        },
        false
      );

      if (emitLog) {
        onLogEventRef.current?.('[RealTimeCameraFeed] Stopped live device camera stream.');
      }
    },
    []
  );

  const startCamera = useCallback(
    async (opts?: { facing?: 'environment' | 'user'; deviceId?: string }) => {
      stopCamera(false);
      setErrorText(null);
      setStatus('requesting');

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        const msg =
          'navigator.mediaDevices.getUserMedia is not available in this browser context.';
        setStatus('error');
        setErrorText(msg);
        onLogEventRef.current?.(`[RealTimeCameraFeed] ${msg}`);
        return;
      }

      const targetFacing = opts?.facing ?? facingMode;
      const targetDevice = opts?.deviceId ?? selectedDeviceId;

      const videoConstraints: MediaTrackConstraints = targetDevice
        ? {
            deviceId: { exact: targetDevice },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          }
        : {
            facingMode: { ideal: targetFacing },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          };

      try {
        let mediaStream: MediaStream;
        try {
          mediaStream = await navigator.mediaDevices.getUserMedia({
            video: videoConstraints,
            audio: false,
          });
        } catch (constraintErr: unknown) {
          const errName = (constraintErr as { name?: string })?.name;
          if (errName === 'OverconstrainedError' || errName === 'ConstraintNotSatisfiedError') {
            mediaStream = await navigator.mediaDevices.getUserMedia({
              video: true,
              audio: false,
            });
          } else {
            throw constraintErr;
          }
        }

        streamRef.current = mediaStream;

        const track = mediaStream.getVideoTracks()[0];
        const label = track?.label || 'Live Device Camera';
        setCameraLabel(label);

        const settings = track?.getSettings?.();
        if (settings?.width && settings?.height) {
          setResolution(`${settings.width}×${settings.height}`);
        }

        const videoEl = videoRef.current;
        if (videoEl) {
          videoEl.srcObject = mediaStream;
          try {
            await videoEl.play();
          } catch {
            // Browser may defer playback until loadedmetadata fires
          }
          if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
            setResolution(`${videoEl.videoWidth}×${videoEl.videoHeight}`);
          }
        }

        setStatus('active');
        trackerRef.current.fpsWindowStart = performance.now();
        trackerRef.current.frameCount = 0;

        await refreshVideoDevices();
        onLogEventRef.current?.(
          `[RealTimeCameraFeed] Live <video> crop-row feed active (${label}) — ExG + Otsu HUD running.`
        );
      } catch (err: unknown) {
        const e = err as { name?: string; message?: string };
        const msg =
          e?.name === 'NotAllowedError'
            ? 'Camera permission denied. Grant camera access in your browser address bar and click Retry.'
            : e?.name === 'NotFoundError'
            ? 'No camera device detected on this machine.'
            : e?.name === 'NotReadableError'
            ? 'Camera is currently in use by another tab or application.'
            : `Could not start camera: ${e?.message || 'Unknown error'}`;
        setStatus('error');
        setErrorText(msg);
        onLogEventRef.current?.(`[RealTimeCameraFeed] ${msg}`);
      }
    },
    [facingMode, selectedDeviceId, stopCamera, refreshVideoDevices]
  );

  // Respond to external Start/Stop commands from NavigationWorkbench top bar
  const lastTriggerSeqRef = useRef<number>(0);
  useEffect(() => {
    if (!externalTrigger || externalTrigger.seq === lastTriggerSeqRef.current) return;
    lastTriggerSeqRef.current = externalTrigger.seq;
    if (externalTrigger.action === 'start') {
      void startCamera();
    } else if (externalTrigger.action === 'stop') {
      stopCamera(true);
    }
  }, [externalTrigger, startCamera, stopCamera]);

  // Stop MediaStream tracks cleanly on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
    };
  }, []);

  // Real-time ExG + Otsu crop-row analysis directly from the live <video> element
  useEffect(() => {
    if (status !== 'active') return;

    if (!workCanvasRef.current) {
      const c = document.createElement('canvas');
      c.width = PROC_W;
      c.height = PROC_H;
      workCanvasRef.current = c;
    }

    let rafId = 0;

    const analyzeLoop = (now: number) => {
      const videoEl = videoRef.current;
      const workCanvas = workCanvasRef.current;
      const hudCanvas = hudCanvasRef.current;

      if (videoEl && workCanvas && videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
        const wCtx = workCanvas.getContext('2d', { willReadFrequently: true });
        if (wCtx) {
          wCtx.drawImage(videoEl, 0, 0, PROC_W, PROC_H);
          const frame = wCtx.getImageData(0, 0, PROC_W, PROC_H);
          const p = paramsRef.current;
          const { observation } = detectCropRowFromFrame(frame, {
            rowWidthM: p.rowWidthM,
            minExgFloor: p.minExgFloor,
          });

          const tr = trackerRef.current;
          tr.frameCount += 1;
          const elapsed = now - tr.fpsWindowStart;
          if (elapsed >= 500) {
            tr.currentFps = (tr.frameCount * 1000) / elapsed;
            tr.frameCount = 0;
            tr.fpsWindowStart = now;
          }

          if (observation.valid) {
            if (!tr.hasEverLocked) {
              tr.latM = observation.lateralErrorM;
              tr.yawRad = observation.headingErrorRad;
              tr.hasEverLocked = true;
            } else {
              tr.latM = (1 - ALPHA_LAT) * tr.latM + ALPHA_LAT * observation.lateralErrorM;
              tr.yawRad = (1 - ALPHA_YAW) * tr.yawRad + ALPHA_YAW * observation.headingErrorRad;
            }
            tr.missedFrames = 0;
          } else {
            tr.missedFrames = Math.min(20, tr.missedFrames + 1);
            if (tr.missedFrames > MAX_MISSED_FRAMES) {
              tr.hasEverLocked = false;
            }
          }

          const locked =
            observation.valid || (tr.hasEverLocked && tr.missedFrames <= MAX_MISSED_FRAMES);

          // Draw lightweight transparent crop-row alignment HUD over the native <video>
          if (hudCanvas) {
            const hCtx = hudCanvas.getContext('2d');
            if (hCtx) {
              hCtx.clearRect(0, 0, PROC_W, PROC_H);
              if (p.showHudOverlay) {
                const farRoiY =
                  observation.roiTopPx +
                  Math.floor((observation.roiBottomPx - observation.roiTopPx) / 3);
                hCtx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
                hCtx.lineWidth = 1;
                hCtx.setLineDash([4, 4]);
                hCtx.beginPath();
                hCtx.moveTo(0, observation.roiTopPx);
                hCtx.lineTo(PROC_W, observation.roiTopPx);
                hCtx.moveTo(0, farRoiY);
                hCtx.lineTo(PROC_W, farRoiY);
                hCtx.moveTo(0, observation.roiBottomPx);
                hCtx.lineTo(PROC_W, observation.roiBottomPx);
                hCtx.stroke();
                hCtx.setLineDash([]);

                if (observation.rowEndConfidence >= 0.78 || observation.distanceToFurrowEndM <= 0.6) {
                  hCtx.fillStyle = 'rgba(217, 119, 6, 0.9)';
                  hCtx.fillRect(6, observation.roiTopPx + 4, 178, 16);
                  hCtx.fillStyle = '#FFFFFF';
                  hCtx.font = '600 9px "IBM Plex Mono", monospace';
                  hCtx.fillText(
                    `FURROW END ${observation.distanceToFurrowEndM.toFixed(2)}m · TURN ALERT`,
                    10,
                    observation.roiTopPx + 15
                  );
                }

                // Furrow-end ground-projected horizon line
                if (observation.distanceToFurrowEndM < 1.55) {
                  const hy = Math.max(
                    observation.roiTopPx + 2,
                    Math.min(observation.roiBottomPx - 4, observation.furrowEndYPx)
                  );
                  hCtx.strokeStyle =
                    observation.distanceToFurrowEndM <= 0.6 ? '#F59E0B' : '#34D399';
                  hCtx.lineWidth = 1.6;
                  hCtx.setLineDash([5, 3]);
                  hCtx.beginPath();
                  hCtx.moveTo(0, hy);
                  hCtx.lineTo(PROC_W, hy);
                  hCtx.stroke();
                  hCtx.setLineDash([]);
                }

                // Optical center axis
                hCtx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
                hCtx.beginPath();
                hCtx.moveTo(PROC_W / 2, observation.roiTopPx);
                hCtx.lineTo(PROC_W / 2, observation.roiBottomPx);
                hCtx.stroke();

                if (observation.valid && observation.strips.length >= 2) {
                  for (const st of observation.strips) {
                    const py = observation.roiTopPx + st.y;
                    hCtx.fillStyle = '#34D399';
                    hCtx.beginPath();
                    hCtx.arc(st.leftX, py, 2.6, 0, Math.PI * 2);
                    hCtx.arc(st.rightX, py, 2.6, 0, Math.PI * 2);
                    hCtx.fill();

                    hCtx.fillStyle = '#FBBF24';
                    hCtx.beginPath();
                    hCtx.arc(st.centerX, py, 2.2, 0, Math.PI * 2);
                    hCtx.fill();
                  }

                  // Fitted row centerline
                  hCtx.strokeStyle = '#10B981';
                  hCtx.lineWidth = 2.5;
                  hCtx.beginPath();
                  hCtx.moveTo(observation.centerTopPx, observation.roiTopPx);
                  hCtx.lineTo(observation.centerBottomPx, observation.roiBottomPx);
                  hCtx.stroke();

                  // Lateral offset bar
                  hCtx.strokeStyle =
                    Math.abs(observation.lateralErrorM) > 0.08 ? '#F43F5E' : '#F59E0B';
                  hCtx.lineWidth = 2.5;
                  hCtx.beginPath();
                  hCtx.moveTo(PROC_W / 2, observation.roiBottomPx - 8);
                  hCtx.lineTo(observation.centerBottomPx, observation.roiBottomPx - 8);
                  hCtx.stroke();
                }
              }
            }
          }

          if (now - tr.lastUiEmit >= 75) {
            tr.lastUiEmit = now;

            if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
              setResolution(`${videoEl.videoWidth}×${videoEl.videoHeight}`);
            }

            const cmdWz = locked
              ? Math.max(
                  -0.8,
                  Math.min(
                    0.8,
                    -(p.stanleyGain * Math.atan2(tr.latM, Math.max(p.speedLimit, 0.08)) + tr.yawRad)
                  )
                )
              : 0;

            setTelemetry({
              fps: tr.currentFps,
              processingMs: observation.processingMs,
              otsuThreshold: observation.otsuThreshold,
              lateralOffsetM: tr.latM,
              headingErrorRad: tr.yawRad,
              rowEndConfidence: observation.rowEndConfidence,
              distanceToFurrowEndM: observation.distanceToFurrowEndM,
              greenRatioNear: observation.greenRatioNear,
              greenRatioFar: observation.greenRatioFar,
              trackingLocked: locked,
              detectionMode: observation.mode,
            });

            onAlignmentUpdateRef.current?.(
              {
                trackingLocked: locked,
                lateralOffsetM: tr.latM,
                rawLateralOffsetM: observation.valid ? observation.lateralErrorM : tr.latM,
                headingErrorRad: tr.yawRad,
                rawHeadingErrorRad: observation.valid ? observation.headingErrorRad : tr.yawRad,
                rowWidthM: p.rowWidthM,
                rowEndConfidence: observation.rowEndConfidence,
                distanceToFurrowEndM: observation.distanceToFurrowEndM,
                furrowEndYPx: observation.furrowEndYPx,
                greenRatioFar: observation.greenRatioFar,
                greenRatioNear: observation.greenRatioNear,
                missedFrames: tr.missedFrames,
                cmdWzRadS: cmdWz,
                currentRow: 1,
                sourceLabel: `LIVE <video> FEED (${p.cameraLabel}) · ${tr.currentFps.toFixed(0)} FPS`,
              },
              true
            );
          }
        }
      }

      rafId = requestAnimationFrame(analyzeLoop);
    };

    rafId = requestAnimationFrame(analyzeLoop);
    return () => cancelAnimationFrame(rafId);
  }, [status]);

  return (
    <section
      aria-label="Real-Time Camera Feed"
      className="bg-white border border-emerald-900/10 rounded-lg p-4 space-y-4"
    >
      {/* Header Row */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-emerald-900/10 pb-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <div className="flex items-center gap-2">
            <Camera className="w-4 h-4 text-emerald-600 shrink-0" />
            <h3 className="text-sm font-semibold text-slate-900">
              Live Crop-Row Camera Feed (RealTimeCameraFeed)
            </h3>
          </div>
          <span className="text-xs font-mono text-slate-500">
            getUserMedia &lt;video&gt; · {cameraLabel} · {resolution}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`text-xs font-mono font-semibold tabular-nums ${
              status === 'active'
                ? 'text-emerald-700'
                : status === 'error'
                ? 'text-rose-700'
                : 'text-slate-500'
            }`}
          >
            {status === 'active'
              ? `● LIVE ${telemetry.fps.toFixed(0)} FPS`
              : status === 'requesting'
              ? 'REQUESTING...'
              : status === 'error'
              ? '✖ CAMERA ERROR'
              : '○ STANDBY'}
          </span>

          {status === 'active' ? (
            <button
              onClick={() => stopCamera(true)}
              className="px-3 py-1.5 text-xs font-semibold rounded-md bg-rose-600 hover:bg-rose-700 text-white transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              <CameraOff className="w-3.5 h-3.5" />
              <span>Stop Camera</span>
            </button>
          ) : (
            <button
              onClick={() => void startCamera()}
              className="px-3 py-1.5 text-xs font-semibold rounded-md bg-emerald-600 hover:bg-emerald-700 text-white transition-colors flex items-center gap-1.5 cursor-pointer"
            >
              <Camera className="w-3.5 h-3.5" />
              <span>Start Live Feed</span>
            </button>
          )}
        </div>
      </div>

      {/* Main 2-Column Body: Live <video> Viewport + White/Green Controls & Telemetry */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
        {/* Left: Native <video> kept mounted & laid out so play() never stalls */}
        <div className="lg:col-span-7 flex flex-col gap-2">
          <div className="relative aspect-video rounded-md border border-emerald-900/15 bg-[#F4F8F5] overflow-hidden">
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              onLoadedMetadata={(e) => {
                const v = e.currentTarget;
                if (v.videoWidth > 0 && v.videoHeight > 0) {
                  setResolution(`${v.videoWidth}×${v.videoHeight}`);
                }
                void v.play().catch(() => undefined);
              }}
              className={`w-full h-full object-cover transition-opacity duration-150 ${
                status === 'active' ? 'opacity-100' : 'opacity-0 pointer-events-none'
              } ${mirrored ? 'scale-x-[-1]' : ''}`}
            />

            {/* Transparent ExG+Otsu crop-row centerline HUD layered directly over <video> */}
            <canvas
              ref={hudCanvasRef}
              width={PROC_W}
              height={PROC_H}
              className={`pointer-events-none absolute inset-0 w-full h-full ${
                status === 'active' && showHudOverlay ? 'opacity-100' : 'opacity-0'
              } ${mirrored ? 'scale-x-[-1]' : ''}`}
            />

            {/* Clean White/Green Idle Prompt */}
            {status === 'idle' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center gap-3 bg-[#F8FBF9]">
                <div className="w-11 h-11 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center justify-center">
                  <Camera className="w-5 h-5 text-emerald-700" />
                </div>
                <div className="space-y-1 max-w-sm">
                  <div className="text-sm font-semibold text-slate-900">
                    Connect Device Camera for Live Crop-Row View
                  </div>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    Streams real-time video directly via{' '}
                    <span className="font-mono text-emerald-800">getUserMedia</span> and feeds live
                    ExG + Otsu lateral offset, heading error, and row-end detection straight into
                    the workbench gauges.
                  </p>
                </div>
                <button
                  onClick={() => void startCamera()}
                  className="px-4 py-2 text-xs font-semibold rounded-md bg-emerald-600 hover:bg-emerald-700 text-white transition-colors flex items-center gap-1.5 cursor-pointer"
                >
                  <Camera className="w-3.5 h-3.5" />
                  <span>Enable Camera Feed</span>
                </button>
              </div>
            )}

            {/* Requesting state */}
            {status === 'requesting' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center gap-2 bg-[#F8FBF9]">
                <Camera className="w-6 h-6 text-emerald-600" />
                <span className="text-xs font-mono text-emerald-800">
                  Requesting camera access via navigator.mediaDevices.getUserMedia...
                </span>
              </div>
            )}

            {/* Error state */}
            {status === 'error' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center gap-3 bg-rose-50/95">
                <AlertCircle className="w-6 h-6 text-rose-600" />
                <p className="text-xs font-mono text-rose-800 max-w-md leading-relaxed">
                  {errorText}
                </p>
                <button
                  onClick={() => void startCamera()}
                  className="px-3.5 py-1.5 text-xs font-semibold rounded-md bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer"
                >
                  Retry Camera
                </button>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-slate-500 tabular-nums">
            <span>
              Mode:{' '}
              <strong className="text-emerald-700">
                {status !== 'active'
                  ? 'IDLE'
                  : telemetry.detectionMode === 'dual_row'
                  ? '2-ROW CENTERLINE'
                  : telemetry.detectionMode === 'single_band'
                  ? '1-BAND FOLIAGE'
                  : 'SEARCHING GREEN'}
              </strong>
            </span>
            <span>
              Near: {(telemetry.greenRatioNear * 100).toFixed(1)}% · Far:{' '}
              {(telemetry.greenRatioFar * 100).toFixed(1)}% · CV:{' '}
              {telemetry.processingMs.toFixed(1)} ms
            </span>
          </div>
        </div>

        {/* Right: Camera Controls & Live Crop-Row Metrics */}
        <div className="lg:col-span-5 bg-[#F8FBF9] border border-emerald-900/10 rounded-md p-3.5 flex flex-col justify-between gap-4">
          <div className="space-y-3">
            {/* Quick Camera Controls */}
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                onClick={() => {
                  const next = facingMode === 'environment' ? 'user' : 'environment';
                  setFacingMode(next);
                  setSelectedDeviceId('');
                  if (status === 'active') void startCamera({ facing: next, deviceId: '' });
                }}
                className="px-2.5 py-1.5 text-xs font-medium rounded border border-emerald-900/15 bg-white hover:bg-emerald-50 text-slate-700 flex items-center gap-1.5 cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5 text-emerald-600" />
                <span>{facingMode === 'environment' ? 'Rear Cam' : 'Front Cam'}</span>
              </button>

              <button
                onClick={() => setShowHudOverlay((v) => !v)}
                className={`px-2.5 py-1.5 text-xs font-medium rounded border flex items-center gap-1.5 cursor-pointer transition-colors ${
                  showHudOverlay
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                    : 'bg-white border-slate-200 text-slate-600'
                }`}
              >
                {showHudOverlay ? (
                  <Eye className="w-3.5 h-3.5 text-emerald-600" />
                ) : (
                  <EyeOff className="w-3.5 h-3.5 text-slate-400" />
                )}
                <span>Crop-Row HUD</span>
              </button>

              <button
                onClick={() => setMirrored((v) => !v)}
                className={`px-2.5 py-1.5 text-xs font-medium rounded border flex items-center gap-1.5 cursor-pointer transition-colors ${
                  mirrored
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                    : 'bg-white border-slate-200 text-slate-600'
                }`}
              >
                <FlipHorizontal2 className="w-3.5 h-3.5 text-emerald-600" />
                <span>Mirror</span>
              </button>
            </div>

            {/* Multi-device Camera Selector */}
            {devices.length > 1 && (
              <div className="space-y-1">
                <label className="text-[11px] font-mono text-slate-500">Video Input Device</label>
                <select
                  value={selectedDeviceId}
                  onChange={(e) => {
                    setSelectedDeviceId(e.target.value);
                    if (status === 'active') void startCamera({ deviceId: e.target.value });
                  }}
                  className="w-full text-xs font-mono bg-white border border-emerald-900/15 rounded px-2.5 py-1.5 text-slate-800"
                >
                  <option value="">Auto ({facingMode === 'environment' ? 'Rear' : 'Front'})</option>
                  {devices.map((d, idx) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Camera ${idx + 1}`}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* ExG Green Sensitivity Floor */}
            <div className="space-y-1 pt-1">
              <div className="flex justify-between text-xs font-mono text-slate-600 tabular-nums">
                <span>ExG Green Floor (Otsu ≥ {telemetry.otsuThreshold})</span>
                <span className="text-emerald-700 font-semibold">{minExgFloor}</span>
              </div>
              <input
                type="range"
                min={6}
                max={65}
                step={1}
                value={minExgFloor}
                onChange={(e) => setMinExgFloor(Number(e.target.value))}
                className="w-full accent-emerald-600 cursor-pointer"
              />
            </div>
          </div>

          {/* Live Alignment Readouts extracted from <video> */}
          <div className="space-y-2 pt-3 border-t border-emerald-900/10 text-xs font-mono tabular-nums">
            <div className="flex justify-between">
              <span className="text-slate-600">Live Lateral Offset (e_y)</span>
              <span
                className={
                  status !== 'active'
                    ? 'text-slate-400'
                    : Math.abs(telemetry.lateralOffsetM) > 0.08
                    ? 'text-amber-700 font-semibold'
                    : 'text-emerald-700 font-semibold'
                }
              >
                {status === 'active'
                  ? `${telemetry.lateralOffsetM >= 0 ? '+' : ''}${telemetry.lateralOffsetM.toFixed(3)} m`
                  : '—'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-600">Live Heading Error (e_ψ)</span>
              <span className={status === 'active' ? 'text-slate-900 font-semibold' : 'text-slate-400'}>
                {status === 'active'
                  ? `${telemetry.headingErrorRad >= 0 ? '+' : ''}${telemetry.headingErrorRad.toFixed(3)} rad`
                  : '—'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-600">Distance to Furrow End</span>
              <span
                className={
                  status !== 'active'
                    ? 'text-slate-400'
                    : telemetry.distanceToFurrowEndM <= 0.6
                    ? 'text-amber-700 font-semibold'
                    : 'text-emerald-700 font-semibold'
                }
              >
                {status === 'active' ? `${telemetry.distanceToFurrowEndM.toFixed(2)} m` : '—'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-600">Row-End Confidence</span>
              <span
                className={
                  status !== 'active'
                    ? 'text-slate-400'
                    : telemetry.rowEndConfidence >= 0.78
                    ? 'text-amber-700 font-semibold'
                    : 'text-emerald-700 font-semibold'
                }
              >
                {status === 'active' ? `${Math.round(telemetry.rowEndConfidence * 100)}%` : '—'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
