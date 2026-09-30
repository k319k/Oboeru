import { describe, it, expect } from 'vitest';
import { CURATED_VOICES, resolveVoice, isAllowedVoiceName } from './tts-voices';

describe('CURATED_VOICES', () => {
  it('holds exactly one Gemini voice', () => {
    expect(CURATED_VOICES).toHaveLength(1);
    expect(CURATED_VOICES[0].name).toBe('Ludo');
  });

  it('exposes only name and label', () => {
    for (const v of CURATED_VOICES) {
      expect(Object.keys(v).sort()).toEqual(['label', 'name']);
    }
  });

  it('has a Japanese display label', () => {
    expect(CURATED_VOICES[0].label.length).toBeGreaterThan(0);
  });
});

describe('isAllowedVoiceName', () => {
  it('accepts Ludo', () => {
    expect(isAllowedVoiceName('Ludo')).toBe(true);
  });

  it('rejects the retired Google Cloud TTS names', () => {
    for (const name of [
      'ja-JP-Neural2-B',
      'ja-JP-Neural2-C',
      'ja-JP-Neural2-D',
      'en-US-Neural2-A',
      'en-US-Neural2-C',
      'en-US-Neural2-F',
    ]) {
      expect(isAllowedVoiceName(name)).toBe(false);
    }
  });

  it('rejects garbage', () => {
    expect(isAllowedVoiceName('some-random-uri')).toBe(false);
  });
});

describe('resolveVoice', () => {
  it('returns Ludo when nothing is stored', () => {
    expect(resolveVoice(null).name).toBe('Ludo');
    expect(resolveVoice(undefined).name).toBe('Ludo');
    expect(resolveVoice('').name).toBe('Ludo');
  });

  it('returns Ludo when Ludo is stored', () => {
    expect(resolveVoice('Ludo').name).toBe('Ludo');
  });

  it('falls back to Ludo for every stored Google name, so old settings are invalidated', () => {
    for (const stored of ['ja-JP-Neural2-B', 'en-US-Neural2-F', 'garbage-voice']) {
      expect(resolveVoice(stored).name).toBe('Ludo');
    }
  });
});
