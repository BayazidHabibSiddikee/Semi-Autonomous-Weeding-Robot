/**
 * StartupHandshakeService
 *
 * Orchestrates the safe startup scan and explicit operator hardware recovery
 * for a USB-connected ESP32 and live MaixSense / navigation camera:
 *   1. Zero-config USB ESP32 serial detection (no manual baud/pin setup required).
 *   2. Safe boot scan (`performSafeScan`): dispatches strictly read-only
 *      `PING` + `TELEM?` via `POST /api/robot/handshake` (`allow_clear_latch: false`)
 *      and NEVER automatically clears a latched E-stop or watchdog fault.
 *   3. Manual hardware recovery (`confirmHardwareRecovery`): dispatches `CLEAR_LATCH`
 *      ONLY after explicit operator confirmation in HardwareAuditView, validates
 *      post-clear telemetry (`estop_ok === true && watchdog_ok === true`), and
 *      leaves the rover strictly PAUSED until resumed.
 *   4. Performs a deep Camera Readiness audit (MaixSense USB drive / RNDIS IP,
 *      OUI LAN discovery, active `/ws/camera` stream frames, and Pi CameraHealthMonitor).
 */

import {
  MaixSenseNetworkScanResult,
  scanLocalNetworkForMaixSense,
} from './maixsenseNetworkScanner';

export type HandshakeStepStatus = 'pass' | 'warn' | 'fail' | 'info';

export interface HandshakeStep {
  id: string;
  command: string;
  status: HandshakeStepStatus;
  response: string;
  detail: string;
}

export interface CameraReadinessDetails {
  cameraReady: boolean;
  piCameraHealthy: boolean;
  piCameraReason: string;
  piFramesIngested: number;
  wsPublishers: number;
  wsFramesRelayed: number;
  resolvedIp: string | null;
  ipSource: string;
  driveFound: boolean;
  drivePath: string | null;
  rndisDetected: boolean;
  networkStatus: 'connected' | 'detected' | 'offline';
  activeRoomsCount: number;
}

export interface StartupHandshakeReport {
  ok: boolean;
  configured: boolean;
  mode: 'pi_live' | 'pi_simulated' | 'pi_unreachable' | 'usb_unlinked';
  usbPort: string;
  detectedUsbPorts: string[];
  esp32Ready: boolean;
  watchdogInitialized: boolean;
  estopOk: boolean;
  latchLocked: boolean;
  requiresManualRecovery: boolean;
  clearLatchAttempted: boolean;
  inspectionOnly: boolean;
  navigationDispatchUnlocked: boolean;
  camera: CameraReadinessDetails;
  steps: HandshakeStep[];
  durationMs: number;
  executedAt: string;
  trigger: 'auto_boot_safe_scan' | 'manual_safe_scan' | 'manual_hardware_recovery';
  blockers: string[];
}

export interface HandshakeOptions {
  allowClearLatch?: boolean;
  operatorConfirmed?: boolean;
  trigger?: 'auto_boot_safe_scan' | 'manual_safe_scan' | 'manual_hardware_recovery';
  customOuiPrefixes?: string[];
}

export class StartupHandshakeService {
  private lastReport: StartupHandshakeReport | null = null;
  private inFlightPromise: Promise<StartupHandshakeReport> | null = null;

  getLastReport(): StartupHandshakeReport | null {
    return this.lastReport;
  }

  /**
   * Returns true ONLY when the ESP32 telemetry ready-state has been validated
   * (watchdog initialized & E-stop loop closed, no latch active) AND the camera is ready.
   */
  isNavigationDispatchAllowed(): boolean {
    return Boolean(this.lastReport?.navigationDispatchUnlocked);
  }

