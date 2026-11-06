import type { Asset, Project, SavedExport } from './model';
const DB = 'reancode101-studio';
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(DB, 2);
    let blocked = false;
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('projects'))
        db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('assets'))
        db.createObjectStore('assets', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('chunks'))
        db.createObjectStore('chunks', {
          keyPath: ['id', 'index'],
        }).createIndex('asset', 'id');
      if (!db.objectStoreNames.contains('exports'))
        db.createObjectStore('exports', { keyPath: 'id' }).createIndex(
          'project',
          'projectId'
        );
    };
    r.onsuccess = () => {
      if (blocked) {
        r.result.close();
        return;
      }
      r.result.onversionchange = () => r.result.close();
      resolve(r.result);
    };
    r.onblocked = () => {
      blocked = true;
      reject(
        Error('Close other Studio tabs, then refresh to update local storage.')
      );
    };
    r.onerror = () => reject(r.error);
  });
}
async function transaction<T>(
  name: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>
) {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(name, mode),
        r = fn(tx.objectStore(name));
      tx.oncomplete = () => resolve(r.result);
      tx.onerror = tx.onabort = () =>
        reject(tx.error || r.error || Error('Browser storage failed.'));
    });
  } finally {
    db.close();
  }
}
export const saveProject = (p: Project) =>
  transaction('projects', 'readwrite', (s) => s.put(p));
export const listProjects = () =>
  transaction<Project[]>('projects', 'readonly', (s) => s.getAll()).then((p) =>
    p.sort((a, b) => b.created - a.created)
  );
export const getAsset = (id: string) =>
  transaction<Asset>('assets', 'readonly', (s) => s.get(id));

export const listExports = (projectId?: string) =>
  transaction<SavedExport[]>('exports', 'readonly', (s) =>
    projectId ? s.index('project').getAll(projectId) : s.getAll()
  ).then((exports) => exports.sort((a, b) => b.created - a.created));
export async function saveExport(record: SavedExport) {
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['projects', 'exports'], 'readwrite');
      const project = tx.objectStore('projects').get(record.projectId);
      project.onsuccess = () => {
        if (!project.result) {
          tx.abort();
          return;
        }
        tx.objectStore('exports').put(record);
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () =>
        reject(
          tx.error || Error('Could not save the edited video to its project.')
        );
    });
  } finally {
    db.close();
  }
}

async function directory() {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(DB, {
    create: true,
  });
}
export class AssetWriter {
  asset: Asset;
  private file?: FileSystemWritableFileStream;
  private index = 0;
  private closed = false;
  private queue: Promise<void> = Promise.resolve();
  pending = 0;
  constructor(mime: string, private durable = true) {
    this.asset = { id: crypto.randomUUID(), mime, bytes: 0, storage: 'idb' };
  }
  async open() {
    if (!this.durable && 'getDirectory' in (navigator.storage || {})) {
      try {
        this.file = await (
          await (
            await directory()
          ).getFileHandle(this.asset.id, { create: true })
        ).createWritable();
        this.asset.storage = 'opfs';
      } catch {
        /* IndexedDB fallback for restricted OPFS implementations. */
      }
    }
    await transaction('assets', 'readwrite', (s) => s.put(this.asset));
    return this;
  }
  append(blob: Blob) {
    if (this.closed)
      return Promise.reject(Error('This media file is already closed.'));
    this.pending += blob.size;
    const index = this.index++;
    const job = this.queue
      .then(async () => {
        if (this.file) await this.file.write(blob);
        else
          await transaction('chunks', 'readwrite', (s) =>
            s.put({ id: this.asset.id, index, blob })
          );
        this.asset.bytes += blob.size;
      })
      .finally(() => {
        this.pending -= blob.size;
      });
    this.queue = job;
    return job;
  }
  async close() {
    if (this.closed) return { ...this.asset };
    this.closed = true;
    let failure: unknown;
    try {
      await this.queue;
    } catch (e) {
      failure = e;
    }
    try {
      await this.file?.close();
    } catch (e) {
      failure ||= e;
    }
    await transaction('assets', 'readwrite', (s) => s.put(this.asset));
    if (failure) throw failure;
    return { ...this.asset };
  }
}
export async function assetBlob(asset: Asset): Promise<Blob> {
  if (asset.storage === 'opfs') {
    const file = await (
      await (await directory()).getFileHandle(asset.id)
    ).getFile();
    return file.slice(0, file.size, asset.mime);
  }
  const chunks = await transaction<{ index: number; blob: Blob }[]>(
    'chunks',
    'readonly',
    (s) => s.index('asset').getAll(asset.id)
  );
  return new Blob(
    chunks.sort((a, b) => a.index - b.index).map((c) => c.blob),
    { type: asset.mime }
  );
}
export async function importAsset(file: Blob) {
  const writer = await new AssetWriter(file.type).open();
  try {
    for (let offset = 0; offset < file.size; offset += 4 * 1024 ** 2)
      await writer.append(file.slice(offset, offset + 4 * 1024 ** 2));
    return await writer.close();
  } catch (e) {
    await writer.close().catch(() => {});
    await deleteAsset(writer.asset);
    throw e;
  }
}
export async function deleteAsset(asset: Asset) {
  if (asset.storage === 'opfs')
    await (await directory()).removeEntry(asset.id).catch((e) => {
      if (e.name !== 'NotFoundError') throw e;
    });
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['assets', 'chunks'], 'readwrite');
      tx.objectStore('assets').delete(asset.id);
      const r = tx
        .objectStore('chunks')
        .index('asset')
        .openCursor(IDBKeyRange.only(asset.id));
      r.onsuccess = () => {
        r.result?.delete();
        r.result?.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export async function deleteProject(project: Project) {
  const exported = await listExports(project.id);
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['projects', 'exports'], 'readwrite');
      tx.objectStore('projects').delete(project.id);
      const r = tx
        .objectStore('exports')
        .index('project')
        .openCursor(IDBKeyRange.only(project.id));
      r.onsuccess = () => {
        r.result?.delete();
        r.result?.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
  const other = await listProjects();
  const otherExports = await listExports();
  for (const asset of [
    project.screen,
    project.camera,
    ...exported.map((e) => e.asset),
    project.edits.avatar ? await getAsset(project.edits.avatar) : undefined,
  ]) {
    if (
      asset &&
      !otherExports.some((e) => e.asset.id === asset.id) &&
      !other.some(
        (p) =>
          p.screen.id === asset.id ||
          p.camera?.id === asset.id ||
          p.edits.avatar === asset.id
      )
    )
      await deleteAsset(asset);
  }
}
export async function duplicateProject(project: Project) {
  const copy = structuredClone(project);
  copy.id = crypto.randomUUID();
  copy.title += ' · copy';
  copy.created = Date.now();
  await saveProject(copy);
  return copy;
}
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = name.replace(/[\\/:*?"<>|]/g, '-');
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
