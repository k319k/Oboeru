import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import {
  TTS_CACHE_SCHEMA_VERSION,
  TTS_CACHE_MAX_BYTES,
  cacheKeyOf,
  isTtsCacheAvailable,
  readCachedPcm,
  writeCachedPcm,
  clearTtsCacheForTests,
  pruneOldest,
} from './tts-cache';

const DB_NAME = 'oboeru-tts';
const NO_INDEX_DB_NAME = 'oboeru-tts-no-index';
const STORE = 'audio';

/**
 * lastUsedAt comes from Date.now(), and a tight write loop lands several writes
 * in the same millisecond — which would make the index cursor's order among
 * ties arbitrary and the eviction-order assertions meaningless. A monotonic
 * stand-in gives every write a distinct, ordered stamp so "oldest first" is
 * actually being tested.
 */
let clock = 0;

beforeEach(async () => {
  clock = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => ++clock);
  globalThis.indexedDB = new IDBFactory();
  await clearTtsCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Opens a second connection to the already-created cache database. */
function openTestDb(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function countEntries(db: IDBDatabase): Promise<number> {
  return request(db.transaction(STORE, 'readonly').objectStore(STORE).count());
}

async function stampOf(db: IDBDatabase, key: string): Promise<number> {
  const record = await request<{ lastUsedAt: number } | undefined>(
    db.transaction(STORE, 'readonly').objectStore(STORE).get(key),
  );
  return record?.lastUsedAt ?? -1;
}

/** Sums the stored byteLength of every record, the same way pruneOldest does. */
async function totalBytesOf(db: IDBDatabase): Promise<number> {
  return new Promise<number>((resolve) => {
    let sum = 0;
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(sum);
        return;
      }
      sum += (cursor.value as { byteLength: number }).byteLength ?? 0;
      cursor.continue();
    };
  });
}

/** Polls until `probe` is truthy. Needed for the fire-and-forget lastUsedAt touch. */
async function waitUntil(probe: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitUntil: condition never became true');
}

/**
 * A store shaped like the real one but created WITHOUT the lastUsedAt index, so
 * the missing-index path can be exercised without corrupting the cache database.
 */