  /**
   * Safe Boot Scan (READ-ONLY — safe for automatic execution on boot/mount):
   * Scans USB ports, runs PING + TELEM? read-only, and audits camera readiness.
   * NEVER dispatches CLEAR_LATCH or clears a tripped E-stop/watchdog fault.
   */
  async performSafeScan(
    options: {
      trigger?: 'auto_boot_safe_scan' | 'manual_safe_scan';
      customOuiPrefixes?: string[];
    } = {}
  ): Promise<StartupHandshakeReport> {
    return this.executeHandshake({
      allowClearLatch: false,
      operatorConfirmed: false,
      trigger: options.trigger ?? 'auto_boot_safe_scan',
      customOuiPrefixes: options.customOuiPrefixes,
    });
  }

  /**
   * Backward-compatible alias for performSafeScan().
   */
  async inspectStartupStatus(
    options: {
      trigger?: 'auto_boot_safe_scan' | 'manual_safe_scan';
      customOuiPrefixes?: string[];
    } = {}
  ): Promise<StartupHandshakeReport> {
    return this.performSafeScan(options);
  }

  /**
   * Explicit Operator Hardware Recovery (CLEAR_LATCH):
   * Must ONLY be invoked when the operator manually clicks 'Confirm Hardware Recovery'
   * in HardwareAuditView after verifying the physical E-stop loop and rover perimeter.
   * Leaves the rover in PAUSED/IDLE until an explicit mission start/resume command.
   */
  async confirmHardwareRecovery(options: {
    operatorConfirmed: boolean;
    customOuiPrefixes?: string[];
  }): Promise<StartupHandshakeReport> {
    if (options.operatorConfirmed !== true) {
      return this.performSafeScan({
        trigger: 'manual_safe_scan',
        customOuiPrefixes: options.customOuiPrefixes,
      });
    }
    return this.executeHandshake({
      allowClearLatch: true,
      operatorConfirmed: true,
      trigger: 'manual_hardware_recovery',
      customOuiPrefixes: options.customOuiPrefixes,
    });
  }

  /**
   * Backward-compatible alias for confirmHardwareRecovery().
   */
  async authorizeClearLatch(options: {
    operatorConfirmed: boolean;
    customOuiPrefixes?: string[];
  }): Promise<StartupHandshakeReport> {
    return this.confirmHardwareRecovery(options);
  }

  /**
   * Execute safe boot scan (default) or explicit operator-confirmed CLEAR_LATCH recovery.
   */
  async executeHandshake(options: HandshakeOptions = {}): Promise<StartupHandshakeReport> {
    if (this.inFlightPromise) {
      return this.inFlightPromise;
    }

    const run = this._runInternal(options).finally(() => {
      this.inFlightPromise = null;
    });
    this.inFlightPromise = run;
    return run;
  }

