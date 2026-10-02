/**
 * The single Gemini TTS voice, plus pure selection logic.
 * No browser APIs — safe to import from the server (/api/tts), the client, and
 * Node tests.
 *
 * `Ludo` is a Gemini prebuilt voice that handles both ja and en: Gemini detects
 * the language from the input text, so there is no per-language voice axis.
 * `languageCode` / `gender` were Google Cloud TTS concepts and are gone.
 */

export interface VoiceInfo {
  /** Gemini voice name — stored verbatim in settings.voiceURI. */
  name: string;
  /** Short label shown in the UI (Japanese). */
  label: string;
}

export const CURATED_VOICES: VoiceInfo[] = [{ name: 'Ludo', label: 'Ludo' }];

/**
 * Pick the voice. The stored preference is honoured only when it is in the
 * allowlist; anything else (unknown, or a Google name retired by the Gemini
 * migration) falls back to the single default. This is what silently
 * invalidates `settings.voiceURI` values written by older versions.
 */
export function resolveVoice(storedVoiceURI: string | null | undefined): VoiceInfo {
  if (storedVoiceURI) {
    const match = CURATED_VOICES.find((v) => v.name === storedVoiceURI);
    if (match) return match;
  }
  return CURATED_VOICES[0];
}

/** Allowlist check used by the /api/tts endpoint. */
export function isAllowedVoiceName(name: string): boolean {
  return CURATED_VOICES.some((v) => v.name === name);
}