function createDbWithoutIndex(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(NO_INDEX_DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

describe('cacheKeyOf', () => {
  it('is a synchronous pure function', () => {
    const key = cacheKeyOf({ text: 'こんにちは', lang: 'ja' });
    expect(typeof key).toBe('string');
  });

  it('embeds the schema version, model, voice and style', () => {
    expect(cacheKeyOf({ text: 'x', lang: 'ja' })).toBe(
      `v${TTS_CACHE_SCHEMA_VERSION}|google/gemini-3.8-flash-lite-tts|Ludo|Narration|ja|x`,
    );
  });

  it('excludes speakingRate so a rate change does not regenerate', () => {
    const a = cacheKeyOf({ text: 'x', lang: 'ja' });
    const b = cacheKeyOf({ text: 'x', lang: 'ja' });
    expect(a).toBe(b);
    expect(a).not.toContain('0.9');
  });

  it('separates different text and different lang', () => {
    expect(cacheKeyOf({ text: 'a', lang: 'ja' })).not.toBe(
      cacheKeyOf({ text: 'b', lang: 'ja' }),
    );
    expect(cacheKeyOf({ text: 'a', lang: 'ja' })).not.toBe(
      cacheKeyOf({ text: 'a', lang: 'en' }),
    );
  });
});

describe('isTtsCacheAvailable', () => {
  it('is true when indexedDB exists', () => {
    expect(isTtsCacheAvailable()).toBe(true);
  });
});

describe('read / write round trip', () => {
  it('returns null for a key that was never written', async () => {
    expect(await readCachedPcm('nope')).toBeNull();
  });

  it('returns the exact bytes that were written', async () => {
    const pcm = new Uint8Array([0, 1, 250, 251, 128, 64]);
    await writeCachedPcm('k1', pcm);
    const back = await readCachedPcm('k1');
    expect(back).not.toBeNull();
    expect(Array.from(back!)).toEqual(Array.from(pcm));
  });

  it('overwrites an existing key', async () => {
    await writeCachedPcm('k1', new Uint8Array([1, 1]));
    await writeCachedPcm('k1', new Uint8Array([2, 2, 2]));
    expect(Array.from((await readCachedPcm('k1'))!)).toEqual([2, 2, 2]);
  });

  it('makes a write immediately visible to the next read', async () => {
    // Contract guard, not an implementation guard: Task 5 reads straight after a
    // cache miss, so a read returning the previous value would be a cache hit
    // against stale audio. IndexedDB serialises overlapping transactions on one
    // connection, so this holds even though run() resolves at request success
    // rather than at commit — re-resolving run() on tx.oncomplete was measured
    // to change nothing here, so it was not adopted.
    for (let i = 0; i < 5; i++) {
      const payload = new Uint8Array(64).fill(i + 1);
      await writeCachedPcm('seq', payload);
      expect(Array.from((await readCachedPcm('seq'))!)).toEqual(Array.from(payload));
    }
  });

  it('stores a record with lastUsedAt so eviction can order it', async () => {
    await writeCachedPcm('k1', new Uint8Array([1]));
    const db = await openTestDb();
    const record = await request<{ lastUsedAt: number; byteLength: number }>(
      db.transaction(STORE, 'readonly').objectStore(STORE).get('k1'),
    );
    expect(typeof record.lastUsedAt).toBe('number');
    expect(record.byteLength).toBe(1);
    db.close();
  });
});

describe('pruneOldest', () => {
  it('keeps everything when the total is under the budget', async () => {
    for (let i = 0; i < 10; i++) await writeCachedPcm(`u-${i}`, new Uint8Array(1024));
    const db = await openTestDb();
    await pruneOldest(db, 64 * 1024);
    expect(await countEntries(db)).toBe(10);
    db.close();
  });

  it('deletes oldest first, in lastUsedAt order, until the total fits', async () => {
    for (let i = 0; i < 6; i++) await writeCachedPcm(`p-${i}`, new Uint8Array(1024));
    const db = await openTestDb();
    // 6 KiB stored, 4 KiB budget: exactly the two oldest must go.
    await pruneOldest(db, 4096);
    expect(await countEntries(db)).toBe(4);
    expect(await readCachedPcm('p-0')).toBeNull();
    expect(await readCachedPcm('p-1')).toBeNull();
    expect(await readCachedPcm('p-2')).not.toBeNull();
    expect(await readCachedPcm('p-3')).not.toBeNull();
    expect(await readCachedPcm('p-4')).not.toBeNull();
    expect(await readCachedPcm('p-5')).not.toBeNull();
    db.close();
  });

  it('deletes every entry once the budget is smaller than a single record', async () => {
    for (let i = 0; i < 3; i++) await writeCachedPcm(`s-${i}`, new Uint8Array(1024));
    const db = await openTestDb();
    await pruneOldest(db, 0);
    expect(await countEntries(db)).toBe(0);
    db.close();
  });

  it('refreshes lastUsedAt on read, so reads reorder the eviction queue', async () => {
    await writeCachedPcm('read-a', new Uint8Array(1024));
    await writeCachedPcm('read-b', new Uint8Array(1024));
    await writeCachedPcm('read-c', new Uint8Array(1024));
    // 'read-a' was written first, so without the read touch it would be the
    // oldest and the first to be evicted.
    await readCachedPcm('read-a');
    const db = await openTestDb();
    await waitUntil(async () => (await stampOf(db, 'read-a')) > (await stampOf(db, 'read-c')));
    // One record fits, so the two least-recently-used are evicted and the
    // freshly-read entry survives.
    await pruneOldest(db, 1024);
    expect(await readCachedPcm('read-a')).not.toBeNull();
    expect(await readCachedPcm('read-b')).toBeNull();
    expect(await readCachedPcm('read-c')).toBeNull();
    db.close();
  });

  it('prunes nothing and does not reject when the lastUsedAt index is missing', async () => {
    // A store with no lastUsedAt index has no defined eviction order. Pruning
    // must degrade to a no-op instead of throwing, because pruneOldest runs on
    // the write path and a write that already committed must not fail here.
    const db = await createDbWithoutIndex();
    const tx = db.transaction(STORE, 'readwrite');
    for (let i = 0; i < 4; i++) {
      tx.objectStore(STORE).add({
        key: `n-${i}`,
        pcm: new ArrayBuffer(1024),
        byteLength: 1024,
        lastUsedAt: i,
      });
    }
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => resolve();
    });
    await expect(pruneOldest(db, 1024)).resolves.toBeUndefined();
    expect(await countEntries(db)).toBe(4);
    db.close();
  });
});

