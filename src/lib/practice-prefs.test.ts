import { describe, it, expect, beforeEach } from 'vitest';
import {
	loadPracticePrefs,
	savePracticePrefs,
	savePracticeProgress,
	loadPracticeProgress,
	clearPracticeProgress,
	type PracticePrefs,
	type PracticeProgress
} from './practice-prefs';
import { CORRECT_DWELL_MS, INCORRECT_DWELL_MS } from './constants';

// ---------------------------------------------------------------------------
// Minimal localStorage / sessionStorage mocks (no jsdom dependency needed)
// ---------------------------------------------------------------------------

function createStorageMock(): Storage {
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

let ls: ReturnType<typeof createStorageMock>;
let ss: ReturnType<typeof createStorageMock>;

beforeEach(() => {
  ls = createStorageMock();
  ss = createStorageMock();
  // Vitest runs in Node which has no Web Storage — wire our mocks in.
  Object.defineProperty(globalThis, 'localStorage', {
    value: ls,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: ss,
    writable: true,
    configurable: true,
  });
});

// ---------------------------------------------------------------------------
// PracticePrefs — defaults
// ---------------------------------------------------------------------------

describe('loadPracticePrefs — defaults', () => {
  it('returns defaults when localStorage is empty', () => {
    expect(loadPracticePrefs()).toEqual({
      autoAdvance: true,
      correctDwellMs: 800,
      incorrectDwellMs: 2000,
    });
  });

  it('returns defaults on corrupt JSON', () => {
    ls.setItem('oboeru:practice-ui:v1', '{bad json!!!');
    expect(loadPracticePrefs()).toEqual({
      autoAdvance: true,
      correctDwellMs: 800,
      incorrectDwellMs: 2000,
    });
  });

  it('returns defaults when stored value is not an object', () => {
    ls.setItem('oboeru:practice-ui:v1', JSON.stringify('just a string'));
    expect(loadPracticePrefs().autoAdvance).toBe(true);

    ls.setItem('oboeru:practice-ui:v1', JSON.stringify(42));
    expect(loadPracticePrefs().autoAdvance).toBe(true);

    ls.setItem('oboeru:practice-ui:v1', JSON.stringify(null));
    expect(loadPracticePrefs().autoAdvance).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PracticePrefs — save + load round-trip
// ---------------------------------------------------------------------------

describe('savePracticePrefs + loadPracticePrefs round-trip', () => {
  it('persists and retrieves custom prefs', () => {
    const custom: PracticePrefs = {
      autoAdvance: false,
      correctDwellMs: 400,
      incorrectDwellMs: 800,
    };
    savePracticePrefs(custom);
    expect(loadPracticePrefs()).toEqual(custom);
  });

  it('writes under the dedicated oboeru:practice-ui:v1 key', () => {
    savePracticePrefs({ autoAdvance: true, correctDwellMs: 800, incorrectDwellMs: 2000 });
    expect(ls.getItem('oboeru:practice-ui:v1')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PracticePrefs — validation / clamp
// ---------------------------------------------------------------------------

describe('loadPracticePrefs — clamp', () => {
  it('clamps non-boolean autoAdvance to true', () => {
    ls.setItem(
      'oboeru:practice-ui:v1',
      JSON.stringify({ autoAdvance: 'yes', correctDwellMs: 800, incorrectDwellMs: 2000 }),
    );
    expect(loadPracticePrefs().autoAdvance).toBe(true);
  });

  it('accepts autoAdvance = false', () => {
    ls.setItem(
      'oboeru:practice-ui:v1',
      JSON.stringify({ autoAdvance: false, correctDwellMs: 800, incorrectDwellMs: 2000 }),
    );
    expect(loadPracticePrefs().autoAdvance).toBe(false);
  });

  it('clamps non-number dwell to default', () => {
    ls.setItem(
      'oboeru:practice-ui:v1',
      JSON.stringify({ autoAdvance: true, correctDwellMs: 'fast', incorrectDwellMs: null }),
    );
    const prefs = loadPracticePrefs();
    expect(prefs.correctDwellMs).toBe(800);
    expect(prefs.incorrectDwellMs).toBe(2000);
  });

  it('clamps NaN dwell to default', () => {
    ls.setItem(
      'oboeru:practice-ui:v1',
      JSON.stringify({ autoAdvance: true, correctDwellMs: NaN, incorrectDwellMs: NaN }),
    );
    const prefs = loadPracticePrefs();
    expect(prefs.correctDwellMs).toBe(800);
    expect(prefs.incorrectDwellMs).toBe(2000);
  });

  it('clamps out-of-range dwell to default', () => {
    ls.setItem(
      'oboeru:practice-ui:v1',
      JSON.stringify({ autoAdvance: true, correctDwellMs: 99_999, incorrectDwellMs: -5 }),
    );
    const prefs = loadPracticePrefs();
    expect(prefs.correctDwellMs).toBe(800);
    expect(prefs.incorrectDwellMs).toBe(2000);
  });

  it('accepts dwell values within the legacy fallback envelope (constants.ts)', () => {
    ls.setItem(
      'oboeru:practice-ui:v1',
      JSON.stringify({ autoAdvance: true, correctDwellMs: 400, incorrectDwellMs: 800 }),
    );
    const prefs = loadPracticePrefs();
    expect(prefs.correctDwellMs).toBe(400);
    expect(prefs.incorrectDwellMs).toBe(800);

    // The legacy constants act as the ceiling of the valid range.
    expect(CORRECT_DWELL_MS).toBe(1200);
    expect(INCORRECT_DWELL_MS).toBe(2500);
    ls.setItem(
      'oboeru:practice-ui:v1',
      JSON.stringify({ autoAdvance: true, correctDwellMs: CORRECT_DWELL_MS, incorrectDwellMs: INCORRECT_DWELL_MS }),
    );
    expect(loadPracticePrefs().correctDwellMs).toBe(CORRECT_DWELL_MS);
    expect(loadPracticePrefs().incorrectDwellMs).toBe(INCORRECT_DWELL_MS);
  });
});

// ---------------------------------------------------------------------------
// PracticeProgress — save + load round-trip
// ---------------------------------------------------------------------------

describe('savePracticeProgress + loadPracticeProgress round-trip', () => {
  it('persists and retrieves progress for the same chapter', () => {
    const progress: PracticeProgress = {
      chapterId: 'ch-1',
      currentIndex: 1,
      completedCount: 2,
      totalScore: 170,
      skippedCount: 1,
      savedAt: Date.now(),
    };
    savePracticeProgress(progress);
    expect(loadPracticeProgress('ch-1')).toEqual(progress);
  });

  it('writes under the dedicated oboeru:progress:v1 sessionStorage key', () => {
    savePracticeProgress({
      chapterId: 'ch-1',
      currentIndex: 0,
      completedCount: 0,
      totalScore: 0,
      skippedCount: 0,
      savedAt: Date.now(),
    });
    expect(ss.getItem('oboeru:progress:v1')).not.toBeNull();
  });

  it('returns null for a different chapterId', () => {
    savePracticeProgress({
      chapterId: 'ch-1',
      currentIndex: 1,
      completedCount: 0,
      totalScore: 0,
      skippedCount: 0,
      savedAt: Date.now(),
    });
    expect(loadPracticeProgress('ch-other')).toBeNull();
  });

  it('returns null when nothing was saved', () => {
    expect(loadPracticeProgress('ch-1')).toBeNull();
  });

  it('returns null after clearPracticeProgress', () => {
    savePracticeProgress({
      chapterId: 'ch-1',
      currentIndex: 0,
      completedCount: 0,
      totalScore: 0,
      skippedCount: 0,
      savedAt: Date.now(),
    });
    clearPracticeProgress();
    expect(loadPracticeProgress('ch-1')).toBeNull();
  });

  it('returns null for progress older than 30 minutes', () => {
    const now = Date.now();
    savePracticeProgress({
      chapterId: 'ch-1',
      currentIndex: 1,
      completedCount: 0,
      totalScore: 0,
      skippedCount: 0,
      savedAt: now - 31 * 60 * 1000,
    });
    expect(loadPracticeProgress('ch-1', now)).toBeNull();
  });

  it('returns progress saved exactly at the 30 minute boundary', () => {
    const now = Date.now();
    savePracticeProgress({
      chapterId: 'ch-1',
      currentIndex: 1,
      completedCount: 0,
      totalScore: 0,
      skippedCount: 0,
      savedAt: now - 30 * 60 * 1000,
    });
    expect(loadPracticeProgress('ch-1', now)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PracticeProgress — validation / clamp
// ---------------------------------------------------------------------------

describe('loadPracticeProgress — validation', () => {
  it('returns null on corrupt JSON', () => {
    ss.setItem('oboeru:progress:v1', '{broken');
    expect(loadPracticeProgress('ch-1')).toBeNull();
  });

  it('returns null when the stored value is not an object', () => {
    ss.setItem('oboeru:progress:v1', JSON.stringify(42));
    expect(loadPracticeProgress('ch-1')).toBeNull();
  });

  it('returns null when savedAt is missing or not a number', () => {
    ss.setItem(
      'oboeru:progress:v1',
      JSON.stringify({ chapterId: 'ch-1', currentIndex: 1, completedCount: 0, totalScore: 0, skippedCount: 0 }),
    );
    expect(loadPracticeProgress('ch-1')).toBeNull();

    ss.setItem(
      'oboeru:progress:v1',
      JSON.stringify({ chapterId: 'ch-1', currentIndex: 1, completedCount: 0, totalScore: 0, skippedCount: 0, savedAt: 'now' }),
    );
    expect(loadPracticeProgress('ch-1')).toBeNull();
  });

  it('clamps non-number / negative counters to 0', () => {
    ss.setItem(
      'oboeru:progress:v1',
      JSON.stringify({
        chapterId: 'ch-1',
        currentIndex: 'two',
        completedCount: -3,
        totalScore: null,
        skippedCount: -2,
        savedAt: Date.now(),
      }),
    );
    const progress = loadPracticeProgress('ch-1');
    expect(progress).not.toBeNull();
    expect(progress!.currentIndex).toBe(0);
    expect(progress!.completedCount).toBe(0);
    expect(progress!.totalScore).toBe(0);
    expect(progress!.skippedCount).toBe(0);
  });

  it('truncates fractional counters to integers', () => {
    ss.setItem(
      'oboeru:progress:v1',
      JSON.stringify({
        chapterId: 'ch-1',
        currentIndex: 2,
        completedCount: 2,
        totalScore: 170,
        skippedCount: 1,
        savedAt: Date.now(),
      }),
    );
    const progress = loadPracticeProgress('ch-1');
    expect(progress!.currentIndex).toBe(2);
  });
});
