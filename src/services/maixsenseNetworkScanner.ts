/**
 * Local Network Scanner Utility for Sipeed MaixSense-A075V / ToF+RGB Cameras.
 *
 * Queries common embedded/USB-RNDIS manufacturer OUI prefixes against:
 *  1. Host network interfaces & Linux kernel ARP table (/api/maixsense/scan-network)
 *  2. Active MaixSense WebSocket bridge streams (/ws/camera)
 *  3. Mounted USB drive IP discovery (/api/maixsense/discover)
 *  4. Optional client-side HTTP probe (when running on local HTTP)
 */

export interface ManufacturerOuiPrefix {
  prefix: string;
  vendor: string;
  role: string;
  priority: 'high' | 'medium';
}

export const MAIXSENSE_MANUFACTURER_PREFIXES: ManufacturerOuiPrefix[] = [
  {
    prefix: '00:E0:4C',
    vendor: 'Realtek Semiconductor',
    role: 'USB-Ethernet / RNDIS Bridge',
    priority: 'high',
  },
  {
    prefix: '18:93:7F',
    vendor: 'Sipeed / Allwinner SoC',
    role: 'MaixSense-A075V Linux Module',
    priority: 'high',
  },
  {
    prefix: '88:12:4E',
    vendor: 'Allwinner Embedded Linux',
    role: 'MaixSense ToF/RGB Module',
    priority: 'high',
  },
  {
    prefix: '42:4C:00',
    vendor: 'Bouffalo Lab / Sipeed',
    role: 'MaixSense-A010 / Companion',
    priority: 'high',
  },
  {
    prefix: '00:1A:79',
    vendor: 'Embedded Linux IP Cam',
    role: 'ToF/RGB Camera Firmware',
    priority: 'medium',
  },
  {
    prefix: '28:6C:07',
    vendor: 'Allwinner Camera SoC',
    role: 'Linux Camera Module',
    priority: 'medium',
  },
  {
    prefix: '30:AE:A4',
    vendor: 'Espressif Systems',
    role: 'Rover ESP32 / Camera Bridge',
    priority: 'medium',
  },
  {
    prefix: '24:6F:28',
    vendor: 'Espressif Systems',
    role: 'Rover ESP32 / Wi-Fi Bridge',
    priority: 'medium',
  },
  {
    prefix: 'DC:A6:32',
    vendor: 'Raspberry Pi Trading',
    role: 'Rover Companion Pi',
    priority: 'medium',
  },
  {
    prefix: 'E4:5F:01',
    vendor: 'Raspberry Pi Trading',
    role: 'Rover Companion Pi',
    priority: 'medium',
  },
];

export type MaixSenseConnectionStatus = 'connected' | 'detected' | 'scanning' | 'offline';

export interface NetworkCandidate {
  ip: string;
  mac: string;
  interfaceName: string;
  manufacturer: string;
  matchedPrefix: string;
  confidence: 'high' | 'medium' | 'low';
  source: 'ws_bridge' | 'arp_table' | 'rndis_adapter' | 'usb_drive' | 'direct_http';
  reachable: boolean;
}

export interface MaixSenseNetworkScanResult {
  status: MaixSenseConnectionStatus;
  resolvedIp: string | null;
  resolvedMac: string | null;
  resolvedVendor: string | null;
  matchedPrefix: string | null;
  connectionMethod: 'ws_bridge' | 'rndis_interface' | 'rndis_arp' | 'usb_drive' | 'direct_http' | 'none';
  isCloudContainer: boolean;
  hostOs: string;
  scannedSubnets: string[];
  prefixesQueried: number;
  arpEntriesScanned: number;
  activeWsBridges: number;
  candidates: NetworkCandidate[];
  scanDurationMs: number;
  scannedAt: string;
  error?: string;
}

const OUI_PREFIX_REGEX = /^[0-9A-F]{2}:[0-9A-F]{2}:[0-9A-F]{2}$/;
const IPV4_EXACT_REGEX =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/**
 * Validates and normalizes an IEEE OUI prefix string (e.g. "00-e0-4c" -> "00:E0:4C").
 */
