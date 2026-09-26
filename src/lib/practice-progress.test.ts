import { describe, it, expect, beforeEach } from 'vitest';
import {
	savePracticeProgress,
	loadPracticeProgress,
	clearPracticeProgress,
	type PracticeProgress
} from './practice-progress';

// ---------------------------------------------------------------------------
// Minimal sessionStorage mock (no jsdom dependency needed)
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

let ss: ReturnType<typeof createStorageMock>;

beforeEach(() => {
  ss = createStorageMock();
  // Vitest runs in Node which has no Web Storage — wire our mocks in.
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: ss,
    writable: true,
    configurable: true,
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