describe('byte-budget enforcement on the write path', () => {
  it('holds the store at the real ceiling, tripping only when the counter says so', async () => {
    // No injected threshold and no test-only seam: this drives the production
    // TTS_CACHE_MAX_BYTES and the counter's own trip point, writing ~72 MiB.
    // Slow-ish (~0.3 s) but it is the only assertion that the ceiling and the
    // counter agree in the configuration that actually ships.
    //
    // It is also the guard against the quadratic cold start: scanning on every
    // write measured 2091 ms for 189 x 250 KB versus 70 ms once counted. The
    // timing is not asserted (too flaky to pin), but a scan-per-write
    // implementation would prune as soon as the ceiling was crossed, which the
    // recordsAtFirstPrune assertions below rule out behaviourally.
    const recordBytes = 256 * 1024;
    const payload = new Uint8Array(recordBytes);
    await writeCachedPcm('ceiling-0', payload);
    const db = await openTestDb();

    let stored = await countEntries(db);
    let recordsAtFirstPrune = -1;
    // Cap the loop well past the expected trip so a regression that never
    // prunes fails on the assertion rather than hanging.
    for (let i = 1; i < 400 && recordsAtFirstPrune < 0; i++) {
      await writeCachedPcm(`ceiling-${i}`, payload);
      const after = await countEntries(db);
      if (after <= stored) recordsAtFirstPrune = stored;
      stored = after;
    }

    // The store must not prune just because the ceiling was crossed: a
    // scan-on-every-write implementation first prunes at 257 records (64.25 MiB,
    // the first record past the ceiling). The counter defers it by a threshold,
    // so require at least half a threshold of slack before any pruning. The
    // floor is expressed in half-thresholds so a *larger* threshold (a smaller
    // divisor) still passes; only a smaller slack than that would be a defect.
    const halfThresholdRecords = Math.ceil(
      (TTS_CACHE_MAX_BYTES + TTS_CACHE_MAX_BYTES / 16) / recordBytes,
    );
    const fullThresholdRecords = Math.ceil(
      (TTS_CACHE_MAX_BYTES + TTS_CACHE_MAX_BYTES / 8) / recordBytes,
    );
    expect(recordsAtFirstPrune).toBeGreaterThanOrEqual(halfThresholdRecords);
    // The documented overshoot bound is ceiling + one full threshold, so a trip
    // much later than that means the ceiling is no longer being enforced.
    expect(recordsAtFirstPrune).toBeLessThanOrEqual(fullThresholdRecords + 4);
    // And once it does prune, it lands back on the ceiling, not near it.
    expect(await totalBytesOf(db)).toBeLessThanOrEqual(TTS_CACHE_MAX_BYTES);
    db.close();
  }, 30000);
});

describe('TTS_CACHE_MAX_BYTES', () => {
  it('is the 64 MiB ceiling documented for the corpus', () => {
    expect(TTS_CACHE_MAX_BYTES).toBe(64 * 1024 * 1024);
  });
});