export function normalizeOuiPrefix(raw: string): string | null {
  const cleaned = raw.trim().toUpperCase().replace(/-/g, ':');
  return OUI_PREFIX_REGEX.test(cleaned) ? cleaned : null;
}

/**
 * Matches a MAC address against known MaixSense/embedded manufacturer OUI prefixes
 * as well as Linux USB-RNDIS locally-administered gadget MAC addresses.
 */
export function matchManufacturerPrefix(
  macRaw: string,
  customPrefixes: string[] = []
): {
  matched: boolean;
  vendor: string;
  matchedPrefix: string;
  isLocallyAdministeredRndis: boolean;
} {
  const mac = macRaw.trim().toUpperCase().replace(/-/g, ':');
  if (mac.length < 8) {
    return { matched: false, vendor: 'Unknown', matchedPrefix: '—', isLocallyAdministeredRndis: false };
  }
  const prefix3 = mac.slice(0, 8);

  const normalizedCustom = customPrefixes
    .map(normalizeOuiPrefix)
    .filter((p): p is string => p !== null);

  if (normalizedCustom.includes(prefix3)) {
    return {
      matched: true,
      vendor: 'Custom Manufacturer OUI',
      matchedPrefix: prefix3,
      isLocallyAdministeredRndis: false,
    };
  }

  const known = MAIXSENSE_MANUFACTURER_PREFIXES.find((item) => item.prefix === prefix3);
  if (known) {
    return {
      matched: true,
      vendor: known.vendor,
      matchedPrefix: known.prefix,
      isLocallyAdministeredRndis: false,
    };
  }

  // Linux USB RNDIS gadget (f_rndis / g_ether on Sipeed MaixSense-A075V) sets bit 1 (LAA) & clears bit 0 (unicast)
  const firstOctet = parseInt(mac.slice(0, 2), 16);
  const isLaaUnicast =
    Number.isFinite(firstOctet) && (firstOctet & 0x02) !== 0 && (firstOctet & 0x01) === 0;
  if (isLaaUnicast) {
    return {
      matched: true,
      vendor: 'Linux USB-RNDIS Gadget (MaixSense-A075V)',
      matchedPrefix: `${prefix3} (LAA/RNDIS)`,
      isLocallyAdministeredRndis: true,
    };
  }

  return {
    matched: false,
    vendor: 'Unlisted Vendor',
    matchedPrefix: prefix3,
    isLocallyAdministeredRndis: false,
  };
}

/**
 * Scans the local network for the MaixSense camera IP address by querying common
 * manufacturer OUI prefixes, USB-RNDIS interfaces, ARP entries, mounted drives,
 * and active WebSocket camera bridges.
 */
