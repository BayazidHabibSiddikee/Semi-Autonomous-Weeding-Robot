import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket, RawData } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

type ClientRole = 'publisher' | 'viewer';

interface CameraPeer {
  id: string;
  role: ClientRole;
  room: string;
  transport: string;
  label: string;
  ws: WebSocket;
  connectedAt: number;
  framesRelayed: number;
  bytesRelayed: number;
}

const rooms = new Map<string, Map<string, CameraPeer>>();

function getRoom(roomId: string): Map<string, CameraPeer> {
  let r = rooms.get(roomId);
  if (!r) {
    r = new Map();
    rooms.set(roomId, r);
  }
  return r;
}

function broadcastPresence(roomId: string) {
  const room = rooms.get(roomId);
  if (!room) return;

  const publishers: Array<{ id: string; label: string; transport: string; connectedAt: number }> = [];
  let viewersCount = 0;

  for (const peer of room.values()) {
    if (peer.ws.readyState !== WebSocket.OPEN) continue;
    if (peer.role === 'publisher') {
      publishers.push({
        id: peer.id,
        label: peer.label,
        transport: peer.transport,
        connectedAt: peer.connectedAt,
      });
    } else {
      viewersCount++;
    }
  }

  const payload = JSON.stringify({
    type: 'presence',
    room: roomId,
    publishers,
    viewersCount,
    serverTime: Date.now(),
  });

  for (const peer of room.values()) {
    if (peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(payload);
    }
  }
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Diagnostic endpoint for active camera rooms & publishers
  app.get('/api/camera/rooms', (_req, res) => {
    const summary: Array<{
      room: string;
      publishers: Array<{ id: string; label: string; transport: string; framesRelayed: number }>;
      viewersCount: number;
    }> = [];

    for (const [roomId, peers] of rooms.entries()) {
      const publishers: Array<{ id: string; label: string; transport: string; framesRelayed: number }> = [];
      let viewersCount = 0;
      for (const peer of peers.values()) {
        if (peer.role === 'publisher') {
          publishers.push({
            id: peer.id,
            label: peer.label,
            transport: peer.transport,
            framesRelayed: peer.framesRelayed,
          });
        } else {
          viewersCount++;
        }
      }
      summary.push({ room: roomId, publishers, viewersCount });
    }

    res.json({ ok: true, rooms: summary });
  });

  const server = http.createServer(app);

  // Real-time WebSocket server on /ws/camera for WebRTC signaling AND CameraX/MJPEG binary frame relay
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });

  server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
      if (url.pathname === '/ws/camera') {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request, url);
        });
      } else {
        socket.destroy();
      }
    } catch {
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket, _req: http.IncomingMessage, url: URL) => {
    const rawRoom = (url.searchParams.get('room') || 'rover-01').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32);
    const roomId = rawRoom || 'rover-01';
    const role: ClientRole = url.searchParams.get('role') === 'publisher' ? 'publisher' : 'viewer';
    const transport = (url.searchParams.get('transport') || 'webrtc').slice(0, 24);
    const label = (
      url.searchParams.get('label') ||
      (role === 'publisher' ? `${transport.toUpperCase()} Camera` : 'Nav Console Viewer')
    ).slice(0, 64);

    const peerId = `${role}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const peer: CameraPeer = {
      id: peerId,
      role,
      room: roomId,
      transport,
      label,
      ws,
      connectedAt: Date.now(),
      framesRelayed: 0,
      bytesRelayed: 0,
    };

    const room = getRoom(roomId);
    room.set(peerId, peer);

    // Send initial identity handshake
    ws.send(
      JSON.stringify({
        type: 'welcome',
        peerId,
        room: roomId,
        role,
        serverTime: Date.now(),
      })
    );
    broadcastPresence(roomId);

    // Notify existing publishers that a viewer joined so WebRTC publishers can initiate offers immediately
    if (role === 'viewer') {
      const notify = JSON.stringify({
        type: 'viewer:joined',
        viewerId: peerId,
        room: roomId,
      });
      for (const other of room.values()) {
        if (other.role === 'publisher' && other.ws.readyState === WebSocket.OPEN) {
          other.ws.send(notify);
        }
      }
    }

    ws.on('message', (data: RawData, isBinary: boolean) => {
      const currentRoom = rooms.get(roomId);
      if (!currentRoom) return;

      // Binary JPEG frames from Android CameraX (OkHttp WebSocket) or browser WebSocket publisher
      if (isBinary) {
        if (peer.role !== 'publisher') return;
        const byteLen = Buffer.isBuffer(data)
          ? data.byteLength
          : Array.isArray(data)
          ? data.reduce((acc, b) => acc + b.byteLength, 0)
          : data.byteLength;
        peer.framesRelayed += 1;
        peer.bytesRelayed += byteLen;

        for (const target of currentRoom.values()) {
          if (
            target.role === 'viewer' &&
            target.ws.readyState === WebSocket.OPEN &&
            target.ws.bufferedAmount < 512 * 1024
          ) {
            target.ws.send(data, { binary: true });
          }
        }
        return;
      }

      // Text JSON control & WebRTC signaling messages
      let msg: any;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', ts: msg.ts || Date.now() }));
        return;
      }

      // Base64 JPEG frame over JSON (optional compatibility for Python/ROS2/CameraX JSON clients)
      if (msg.type === 'frame:jpeg' && peer.role === 'publisher' && typeof msg.data === 'string') {
        peer.framesRelayed += 1;
        const out = JSON.stringify({
          type: 'frame:jpeg',
          from: peerId,
          label: peer.label,
          ts: msg.ts || Date.now(),
          width: msg.width,
          height: msg.height,
          data: msg.data,
        });
        for (const target of currentRoom.values()) {
          if (
            target.role === 'viewer' &&
            target.ws.readyState === WebSocket.OPEN &&
            target.ws.bufferedAmount < 512 * 1024
          ) {
            target.ws.send(out);
          }
        }
        return;
      }

      // WebRTC signaling relay (offer, answer, ice-candidate, request-offer)
      if (
        msg.type === 'webrtc:offer' ||
        msg.type === 'webrtc:answer' ||
        msg.type === 'webrtc:ice' ||
        msg.type === 'webrtc:request-offer'
      ) {
        const envelope = JSON.stringify({
          ...msg,
          from: peerId,
          fromRole: peer.role,
          fromLabel: peer.label,
        });

        if (typeof msg.to === 'string' && currentRoom.has(msg.to)) {
          const target = currentRoom.get(msg.to);
          if (target && target.ws.readyState === WebSocket.OPEN) {
            target.ws.send(envelope);
          }
        } else {
          // Broadcast to opposite role in the same room
          const targetRole: ClientRole = peer.role === 'publisher' ? 'viewer' : 'publisher';
          for (const target of currentRoom.values()) {
            if (target.role === targetRole && target.ws.readyState === WebSocket.OPEN) {
              target.ws.send(envelope);
            }
          }
        }
      }
    });

    ws.on('close', () => {
      const currentRoom = rooms.get(roomId);
      if (!currentRoom) return;
      currentRoom.delete(peerId);
      if (currentRoom.size === 0) {
        rooms.delete(roomId);
      } else {
        broadcastPresence(roomId);
      }
    });

    ws.on('error', () => {
      try {
        ws.close();
      } catch {
        // Ignore close errors
      }
    });
  });

  // Mount Vite middleware in development or static dist in production
  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[CameraStreamServer] Listening on http://0.0.0.0:${PORT} (WebSocket /ws/camera ready)`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
