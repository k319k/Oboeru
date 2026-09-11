import { describe, it, expect } from 'vitest';
import { CURATED_VOICES, DEFAULT_VOICE, resolveVoice, isAllowedVoiceName } from './tts-voices';

describe('CURATED_VOICES', () => {
  it('has 6 voices: 3 ja + 3 en, unique names', () => {
    expect(CURATED_VOICES).toHaveLength(6);
    const ja = CURATED_VOICES.filter((v) => v.lang === 'ja');
    const en = CURATED_VOICES.filter((v) => v.lang === 'en');
    expect(ja).toHaveLength(3);
    expect(en).toHaveLength(3);
    const names = CURATED_VOICES.map((v) => v.name);
    expect(new Set(names).size).toBe(6);
    expect(names).toContain('ja-JP-Neural2-B');
    expect(names).toContain('en-US-Neural2-A');
  });

  it('DEFAULT_VOICE names exist in CURATED_VOICES', () => {
    for (const name of Object.values(DEFAULT_VOICE)) {
      expect(isAllowedVoiceName(name)).toBe(true);
    }
  });
});

describe('resolveVoice', () => {
  it('uses stored voice when it matches the sentence language', () => {
    const v = resolveVoice('ja', 'ja-JP-Neural2-C');
    expect(v.name).toBe('ja-JP-Neural2-C');
  });

  it('falls back to default when stored voice is for a different language', () => {
    const v = resolveVoice('ja', 'en-US-Neural2-A');
    expect(v.name).toBe(DEFAULT_VOICE.ja);
  });

  it('falls back to default when stored voice is unknown (old Web Speech URI)', () => {
    const v = resolveVoice('ja', 'Microsoft Haruka - Japanese (Japan)');
    expect(v.name).toBe(DEFAULT_VOICE.ja);
  });

  it('falls back to default when no stored voice', () => {
    expect(resolveVoice('en', null).name).toBe(DEFAULT_VOICE.en);
    expect(resolveVoice('en', undefined).name).toBe(DEFAULT_VOICE.en);
  });

  it('returns a voice with the matching lang in all cases', () => {
    for (const lang of ['ja', 'en'] as const) {
      for (const stored of ['ja-JP-Neural2-B', 'en-US-Neural2-F', null, 'garbage-voice']) {
        expect(resolveVoice(lang, stored).lang).toBe(lang);
      }
    }
  });
});