/**
 * Local IndexedDB storage for captures, editor drafts and in-progress recording chunks.
 * Captures live here until the user uploads them to their Google Drive (the cloud source of truth).
 */
export type CaptureKind = 'screenshot' | 'edited' | 'video';

export interface CloudLink {
  assetId: string;
  driveFileId: string;
  uploadedAt: number;
}

export interface CaptureRecord {
  id: string;
  kind: CaptureKind;
  blob: Blob;
  mimeType: string;
  filename: string;
  size: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  createdAt: number;
  /** For edited images: id of the original screenshot capture. */
  parentId: string | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
  cloud: CloudLink | null;
  /** True when the recording was assembled from chunks after an interruption. */
  recovered?: boolean;
}

export type CaptureMeta = Omit<CaptureRecord, 'blob'>;

export interface EditorDraft {
  captureId: string;
  state: unknown;
  updatedAt: number;
}

export interface ChunkRecord {
  key?: number;
  recordingId: string;
  seq: number;
  blob: Blob;
}

export interface UploadSession {
  captureId: string;
  sessionUrl: string;
  createdAt: number;
}

const DB_NAME = 'snapshare';
const DB_VERSION = 1;
let dbPromise: Promise<IDBDatabase> | null = null;

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('captures')) {
        const s = db.createObjectStore('captures', { keyPath: 'id' });
        s.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'captureId' });
      if (!db.objectStoreNames.contains('chunks')) {
        const c = db.createObjectStore('chunks', { keyPath: 'key', autoIncrement: true });
        c.createIndex('recordingId', 'recordingId');
      }
      if (!db.objectStoreNames.contains('uploads')) db.createObjectStore('uploads', { keyPath: 'captureId' });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => {
      dbPromise = null;
      reject(open.error ?? new Error('Could not open local storage'));
    };
  });
  return dbPromise;
}

/** Test hook: forget cached connection. */
export function resetDbForTests() {
  dbPromise = null;
}

export function newId(): string {
  return crypto.randomUUID();
}

export async function putCapture(rec: CaptureRecord): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('captures', 'readwrite');
  tx.objectStore('captures').put(rec);
  await txDone(tx);
}

export async function getCapture(id: string): Promise<CaptureRecord | undefined> {
  const db = await openDb();
  return req(db.transaction('captures').objectStore('captures').get(id));
}

export async function updateCapture(id: string, patch: Partial<CaptureRecord>): Promise<CaptureRecord | undefined> {
  const db = await openDb();
  const tx = db.transaction('captures', 'readwrite');
  const store = tx.objectStore('captures');
  const existing = (await req(store.get(id))) as CaptureRecord | undefined;
  if (existing) store.put({ ...existing, ...patch, id });
  await txDone(tx);
  return existing ? { ...existing, ...patch } : undefined;
}

/** Lists capture metadata newest first, without loading blobs into memory beyond the cursor. */
export async function listCaptures(limit = 500): Promise<CaptureMeta[]> {
  const db = await openDb();
  const out: CaptureMeta[] = [];
  return new Promise((resolve, reject) => {
    const cursorReq = db.transaction('captures').objectStore('captures').index('createdAt').openCursor(null, 'prev');
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor || out.length >= limit) return resolve(out);
      const { blob: _blob, ...meta } = cursor.value as CaptureRecord;
      out.push(meta);
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

export async function deleteCapture(id: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(['captures', 'drafts', 'uploads'], 'readwrite');
  tx.objectStore('captures').delete(id);
  tx.objectStore('drafts').delete(id);
  tx.objectStore('uploads').delete(id);
  await txDone(tx);
}

export async function saveDraft(captureId: string, state: unknown): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('drafts', 'readwrite');
  tx.objectStore('drafts').put({ captureId, state, updatedAt: Date.now() } satisfies EditorDraft);
  await txDone(tx);
}

export async function getDraft(captureId: string): Promise<EditorDraft | undefined> {
  const db = await openDb();
  return req(db.transaction('drafts').objectStore('drafts').get(captureId));
}

export async function deleteDraft(captureId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('drafts', 'readwrite');
  tx.objectStore('drafts').delete(captureId);
  await txDone(tx);
}

export async function appendChunk(recordingId: string, seq: number, blob: Blob): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('chunks', 'readwrite');
  tx.objectStore('chunks').add({ recordingId, seq, blob } satisfies ChunkRecord);
  await txDone(tx);
}

export async function getChunks(recordingId: string): Promise<Blob[]> {
  const db = await openDb();
  const all = (await req(db.transaction('chunks').objectStore('chunks').index('recordingId').getAll(recordingId))) as ChunkRecord[];
  return all.sort((a, b) => a.seq - b.seq).map((c) => c.blob);
}

export async function listChunkRecordingIds(): Promise<string[]> {
  const db = await openDb();
  const ids: string[] = [];
  return new Promise((resolve, reject) => {
    const cursorReq = db.transaction('chunks').objectStore('chunks').index('recordingId').openKeyCursor(null, 'nextunique');
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return resolve(ids);
      ids.push(String(cursor.key));
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error);
  });
}

export async function deleteChunks(recordingId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('chunks', 'readwrite');
  const index = tx.objectStore('chunks').index('recordingId');
  const keys = await req(index.getAllKeys(recordingId));
  for (const k of keys) tx.objectStore('chunks').delete(k);
  await txDone(tx);
}

export async function saveUploadSession(s: UploadSession): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('uploads', 'readwrite');
  tx.objectStore('uploads').put(s);
  await txDone(tx);
}

export async function getUploadSession(captureId: string): Promise<UploadSession | undefined> {
  const db = await openDb();
  return req(db.transaction('uploads').objectStore('uploads').get(captureId));
}

export async function deleteUploadSession(captureId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction('uploads', 'readwrite');
  tx.objectStore('uploads').delete(captureId);
  await txDone(tx);
}
