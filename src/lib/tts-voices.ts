/**
 * Curated Google Cloud TTS voices and pure selection logic.
 * No browser APIs — safe to import from the server (/api/tts), the client,
 * and Node tests.
 */

export type TtsLang = 'ja' | 'en';

export interface VoiceInfo {
  /** Google Cloud TTS voice name — stored verbatim in settings.voiceURI. */
  name: string;
  languageCode: string;
  lang: TtsLang;
  gender: 'male' | 'female';
  /** Short label shown in the UI (Japanese). */
  label: string;
}

export const CURATED_VOICES: VoiceInfo[] = [
  { name: 'ja-JP-Neural2-B', languageCode: 'ja-JP', lang: 'ja', gender: 'female', label: 'Neural2-B (女性)' },
  { name: 'ja-JP-Neural2-C', languageCode: 'ja-JP', lang: 'ja', gender: 'male', label: 'Neural2-C (男性)' },
  { name: 'ja-JP-Neural2-D', languageCode: 'ja-JP', lang: 'ja', gender: 'male', label: 'Neural2-D (男性)' },
  { name: 'en-US-Neural2-A', languageCode: 'en-US', lang: 'en', gender: 'male', label: 'Neural2-A (男性)' },
  { name: 'en-US-Neural2-C', languageCode: 'en-US', lang: 'en', gender: 'female', label: 'Neural2-C (女性)' },
  { name: 'en-US-Neural2-F', languageCode: 'en-US', lang: 'en', gender: 'female', label: 'Neural2-F (女性)' },
];

export const DEFAULT_VOICE: Record<TtsLang, string> = {
  ja: 'ja-JP-Neural2-B',
  en: 'en-US-Neural2-C',
};

/**
 * Pick the voice for a sentence of `lang`.
 * The stored preference is honoured only when it belongs to the same language;
 * otherwise (unknown / old Web Speech URI / wrong language) the per-language
 * default wins.
 */
export function resolveVoice(
  lang: TtsLang,
  storedVoiceURI: string | null | undefined,
): VoiceInfo {
  if (storedVoiceURI) {
    const match = CURATED_VOICES.find(
      (v) => v.name === storedVoiceURI && v.lang === lang,
    );
    if (match) return match;
  }
  const def = CURATED_VOICES.find((v) => v.name === DEFAULT_VOICE[lang]);
  return def ?? CURATED_VOICES.find((v) => v.lang === lang)!;
}

/** Allowlist check used by the /api/tts endpoint. */
export function isAllowedVoiceName(name: string): boolean {
  return CURATED_VOICES.some((v) => v.name === name);
}