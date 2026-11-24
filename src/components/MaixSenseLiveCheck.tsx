import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Camera,
  HardDrive,
  Network,
  RefreshCw,
  Download,
  Copy,
  Check,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Wifi,
  WifiOff,
  Eye,
  EyeOff,
  FolderSearch,
  Radio,
  ExternalLink,
} from 'lucide-react';
import type { VisionAlignmentData } from './CropRowAlignmentGauge';
import { detectCropRowFromFrame } from '../vision/cropRowVision';
import { loadActiveThresholds } from '../services/thresholdPresetStorage';

interface Props {
  rowWidthM: number;
  stanleyGain: number;
  speedLimit: number;
  triggerSeq?: number;
  onSwitchToWebcam?: () => void;
  onAlignmentUpdate?: (alignment: VisionAlignmentData, active: boolean) => void;
  onLogEvent?: (msg: string) => void;
}

interface DiscoverResponse {
  ok: boolean;
  hostOs: string;
  isCloudContainer: boolean;
  drivesChecked: string[];
  driveFound: boolean;
  drivePath: string | null;
  ipFromDrive: string | null;
  rndisInterfaces: Array<{ name: string; hostIp: string; cameraIp: string }>;
  detectedIp: string;
  ipSource: string;
  activePublishers: Array<{
    room: string;
    id: string;
    label: string;
    framesRelayed: number;
    connectedAt: number;
  }>;
  checkedAt: string;
}

interface MaixSenseTelemetry {
  ip: string;
  ipSource: string;
  driveFound: boolean;
  drivePath: string;
  interfaceName: string;
  endpoint: string;
  frameId: number;
  fps: number;
  latencyMs: number;
  centerDepthMm: number | null;
  minDepthMm: number | null;
  maxDepthMm: number | null;
  rgbBytes: number;
  depthBytes: number;
}

type CheckState = 'pass' | 'warn' | 'fail' | 'checking' | 'idle';

const PROC_W = 320;
const PROC_H = 180;
const IPV4_EXACT_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const PRIVATE_IPV4_RE = /\b((?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3})\b/g;

function buildMaixSenseSetCfgPayload(): ArrayBuffer {
  // Official Sipeed MaixSense-A075V <BBBBBBBBi (12 bytes):
  // trigger_mode=1, deep_mode=1, deep_shift=255, ir_mode=0, status_mode=2, status_mask=7, rgb_mode=1, rgb_res=0, expose_time=0
  const buf = new ArrayBuffer(12);
  const view = new DataView(buf);
  view.setUint8(0, 1);
  view.setUint8(1, 1);
  view.setUint8(2, 255);
  view.setUint8(3, 0);
  view.setUint8(4, 2);
  view.setUint8(5, 7);
  view.setUint8(6, 1);
  view.setUint8(7, 0);
  view.setInt32(8, 0, true);
  return buf;
}

function extractJpegFromGetdeep(buf: ArrayBuffer): Uint8Array | null {
  const bytes = new Uint8Array(buf);
  let soi = -1;
  for (let i = 0; i < bytes.length - 2; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd8 && bytes[i + 2] === 0xff) {
      soi = i;
      break;
    }
  }
  if (soi < 0) return null;
  for (let j = bytes.length - 2; j > soi + 2; j--) {
    if (bytes[j] === 0xff && bytes[j + 1] === 0xd9) {
      return bytes.subarray(soi, j + 2);
    }
  }
  return null;
}

