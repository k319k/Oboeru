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

/**
 * How many bytes may be written after a scan before the next one is forced.
 *
 * A scan is a full cursor pass over every record, so running one per write makes
 * a cold start quadratic: 189 sentences at ~250 KB measured 2091 ms of nothing
 * but scanning, and that latency lands directly in Task 5's "miss -> generate ->
 * store -> play" path. Counting bytes is O(1) instead.
 *
 * OVERSHOOT BOUND — assuming writes are serialised (see below), the store never
 * exceeds
 *   TTS_CACHE_MAX_BYTES + PRUNE_SCAN_THRESHOLD_BYTES + (one record)
 * = 64 MiB + 8 MiB + one record, i.e. about 1.13x the ceiling. Right after a
 * scan the store is at or below TTS_CACHE_MAX_BYTES; until the next scan at
 * most PRUNE_SCAN_THRESHOLD_BYTES can be written, plus the single record whose
 * write crossed the threshold. That record is then inside the scan, so the
 * store returns under the ceiling on that same scan.
 *
 * The bound assumes writes are SERIALISED. Two overlapping writeCachedPcm calls
 * can both pass the threshold check, so two scans can overlap; the later reset
 * then cancels the bytes counted during the earlier scan's window and the store
 * can transiently reach roughly 2x the threshold above the ceiling. Each scan
 * still ends at or below the ceiling, so the resting state is safe — only the
 * transient peak is wider.
 *
 * The serialisation assumption does NOT hold on the practice flow. `src/lib/tts.ts`
 * persists with `void persistToIdb(key, blob)` (fire-and-forget, no await), and
 * `practice/+page.svelte` fires `prefetchTts(next.text, ...)` for the NEXT
 * sentence and `speak(s.text, ...)` for the CURRENT one from the same effect, so
 * two distinct keys can be written concurrently. Overlapping writes therefore
 * happen in practice, and the transient peak can indeed widen to roughly
 * 2x PRUNE_SCAN_THRESHOLD_BYTES above the ceiling. Nothing exceeds
 * TTS_CACHE_MAX_BYTES at rest, so this is a soft-hint artefact rather than a
 * storage-bound violation — but a caller that cares about the peak must
 * serialise its own writes.
 */
const PRUNE_SCAN_THRESHOLD_BYTES = TTS_CACHE_MAX_BYTES / 8;

/**
 * Bytes written since the last completed scan.
 *
 * This is an in-memory hint, so a page reload resets it. That is safe: a reload
 * only delays the first scan by PRUNE_SCAN_THRESHOLD_BYTES, which is already
 * inside the overshoot bound above, so the ceiling guarantee does not depend on
 * this surviving navigation.
 */
let bytesSinceLastScan = 0;

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

/**
 * Delete least-recently-used records until the store fits `maxBytes`.
 *
 * Exported for tests. `TTS_CACHE_MAX_BYTES` is deliberately a `const` — it must
 * not be able to drift at runtime — which also means a test cannot shrink it, so
 * the tests pass an explicit small budget instead of writing 64 MiB. Internal
 * callers omit the argument and get the module constant.
 *
 * Never rejects: this is called from the write path, and a store it cannot
 * prune (missing index, read-only store) must degrade to "keep everything"
 * rather than fail a write that already committed.
 */
export async function pruneOldest(
  db: IDBDatabase,
  maxBytes: number = TTS_CACHE_MAX_BYTES,
): Promise<void> {
  const used = await totalBytes(db);
  // Zero the counter here rather than recomputing it from what survives:
  // pruning frees bytes that were never counted, so the counter is a measure of
  // work since the last measurement, not of the store's size.
  bytesSinceLastScan = 0;
  if (used <= maxBytes) return;
  await new Promise<void>((resolve) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(STORE, 'readwrite');
    } catch {
      resolve();
      return;
    }
    const store = tx.objectStore(STORE);
    let cursorReq: IDBRequest<IDBCursorWithValue | null>;
    try {
      cursorReq = store.index('lastUsedAt').openCursor();
    } catch {
      // No lastUsedAt index (a store written by an older schema, or a fixture
      // built without one) means there is no defined eviction order. Keeping
      // everything is the safe reading: the cache is disposable either way.
      resolve();
      return;
    }
    let running = used;
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor || running <= maxBytes) return;
      running -= (cursor.value as AudioRecord).byteLength ?? 0;
      cursor.delete();
      cursor.continue();
    };
    cursorReq.onerror = () => resolve();
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

/**
 * Count freshly written bytes toward the next forced scan.
 *
 * An overwrite deliberately OVER-counts: the new payload's length is added
 * without subtracting the record it replaced. Over-counting only buys an extra
 * scan, whereas under-counting could let the store grow past the overshoot
 * bound without anyone noticing. The accurate alternative — reading the old
 * record to subtract its size — costs a `get` round trip on every write to buy
 * precision the ceiling does not need.
 */
function noteBytesWritten(byteLength: number): void {
  bytesSinceLastScan += byteLength;
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
  if (written !== null) {
    // Enforce the byte budget, but only pay for a full scan once enough has
    // been written to be worth it — see PRUNE_SCAN_THRESHOLD_BYTES for the
    // resulting overshoot bound. Previously pruning only ran in reaction to a
    // failed write, so the ceiling was documented but never enforced at all;
    // running it on every write fixed that but made a cold start quadratic.
    noteBytesWritten(pcm.length);
    if (bytesSinceLastScan >= PRUNE_SCAN_THRESHOLD_BYTES) await pruneOldest(db);
    return;
  }
  // Most likely QuotaExceededError. Prune and retry once, then give up
  // silently — the caller treats a missing cache entry as a normal miss.
  await pruneOldest(db);
  await run(db, 'readwrite', (s) => s.put(record));
}

export async function clearTtsCacheForTests(): Promise<void> {
  const pending = dbPromise;
  dbPromise = null;
  // The counters outlive the database, so they have to be reset with it —
  // otherwise a stale byte count could suppress the next test's scan entirely.
  bytesSinceLastScan = 0;
  if (!isTtsCacheAvailable()) return;
  // Close our own connection before deleting. An open connection blocks
  // deleteDatabase indefinitely: the delete never completes, so the "cleared"
  // data survives, and every later open() queues behind a delete that can
  // never finish.
  const db = await pending;
  db?.close();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}
