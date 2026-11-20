import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, CameraOff, Radio, RefreshCw, Wifi, ArrowLeft } from 'lucide-react';

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

function getWsUrl(room: string, transport: 'webrtc' | 'camerax-ws') {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const label = encodeURIComponent(
    transport === 'webrtc' ? 'Mobile WebRTC Camera' : 'Mobile WS JPEG Camera'
  );
  return `${proto}//${window.location.host}/ws/camera?room=${encodeURIComponent(
    room
  )}&role=publisher&transport=${transport}&label=${label}`;
}

export const MobileCameraPublisher: React.FC<{ initialRoom: string }> = ({ initialRoom }) => {
  const [room, setRoom] = useState(initialRoom || 'rover-01');
  const [transport, setTransport] = useState<'webrtc' | 'camerax-ws'>('webrtc');
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [streaming, setStreaming] = useState(false);
  const [statusText, setStatusText] = useState('Ready to stream live crop-row camera');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [viewersCount, setViewersCount] = useState(0);
  const [txStats, setTxStats] = useState({ fps: 0, kbps: 0 });

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const wsPumpRef = useRef<number | null>(null);
  const encodeCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const stopPublishing = useCallback(() => {
    if (wsPumpRef.current !== null) {
      window.clearInterval(wsPumpRef.current);
      wsPumpRef.current = null;
    }
    for (const pc of peersRef.current.values()) {
      try {
        pc.close();
      } catch {
        // ignore
      }
    }
    peersRef.current.clear();

    if (wsRef.current) {
      try {
        wsRef.current.close();
      } catch {
        // ignore
      }
      wsRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setStreaming(false);
    setViewersCount(0);
    setTxStats({ fps: 0, kbps: 0 });
    setStatusText('Stream stopped');
  }, []);

  const createOfferForViewer = useCallback(
    async (viewerId: string, ws: WebSocket, mediaStream: MediaStream) => {
      const existing = peersRef.current.get(viewerId);
      if (existing) {
        try {
          existing.close();
        } catch {
          // ignore
        }
      }

      const pc = new RTCPeerConnection(RTC_CONFIG);
      peersRef.current.set(viewerId, pc);

      mediaStream.getTracks().forEach((track) => pc.addTrack(track, mediaStream));

      pc.onicecandidate = (ev) => {
        if (ev.candidate && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: 'webrtc:ice',
              to: viewerId,
              candidate: ev.candidate,
            })
          );
        }
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          setStatusText(`WebRTC live -> Nav Console (${room})`);
        } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          peersRef.current.delete(viewerId);
        }
      };

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'webrtc:offer',
            to: viewerId,
            sdp: pc.localDescription,
          })
        );
      }
    },
    [room]
  );

  const startPublishing = useCallback(
    async (nextFacing = facing, nextTransport = transport) => {
      stopPublishing();
      setErrorMsg(null);
      setStatusText('Opening camera...');

      if (!navigator.mediaDevices?.getUserMedia) {
        setErrorMsg('Browser camera API (getUserMedia) is unavailable.');
        return;
      }

      try {
        const mediaStream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: nextFacing },
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 24 },
          },
          audio: false,
        });

        streamRef.current = mediaStream;
        if (videoRef.current) {
          videoRef.current.srcObject = mediaStream;
          await videoRef.current.play();
        }

        const ws = new WebSocket(getWsUrl(room, nextTransport));
        wsRef.current = ws;

        ws.onopen = () => {
          setStreaming(true);
          setStatusText(
            nextTransport === 'webrtc'
              ? `WebRTC publisher online in "${room}" — waiting for console viewer`
              : `Streaming binary JPEG over WebSocket to "${room}" (CameraX protocol)`
          );

          // If WebSocket JPEG mode, pump real binary JPEG frames at ~15 FPS
          if (nextTransport === 'camerax-ws') {
            if (!encodeCanvasRef.current) {
              const c = document.createElement('canvas');
              c.width = 480;
              c.height = 340;
              encodeCanvasRef.current = c;
            }
            let framesInSec = 0;
            let bytesInSec = 0;
            let winStart = performance.now();
            let encoding = false;

            wsPumpRef.current = window.setInterval(() => {
              const v = videoRef.current;
              const c = encodeCanvasRef.current;
              if (!v || !c || v.readyState < 2 || ws.readyState !== WebSocket.OPEN || encoding) return;
              if (ws.bufferedAmount > 256 * 1024) return;

              const ctx = c.getContext('2d');
              if (!ctx) return;
              ctx.drawImage(v, 0, 0, c.width, c.height);
              encoding = true;
              c.toBlob(
                (blob) => {
                  encoding = false;
                  if (!blob || ws.readyState !== WebSocket.OPEN) return;
                  ws.send(blob);
                  framesInSec++;
                  bytesInSec += blob.size;
                  const now = performance.now();
                  if (now - winStart >= 1000) {
                    setTxStats({
                      fps: framesInSec / ((now - winStart) / 1000),
                      kbps: (bytesInSec * 8) / 1000 / ((now - winStart) / 1000),
                    });
                    framesInSec = 0;
                    bytesInSec = 0;
                    winStart = now;
                  }
                },
                'image/jpeg',
                0.65
              );
            }, 66);
          }
        };

        ws.onmessage = async (ev) => {
          if (typeof ev.data !== 'string') return;
          let msg: any;
          try {
            msg = JSON.parse(ev.data);
          } catch {
            return;
          }

          if (msg.type === 'presence') {
            setViewersCount(Number(msg.viewersCount || 0));
            return;
          }

          if (nextTransport === 'webrtc') {
            if (msg.type === 'viewer:joined' && msg.viewerId) {
              await createOfferForViewer(msg.viewerId, ws, mediaStream);
            } else if (msg.type === 'webrtc:request-offer' && msg.from) {
              await createOfferForViewer(msg.from, ws, mediaStream);
            } else if (msg.type === 'webrtc:answer' && msg.from && msg.sdp) {
              const pc = peersRef.current.get(msg.from);
              if (pc) {
                await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
              }
            } else if (msg.type === 'webrtc:ice' && msg.from && msg.candidate) {
              const pc = peersRef.current.get(msg.from);
              if (pc) {
                await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
              }
            }
          }
        };

        ws.onerror = () => {
          setErrorMsg('WebSocket connection error to signaling server.');
        };

        ws.onclose = () => {
          setStreaming(false);
          setStatusText('Disconnected from server');
        };
      } catch (err: any) {
        setErrorMsg(
          err?.name === 'NotAllowedError'
            ? 'Camera permission denied. Allow camera access and tap Start Stream.'
            : `Camera error: ${err?.message || 'Unable to open camera'}`
        );
        stopPublishing();
      }
    },
    [facing, transport, room, stopPublishing, createOfferForViewer]
  );

  useEffect(() => {
    return () => stopPublishing();
  }, [stopPublishing]);

  return (
    <div className="min-h-screen bg-[#F7FAF8] text-slate-900 flex flex-col">
      <header className="bg-white border-b border-emerald-900/10 px-4 h-14 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Radio className="w-4 h-4 text-emerald-600" />
          <span className="text-sm font-semibold text-emerald-950">
            Rover Camera Publisher
          </span>
        </div>
        <a
          href="/"
          className="text-xs font-medium text-emerald-700 hover:underline flex items-center gap-1"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back to Console</span>
        </a>
      </header>

      <main className="flex-1 max-w-xl w-full mx-auto p-4 space-y-4">
        <div className="bg-white border border-emerald-900/10 rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between text-xs font-mono">
            <span className={streaming ? 'text-emerald-700 font-semibold' : 'text-slate-500'}>
              {streaming ? `● STREAMING (${transport.toUpperCase()})` : '○ STANDBY'}
            </span>
            <span className="text-slate-600 tabular-nums">
              Console Viewers: <strong className="text-emerald-700">{viewersCount}</strong>
              {transport === 'camerax-ws' && streaming && ` · ${txStats.fps.toFixed(0)} FPS · ${txStats.kbps.toFixed(0)} kbps`}
            </span>
          </div>

          <div className="relative aspect-[4/3] bg-[#141A17] rounded border border-emerald-900/15 overflow-hidden">
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              className="w-full h-full object-cover"
            />
            {!streaming && (
              <div className="absolute inset-0 flex flex-col items-center justify-center p-4 text-center gap-2 text-slate-300">
                <Camera className="w-8 h-8 text-emerald-400" />
                <span className="text-xs font-mono">{statusText}</span>
              </div>
            )}
          </div>

          {errorMsg && (
            <div className="p-2.5 rounded bg-rose-50 border border-rose-200 text-xs font-mono text-rose-700">
              {errorMsg}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="space-y-1">
              <label className="text-[11px] font-mono text-slate-500">Room ID</label>
              <input
                type="text"
                value={room}
                disabled={streaming}
                onChange={(e) => setRoom(e.target.value.replace(/[^a-zA-Z0-9_-]/g, ''))}
                className="w-full px-2.5 py-1.5 font-mono text-xs bg-[#F8FBF9] border border-slate-200 rounded disabled:opacity-60"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[11px] font-mono text-slate-500">Transport Protocol</label>
              <div className="grid grid-cols-2 gap-1 p-0.5 bg-[#EDF5F0] border border-emerald-900/10 rounded">
                <button
                  disabled={streaming}
                  onClick={() => setTransport('webrtc')}
                  className={`py-1 text-[11px] font-semibold rounded cursor-pointer disabled:opacity-60 ${
                    transport === 'webrtc' ? 'bg-emerald-600 text-white' : 'text-slate-600'
                  }`}
                >
                  WebRTC
                </button>
                <button
                  disabled={streaming}
                  onClick={() => setTransport('camerax-ws')}
                  className={`py-1 text-[11px] font-semibold rounded cursor-pointer disabled:opacity-60 ${
                    transport === 'camerax-ws' ? 'bg-emerald-600 text-white' : 'text-slate-600'
                  }`}
                >
                  WS JPEG
                </button>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 pt-1">
            {streaming ? (
              <button
                onClick={stopPublishing}
                className="flex-1 py-2.5 px-4 text-xs font-semibold rounded-md bg-rose-600 hover:bg-rose-700 text-white flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <CameraOff className="w-4 h-4" />
                <span>Stop Broadcasting</span>
              </button>
            ) : (
              <button
                onClick={() => void startPublishing()}
                className="flex-1 py-2.5 px-4 text-xs font-semibold rounded-md bg-emerald-600 hover:bg-emerald-700 text-white flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Wifi className="w-4 h-4" />
                <span>Start Live Stream to Console</span>
              </button>
            )}

            <button
              onClick={() => {
                const next = facing === 'environment' ? 'user' : 'environment';
                setFacing(next);
                if (streaming) void startPublishing(next, transport);
              }}
              className="py-2.5 px-3 text-xs font-medium rounded-md bg-[#F8FBF9] border border-slate-200 text-slate-700 hover:bg-emerald-50 flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5 text-emerald-600" />
              <span>{facing === 'environment' ? 'Rear' : 'Front'}</span>
            </button>
          </div>
        </div>
      </main>
    </div>
  );
};
