import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
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
  lastReportedIp?: string;
  lastInterfaceName?: string;
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

  // Safe, read-only MaixSense USB drive & RNDIS interface discovery (no shell execution, no SSRF)
  app.get('/api/maixsense/discover', (_req, res) => {
    const MAIX_KEYS = ['maixsense', 'sipeed', 'a075', 'a010', 'rndis', 'tof'];
    const IPV4_REGEX = /\b((?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3})\b/g;
    const TEXT_EXTS = new Set(['.txt', '.url', '.html', '.htm', '.ini', '.cfg', '.conf', '.json', '.md']);

    const drivesChecked: string[] = [];
    let driveFound = false;
    let drivePath: string | null = null;
    let ipFromDrive: string | null = null;

    const mountBases = ['/media', '/run/media', '/mnt', '/Volumes'];
    for (const base of mountBases) {
      if (!fs.existsSync(base)) continue;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(base, { withFileTypes: true }).slice(0, 32);
      } catch {
        continue;
      }

      const candidates: string[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const full = path.join(base, entry.name);
        if (base === '/media' || base === '/run/media') {
          try {
            const subDirs = fs
              .readdirSync(full, { withFileTypes: true })
              .filter((d) => d.isDirectory())
              .slice(0, 16);
            if (subDirs.length > 0) {
              for (const sub of subDirs) candidates.push(path.join(full, sub.name));
              continue;
            }
          } catch {
            // Fall through to check full directly
          }
        }
        candidates.push(full);
      }

      for (const volPath of candidates) {
        drivesChecked.push(volPath);
        const lowerVol = path.basename(volPath).toLowerCase();
        let isMaix = MAIX_KEYS.some((k) => lowerVol.includes(k));

        try {
          const files = fs.readdirSync(volPath, { withFileTypes: true }).slice(0, 40);
          for (const f of files) {
            const fname = f.name.toLowerCase();
            if (MAIX_KEYS.some((k) => fname.includes(k))) isMaix = true;
            if (!f.isFile()) continue;
            const ext = path.extname(fname);
            if (!TEXT_EXTS.has(ext) && !fname.includes('ip') && !fname.includes('maix')) continue;

            const filePath = path.join(volPath, f.name);
            try {
              const stat = fs.statSync(filePath);
              if (stat.size > 64 * 1024) continue;
              const text = fs.readFileSync(filePath, 'utf8');
              const matches = text.match(IPV4_REGEX);
              if (matches && matches.length > 0) {
                const preferred = matches.find((ip) => ip.startsWith('192.168.233.')) || matches[0];
                if (isMaix || preferred.startsWith('192.168.233.')) {
                  driveFound = true;
                  drivePath = volPath;
                  ipFromDrive = preferred;
                  break;
                }
              }
            } catch {
              // Ignore unreadable file
            }
          }
        } catch {
          // Ignore unreadable mount
        }

        if (isMaix && !driveFound) {
          driveFound = true;
          drivePath = volPath;
        }
        if (ipFromDrive) break;
      }
      if (ipFromDrive) break;
    }

    // Inspect host network interfaces for USB RNDIS 192.168.233.x subnet
    const rndisInterfaces: Array<{ name: string; hostIp: string; cameraIp: string }> = [];
    const nets = os.networkInterfaces();
    for (const [ifName, addrs] of Object.entries(nets)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal && addr.address.startsWith('192.168.233.')) {
          const parts = addr.address.split('.');
          rndisInterfaces.push({
            name: ifName,
            hostIp: addr.address,
            cameraIp: `${parts[0]}.${parts[1]}.${parts[2]}.1`,
          });
        }
      }
    }

    // Check active MaixSense publishers currently streaming over /ws/camera
    const activePublishers: Array<{
      room: string;
      id: string;
      label: string;
      framesRelayed: number;
      connectedAt: number;
    }> = [];
    for (const [roomId, peers] of rooms.entries()) {
      for (const peer of peers.values()) {
        if (
          peer.role === 'publisher' &&
          peer.ws.readyState === WebSocket.OPEN &&
          (peer.transport === 'maixsense' || peer.label.toLowerCase().includes('maixsense'))
        ) {
          activePublishers.push({
            room: roomId,
            id: peer.id,
            label: peer.label,
            framesRelayed: peer.framesRelayed,
            connectedAt: peer.connectedAt,
          });
        }
      }
    }

    const detectedIp = ipFromDrive || rndisInterfaces[0]?.cameraIp || '192.168.233.1';
    const ipSource = ipFromDrive
      ? `USB Drive (${drivePath})`
      : rndisInterfaces[0]
      ? `USB RNDIS (${rndisInterfaces[0].name})`
      : 'Default MaixSense-A075V IP';

    const isCloudContainer = Boolean(process.env.K_SERVICE || process.env.CLOUD_RUN_JOB);

    res.json({
      ok: true,
      hostOs: `${os.platform()} (${os.arch()})`,
      isCloudContainer,
      drivesChecked,
      driveFound,
      drivePath,
      ipFromDrive,
      rndisInterfaces,
      detectedIp,
      ipSource,
      activePublishers,
      checkedAt: new Date().toISOString(),
    });
  });

  // Download fixed MaixSense drive/IP discovery & WebSocket bridge script
  app.get('/api/maixsense/script', (_req, res) => {
    const allowedDir = path.resolve(__dirname, 'Navigation', 'src');
    const scriptPath = path.resolve(allowedDir, 'maixsense_bridge.py');
    if (!scriptPath.startsWith(allowedDir + path.sep) || !fs.existsSync(scriptPath)) {
      res.status(404).json({ ok: false, error: 'Bridge script not found.' });
      return;
    }
    res.setHeader('Content-Type', 'text/x-python; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="maixsense_bridge.py"');
    res.sendFile(scriptPath);
  });

  // Safe local network OUI / manufacturer prefix scanner for MaixSense camera (read-only ARP + NICs + WS bridges)
  app.get('/api/maixsense/scan-network', (req, res) => {
    const OUI_TABLE: Array<{
      prefix: string;
      vendor: string;
      role: string;
      priority: 'high' | 'medium';
    }> = [
      { prefix: '00:E0:4C', vendor: 'Realtek Semiconductor (USB-RNDIS / Eth)', role: 'MaixSense USB-Ethernet / RNDIS Bridge', priority: 'high' },
      { prefix: '18:93:7F', vendor: 'Sipeed / Allwinner Linux SoC', role: 'MaixSense-A075V SoC', priority: 'high' },
      { prefix: '88:12:4E', vendor: 'Allwinner / Embedded Linux Gadget', role: 'MaixSense ToF Module', priority: 'high' },
      { prefix: '42:4C:00', vendor: 'Bouffalo Lab / Sipeed Embedded', role: 'MaixSense-A010 / Companion', priority: 'high' },
      { prefix: '00:1A:79', vendor: 'Embedded Linux IP Camera', role: 'ToF/RGB Camera Firmware', priority: 'medium' },
      { prefix: '28:6C:07', vendor: 'Allwinner / Smart Camera Module', role: 'Linux Camera SoC', priority: 'medium' },
      { prefix: '30:AE:A4', vendor: 'Espressif Systems', role: 'Rover ESP32 / Camera Bridge', priority: 'medium' },
      { prefix: '24:6F:28', vendor: 'Espressif Systems', role: 'Rover ESP32 / Wi-Fi Bridge', priority: 'medium' },
      { prefix: 'DC:A6:32', vendor: 'Raspberry Pi Trading', role: 'Rover Companion Pi', priority: 'medium' },
      { prefix: 'E4:5F:01', vendor: 'Raspberry Pi Trading', role: 'Rover Companion Pi', priority: 'medium' },
    ];

    const OUI_REGEX = /^[0-9A-F]{2}:[0-9A-F]{2}:[0-9A-F]{2}$/;
    const customRaw = typeof req.query.prefixes === 'string' ? req.query.prefixes : '';
    const customEntries = customRaw
      .split(',')
      .map((s) => s.trim().toUpperCase().replace(/-/g, ':'))
      .filter((s) => OUI_REGEX.test(s))
      .slice(0, 10)
      .map((prefix) => ({
        prefix,
        vendor: 'Custom Manufacturer Prefix',
        role: 'User-Specified OUI',
        priority: 'high' as const,
      }));

    const activeOuiTable = [...customEntries, ...OUI_TABLE];

    const matchMacPrefix = (
      macRaw: string,
      ip: string,
      ifName: string
    ): {
      matched: boolean;
      vendor: string;
      matchedPrefix: string;
      confidence: 'high' | 'medium' | 'low';
    } => {
      const mac = macRaw.trim().toUpperCase().replace(/-/g, ':');
      if (!mac || mac === '00:00:00:00:00:00') {
        return { matched: false, vendor: 'Unknown', matchedPrefix: '—', confidence: 'low' };
      }
      const prefix3 = mac.slice(0, 8);
      const exact = activeOuiTable.find((entry) => entry.prefix === prefix3);
      if (exact) {
        return {
          matched: true,
          vendor: exact.vendor,
          matchedPrefix: exact.prefix,
          confidence: ip.startsWith('192.168.233.') ? 'high' : exact.priority,
        };
      }

      // Check locally-administered unicast MAC (bit 1 of first octet set, bit 0 clear):
      // Linux USB RNDIS gadget (f_rndis / g_ether) on Sipeed MaixSense-A075V assigns locally-administered MACs.
      const firstOctet = parseInt(mac.slice(0, 2), 16);
      const isLocallyAdministered =
        Number.isFinite(firstOctet) && (firstOctet & 0x02) !== 0 && (firstOctet & 0x01) === 0;
      const isUsbIf = /^(usb|rndis|enx|eth\d)/i.test(ifName);

      if (ip.startsWith('192.168.233.') || (isLocallyAdministered && isUsbIf)) {
        return {
          matched: true,
          vendor: 'Linux USB-RNDIS Gadget (Sipeed MaixSense-A075V)',
          matchedPrefix: `${prefix3} (LAA/RNDIS)`,
          confidence: ip.startsWith('192.168.233.') ? 'high' : 'medium',
        };
      }

      return { matched: false, vendor: 'Unlisted Vendor', matchedPrefix: prefix3, confidence: 'low' };
    };

    interface NetworkCandidate {
      ip: string;
      mac: string;
      interfaceName: string;
      manufacturer: string;
      matchedPrefix: string;
      confidence: 'high' | 'medium' | 'low';
      source: 'ws_bridge' | 'arp_table' | 'rndis_adapter';
      reachable: boolean;
    }

    const candidates: NetworkCandidate[] = [];
    const seenIps = new Set<string>();
    const scannedSubnets: string[] = [];

    // 1. Live MaixSense WebSocket bridges already streaming to /ws/camera
    let activeWsBridges = 0;
    for (const [roomId, peers] of rooms.entries()) {
      for (const peer of peers.values()) {
        if (
          peer.role === 'publisher' &&
          peer.ws.readyState === WebSocket.OPEN &&
          (peer.transport === 'maixsense' || peer.label.toLowerCase().includes('maixsense'))
        ) {
          activeWsBridges += 1;
          const ipMatch = peer.label.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
          const bridgeIp = peer.lastReportedIp || (ipMatch ? ipMatch[1] : '192.168.233.1');
          if (!seenIps.has(bridgeIp)) {
            seenIps.add(bridgeIp);
            candidates.push({
              ip: bridgeIp,
              mac: 'USB-RNDIS / WS',
              interfaceName: peer.lastInterfaceName || `WS room:${roomId}`,
              manufacturer: 'Sipeed MaixSense (Verified Live Bridge)',
              matchedPrefix: '192.168.233.x / WS',
              confidence: 'high',
              source: 'ws_bridge',
              reachable: true,
            });
          }
        }
      }
    }

    // 2. Host network interfaces (inspecting RNDIS adapters & local subnets)
    const nets = os.networkInterfaces();
    for (const [ifName, addrs] of Object.entries(nets)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (addr.family !== 'IPv4' || addr.internal) continue;
        const octets = addr.address.split('.');
        if (octets.length === 4) {
          const subnet = `${octets[0]}.${octets[1]}.${octets[2]}.0/24`;
          if (!scannedSubnets.includes(subnet)) scannedSubnets.push(subnet);
        }

        if (addr.address.startsWith('192.168.233.')) {
          const camIp = `${octets[0]}.${octets[1]}.${octets[2]}.1`;
          if (!seenIps.has(camIp)) {
            seenIps.add(camIp);
            const m = matchMacPrefix(addr.mac || '', camIp, ifName);
            candidates.push({
              ip: camIp,
              mac: (addr.mac || '00:00:00:00:00:00').toUpperCase(),
              interfaceName: ifName,
              manufacturer: m.matched ? m.vendor : 'Sipeed MaixSense USB-RNDIS Adapter',
              matchedPrefix: m.matchedPrefix,
              confidence: 'high',
              source: 'rndis_adapter',
              reachable: true,
            });
          }
        }
      }
    }

    // 3. Read-only Linux kernel ARP neighbor table (/proc/net/arp)
    let arpEntriesScanned = 0;
    try {
      if (fs.existsSync('/proc/net/arp')) {
        const arpRaw = fs.readFileSync('/proc/net/arp', 'utf8');
        const lines = arpRaw.split('\n').slice(1);
        for (const line of lines) {
          const cols = line.trim().split(/\s+/);
          if (cols.length < 6) continue;
          const [ip, _hwType, flags, mac, _mask, dev] = cols;
          if (!ip || !mac || mac === '00:00:00:00:00:00') continue;
          arpEntriesScanned += 1;

          const match = matchMacPrefix(mac, ip, dev || '');
          if (match.matched && !seenIps.has(ip)) {
            seenIps.add(ip);
            candidates.push({
              ip,
              mac: mac.toUpperCase(),
              interfaceName: dev || 'lan',
              manufacturer: match.vendor,
              matchedPrefix: match.matchedPrefix,
              confidence: match.confidence,
              source: 'arp_table',
              reachable: flags !== '0x0',
            });
          }
        }
      }
    } catch {
      // Ignore environments without /proc/net/arp
    }

    // Sort candidates: live WS bridge & high confidence first
    const rank = { high: 0, medium: 1, low: 2 };
    candidates.sort((a, b) => {
      if (a.source === 'ws_bridge' && b.source !== 'ws_bridge') return -1;
      if (b.source === 'ws_bridge' && a.source !== 'ws_bridge') return 1;
      return rank[a.confidence] - rank[b.confidence];
    });

    const top = candidates[0] || null;
    const status =
      activeWsBridges > 0 || (top && top.source === 'rndis_adapter')
        ? 'connected'
        : top
        ? 'detected'
        : 'offline';

    const connectionMethod =
      activeWsBridges > 0
        ? 'ws_bridge'
        : top?.source === 'rndis_adapter'
        ? 'rndis_interface'
        : top?.source === 'arp_table'
        ? 'rndis_arp'
        : 'none';

    res.json({
      ok: true,
      status,
      resolvedIp: top?.ip ?? null,
      resolvedMac: top?.mac ?? null,
      resolvedVendor: top?.manufacturer ?? null,
      matchedPrefix: top?.matchedPrefix ?? null,
      connectionMethod,
      isCloudContainer: Boolean(process.env.K_SERVICE || process.env.CLOUD_RUN_JOB),
      hostOs: `${os.platform()} (${os.arch()})`,
      scannedSubnets,
      prefixesQueried: activeOuiTable.length,
      arpEntriesScanned,
      activeWsBridges,
      candidates,
      scannedAt: new Date().toISOString(),
    });
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

      // Sanitized MaixSense ToF depth + drive/IP discovery telemetry relay
      if (msg.type === 'maixsense:telemetry' && peer.role === 'publisher') {
        const safeNum = (v: unknown): number | null =>
          typeof v === 'number' && Number.isFinite(v) ? v : null;
        const safeStr = (v: unknown, max = 96): string =>
          typeof v === 'string' ? v.slice(0, max) : '';

        const reportedIp = safeStr(msg.ip, 45);
        const reportedIf = safeStr(msg.interfaceName, 96);
        if (reportedIp) peer.lastReportedIp = reportedIp;
        if (reportedIf) peer.lastInterfaceName = reportedIf;

        const out = JSON.stringify({
          type: 'maixsense:telemetry',
          from: peerId,
          label: peer.label,
          ip: reportedIp,
          ipSource: safeStr(msg.ipSource, 96),
          driveFound: Boolean(msg.driveFound),
          drivePath: safeStr(msg.drivePath, 128),
          interfaceName: reportedIf,
          endpoint: safeStr(msg.endpoint, 32),
          frameId: safeNum(msg.frameId) ?? 0,
          fps: safeNum(msg.fps) ?? 0,
          latencyMs: safeNum(msg.latencyMs) ?? 0,
          centerDepthMm: safeNum(msg.centerDepthMm),
          minDepthMm: safeNum(msg.minDepthMm),
          maxDepthMm: safeNum(msg.maxDepthMm),
          rgbBytes: safeNum(msg.rgbBytes) ?? 0,
          depthBytes: safeNum(msg.depthBytes) ?? 0,
          ts: Date.now(),
        });

        for (const target of currentRoom.values()) {
          if (target.role === 'viewer' && target.ws.readyState === WebSocket.OPEN) {
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
