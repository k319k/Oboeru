/**
 * Live STT model archive constants.
 *
 * The official downloads (https://alphacephei.com/vosk/models) are plain .zip
 * files. vosk-browser extracts them in its worker with libarchive configured
 * via `archive_read_support_format_all` (upstream src/utils.cc), which reads
 * zip directly — no conversion to tar.gz is needed.
 */

export const MODEL_ARCHIVE_NAMES = {
	ja: 'vosk-model-small-ja-0.22.zip',
	en: 'vosk-model-small-en-us-0.15.zip'
} as const;

export type ModelLang = keyof typeof MODEL_ARCHIVE_NAMES;

/**
 * Upstream asset URLs (GitHub Release). Release assets do not send CORS
 * headers, so the browser fetches models through the same-origin
 * /models/[file] proxy route. Fill these in after running `npm run stt:upload`
 * once (see README); a null entry makes the proxy answer 503.
 */
export const UPSTREAM_MODEL_URLS: Record<ModelLang, string | null> = {
	ja: null,
	en: null
};

/** Same-origin proxy URL the browser loads the model from. */
export function modelProxyUrl(lang: ModelLang): string {
	return `/models/${MODEL_ARCHIVE_NAMES[lang]}`;
}
