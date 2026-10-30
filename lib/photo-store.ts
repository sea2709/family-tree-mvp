// Photo bytes are too large for localStorage, so they go to IndexedDB,
// keyed by Photo.id. Each photo is stored twice: the resized original
// for the viewer and a small thumbnail for grids.

const DB_NAME = "family-tree-mvp";
const STORE = "photos";

export type PhotoVariant = "full" | "thumb";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

const key = (id: string, variant: PhotoVariant) => `${id}:${variant}`;

async function transact<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void
): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function putPhotoBlobs(id: string, blobs: Record<PhotoVariant, Blob>): Promise<void> {
  await transact("readwrite", (store) => {
    store.put(blobs.full, key(id, "full"));
    store.put(blobs.thumb, key(id, "thumb"));
  });
}

export async function getPhotoBlob(id: string, variant: PhotoVariant): Promise<Blob | null> {
  const blob = await transact<Blob>("readonly", (store) => store.get(key(id, variant)));
  return blob ?? null;
}

export async function deletePhotoBlobs(id: string): Promise<void> {
  await transact("readwrite", (store) => {
    store.delete(key(id, "full"));
    store.delete(key(id, "thumb"));
  });
}

export function isQuotaError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "QuotaExceededError";
}

let persistAsked = false;

// Without this, the browser may evict IndexedDB when the disk is low.
export function requestPersistence(): void {
  if (persistAsked) return;
  persistAsked = true;
  navigator.storage?.persist?.().catch(() => {});
}
