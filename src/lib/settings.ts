/**
 * Application settings with localStorage persistence.
 *
 * The Settings type is defined here so that this module is self-contained
 * even before src/lib/types.ts is created.  Once types.ts exists it can
 * re-export this interface.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Settings {
  /** Speech-match accuracy threshold 0–100 (default 80). */
  threshold: number;
  /** TTS playback rate 0.5–2.0 (default 1.0). */
  ttsRate: number;
  /** Selected voice URI, or null for the browser default. */
  voiceURI: string | null;
  /** Where to replay from after an incorrect answer. */
  retryFrom: 'tts' | 'rerecord';
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'oboeru:settings:v1';

const DEFAULTS: Readonly<Settings> = {
  threshold: 80,
  ttsRate: 1.0,
  voiceURI: null,
  retryFrom: 'tts',
} as const;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function clampOrFallback(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== 'number' || Number.isNaN(value)) return fallback;
  if (value < min || value > max) return fallback;
  return value;
}

function validateRetryFrom(value: unknown): 'tts' | 'rerecord' {
  return value === 'tts' || value === 'rerecord' ? value : 'tts';
}

function validate(raw: Record<string, unknown>): Settings {
  return {
    threshold: clampOrFallback(raw.threshold, 0, 100, DEFAULTS.threshold),
    ttsRate: clampOrFallback(raw.ttsRate, 0.5, 2.0, DEFAULTS.ttsRate),
    voiceURI:
      typeof raw.voiceURI === 'string' || raw.voiceURI === null
        ? raw.voiceURI
        : DEFAULTS.voiceURI,
    retryFrom: validateRetryFrom(raw.retryFrom),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Read settings from localStorage, falling back to defaults on any error. */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return { ...DEFAULTS };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULTS };
    return validate(parsed as Record<string, unknown>);
  } catch {
    return { ...DEFAULTS };
  }
}

/** Persist settings to localStorage. */
export function saveSettings(settings: Settings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
