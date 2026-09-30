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
  setPruneScanThresholdForTests,
  getPruneScanCountForTests,
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

describe('scan scheduling', () => {
  it('does not scan on every write, and scans once the counter crosses the threshold', async () => {
    // This is the quadratic-blowup guard. A scan is a full cursor pass, so a
    // scan-per-write cold start measured 1.71 s for 189 x 250 KB. Counting is
    // what makes the write path O(1); the threshold is what makes the ceiling
    // still hold.
    const scansBefore = getPruneScanCountForTests();
    setPruneScanThresholdForTests(4096);
    try {
      // 3 KiB written: below the 4 KiB threshold, so still no scan.
      for (let i = 0; i < 3; i++) await writeCachedPcm(`sched-${i}`, new Uint8Array(1024));
      expect(getPruneScanCountForTests()).toBe(scansBefore);
      // The 4th write crosses it.
      await writeCachedPcm('sched-3', new Uint8Array(1024));
      expect(getPruneScanCountForTests()).toBe(scansBefore + 1);
      // The 5th starts a fresh budget, so it must not scan again.
      await writeCachedPcm('sched-4', new Uint8Array(1024));
      expect(getPruneScanCountForTests()).toBe(scansBefore + 1);
    } finally {
      setPruneScanThresholdForTests(null);
    }
  });

  it('counts an overwrite as a full payload, so a rewrite cannot dodge a scan', async () => {
    const scansBefore = getPruneScanCountForTests();
    setPruneScanThresholdForTests(4096);
    try {
      // The same 1 KiB key rewritten five times adds up to 5 KiB of counted
      // bytes even though the store only ever holds 1 KiB. Over-counting is
      // deliberate: the alternative is under-counting, which would let a
      // hot-key rewrite loop skip the ceiling check entirely.
      for (let i = 0; i < 5; i++) await writeCachedPcm('hot', new Uint8Array(1024));
      expect(getPruneScanCountForTests()).toBe(scansBefore + 1);
    } finally {
      setPruneScanThresholdForTests(null);
    }
  });
  it('starts from a zeroed counter after clearTtsCacheForTests', async () => {
    // The scan assertions above are only deterministic because the counter is
    // module state that outlives the database. Without the reset inside
    // clearTtsCacheForTests, a byte count leaked from one test would make the
    // next one scan early or late purely by run order.
    // Bank 3 KiB of counted bytes with the threshold parked out of reach, so
    // nothing resets the counter along the way.
    setPruneScanThresholdForTests(Number.MAX_SAFE_INTEGER);
    for (let i = 0; i < 3; i++) await writeCachedPcm(`leak-${i}`, new Uint8Array(1024));
    setPruneScanThresholdForTests(4096);
    await clearTtsCacheForTests();
    setPruneScanThresholdForTests(4096);

    const scansBefore = getPruneScanCountForTests();
    // One 1 KiB write is comfortably under a 4 KiB threshold counting from zero,
    // so this must not scan. Carried-over 3 KiB would push it over.
    await writeCachedPcm('after-clear', new Uint8Array(1024));
    expect(getPruneScanCountForTests()).toBe(scansBefore);
  });
});

describe('TTS_CACHE_MAX_BYTES', () => {
  it('is the 64 MiB ceiling documented for the corpus', () => {
    expect(TTS_CACHE_MAX_BYTES).toBe(64 * 1024 * 1024);
  });
});
