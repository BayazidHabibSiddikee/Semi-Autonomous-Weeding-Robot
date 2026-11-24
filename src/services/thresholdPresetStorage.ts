/**
 * LocalStorage persistence for Weed Detection Threshold Configurations & Named Presets.
 * Syncs live segmentation parameters between the Weed Vision tab and the Calibration tab.
 */

export interface WeedThresholdConfig {
  minExgFloor: number; // 6..65 (2G - R - B floor)
  minBlobAreaPx: number; // 20..300 px^2
  cropAreaFracPct: number; // 1.5..12.0 % frame area threshold splitting crop canopy vs weed candidate
  minConfidencePct: number; // 50..95 % minimum confidence to retain a localized blob
}

export interface ThresholdPreset {
  id: string;
  name: string;
  notes?: string;
  config: WeedThresholdConfig;
  savedAt: string;
}

export const DEFAULT_WEED_THRESHOLDS: WeedThresholdConfig = {
  minExgFloor: 24,
  minBlobAreaPx: 50,
  cropAreaFracPct: 4.5,
  minConfidencePct: 58,
};

export const ACTIVE_THRESHOLDS_STORAGE_KEY = 'weeding_rover_active_weed_thresholds_v1';
export const PRESETS_STORAGE_KEY = 'weeding_rover_weed_threshold_presets_v1';

function clampNumber(val: unknown, min: number, max: number, fallback: number): number {
  const n = typeof val === 'number' && Number.isFinite(val) ? val : fallback;
  return Math.max(min, Math.min(max, n));
}

export function sanitizeThresholdConfig(raw: Partial<WeedThresholdConfig> | null | undefined): WeedThresholdConfig {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_WEED_THRESHOLDS };
  }
  return {
    minExgFloor: Math.round(clampNumber(raw.minExgFloor, 6, 65, DEFAULT_WEED_THRESHOLDS.minExgFloor)),
    minBlobAreaPx: Math.round(
      clampNumber(raw.minBlobAreaPx, 20, 300, DEFAULT_WEED_THRESHOLDS.minBlobAreaPx)
    ),
    cropAreaFracPct: Number(
      clampNumber(raw.cropAreaFracPct, 1.5, 12.0, DEFAULT_WEED_THRESHOLDS.cropAreaFracPct).toFixed(1)
    ),
    minConfidencePct: Math.round(
      clampNumber(raw.minConfidencePct, 50, 95, DEFAULT_WEED_THRESHOLDS.minConfidencePct)
    ),
  };
}

export function loadActiveThresholds(): WeedThresholdConfig {
  try {
    const raw = window.localStorage.getItem(ACTIVE_THRESHOLDS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_WEED_THRESHOLDS };
    return sanitizeThresholdConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_WEED_THRESHOLDS };
  }
}

export function saveActiveThresholds(config: WeedThresholdConfig): void {
  try {
    window.localStorage.setItem(
      ACTIVE_THRESHOLDS_STORAGE_KEY,
      JSON.stringify(sanitizeThresholdConfig(config))
    );
  } catch {
    // Ignore storage quota or private browsing errors
  }
}

export function loadThresholdPresets(): ThresholdPreset[] {
  try {
    const raw = window.localStorage.getItem(PRESETS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item.id === 'string' && typeof item.name === 'string')
      .map((item) => ({
        id: item.id,
        name: item.name.trim(),
        notes: typeof item.notes === 'string' ? item.notes.trim() : undefined,
        config: sanitizeThresholdConfig(item.config),
        savedAt: typeof item.savedAt === 'string' ? item.savedAt : new Date().toLocaleString(),
      }));
  } catch {
    return [];
  }
}

export function saveThresholdPresets(presets: ThresholdPreset[]): void {
  try {
    window.localStorage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(presets));
  } catch {
    // Ignore storage quota or private browsing errors
  }
}

export function upsertThresholdPreset(
  name: string,
  config: WeedThresholdConfig,
  notes?: string
): { presets: ThresholdPreset[]; saved: ThresholdPreset; replaced: boolean } {
  const trimmedName = name.trim();
  const trimmedNotes = notes?.trim() || undefined;
  const cleanConfig = sanitizeThresholdConfig(config);
  const existing = loadThresholdPresets();
  const matchIdx = existing.findIndex(
    (p) => p.name.toLowerCase() === trimmedName.toLowerCase()
  );

  const nowLabel = new Date().toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  if (matchIdx >= 0) {
    const updated: ThresholdPreset = {
      ...existing[matchIdx],
      name: trimmedName,
      notes: trimmedNotes,
      config: cleanConfig,
      savedAt: nowLabel,
    };
    const next = [updated, ...existing.filter((_, i) => i !== matchIdx)];
    saveThresholdPresets(next);
    return { presets: next, saved: updated, replaced: true };
  }

  const created: ThresholdPreset = {
    id: `preset-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: trimmedName,
    notes: trimmedNotes,
    config: cleanConfig,
    savedAt: nowLabel,
  };
  const next = [created, ...existing];
  saveThresholdPresets(next);
  return { presets: next, saved: created, replaced: false };
}

export function deleteThresholdPreset(id: string): ThresholdPreset[] {
  const next = loadThresholdPresets().filter((p) => p.id !== id);
  saveThresholdPresets(next);
  return next;
}
