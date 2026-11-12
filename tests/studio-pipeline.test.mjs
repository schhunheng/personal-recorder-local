import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
const result = await build({
  entryPoints: ['src/studio/pipeline.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  write: false,
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', result.outputFiles[0].text)(
  createRequire(import.meta.url),
  mod,
  mod.exports
);
const { toEDL, applyEDL, localRequest } = mod.exports;
test('only accepted draft cuts are applied and original source metadata stays separate', () => {
  const project = {
    id: 'source-id',
    duration: 12,
    screen: { id: 'immutable-source' },
    edits: {
      trim: { start: 0, end: 12 },
      cuts: [{ start: 4, end: 5 }],
      zooms: [],
      masks: [{ id: 'private', x: 0.2, y: 0.2, width: 0.3, height: 0.1, color: '#000000', start: 1, end: 10 }],
      camera: { visible: true },
      appearance: { ratio: '16:9' },
      audio: { enabled: false },
    },
  };
  const edl = toEDL(project);
  edl.cuts.push({
    id: 'suggestion',
    start: 7,
    end: 9,
    reason: 'silence',
    accepted: false,
  });
  const edits = applyEDL(project.edits, edl);
  assert.deepEqual(edits.cuts, [{ start: 4, end: 5 }]);
  assert.equal(project.screen.id, 'immutable-source');
  assert.equal(edits.audio, project.edits.audio);
  assert.deepEqual(edl.masks, project.edits.masks);
  assert.deepEqual(edits.masks, project.edits.masks);
  edl.cuts[1].accepted = true;
  assert.equal(applyEDL(project.edits, edl).cuts.length, 2);
  delete edl.masks;
  assert.deepEqual(applyEDL(project.edits, edl).masks, []);
});
test('automatic processing cannot send media to a non-local origin', async () => {
  globalThis.window = { location: { hostname: 'cloud.example' } };
  let sent = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    sent = true;
    throw Error('Should not send');
  };
  try {
    await assert.rejects(localRequest('/projects'), /only on localhost/);
    assert.equal(sent, false);
  } finally {
    globalThis.fetch = original;
  }
});
test('replanning can replace earlier silence cuts instead of treating them as permanent manual edits', () => {
  const edits = {
    trim: { start: 0, end: 12 }, cuts: [], zooms: [],
    camera: {}, appearance: {}, audio: {},
  };
  const edl = toEDL({ duration: 12, edits });
  edl.cuts = [
    { id: 'automatic', start: 2, end: 5, reason: 'silence', accepted: true },
    { id: 'manual', start: 8, end: 9, reason: 'manual', accepted: true },
  ];
  const applied = applyEDL(edits, edl);
  assert.deepEqual(toEDL({ duration: 12, edits: applied }).cuts.map((c) => c.reason), ['silence', 'manual']);
  delete applied.automaticCuts;
  assert.deepEqual(toEDL({ duration: 12, edits: applied }).cuts.map((c) => c.reason), ['silence', 'manual']);
});