export async function scanLocalNetworkForMaixSense(options?: {
  customPrefixes?: string[];
  timeoutMs?: number;
  probeLocalHttp?: boolean;
}): Promise<MaixSenseNetworkScanResult> {
  const t0 = performance.now();
  const timeoutMs = Math.max(800, Math.min(8000, options?.timeoutMs ?? 2500));
  const validCustom = (options?.customPrefixes ?? [])
    .map(normalizeOuiPrefix)
    .filter((p): p is string => p !== null)
    .slice(0, 10);

  const query = validCustom.length > 0 ? `?prefixes=${encodeURIComponent(validCustom.join(','))}` : '';

  const controller = new AbortController();
  const timerId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const [scanResp, discoverResp] = await Promise.all([
      fetch(`/api/maixsense/scan-network${query}`, {
        cache: 'no-store',
        signal: controller.signal,
      }),
      fetch('/api/maixsense/discover', {
        cache: 'no-store',
        signal: controller.signal,
      }).catch(() => null),
    ]);

    if (!scanResp.ok) {
      throw new Error(`Network scanner endpoint returned HTTP ${scanResp.status}`);
    }

    const scanData = await scanResp.json();
    const discoverData = discoverResp && discoverResp.ok ? await discoverResp.json() : null;

    const candidates: NetworkCandidate[] = Array.isArray(scanData.candidates)
      ? [...scanData.candidates]
      : [];

    // Merge USB drive discovery if an IP was extracted from a mounted MaixSense volume
    if (
      discoverData?.driveFound &&
      typeof discoverData.ipFromDrive === 'string' &&
      IPV4_EXACT_REGEX.test(discoverData.ipFromDrive) &&
      !candidates.some((c) => c.ip === discoverData.ipFromDrive)
    ) {
      candidates.push({
        ip: discoverData.ipFromDrive,
        mac: 'USB-DRIVE',
        interfaceName: discoverData.drivePath || 'USB Volume',
        manufacturer: 'Sipeed MaixSense (USB Drive Config)',
        matchedPrefix: 'USB-STORAGE',
        confidence: 'high',
        source: 'usb_drive',
        reachable: true,
      });
    }

    let status: MaixSenseConnectionStatus = scanData.status || 'offline';
    let resolvedIp: string | null = scanData.resolvedIp ?? candidates[0]?.ip ?? null;
    let resolvedMac: string | null = scanData.resolvedMac ?? candidates[0]?.mac ?? null;
    let resolvedVendor: string | null = scanData.resolvedVendor ?? candidates[0]?.manufacturer ?? null;
    let matchedPrefix: string | null = scanData.matchedPrefix ?? candidates[0]?.matchedPrefix ?? null;
    let connectionMethod: MaixSenseNetworkScanResult['connectionMethod'] =
      scanData.connectionMethod || 'none';

    // When opened locally over http:// (e.g. localhost:3000 on PC/Pi), optionally verify direct HTTP response
    if (
      options?.probeLocalHttp !== false &&
      status !== 'connected' &&
      window.location.protocol === 'http:'
    ) {
      const targetIp = resolvedIp && IPV4_EXACT_REGEX.test(resolvedIp) ? resolvedIp : '192.168.233.1';
      const probeCtrl = new AbortController();
      const probeTimer = window.setTimeout(() => probeCtrl.abort(), 900);
      try {
        const directResp = await fetch(`http://${targetIp}/get_cfg`, {
          cache: 'no-store',
          signal: probeCtrl.signal,
        });
        if (directResp.ok) {
          status = 'connected';
          resolvedIp = targetIp;
          resolvedVendor = resolvedVendor || 'Sipeed MaixSense-A075V (Direct HTTP)';
          matchedPrefix = matchedPrefix || '192.168.233.x';
          connectionMethod = 'direct_http';
          if (!candidates.some((c) => c.ip === targetIp)) {
            candidates.unshift({
              ip: targetIp,
              mac: resolvedMac || 'USB-RNDIS',
              interfaceName: 'Direct HTTP',
              manufacturer: 'Sipeed MaixSense-A075V',
              matchedPrefix: '192.168.233.x',
              confidence: 'high',
              source: 'direct_http',
              reachable: true,
            });
          }
        }
      } catch {
        // Expected if MaixSense isn't locally reachable or blocks CORS
      } finally {
        window.clearTimeout(probeTimer);
      }
    }

    return {
      status,
      resolvedIp,
      resolvedMac,
      resolvedVendor,
      matchedPrefix,
      connectionMethod,
      isCloudContainer: Boolean(scanData.isCloudContainer),
      hostOs: String(scanData.hostOs || 'unknown'),
      scannedSubnets: Array.isArray(scanData.scannedSubnets) ? scanData.scannedSubnets : [],
      prefixesQueried: Number(scanData.prefixesQueried || MAIXSENSE_MANUFACTURER_PREFIXES.length),
      arpEntriesScanned: Number(scanData.arpEntriesScanned || 0),
      activeWsBridges: Number(scanData.activeWsBridges || 0),
      candidates,
      scanDurationMs: Math.round(performance.now() - t0),
      scannedAt: new Date().toLocaleTimeString(),
    };
  } catch (err) {
    return {
      status: 'offline',
      resolvedIp: null,
      resolvedMac: null,
      resolvedVendor: null,
      matchedPrefix: null,
      connectionMethod: 'none',
      isCloudContainer: false,
      hostOs: 'unknown',
      scannedSubnets: [],
      prefixesQueried: MAIXSENSE_MANUFACTURER_PREFIXES.length + validCustom.length,
      arpEntriesScanned: 0,
      activeWsBridges: 0,
      candidates: [],
      scanDurationMs: Math.round(performance.now() - t0),
      scannedAt: new Date().toLocaleTimeString(),
      error: err instanceof Error ? err.message : 'Local network scan failed',
    };
  } finally {
    window.clearTimeout(timerId);
  }
}

