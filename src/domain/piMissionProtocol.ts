/**
 * Raspberry Pi 4/5 FastAPI BEV & Mission Plan Protocol Helpers.
 *
 * Matches Navigation/src/pi_server.py:
 *   - POST /image          -> returns BEV metadata + bev_url (or direct image blob)
 *   - GET  /bev_image      -> serves the auto-warped 2D Top-Down BEV JPEG
 *   - POST /start_mission  -> accepts { start: { nx, ny }, end: { nx, ny } | null, relay_mode }
 */

import { AutoFieldAnalysis, MIN_DETECTION_CONFIDENCE, NormalizedPoint } from './autoFieldPipeline';
import { FieldCorners } from './models';
import { RelayMode } from './roverLiveEngine';

export interface BevPixelPoint {
  x: number;
  y: number;
}

export interface PiImageServerResponse {
  status?: string;
  bev_url?: string;
  bev_width?: number;
  bev_height?: number;
  boundary_corners?: number[][];
  ridges_nx?: number[];
  furrows_nx?: number[];
  confidence?: number;
  min_confidence?: number;
  ready?: boolean;
  map_feed?: string;
  video_feed?: string;
}

export interface PiMissionPlanJson {
  start: {
    nx: number;
    ny: number;
  };
  end: {
    nx: number;
    ny: number;
  } | null;
  relay_mode: RelayMode;
}

export interface PiStartMissionResponse {
  status: string;
  waypoints?: number;
  start?: NormalizedPoint;
  end?: NormalizedPoint;
  relay_mode?: string;
}

/**
 * Translate tapped BEV pixel coordinates (px, py) into normalized [0.02, 0.98]
 * coordinates matching Navigation/src/pi_server.py's start_mission schema.
 */
export function pixelToNormalizedBev(
  pixel: BevPixelPoint,
  bevWidth: number,
  bevHeight: number
): NormalizedPoint {
  const safeW = Math.max(1, bevWidth);
  const safeH = Math.max(1, bevHeight);
  const nx = Math.max(0.02, Math.min(0.98, pixel.x / safeW));
  const ny = Math.max(0.02, Math.min(0.98, pixel.y / safeH));
  return {
    nx: Number(nx.toFixed(4)),
    ny: Number(ny.toFixed(4)),
  };
}

/**
 * Translate normalized BEV coordinates back into exact pixel coordinates on the BEV image.
 */
export function normalizedToPixelBev(
  point: NormalizedPoint,
  bevWidth: number,
  bevHeight: number
): BevPixelPoint {
  return {
    x: Math.round(Math.max(0, Math.min(bevWidth, point.nx * bevWidth))),
    y: Math.round(Math.max(0, Math.min(bevHeight, point.ny * bevHeight))),
  };
}

/**
 * Build the exact mission plan JSON expected by Pi's POST /start_mission endpoint.
 */
export function buildPiMissionPlanJson(
  startPixel: BevPixelPoint,
  endPixel: BevPixelPoint | null,
  bevWidth: number,
  bevHeight: number,
  relayMode: RelayMode
): PiMissionPlanJson {
  return {
    start: pixelToNormalizedBev(startPixel, bevWidth, bevHeight),
    end: endPixel ? pixelToNormalizedBev(endPixel, bevWidth, bevHeight) : null,
    relay_mode: relayMode,
  };
}

