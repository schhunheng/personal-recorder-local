export interface LocalRecording { id: string; name: string; mime: string; created: number; bytes: number; duration: number; complete: boolean; serverId?: string; processedBytes?: number; processedVersion?: number }
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('edu-recorder', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('recordings')) db.createObjectStore('recordings', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: ['id', 'index'] }).createIndex('recording', 'id');
      if (!db.objectStoreNames.contains('processed')) db.createObjectStore('processed', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function transact<T>(store: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const request = action(tx.objectStore(store));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error || request.error || Error('Local storage failed'));
    });
  } finally { db.close(); }
}
export const saveRecording = (record: LocalRecording) => transact('recordings', 'readwrite', s => s.put(record));
export const listRecordings = () => transact<LocalRecording[]>('recordings', 'readonly', s => s.getAll());
export const appendChunk = (id: string, index: number, blob: Blob) => transact('chunks', 'readwrite', s => s.put({ id, index, blob }));
export async function recordingBlob(record: LocalRecording): Promise<Blob> {
  const chunks = await transact<{ id: string; index: number; blob: Blob }[]>('chunks', 'readonly', s => s.index('recording').getAll(record.id));
  return new Blob(chunks.sort((a, b) => a.index - b.index).map(c => c.blob), { type: record.mime });
}
export async function saveProcessed(id: string, blob: Blob) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['processed', 'recordings'], 'readwrite');
      tx.objectStore('processed').put({ id, blob });
      const request = tx.objectStore('recordings').get(id);
      request.onsuccess = () => {
        if (!request.result) { tx.abort(); return; }
        tx.objectStore('recordings').put({ ...request.result, processedBytes: blob.size });
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error || Error('Could not save processed video in browser storage'));
    });
  } finally { db.close(); }
}
export async function processedBlob(id: string): Promise<Blob | undefined> {
  const result = await transact<{ id: string; blob: Blob } | undefined>('processed', 'readonly', s => s.get(id));
  return result?.blob;
}
export async function deleteRecording(id: string) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['recordings', 'chunks', 'processed'], 'readwrite');
      tx.objectStore('recordings').delete(id);
      tx.objectStore('processed').delete(id);
      const cursor = tx.objectStore('chunks').index('recording').openCursor(IDBKeyRange.only(id));
      cursor.onsuccess = () => { if (cursor.result) { cursor.result.delete(); cursor.result.continue(); } };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}