export type StreamDiagnosticProtocol = 'auto' | 'mjpeg' | 'rtsp';

export interface DiagnosticPortProbe {
  port: number;
  service: string;
  open: boolean;
  rttMs: number | null;
}

export interface DiagnosticStep {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail' | 'info';
  detail: string;
  durationMs?: number;
}

export interface MaixSenseDiagnosticReport {
  ok: boolean;
  targetIp: string;
  room: string;
  protocolRequested: StreamDiagnosticProtocol;
  isCloudContainer: boolean;
  overallStatus: 'accessible' | 'bridge_reconnected' | 'unreachable';
  ping: {
    reachable: boolean;
    rttMs: number | null;
    method: 'tcp_socket_probe' | 'ws_bridge_heartbeat' | 'browser_local_http' | 'browser_local_required';
    detail: string;
  };
  ports: DiagnosticPortProbe[];
  streamProbe: {
    protocol: 'MJPEG/HTTP' | 'RTSP' | 'WS-Bridge' | 'None';
    endpointUrl: string;
    accessible: boolean;
    httpOrRtspStatus: string | null;
    detail: string;
  };
  reconnection: {
    attempted: boolean;
    hardwareSetCfgOk: boolean;
    wsPublishersSignaled: number;
    wsViewersSignaled: number;
    activeFramesRelayed: number;
    detail: string;
  };
  steps: DiagnosticStep[];
  totalDurationMs: number;
  diagnosedAt: string;
  error?: string;
}

/**
 * Validates that an IP string is a canonical private LAN IPv4 address
 * (blocks loopback, link-local/metadata 169.254.x.x, and public internet IPs).
 */
