import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  CameraOff,
  Radio,
  Wifi,
  WifiOff,
  Upload,
  RefreshCw,
  Copy,
  Check,
  Smartphone,
  SlidersHorizontal,
} from 'lucide-react';
import type { VisionAlignmentData } from './CropRowAlignmentGauge';
import {
  CameraOverlayMode,
  detectCropRowFromFrame,
  renderVisionOverlay,
} from '../vision/cropRowVision';

export type StreamTransportMode = 'local' | 'webrtc' | 'websocket' | 'media' | 'sim';

interface PublisherInfo {
  id: string;
  label: string;
  transport: string;
  connectedAt: number;
}

interface Props {
  simCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  rowWidthM: number;
  stanleyGain: number;
  speedLimit: number;
  simRowEndConf: number;
  simBoundaryOk: boolean;
  simAlignment: VisionAlignmentData;
  onAlignmentChange: (alignment: VisionAlignmentData, isLive: boolean) => void;
  onStreamModeChange?: (mode: StreamTransportMode) => void;
  onLogEvent: (msg: string) => void;
  /** External trigger counter so top-bar buttons in NavigationWorkbench can start/stop stream */
  externalAction?: { type: 'start_local' | 'start_webrtc' | 'start_ws' | 'stop_to_sim'; seq: number } | null;
}

const PROC_W = 340;
const PROC_H = 240;
const ALPHA_LAT = 0.35;
const ALPHA_YAW = 0.3;
const MAX_MISSED_FRAMES = 12;

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