  private async _runInternal(options: HandshakeOptions): Promise<StartupHandshakeReport> {
    const startedAt = performance.now();
    // Strictly opt-in: NEVER clear a latch unless explicitly requested AND operator-confirmed
    const allowClearLatch = options.allowClearLatch === true && options.operatorConfirmed === true;
    const operatorConfirmed = allowClearLatch;
    const trigger =
      options.trigger ?? (allowClearLatch ? 'manual_hardware_recovery' : 'manual_safe_scan');

    // Run ESP32 USB safe scan (PING + TELEM?) or explicit CLEAR_LATCH AND deep camera discovery in parallel
    const [handshakeResp, discoverResp, roomsResp, netScan] = await Promise.all([
      this.fetchEsp32Handshake(allowClearLatch, operatorConfirmed),
      this.fetchCameraDiscover(),
      this.fetchCameraRooms(),
      scanLocalNetworkForMaixSense({ customPrefixes: options.customOuiPrefixes ?? [] }).catch(
        (): MaixSenseNetworkScanResult | null => null
      ),
    ]);

    const wsPublishersFromRooms = roomsResp.publishersCount;
    const wsFramesFromRooms = roomsResp.framesRelayed;
    const wsPublishers = Math.max(
      wsPublishersFromRooms,
      Number(handshakeResp?.cameraSummary?.wsPublishers ?? 0)
    );
    const wsFramesRelayed = Math.max(
      wsFramesFromRooms,
      Number(handshakeResp?.cameraSummary?.wsFramesRelayed ?? 0)
    );

    const piCameraHealthy = Boolean(handshakeResp?.cameraSummary?.piCameraHealthy);
    const piCameraReason = String(
      handshakeResp?.cameraSummary?.piCameraReason || (piCameraHealthy ? 'OK' : 'CAMERA_NOT_ATTACHED')
    );
    const piFramesIngested = Number(handshakeResp?.cameraSummary?.piFramesIngested ?? 0);

    const rndisDetected = Boolean(
      (discoverResp?.rndisInterfaces?.length ?? 0) > 0 ||
        netScan?.connectionMethod === 'rndis_interface'
    );
    const resolvedIp =
      netScan?.resolvedIp ||
      handshakeResp?.cameraSummary?.resolvedIp ||
      discoverResp?.ipFromDrive ||
      discoverResp?.rndisInterfaces?.[0]?.cameraIp ||
      null;

    const ipSource = discoverResp?.ipFromDrive
      ? `MaixSense USB Drive (${discoverResp.drivePath || 'mounted'})`
      : rndisDetected
      ? `USB-RNDIS (${discoverResp?.rndisInterfaces?.[0]?.name || '192.168.233.x'})`
      : wsPublishers > 0
      ? 'Live WebSocket Bridge (/ws/camera)'
      : netScan?.resolvedIp
      ? `LAN OUI (${netScan.matchedPrefix || 'ARP'})`
      : 'Not detected yet';

    const cameraReady = Boolean(piCameraHealthy || wsPublishers > 0 || rndisDetected);

    const camera: CameraReadinessDetails = {
      cameraReady,
      piCameraHealthy,
      piCameraReason,
      piFramesIngested,
      wsPublishers,
      wsFramesRelayed,
      resolvedIp,
      ipSource,
      driveFound: Boolean(discoverResp?.driveFound),
      drivePath: discoverResp?.drivePath ?? null,
      rndisDetected,
      networkStatus: netScan?.status ?? (wsPublishers > 0 ? 'connected' : 'offline'),
      activeRoomsCount: roomsResp.roomsCount,
    };

    const esp32Ready = Boolean(handshakeResp?.esp32Ready);
    const watchdogInitialized = Boolean(handshakeResp?.watchdogInitialized);
    const estopOk = Boolean(handshakeResp?.estopOk);
    const latchLocked =
      typeof handshakeResp?.latchLocked === 'boolean' ? handshakeResp.latchLocked : !esp32Ready;
    const requiresManualRecovery = Boolean(latchLocked || !esp32Ready || !watchdogInitialized);
    const clearLatchAttempted = Boolean(handshakeResp?.clearLatchAttempted);
    const inspectionOnly = handshakeResp?.inspectionOnly !== false && !allowClearLatch;

    // Navigation dispatch unlocks ONLY when both ESP32 ready-state (no latch) AND camera are verified
    const navigationDispatchUnlocked = Boolean(
      esp32Ready &&
        watchdogInitialized &&
        estopOk &&
        !latchLocked &&
        (handshakeResp?.configured ? piCameraHealthy : cameraReady)
    );

    const blockers: string[] = [];
    if (!handshakeResp?.configured) {
      blockers.push('Pi robot controller not linked (PI_ROBOT_URL unset)');
    } else if (requiresManualRecovery) {
      blockers.push(
        'Latched E-stop or watchdog fault active — click "Confirm Hardware Recovery" after inspecting the physical rover'
      );
    }
    if (!estopOk && handshakeResp?.configured) {
      blockers.push('Physical GPIO 13 E-stop loop is open');
    }
    if (!cameraReady) {
      blockers.push('Camera stream offline (connect MaixSense USB/RNDIS or start bridge)');
    } else if (handshakeResp?.configured && !piCameraHealthy) {
      blockers.push(`Pi camera monitor awaiting frames (${piCameraReason})`);
    }

    const baseSteps: HandshakeStep[] = Array.isArray(handshakeResp?.steps)
      ? handshakeResp.steps.map((s: any) => ({
          id: String(s.id ?? 'step'),
          command: String(s.command ?? ''),
          status: (['pass', 'warn', 'fail', 'info'].includes(s.status) ? s.status : 'info') as HandshakeStepStatus,
          response: String(s.response ?? ''),
          detail: String(s.detail ?? ''),
        }))
      : [];

    // Ensure camera deep-check summary step is always included cleanly
    const hasCamStep = baseSteps.some((s) => s.id === 'camera_check' || s.id === 'camera_ready');
    if (!hasCamStep) {
      baseSteps.push({
        id: 'camera_deep_check',
        command: 'CAMERA_AUDIT',
        status: cameraReady ? 'pass' : 'warn',
        response: cameraReady
          ? `${resolvedIp || 'WS'} · ${wsPublishers} pub · ${wsFramesRelayed} frames`
          : 'CAMERA_OFFLINE',
        detail: cameraReady
          ? `Camera detected via ${ipSource}.`
          : 'No MaixSense USB drive, RNDIS adapter, or /ws/camera stream detected.',
      });
    }

    const report: StartupHandshakeReport = {
      ok: esp32Ready,
      configured: Boolean(handshakeResp?.configured),
      mode: handshakeResp?.mode || 'usb_unlinked',
      usbPort: String(handshakeResp?.usbPort || '/dev/ttyUSB0 (USB auto)'),
      detectedUsbPorts: Array.isArray(handshakeResp?.detectedUsbPorts)
        ? handshakeResp.detectedUsbPorts
        : [],
      esp32Ready,
      watchdogInitialized,
      estopOk,
      latchLocked,
      requiresManualRecovery,
      clearLatchAttempted,
      inspectionOnly,
      navigationDispatchUnlocked,
      camera,
      steps: baseSteps,
      durationMs: Math.round(performance.now() - startedAt),
      executedAt: new Date().toLocaleTimeString(),
      trigger,
      blockers,
    };

    this.lastReport = report;
    return report;
  }

