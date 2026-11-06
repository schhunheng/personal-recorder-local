const { open, rename, mkdir } = require('node:fs/promises');
const { dirname } = require('node:path');
const { randomUUID } = require('node:crypto');
class RecordingStore {
  constructor() { this.sessions = new Map(); }
  async begin(path, owner) {
    if ([...this.sessions.values()].some(value => value.owner === owner)) throw Error('A recording is already open');
    await mkdir(dirname(path), { recursive: true });
    const partial = `${path}.${randomUUID()}.partial`;
    const handle = await open(partial, 'wx');
    const id = randomUUID();
    this.sessions.set(id, { path, partial, handle, owner, queue: Promise.resolve(), failure: null, closing: false });
    return { id, path };
  }
  session(id, owner) {
    const session = this.sessions.get(id);
    if (!session || session.owner !== owner) throw Error('Unknown recording');
    return session;
  }
  append(id, owner, data) {
    const session = this.session(id, owner);
    if (session.closing) throw Error('Recording is closing');
    if (!(data instanceof Uint8Array) || !data.byteLength || data.byteLength > 16 * 1024 * 1024) throw Error('Invalid recording chunk');
    const work = session.queue.then(async () => {
      if (session.failure) throw session.failure;
      let offset = 0;
      while (offset < data.byteLength) {
        const { bytesWritten } = await session.handle.write(data, offset, data.byteLength - offset);
        if (!bytesWritten) throw Error('Disk write made no progress');
        offset += bytesWritten;
      }
    });
    session.queue = work.catch(error => { session.failure = error; });
    return work;
  }
  async finish(id, owner, preservePartial = false) {
    const session = this.session(id, owner);
    if (session.closing) throw Error('Recording is already closing');
    session.closing = true;
    try {
      await session.queue;
      if (session.failure) throw session.failure;
      await session.handle.sync();
      await session.handle.close();
      if (preservePartial) return session.partial;
      await rename(session.partial, session.path);
      return session.path;
    } finally {
      await session.handle.close().catch(() => {});
      this.sessions.delete(id);
    }
  }
  async abandonOwner(owner) {
    for (const [id, session] of this.sessions) {
      if (session.owner !== owner) continue;
      session.closing = true;
      await session.queue;
      await session.handle.close().catch(() => {});
      this.sessions.delete(id); // Keep .partial file for local recovery.
    }
  }
}
module.exports = { RecordingStore };