function getDefaultWsBase(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws/camera`;
}

export const RealTimeCameraStream: React.FC<Props> = ({
  simCanvasRef,
  rowWidthM,
  stanleyGain,
  speedLimit,
  simRowEndConf,
  simBoundaryOk,
  simAlignment,
  onAlignmentChange,
  onStreamModeChange,
  onLogEvent,
  externalAction,
}) => {
  const [mode, setMode] = useState<StreamTransportMode>('sim');
  const [roomId, setRoomId] = useState<string>('rover-01');
  const [customWsUrl, setCustomWsUrl] = useState<string>(() => getDefaultWsBase());
  const [overlayMode, setOverlayMode] = useState<CameraOverlayMode>('overlay');
  const [minExgFloor, setMinExgFloor] = useState<number>(22);
  const [facingMode, setFacingMode] = useState<'environment' | 'user'>('environment');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');

  const [connStatus, setConnStatus] = useState<'idle' | 'connecting' | 'waiting' | 'streaming' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [iceState, setIceState] = useState<string>('new');
  const [publishers, setPublishers] = useState<PublisherInfo[]>([]);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [showControls, setShowControls] = useState<boolean>(true);
  const [mediaFileName, setMediaFileName] = useState<string | null>(null);

  const [liveStats, setLiveStats] = useState({
    fps: 0,
    processingMs: 0,
    kbps: 0,
    otsuThreshold: 22,
    greenRatioNear: 0,
    greenRatioFar: 0,
    detectionMode: 'none' as 'dual_row' | 'single_band' | 'none',
    rowEndConf: 0,
    latM: 0,
    yawRad: 0,
    trackingLocked: false,
  });

  // Rendering & capture refs
  const liveCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const workCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  const imageElRef = useRef<HTMLImageElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Network refs (WebSocket + WebRTC)
  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const latestBitmapRef = useRef<ImageBitmap | null>(null);
  const wsBytesWindowRef = useRef({ bytes: 0, start: performance.now(), kbps: 0 });
  const decodingFrameRef = useRef<boolean>(false);

  const paramsRef = useRef({
    rowWidthM,
    stanleyGain,
    speedLimit,
    minExgFloor,
    overlayMode,
    mode,
    roomId,
    mediaFileName,
  });

  useEffect(() => {
    paramsRef.current = {
      rowWidthM,
      stanleyGain,
      speedLimit,
      minExgFloor,
      overlayMode,
      mode,
      roomId,
      mediaFileName,
    };
  }, [rowWidthM, stanleyGain, speedLimit, minExgFloor, overlayMode, mode, roomId, mediaFileName]);

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

  const resetTracker = useCallback(() => {
    trackerRef.current.missedFrames = 0;
    trackerRef.current.hasEverLocked = false;
    trackerRef.current.frameCount = 0;
    trackerRef.current.fpsWindowStart = performance.now();
    trackerRef.current.currentFps = 0;
  }, []);

  const cleanupAllTransports = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (pcRef.current) {
      try {
        pcRef.current.ontrack = null;
        pcRef.current.onicecandidate = null;
        pcRef.current.onconnectionstatechange = null;
        pcRef.current.close();
      } catch {
        // ignore
      }
      pcRef.current = null;
    }
    if (wsRef.current) {
      try {
        wsRef.current.onopen = null;
        wsRef.current.onmessage = null;
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    }
    if (videoElRef.current) {
      videoElRef.current.pause();
      videoElRef.current.srcObject = null;
      videoElRef.current.removeAttribute('src');
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    if (latestBitmapRef.current) {
      latestBitmapRef.current.close();
      latestBitmapRef.current = null;
    }
    imageElRef.current = null;
    setMediaFileName(null);
    setPublishers([]);
    setIceState('new');
  }, []);

  const ensureVideoEl = () => {
    if (!videoElRef.current) {
      const v = document.createElement('video');
      v.playsInline = true;
      v.muted = true;
      v.autoplay = true;
      videoElRef.current = v;
    }
    return videoElRef.current;
  };

  const refreshCameraDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setDevices(list.filter((d) => d.kind === 'videoinput'));
    } catch {
      // ignore
    }
  }, []);

  // 1. Local Device Camera (getUserMedia)
  const startLocalCamera = useCallback(
    async (opts?: { facing?: 'environment' | 'user'; deviceId?: string }) => {
      cleanupAllTransports();
      resetTracker();
      setErrorMsg(null);
      setMode('local');
      onStreamModeChange?.('local');
      setConnStatus('connecting');

      if (!navigator.mediaDevices?.getUserMedia) {
        setConnStatus('error');
        setErrorMsg('Browser camera API (getUserMedia) is unavailable. Use WebRTC/WS or upload a video.');
        return;
      }

      const targetFacing = opts?.facing ?? facingMode;
      const targetDev = opts?.deviceId ?? selectedDeviceId;

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: targetDev
            ? { deviceId: { exact: targetDev }, width: { ideal: 640 }, height: { ideal: 480 } }
            : { facingMode: { ideal: targetFacing }, width: { ideal: 640 }, height: { ideal: 480 } },
          audio: false,
        });
        localStreamRef.current = stream;
        const vid = ensureVideoEl();
        vid.srcObject = stream;
        await vid.play();

        const label = stream.getVideoTracks()[0]?.label || 'Device Camera';
        setConnStatus('streaming');
        await refreshCameraDevices();
        onLogEvent(`[Camera] Local device stream active (${label}) — real-time ExG + Otsu crop-row CV running.`);
      } catch (err: any) {
        const msg =
          err?.name === 'NotAllowedError'
            ? 'Camera permission denied. Allow camera access or switch to WebRTC / WebSocket stream.'
            : err?.name === 'NotFoundError'
            ? 'No local webcam found. Use WebRTC Peer or CameraX WebSocket to receive a phone/rover feed.'
            : `Camera error: ${err?.message || 'Unable to access device camera'}`;
        setConnStatus('error');
        setErrorMsg(msg);
        onLogEvent(`[Camera] ${msg}`);
      }
    },
    [cleanupAllTransports, resetTracker, facingMode, selectedDeviceId, refreshCameraDevices, onStreamModeChange, onLogEvent]
  );

  // Helper: decode incoming binary JPEG Blob or base64 JPEG into ImageBitmap for CV canvas
  const ingestJpegBlob = useCallback((blob: Blob) => {
    const win = wsBytesWindowRef.current;
    win.bytes += blob.size;
    const now = performance.now();
    if (now - win.start >= 1000) {
      win.kbps = (win.bytes * 8) / 1000 / ((now - win.start) / 1000);
      win.bytes = 0;
      win.start = now;
    }

    if (decodingFrameRef.current) return; // drop frame if previous decode still in flight
    decodingFrameRef.current = true;
    createImageBitmap(blob)
      .then((bmp) => {
        if (latestBitmapRef.current) {
          latestBitmapRef.current.close();
        }
        latestBitmapRef.current = bmp;
        setConnStatus('streaming');
      })
      .catch(() => {
        // ignore malformed frame
      })
      .finally(() => {
        decodingFrameRef.current = false;
      });
  }, []);

  // 2 & 3. WebRTC Peer OR CameraX WebSocket Receiver
  const connectRemoteStream = useCallback(
    (transport: 'webrtc' | 'websocket', targetRoom = roomId, endpointBase = customWsUrl) => {
      cleanupAllTransports();
      resetTracker();
      setErrorMsg(null);
      setMode(transport);
      onStreamModeChange?.(transport);
      setConnStatus('connecting');

      const cleanBase = endpointBase.trim() || getDefaultWsBase();
      const sep = cleanBase.includes('?') ? '&' : '?';
      const url = `${cleanBase}${sep}room=${encodeURIComponent(targetRoom)}&role=viewer&transport=${transport}`;

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
        ws.binaryType = 'blob';
      } catch (err: any) {
        setConnStatus('error');
        setErrorMsg(`Invalid WebSocket endpoint: ${err?.message || cleanBase}`);
        return;
      }

      wsRef.current = ws;

      const createViewerPeerConnection = (publisherId: string) => {
        if (pcRef.current) {
          try {
            pcRef.current.close();
          } catch {
            // ignore
          }
        }
        const pc = new RTCPeerConnection(RTC_CONFIG);
        pcRef.current = pc;

        pc.onicecandidate = (ev) => {
          if (ev.candidate && ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: 'webrtc:ice',
                to: publisherId,
                candidate: ev.candidate,
              })
            );
          }
        };

        pc.onconnectionstatechange = () => {
          setIceState(pc.connectionState);
          if (pc.connectionState === 'connected') {
            setConnStatus('streaming');
            onLogEvent(`[WebRTC] Peer video connected to room "${targetRoom}".`);
          } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            setConnStatus('waiting');
          }
        };

        pc.ontrack = (ev) => {
          const remoteStream = ev.streams[0];
          if (!remoteStream) return;
          const vid = ensureVideoEl();
          vid.srcObject = remoteStream;
          vid
            .play()
            .then(() => {
              setConnStatus('streaming');
            })
            .catch(() => {
              // muted autoplay should succeed
            });
        };

        return pc;
      };

      ws.onopen = () => {
        setConnStatus('waiting');
        setErrorMsg(null);
        onLogEvent(
          transport === 'webrtc'
            ? `[WebRTC] Connected to signaling channel (${targetRoom}) — awaiting mobile/remote camera offer.`
            : `[CameraX WS] Listening on ${targetRoom} for live binary JPEG frames.`
        );
      };

      ws.onmessage = async (event) => {
        // Binary JPEG frame from Android CameraX (OkHttp WebSocket) or browser WS publisher
        if (event.data instanceof Blob) {
          ingestJpegBlob(event.data);
          return;
        }
        if (event.data instanceof ArrayBuffer) {
          ingestJpegBlob(new Blob([event.data], { type: 'image/jpeg' }));
          return;
        }

        if (typeof event.data !== 'string') return;
        let msg: any;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        if (msg.type === 'presence') {
          const pubs: PublisherInfo[] = Array.isArray(msg.publishers) ? msg.publishers : [];
          setPublishers(pubs);
          if (transport === 'webrtc' && pubs.length > 0 && (!pcRef.current || pcRef.current.connectionState !== 'connected')) {
            // Request an offer from the first available publisher
            ws.send(JSON.stringify({ type: 'webrtc:request-offer', to: pubs[0].id }));
          }
          return;
        }

        // Base64 JSON JPEG frame fallback
        if (msg.type === 'frame:jpeg' && typeof msg.data === 'string') {
          try {
            const b64 = msg.data.includes(',') ? msg.data.split(',')[1] : msg.data;
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            ingestJpegBlob(new Blob([bytes], { type: 'image/jpeg' }));
          } catch {
            // ignore
          }
          return;
        }

        // WebRTC SDP Offer from mobile/remote publisher
        if (msg.type === 'webrtc:offer' && msg.sdp && msg.from) {
          try {
            const pc = createViewerPeerConnection(msg.from);
            await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: 'webrtc:answer',
                  to: msg.from,
                  sdp: pc.localDescription,
                })
              );
            }
          } catch (err: any) {
            setErrorMsg(`WebRTC handshake error: ${err?.message || 'failed'}`);
          }
          return;
        }

        if (msg.type === 'webrtc:ice' && msg.candidate && pcRef.current) {
          try {
            await pcRef.current.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } catch {
            // ignore stale ICE
          }
        }
      };

      ws.onerror = () => {
        setErrorMsg(`WebSocket transport error connecting to ${cleanBase}`);
      };

      ws.onclose = () => {
        if (paramsRef.current.mode === transport) {
          setConnStatus('connecting');
          reconnectTimerRef.current = window.setTimeout(() => {
            if (paramsRef.current.mode === transport) {
              connectRemoteStream(transport, targetRoom, endpointBase);
            }
          }, 2500);
        }
      };
    },
    [cleanupAllTransports, resetTracker, roomId, customWsUrl, ingestJpegBlob, onStreamModeChange, onLogEvent]
  );

  // 4. Uploaded Real Video / Photo
  const handleLoadMedia = useCallback(
    (file: File) => {
      cleanupAllTransports();
      resetTracker();
      setErrorMsg(null);
      setMode('media');
      onStreamModeChange?.('media');
      setMediaFileName(file.name);
      setConnStatus('connecting');

      const url = URL.createObjectURL(file);
      objectUrlRef.current = url;

      if (file.type.startsWith('video/')) {
        const vid = ensureVideoEl();
        vid.loop = true;
        vid.muted = true;
        vid.src = url;
        vid
          .play()
          .then(() => {
            setConnStatus('streaming');
            onLogEvent(`[Vision] Running real-time ExG + Otsu crop-row CV on uploaded video: ${file.name}`);
          })
          .catch((e) => {
            setConnStatus('error');
            setErrorMsg(`Could not play video: ${e?.message || 'unsupported format'}`);
          });
      } else if (file.type.startsWith('image/')) {
        const img = new Image();
        img.onload = () => {
          imageElRef.current = img;
          setConnStatus('streaming');
          onLogEvent(`[Vision] Running ExG + Otsu crop-row CV on uploaded image: ${file.name}`);
        };
        img.onerror = () => {
          setConnStatus('error');
          setErrorMsg('Could not decode uploaded image.');
        };
        img.src = url;
      } else {
        setConnStatus('error');
        setErrorMsg('Select a video (.mp4, .webm) or image (.jpg, .png) file.');
      }
    },
    [cleanupAllTransports, resetTracker, onStreamModeChange, onLogEvent]
  );

  // 5. Return to Field Sim
  const switchToSim = useCallback(() => {
    cleanupAllTransports();
    resetTracker();
    setErrorMsg(null);
    setConnStatus('idle');
    setMode('sim');
    onStreamModeChange?.('sim');
    onAlignmentChange(simAlignment, false);
    onLogEvent('[Camera] Switched Forward Nav Camera back to Field Simulator feed.');
  }, [cleanupAllTransports, resetTracker, onStreamModeChange, onAlignmentChange, simAlignment, onLogEvent]);

  // Respond to external top-bar actions from NavigationWorkbench
  const lastSeqRef = useRef<number>(0);
  useEffect(() => {
    if (!externalAction || externalAction.seq === lastSeqRef.current) return;
    lastSeqRef.current = externalAction.seq;
    if (externalAction.type === 'start_local') void startLocalCamera();
    else if (externalAction.type === 'start_webrtc') connectRemoteStream('webrtc');
    else if (externalAction.type === 'start_ws') connectRemoteStream('websocket');
    else if (externalAction.type === 'stop_to_sim') switchToSim();
  }, [externalAction, startLocalCamera, connectRemoteStream, switchToSim]);

  // Cleanup on unmount
  useEffect(() => {
    return () => cleanupAllTransports();
  }, [cleanupAllTransports]);

  // Real-time Pixel CV Processing Loop (runs for local, webrtc, websocket, and media!)
  useEffect(() => {
    if (mode === 'sim') return;

    if (!workCanvasRef.current) {
      const c = document.createElement('canvas');
      c.width = PROC_W;
      c.height = PROC_H;
      workCanvasRef.current = c;
    }

    let rafId = 0;

    const tick = (now: number) => {
      const displayCanvas = liveCanvasRef.current;
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
      const vid = videoElRef.current;
      const img = imageElRef.current;
      const bmp = latestBitmapRef.current;

      if (bmp && (mode === 'websocket' || (mode === 'webrtc' && (!vid || vid.readyState < 2)))) {
        workCtx.drawImage(bmp, 0, 0, PROC_W, PROC_H);
        hasFrame = true;
      } else if (vid && vid.readyState >= 2 && vid.videoWidth > 0) {
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

        const cmdWz = effectiveLocked
          ? Math.max(
              -0.8,
              Math.min(
                0.8,
                -(p.stanleyGain * Math.atan2(tr.latM, Math.max(p.speedLimit, 0.08)) + tr.yawRad)
              )
            )
          : 0;

        if (displayCanvas.width !== PROC_W || displayCanvas.height !== PROC_H) {
          displayCanvas.width = PROC_W;
          displayCanvas.height = PROC_H;
        }

        renderVisionOverlay(dispCtx, frame, mask, observation, p.overlayMode, tr.currentFps);

        if (now - tr.lastUiEmit >= 65) {
          tr.lastUiEmit = now;

          const transportTag =
            p.mode === 'webrtc'
              ? `WEBRTC (${p.roomId})`
              : p.mode === 'websocket'
              ? `WS / CAMERAX (${p.roomId})`
              : p.mode === 'media'
              ? `MEDIA (${p.mediaFileName || 'file'})`
              : 'DEVICE CAM';

          const nextAlignment: VisionAlignmentData = {
            trackingLocked: effectiveLocked,
            lateralOffsetM: tr.latM,
            rawLateralOffsetM: observation.valid ? observation.lateralErrorM : tr.latM,
            headingErrorRad: tr.yawRad,
            rawHeadingErrorRad: observation.valid ? observation.headingErrorRad : tr.yawRad,
            rowWidthM: p.rowWidthM,
            rowEndConfidence: observation.rowEndConfidence,
            greenRatioFar: observation.greenRatioFar,
            greenRatioNear: observation.greenRatioNear,
            missedFrames: tr.missedFrames,
            cmdWzRadS: cmdWz,
            currentRow: 1,
            sourceLabel: `${transportTag} · ${tr.currentFps.toFixed(0)} FPS · ${observation.processingMs.toFixed(1)} ms`,
          };

          onAlignmentChange(nextAlignment, true);
          setLiveStats({
            fps: tr.currentFps,
            processingMs: observation.processingMs,
            kbps: wsBytesWindowRef.current.kbps,
            otsuThreshold: observation.otsuThreshold,
            greenRatioNear: observation.greenRatioNear,
            greenRatioFar: observation.greenRatioFar,
            detectionMode: observation.mode,
            rowEndConf: observation.rowEndConfidence,
            latM: tr.latM,
            yawRad: tr.yawRad,
            trackingLocked: effectiveLocked,
          });
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [mode, onAlignmentChange]);

  const publisherUrl = `${window.location.origin}/?mode=camera-publisher&room=${encodeURIComponent(roomId)}`;
  const cameraXWsUri = `${customWsUrl.trim() || getDefaultWsBase()}?room=${encodeURIComponent(roomId)}&role=publisher&transport=camerax`;

  const copyText = (key: string, value: string) => {
    navigator.clipboard?.writeText(value).catch(() => {});
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey(null), 1800);
  };

  const isLive = mode !== 'sim';
  const displayedLatM = isLive ? liveStats.latM : simAlignment.lateralOffsetM;
  const displayedYawRad = isLive ? liveStats.yawRad : simAlignment.headingErrorRad;
  const displayedRowEnd = isLive ? liveStats.rowEndConf : simRowEndConf;

  return (
    <div className="lg:col-span-4 bg-white border border-emerald-900/10 rounded-lg p-4 flex flex-col gap-3">
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*,image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleLoadMedia(f);
          e.target.value = '';
        }}
      />

      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Camera className="w-4 h-4 text-emerald-600 shrink-0" />
          <h3 className="text-sm font-semibold text-slate-900 truncate">
            Real-Time Crop-Row Stream
          </h3>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className={`text-[11px] font-mono font-semibold tabular-nums ${
              mode === 'sim'
                ? 'text-slate-500'
                : connStatus === 'streaming'
                ? 'text-emerald-700'
                : connStatus === 'error'
                ? 'text-rose-700'
                : 'text-amber-700'
            }`}
          >
            {mode === 'sim'
              ? 'SIM'
              : connStatus === 'streaming'
              ? `● LIVE ${liveStats.fps.toFixed(0)} FPS`
              : connStatus === 'waiting'
              ? '○ AWAITING FEED'
              : connStatus === 'connecting'
              ? 'CONNECTING...'
              : '✖ ERROR'}
          </span>
          {isLive && (
            <button
              onClick={() => setShowControls((v) => !v)}
              title="Toggle Stream & CV Settings"
              className="p-1 rounded border border-emerald-900/10 text-slate-600 hover:bg-emerald-50 cursor-pointer"
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* 4-Way Transport Selector */}
      <div className="grid grid-cols-4 gap-1 p-0.5 bg-[#EDF5F0] border border-emerald-900/10 rounded-md">
        <button
          onClick={() => void startLocalCamera()}
          className={`py-1 text-[11px] font-medium rounded transition-colors cursor-pointer ${
            mode === 'local'
              ? 'bg-emerald-600 text-white font-semibold'
              : 'text-slate-600 hover:text-emerald-800'
          }`}
        >
          Device Cam
        </button>
        <button
          onClick={() => connectRemoteStream('webrtc')}
          className={`py-1 text-[11px] font-medium rounded transition-colors cursor-pointer ${
            mode === 'webrtc'
              ? 'bg-emerald-600 text-white font-semibold'
              : 'text-slate-600 hover:text-emerald-800'
          }`}
        >
          WebRTC
        </button>
        <button
          onClick={() => connectRemoteStream('websocket')}
          className={`py-1 text-[11px] font-medium rounded transition-colors cursor-pointer ${
            mode === 'websocket'
              ? 'bg-emerald-600 text-white font-semibold'
              : 'text-slate-600 hover:text-emerald-800'
          }`}
        >
          WS/CamX
        </button>
        <button
          onClick={switchToSim}
          className={`py-1 text-[11px] font-medium rounded transition-colors cursor-pointer ${
            mode === 'sim'
              ? 'bg-white text-emerald-800 border border-emerald-200 font-semibold'
              : 'text-slate-600 hover:text-emerald-800'
          }`}
        >
          Field Sim
        </button>
      </div>

      {/* Video Stream Canvas Viewport */}
      <div className="relative rounded border border-emerald-900/10 bg-[#141A17] overflow-hidden aspect-[340/240]">
        {/* Field Sim canvas shown only in sim mode */}
        <canvas
          ref={simCanvasRef}
          width={340}
          height={240}
          className={`w-full h-full object-cover ${mode === 'sim' ? 'block' : 'hidden'}`}
        />
        {/* Live CV canvas shown in local, webrtc, websocket, and media modes */}
        <canvas
          ref={liveCanvasRef}
          width={PROC_W}
          height={PROC_H}
          className={`w-full h-full object-cover ${isLive ? 'block' : 'hidden'}`}
        />

        {/* Waiting / Connecting / Error overlays */}
        {isLive && connStatus === 'connecting' && (
          <div className="absolute inset-0 bg-slate-950/78 flex flex-col items-center justify-center p-4 text-center gap-2">
            <Radio className="w-6 h-6 text-emerald-400" />
            <span className="text-xs font-mono text-emerald-100">
              {mode === 'local'
                ? 'Requesting device camera...'
                : `Connecting ${mode.toUpperCase()} channel (${roomId})...`}
            </span>
          </div>
        )}

        {isLive && connStatus === 'waiting' && (
          <div className="absolute inset-0 bg-slate-950/84 flex flex-col items-center justify-center p-4 text-center gap-2.5">
            {mode === 'webrtc' ? (
              <Smartphone className="w-6 h-6 text-emerald-400" />
            ) : (
              <Wifi className="w-6 h-6 text-emerald-400" />
            )}
            <div className="text-xs font-mono font-semibold text-white">
              {mode === 'webrtc'
                ? `WebRTC Ready · Room "${roomId}"`
                : `CameraX WebSocket Listening · Room "${roomId}"`}
            </div>
            <p className="text-[11px] text-slate-300 leading-relaxed max-w-[260px]">
              {mode === 'webrtc'
                ? 'Open the Mobile Camera Publisher on your phone (or another tab) to stream live WebRTC video into this console.'
                : 'Stream live JPEG frames from Android CameraX (CameraXWebSocketStreamer.kt) or open the browser Publisher in WS mode.'}
            </p>
            <div className="flex flex-wrap items-center justify-center gap-1.5">
              <button
                onClick={() => copyText('pub', publisherUrl)}
                className="px-2.5 py-1 text-[11px] font-semibold rounded bg-emerald-600 hover:bg-emerald-700 text-white flex items-center gap-1 cursor-pointer"
              >
                {copiedKey === 'pub' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                <span>{copiedKey === 'pub' ? 'Copied Link' : 'Copy Phone Link'}</span>
              </button>
              <a
                href={publisherUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="px-2.5 py-1 text-[11px] font-semibold rounded bg-white text-slate-900 hover:bg-emerald-50 flex items-center gap-1"
              >
                <Smartphone className="w-3 h-3 text-emerald-700" />
                <span>Open Publisher</span>
              </a>
            </div>
          </div>
        )}

        {isLive && connStatus === 'error' && (
          <div className="absolute inset-0 bg-slate-950/88 flex flex-col items-center justify-center p-4 text-center gap-2.5">
            {mode === 'local' ? (
              <CameraOff className="w-6 h-6 text-rose-400" />
            ) : (
              <WifiOff className="w-6 h-6 text-rose-400" />
            )}
            <p className="text-[11px] font-mono text-rose-200 leading-relaxed">{errorMsg}</p>
            <div className="flex flex-wrap items-center justify-center gap-1.5">
              <button
                onClick={() =>
                  mode === 'local'
                    ? void startLocalCamera()
                    : mode === 'webrtc' || mode === 'websocket'
                    ? connectRemoteStream(mode)
                    : fileInputRef.current?.click()
                }
                className="px-2.5 py-1 text-[11px] font-semibold rounded bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer"
              >
                Retry
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="px-2.5 py-1 text-[11px] font-semibold rounded bg-white text-slate-800 hover:bg-emerald-50 cursor-pointer"
              >
                Upload Video/Photo
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Transport & Real-Time CV Controls */}
      {isLive && showControls && (
        <div className="space-y-2.5 bg-[#F8FBF9] border border-emerald-900/10 rounded p-2.5">
          {/* Overlay Mode + Device / Upload buttons */}
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <div className="flex items-center gap-1">
              {(['overlay', 'mask', 'raw'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setOverlayMode(m)}
                  className={`px-2 py-0.5 text-[10px] font-mono uppercase rounded border transition-colors cursor-pointer ${
                    overlayMode === m
                      ? 'bg-emerald-600 border-emerald-600 text-white font-semibold'
                      : 'bg-white border-slate-200 text-slate-600 hover:border-emerald-300'
                  }`}
                >
                  {m === 'overlay' ? 'CV Overlay' : m === 'mask' ? 'ExG Mask' : 'Raw'}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              {mode === 'local' && (
                <button
                  onClick={() => {
                    const next = facingMode === 'environment' ? 'user' : 'environment';
                    setFacingMode(next);
                    setSelectedDeviceId('');
                    void startLocalCamera({ facing: next, deviceId: '' });
                  }}
                  className="px-2 py-0.5 text-[10px] font-mono rounded bg-white border border-slate-200 text-slate-700 hover:bg-emerald-50 flex items-center gap-1 cursor-pointer"
                >
                  <RefreshCw className="w-3 h-3 text-emerald-600" />
                  <span>{facingMode === 'environment' ? 'Rear' : 'Front'}</span>
                </button>
              )}
              <button
                onClick={() => fileInputRef.current?.click()}
                title="Test CV on uploaded video or image"
                className="px-2 py-0.5 text-[10px] font-mono rounded bg-white border border-slate-200 text-slate-700 hover:bg-emerald-50 flex items-center gap-1 cursor-pointer"
              >
                <Upload className="w-3 h-3 text-emerald-600" />
                <span>File</span>
              </button>
            </div>
          </div>

          {/* Local physical camera selector */}
          {mode === 'local' && devices.length > 1 && (
            <select
              value={selectedDeviceId}
              onChange={(e) => {
                setSelectedDeviceId(e.target.value);
                void startLocalCamera({ deviceId: e.target.value });
              }}
              className="w-full text-[11px] font-mono bg-white border border-slate-200 rounded px-2 py-1 text-slate-700"
            >
              <option value="">Default Device Camera</option>
              {devices.map((d, idx) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Camera ${idx + 1}`}
                </option>
              ))}
            </select>
          )}

          {/* WebRTC / CameraX WebSocket Room & Endpoint Config */}
          {(mode === 'webrtc' || mode === 'websocket') && (
            <div className="space-y-1.5 pt-1 border-t border-emerald-900/10">
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] font-mono text-slate-500 shrink-0">Room</span>
                <input
                  type="text"
                  value={roomId}
                  onChange={(e) => setRoomId(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))}
                  className="flex-1 min-w-0 text-[11px] font-mono bg-white border border-slate-200 rounded px-2 py-0.5 text-slate-800"
                />
                <button
                  onClick={() => connectRemoteStream(mode, roomId, customWsUrl)}
                  className="px-2 py-0.5 text-[10px] font-mono font-semibold rounded bg-emerald-600 text-white hover:bg-emerald-700 cursor-pointer shrink-0"
                >
                  Connect
                </button>
              </div>

              {mode === 'websocket' && (
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-mono text-slate-500 shrink-0">WS URL</span>
                    <input
                      type="text"
                      value={customWsUrl}
                      onChange={(e) => setCustomWsUrl(e.target.value)}
                      className="flex-1 min-w-0 text-[10px] font-mono bg-white border border-slate-200 rounded px-1.5 py-0.5 text-slate-700"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-1 text-[10px] font-mono text-slate-500">
                    <span className="truncate">CameraX URI ready</span>
                    <button
                      onClick={() => copyText('camx', cameraXWsUri)}
                      className="text-emerald-700 hover:underline flex items-center gap-0.5 shrink-0 cursor-pointer"
                    >
                      {copiedKey === 'camx' ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                      <span>{copiedKey === 'camx' ? 'Copied' : 'Copy CameraX URI'}</span>
                    </button>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between text-[10px] font-mono text-slate-500 tabular-nums">
                <span>
                  Publishers: <strong className="text-emerald-700">{publishers.length}</strong>
                  {mode === 'webrtc' ? ` · ICE: ${iceState}` : ` · ${liveStats.kbps.toFixed(0)} kbps`}
                </span>
                <a
                  href={publisherUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-emerald-700 font-semibold hover:underline"
                >
                  Open Phone Publisher ↗
                </a>
              </div>
            </div>
          )}

          {/* ExG Green Sensitivity Floor */}
          <div className="space-y-1 pt-1 border-t border-emerald-900/10">
            <div className="flex justify-between text-[11px] font-mono text-slate-600 tabular-nums">
              <span>ExG Green Floor (Otsu ≥ {liveStats.otsuThreshold})</span>
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

          <div className="flex justify-between text-[10px] font-mono text-slate-500 tabular-nums">
            <span>
              Green Near: {(liveStats.greenRatioNear * 100).toFixed(1)}% · Far:{' '}
              {(liveStats.greenRatioFar * 100).toFixed(1)}%
            </span>
            <span>{liveStats.processingMs.toFixed(1)} ms/f</span>
          </div>
        </div>
      )}

      {/* Telemetry Readouts */}
      <div className="space-y-2 pt-1 text-xs font-mono tabular-nums">
        <div className="flex justify-between border-b border-emerald-900/10 pb-1.5">
          <span className="text-slate-600">Lateral Offset (e_y)</span>
          <span className={Math.abs(displayedLatM) > 0.08 ? 'text-amber-700 font-semibold' : 'text-emerald-700 font-semibold'}>
            {displayedLatM >= 0 ? '+' : ''}
            {displayedLatM.toFixed(3)} m
          </span>
        </div>
        <div className="flex justify-between border-b border-emerald-900/10 pb-1.5">
          <span className="text-slate-600">Heading Error (e_ψ)</span>
          <span className="text-slate-800 font-semibold">
            {displayedYawRad >= 0 ? '+' : ''}
            {displayedYawRad.toFixed(3)} rad
          </span>
        </div>
        <div className="flex justify-between border-b border-emerald-900/10 pb-1.5">
          <span className="text-slate-600">{isLive ? 'Vision Lock Mode' : 'Boundary Guard'}</span>
          <span
            className={
              isLive
                ? liveStats.trackingLocked
                  ? 'text-emerald-700 font-semibold'
                  : 'text-amber-700 font-semibold'
                : simBoundaryOk
                ? 'text-emerald-700 font-semibold'
                : 'text-rose-700 font-semibold'
            }
          >
            {isLive
              ? liveStats.detectionMode === 'dual_row'
                ? '2-ROW CENTERLINE'
                : liveStats.detectionMode === 'single_band'
                ? '1-BAND FOLIAGE'
                : 'SEARCHING GREEN'
              : simBoundaryOk
              ? 'INSIDE MARGIN'
              : 'BLOCKED'}
          </span>
        </div>
        <div className="space-y-1">
          <div className="flex justify-between">
            <span className="text-slate-600">Row-End Confidence</span>
            <span className={displayedRowEnd > 0.78 ? 'text-amber-700 font-semibold' : 'text-slate-700'}>
              {(displayedRowEnd * 100).toFixed(0)}%
            </span>
          </div>
          <div className="w-full h-1.5 bg-[#E6EFE9] rounded-full overflow-hidden">
            <div
              className="h-full bg-emerald-600 transition-all duration-150"
              style={{ width: `${Math.round(displayedRowEnd * 100)}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
