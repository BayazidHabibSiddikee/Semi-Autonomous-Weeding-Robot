import { useCallback, useEffect, useRef, useState } from 'react';
import type { VisionAlignmentData } from '../components/CropRowAlignmentGauge';
import {
  CameraOverlayMode,
  detectCropRowFromFrame,
  renderVisionOverlay,
} from './cropRowVision';

export type VisionSourceMode = 'webcam' | 'media' | 'sim';
export type CameraStatus = 'idle' | 'requesting' | 'active' | 'error';

export interface LiveCameraDiagnostics {
  fps: number;
  processingMs: number;
  otsuThreshold: number;
  greenRatioNear: number;
  greenRatioFar: number;
  detectionMode: 'dual_row' | 'single_band' | 'none';
  sourceLabel: string;
}

interface UseLiveCameraVisionOptions {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  rowWidthM: number;
  stanleyGain: number;
  speedLimit: number;
  minExgFloor: number;
  overlayMode: CameraOverlayMode;
  onLogEvent?: (msg: string) => void;
}

const ALPHA_LAT = 0.35;
const ALPHA_YAW = 0.3;
const MAX_MISSED_FRAMES = 12;
const PROC_W = 340;
const PROC_H = 240;

export function useLiveCameraVision({
  canvasRef,
  rowWidthM,
  stanleyGain,
  speedLimit,
  minExgFloor,
  overlayMode,
  onLogEvent,
}: UseLiveCameraVisionOptions) {
  const [sourceMode, setSourceMode] = useState<VisionSourceMode>('sim');
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>('idle');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [mediaFileName, setMediaFileName] = useState<string | null>(null);

  const [alignment, setAlignment] = useState<VisionAlignmentData>({
    trackingLocked: false,
    lateralOffsetM: 0,
    rawLateralOffsetM: 0,
    headingErrorRad: 0,
    rawHeadingErrorRad: 0,
    rowWidthM,
    rowEndConfidence: 0,
    missedFrames: 0,
    cmdWzRadS: 0,
    currentRow: 1,
    sourceLabel: 'LIVE CAMERA · ExG + Otsu',
  });

  const [diagnostics, setDiagnostics] = useState<LiveCameraDiagnostics>({
    fps: 0,
    processingMs: 0,
    otsuThreshold: minExgFloor,
    greenRatioNear: 0,
    greenRatioFar: 0,
    detectionMode: 'none',
    sourceLabel: 'Idle',
  });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const workCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const paramsRef = useRef({
    rowWidthM,
    stanleyGain,
    speedLimit,
    minExgFloor,
    overlayMode,
  });

  useEffect(() => {
    paramsRef.current = {
      rowWidthM,
      stanleyGain,
      speedLimit,
      minExgFloor,
      overlayMode,
    };
  }, [rowWidthM, stanleyGain, speedLimit, minExgFloor, overlayMode]);

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

  const stopTracksAndMedia = useCallback(() => {
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
    setMediaFileName(null);
  }, []);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const cams = all.filter((d) => d.kind === 'videoinput');
      setDevices(cams);
    } catch {
      // Ignore enumeration errors before permission granted
    }
  }, []);

  const startWebcam = useCallback(
    async (opts?: { facing?: 'environment' | 'user'; deviceId?: string }) => {
      stopTracksAndMedia();
      setCameraError(null);
      setCameraStatus('requesting');
      setSourceMode('webcam');

      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setCameraStatus('error');
        setCameraError(
          'Browser camera API (getUserMedia) is unavailable in this context. Upload a real video or photo instead.'
        );
        return;
      }

      const targetFacing = opts?.facing ?? facingMode;
      const targetDeviceId = opts?.deviceId ?? selectedDeviceId;

      const videoConstraints: MediaTrackConstraints = targetDeviceId
        ? {
            deviceId: { exact: targetDeviceId },
            width: { ideal: 640 },
            height: { ideal: 480 },
          }
        : {
            facingMode: { ideal: targetFacing },
            width: { ideal: 640 },
            height: { ideal: 480 },
          };

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: videoConstraints,
          audio: false,
        });
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

        const trackLabel = stream.getVideoTracks()[0]?.label || 'Web Camera';
        setCameraStatus('active');
        setDiagnostics((prev) => ({ ...prev, sourceLabel: trackLabel }));
        trackerRef.current.missedFrames = 0;
        trackerRef.current.hasEverLocked = false;
        await refreshDevices();

        onLogEvent?.(
          `[Vision] Real-time webcam active (${trackLabel}) — running live ExG + Otsu crop-row centerline CV.`
        );
      } catch (err: any) {
        const msg =
          err?.name === 'NotAllowedError'
            ? 'Camera permission denied. Allow camera access in your browser bar or upload a real field video/image.'
            : err?.name === 'NotFoundError'
            ? 'No webcam detected on this device. You can upload a real field video or photo to test live CV.'
            : `Unable to open camera (${err?.message || 'Unknown error'}).`;
        setCameraStatus('error');
        setCameraError(msg);
        onLogEvent?.(`[Vision] Webcam error: ${msg}`);
      }
    },
    [facingMode, selectedDeviceId, stopTracksAndMedia, refreshDevices, onLogEvent]
  );

  const switchFacingMode = useCallback(() => {
    const next = facingMode === 'environment' ? 'user' : 'environment';
    setFacingMode(next);
    setSelectedDeviceId('');
    if (sourceMode === 'webcam') {
      void startWebcam({ facing: next, deviceId: '' });
    }
  }, [facingMode, sourceMode, startWebcam]);

  const selectDevice = useCallback(
    (deviceId: string) => {
      setSelectedDeviceId(deviceId);
      if (sourceMode === 'webcam') {
        void startWebcam({ deviceId });
      }
    },
    [sourceMode, startWebcam]
  );

  const loadMediaFile = useCallback(
    (file: File) => {
      stopTracksAndMedia();
      setCameraError(null);
      setSourceMode('media');
      setMediaFileName(file.name);

      const url = URL.createObjectURL(file);
      objectUrlRef.current = url;

      if (file.type.startsWith('video/')) {
        setCameraStatus('requesting');
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
            setCameraStatus('active');
            setDiagnostics((prev) => ({ ...prev, sourceLabel: file.name }));
            onLogEvent?.(
              `[Vision] Running real-time ExG + Otsu crop-row CV on uploaded video: ${file.name}`
            );
          })
          .catch((e) => {
            setCameraStatus('error');
            setCameraError(`Could not play video file: ${e?.message || 'unsupported format'}`);
          });
      } else if (file.type.startsWith('image/')) {
        setCameraStatus('requesting');
        const img = new Image();
        img.onload = () => {
          imageRef.current = img;
          setCameraStatus('active');
          setDiagnostics((prev) => ({ ...prev, sourceLabel: file.name }));
          onLogEvent?.(
            `[Vision] Running ExG + Otsu crop-row CV on uploaded image: ${file.name}`
          );
        };
        img.onerror = () => {
          setCameraStatus('error');
          setCameraError('Could not decode uploaded image file.');
        };
        img.src = url;
      } else {
        setCameraStatus('error');
        setCameraError('Please select a video (.mp4, .webm, .mov) or image (.jpg, .png) file.');
      }
    },
    [stopTracksAndMedia, onLogEvent]
  );

  const switchToSim = useCallback(() => {
    stopTracksAndMedia();
    setCameraStatus('idle');
    setCameraError(null);
    setSourceMode('sim');
    onLogEvent?.('[Vision] Switched Forward Nav Camera back to Field Simulator feed.');
  }, [stopTracksAndMedia, onLogEvent]);

  // Cleanup camera stream on unmount
  useEffect(() => {
    return () => {
      stopTracksAndMedia();
    };
  }, [stopTracksAndMedia]);

  // Real-time pixel CV loop when webcam or uploaded media is active
  useEffect(() => {
    if (sourceMode === 'sim' || cameraStatus !== 'active') return;

    if (!workCanvasRef.current) {
      const c = document.createElement('canvas');
      c.width = PROC_W;
      c.height = PROC_H;
      workCanvasRef.current = c;
    }

    let rafId = 0;

    const processFrame = (now: number) => {
      const displayCanvas = canvasRef.current;
      const workCanvas = workCanvasRef.current;
      if (!displayCanvas || !workCanvas) {
        rafId = requestAnimationFrame(processFrame);
        return;
      }

      const workCtx = workCanvas.getContext('2d', { willReadFrequently: true });
      const displayCtx = displayCanvas.getContext('2d');
      if (!workCtx || !displayCtx) {
        rafId = requestAnimationFrame(processFrame);
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
        const { observation, mask } = detectCropRowFromFrame(frame, {
          rowWidthM: p.rowWidthM,
          minExgFloor: p.minExgFloor,
        });

        const tr = trackerRef.current;
        tr.frameCount += 1;
        const elapsedFps = now - tr.fpsWindowStart;
        if (elapsedFps >= 500) {
          tr.currentFps = (tr.frameCount * 1000) / elapsedFps;
          tr.frameCount = 0;
          tr.fpsWindowStart = now;
        }

        // Update EMA CropRowTracker with real camera measurement
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

        const effectiveLocked =
          observation.valid || (tr.hasEverLocked && tr.missedFrames <= MAX_MISSED_FRAMES);

        // Real Stanley steering output from live camera alignment
        const cmdWz = effectiveLocked
          ? Math.max(
              -0.8,
              Math.min(
                0.8,
                -(p.stanleyGain * Math.atan2(tr.latM, Math.max(p.speedLimit, 0.08)) + tr.yawRad)
              )
            )
          : 0;

        // Ensure display canvas dimensions match working resolution for crisp 1:1 overlay
        if (displayCanvas.width !== PROC_W || displayCanvas.height !== PROC_H) {
          displayCanvas.width = PROC_W;
          displayCanvas.height = PROC_H;
        }

        renderVisionOverlay(displayCtx, frame, mask, observation, p.overlayMode, tr.currentFps);

        // Emit React UI state at ~15 Hz to keep gauges smooth without flooding React reconciliation
        if (now - tr.lastUiEmit >= 65) {
          tr.lastUiEmit = now;
          const label =
            sourceMode === 'webcam'
              ? `LIVE WEBCAM · ${tr.currentFps.toFixed(0)} FPS · ${observation.processingMs.toFixed(1)} ms`
              : `MEDIA CV (${mediaFileName || 'file'}) · ${observation.processingMs.toFixed(1)} ms`;

          setAlignment({
            trackingLocked: effectiveLocked,
            lateralOffsetM: tr.latM,
            rawLateralOffsetM: observation.valid ? observation.lateralErrorM : tr.latM,
            headingErrorRad: tr.yawRad,
            rawHeadingErrorRad: observation.valid ? observation.headingErrorRad : tr.yawRad,
            rowWidthM: p.rowWidthM,
            rowEndConfidence: observation.rowEndConfidence,
            missedFrames: tr.missedFrames,
            cmdWzRadS: cmdWz,
            currentRow: 1,
            sourceLabel: label,
          });

          setDiagnostics((prev) => ({
            ...prev,
            fps: tr.currentFps,
            processingMs: observation.processingMs,
            otsuThreshold: observation.otsuThreshold,
            greenRatioNear: observation.greenRatioNear,
            greenRatioFar: observation.greenRatioFar,
            detectionMode: observation.mode,
          }));
        }
      }

      rafId = requestAnimationFrame(processFrame);
    };

    rafId = requestAnimationFrame(processFrame);
    return () => cancelAnimationFrame(rafId);
  }, [sourceMode, cameraStatus, canvasRef, mediaFileName]);

  return {
    sourceMode,
    cameraStatus,
    cameraError,
    facingMode,
    devices,
    selectedDeviceId,
    mediaFileName,
    alignment,
    diagnostics,
    startWebcam,
    switchFacingMode,
    selectDevice,
    loadMediaFile,
    switchToSim,
  };
}
