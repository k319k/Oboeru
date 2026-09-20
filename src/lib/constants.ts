/**
 * Legacy fixed dwell times — now the FALLBACK DEFAULTS of the user-tunable
 * practice prefs (`oboeru:practice-ui:v1`, see src/lib/practice-prefs.ts).
 * The values are unchanged: they act as the ceiling of the valid dwell range
 * stored in prefs, so tuned dwell times never exceed the original behavior.
 */

/** Legacy 1.2 s after a correct answer before auto-advance (prefs fallback ceiling). */
export const CORRECT_DWELL_MS = 1_200;

/** Legacy 2.5 s after an incorrect answer before the retry prompt replays (prefs fallback ceiling). */
export const INCORRECT_DWELL_MS = 2_500;
