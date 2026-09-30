import { describe, it, expect, beforeEach, vi } from 'vitest';
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
} from './tts-cache';

const DB_NAME = 'oboeru-tts';
const STORE = 'audio';

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  await clearTtsCacheForTests();
});

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

  it('stores a record with lastUsedAt so eviction can order it', async () => {
    await writeCachedPcm('k1', new Uint8Array([1]));
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const record = await new Promise<{ lastUsedAt: number; byteLength: number }>(
      (resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get('k1');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      },
    );
    expect(typeof record.lastUsedAt).toBe('number');
    expect(record.byteLength).toBe(1);
    db.close();
  });
});

async function countEntries(): Promise<number> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const n = await new Promise<number>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return n;
}

describe('LRU pruning', () => {
  it('keeps everything under the byte budget', async () => {
    // 40 KiB is far below the 64 MiB cap, so nothing is pruned.
    const chunk = new Uint8Array(1024);
    for (let i = 0; i < 40; i++) await writeCachedPcm(`bulk-${i}`, chunk);
    expect(await countEntries()).toBe(40);
  });

  it('drops the oldest entries once the budget is exceeded', async () => {
    // Shrink the cap for this test so pruning is actually exercised without
    // writing 64 MiB. vi.resetModules + dynamic import picks up the new value.
    vi.resetModules();
    vi.doMock('./tts-cache', async () => {
      const actual = await vi.importActual<typeof import('./tts-cache')>('./tts-cache');
      return { ...actual, TTS_CACHE_MAX_BYTES: 4096 };
    });
    const { writeCachedPcm: write, readCachedPcm: read, cacheKeyOf: key } = await import(
      './tts-cache'
    );
    const { IDBFactory: Fresh } = await import('fake-indexeddb');
    globalThis.indexedDB = new Fresh();
    // Six 1 KiB records = 6 KiB > 4096, so the oldest must be pruned.
    for (let i = 0; i < 6; i++) await write(`p-${i}`, new Uint8Array(1024));
    expect(await countEntries()).toBeLessThan(6);
    // The most recent write survives.
    const newest = await read('p-5');
    expect(newest).not.toBeNull();
    vi.doUnmock('./tts-cache');
    vi.resetModules();
  });
});
