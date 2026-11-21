export const MISSION_CONTROL_ENDPOINTS = {
  start: '/api/robot/mission/start',
  stop: '/api/robot/mission/stop',
  pause: '/api/robot/mission/pause',
  resume: '/api/robot/mission/resume',
  recover: '/api/robot/recover',
  status: '/api/robot/status',
} as const;

export type MissionLifecycleAction = 'start' | 'stop' | 'pause' | 'resume' | 'recover';
export type PiConnectionMode = 'pi_live' | 'pi_unreachable' | 'sim_only' | 'checking';

export interface MissionStartRequest {
  source_type?: 'live_capture' | 'live_stream' | 'simulated' | 'field_mission';
  nav_only: boolean;
  operator_confirmed: boolean;
  start_row?: number;
  end_row?: number;
  speed_limit_mps?: number;
}

export interface MissionRecoverRequest {
  operator_confirmed: boolean;
  relocalize_pose?: [number, number, number];
}

export interface MissionControlStatus {
  ok: boolean;
  configured: boolean;
  connected: boolean;
  mode: PiConnectionMode;
  workerRunning: boolean;
  detail: string;
  piState: string | null;
  checkedAt: string;
  raw: Record<string, unknown> | null;
}

export interface MissionCommandResult {
  action: MissionLifecycleAction;
  endpoint: string;
  ok: boolean;
  httpStatus: number;
  configured: boolean;
  piExecuted: boolean;
  simOnly: boolean;
  ackVerified: boolean;
  hardwareStopped: boolean;
  state: string | null;
  reason: string | null;
  blockers: string[];
  checkpoint: Record<string, unknown> | null;
  detail: string;
  executedAt: string;
  raw: Record<string, unknown> | null;
}

/**
 * MissionControlService
 *
 * Implements the standard rover mission lifecycle API contract:
 *   - POST /api/robot/mission/start  -> Pi POST /start_mission
 *   - POST /api/robot/mission/stop   -> Pi POST /stop (verifies ESP32 stop ACK)
 *   - POST /api/robot/mission/pause  -> Pi POST /pause (returns saved checkpoint)
 *   - POST /api/robot/mission/resume -> Pi POST /resume
 *   - POST /api/robot/recover        -> Pi POST /recover
 *   - GET  /api/robot/status         -> Pi GET  /health
 *
 * Strictly distinguishes live Raspberry Pi execution from local simulation fallback
 * so UI controls never falsely report physical motion when PI_ROBOT_URL is unset.
 */
export class MissionControlService {
  private lastStatus: MissionControlStatus | null = null;
  private lastResult: MissionCommandResult | null = null;

  getLastStatus(): MissionControlStatus | null {
    return this.lastStatus;
  }

  getLastResult(): MissionCommandResult | null {
    return this.lastResult;
  }