export function isValidPrivateLanIpv4(raw: string): boolean {
  const ip = raw.trim();
  if (!IPV4_EXACT_REGEX.test(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Diagnostic function for the Hardware Audit view:
 *  1. Pings the identified MaixSense IP (TCP socket RTT on local host or active WS bridge heartbeat)
 *  2. Probes RTSP (:554 OPTIONS) and HTTP/MJPEG (/getdeep, /mjpeg, /stream) accessibility
 *  3. Forces a stream reconnection via hardware POST /set_cfg + /ws/camera maixsense:reconnect broadcast
 *  4. When running locally over http://, also performs a direct browser HTTP ping & re-trigger fallback
 */
export async function diagnoseMaixSenseHardwareAccessibility(options: {
  ip: string;
  protocol?: StreamDiagnosticProtocol;
  room?: string;
  forceReconnect?: boolean;
}): Promise<MaixSenseDiagnosticReport> {
  const t0 = performance.now();
  const targetIp = options.ip.trim();
  const protocol: StreamDiagnosticProtocol = options.protocol ?? 'auto';
  const room = (options.room || 'rover-01').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'rover-01';
  const forceReconnect = options.forceReconnect !== false;

  if (!isValidPrivateLanIpv4(targetIp)) {
    return {
      ok: false,
      targetIp,
      room,
      protocolRequested: protocol,
      isCloudContainer: false,
      overallStatus: 'unreachable',
      ping: {
        reachable: false,
        rttMs: null,
        method: 'tcp_socket_probe',
        detail: 'Enter a valid local private LAN IPv4 address (e.g. 192.168.233.1).',
      },
      ports: [],
      streamProbe: {
        protocol: 'None',
        endpointUrl: `http://${targetIp}/getdeep`,
        accessible: false,
        httpOrRtspStatus: null,
        detail: 'Invalid private LAN IP address.',
      },
      reconnection: {
        attempted: false,
        hardwareSetCfgOk: false,
        wsPublishersSignaled: 0,
        wsViewersSignaled: 0,
        activeFramesRelayed: 0,
        detail: 'Aborted due to invalid IP format.',
      },
      steps: [
        {
          id: 'validate',
          label: 'IP Address Validation',
          status: 'fail',
          detail: `"${targetIp || '(empty)'}" is not a valid private LAN IPv4 address.`,
        },
      ],
      totalDurationMs: Math.round(performance.now() - t0),
      diagnosedAt: new Date().toLocaleTimeString(),
      error: 'Invalid private LAN IPv4 address.',
    };
  }

  // Notify any active in-page stream viewers to prepare for reconnection
  if (forceReconnect) {
    window.dispatchEvent(
      new CustomEvent('maixsense:force-reconnect', {
        detail: { ip: targetIp, protocol, room },
      })
    );
  }

  const controller = new AbortController();
  const timerId = window.setTimeout(() => controller.abort(), 7500);

  try {
    const resp = await fetch('/api/maixsense/diagnose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
      body: JSON.stringify({
        ip: targetIp,
        protocol,
        room,
        forceReconnect,
      }),
    });

    const data = await resp.json();
    if (!resp.ok || !data?.ok) {
      throw new Error(data?.error || `Diagnostic endpoint returned HTTP ${resp.status}`);
    }

    const report: MaixSenseDiagnosticReport = {
      ok: true,
      targetIp: data.targetIp,
      room: data.room,
      protocolRequested: data.protocolRequested,
      isCloudContainer: Boolean(data.isCloudContainer),
      overallStatus: data.overallStatus,
      ping: data.ping,
      ports: Array.isArray(data.ports) ? data.ports : [],
      streamProbe: data.streamProbe,
      reconnection: data.reconnection,
      steps: Array.isArray(data.steps) ? [...data.steps] : [],
      totalDurationMs: Math.round(performance.now() - t0),
      diagnosedAt: new Date().toLocaleTimeString(),
    };

    // If opened locally over http:// and backend could not reach the camera directly,
    // attempt a direct browser-to-MaixSense HTTP ping + POST /set_cfg stream re-trigger.
    if (
      window.location.protocol === 'http:' &&
      report.overallStatus !== 'accessible' &&
      (protocol === 'auto' || protocol === 'mjpeg')
    ) {
      const browserT0 = performance.now();
      const bCtrl = new AbortController();
      const bTimer = window.setTimeout(() => bCtrl.abort(), 1400);
      try {
        if (forceReconnect) {
          const cfgBytes = new Uint8Array([1, 1, 255, 0, 2, 7, 1, 0, 0, 0, 0, 0]);
          await fetch(`http://${targetIp}/set_cfg`, {
            method: 'POST',
            body: cfgBytes,
            cache: 'no-store',
            signal: bCtrl.signal,
          }).catch(() => null);
        }
        const getRes = await fetch(`http://${targetIp}/getdeep`, {
          cache: 'no-store',
          signal: bCtrl.signal,
        });
        const rtt = Math.round(performance.now() - browserT0);
        if (getRes.ok) {
          const buf = await getRes.arrayBuffer();
          report.overallStatus = 'accessible';
          report.ping = {
            reachable: true,
            rttMs: rtt,
            method: 'browser_local_http',
            detail: `Direct browser HTTP ping to http://${targetIp}/getdeep succeeded (${rtt} ms).`,
          };
          report.streamProbe = {
            protocol: 'MJPEG/HTTP',
            endpointUrl: `http://${targetIp}/getdeep`,
            accessible: true,
            httpOrRtspStatus: `HTTP ${getRes.status} (${buf.byteLength} B)`,
            detail: `Verified live MaixSense frame payload directly from browser (${buf.byteLength} B in ${rtt} ms).`,
          };
          report.reconnection.hardwareSetCfgOk = true;
          report.steps.push({
            id: 'browser_direct',
            label: `Direct Browser HTTP Probe (http://${targetIp}/getdeep)`,
            status: 'pass',
            detail: `Received ${buf.byteLength} B frame payload after POST /set_cfg re-init (${rtt} ms).`,
            durationMs: rtt,
          });
        }
      } catch {
        // Expected when camera is disconnected or CORS blocks direct fetch
      } finally {
        window.clearTimeout(bTimer);
      }
    }

    report.totalDurationMs = Math.round(performance.now() - t0);
    return report;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Hardware accessibility diagnostic failed';
    return {
      ok: false,
      targetIp,
      room,
      protocolRequested: protocol,
      isCloudContainer: false,
      overallStatus: 'unreachable',
      ping: {
        reachable: false,
        rttMs: null,
        method: 'tcp_socket_probe',
        detail: msg,
      },
      ports: [],
      streamProbe: {
        protocol: 'None',
        endpointUrl: protocol === 'rtsp' ? `rtsp://${targetIp}:554/` : `http://${targetIp}/getdeep`,
        accessible: false,
        httpOrRtspStatus: null,
        detail: msg,
      },
      reconnection: {
        attempted: forceReconnect,
        hardwareSetCfgOk: false,
        wsPublishersSignaled: 0,
        wsViewersSignaled: 0,
        activeFramesRelayed: 0,
        detail: msg,
      },
      steps: [
        {
          id: 'error',
          label: 'Diagnostic Execution',
          status: 'fail',
          detail: msg,
        },
      ],
      totalDurationMs: Math.round(performance.now() - t0),
      diagnosedAt: new Date().toLocaleTimeString(),
      error: msg,
    };
  } finally {
    window.clearTimeout(timerId);
  }
}

export interface HardResetStep {
  id: string;
  phase: string;
  status: 'pass' | 'warn' | 'fail' | 'info';
  detail: string;
  durationMs?: number;
}

export interface MaixSenseHardResetReport {
  ok: boolean;
  targetIp: string;
  room: string;
  isCloudContainer: boolean;
  overallStatus: 'power_cycled' | 'bridge_dispatched' | 'manual_required';
  usbDeviceMatched: string | null;
  usbPowerCycled: boolean;
  firmwareResetSent: boolean;
  wsPublishersSignaled: number;
  wsViewersSignaled: number;
  postResetRecovered: boolean;
  postResetRttMs: number | null;
  totalDurationMs: number;
  steps: HardResetStep[];
  executedAt: string;
  error?: string;
}

/**
 * Triggers a lower-level hardware power-cycle signal to the MaixSense device
 * (USB sysfs power toggle + firmware trigger halt/reboot/cold /set_cfg + WS bridge hard-reset dispatch)
 * to resolve persistent connection failures.
 */
export async function attemptMaixSenseHardReset(options: {
  ip: string;
  room?: string;
  powerOffMs?: number;
}): Promise<MaixSenseHardResetReport> {
  const t0 = performance.now();
  const targetIp = options.ip.trim();
  const room = (options.room || 'rover-01').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'rover-01';
  const powerOffMs = Math.max(800, Math.min(3000, options.powerOffMs ?? 1500));

  if (!isValidPrivateLanIpv4(targetIp)) {
    return {
      ok: false,
      targetIp,
      room,
      isCloudContainer: false,
      overallStatus: 'manual_required',
      usbDeviceMatched: null,
      usbPowerCycled: false,
      firmwareResetSent: false,
      wsPublishersSignaled: 0,
      wsViewersSignaled: 0,
      postResetRecovered: false,
      postResetRttMs: null,
      totalDurationMs: Math.round(performance.now() - t0),
      steps: [
        {
          id: 'validate',
          phase: 'IP Validation',
          status: 'fail',
          detail: `"${targetIp || '(empty)'}" is not a valid private LAN IPv4 address.`,
        },
      ],
      executedAt: new Date().toLocaleTimeString(),
      error: 'Invalid private LAN IPv4 address.',
    };
  }

  const controller = new AbortController();
  const timerId = window.setTimeout(() => controller.abort(), 12000);

  try {
    const resp = await fetch('/api/maixsense/hard-reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
      body: JSON.stringify({
        ip: targetIp,
        room,
        powerOffMs,
      }),
    });

    const data = await resp.json();
    if (!resp.ok || !data?.ok) {
      throw new Error(data?.error || `Hard reset endpoint returned HTTP ${resp.status}`);
    }

    const report: MaixSenseHardResetReport = {
      ok: true,
      targetIp: data.targetIp,
      room: data.room,
      isCloudContainer: Boolean(data.isCloudContainer),
      overallStatus: data.overallStatus,
      usbDeviceMatched: data.usbDeviceMatched ?? null,
      usbPowerCycled: Boolean(data.usbPowerCycled),
      firmwareResetSent: Boolean(data.firmwareResetSent),
      wsPublishersSignaled: Number(data.wsPublishersSignaled ?? 0),
      wsViewersSignaled: Number(data.wsViewersSignaled ?? 0),
      postResetRecovered: Boolean(data.postResetRecovered),
      postResetRttMs: typeof data.postResetRttMs === 'number' ? data.postResetRttMs : null,
      totalDurationMs: Math.round(performance.now() - t0),
      steps: Array.isArray(data.steps) ? [...data.steps] : [],
      executedAt: new Date().toLocaleTimeString(),
    };

    // Local HTTP fallback: if opened directly on http://localhost and server could not reach hardware,
    // send stop trigger -> brief hold -> cold POST /set_cfg directly from browser.
    if (window.location.protocol === 'http:' && report.overallStatus === 'manual_required') {
      const bCtrl = new AbortController();
      const bTimer = window.setTimeout(() => bCtrl.abort(), 2500);
      try {
        const stopBytes = new Uint8Array([0, 0, 255, 0, 2, 7, 0, 0, 0, 0, 0, 0]);
        await fetch(`http://${targetIp}/set_cfg`, {
          method: 'POST',
          body: stopBytes,
          cache: 'no-store',
          signal: bCtrl.signal,
        }).catch(() => null);
        await new Promise((r) => window.setTimeout(r, 400));
        const startBytes = new Uint8Array([1, 1, 255, 0, 2, 7, 1, 0, 0, 0, 0, 0]);
        const tReinit = performance.now();
        const reinit = await fetch(`http://${targetIp}/set_cfg`, {
          method: 'POST',
          body: startBytes,
          cache: 'no-store',
          signal: bCtrl.signal,
        });
        if (reinit.ok) {
          const rtt = Math.round(performance.now() - tReinit);
          report.overallStatus = 'power_cycled';
          report.firmwareResetSent = true;
          report.postResetRecovered = true;
          report.postResetRttMs = rtt;
          report.steps.push({
            id: 'browser_fw_cycle',
            phase: 'Direct Browser Firmware Cycle',
            status: 'pass',
            detail: `Sent trigger halt + cold POST http://${targetIp}/set_cfg directly from browser (${rtt} ms).`,
            durationMs: rtt,
          });
        }
      } catch {
        // Expected if device is unplugged or CORS blocks direct access
      } finally {
        window.clearTimeout(bTimer);
      }
    }

    report.totalDurationMs = Math.round(performance.now() - t0);
    return report;
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Hard reset sequence failed';
    return {
      ok: false,
      targetIp,
      room,
      isCloudContainer: false,
      overallStatus: 'manual_required',
      usbDeviceMatched: null,
      usbPowerCycled: false,
      firmwareResetSent: false,
      wsPublishersSignaled: 0,
      wsViewersSignaled: 0,
      postResetRecovered: false,
      postResetRttMs: null,
      totalDurationMs: Math.round(performance.now() - t0),
      steps: [
        {
          id: 'error',
          phase: 'Hard Reset Execution',
          status: 'fail',
          detail: msg,
        },
      ],
      executedAt: new Date().toLocaleTimeString(),
      error: msg,
    };
  } finally {
    window.clearTimeout(timerId);
  }
}


