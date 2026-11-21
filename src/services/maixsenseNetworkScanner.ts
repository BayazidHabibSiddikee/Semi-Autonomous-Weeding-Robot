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
