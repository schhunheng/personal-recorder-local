import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const { RecordingStore } = createRequire(import.meta.url)('../electron/recording-store.cjs');
async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'recorder-test-'));
  try { await run(new RecordingStore(), dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
test('serializes concurrent chunks and finalizes byte-exact local file', () => fixture(async (store, dir) => {
  const path = join(dir, 'video.webm');
  const { id } = await store.begin(path, 7);
  await Promise.all(Array.from({ length: 100 }, (_, i) => store.append(id, 7, new Uint8Array([i]))));
  assert.equal(await store.finish(id, 7), path);
  assert.deepEqual([...await readFile(path)], Array.from({ length: 100 }, (_, i) => i));
  assert.deepEqual(await readdir(dir), ['video.webm']);
  assert.equal(store.sessions.size, 0);
}));
test('rejects cross-window IPC and duplicate sessions', () => fixture(async (store, dir) => {
  const { id } = await store.begin(join(dir, 'video.webm'), 7);
  assert.throws(() => store.append(id, 8, new Uint8Array([1])), /Unknown/);
  await assert.rejects(store.begin(join(dir, 'other.webm'), 7), /already open/);
  await store.abandonOwner(7);
  assert.ok((await readdir(dir))[0].endsWith('.partial'));
}));
test('disk failure keeps partial file and never claims a finalized recording', () => fixture(async (store, dir) => {
  const { id } = await store.begin(join(dir, 'video.webm'), 7);
  await store.sessions.get(id).handle.close();
  await assert.rejects(store.append(id, 7, new Uint8Array([1])));
  await assert.rejects(store.finish(id, 7));
  assert.ok((await readdir(dir)).every(name => name.endsWith('.partial')));
}));
test('encoder/backpressure failures preserve a partial file on explicit finalization', () => fixture(async (store, dir) => {
  const { id } = await store.begin(join(dir, 'video.webm'), 7);
  await store.append(id, 7, new Uint8Array([1, 2, 3]));
  const path = await store.finish(id, 7, true);
  assert.ok(path.endsWith('.partial'));
  assert.deepEqual([...await readFile(path)], [1, 2, 3]);
}));