export function normalizePiBaseUrl(piHost: string): string {
  const trimmed = piHost.trim().replace(/\/+$/, '');
  if (!trimmed) return 'http://192.168.4.1:8000';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

export function resolvePiBevImageUrl(piHost: string, bevUrlPath?: string): string {
  const base = normalizePiBaseUrl(piHost);
  if (!bevUrlPath) return `${base}/bev_image?t=${Date.now()}`;
  if (/^(https?:|data:|blob:)/i.test(bevUrlPath)) return bevUrlPath;
  const path = bevUrlPath.startsWith('/') ? bevUrlPath : `/${bevUrlPath}`;
  return `${base}${path}`;
}

function parseServerCorners(
  rawCorners: number[][] | undefined,
  srcW: number,
  srcH: number
): FieldCorners {
  if (Array.isArray(rawCorners) && rawCorners.length === 4) {
    const valid = rawCorners.every(
      (pt) => Array.isArray(pt) && pt.length >= 2 && Number.isFinite(pt[0]) && Number.isFinite(pt[1])
    );
    if (valid) {
      return {
        topLeft: { x: rawCorners[0][0], y: rawCorners[0][1] },
        topRight: { x: rawCorners[1][0], y: rawCorners[1][1] },
        bottomRight: { x: rawCorners[2][0], y: rawCorners[2][1] },
        bottomLeft: { x: rawCorners[3][0], y: rawCorners[3][1] },
      };
    }
  }
  return {
    topLeft: { x: srcW * 0.08, y: srcH * 0.1 },
    topRight: { x: srcW * 0.92, y: srcH * 0.1 },
    bottomRight: { x: srcW * 0.92, y: srcH * 0.9 },
    bottomLeft: { x: srcW * 0.08, y: srcH * 0.9 },
  };
}

export interface UploadedPiBevResult {
  analysis: AutoFieldAnalysis;
  bevImageUrl: string;
  isObjectUrl: boolean;
  rawResponse?: PiImageServerResponse;
}

/**
 * Upload a field photo to the Raspberry Pi server (`POST /image`).
 * Handles both:
 *   1. FastAPI JSON response returning `{ bev_url, bev_width, bev_height, ridges_nx, furrows_nx, confidence, ready }`
 *   2. Direct binary BEV image responses (`image/jpeg`, `image/png`)
 */
export async function uploadFieldPhotoToPi(
  piHost: string,
  imageBlob: Blob,
  filename: string,
  sourceWidth: number,
  sourceHeight: number,
  apiToken?: string
): Promise<UploadedPiBevResult> {
  const base = normalizePiBaseUrl(piHost);
  const form = new FormData();
  form.append('file', imageBlob, filename);

  const headers: Record<string, string> = {};
  if (apiToken && apiToken.trim()) {
    headers.Authorization = `Bearer ${apiToken.trim()}`;
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch(`${base}/image`, {
      method: 'POST',
      headers,
      body: form,
      signal: controller.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Pi /image rejected (HTTP ${res.status})${detail ? `: ${detail}` : ''}`);
    }

    const contentType = res.headers.get('content-type') || '';

    // Case A: Server returned a raw warped BEV image directly
    if (contentType.startsWith('image/')) {
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      return {
        bevImageUrl: objectUrl,
        isObjectUrl: true,
        analysis: {
          sourceWidth,
          sourceHeight,
          detectedCorners: parseServerCorners(undefined, sourceWidth, sourceHeight),
          bevDataUrl: objectUrl,
          bevWidth: 640,
          bevHeight: 480,
          ridgesNx: [],
          furrowsNx: [],
          furrowWidthNx: 0.1,
          vegetationCoverage: 0,
          confidence: 0.85,
          ready: true,
        },
      };
    }

    // Case B: Standard Pi FastAPI JSON response with bev_url & segmentation metadata
    const data = (await res.json()) as PiImageServerResponse;
    const bevW = Number.isFinite(data.bev_width) && (data.bev_width ?? 0) > 0 ? data.bev_width! : 640;
    const bevH = Number.isFinite(data.bev_height) && (data.bev_height ?? 0) > 0 ? data.bev_height! : 480;
    const ridgesNx = Array.isArray(data.ridges_nx) ? data.ridges_nx : [];
    const furrowsNx = Array.isArray(data.furrows_nx) ? data.furrows_nx : [];
    const confidence = typeof data.confidence === 'number' ? data.confidence : 0;
    const minConf = typeof data.min_confidence === 'number' ? data.min_confidence : MIN_DETECTION_CONFIDENCE;
    const ready = typeof data.ready === 'boolean' ? data.ready : confidence >= minConf && furrowsNx.length >= 1;
    const bevImageUrl = resolvePiBevImageUrl(piHost, data.bev_url);

    const furrowWidthNx =
      furrowsNx.length >= 2
        ? Math.min(0.14, ((furrowsNx[furrowsNx.length - 1] - furrowsNx[0]) / (furrowsNx.length - 1)) * 0.48)
        : 0.1;

    return {
      bevImageUrl,
      isObjectUrl: false,
      rawResponse: data,
      analysis: {
        sourceWidth,
        sourceHeight,
        detectedCorners: parseServerCorners(data.boundary_corners, sourceWidth, sourceHeight),
        bevDataUrl: bevImageUrl,
        bevWidth: bevW,
        bevHeight: bevH,
        ridgesNx,
        furrowsNx,
        furrowWidthNx,
        vegetationCoverage: confidence,
        confidence,
        ready,
      },
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

/**
 * Send the translated Pi Mission Plan JSON to `POST /start_mission`.
 */
export async function dispatchMissionPlanToPi(
  piHost: string,
  missionPlan: PiMissionPlanJson,
  apiToken?: string
): Promise<PiStartMissionResponse> {
  const base = normalizePiBaseUrl(piHost);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiToken && apiToken.trim()) {
    headers.Authorization = `Bearer ${apiToken.trim()}`;
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(`${base}/start_mission`, {
      method: 'POST',
      headers,
      body: JSON.stringify(missionPlan),
      signal: controller.signal,
    });

    const rawText = await res.text().catch(() => '');
    if (!res.ok) {
      throw new Error(`Pi /start_mission rejected (HTTP ${res.status})${rawText ? `: ${rawText}` : ''}`);
    }

    return rawText ? (JSON.parse(rawText) as PiStartMissionResponse) : { status: 'started' };
  } finally {
    window.clearTimeout(timeout);
  }
}