export const MaixSenseLiveCheck: React.FC<Props> = ({
  rowWidthM,
  stanleyGain,
  speedLimit,
  triggerSeq,
  onSwitchToWebcam,
  onAlignmentUpdate,
  onLogEvent,
}) => {
  const [roomId, setRoomId] = useState<string>('rover-01');
  const [cameraIp, setCameraIp] = useState<string>('192.168.233.1');
  const [ipError, setIpError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState<boolean>(false);
  const [discoverInfo, setDiscoverInfo] = useState<DiscoverResponse | null>(null);
  const [localDriveScan, setLocalDriveScan] = useState<{
    scanned: boolean;
    driveName: string;
    foundIp: string | null;
    sourceFile: string | null;
    filesRead: number;
  } | null>(null);

  const [wsState, setWsState] = useState<'disconnected' | 'connecting' | 'waiting' | 'streaming'>('disconnected');
  const [directPollActive, setDirectPollActive] = useState<boolean>(false);
  const [directStatusMsg, setDirectStatusMsg] = useState<string | null>(null);
  const [showHudOverlay, setShowHudOverlay] = useState<boolean>(true);
  const [minExgFloor, setMinExgFloor] = useState<number>(() => loadActiveThresholds().minExgFloor);
  const [copiedCmd, setCopiedCmd] = useState<'stream' | 'check' | null>(null);

  const [maixTelemetry, setMaixTelemetry] = useState<MaixSenseTelemetry | null>(null);
  const [frameStats, setFrameStats] = useState({
    fps: 0,
    framesReceived: 0,
    resolution: '—',
    cvMs: 0,
    lateralOffsetM: 0,
    headingErrorRad: 0,
    distanceToFurrowEndM: 2.0,
    rowEndConfidence: 0,
    greenRatioNear: 0,
  });

  const displayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const workCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const driveInputRef = useRef<HTMLInputElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const manualDisconnectRef = useRef<boolean>(false);
  const directTimerRef = useRef<number | null>(null);
  const busyDecodingRef = useRef<boolean>(false);

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
    cameraIp,
  });
  useEffect(() => {
    paramsRef.current = {
      rowWidthM,
      stanleyGain,
      speedLimit,
      showHudOverlay,
      minExgFloor,
      cameraIp,
    };
  }, [rowWidthM, stanleyGain, speedLimit, showHudOverlay, minExgFloor, cameraIp]);

  const trackerRef = useRef({
    frames: 0,
    winFrames: 0,
    winStart: performance.now(),
    fps: 0,
    latM: 0,
    yawRad: 0,
    hasLocked: false,
    missed: 0,
  });

  const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsBaseUrl = `${wsProto}//${window.location.host}/ws/camera`;
  const bridgeCommand = `python maixsense_bridge.py --ws ${wsBaseUrl} --room ${roomId}`;
  const checkOnlyCommand = `python maixsense_bridge.py --check-only`;

  const processFrameBlob = useCallback(async (rawBlob: Blob, sourceTag: string) => {
    if (busyDecodingRef.current) return;
    busyDecodingRef.current = true;
    try {
      // Detect PNG vs JPEG magic bytes so both RGB JPEG & ToF Depth PNG frames decode reliably
      let blob = rawBlob;
      if (!blob.type) {
        const hdr = new Uint8Array(await rawBlob.slice(0, 4).arrayBuffer());
        const isPng = hdr[0] === 0x89 && hdr[1] === 0x50 && hdr[2] === 0x4e && hdr[3] === 0x47;
        blob = new Blob([rawBlob], { type: isPng ? 'image/png' : 'image/jpeg' });
      }

      const bitmap = await createImageBitmap(blob);
      const dispCanvas = displayCanvasRef.current;
      if (!workCanvasRef.current) {
        const c = document.createElement('canvas');
        c.width = PROC_W;
        c.height = PROC_H;
        workCanvasRef.current = c;
      }
      const workCanvas = workCanvasRef.current;
      const wCtx = workCanvas.getContext('2d', { willReadFrequently: true });
      const dCtx = dispCanvas?.getContext('2d');

      if (wCtx && dispCanvas && dCtx) {
        if (dispCanvas.width !== PROC_W || dispCanvas.height !== PROC_H) {
          dispCanvas.width = PROC_W;
          dispCanvas.height = PROC_H;
        }
        wCtx.drawImage(bitmap, 0, 0, PROC_W, PROC_H);
        const frame = wCtx.getImageData(0, 0, PROC_W, PROC_H);
        const p = paramsRef.current;
        const { observation } = detectCropRowFromFrame(frame, {
          rowWidthM: p.rowWidthM,
          minExgFloor: p.minExgFloor,
        });

        dCtx.drawImage(bitmap, 0, 0, PROC_W, PROC_H);

        if (p.showHudOverlay) {
          const farRoiY =
            observation.roiTopPx + Math.floor((observation.roiBottomPx - observation.roiTopPx) / 3);
          dCtx.strokeStyle = 'rgba(255,255,255,0.6)';
          dCtx.lineWidth = 1;
          dCtx.setLineDash([4, 4]);
          dCtx.beginPath();
          dCtx.moveTo(0, observation.roiTopPx);
          dCtx.lineTo(PROC_W, observation.roiTopPx);
          dCtx.moveTo(0, farRoiY);
          dCtx.lineTo(PROC_W, farRoiY);
          dCtx.moveTo(0, observation.roiBottomPx);
          dCtx.lineTo(PROC_W, observation.roiBottomPx);
          dCtx.stroke();
          dCtx.setLineDash([]);

          if (observation.valid && observation.strips.length >= 2) {
            dCtx.strokeStyle = '#10B981';
            dCtx.lineWidth = 2.4;
            dCtx.beginPath();
            dCtx.moveTo(observation.centerTopPx, observation.roiTopPx);
            dCtx.lineTo(observation.centerBottomPx, observation.roiBottomPx);
            dCtx.stroke();
          }

          dCtx.fillStyle = 'rgba(15, 23, 42, 0.78)';
          dCtx.fillRect(6, 6, PROC_W - 12, 18);
          dCtx.fillStyle = '#A7F3D0';
          dCtx.font = '600 9px "IBM Plex Mono", monospace';
          dCtx.fillText(
            `MAIXSENSE ${p.cameraIp} · ${bitmap.width}×${bitmap.height} · ${trackerRef.current.fps.toFixed(0)} FPS`,
            11,
            18
          );
        }

        const tr = trackerRef.current;
        tr.frames += 1;
        tr.winFrames += 1;
        const now = performance.now();
        if (now - tr.winStart >= 500) {
          tr.fps = (tr.winFrames * 1000) / (now - tr.winStart);
          tr.winFrames = 0;
          tr.winStart = now;
        }

        if (observation.valid) {
          if (!tr.hasLocked) {
            tr.latM = observation.lateralErrorM;
            tr.yawRad = observation.headingErrorRad;
            tr.hasLocked = true;
          } else {
            tr.latM = 0.65 * tr.latM + 0.35 * observation.lateralErrorM;
            tr.yawRad = 0.7 * tr.yawRad + 0.3 * observation.headingErrorRad;
          }
          tr.missed = 0;
        } else {
          tr.missed = Math.min(20, tr.missed + 1);
        }

        const locked = observation.valid || (tr.hasLocked && tr.missed <= 12);
        const cmdWz = locked
          ? Math.max(
              -0.8,
              Math.min(
                0.8,
                -(p.stanleyGain * Math.atan2(tr.latM, Math.max(p.speedLimit, 0.08)) + tr.yawRad)
              )
            )
          : 0;

        setFrameStats({
          fps: tr.fps,
          framesReceived: tr.frames,
          resolution: `${bitmap.width}×${bitmap.height}`,
          cvMs: observation.processingMs,
          lateralOffsetM: tr.latM,
          headingErrorRad: tr.yawRad,
          distanceToFurrowEndM: observation.distanceToFurrowEndM,
          rowEndConfidence: observation.rowEndConfidence,
          greenRatioNear: observation.greenRatioNear,
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
            missedFrames: tr.missed,
            cmdWzRadS: cmdWz,
            currentRow: 1,
            sourceLabel: `MAIXSENSE ${sourceTag} (${p.cameraIp}) · ${tr.fps.toFixed(0)} FPS`,
          },
          true
        );
      }

      bitmap.close();
    } catch {
      // Skip malformed frames
    } finally {
      busyDecodingRef.current = false;
    }
  }, []);

  const runServerDiscover = useCallback(async () => {
    setDiscovering(true);
    try {
      const resp = await fetch('/api/maixsense/discover', { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data: DiscoverResponse = await resp.json();
      setDiscoverInfo(data);
      if (data.detectedIp && IPV4_EXACT_RE.test(data.detectedIp)) {
        setCameraIp((prev) => (data.ipFromDrive || data.rndisInterfaces.length > 0 ? data.detectedIp : prev));
      }
      onLogEventRef.current?.(
        `[MaixSense Check] Host scan (${data.hostOs}): drive=${data.driveFound ? data.drivePath : 'none'}, RNDIS=${data.rndisInterfaces.length}, IP=${data.detectedIp} (${data.ipSource}), active WS bridges=${data.activePublishers.length}.`
      );
    } catch (err) {
      onLogEventRef.current?.(
        `[MaixSense Check] Discovery request failed: ${err instanceof Error ? err.message : 'network error'}`
      );
    } finally {
      setDiscovering(false);
    }
  }, []);

  const disconnectWs = useCallback((isManual = false) => {
    manualDisconnectRef.current = isManual;
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    setWsState('disconnected');
  }, []);

  // Stable WebSocket listener: does NOT depend on cameraIp so telemetry IP updates never cause reconnect loops
  const connectWsListener = useCallback(() => {
    disconnectWs(false);
    const safeRoom = roomId.replace(/[^a-zA-Z0-9_-]/g, '') || 'rover-01';
    setWsState('connecting');
    const url = `${wsBaseUrl}?room=${encodeURIComponent(safeRoom)}&role=viewer&transport=maixsense`;
    const ws = new WebSocket(url);
    ws.binaryType = 'blob';
    wsRef.current = ws;

    ws.onopen = () => {
      setWsState('waiting');
      onLogEventRef.current?.(
        `[MaixSense Bridge] Listening on room "${safeRoom}" for live MaixSense RGB + ToF depth stream.`
      );
    };

    ws.onmessage = (evt) => {
      if (evt.data instanceof Blob) {
        setWsState('streaming');
        void processFrameBlob(evt.data, 'WS BRIDGE');
        return;
      }
      if (typeof evt.data === 'string') {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === 'frame:jpeg' && typeof msg.data === 'string') {
            setWsState('streaming');
            const bin = atob(msg.data);
            const arr = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
            void processFrameBlob(new Blob([arr], { type: 'image/jpeg' }), 'WS JSON');
            return;
          }
          if (msg.type === 'maixsense:telemetry') {
            const activeIp = msg.ip || paramsRef.current.cameraIp;
            setMaixTelemetry({
              ip: activeIp,
              ipSource: msg.ipSource || 'MaixSense Bridge',
              driveFound: Boolean(msg.driveFound),
              drivePath: msg.drivePath || '',
              interfaceName: msg.interfaceName || 'USB RNDIS',
              endpoint: msg.endpoint || '/getdeep',
              frameId: Number(msg.frameId || 0),
              fps: Number(msg.fps || 0),
              latencyMs: Number(msg.latencyMs || 0),
              centerDepthMm: typeof msg.centerDepthMm === 'number' ? msg.centerDepthMm : null,
              minDepthMm: typeof msg.minDepthMm === 'number' ? msg.minDepthMm : null,
              maxDepthMm: typeof msg.maxDepthMm === 'number' ? msg.maxDepthMm : null,
              rgbBytes: Number(msg.rgbBytes || 0),
              depthBytes: Number(msg.depthBytes || 0),
            });
            if (msg.ip && IPV4_EXACT_RE.test(msg.ip) && msg.ip !== paramsRef.current.cameraIp) {
              setCameraIp(msg.ip);
            }
            setWsState('streaming');
          } else if (msg.type === 'presence' && Array.isArray(msg.publishers)) {
            const hasMaix = msg.publishers.some(
              (p: { transport?: string; label?: string }) =>
                p.transport === 'maixsense' || (p.label || '').toLowerCase().includes('maixsense')
            );
            if (!hasMaix) {
              setWsState((prev) => (prev === 'streaming' ? 'waiting' : prev));
            }
          } else if (msg.type === 'maixsense:reconnect') {
            if (typeof msg.ip === 'string' && IPV4_EXACT_RE.test(msg.ip)) {
              setCameraIp(msg.ip);
            }
            onLogEventRef.current?.(
              `[MaixSense Diagnostic] Force-reconnect command received from Hardware Audit — re-establishing live stream listener.`
            );
            connectWsListener();
          } else if (msg.type === 'maixsense:hard_reset') {
            onLogEventRef.current?.(
              `[MaixSense Hard Reset] Hardware power-cycle initiated from Hardware Audit — waiting for device re-enumeration to reconnect.`
            );
            setWsState('waiting');
            if (reconnectTimerRef.current !== null) {
              window.clearTimeout(reconnectTimerRef.current);
            }
            reconnectTimerRef.current = window.setTimeout(() => {
              connectWsListener();
            }, 2200);
          }
        } catch {
          // Ignore non-JSON messages
        }
      }
    };

    ws.onclose = () => {
      setWsState('disconnected');
      if (!manualDisconnectRef.current) {
        reconnectTimerRef.current = window.setTimeout(() => {
          connectWsListener();
        }, 3000);
      }
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        // Ignore close errors
      }
    };
  }, [roomId, wsBaseUrl, disconnectWs, processFrameBlob]);

  const stopDirectHttpPoll = useCallback(() => {
    if (directTimerRef.current !== null) {
      window.clearInterval(directTimerRef.current);
      directTimerRef.current = null;
    }
    setDirectPollActive(false);
  }, []);

  const startDirectHttpPoll = useCallback(async () => {
    const trimmedIp = cameraIp.trim();
    if (!IPV4_EXACT_RE.test(trimmedIp)) {
      setIpError('Enter a valid IPv4 address (e.g. 192.168.233.1).');
      return;
    }
    setIpError(null);
    stopDirectHttpPoll();

    if (window.location.protocol === 'https:') {
      const msg = `Hosted HTTPS browser blocks direct http://${trimmedIp}/getdeep (Mixed Content). Run maixsense_bridge.py on the PC/Pi where MaixSense is plugged in — this console automatically receives the live stream over wss://.`;
      setDirectStatusMsg(msg);
      onLogEventRef.current?.(`[MaixSense Direct IP] ${msg}`);
      return;
    }

    setDirectStatusMsg(`Configuring RGB+Depth via POST http://${trimmedIp}/set_cfg and probing /getdeep ...`);
    // Attempt official binary /set_cfg first (best-effort)
    try {
      await fetch(`http://${trimmedIp}/set_cfg`, {
        method: 'POST',
        body: buildMaixSenseSetCfgPayload(),
      });
    } catch {
      // May be blocked by firmware CORS; /getdeep probe below will report accurately
    }

    const grabOnce = async () => {
      try {
        const resp = await fetch(`http://${trimmedIp}/getdeep`, { cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const buf = await resp.arrayBuffer();
        const jpeg = extractJpegFromGetdeep(buf);
        if (!jpeg) {
          setDirectStatusMsg(
            `Connected to http://${trimmedIp}/getdeep (${buf.byteLength} B), but RGB JPEG was absent — run maixsense_bridge.py to auto-enable /set_cfg & ToF Depth rendering.`
          );
          return;
        }
        setDirectStatusMsg(`Live direct HTTP stream from http://${trimmedIp}/getdeep`);
        const safeCopy = new Uint8Array(jpeg.byteLength);
        safeCopy.set(jpeg);
        await processFrameBlob(new Blob([safeCopy.buffer], { type: 'image/jpeg' }), 'DIRECT HTTP');
      } catch (err) {
        setDirectStatusMsg(
          `Direct browser fetch to http://${trimmedIp}/getdeep was blocked by MaixSense firmware CORS or unreachable (${
            err instanceof Error ? err.message : 'network error'
          }). Run maixsense_bridge.py to relay live video cleanly.`
        );
        stopDirectHttpPoll();
      }
    };

    setDirectPollActive(true);
    await grabOnce();
    directTimerRef.current = window.setInterval(() => {
      void grabOnce();
    }, 140);
  }, [cameraIp, processFrameBlob, stopDirectHttpPoll]);

  const handleDriveFolderSelected = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const list = Array.from(files).slice(0, 60);
    const firstRel = (list[0] as File & { webkitRelativePath?: string }).webkitRelativePath || '';
    const driveName = firstRel.split('/')[0] || 'Selected Drive';

    let foundIp: string | null = null;
    let sourceFile: string | null = null;
    let filesRead = 0;

    for (const file of list) {
      if (file.size > 64 * 1024) continue;
      const lower = file.name.toLowerCase();
      const isText =
        /\.(txt|url|html|htm|ini|cfg|conf|json|md|yaml|yml)$/.test(lower) ||
        lower.includes('ip') ||
        lower.includes('maix') ||
        lower.includes('readme');
      if (!isText) continue;

      try {
        const text = await file.text();
        filesRead += 1;
        const matches = text.match(PRIVATE_IPV4_RE);
        if (matches && matches.length > 0) {
          const preferred = matches.find((ip) => ip.startsWith('192.168.233.')) || matches[0];
          foundIp = preferred;
          sourceFile = file.name;
          break;
        }
      } catch {
        // Skip unreadable files
      }
    }

    setLocalDriveScan({
      scanned: true,
      driveName,
      foundIp,
      sourceFile,
      filesRead,
    });

    if (foundIp) {
      setCameraIp(foundIp);
      setIpError(null);
      onLogEventRef.current?.(
        `[MaixSense Drive Scan] Found IP ${foundIp} in "${driveName}/${sourceFile}" (${filesRead} files scanned).`
      );
    } else {
      onLogEventRef.current?.(
        `[MaixSense Drive Scan] Scanned "${driveName}" (${filesRead} text/config files); using default MaixSense IP 192.168.233.1.`
      );
    }
  }, []);

  // Auto-run host discovery & open persistent WebSocket bridge listener on mount
  useEffect(() => {
    void runServerDiscover();
    connectWsListener();
    return () => {
      disconnectWs(true);
      stopDirectHttpPoll();
    };
  }, [runServerDiscover, connectWsListener, disconnectWs, stopDirectHttpPoll]);

  // Respond when top-bar "Live Camera Check" button triggers MaixSense check
  const lastTriggerRef = useRef<number>(0);
  useEffect(() => {
    if (!triggerSeq || triggerSeq === lastTriggerRef.current) return;
    lastTriggerRef.current = triggerSeq;
    void runServerDiscover();
    if (wsState === 'disconnected') {
      connectWsListener();
    }
  }, [triggerSeq, runServerDiscover, wsState, connectWsListener]);

  const handleCopyCommand = useCallback(
    async (kind: 'stream' | 'check') => {
      const text = kind === 'stream' ? bridgeCommand : checkOnlyCommand;
      try {
        await navigator.clipboard.writeText(text);
        setCopiedCmd(kind);
        window.setTimeout(() => setCopiedCmd(null), 2000);
      } catch {
        // Clipboard may be restricted
      }
    },
    [bridgeCommand, checkOnlyCommand]
  );

  const isStreaming = wsState === 'streaming' || (directPollActive && frameStats.framesReceived > 0);
  const driveDetected = Boolean(
    maixTelemetry?.driveFound || discoverInfo?.driveFound || localDriveScan?.scanned
  );
  const resolvedDriveLabel = maixTelemetry?.driveFound
    ? maixTelemetry.drivePath || 'MaixSense USB Drive'
    : discoverInfo?.driveFound
    ? discoverInfo.drivePath || 'MaixSense USB Drive'
    : localDriveScan?.scanned
    ? `${localDriveScan.driveName}${localDriveScan.foundIp ? ` -> ${localDriveScan.foundIp}` : ''}`
    : discoverInfo?.isCloudContainer
    ? 'Cloud host — run bridge script on PC/Pi'
    : 'Not found on host mounts';

  const checkCards: Array<{ id: string; label: string; state: CheckState; detail: string }> = [
    {
      id: 'drive',
      label: '01. USB Drive Check',
      state: driveDetected ? 'pass' : discovering ? 'checking' : 'warn',
      detail: resolvedDriveLabel,
    },
    {
      id: 'ip',
      label: '02. MaixSense IP',
      state:
        maixTelemetry?.ip || discoverInfo?.rndisInterfaces.length || localDriveScan?.foundIp
          ? 'pass'
          : IPV4_EXACT_RE.test(cameraIp)
          ? 'warn'
          : 'fail',
      detail: maixTelemetry?.ip
        ? `${maixTelemetry.ip} (${maixTelemetry.interfaceName})`
        : `${cameraIp} (${discoverInfo?.ipSource || 'Default A075V IP'})`,
    },
    {
      id: 'bridge',
      label: '03. Camera Link',
      state: isStreaming
        ? 'pass'
        : wsState === 'waiting' || wsState === 'connecting'
        ? 'checking'
        : 'idle',
      detail: isStreaming
        ? directPollActive
          ? `Direct HTTP (${cameraIp})`
          : `Live WS Bridge (room: ${roomId})`
        : wsState === 'waiting'
        ? `Listening on room "${roomId}"`
        : 'Disconnected',
    },
    {
      id: 'frames',
      label: '04. Live Video Stream',
      state: isStreaming && frameStats.framesReceived > 0 ? 'pass' : 'idle',
      detail:
        isStreaming && frameStats.framesReceived > 0
          ? `${frameStats.resolution} · ${frameStats.fps.toFixed(0)} FPS · #${frameStats.framesReceived}`
          : 'Waiting for MaixSense frames',
    },
    {
      id: 'tof',
      label: '05. ToF Depth + ExG CV',
      state: maixTelemetry?.centerDepthMm != null || isStreaming ? 'pass' : 'idle',
      detail:
        maixTelemetry?.centerDepthMm != null
          ? `Center ${maixTelemetry.centerDepthMm} mm · Min ${maixTelemetry.minDepthMm ?? '—'} mm`
          : isStreaming
          ? `ExG CV ${frameStats.cvMs.toFixed(1)} ms`
          : 'Awaiting /getdeep payload',
    },
  ];

  const renderBadge = (state: CheckState) => {
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
          READY
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
      return <span className="text-[10px] font-mono font-semibold text-emerald-700">LISTENING…</span>;
    }
    return <span className="text-[10px] font-mono text-slate-400">STANDBY</span>;
  };

  const safeHttpHref = IPV4_EXACT_RE.test(cameraIp.trim()) ? `http://${cameraIp.trim()}/` : null;

  return (
    <div className="space-y-4">
      <input
        ref={driveInputRef}
        type="file"
        multiple
        // @ts-expect-error webkitdirectory is supported by Chromium/Edge/Firefox/Safari for mounted USB drives
        webkitdirectory=""
        className="hidden"
        onChange={(e) => {
          void handleDriveFolderSelected(e.target.files);
          e.target.value = '';
        }}
      />

      {/* 5-Point MaixSense Drive -> IP -> Stream Diagnostic Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
        {checkCards.map((c) => (
          <div
            key={c.id}
            className={`rounded-md border px-3 py-2 space-y-1 ${
              c.state === 'pass'
                ? 'bg-emerald-50/60 border-emerald-200'
                : c.state === 'warn'
                ? 'bg-amber-50/60 border-amber-200'
                : c.state === 'fail'
                ? 'bg-rose-50/70 border-rose-200'
                : 'bg-[#F8FBF9] border-emerald-900/10'
            }`}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="text-[11px] font-semibold text-slate-800 truncate">{c.label}</span>
              {renderBadge(c.state)}
            </div>
            <div className="text-[11px] font-mono text-slate-600 truncate tabular-nums" title={c.detail}>
              {c.detail}
            </div>
          </div>
        ))}
      </div>

      {/* Main Split: Live MaixSense Video Viewport + Drive/IP & Script Controls */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
        {/* Left: Live MaixSense RGB/ToF + Crop-Row ExG Canvas */}
        <div className="lg:col-span-7 flex flex-col gap-2">
          <div className="relative aspect-video rounded-md border border-emerald-900/15 bg-[#F4F8F5] overflow-hidden flex items-center justify-center">
            <canvas
              ref={displayCanvasRef}
              width={PROC_W}
              height={PROC_H}
              className={`w-full h-full object-contain bg-[#141A17] ${isStreaming ? 'block' : 'hidden'}`}
            />

            {!isStreaming && (
              <div className="p-5 text-center space-y-3 max-w-lg bg-[#F8FBF9]">
                <div className="w-11 h-11 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center justify-center mx-auto">
                  <HardDrive className="w-5 h-5 text-emerald-700" />
                </div>
                <div className="space-y-1">
                  <div className="text-sm font-semibold text-slate-900">
                    MaixSense Bridge Listener Active (Room: {roomId} · IP: {cameraIp})
                  </div>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    Download &amp; run <span className="font-mono text-emerald-800">maixsense_bridge.py</span> on the PC or Raspberry Pi where MaixSense is plugged in. It automatically sends <span className="font-mono text-emerald-800">POST /set_cfg</span> to enable RGB + 16-bit ToF Depth and relays live video straight into this viewport.
                  </p>
                </div>

                <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                  <a
                    href="/api/maixsense/script"
                    download="maixsense_bridge.py"
                    className="px-3.5 py-2 text-xs font-semibold rounded-md bg-emerald-600 hover:bg-emerald-700 text-white flex items-center gap-1.5"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Download maixsense_bridge.py</span>
                  </a>
                  <button
                    type="button"
                    onClick={() => driveInputRef.current?.click()}
                    className="px-3 py-2 text-xs font-medium rounded-md bg-white hover:bg-emerald-50 border border-emerald-900/15 text-slate-700 flex items-center gap-1.5 cursor-pointer"
                  >
                    <FolderSearch className="w-3.5 h-3.5 text-emerald-600" />
                    <span>Check USB Drive</span>
                  </button>
                  {onSwitchToWebcam && (
                    <button
                      type="button"
                      onClick={onSwitchToWebcam}
                      className="px-3 py-2 text-xs font-medium rounded-md bg-white hover:bg-emerald-50 border border-emerald-900/15 text-slate-700 flex items-center gap-1.5 cursor-pointer"
                    >
                      <Camera className="w-3.5 h-3.5 text-emerald-600" />
                      <span>Use USB UVC Webcam</span>
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono text-slate-500 tabular-nums">
            <span>
              Camera IP: <strong className="text-emerald-700">{cameraIp}</strong> · Room:{' '}
              <strong className="text-slate-800">{roomId}</strong>
              {safeHttpHref && (
                <>
                  {' '}
                  ·{' '}
                  <a
                    href={safeHttpHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-emerald-700 hover:underline inline-flex items-center gap-0.5"
                  >
                    <span>Device Web UI</span>
                    <ExternalLink className="w-2.5 h-2.5" />
                  </a>
                </>
              )}
            </span>
            <span>
              {maixTelemetry?.centerDepthMm != null ? (
                <>
                  ToF Center: <strong className="text-emerald-700">{maixTelemetry.centerDepthMm} mm</strong> · Min:{' '}
                  <strong className="text-slate-800">{maixTelemetry.minDepthMm ?? '—'} mm</strong> · CV:{' '}
                  {frameStats.cvMs.toFixed(1)} ms
                </>
              ) : (
                <>
                  WS Status:{' '}
                  <strong className="text-emerald-700">
                    {wsState === 'streaming'
                      ? 'LIVE STREAM'
                      : wsState === 'waiting'
                      ? 'WAITING FOR BRIDGE'
                      : wsState.toUpperCase()}
                  </strong>
                </>
              )}
            </span>
          </div>
        </div>

        {/* Right: Drive-to-IP Controls & Local Discovery Script Runner */}
        <div className="lg:col-span-5 bg-[#F8FBF9] border border-emerald-900/10 rounded-md p-3.5 flex flex-col justify-between gap-3.5">
          <div className="space-y-3">
            {/* Step 1: Drive & IP Resolution */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label
                  htmlFor="maixsense-ip-input"
                  className="text-xs font-semibold text-slate-900 flex items-center gap-1.5"
                >
                  <Network className="w-3.5 h-3.5 text-emerald-600" />
                  <span>Resolved MaixSense IP Address</span>
                </label>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void runServerDiscover()}
                    disabled={discovering}
                    className="px-2 py-0.5 text-[11px] font-mono rounded border border-emerald-900/15 bg-white hover:bg-emerald-50 text-slate-700 flex items-center gap-1 cursor-pointer"
                  >
                    <RefreshCw className={`w-3 h-3 text-emerald-600 ${discovering ? 'animate-spin' : ''}`} />
                    <span>Rescan</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowHudOverlay((v) => !v)}
                    className={`px-2 py-0.5 text-[11px] font-mono rounded border flex items-center gap-1 cursor-pointer ${
                      showHudOverlay
                        ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                        : 'bg-white border-slate-200 text-slate-500'
                    }`}
                  >
                    {showHudOverlay ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                    <span>HUD</span>
                  </button>
                </div>
              </div>

              <div className="flex gap-1.5">
                <input
                  id="maixsense-ip-input"
                  type="text"
                  value={cameraIp}
                  onChange={(e) => {
                    setCameraIp(e.target.value);
                    setIpError(null);
                  }}
                  placeholder="192.168.233.1"
                  className="flex-1 min-w-0 px-2.5 py-1.5 text-xs font-mono rounded bg-white border border-emerald-900/15 text-slate-900 focus:outline-none focus:border-emerald-500"
                />
                {directPollActive ? (
                  <button
                    type="button"
                    onClick={stopDirectHttpPoll}
                    className="px-2.5 py-1.5 text-xs font-semibold rounded bg-rose-600 hover:bg-rose-700 text-white whitespace-nowrap cursor-pointer"
                  >
                    Stop IP Poll
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void startDirectHttpPoll()}
                    className="px-2.5 py-1.5 text-xs font-semibold rounded bg-emerald-600 hover:bg-emerald-700 text-white whitespace-nowrap cursor-pointer flex items-center gap-1"
                  >
                    <Camera className="w-3.5 h-3.5" />
                    <span>Connect IP</span>
                  </button>
                )}
              </div>

              {ipError && <div className="text-[11px] font-mono text-rose-700">{ipError}</div>}
              {directStatusMsg && (
                <div className="text-[11px] font-mono text-amber-800 bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5 leading-relaxed">
                  {directStatusMsg}
                </div>
              )}
            </div>

            {/* Step 2: Run Drive & IP Script on PC / Raspberry Pi */}
            <div className="bg-white border border-emerald-900/10 rounded p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                  <Radio className="w-3.5 h-3.5 text-emerald-600" />
                  <span>MaixSense Bridge (/set_cfg + RGB/ToF)</span>
                </span>
                <a
                  href="/api/maixsense/script"
                  download="maixsense_bridge.py"
                  className="text-[11px] font-mono text-emerald-700 hover:underline inline-flex items-center gap-1"
                >
                  <Download className="w-3 h-3" />
                  <span>maixsense_bridge.py</span>
                </a>
              </div>

              <div className="space-y-1.5">
                <div className="text-[11px] text-slate-600">
                  1. Verify drive, RNDIS IP &amp; <span className="font-mono">/set_cfg</span> (stdlib only):
                </div>
                <div className="flex items-center gap-1.5 bg-[#F4F8F5] border border-emerald-900/10 rounded px-2 py-1.5">
                  <code className="text-[10px] font-mono text-slate-800 truncate flex-1">
                    {checkOnlyCommand}
                  </code>
                  <button
                    type="button"
                    onClick={() => void handleCopyCommand('check')}
                    className="p-1 rounded hover:bg-emerald-100 text-emerald-700 shrink-0 cursor-pointer"
                    title="Copy check command"
                  >
                    {copiedCmd === 'check' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>

                <div className="text-[11px] text-slate-600 pt-0.5">
                  2. Stream live RGB / ToF Depth into this console:
                </div>
                <div className="flex items-center gap-1.5 bg-[#F4F8F5] border border-emerald-900/10 rounded px-2 py-1.5">
                  <code className="text-[10px] font-mono text-emerald-900 truncate flex-1">
                    {bridgeCommand}
                  </code>
                  <button
                    type="button"
                    onClick={() => void handleCopyCommand('stream')}
                    className="p-1 rounded hover:bg-emerald-100 text-emerald-700 shrink-0 cursor-pointer"
                    title="Copy live stream command"
                  >
                    {copiedCmd === 'stream' ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              <div className="flex items-center justify-between pt-1 text-[11px] font-mono">
                <span className="text-slate-500">
                  Bridge Room:{' '}
                  <input
                    type="text"
                    value={roomId}
                    onChange={(e) => setRoomId(e.target.value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24))}
                    className="w-20 px-1.5 py-0.5 bg-[#F8FBF9] border border-emerald-900/15 rounded text-slate-800"
                  />
                </span>
                <button
                  type="button"
                  onClick={() => (wsState === 'disconnected' ? connectWsListener() : disconnectWs(true))}
                  className="text-emerald-700 hover:underline inline-flex items-center gap-1 cursor-pointer"
                >
                  {wsState === 'disconnected' ? (
                    <>
                      <Wifi className="w-3 h-3" />
                      <span>Reconnect WS</span>
                    </>
                  ) : (
                    <>
                      <WifiOff className="w-3 h-3 text-slate-500" />
                      <span className="text-slate-600">Disconnect</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* ExG Green Sensitivity Floor synced with Calibration */}
            <div className="space-y-1">
              <div className="flex justify-between text-xs font-mono text-slate-600 tabular-nums">
                <span>ExG Crop-Row Floor</span>
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
          </div>

          {/* Live ToF + Crop-Row Readout Strip */}
          <div className="grid grid-cols-2 gap-2 pt-2.5 border-t border-emerald-900/10 text-[11px] font-mono tabular-nums">
            <div className="bg-white border border-emerald-900/10 rounded px-2.5 py-1.5">
              <div className="text-slate-400 text-[10px]">ToF Center / Min</div>
              <div className="text-emerald-700 font-semibold">
                {maixTelemetry?.centerDepthMm != null
                  ? `${maixTelemetry.centerDepthMm} / ${maixTelemetry.minDepthMm ?? '—'} mm`
                  : '—'}
              </div>
            </div>
            <div className="bg-white border border-emerald-900/10 rounded px-2.5 py-1.5">
              <div className="text-slate-400 text-[10px]">Lateral Offset (e_y)</div>
              <div className="text-slate-900 font-semibold">
                {isStreaming
                  ? `${frameStats.lateralOffsetM >= 0 ? '+' : ''}${frameStats.lateralOffsetM.toFixed(3)} m`
                  : '—'}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
