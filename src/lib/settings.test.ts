import { describe, it, expect, beforeEach } from 'vitest';
import { loadSettings, saveSettings, type Settings } from './settings';

// ---------------------------------------------------------------------------
// Minimal localStorage mock (no jsdom dependency needed)
// ---------------------------------------------------------------------------

function createLocalStorageMock(): Storage {
  let store: Record<string, string> = {};
  return {
    get length() {
      return Object.keys(store).length;
    },
    clear() {
      store = {};
    },
    getItem(key: string) {
      return key in store ? store[key] : null;
    },
    setItem(key: string, value: string) {
      store[key] = value;
    },
    removeItem(key: string) {
      delete store[key];
    },
    key(index: number) {
      return Object.keys(store)[index] ?? null;
    },
  };
}

let ls: ReturnType<typeof createLocalStorageMock>;

beforeEach(() => {
  ls = createLocalStorageMock();
  // Vitest runs in Node which has no localStorage — wire our mock in.
  Object.defineProperty(globalThis, 'localStorage', {
    value: ls,
    writable: true,
    configurable: true,
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadSettings', () => {
  it('returns defaults when localStorage is empty', () => {
    const s = loadSettings();
    expect(s).toEqual({
      threshold: 80,
      ttsRate: 1.0,
      voiceURI: null,
      retryFrom: 'tts',
    });
  });

  it('returns defaults on corrupt JSON', () => {
    ls.setItem('oboeru:settings:v1', '{bad json!!!');
    const s = loadSettings();
    expect(s.threshold).toBe(80);
    expect(s.ttsRate).toBe(1.0);
  });

  it('returns defaults when stored value is not an object', () => {
    ls.setItem('oboeru:settings:v1', JSON.stringify('just a string'));
    expect(loadSettings().threshold).toBe(80);

    ls.setItem('oboeru:settings:v1', JSON.stringify(42));
    expect(loadSettings().threshold).toBe(80);
  });

  it('returns defaults when stored value is null', () => {
    ls.setItem('oboeru:settings:v1', JSON.stringify(null));
    expect(loadSettings().threshold).toBe(80);
  });
});

describe('saveSettings + loadSettings round-trip', () => {
  it('persists and retrieves custom settings', () => {
    const custom: Settings = {
      threshold: 90,
      ttsRate: 1.5,
      voiceURI: 'urn:android:com.google.android.tts:some-voice',
      retryFrom: 'rerecord',
    };
    saveSettings(custom);
    expect(loadSettings()).toEqual(custom);
  });

  it('persists voiceURI = null correctly', () => {
    saveSettings({ threshold: 50, ttsRate: 0.8, voiceURI: null, retryFrom: 'tts' });
    const s = loadSettings();
    expect(s.voiceURI).toBeNull();
  });
});

describe('validation — threshold', () => {
  it('clamps threshold below 0 to default', () => {
    saveSettings({ threshold: -10, ttsRate: 1.0, voiceURI: null, retryFrom: 'tts' });
    expect(loadSettings().threshold).toBe(80);
  });

  it('clamps threshold above 100 to default', () => {
    saveSettings({ threshold: 200, ttsRate: 1.0, voiceURI: null, retryFrom: 'tts' });
    expect(loadSettings().threshold).toBe(80);
  });

  it('accepts threshold at boundary values', () => {
    saveSettings({ threshold: 0, ttsRate: 1.0, voiceURI: null, retryFrom: 'tts' });
    expect(loadSettings().threshold).toBe(0);

    saveSettings({ threshold: 100, ttsRate: 1.0, voiceURI: null, retryFrom: 'tts' });
    expect(loadSettings().threshold).toBe(100);
  });

  it('clamps non-number threshold to default', () => {
    ls.setItem(
      'oboeru:settings:v1',
      JSON.stringify({ threshold: 'not a number', ttsRate: 1.0, voiceURI: null, retryFrom: 'tts' }),
    );
    expect(loadSettings().threshold).toBe(80);
  });
});

describe('validation — ttsRate', () => {
  it('clamps ttsRate below 0.5 to default', () => {
    saveSettings({ threshold: 80, ttsRate: 0.1, voiceURI: null, retryFrom: 'tts' });
    expect(loadSettings().ttsRate).toBe(1.0);
  });

  it('clamps ttsRate above 2.0 to default', () => {
    saveSettings({ threshold: 80, ttsRate: 3.0, voiceURI: null, retryFrom: 'tts' });
    expect(loadSettings().ttsRate).toBe(1.0);
  });

  it('accepts ttsRate at boundary values', () => {
    saveSettings({ threshold: 80, ttsRate: 0.5, voiceURI: null, retryFrom: 'tts' });
    expect(loadSettings().ttsRate).toBe(0.5);

    saveSettings({ threshold: 80, ttsRate: 2.0, voiceURI: null, retryFrom: 'tts' });
    expect(loadSettings().ttsRate).toBe(2.0);
  });

  it('clamps non-number ttsRate to default', () => {
    ls.setItem(
      'oboeru:settings:v1',
      JSON.stringify({ threshold: 80, ttsRate: 'fast', voiceURI: null, retryFrom: 'tts' }),
    );
    expect(loadSettings().ttsRate).toBe(1.0);
  });
});

describe('validation — retryFrom', () => {
  it('accepts valid retryFrom values', () => {
    saveSettings({ threshold: 80, ttsRate: 1.0, voiceURI: null, retryFrom: 'tts' });
    expect(loadSettings().retryFrom).toBe('tts');

    saveSettings({ threshold: 80, ttsRate: 1.0, voiceURI: null, retryFrom: 'rerecord' });
    expect(loadSettings().retryFrom).toBe('rerecord');
  });

  it('falls back to "tts" for invalid retryFrom', () => {
    ls.setItem(
      'oboeru:settings:v1',
      JSON.stringify({ threshold: 80, ttsRate: 1.0, voiceURI: null, retryFrom: 'invalid' }),
    );
    expect(loadSettings().retryFrom).toBe('tts');
  });

  it('falls back to "tts" for non-string retryFrom', () => {
    ls.setItem(
      'oboeru:settings:v1',
      JSON.stringify({ threshold: 80, ttsRate: 1.0, voiceURI: null, retryFrom: 42 }),
    );
    expect(loadSettings().retryFrom).toBe('tts');
  });
});

describe('validation — voiceURI', () => {
  it('accepts any string as voiceURI', () => {
    saveSettings({ threshold: 80, ttsRate: 1.0, voiceURI: 'some-random-uri', retryFrom: 'tts' });
    expect(loadSettings().voiceURI).toBe('some-random-uri');
  });

  it('falls back to null for non-string voiceURI', () => {
    ls.setItem(
      'oboeru:settings:v1',
      JSON.stringify({ threshold: 80, ttsRate: 1.0, voiceURI: 123, retryFrom: 'tts' }),
    );
    expect(loadSettings().voiceURI).toBeNull();
  });
});
