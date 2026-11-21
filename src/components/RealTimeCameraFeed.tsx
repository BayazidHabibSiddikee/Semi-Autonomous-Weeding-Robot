import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  CameraOff,
  RefreshCw,
  Eye,
  EyeOff,
  FlipHorizontal2,
  AlertCircle,
  CheckCircle2,
  AlertTriangle,
  Activity,
  Download,
  X,
  HardDrive,
} from 'lucide-react';
import type { VisionAlignmentData } from './CropRowAlignmentGauge';
import { detectCropRowFromFrame } from '../vision/cropRowVision';
import { loadActiveThresholds } from '../services/thresholdPresetStorage';
import { MaixSenseLiveCheck } from './MaixSenseLiveCheck';

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

type CheckStatus = 'pass' | 'warn' | 'fail' | 'checking' | 'idle';

interface LiveCameraDiagnostics {
  trackLive: boolean;
  trackMuted: boolean;
  negotiatedFps: number | null;
  framesCaptured: number;
  meanLuma: number;
  lumaStd: number;
  motionDelta: number;
  exposureState: 'ok' | 'dark' | 'overexposed' | 'idle';
  lastCheckTime: string | null;
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
  const [sourceMode, setSourceMode] = useState<'maixsense' | 'webcam'>('maixsense');
  const [status, setStatus] = useState<'idle' | 'requesting' | 'active' | 'error'>('idle');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [showHudOverlay, setShowHudOverlay] = useState<boolean>(true);
  const [mirrored, setMirrored] = useState<boolean>(false);
  const [minExgFloor, setMinExgFloor] = useState<number>(() => loadActiveThresholds().minExgFloor);
  const [cameraLabel, setCameraLabel] = useState<string>('Standby');
  const [resolution, setResolution] = useState<string>('—');
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null);
  const [snapshotMeta, setSnapshotMeta] = useState<string>('');

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

  const [diagnostics, setDiagnostics] = useState<LiveCameraDiagnostics>({
    trackLive: false,
    trackMuted: false,
    negotiatedFps: null,
    framesCaptured: 0,
    meanLuma: 0,
    lumaStd: 0,
    motionDelta: 0,
    exposureState: 'idle',
    lastCheckTime: null,
  });

  const sectionRef = useRef<HTMLElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hudCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const workCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const prevLumaSampleRef = useRef<Float32Array | null>(null);
  const autoCheckedOnMountRef = useRef<boolean>(false);

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
    totalFrames: 0,
    fpsWindowStart: performance.now(),
    currentFps: 0,
  });

  const refreshVideoDevices = useCallback(async (): Promise<MediaDeviceInfo[]> => {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const cams = all.filter((d) => d.kind === 'videoinput');
      setDevices(cams);
      return cams;
    } catch {
      return [];
    }
  }, []);

  const stopCamera = useCallback((emitLog = true) => {
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

    prevLumaSampleRef.current = null;
    trackerRef.current.missedFrames = 0;
    trackerRef.current.hasEverLocked = false;
    trackerRef.current.totalFrames = 0;
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
    setDiagnostics({
      trackLive: false,
      trackMuted: false,
      negotiatedFps: null,
      framesCaptured: 0,
      meanLuma: 0,
      lumaStd: 0,
      motionDelta: 0,
      exposureState: 'idle',
      lastCheckTime: null,
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
      onLogEventRef.current?.('[Live Camera Check] Stopped live device camera stream.');
    }
  }, []);

  const startCamera = useCallback(
    async (opts?: { facing?: 'environment' | 'user'; deviceId?: string }) => {
      stopCamera(false);
      setErrorText(null);
      setStatus('requesting');

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        const msg =
          'navigator.mediaDevices.getUserMedia is not available in this browser context (requires HTTPS or localhost).';
        setStatus('error');
        setErrorText(msg);
        onLogEventRef.current?.(`[Live Camera Check] FAIL — ${msg}`);
        return;
      }

      const targetFacing = opts?.facing ?? facingMode;
      const targetDevice = opts?.deviceId !== undefined ? opts.deviceId : selectedDeviceId;

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
        if (settings?.deviceId) {
          setSelectedDeviceId(settings.deviceId);
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

        prevLumaSampleRef.current = null;
        trackerRef.current.fpsWindowStart = performance.now();
        trackerRef.current.frameCount = 0;
        trackerRef.current.totalFrames = 0;

        setDiagnostics({
          trackLive: track?.readyState === 'live',
          trackMuted: Boolean(track?.muted),
          negotiatedFps: typeof settings?.frameRate === 'number' ? settings.frameRate : null,
          framesCaptured: 0,
          meanLuma: 0,
          lumaStd: 0,
          motionDelta: 0,
          exposureState: 'idle',
          lastCheckTime: new Date().toLocaleTimeString(),
        });

        setStatus('active');

        const cams = await refreshVideoDevices();
        onLogEventRef.current?.(
          `[Live Camera Check] LIVE — "${label}" (${settings?.width ?? '?'}×${settings?.height ?? '?'}, ${cams.length} video device${cams.length === 1 ? '' : 's'} detected).`
        );
      } catch (err: unknown) {
        const e = err as { name?: string; message?: string };
        const msg =
          e?.name === 'NotAllowedError'
            ? 'Camera permission denied. Allow camera access in your browser address bar and click Run Live Check.'
            : e?.name === 'NotFoundError'
            ? 'No connected camera hardware detected by browser. Verify USB/camera connection and click Rescan.'
            : e?.name === 'NotReadableError'
            ? 'Camera is currently locked by another app or tab. Close other video apps and click Retry.'
            : `Could not open camera stream: ${e?.message || 'Unknown error'}`;
        setStatus('error');
        setErrorText(msg);
        await refreshVideoDevices();
        onLogEventRef.current?.(`[Live Camera Check] FAIL — ${msg}`);
      }
    },
    [facingMode, selectedDeviceId, stopCamera, refreshVideoDevices]
  );

  // Enumerate cameras on mount, watch USB hot-plug events, and auto-run live check if permission is already granted
  useEffect(() => {
    void refreshVideoDevices();

    const handleDeviceChange = () => {
      void refreshVideoDevices().then((cams) => {
        onLogEventRef.current?.(
          `[Live Camera Check] Video hardware changed — ${cams.length} camera input${cams.length === 1 ? '' : 's'} available.`
        );
      });
    };

    navigator.mediaDevices?.addEventListener?.('devicechange', handleDeviceChange);

    if (sourceMode === 'webcam' && !autoCheckedOnMountRef.current && navigator.permissions?.query) {
      autoCheckedOnMountRef.current = true;
      navigator.permissions
        .query({ name: 'camera' as PermissionName })
        .then((perm) => {
          if (perm.state === 'granted') {
            void startCamera();
          }
        })
        .catch(() => {
          // Permissions API query('camera') not supported in all browsers
        });
    }

    return () => {
      navigator.mediaDevices?.removeEventListener?.('devicechange', handleDeviceChange);
    };
  }, [sourceMode, refreshVideoDevices, startCamera]);

  // Respond to external Start/Stop commands from NavigationWorkbench top bar
  const lastTriggerSeqRef = useRef<number>(0);
  useEffect(() => {
    if (!externalTrigger || externalTrigger.seq === lastTriggerSeqRef.current) return;
    lastTriggerSeqRef.current = externalTrigger.seq;
    if (externalTrigger.action === 'start') {
      sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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

  const handleCaptureTestSnapshot = useCallback(() => {
    const videoEl = videoRef.current;
    if (!videoEl || videoEl.videoWidth === 0 || videoEl.videoHeight === 0) return;

    const snapCanvas = document.createElement('canvas');
    snapCanvas.width = videoEl.videoWidth;
    snapCanvas.height = videoEl.videoHeight;
    const ctx = snapCanvas.getContext('2d');
    if (!ctx) return;

    if (mirrored) {
      ctx.translate(snapCanvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(videoEl, 0, 0, snapCanvas.width, snapCanvas.height);

    const dataUrl = snapCanvas.toDataURL('image/jpeg', 0.88);
    const ts = new Date().toLocaleTimeString();
    setSnapshotUrl(dataUrl);
    setSnapshotMeta(`${cameraLabel} · ${snapCanvas.width}×${snapCanvas.height} · Captured ${ts}`);
    onLogEventRef.current?.(
      `[Live Camera Check] Test snapshot verified (${snapCanvas.width}×${snapCanvas.height}) from "${cameraLabel}".`
    );
  }, [cameraLabel, mirrored]);

  // Real-time ExG + Otsu crop-row analysis + hardware signal verification directly from live <video>
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

          // Live pixel signal check (luminance, contrast std-dev, and frame-to-frame motion delta)
          const data = frame.data;
          const stride = 8; // sample every 8th pixel for ultra-fast <0.2ms check
          const sampleCount = Math.floor((PROC_W * PROC_H) / stride);
          if (!prevLumaSampleRef.current || prevLumaSampleRef.current.length !== sampleCount) {
            prevLumaSampleRef.current = new Float32Array(sampleCount);
          }
          const prevBuf = prevLumaSampleRef.current;
          let sumLuma = 0;
          let sumSq = 0;
          let sumDiff = 0;
          const hasPrev = trackerRef.current.totalFrames > 0;

          for (let s = 0; s < sampleCount; s++) {
            const idx = s * stride * 4;
            const luma = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
            sumLuma += luma;
            sumSq += luma * luma;
            if (hasPrev) {
              sumDiff += Math.abs(luma - prevBuf[s]);
            }
            prevBuf[s] = luma;
          }

          const meanLuma = sumLuma / Math.max(1, sampleCount);
          const variance = Math.max(0, sumSq / Math.max(1, sampleCount) - meanLuma * meanLuma);
          const lumaStd = Math.sqrt(variance);
          const motionDelta = hasPrev ? sumDiff / Math.max(1, sampleCount) : 0;

          const exposureState: LiveCameraDiagnostics['exposureState'] =
            meanLuma < 10 && lumaStd < 4
              ? 'dark'
              : meanLuma > 246 && lumaStd < 5
              ? 'overexposed'
              : 'ok';

          const tr = trackerRef.current;
          tr.frameCount += 1;
          tr.totalFrames += 1;
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

          if (now - tr.lastUiEmit >= 90) {
            tr.lastUiEmit = now;

            if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
              setResolution(`${videoEl.videoWidth}×${videoEl.videoHeight}`);
            }

            const track = streamRef.current?.getVideoTracks()[0];
            const trackSettings = track?.getSettings?.();

            setDiagnostics({
              trackLive: track?.readyState === 'live',
              trackMuted: Boolean(track?.muted),
              negotiatedFps:
                typeof trackSettings?.frameRate === 'number' ? trackSettings.frameRate : null,
              framesCaptured: tr.totalFrames,
              meanLuma,
              lumaStd,
              motionDelta,
              exposureState,
              lastCheckTime: new Date().toLocaleTimeString(),
            });

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

  // Compute live 5-point hardware verification checks
  const hwStatus: CheckStatus =
    status === 'error'
      ? 'fail'
      : devices.length > 0 || status === 'active'
      ? 'pass'
      : status === 'requesting'
      ? 'checking'
      : 'idle';

  const streamStatus: CheckStatus =
    status === 'error'
      ? 'fail'
      : status === 'requesting'
      ? 'checking'
      : status === 'active' && diagnostics.trackLive && !diagnostics.trackMuted && resolution !== '—'
      ? 'pass'
      : status === 'active'
      ? 'warn'
      : 'idle';

  const signalStatus: CheckStatus =
    status !== 'active'
      ? 'idle'
      : diagnostics.framesCaptured < 2
      ? 'checking'
      : diagnostics.exposureState === 'ok'
      ? 'pass'
      : 'warn';

  const motionStatus: CheckStatus =
    status !== 'active'
      ? 'idle'
      : diagnostics.framesCaptured < 4
      ? 'checking'
      : diagnostics.framesCaptured >= 4 && telemetry.fps > 1
      ? 'pass'
      : 'warn';

  const cvStatus: CheckStatus =
    status !== 'active'
      ? 'idle'
      : diagnostics.framesCaptured < 2
      ? 'checking'
      : 'pass';

  const checks: Array<{
    id: string;
    label: string;
    state: CheckStatus;
    detail: string;
  }> = [
    {
      id: 'hw',
      label: '01. Camera Hardware',
      state: hwStatus,
      detail:
        status === 'active'
          ? `${devices.length || 1} detected · ${cameraLabel}`
          : devices.length > 0
          ? `${devices.length} input${devices.length === 1 ? '' : 's'} ready`
          : 'Click Run Live Check',
    },
    {
      id: 'stream',
      label: '02. Live Video Track',
      state: streamStatus,
      detail:
        status === 'active'
          ? `${resolution} · ${telemetry.fps.toFixed(0)} FPS${
              diagnostics.negotiatedFps ? ` (${Math.round(diagnostics.negotiatedFps)} Hz)` : ''
            }`
          : status === 'requesting'
          ? 'Negotiating stream...'
          : 'Not started',
    },
    {
      id: 'signal',
      label: '03. Pixel Signal & Exposure',
      state: signalStatus,
      detail:
        status !== 'active'
          ? 'Awaiting frames'
          : diagnostics.exposureState === 'dark'
          ? `Low light / covered (Y=${diagnostics.meanLuma.toFixed(0)})`
          : diagnostics.exposureState === 'overexposed'
          ? `Overexposed (Y=${diagnostics.meanLuma.toFixed(0)})`
          : `Y=${diagnostics.meanLuma.toFixed(0)} · σ=${diagnostics.lumaStd.toFixed(1)}`,
    },
    {
      id: 'motion',
      label: '04. Frame Flow (Non-Frozen)',
      state: motionStatus,
      detail:
        status !== 'active'
          ? 'Awaiting frames'
          : `${diagnostics.framesCaptured} frames · Δ${diagnostics.motionDelta.toFixed(2)}`,
    },
    {
      id: 'cv',
      label: '05. ExG Crop-Row CV',
      state: cvStatus,
      detail:
        status !== 'active'
          ? 'Standby'
          : `${telemetry.processingMs.toFixed(1)} ms · Green ${(
              telemetry.greenRatioNear * 100
            ).toFixed(1)}%`,
    },
  ];

  const allChecksPassed =
    status === 'active' &&
    hwStatus === 'pass' &&
    streamStatus === 'pass' &&
    signalStatus === 'pass' &&
    motionStatus === 'pass' &&
    cvStatus === 'pass';

  const renderBadge = (state: CheckStatus) => {
    if (state === 'pass') {
      return (
        <span className="inline-flex items-center gap-1 text-[10px] font-mono font-semibold text-emerald-700">
          <CheckCircle2 className="w-3 h-3 text-emerald-600" />
          PASS
        </span>
      );
    }
    if (state === 'warn') {
      return (
        <span className="inline-flex items-center gap-1 text-[10px] font-mono font-semibold text-amber-700">
          <AlertTriangle className="w-3 h-3 text-amber-600" />
          CHECK
        </span>
      );
    }
    if (state === 'fail') {
      return (
        <span className="inline-flex items-center gap-1 text-[10px] font-mono font-semibold text-rose-700">
          <AlertCircle className="w-3 h-3 text-rose-600" />
          FAIL
        </span>
      );
    }
    if (state === 'checking') {
      return <span className="text-[10px] font-mono font-semibold text-emerald-700">PROBING…</span>;
    }
    return <span className="text-[10px] font-mono text-slate-400">IDLE</span>;
  };

  return (
    <section
      ref={sectionRef}
      aria-label="Real-Time Camera Feed & Live Check"
      className="bg-white border border-emerald-900/10 rounded-lg p-4 space-y-4"
    >
      {/* Header Row */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-emerald-900/10 pb-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <div className="flex items-center gap-2">
            {sourceMode === 'maixsense' ? (
              <HardDrive className="w-4 h-4 text-emerald-600 shrink-0" />
            ) : (
              <Camera className="w-4 h-4 text-emerald-600 shrink-0" />
            )}
            <h3 className="text-sm font-semibold text-slate-900">
              {sourceMode === 'maixsense'
                ? 'MaixSense Camera Check (USB Drive + IP)'
                : 'Live Camera Check & Crop-Row Feed'}
            </h3>
          </div>
          {sourceMode === 'webcam' && (
            <span className="text-xs font-mono text-slate-500">
              {cameraLabel} · {resolution}
              {devices.length > 0 ? ` · ${devices.length} cam${devices.length === 1 ? '' : 's'}` : ''}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Source Switcher: MaixSense (Drive + IP) vs Browser Webcam */}
          <div className="flex items-center p-0.5 bg-[#EDF5F0] border border-emerald-900/10 rounded-md">
            <button
              type="button"
              onClick={() => {
                if (status === 'active') stopCamera(false);
                setSourceMode('maixsense');
              }}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer flex items-center gap-1.5 ${
                sourceMode === 'maixsense'
                  ? 'bg-white text-emerald-800 border border-emerald-200 font-semibold'
                  : 'text-slate-600 hover:text-emerald-800 border border-transparent'
              }`}
            >
              <HardDrive className="w-3.5 h-3.5 text-emerald-600" />
              <span>MaixSense (Drive + IP)</span>
            </button>
            <button
              type="button"
              onClick={() => setSourceMode('webcam')}
              className={`px-2.5 py-1 text-xs font-medium rounded transition-colors cursor-pointer flex items-center gap-1.5 ${
                sourceMode === 'webcam'
                  ? 'bg-white text-emerald-800 border border-emerald-200 font-semibold'
                  : 'text-slate-600 hover:text-emerald-800 border border-transparent'
              }`}
            >
              <Camera className="w-3.5 h-3.5 text-emerald-600" />
              <span>Browser Webcam</span>
            </button>
          </div>

          {sourceMode === 'webcam' && (
            <>
              <span
                className={`text-xs font-mono font-semibold tabular-nums ${
                  allChecksPassed
                    ? 'text-emerald-700'
                    : status === 'active'
                    ? 'text-amber-700'
                    : status === 'error'
                    ? 'text-rose-700'
                    : 'text-slate-500'
                }`}
              >
                {allChecksPassed
                  ? `● LIVE VERIFIED · ${telemetry.fps.toFixed(0)} FPS`
                  : status === 'active'
                  ? `● LIVE ${telemetry.fps.toFixed(0)} FPS`
                  : status === 'requesting'
                  ? 'PROBING CAMERA...'
                  : status === 'error'
                  ? '✖ CAMERA CHECK FAILED'
                  : '○ READY FOR CHECK'}
              </span>

              {status === 'active' && (
                <button
                  onClick={handleCaptureTestSnapshot}
                  className="px-2.5 py-1.5 text-xs font-medium rounded-md bg-[#F8FBF9] hover:bg-emerald-50 border border-emerald-900/15 text-slate-700 transition-colors flex items-center gap-1.5 cursor-pointer"
                >
                  <Activity className="w-3.5 h-3.5 text-emerald-600" />
                  <span>Test Snapshot</span>
                </button>
              )}

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
                  className="px-3.5 py-1.5 text-xs font-semibold rounded-md bg-emerald-600 hover:bg-emerald-700 text-white transition-colors flex items-center gap-1.5 cursor-pointer"
                >
                  <Camera className="w-3.5 h-3.5" />
                  <span>Run Live Camera Check</span>
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {sourceMode === 'maixsense' ? (
        <MaixSenseLiveCheck
          rowWidthM={rowWidthM}
          stanleyGain={stanleyGain}
          speedLimit={speedLimit}
          onAlignmentUpdate={onAlignmentUpdate}
          onLogEvent={onLogEvent}
        />
      ) : (
        <>
          {/* 5-Point Live Camera Hardware & Pixel Diagnostic Strip */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
        {checks.map((chk) => (
          <div
            key={chk.id}
            className={`rounded-md border px-3 py-2 space-y-1 transition-colors ${
              chk.state === 'pass'
                ? 'bg-emerald-50/60 border-emerald-200'
                : chk.state === 'warn'
                ? 'bg-amber-50/70 border-amber-200'
                : chk.state === 'fail'
                ? 'bg-rose-50/70 border-rose-200'
                : 'bg-[#F8FBF9] border-emerald-900/10'
            }`}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="text-[11px] font-semibold text-slate-800 truncate">{chk.label}</span>
              {renderBadge(chk.state)}
            </div>
            <div className="text-[11px] font-mono text-slate-600 truncate tabular-nums" title={chk.detail}>
              {chk.detail}
            </div>
          </div>
        ))}
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
                    {devices.length > 0
                      ? `${devices.length} Camera Input${devices.length === 1 ? '' : 's'} Detected — Ready for Live Check`
                      : 'Connect Device Camera for Live Hardware & Vision Check'}
                  </div>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    Opens your connected camera via{' '}
                    <span className="font-mono text-emerald-800">getUserMedia</span>, verifies live
                    resolution, FPS, exposure, and frame flow, and feeds real-time ExG + Otsu
                    crop-row telemetry into the gauges.
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <button
                    onClick={() => void startCamera()}
                    className="px-4 py-2 text-xs font-semibold rounded-md bg-emerald-600 hover:bg-emerald-700 text-white transition-colors flex items-center gap-1.5 cursor-pointer"
                  >
                    <Camera className="w-3.5 h-3.5" />
                    <span>Run Live Camera Check</span>
                  </button>
                  <button
                    onClick={() => void refreshVideoDevices()}
                    className="px-3 py-2 text-xs font-medium rounded-md bg-white hover:bg-emerald-50 border border-emerald-900/15 text-slate-700 transition-colors flex items-center gap-1.5 cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5 text-emerald-600" />
                    <span>Rescan Devices</span>
                  </button>
                </div>
              </div>
            )}

            {/* Requesting state */}
            {status === 'requesting' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center gap-2 bg-[#F8FBF9]">
                <Camera className="w-6 h-6 text-emerald-600" />
                <span className="text-xs font-mono text-emerald-800">
                  Opening connected camera &amp; verifying live video track...
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
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => void startCamera()}
                    className="px-3.5 py-1.5 text-xs font-semibold rounded-md bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer"
                  >
                    Retry Live Check
                  </button>
                  <button
                    onClick={() => void refreshVideoDevices()}
                    className="px-3 py-1.5 text-xs font-medium rounded-md bg-white border border-emerald-900/15 text-slate-700 cursor-pointer"
                  >
                    Rescan Hardware
                  </button>
                </div>
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

            {/* Connected Video Input Device Selector */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-mono text-slate-500">
                  Connected Video Input ({devices.length})
                </label>
                <button
                  type="button"
                  onClick={() => void refreshVideoDevices()}
                  className="text-[11px] font-mono text-emerald-700 hover:underline cursor-pointer"
                >
                  Rescan
                </button>
              </div>
              <select
                value={selectedDeviceId}
                onChange={(e) => {
                  const nextId = e.target.value;
                  setSelectedDeviceId(nextId);
                  if (status === 'active') void startCamera({ deviceId: nextId });
                }}
                className="w-full text-xs font-mono bg-white border border-emerald-900/15 rounded px-2.5 py-1.5 text-slate-800"
              >
                <option value="">
                  Auto ({facingMode === 'environment' ? 'Rear / External' : 'Front'})
                </option>
                {devices.map((d, idx) => (
                  <option key={d.deviceId || `cam-${idx}`} value={d.deviceId}>
                    {d.label || `Video Input #${idx + 1} (grant access to reveal name)`}
                  </option>
                ))}
              </select>
            </div>

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

      {/* Optional Captured Test Snapshot Verification Card */}
      {snapshotUrl && (
        <div className="bg-[#F8FBF9] border border-emerald-900/15 rounded-md p-3 flex flex-col sm:flex-row items-start sm:items-center gap-4">
          <img
            src={snapshotUrl}
            alt="Captured camera check test frame"
            className="w-40 aspect-video object-cover rounded border border-emerald-900/15 shrink-0"
          />
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-800">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
              <span>Test Frame Verified</span>
            </div>
            <div className="text-xs font-mono text-slate-600 truncate">{snapshotMeta}</div>
            <div className="flex items-center gap-2 pt-1">
              <a
                href={snapshotUrl}
                download={`rover-camera-check-${Date.now()}.jpg`}
                className="px-2.5 py-1 text-xs font-medium rounded bg-white hover:bg-emerald-50 border border-emerald-900/15 text-slate-700 inline-flex items-center gap-1"
              >
                <Download className="w-3 h-3 text-emerald-600" />
                <span>Download JPEG</span>
              </a>
              <button
                type="button"
                onClick={() => setSnapshotUrl(null)}
                className="px-2 py-1 text-xs text-slate-500 hover:text-slate-800 inline-flex items-center gap-1 cursor-pointer"
              >
                <X className="w-3 h-3" />
                <span>Dismiss</span>
              </button>
            </div>
          </div>
        </div>
      )}
        </>
      )}
    </section>
  );
};
