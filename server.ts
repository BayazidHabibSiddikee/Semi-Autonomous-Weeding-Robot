import express from 'express';
import fs from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
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
  lastLatencyMs?: number;
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

  // Safe MaixSense hardware accessibility diagnostic: TCP ping + RTSP/MJPEG probe + force stream reconnect
  app.post('/api/maixsense/diagnose', async (req, res) => {
    const rawIp = typeof req.body?.ip === 'string' ? req.body.ip.trim() : '';
    const rawProtocol = typeof req.body?.protocol === 'string' ? req.body.protocol.toLowerCase() : 'auto';
    const protocol: 'auto' | 'mjpeg' | 'rtsp' =
      rawProtocol === 'mjpeg' || rawProtocol === 'rtsp' ? rawProtocol : 'auto';
    const rawRoom = typeof req.body?.room === 'string' ? req.body.room : 'rover-01';
    const roomId = rawRoom.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'rover-01';
    const forceReconnect = req.body?.forceReconnect !== false;

    const IPV4_REGEX =
      /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
    if (!IPV4_REGEX.test(rawIp)) {
      res.status(400).json({ ok: false, error: 'Invalid IPv4 address format.' });
      return;
    }

    const octets = rawIp.split('.').map(Number);
    const isPrivateLan =
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168);

    // Explicitly block loopback (127.x), link-local/metadata (169.254.x), 0.x, multicast, and public IPs
    if (!isPrivateLan) {
      res.status(400).json({
        ok: false,
        error: 'Diagnostic target must be a local private LAN IPv4 address (e.g. 192.168.233.1).',
      });
      return;
    }

    const isCloudContainer = Boolean(process.env.K_SERVICE || process.env.CLOUD_RUN_JOB);

    // Collect local host subnets & ARP entries so local probes stay strictly within attached LANs / RNDIS
    const localPrefixes = new Set<string>(['192.168.233.']);
    const nets = os.networkInterfaces();
    for (const addrs of Object.values(nets)) {
      if (!addrs) continue;
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && !addr.internal) {
          const p = addr.address.split('.');
          if (p.length === 4) localPrefixes.add(`${p[0]}.${p[1]}.${p[2]}.`);
        }
      }
    }
    const targetPrefix = `${octets[0]}.${octets[1]}.${octets[2]}.`;
    const isAttachedLocalSubnet = localPrefixes.has(targetPrefix);

    type StepStatus = 'pass' | 'warn' | 'fail' | 'info';
    const steps: Array<{
      id: string;
      label: string;
      status: StepStatus;
      detail: string;
      durationMs?: number;
    }> = [];

    const tcpProbe = (
      host: string,
      port: number,
      timeoutMs = 1100
    ): Promise<{ open: boolean; rttMs: number | null; error?: string }> =>
      new Promise((resolve) => {
        const started = Date.now();
        const socket = new net.Socket();
        let settled = false;
        const finish = (open: boolean, error?: string) => {
          if (settled) return;
          settled = true;
          try {
            socket.destroy();
          } catch {
            // Ignore cleanup error
          }
          resolve({ open, rttMs: open ? Date.now() - started : null, error });
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false, 'timeout'));
        socket.once('error', (err) => finish(false, err.message));
        socket.connect(port, host);
      });

    const rtspOptionsProbe = (
      host: string,
      port = 554,
      timeoutMs = 1300
    ): Promise<{ ok: boolean; statusLine: string | null; rttMs: number | null }> =>
      new Promise((resolve) => {
        const started = Date.now();
        const socket = new net.Socket();
        let settled = false;
        let responseBuf = '';
        const finish = (ok: boolean, statusLine: string | null) => {
          if (settled) return;
          settled = true;
          try {
            socket.destroy();
          } catch {
            // Ignore cleanup error
          }
          resolve({ ok, statusLine, rttMs: ok ? Date.now() - started : null });
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => {
          socket.write(`OPTIONS rtsp://${host}:${port}/ RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: WeedingRover-Audit/1.0\r\n\r\n`);
        });
        socket.on('data', (chunk) => {
          responseBuf += chunk.toString('utf8');
          if (responseBuf.includes('\r\n')) {
            const firstLine = responseBuf.split('\r\n')[0].trim();
            finish(firstLine.startsWith('RTSP/'), firstLine);
          }
        });
        socket.once('timeout', () => finish(false, null));
        socket.once('error', () => finish(false, null));
        socket.connect(port, host);
      });

    const httpProbe = (
      host: string,
      port: number,
      urlPath: string,
      method: 'GET' | 'POST' = 'GET',
      body?: Buffer,
      timeoutMs = 1400
    ): Promise<{ ok: boolean; statusCode: number | null; contentType: string; bytes: number; rttMs: number }> =>
      new Promise((resolve) => {
        const started = Date.now();
        const reqOpts: http.RequestOptions = {
          hostname: host,
          port,
          path: urlPath,
          method,
          timeout: timeoutMs,
          headers: body
            ? {
                'Content-Type': 'application/octet-stream',
                'Content-Length': body.byteLength,
                'User-Agent': 'WeedingRover-Audit/1.0',
              }
            : { 'User-Agent': 'WeedingRover-Audit/1.0' },
        };
        const hReq = http.request(reqOpts, (hRes) => {
          let bytes = 0;
          const contentType = String(hRes.headers['content-type'] || '');
          const statusCode = hRes.statusCode ?? null;
          hRes.on('data', (chunk: Buffer) => {
            bytes += chunk.byteLength;
            // Cap read for MJPEG infinite streams after confirming stream headers + initial bytes
            if (bytes >= 8192) {
              hRes.destroy();
            }
          });
          const done = () =>
            resolve({
              ok: statusCode !== null && statusCode >= 200 && statusCode < 400,
              statusCode,
              contentType,
              bytes,
              rttMs: Date.now() - started,
            });
          hRes.once('end', done);
          hRes.once('close', done);
        });
        hReq.once('timeout', () => {
          hReq.destroy();
          resolve({ ok: false, statusCode: null, contentType: '', bytes: 0, rttMs: Date.now() - started });
        });
        hReq.once('error', () => {
          resolve({ ok: false, statusCode: null, contentType: '', bytes: 0, rttMs: Date.now() - started });
        });
        if (body) hReq.write(body);
        hReq.end();
      });

    // 1. Check active WebSocket MaixSense publishers/viewers in /ws/camera and optionally trigger reconnect
    let wsPublishersSignaled = 0;
    let wsViewersSignaled = 0;
    let matchingBridgeFound = false;
    let matchingBridgeLatencyMs: number | null = null;
    let activeFramesRelayed = 0;

    const reconnectSignalPayload = JSON.stringify({
      type: 'maixsense:reconnect',
      ip: rawIp,
      protocol,
      room: roomId,
      reason: 'hardware_audit_diagnostic',
      requestedAt: Date.now(),
    });

    for (const [rId, peers] of rooms.entries()) {
      for (const peer of peers.values()) {
        if (peer.ws.readyState !== WebSocket.OPEN) continue;
        const isMaixPub =
          peer.role === 'publisher' &&
          (peer.transport === 'maixsense' || peer.label.toLowerCase().includes('maixsense'));
        if (isMaixPub) {
          activeFramesRelayed += peer.framesRelayed;
          if (peer.lastReportedIp === rawIp || peer.label.includes(rawIp) || rId === roomId) {
            matchingBridgeFound = true;
            if (typeof peer.lastLatencyMs === 'number' && Number.isFinite(peer.lastLatencyMs)) {
              matchingBridgeLatencyMs = Math.round(peer.lastLatencyMs);
            }
          }
          if (forceReconnect) {
            try {
              peer.ws.send(reconnectSignalPayload);
              wsPublishersSignaled += 1;
            } catch {
              // Ignore transient send error
            }
          }
        } else if (peer.role === 'viewer' && rId === roomId && forceReconnect) {
          try {
            peer.ws.send(reconnectSignalPayload);
            wsViewersSignaled += 1;
          } catch {
            // Ignore transient send error
          }
        }
      }
    }

    const portMatrix: Array<{ port: number; service: string; open: boolean; rttMs: number | null }> = [
      { port: 80, service: 'HTTP / MJPEG /getdeep', open: false, rttMs: null },
      { port: 554, service: 'RTSP Stream', open: false, rttMs: null },
      { port: 81, service: 'Alt MJPEG :81', open: false, rttMs: null },
      { port: 8080, service: 'Alt HTTP/MJPEG :8080', open: false, rttMs: null },
    ];

    let pingReachable = false;
    let pingRttMs: number | null = null;
    let pingMethod: 'tcp_socket_probe' | 'ws_bridge_heartbeat' | 'browser_local_required' = 'tcp_socket_probe';
    let pingDetail = '';

    let streamProtocolFound: 'MJPEG/HTTP' | 'RTSP' | 'WS-Bridge' | 'None' = 'None';
    let streamEndpointUrl = protocol === 'rtsp' ? `rtsp://${rawIp}:554/` : `http://${rawIp}/getdeep`;
    let streamAccessible = false;
    let streamStatusLine: string | null = null;
    let streamDetail = '';
    let hardwareSetCfgOk = false;

    if (isCloudContainer) {
      // Never probe arbitrary internal cloud RFC1918 networks from a remote container
      pingMethod = matchingBridgeFound ? 'ws_bridge_heartbeat' : 'browser_local_required';
      pingReachable = matchingBridgeFound;
      pingRttMs = matchingBridgeFound ? matchingBridgeLatencyMs : null;
      pingDetail = matchingBridgeFound
        ? `Verified via live MaixSense WebSocket bridge (${activeFramesRelayed} frames relayed${
            matchingBridgeLatencyMs !== null ? `, ${matchingBridgeLatencyMs} ms frame RTT` : ''
          }).`
        : `Server runs in a cloud container and cannot directly reach local LAN ${rawIp}. Run maixsense_bridge.py locally or open this console on http://localhost:3000.`;

      steps.push({
        id: 'ping',
        label: `Ping ${rawIp}`,
        status: matchingBridgeFound ? 'pass' : 'warn',
        detail: pingDetail,
        durationMs: pingRttMs ?? undefined,
      });

      if (matchingBridgeFound) {
        streamProtocolFound = 'WS-Bridge';
        streamEndpointUrl = `/ws/camera?room=${roomId}&transport=maixsense`;
        streamAccessible = true;
        streamStatusLine = 'WS_BRIDGE_ACTIVE';
        streamDetail = `Active MaixSense bridge streaming (${activeFramesRelayed} frames relayed). Sent force-reconnect + POST /set_cfg trigger to ${wsPublishersSignaled} publisher(s).`;
        steps.push({
          id: 'stream',
          label: 'Stream Accessibility & Force Reconnect',
          status: 'pass',
          detail: streamDetail,
        });
      } else {
        streamDetail = `No active MaixSense bridge connected in room "${roomId}". Cannot verify RTSP/MJPEG stream from remote cloud container.`;
        steps.push({
          id: 'stream',
          label: 'RTSP / MJPEG Stream Probe',
          status: 'fail',
          detail: streamDetail,
        });
      }
    } else if (!isAttachedLocalSubnet) {
      pingMethod = 'tcp_socket_probe';
      pingReachable = matchingBridgeFound;
      pingDetail = `Target ${rawIp} is outside attached host LAN subnets (${Array.from(localPrefixes).join(', ')}). Check USB-RNDIS adapter or LAN routing.`;
      steps.push({
        id: 'ping',
        label: `Subnet & Ping Check (${rawIp})`,
        status: matchingBridgeFound ? 'warn' : 'fail',
        detail: pingDetail,
      });
    } else {
      // Local host (PC / Raspberry Pi): safe non-shell TCP socket probes on fixed camera ports
      const probeResults = await Promise.all(portMatrix.map((entry) => tcpProbe(rawIp, entry.port, 1100)));
      probeResults.forEach((r, idx) => {
        portMatrix[idx].open = r.open;
        portMatrix[idx].rttMs = r.rttMs;
      });

      const firstOpen = portMatrix.find((p) => p.open);
      pingReachable = Boolean(firstOpen) || matchingBridgeFound;
      pingRttMs = firstOpen?.rttMs ?? null;
      pingMethod = firstOpen ? 'tcp_socket_probe' : matchingBridgeFound ? 'ws_bridge_heartbeat' : 'tcp_socket_probe';
      pingDetail = firstOpen
        ? `Host ${rawIp} responded on TCP port ${firstOpen.port} (${firstOpen.service}) in ${firstOpen.rttMs} ms.`
        : `No response from ${rawIp} on ports 80, 554, 81, or 8080 (timed out after 1100 ms).`;

      steps.push({
        id: 'ping',
        label: `TCP Ping ${rawIp}`,
        status: pingReachable ? 'pass' : 'fail',
        detail: pingDetail,
        durationMs: pingRttMs ?? undefined,
      });

      // Probe RTSP if requested or port 554 is open
      const port554Open = portMatrix[1].open;
      if ((protocol === 'rtsp' || protocol === 'auto') && port554Open) {
        const rtspRes = await rtspOptionsProbe(rawIp, 554, 1300);
        steps.push({
          id: 'rtsp',
          label: `RTSP Handshake (rtsp://${rawIp}:554/)`,
          status: rtspRes.ok ? 'pass' : 'warn',
          detail: rtspRes.ok
            ? `RTSP server responded: ${rtspRes.statusLine} (${rtspRes.rttMs} ms).`
            : 'Port 554 open, but RTSP OPTIONS handshake did not return an RTSP/1.0 header.',
          durationMs: rtspRes.rttMs ?? undefined,
        });
        if (rtspRes.ok) {
          streamProtocolFound = 'RTSP';
          streamEndpointUrl = `rtsp://${rawIp}:554/`;
          streamAccessible = true;
          streamStatusLine = rtspRes.statusLine;
          streamDetail = `RTSP stream endpoint verified (${rtspRes.statusLine}).`;
        }
      } else if (protocol === 'rtsp') {
        steps.push({
          id: 'rtsp',
          label: `RTSP Handshake (rtsp://${rawIp}:554/)`,
          status: 'fail',
          detail: `RTSP port 554 is closed or unreachable on ${rawIp}. (MaixSense-A075V typically serves HTTP/MJPEG on port 80.)`,
        });
      }

      // Probe HTTP / MJPEG / MaixSense /getdeep + force POST /set_cfg reconnection
      const httpPort = portMatrix[0].open ? 80 : portMatrix[2].open ? 81 : portMatrix[3].open ? 8080 : null;
      if ((protocol === 'mjpeg' || protocol === 'auto') && httpPort !== null) {
        if (forceReconnect && httpPort === 80) {
          // Official 12-byte MaixSense-A075V binary frame_config_encode (<BBBBBBBBi)
          const setCfgBuf = Buffer.from([1, 1, 255, 0, 2, 7, 1, 0, 0, 0, 0, 0]);
          const cfgRes = await httpProbe(rawIp, 80, '/set_cfg', 'POST', setCfgBuf, 1400);
          hardwareSetCfgOk = cfgRes.ok;
          steps.push({
            id: 'set_cfg',
            label: `Force Stream Re-Init (POST http://${rawIp}/set_cfg)`,
            status: cfgRes.ok ? 'pass' : 'info',
            detail: cfgRes.ok
              ? `Re-enabled MaixSense RGB JPEG + 16-bit ToF continuous trigger (HTTP ${cfgRes.statusCode}, ${cfgRes.rttMs} ms).`
              : `POST /set_cfg returned ${cfgRes.statusCode ?? 'no response'}; continuing MJPEG/HTTP stream probe.`,
            durationMs: cfgRes.rttMs,
          });
        }

        const candidatePaths = ['/getdeep', '/mjpeg', '/stream', '/video', '/get_cfg'];
        let matchedHttp: { path: string; statusCode: number | null; contentType: string; bytes: number; rttMs: number } | null = null;
        for (const p of candidatePaths) {
          const probe = await httpProbe(rawIp, httpPort, p, 'GET', undefined, 1400);
          if (probe.ok) {
            matchedHttp = { path: p, ...probe };
            break;
          }
        }

        if (matchedHttp) {
          streamProtocolFound = 'MJPEG/HTTP';
          streamEndpointUrl = `http://${rawIp}${httpPort === 80 ? '' : `:${httpPort}`}${matchedHttp.path}`;
          streamAccessible = true;
          streamStatusLine = `HTTP ${matchedHttp.statusCode} (${matchedHttp.contentType || 'application/octet-stream'})`;
          streamDetail = `Verified live camera endpoint ${streamEndpointUrl} (${matchedHttp.bytes} B read in ${matchedHttp.rttMs} ms).`;
          steps.push({
            id: 'mjpeg',
            label: `HTTP / MJPEG Stream Probe (${streamEndpointUrl})`,
            status: 'pass',
            detail: streamDetail,
            durationMs: matchedHttp.rttMs,
          });
        } else {
          steps.push({
            id: 'mjpeg',
            label: `HTTP / MJPEG Stream Probe (http://${rawIp}:${httpPort})`,
            status: 'warn',
            detail: `Port ${httpPort} is open, but none of /getdeep, /mjpeg, /stream, /video, or /get_cfg returned HTTP 200.`,
          });
        }
      }
    }

    if (forceReconnect) {
      steps.push({
        id: 'ws_reconnect',
        label: 'WebSocket Stream Force-Reconnect Dispatch',
        status: wsPublishersSignaled > 0 || wsViewersSignaled > 0 ? 'pass' : 'info',
        detail:
          wsPublishersSignaled > 0 || wsViewersSignaled > 0
            ? `Dispatched maixsense:reconnect to ${wsPublishersSignaled} publisher(s) and ${wsViewersSignaled} viewer(s) in room "${roomId}".`
            : `No active WebSocket publishers or viewers in room "${roomId}" to signal.`,
      });
    }

    const overallStatus: 'accessible' | 'bridge_reconnected' | 'unreachable' =
      streamAccessible && (hardwareSetCfgOk || pingMethod === 'tcp_socket_probe')
        ? 'accessible'
        : matchingBridgeFound
        ? 'bridge_reconnected'
        : 'unreachable';

    res.json({
      ok: true,
      targetIp: rawIp,
      room: roomId,
      protocolRequested: protocol,
      isCloudContainer,
      overallStatus,
      ping: {
        reachable: pingReachable,
        rttMs: pingRttMs,
        method: pingMethod,
        detail: pingDetail,
      },
      ports: portMatrix,
      streamProbe: {
        protocol: streamProtocolFound,
        endpointUrl: streamEndpointUrl,
        accessible: streamAccessible,
        httpOrRtspStatus: streamStatusLine,
        detail: streamDetail || 'No accessible RTSP or MJPEG/HTTP stream detected on target IP.',
      },
      reconnection: {
        attempted: forceReconnect,
        hardwareSetCfgOk,
        wsPublishersSignaled,
        wsViewersSignaled,
        activeFramesRelayed,
        detail: hardwareSetCfgOk
          ? `Hardware stream re-triggered via POST /set_cfg and WebSocket reconnect broadcast to ${wsPublishersSignaled} bridge(s) / ${wsViewersSignaled} viewer(s).`
          : wsPublishersSignaled > 0
          ? `Force-reconnect signal delivered to ${wsPublishersSignaled} active MaixSense bridge(s) and ${wsViewersSignaled} viewer(s).`
          : 'Reconnect requested; start maixsense_bridge.py or connect locally over USB-RNDIS to bring up the stream.',
      },
      steps,
      diagnosedAt: new Date().toISOString(),
    });
  });

  // Lower-level MaixSense hardware power-cycle / hard reset endpoint
  // Strictly validated private LAN IPv4, zero shell execution, sysfs path confinement, cloud-safe dispatch
  app.post('/api/maixsense/hard-reset', async (req, res) => {
    const startedAt = Date.now();
    const rawIp = typeof req.body?.ip === 'string' ? req.body.ip.trim() : '192.168.233.1';
    const rawRoom = typeof req.body?.room === 'string' ? req.body.room : 'rover-01';
    const roomId = rawRoom.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'rover-01';
    const powerOffMs = Math.max(800, Math.min(3000, Number(req.body?.powerOffMs) || 1500));

    const IPV4_REGEX =
      /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
    if (!IPV4_REGEX.test(rawIp)) {
      res.status(400).json({ ok: false, error: 'Invalid IPv4 address format.' });
      return;
    }

    const octets = rawIp.split('.').map(Number);
    const isPrivateLan =
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168);

    if (!isPrivateLan) {
      res.status(400).json({
        ok: false,
        error: 'Hard reset target must be a local private LAN IPv4 address (e.g. 192.168.233.1).',
      });
      return;
    }

    const isCloudContainer = Boolean(process.env.K_SERVICE || process.env.CLOUD_RUN_JOB);
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    type ResetStepStatus = 'pass' | 'warn' | 'fail' | 'info';
    const steps: Array<{
      id: string;
      phase: string;
      status: ResetStepStatus;
      detail: string;
      durationMs?: number;
    }> = [];

    // Helper for bounded HTTP request to local MaixSense module
    const localHttpSignal = (
      host: string,
      urlPath: string,
      method: 'GET' | 'POST',
      body?: Buffer,
      timeoutMs = 1400
    ): Promise<{ ok: boolean; statusCode: number | null; rttMs: number }> =>
      new Promise((resolve) => {
        const t0 = Date.now();
        const hReq = http.request(
          {
            hostname: host,
            port: 80,
            path: urlPath,
            method,
            timeout: timeoutMs,
            headers: body
              ? {
                  'Content-Type': 'application/octet-stream',
                  'Content-Length': body.byteLength,
                  'User-Agent': 'WeedingRover-HardReset/1.0',
                }
              : { 'User-Agent': 'WeedingRover-HardReset/1.0' },
          },
          (hRes) => {
            hRes.resume();
            hRes.once('end', () =>
              resolve({
                ok: (hRes.statusCode ?? 0) >= 200 && (hRes.statusCode ?? 0) < 400,
                statusCode: hRes.statusCode ?? null,
                rttMs: Date.now() - t0,
              })
            );
          }
        );
        hReq.once('timeout', () => {
          hReq.destroy();
          resolve({ ok: false, statusCode: null, rttMs: Date.now() - t0 });
        });
        hReq.once('error', () => {
          resolve({ ok: false, statusCode: null, rttMs: Date.now() - t0 });
        });
        if (body) hReq.write(body);
        hReq.end();
      });

    // 1. Dispatch lower-level hard-reset command over /ws/camera to active MaixSense bridges & viewers
    let wsPublishersSignaled = 0;
    let wsViewersSignaled = 0;
    const hardResetEnvelope = JSON.stringify({
      type: 'maixsense:hard_reset',
      ip: rawIp,
      room: roomId,
      powerOffMs,
      reason: 'hardware_audit_hard_reset',
      requestedAt: Date.now(),
    });

    for (const [rId, peers] of rooms.entries()) {
      for (const peer of peers.values()) {
        if (peer.ws.readyState !== WebSocket.OPEN) continue;
        const isMaixPub =
          peer.role === 'publisher' &&
          (peer.transport === 'maixsense' || peer.label.toLowerCase().includes('maixsense'));
        if (isMaixPub) {
          try {
            peer.ws.send(hardResetEnvelope);
            wsPublishersSignaled += 1;
          } catch {
            // Ignore transient write error
          }
        } else if (peer.role === 'viewer' && rId === roomId) {
          try {
            peer.ws.send(hardResetEnvelope);
            wsViewersSignaled += 1;
          } catch {
            // Ignore transient write error
          }
        }
      }
    }

    steps.push({
      id: 'ws_dispatch',
      phase: '1. Bridge Hard-Reset Signal',
      status: wsPublishersSignaled > 0 ? 'pass' : 'info',
      detail:
        wsPublishersSignaled > 0
          ? `Dispatched maixsense:hard_reset (${powerOffMs} ms USB/firmware cycle) to ${wsPublishersSignaled} active MaixSense bridge(s) and notified ${wsViewersSignaled} viewer(s).`
          : `No active MaixSense WebSocket bridge in room "${roomId}". ${
              isCloudContainer
                ? 'Start maixsense_bridge.py on your local PC/Pi so remote hard-reset commands can reach the USB bus.'
                : 'Proceeding with local USB sysfs & firmware power-cycle.'
            }`,
    });

    let usbPowerCycled = false;
    let usbDeviceMatched: string | null = null;
    let firmwareResetSent = false;
    let postResetRecovered = false;
    let postResetRttMs: number | null = null;

    if (!isCloudContainer) {
      // 2. Linux sysfs USB device authorization power-cycle (zero shell execution, strict path confinement)
      const USB_SYSFS_BASE = '/sys/bus/usb/devices';
      const SAFE_USB_DEV_RE = /^[0-9]+-[0-9]+(?:\.[0-9]+)*$/;
      const MAIX_VENDOR_IDS = new Set(['1f3a', '0525', '359f']);
      const MAIX_KEYWORDS = ['maixsense', 'sipeed', 'rndis', 'allwinner', 'a075'];

      const tUsb = Date.now();
      if (process.platform === 'linux' && fs.existsSync(USB_SYSFS_BASE)) {
        try {
          const entries = fs.readdirSync(USB_SYSFS_BASE).filter((name) => SAFE_USB_DEV_RE.test(name));
          for (const devName of entries.slice(0, 48)) {
            const devDir = path.resolve(USB_SYSFS_BASE, devName);
            if (!devDir.startsWith(USB_SYSFS_BASE + path.sep)) continue;

            const readSysAttr = (attr: string): string => {
              const p = path.resolve(devDir, attr);
              if (!p.startsWith(devDir + path.sep) || !fs.existsSync(p)) return '';
              try {
                return fs.readFileSync(p, 'utf8').trim().toLowerCase();
              } catch {
                return '';
              }
            };

            const idVendor = readSysAttr('idVendor');
            const product = readSysAttr('product');
            const manufacturer = readSysAttr('manufacturer');
            const combined = `${product} ${manufacturer}`;

            const isMatch =
              MAIX_VENDOR_IDS.has(idVendor) ||
              MAIX_KEYWORDS.some((kw) => combined.includes(kw));

            if (isMatch) {
              usbDeviceMatched = `${devName} (${idVendor || 'usb'}${product ? ` · ${product}` : ''})`;
              const authPath = path.resolve(devDir, 'authorized');
              if (authPath.startsWith(devDir + path.sep) && fs.existsSync(authPath)) {
                try {
                  fs.writeFileSync(authPath, '0', 'utf8');
                  await sleep(powerOffMs);
                  fs.writeFileSync(authPath, '1', 'utf8');
                  usbPowerCycled = true;
                  steps.push({
                    id: 'usb_sysfs',
                    phase: '2. USB Bus Power-Cycle (sysfs)',
                    status: 'pass',
                    detail: `Deauthorized and re-enumerated USB device ${usbDeviceMatched} via sysfs (${powerOffMs} ms power-off hold).`,
                    durationMs: Date.now() - tUsb,
                  });
                } catch (err) {
                  steps.push({
                    id: 'usb_sysfs',
                    phase: '2. USB Bus Power-Cycle (sysfs)',
                    status: 'warn',
                    detail: `Matched USB device ${usbDeviceMatched}, but sysfs write requires root/udev permission (${
                      err instanceof Error ? err.message : 'EACCES'
                    }). Falling back to firmware HTTP reset.`,
                    durationMs: Date.now() - tUsb,
                  });
                }
              }
              break;
            }
          }

          if (!usbDeviceMatched) {
            steps.push({
              id: 'usb_sysfs',
              phase: '2. USB Bus Power-Cycle (sysfs)',
              status: 'info',
              detail: 'No MaixSense / Allwinner / USB-RNDIS device matched in /sys/bus/usb/devices on this host.',
              durationMs: Date.now() - tUsb,
            });
          }
        } catch {
          steps.push({
            id: 'usb_sysfs',
            phase: '2. USB Bus Power-Cycle (sysfs)',
            status: 'info',
            detail: 'Unable to enumerate /sys/bus/usb/devices on this host; proceeding with firmware reset.',
            durationMs: Date.now() - tUsb,
          });
        }
      } else {
        steps.push({
          id: 'usb_sysfs',
          phase: '2. USB Bus Power-Cycle',
          status: 'info',
          detail: `Host OS (${os.platform()}) does not expose Linux USB sysfs; proceeding with firmware trigger cycle.`,
        });
      }

      // 3. Firmware-level halt + reboot + cold re-init (strictly restricted to attached local subnets)
      const localPrefixes = new Set<string>(['192.168.233.']);
      for (const addrs of Object.values(os.networkInterfaces())) {
        if (!addrs) continue;
        for (const addr of addrs) {
          if (addr.family === 'IPv4' && !addr.internal) {
            const p = addr.address.split('.');
            if (p.length === 4) localPrefixes.add(`${p[0]}.${p[1]}.${p[2]}.`);
          }
        }
      }
      const targetPrefix = `${octets[0]}.${octets[1]}.${octets[2]}.`;

      if (localPrefixes.has(targetPrefix)) {
        const tFw = Date.now();
        // Halt active capture (trigger_mode=0)
        const stopCfg = Buffer.from([0, 0, 255, 0, 2, 7, 0, 0, 0, 0, 0, 0]);
        const stopRes = await localHttpSignal(rawIp, '/set_cfg', 'POST', stopCfg, 1000);
        // Attempt firmware reboot endpoint if exposed by module firmware
        const rebootRes = await localHttpSignal(rawIp, '/reboot', 'GET', undefined, 900);
        if (stopRes.ok || rebootRes.ok) {
          firmwareResetSent = true;
          await sleep(600);
        }

        // Cold re-initialize continuous trigger + 16-bit depth + RGB JPEG (trigger_mode=1, deep_mode=1, rgb_mode=1)
        const startCfg = Buffer.from([1, 1, 255, 0, 2, 7, 1, 0, 0, 0, 0, 0]);
        const reinitRes = await localHttpSignal(rawIp, '/set_cfg', 'POST', startCfg, 1400);
        if (reinitRes.ok) {
          firmwareResetSent = true;
          postResetRecovered = true;
          postResetRttMs = reinitRes.rttMs;
          steps.push({
            id: 'firmware_cycle',
            phase: '3. Firmware Trigger Cycle & Cold Re-Init',
            status: 'pass',
            detail: `Sent trigger halt + cold POST /set_cfg re-init to http://${rawIp}/set_cfg (HTTP ${reinitRes.statusCode}, ${reinitRes.rttMs} ms).`,
            durationMs: Date.now() - tFw,
          });
        } else {
          steps.push({
            id: 'firmware_cycle',
            phase: '3. Firmware Trigger Cycle & Cold Re-Init',
            status: 'warn',
            detail: `MaixSense HTTP control port on ${rawIp}:80 did not acknowledge cold re-init (device may still be rebooting or USB cable is unplugged).`,
            durationMs: Date.now() - tFw,
          });
        }
      }
    } else {
      steps.push({
        id: 'cloud_notice',
        phase: '2. Physical USB Bus Scope',
        status: wsPublishersSignaled > 0 ? 'info' : 'warn',
        detail:
          wsPublishersSignaled > 0
            ? 'Remote cloud console delegated the physical USB/firmware power-cycle to your local maixsense_bridge.py process over /ws/camera.'
            : 'Cloud container cannot toggle local USB power directly. Run maixsense_bridge.py locally on the rover/PC, or physically unplug and replug the MaixSense USB-C cable for 3 seconds.',
      });
    }

    const overallStatus: 'power_cycled' | 'bridge_dispatched' | 'manual_required' =
      usbPowerCycled || postResetRecovered
        ? 'power_cycled'
        : wsPublishersSignaled > 0
        ? 'bridge_dispatched'
        : 'manual_required';

    res.json({
      ok: true,
      targetIp: rawIp,
      room: roomId,
      isCloudContainer,
      overallStatus,
      usbDeviceMatched,
      usbPowerCycled,
      firmwareResetSent,
      wsPublishersSignaled,
      wsViewersSignaled,
      postResetRecovered,
      postResetRttMs,
      totalDurationMs: Date.now() - startedAt,
      steps,
      executedAt: new Date().toISOString(),
    });
  });

  // ─── Physical Raspberry Pi Robot Mission & Safety Proxy (/api/robot/*) ──────
  // Strictly proxies ONLY to server-configured process.env.PI_ROBOT_URL (never client-controlled URLs).
  const getConfiguredPiBaseUrl = (): URL | null => {
    const raw = (process.env.PI_ROBOT_URL || '').trim();
    if (!raw) return null;
    try {
      const parsed = new URL(raw);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
      return parsed;
    } catch {
      return null;
    }
  };

  const proxyPiRequest = (
    method: 'GET' | 'POST',
    endpointPath: string,
    payload?: Buffer | Record<string, unknown>,
    contentType = 'application/json',
    timeoutMs = 2500
  ): Promise<{ reachable: boolean; statusCode: number; body: any; error?: string }> =>
    new Promise((resolve) => {
      const base = getConfiguredPiBaseUrl();
      if (!base) {
        resolve({ reachable: false, statusCode: 503, body: null, error: 'PI_ROBOT_URL not configured' });
        return;
      }

      const target = new URL(endpointPath, base);
      const isHttps = target.protocol === 'https:';
      const bodyBuf =
        payload === undefined
          ? undefined
          : Buffer.isBuffer(payload)
          ? payload
          : Buffer.from(JSON.stringify(payload), 'utf8');

      const headers: Record<string, string | number> = {
        'User-Agent': 'WeedingRover-ConsoleProxy/1.0',
      };
      const piApiToken = (process.env.PI_API_TOKEN || '').trim();
      if (piApiToken) {
        headers['Authorization'] = `Bearer ${piApiToken}`;
      }
      if (bodyBuf) {
        headers['Content-Type'] = contentType;
        headers['Content-Length'] = bodyBuf.byteLength;
      }

      const transport = isHttps ? https : http;
      const hReq = transport.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (isHttps ? 443 : 80),
          path: target.pathname + target.search,
          method,
          timeout: timeoutMs,
          headers,
        },
        (hRes) => {
          const chunks: Buffer[] = [];
          hRes.on('data', (c: Buffer) => {
            if (chunks.reduce((acc, b) => acc + b.byteLength, 0) < 512 * 1024) {
              chunks.push(c);
            }
          });
          hRes.once('end', () => {
            const rawText = Buffer.concat(chunks).toString('utf8');
            let parsedBody: any = rawText;
            try {
              parsedBody = rawText ? JSON.parse(rawText) : {};
            } catch {
              parsedBody = { raw: rawText };
            }
            resolve({
              reachable: true,
              statusCode: hRes.statusCode ?? 502,
              body: parsedBody,
            });
          });
        }
      );

      hReq.once('timeout', () => {
        hReq.destroy();
        resolve({ reachable: false, statusCode: 504, body: null, error: 'Pi robot API request timed out' });
      });
      hReq.once('error', (err) => {
        resolve({ reachable: false, statusCode: 503, body: null, error: err.message });
      });
      if (bodyBuf) hReq.write(bodyBuf);
      hReq.end();
    });

  app.get('/api/robot/status', async (_req, res) => {
    const base = getConfiguredPiBaseUrl();
    if (!base) {
      res.json({
        ok: true,
        configured: false,
        connected: false,
        mode: 'sim_only',
        detail: 'PI_ROBOT_URL is not configured. Dashboard is running in local simulation mode only.',
        status: null,
      });
      return;
    }

    const r = await proxyPiRequest('GET', '/health', undefined, 'application/json', 2000);
    if (!r.reachable || r.statusCode >= 500) {
      res.json({
        ok: false,
        configured: true,
        connected: false,
        mode: 'pi_unreachable',
        statusCode: r.statusCode,
        detail: r.error || `Pi server returned HTTP ${r.statusCode}`,
        status: null,
      });
      return;
    }

    if (r.statusCode === 401 || r.statusCode === 403) {
      res.json({
        ok: false,
        configured: true,
        connected: false,
        mode: 'pi_auth_error',
        authError: true,
        statusCode: r.statusCode,
        detail: `Raspberry Pi rejected authentication (HTTP ${r.statusCode}). Configure matching PI_API_TOKEN on both Pi and dashboard server.`,
        status: null,
      });
      return;
    }

    if (r.statusCode < 200 || r.statusCode >= 300) {
      res.json({
        ok: false,
        configured: true,
        connected: false,
        mode: 'pi_unreachable',
        statusCode: r.statusCode,
        detail: `Pi server /health returned unexpected HTTP ${r.statusCode}.`,
        status: null,
      });
      return;
    }

    // Verify Bearer token against protected /auth/verify whenever Pi enforces authentication
    if (r.body?.auth_enforced !== false) {
      const authProbe = await proxyPiRequest('GET', '/auth/verify', undefined, 'application/json', 1500);
      if (authProbe.reachable && (authProbe.statusCode === 401 || authProbe.statusCode === 403)) {
        res.json({
          ok: false,
          configured: true,
          connected: false,
          mode: 'pi_auth_error',
          authError: true,
          statusCode: authProbe.statusCode,
          detail:
            authProbe.body?.detail ||
            `Raspberry Pi rejected Bearer token on /auth/verify (HTTP ${authProbe.statusCode}). Set matching PI_API_TOKEN on both Pi and server.`,
          status: null,
        });
        return;
      }
    }

    res.json({
      ok: true,
      configured: true,
      connected: true,
      mode: 'pi_live',
      detail: 'Connected to Raspberry Pi navigation controller.',
      workerRunning: Boolean(r.body?.worker_running),
      status: r.body?.status ?? r.body,
    });
  });

  const ALLOWED_MISSION_SOURCE_TYPES = new Set([
    'live_capture',
    'live_stream',
    'simulated',
    'field_mission',
  ]);

  const handleMissionStop = async (req: express.Request, res: express.Response) => {
    const endpoint = req.path;
    const base = getConfiguredPiBaseUrl();
    if (!base) {
      res.status(503).json({
        ok: false,
        stopped: false,
        configured: false,
        endpoint,
        reason: 'PI_ROBOT_NOT_CONFIGURED',
        ackVerified: false,
        hardwareStopped: false,
        detail:
          'No physical Raspberry Pi backend configured (PI_ROBOT_URL unset) — UI simulation halted only. Browser button is NOT a physical emergency stop.',
      });
      return;
    }

    const r = await proxyPiRequest('POST', '/stop', {}, 'application/json', 2500);
    if (!r.reachable) {
      res.status(503).json({
        ok: false,
        stopped: false,
        configured: true,
        endpoint,
        reason: 'PI_UNREACHABLE',
        ackVerified: false,
        hardwareStopped: false,
        detail: `Failed to reach Raspberry Pi /stop (${r.error}). Engage physical GPIO 13 E-stop switch immediately!`,
      });
      return;
    }

    const ackVerified = r.statusCode === 200 && Boolean(r.body?.ack_verified);
    res.status(ackVerified ? 200 : 503).json({
      ok: ackVerified,
      stopped: ackVerified,
      configured: true,
      endpoint,
      ackVerified,
      hardwareStopped: ackVerified && !r.body?.simulated,
      state: r.body?.state ?? (ackVerified ? 'STOPPED' : 'UNKNOWN'),
      esp32Response: r.body?.esp32_response ?? null,
      estopLatched: Boolean(r.body?.estop_latched),
      simulated: Boolean(r.body?.simulated),
      detail: ackVerified
        ? `ESP32 stop ACK verified (${r.body?.esp32_response}).`
        : r.body?.error || 'ESP32 stop ACK NOT verified — engage physical power cutoff immediately!',
    });
  };

  const handleMissionStart = async (req: express.Request, res: express.Response) => {
    const endpoint = req.path;
    const base = getConfiguredPiBaseUrl();
    if (!base) {
      res.status(503).json({
        ok: false,
        started: false,
        configured: false,
        endpoint,
        reason: 'PI_ROBOT_NOT_CONFIGURED',
        detail: 'PI_ROBOT_URL is not configured; cannot launch a physical rover mission.',
      });
      return;
    }

    const rawSourceType = typeof req.body?.source_type === 'string' ? req.body.source_type.trim() : 'live_capture';
    const source_type = ALLOWED_MISSION_SOURCE_TYPES.has(rawSourceType) ? rawSourceType : 'live_capture';

    const payload: Record<string, unknown> = {
      source_type,
      nav_only: req.body?.nav_only !== false,
      operator_confirmed: req.body?.operator_confirmed === true,
    };

    if (typeof req.body?.start_row === 'number' && Number.isInteger(req.body.start_row)) {
      const startRow = Math.max(1, Math.min(100, req.body.start_row));
      payload.start_row = startRow;
    }
    if (typeof req.body?.end_row === 'number' && Number.isInteger(req.body.end_row)) {
      const minEnd = typeof payload.start_row === 'number' ? (payload.start_row as number) : 1;
      payload.end_row = Math.max(minEnd, Math.min(100, req.body.end_row));
    }
    if (typeof req.body?.speed_limit_mps === 'number' && Number.isFinite(req.body.speed_limit_mps)) {
      payload.speed_limit_mps = Math.max(0.05, Math.min(1.5, Number(req.body.speed_limit_mps.toFixed(3))));
    }

    const r = await proxyPiRequest('POST', '/start_mission', payload);
    if (!r.reachable) {
      res.status(503).json({
        ok: false,
        started: false,
        configured: true,
        endpoint,
        reason: 'PI_UNREACHABLE',
        detail: r.error || 'Raspberry Pi navigation controller unreachable.',
      });
      return;
    }

    res.status(r.statusCode).json({
      ok: r.statusCode === 200,
      configured: true,
      endpoint,
      ...(typeof r.body === 'object' && r.body !== null ? r.body : { raw: r.body }),
    });
  };

  const handleMissionPause = async (req: express.Request, res: express.Response) => {
    const endpoint = req.path;
    const base = getConfiguredPiBaseUrl();
    if (!base) {
      res.status(503).json({
        ok: false,
        paused: false,
        configured: false,
        endpoint,
        reason: 'PI_ROBOT_NOT_CONFIGURED',
        detail: 'PI_ROBOT_URL is not configured; local simulation paused only.',
      });
      return;
    }

    const r = await proxyPiRequest('POST', '/pause', {});
    if (!r.reachable) {
      res.status(503).json({
        ok: false,
        paused: false,
        configured: true,
        endpoint,
        reason: 'PI_UNREACHABLE',
        detail: r.error || 'Failed to reach Raspberry Pi /pause.',
      });
      return;
    }

    res.status(r.statusCode).json({
      ok: r.statusCode === 200,
      configured: true,
      endpoint,
      ...(typeof r.body === 'object' && r.body !== null ? r.body : { raw: r.body }),
    });
  };

  const handleMissionResume = async (req: express.Request, res: express.Response) => {
    const endpoint = req.path;
    const base = getConfiguredPiBaseUrl();
    if (!base) {
      res.status(503).json({
        ok: false,
        resumed: false,
        configured: false,
        endpoint,
        reason: 'PI_ROBOT_NOT_CONFIGURED',
        detail: 'PI_ROBOT_URL is not configured; local simulation resumed only.',
      });
      return;
    }

    const r = await proxyPiRequest('POST', '/resume', {});
    if (!r.reachable) {
      res.status(503).json({
        ok: false,
        resumed: false,
        configured: true,
        endpoint,
        reason: 'PI_UNREACHABLE',
        detail: r.error || 'Failed to reach Raspberry Pi /resume.',
      });
      return;
    }

    res.status(r.statusCode).json({
      ok: r.statusCode === 200,
      configured: true,
      endpoint,
      ...(typeof r.body === 'object' && r.body !== null ? r.body : { raw: r.body }),
    });
  };

  // Canonical mission lifecycle endpoints (MissionControlService contract)
  app.post('/api/robot/mission/start', handleMissionStart);
  app.post('/api/robot/mission/stop', handleMissionStop);
  app.post('/api/robot/mission/pause', handleMissionPause);
  app.post('/api/robot/mission/resume', handleMissionResume);

  // Legacy aliases retained for App.tsx E-Stop & Ros2ToolsView compatibility
  app.post('/api/robot/start_mission', handleMissionStart);
  app.post('/api/robot/stop', handleMissionStop);
  app.post('/api/robot/pause', handleMissionPause);
  app.post('/api/robot/resume', handleMissionResume);

  app.post('/api/robot/recover', async (req, res) => {
    const endpoint = req.path;
    const base = getConfiguredPiBaseUrl();
    if (!base) {
      res.status(503).json({
        ok: false,
        recovered: false,
        configured: false,
        endpoint,
        reason: 'PI_ROBOT_NOT_CONFIGURED',
        detail: 'PI_ROBOT_URL is not configured; local fault state cleared only.',
      });
      return;
    }
    const payload: Record<string, unknown> = {
      operator_confirmed: req.body?.operator_confirmed === true,
    };
    if (Array.isArray(req.body?.relocalize_pose) && req.body.relocalize_pose.length === 3) {
      const nums = req.body.relocalize_pose.map(Number);
      if (nums.every((n: number) => Number.isFinite(n))) {
        payload.relocalize_pose = nums;
      }
    }
    const r = await proxyPiRequest('POST', '/recover', payload);
    if (!r.reachable) {
      res.status(503).json({
        ok: false,
        recovered: false,
        configured: true,
        endpoint,
        reason: 'PI_UNREACHABLE',
        detail: r.error || 'Failed to reach Raspberry Pi /recover.',
      });
      return;
    }
    res.status(r.statusCode).json({
      ok: r.statusCode === 200,
      configured: true,
      endpoint,
      ...(typeof r.body === 'object' && r.body !== null ? r.body : { raw: r.body }),
    });
  });

  // Safe USB ESP32 startup inspection (PING + TELEM? read-only by default) & explicit operator-authorized CLEAR_LATCH
  app.post('/api/robot/handshake', async (req, res) => {
    const startedAt = Date.now();
    // Strictly opt-in: automatic startup MUST NEVER clear a latched E-stop or watchdog fault!
    const allowClearLatch = req.body?.allow_clear_latch === true;
    const operatorConfirmed = req.body?.operator_confirmed === true;
    const isCloudContainer = Boolean(process.env.K_SERVICE || process.env.CLOUD_RUN_JOB);

    // 1. Read-only scan of /dev for USB-connected ESP32 serial bridges (zero shell execution, zero manual config)
    const detectedUsbPorts: string[] = [];
    const SAFE_USB_SERIAL_RE = /^(ttyUSB\d+|ttyACM\d+|cu\.usb\S+|cu\.SLAB\S+|cu\.wchusb\S+)$/;
    if (!isCloudContainer && fs.existsSync('/dev')) {
      try {
        const devEntries = fs.readdirSync('/dev');
        for (const name of devEntries) {
          if (SAFE_USB_SERIAL_RE.test(name)) {
            detectedUsbPorts.push(`/dev/${name}`);
          }
          if (detectedUsbPorts.length >= 8) break;
        }
      } catch {
        // Ignore unreadable /dev
      }
    }

    // 2. Summarize live camera readiness from /ws/camera publishers & USB-RNDIS interfaces
    let wsCameraPublishers = 0;
    let wsFramesRelayed = 0;
    let activeCameraIp: string | null = null;
    for (const peers of rooms.values()) {
      for (const peer of peers.values()) {
        if (peer.role === 'publisher' && peer.ws.readyState === WebSocket.OPEN) {
          wsCameraPublishers += 1;
          wsFramesRelayed += peer.framesRelayed;
          if (!activeCameraIp && peer.lastReportedIp) {
            activeCameraIp = peer.lastReportedIp;
          }
        }
      }
    }
    if (!activeCameraIp) {
      const nets = os.networkInterfaces();
      for (const addrs of Object.values(nets)) {
        if (!addrs) continue;
        for (const addr of addrs) {
          if (addr.family === 'IPv4' && !addr.internal && addr.address.startsWith('192.168.233.')) {
            const p = addr.address.split('.');
            activeCameraIp = `${p[0]}.${p[1]}.${p[2]}.1`;
          }
        }
      }
    }

    const base = getConfiguredPiBaseUrl();
    if (!base) {
      res.status(200).json({
        ok: false,
        configured: false,
        mode: 'usb_unlinked',
        isCloudContainer,
        detectedUsbPorts,
        usbPort: detectedUsbPorts[0] || '/dev/ttyUSB0 (USB auto)',
        esp32Ready: false,
        watchdogInitialized: false,
        estopOk: false,
        latchLocked: true,
        clearLatchAttempted: false,
        inspectionOnly: !allowClearLatch,
        cameraHealthy: wsCameraPublishers > 0,
        cameraSummary: {
          wsPublishers: wsCameraPublishers,
          wsFramesRelayed,
          resolvedIp: activeCameraIp,
          piCameraHealthy: false,
          piCameraReason: 'PI_ROBOT_URL_UNSET',
        },
        navigationDispatchUnlocked: false,
        durationMs: Date.now() - startedAt,
        steps: [
          {
            id: 'usb_detect',
            command: 'USB AUTO-DETECT',
            status: detectedUsbPorts.length > 0 ? 'pass' : 'info',
            response: detectedUsbPorts.length > 0 ? detectedUsbPorts.join(', ') : 'NO_LOCAL_USB_PORT',
            detail:
              detectedUsbPorts.length > 0
                ? `Detected USB serial device(s) on host: ${detectedUsbPorts.join(', ')}. Set PI_ROBOT_URL to inspect live Pi telemetry.`
                : isCloudContainer
                ? 'ESP32 connects over USB to your Raspberry Pi. Set PI_ROBOT_URL (and PI_API_TOKEN) on the server to link live telemetry.'
                : 'No USB-serial ESP32 found on /dev/ttyUSB* or /dev/ttyACM*. Plug ESP32 into Raspberry Pi USB and set PI_ROBOT_URL.',
          },
          {
            id: 'clear_latch',
            command: allowClearLatch ? 'CLEAR_LATCH' : 'TELEM? (READ-ONLY)',
            status: 'warn',
            response: 'PI_BRIDGE_UNCONFIGURED',
            detail: allowClearLatch
              ? 'CLEAR_LATCH was NOT dispatched because PI_ROBOT_URL is not configured. Watchdog gate remains locked.'
              : 'Read-only inspection complete (PI_ROBOT_URL unset). Automatic startup never clears E-stop or watchdog latches.',
          },
          {
            id: 'camera_check',
            command: 'CAMERA_CHECK',
            status: wsCameraPublishers > 0 ? 'pass' : 'warn',
            response:
              wsCameraPublishers > 0
                ? `LIVE_STREAM (${wsCameraPublishers} pub · ${wsFramesRelayed} frames)`
                : activeCameraIp
                ? `RNDIS_IP_${activeCameraIp}_IDLE`
                : 'NO_LIVE_CAMERA_STREAM',
            detail:
              wsCameraPublishers > 0
                ? `Live camera publisher active (${wsFramesRelayed} frames relayed${activeCameraIp ? ` from ${activeCameraIp}` : ''}).`
                : 'No live MaixSense / camera stream publishing to /ws/camera yet. Run maixsense_bridge.py or connect camera below.',
          },
        ],
        executedAt: new Date().toISOString(),
      });
      return;
    }

    // 3. Proxy read-only inspection (default) or explicit operator-authorized CLEAR_LATCH to Pi controller
    const r = await proxyPiRequest(
      'POST',
      '/handshake',
      { allow_clear_latch: allowClearLatch, operator_confirmed: operatorConfirmed },
      'application/json',
      3500
    );
    if (!r.reachable) {
      res.status(503).json({
        ok: false,
        configured: true,
        mode: 'pi_unreachable',
        isCloudContainer,
        detectedUsbPorts,
        usbPort: detectedUsbPorts[0] || '/dev/ttyUSB0',
        esp32Ready: false,
        watchdogInitialized: false,
        estopOk: false,
        latchLocked: true,
        clearLatchAttempted: false,
        inspectionOnly: !allowClearLatch,
        cameraHealthy: wsCameraPublishers > 0,
        cameraSummary: {
          wsPublishers: wsCameraPublishers,
          wsFramesRelayed,
          resolvedIp: activeCameraIp,
          piCameraHealthy: false,
          piCameraReason: 'PI_UNREACHABLE',
        },
        navigationDispatchUnlocked: false,
        durationMs: Date.now() - startedAt,
        steps: [
          {
            id: 'pi_link',
            command: 'POST /handshake',
            status: 'fail',
            response: 'PI_UNREACHABLE',
            detail: `Could not reach Raspberry Pi controller (${r.error}). Watchdog state could not be verified.`,
          },
        ],
        executedAt: new Date().toISOString(),
      });
      return;
    }

    if (r.statusCode === 401 || r.statusCode === 403) {
      res.status(r.statusCode).json({
        ok: false,
        configured: true,
        mode: 'pi_auth_error',
        authError: true,
        isCloudContainer,
        detectedUsbPorts,
        usbPort: detectedUsbPorts[0] || '/dev/ttyUSB0',
        esp32Ready: false,
        watchdogInitialized: false,
        estopOk: false,
        latchLocked: true,
        clearLatchAttempted: false,
        inspectionOnly: !allowClearLatch,
        cameraHealthy: wsCameraPublishers > 0,
        cameraSummary: {
          wsPublishers: wsCameraPublishers,
          wsFramesRelayed,
          resolvedIp: activeCameraIp,
          piCameraHealthy: false,
          piCameraReason: 'PI_AUTH_ERROR',
        },
        navigationDispatchUnlocked: false,
        durationMs: Date.now() - startedAt,
        steps: [
          {
            id: 'pi_auth',
            command: 'POST /handshake',
            status: 'fail',
            response: `HTTP_${r.statusCode}_UNAUTHORIZED`,
            detail: `Raspberry Pi rejected authentication (HTTP ${r.statusCode}). Configure matching PI_API_TOKEN on both Pi and dashboard server.`,
          },
        ],
        executedAt: new Date().toISOString(),
      });
      return;
    }

    const piData = r.body || {};
    const esp32Ready = r.statusCode >= 200 && r.statusCode < 300 && Boolean(piData.esp32_ready);
    const watchdogInitialized = Boolean(piData.watchdog_initialized);
    const piCameraHealthy = Boolean(piData.camera_healthy);
    const latchLocked =
      typeof piData.latch_locked === 'boolean' ? piData.latch_locked : !esp32Ready;

    res.status(r.statusCode).json({
      ok: esp32Ready,
      configured: true,
      mode: r.statusCode >= 200 && r.statusCode < 300 ? (piData.simulated ? 'pi_simulated' : 'pi_live') : 'pi_unreachable',
      isCloudContainer,
      detectedUsbPorts,
      usbPort: piData.usb_port || detectedUsbPorts[0] || '/dev/ttyUSB0',
      esp32Ready,
      watchdogInitialized,
      estopOk: Boolean(piData.estop_ok),
      latchLocked,
      clearLatchAttempted: Boolean(piData.clear_latch_attempted),
      inspectionOnly: piData.inspection_only !== false && !allowClearLatch,
      cameraHealthy: piCameraHealthy || wsCameraPublishers > 0,
      cameraSummary: {
        wsPublishers: wsCameraPublishers,
        wsFramesRelayed,
        resolvedIp: activeCameraIp,
        piCameraHealthy,
        piCameraReason: piData.camera_reason || (piCameraHealthy ? 'OK' : 'CAMERA_NOT_ATTACHED'),
        piFramesIngested: Number(piData.frames_ingested ?? 0),
      },
      navigationDispatchUnlocked: Boolean(piData.navigation_dispatch_unlocked),
      durationMs: Date.now() - startedAt,
      steps: Array.isArray(piData.steps) ? piData.steps : [],
      executedAt: new Date().toISOString(),
    });
  });

  // Safety-interlocked Simpla Bot command interface (Normal Motor Driver + Grinder CH1 + Flame CH2)
  const simplaState = {
    leftPct: 0,
    rightPct: 0,
    grinderOn: false,
    flameOn: false,
    lastFlameEndMs: 0,
    lastCommandAt: Date.now(),
  };

  app.post('/api/simpla-bot/command', async (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const kind = typeof body.kind === 'string' ? body.kind.trim().toLowerCase() : '';
    const dryRun = body.dryRun !== false;
    const estopActive = Boolean(body.estopActive);
    const now = Date.now();

    if (!['motor', 'move_mm', 'turn_deg', 'relay', 'stop', 'ping'].includes(kind)) {
      res.status(400).json({ ok: false, error: 'Invalid command kind.' });
      return;
    }

    if (kind === 'ping') {
      res.json({
        ok: true,
        kind: 'ping',
        wireCommand: 'PING',
        ack: `PONG ESTOP=${estopActive ? 1 : 0}`,
        dryRun,
        state: { ...simplaState },
        ts: now,
      });
      return;
    }

    if (kind === 'stop' || estopActive) {
      simplaState.leftPct = 0;
      simplaState.rightPct = 0;
      simplaState.grinderOn = false;
      simplaState.flameOn = false;
      simplaState.lastCommandAt = now;

      let piAck = false;
      if (getConfiguredPiBaseUrl()) {
        const piRes = await proxyPiRequest('POST', '/stop', { reason: 'simpla_bot_stop' }, 'application/json', 1500);
        piAck = Boolean(piRes.reachable && piRes.statusCode >= 200 && piRes.statusCode < 300);
      }

      res.json({
        ok: !estopActive || kind === 'stop',
        kind: 'stop',
        wireCommand: 'STOP',
        ack: estopActive && kind !== 'stop' ? 'ERR INTERLOCK_BLOCKED (E-STOP)' : 'OK STOP',
        piForwarded: piAck,
        dryRun,
        state: { ...simplaState },
        ts: now,
      });
      return;
    }

    if (kind === 'motor' || kind === 'move_mm' || kind === 'turn_deg') {
      const clampPct = (v: unknown) => {
        const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
        return Math.max(-100, Math.min(100, Math.round(n)));
      };

      let leftPct = 0;
      let rightPct = 0;
      let detail = '';

      if (kind === 'motor') {
        leftPct = clampPct(body.leftPct);
        rightPct = clampPct(body.rightPct);
        detail = `Direct PWM L=${leftPct}% R=${rightPct}%`;
      } else if (kind === 'move_mm') {
        const distMm = typeof body.distanceMm === 'number' && Number.isFinite(body.distanceMm)
          ? Math.max(-3000, Math.min(3000, Math.round(body.distanceMm)))
          : 0;
        const speedPct = Math.max(15, Math.min(100, clampPct(body.speedPct ?? 35)));
        const dir = distMm >= 0 ? 1 : -1;
        leftPct = distMm === 0 ? 0 : dir * speedPct;
        rightPct = distMm === 0 ? 0 : dir * speedPct;
        detail = `Calibrated roll ${distMm >= 0 ? '+' : ''}${distMm}mm @ ${speedPct}%`;
      } else {
        const angleDeg = typeof body.angleDeg === 'number' && Number.isFinite(body.angleDeg)
          ? Math.max(-180, Math.min(180, Math.round(body.angleDeg)))
          : 0;
        const speedPct = Math.max(15, Math.min(100, clampPct(body.speedPct ?? 42)));
        leftPct = angleDeg > 0 ? speedPct : angleDeg < 0 ? -speedPct : 0;
        rightPct = angleDeg > 0 ? -speedPct : angleDeg < 0 ? speedPct : 0;
        detail = `Pivot ${angleDeg >= 0 ? '+' : ''}${angleDeg} deg @ ${speedPct}%`;
      }

      // Stationary interlock: any wheel motion forces both relays OFF
      if (leftPct !== 0 || rightPct !== 0) {
        simplaState.grinderOn = false;
        simplaState.flameOn = false;
      }
      simplaState.leftPct = leftPct;
      simplaState.rightPct = rightPct;
      simplaState.lastCommandAt = now;

      const wireCommand = `M ${leftPct} ${rightPct}`;
      res.json({
        ok: true,
        kind,
        wireCommand,
        ack: dryRun ? `DRY_RUN ${wireCommand}` : `OK ${wireCommand}`,
        detail,
        dryRun,
        state: { ...simplaState },
        ts: now,
      });
      return;
    }

    // kind === 'relay' (Grinder CH1 / Flame CH2)
    const grinderOn = Boolean(body.grinderOn);
    const flameOn = Boolean(body.flameOn);
    const requestedFlameMs = typeof body.flameDurationMs === 'number' && Number.isFinite(body.flameDurationMs)
      ? Math.max(100, Math.min(2500, Math.round(body.flameDurationMs)))
      : 1200;

    if ((grinderOn || flameOn) && (simplaState.leftPct !== 0 || simplaState.rightPct !== 0)) {
      simplaState.grinderOn = false;
      simplaState.flameOn = false;
      res.status(409).json({
        ok: false,
        kind: 'relay',
        wireCommand: 'R 0 0',
        ack: 'ERR INTERLOCK_BLOCKED (ROVER_MOVING)',
        detail: 'Stop motors (0% PWM) before energizing Grinder or Flame relays.',
        dryRun,
        state: { ...simplaState },
        ts: now,
      });
      return;
    }

    if (flameOn && !simplaState.flameOn) {
      const cooldownRemMs = Math.max(0, 3000 - (now - simplaState.lastFlameEndMs));
      if (cooldownRemMs > 0) {
        res.status(429).json({
          ok: false,
          kind: 'relay',
          wireCommand: `R ${grinderOn ? 1 : 0} 0`,
          ack: `ERR FLAME_COOLDOWN (${(cooldownRemMs / 1000).toFixed(1)}s)`,
          detail: `Flame cooldown active (${(cooldownRemMs / 1000).toFixed(1)}s remaining).`,
          dryRun,
          state: { ...simplaState },
          ts: now,
        });
        return;
      }
    }

    if (simplaState.flameOn && !flameOn) {
      simplaState.lastFlameEndMs = now;
    }

    simplaState.grinderOn = grinderOn;
    simplaState.flameOn = flameOn;
    simplaState.lastCommandAt = now;

    const wireCommand = `R ${grinderOn ? 1 : 0} ${flameOn ? 1 : 0}`;
    res.json({
      ok: true,
      kind: 'relay',
      wireCommand,
      ack: dryRun ? `DRY_RUN ${wireCommand}` : `OK ${wireCommand}`,
      cappedFlameMs: requestedFlameMs,
      dryRun,
      state: { ...simplaState },
      ts: now,
    });
  });

  let lastPiFrameForwardMs = 0;

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

        // Forward live camera frames (throttled to ~4 Hz) to Pi /camera/frame when PI_ROBOT_URL is configured
        const nowMs = Date.now();
        if (getConfiguredPiBaseUrl() && nowMs - lastPiFrameForwardMs >= 250) {
          lastPiFrameForwardMs = nowMs;
          const frameBuf = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data as ArrayBuffer);
          if (frameBuf.byteLength > 0 && frameBuf.byteLength <= 4 * 1024 * 1024) {
            void proxyPiRequest('POST', '/camera/frame', frameBuf, 'image/jpeg', 1000);
          }
        }

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
        const reportedLatency = safeNum(msg.latencyMs);
        if (reportedIp) peer.lastReportedIp = reportedIp;
        if (reportedIf) peer.lastInterfaceName = reportedIf;
        if (reportedLatency !== null && reportedLatency >= 0) {
          peer.lastLatencyMs = reportedLatency;
        }

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
          latencyMs: reportedLatency ?? 0,
          centerDepthMm: safeNum(msg.centerDepthMm),
          leftDepthMm: safeNum(msg.leftDepthMm),
          rightDepthMm: safeNum(msg.rightDepthMm),
          minDepthMm: safeNum(msg.minDepthMm),
          maxDepthMm: safeNum(msg.maxDepthMm),
          weedDetected: typeof msg.weedDetected === 'boolean' ? msg.weedDetected : null,
          weedDepthMm: safeNum(msg.weedDepthMm),
          weedCxNorm: safeNum(msg.weedCxNorm),
          cornerType: safeStr(msg.cornerType, 32) || null,
          recommendedTravelMm: safeNum(msg.recommendedTravelMm),
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
    app.use((_req, res) => {
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
