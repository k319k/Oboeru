/**
 * Persistent PCM cache in IndexedDB.
 *
 * This is a TRANSPARENT OPTIMISATION. Every operation swallows its own errors
 * and resolves to "no cache hit", so a browser with IndexedDB disabled
 * (private mode), an old WebView, or a rejected write degrades to the
 * in-memory LRU plus the network — the practice flow keeps working.
 *
 * SSR contract (mirrors src/lib/tts.ts:4-5): the database is opened lazily on
 * the first read/write. Never touch `indexedDB` at module top level, and never
 * import `$app/environment` (its `browser` flag is `false` under vitest's node
 * environment, which would make this untestable).
 */

export const TTS_CACHE_SCHEMA_VERSION = 1;

/**
 * Self-managed LRU ceiling. The browser evicts IndexedDB per-origin in bulk
 * (taking unrelated data with it) and `navigator.storage.estimate()` is only an
 * approximation, so we prune before the browser does. 189 sentences at ~5s
 * each is ~45 MB, so this never actually trips for the current corpus.
 */
export const TTS_CACHE_MAX_BYTES = 64 * 1024 * 1024;

const DB_NAME = 'oboeru-tts';
const DB_VERSION = 1;
const STORE = 'audio';

export interface TtsCacheKeyParts {
  text: string;
  lang: string;
}

/**
 * Cache identity == what we send upstream. `speakingRate` is deliberately
 * absent: Gemini cannot be told a rate, so rate is a playback-time setting and
 * including it would store the same sentence once per rate setting.
 *
 * Model / voice / style are inlined as a versioned prefix. Bumping
 * TTS_CACHE_SCHEMA_VERSION (or any of the three literals) invalidates
 * everything at once. Kept synchronous so the in-memory LRU hot path never
 * awaits — hashing via `crypto.subtle.digest` would add a Promise and a
 * secure-context requirement for no benefit at 189 x ~100 characters.
 */
export function cacheKeyOf(parts: TtsCacheKeyParts): string {
  return [
    `v${TTS_CACHE_SCHEMA_VERSION}`,
    'google/gemini-3.8-flash-lite-tts',
    'Ludo',
    'Narration',
    parts.lang,
    parts.text,
  ].join('|');
}

export function isTtsCacheAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

interface AudioRecord {
  key: string;
  pcm: ArrayBuffer;
  byteLength: number;
  lastUsedAt: number;
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (!isTtsCacheAvailable()) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(STORE)) {
        // Schema bump: drop everything rather than leaving orphans that can
        // never be read but still consume the byte budget.
        db.deleteObjectStore(STORE);
      }
      const store = db.createObjectStore(STORE, { keyPath: 'key' });
      store.createIndex('lastUsedAt', 'lastUsedAt', { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  }).then((db) => {
    if (!db) dbPromise = null;
    return db;
  });
  return dbPromise;
}

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, body: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, mode);
    } catch {
      resolve(null);
      return;
    }
    const req = body(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    // No preventDefault(): the transaction aborting is harmless here, and
    // tx.onabort below resolves with the same value. Calling it would also be a
    // type error — preventDefault lives on IDBRequestEvent, not IDBRequest.
    req.onerror = () => resolve(null);
    tx.onabort = () => resolve(null);
  });
}

/** Total stored bytes, or 0 when the count cannot be read. */
async function totalBytes(db: IDBDatabase): Promise<number> {
  return new Promise<number>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, 'readonly');
    } catch {
      resolve(0);
      return;
    }
    const store = tx.objectStore(STORE);
    let sum = 0;
    const cursorReq = store.openCursor();
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) {
        resolve(sum);
        return;
      }
      sum += (cursor.value as AudioRecord).byteLength ?? 0;
      cursor.continue();
    };
    cursorReq.onerror = () => resolve(sum);
  });
}

async function pruneOldest(db: IDBDatabase): Promise<void> {
  const used = await totalBytes(db);
  if (used <= TTS_CACHE_MAX_BYTES) return;
  await new Promise<void>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, 'readwrite');
    } catch {
      resolve();
      return;
    }
    const store = tx.objectStore(STORE);
    const cursorReq = store.index('lastUsedAt').openCursor();
    let running = used;
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor || running <= TTS_CACHE_MAX_BYTES) return;
      running -= (cursor.value as AudioRecord).byteLength ?? 0;
      cursor.delete();
      cursor.continue();
    };
    cursorReq.onerror = () => undefined;
    tx.oncomplete = () => resolve();
    tx.onabort = () => resolve();
    tx.onerror = () => resolve();
  });
}

export async function readCachedPcm(key: string): Promise<Uint8Array | null> {
  const db = await openDb();
  if (!db) return null;
  const record = await run<AudioRecord>(db, 'readonly', (s) => s.get(key) as IDBRequest<AudioRecord>);
  if (!record) return null;
  // Touch lastUsedAt so the LRU order reflects reads, not just writes. A failed
  // touch is harmless — the entry is still usable.
  void writeLastUsed(db, key);
  return new Uint8Array(record.pcm);
}

function writeLastUsed(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, 'readwrite');
    } catch {
      resolve(null);
      return;
    }
    const store = tx.objectStore(STORE);
    const getReq = store.get(key);
    getReq.onsuccess = () => {
      const record = getReq.result as AudioRecord | undefined;
      if (!record) return;
      record.lastUsedAt = Date.now();
      store.put(record);
    };
    getReq.onerror = () => resolve(null);
    tx.oncomplete = () => resolve(null);
    tx.onabort = () => resolve(null);
  });
}

export async function writeCachedPcm(key: string, pcm: Uint8Array): Promise<void> {
  const db = await openDb();
  if (!db) return;
  const copy = pcm.slice().buffer;
  const record: AudioRecord = {
    key,
    pcm: copy,
    byteLength: pcm.length,
    lastUsedAt: Date.now(),
  };
  const written = await run(db, 'readwrite', (s) => s.put(record));
  if (written === null) {
    // Most likely QuotaExceededError. Prune and retry once, then give up
    // silently — the caller treats a missing cache entry as a normal miss.
    await pruneOldest(db);
    await run(db, 'readwrite', (s) => s.put(record));
  }
}

export async function clearTtsCacheForTests(): Promise<void> {
  dbPromise = null;
  if (!isTtsCacheAvailable()) return;
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}