  async getStatus(): Promise<MissionControlStatus> {
    const checkedAt = new Date().toISOString();
    try {
      const res = await fetch(MISSION_CONTROL_ENDPOINTS.status, {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const rawStatus =
        typeof data.status === 'object' && data.status !== null
          ? (data.status as Record<string, unknown>)
          : null;
      const mode: PiConnectionMode =
        data.mode === 'pi_live' || data.mode === 'pi_unreachable' || data.mode === 'sim_only'
          ? data.mode
          : data.configured
          ? 'pi_unreachable'
          : 'sim_only';

      const status: MissionControlStatus = {
        ok: Boolean(data.ok),
        configured: Boolean(data.configured),
        connected: Boolean(data.connected),
        mode,
        workerRunning: Boolean(data.workerRunning),
        detail:
          typeof data.detail === 'string'
            ? data.detail
            : mode === 'pi_live'
            ? 'Connected to Raspberry Pi navigation controller.'
            : 'PI_ROBOT_URL is not configured; local simulation mode only.',
        piState: typeof rawStatus?.state === 'string' ? rawStatus.state : null,
        checkedAt,
        raw: data,
      };
      this.lastStatus = status;
      return status;
    } catch (err) {
      const status: MissionControlStatus = {
        ok: false,
        configured: false,
        connected: false,
        mode: 'pi_unreachable',
        workerRunning: false,
        detail: err instanceof Error ? err.message : 'Unable to reach /api/robot/status.',
        piState: null,
        checkedAt,
        raw: null,
      };
      this.lastStatus = status;
      return status;
    }
  }

  async startMission(payload: MissionStartRequest): Promise<MissionCommandResult> {
    const body: MissionStartRequest = {
      source_type: payload.source_type ?? 'live_capture',
      nav_only: payload.nav_only,
      operator_confirmed: payload.operator_confirmed,
      ...(typeof payload.start_row === 'number' ? { start_row: payload.start_row } : {}),
      ...(typeof payload.end_row === 'number' ? { end_row: payload.end_row } : {}),
      ...(typeof payload.speed_limit_mps === 'number'
        ? { speed_limit_mps: payload.speed_limit_mps }
        : {}),
    };
    return this.postLifecycle('start', MISSION_CONTROL_ENDPOINTS.start, body);
  }

  async stopMission(): Promise<MissionCommandResult> {
    return this.postLifecycle('stop', MISSION_CONTROL_ENDPOINTS.stop, {});
  }

  async pauseMission(): Promise<MissionCommandResult> {
    return this.postLifecycle('pause', MISSION_CONTROL_ENDPOINTS.pause, {});
  }

  async resumeMission(): Promise<MissionCommandResult> {
    return this.postLifecycle('resume', MISSION_CONTROL_ENDPOINTS.resume, {});
  }

  async recoverMission(payload: MissionRecoverRequest): Promise<MissionCommandResult> {
    return this.postLifecycle('recover', MISSION_CONTROL_ENDPOINTS.recover, payload);
  }

  private async postLifecycle(
    action: MissionLifecycleAction,
    endpoint: string,
    payload: Record<string, unknown> | MissionStartRequest | MissionRecoverRequest
  ): Promise<MissionCommandResult> {
    const executedAt = new Date().toISOString();
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const reason = typeof data.reason === 'string' ? data.reason : null;
      const configured = data.configured !== false && reason !== 'PI_ROBOT_NOT_CONFIGURED';
      const simOnly = !configured || reason === 'PI_ROBOT_NOT_CONFIGURED';
      const blockers = Array.isArray(data.blockers)
        ? data.blockers.map((b) => String(b))
        : [];
      const ackVerified = Boolean(data.ackVerified ?? data.ack_verified);
      const hardwareStopped = Boolean(data.hardwareStopped);
      const checkpoint =
        typeof data.checkpoint === 'object' && data.checkpoint !== null
          ? (data.checkpoint as Record<string, unknown>)
          : null;
      const state = typeof data.state === 'string' ? data.state : null;

      let detail: string;
      if (typeof data.detail === 'string' && data.detail.trim()) {
        detail = data.detail;
      } else if (typeof data.error === 'string' && data.error.trim()) {
        detail = data.error;
      } else if (blockers.length > 0) {
        detail = `Pi interlock blocked launch: ${blockers.join(', ')}`;
      } else if (res.ok) {
        detail = `Pi accepted ${action.toUpperCase()} (${state ?? 'OK'}).`;
      } else {
        detail = `Mission ${action} rejected (HTTP ${res.status}${reason ? ` · ${reason}` : ''}).`;
      }

      const result: MissionCommandResult = {
        action,
        endpoint,
        ok: res.ok && data.ok !== false,
        httpStatus: res.status,
        configured,
        piExecuted: configured,
        simOnly,
        ackVerified,
        hardwareStopped,
        state,
        reason,
        blockers,
        checkpoint,
        detail,
        executedAt,
        raw: data,
      };
      this.lastResult = result;
      return result;
    } catch (err) {
      const result: MissionCommandResult = {
        action,
        endpoint,
        ok: false,
        httpStatus: 0,
        configured: Boolean(this.lastStatus?.configured),
        piExecuted: Boolean(this.lastStatus?.configured),
        simOnly: !this.lastStatus?.configured,
        ackVerified: false,
        hardwareStopped: false,
        state: null,
        reason: 'NETWORK_ERROR',
        blockers: [],
        checkpoint: null,
        detail: err instanceof Error ? err.message : `Failed to call ${endpoint}.`,
        executedAt,
        raw: null,
      };
      this.lastResult = result;
      return result;
    }
  }
}

export const missionControlService = new MissionControlService();