  private async fetchEsp32Handshake(
    allowClearLatch: boolean,
    operatorConfirmed: boolean
  ): Promise<any> {
    try {
      const res = await fetch('/api/robot/handshake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          allow_clear_latch: allowClearLatch,
          operator_confirmed: operatorConfirmed,
          auto_usb: true,
        }),
      });
      return await res.json().catch(() => null);
    } catch {
      return null;
    }
  }

  private async fetchCameraDiscover(): Promise<{
    driveFound?: boolean;
    drivePath?: string | null;
    ipFromDrive?: string | null;
    rndisInterfaces?: Array<{ name: string; hostIp: string; cameraIp: string }>;
  } | null> {
    try {
      const res = await fetch('/api/maixsense/discover');
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  private async fetchCameraRooms(): Promise<{
    roomsCount: number;
    publishersCount: number;
    framesRelayed: number;
  }> {
    try {
      const res = await fetch('/api/camera/rooms');
      if (!res.ok) return { roomsCount: 0, publishersCount: 0, framesRelayed: 0 };
      const data = await res.json();
      const roomsList = Array.isArray(data.rooms) ? data.rooms : [];
      let publishersCount = 0;
      let framesRelayed = 0;
      for (const room of roomsList) {
        const pubs = Array.isArray(room.publishers) ? room.publishers : [];
        publishersCount += pubs.length;
        for (const p of pubs) {
          framesRelayed += Number(p.framesRelayed ?? 0);
        }
      }
      return { roomsCount: roomsList.length, publishersCount, framesRelayed };
    } catch {
      return { roomsCount: 0, publishersCount: 0, framesRelayed: 0 };
    }
  }
}

export const startupHandshakeService = new StartupHandshakeService();
