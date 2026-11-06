import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
const result = await build({
  entryPoints: ['src/studio/store.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
});
const module = { exports: {} };
new Function('require', 'module', 'exports', result.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports
);
const { useEditor } = module.exports;
const project = {
  id: 'project-a',
  edits: {
    zooms: [],
    cuts: [],
    trim: { start: 0, end: 30 },
    camera: { x: 0.8, y: 0.7 },
  },
};
test('editing, undo/redo, and branching preserve immutable project source metadata', () => {
  useEditor.getState().open(project);
  useEditor.getState().edit((e) => ({ ...e, cuts: [{ start: 2, end: 4 }] }));
  useEditor.getState().edit((e) => ({ ...e, camera: { ...e.camera, x: 0.2 } }));
  assert.equal(project.edits.camera.x, 0.8);
  assert.deepEqual(project.edits.cuts, []);
  assert.equal(useEditor.getState().project.id, 'project-a');
  useEditor.getState().undo();
  assert.equal(useEditor.getState().project.edits.camera.x, 0.8);
  useEditor.getState().redo();
  assert.equal(useEditor.getState().project.edits.camera.x, 0.2);
  useEditor.getState().undo();
  useEditor.getState().edit((e) => ({ ...e, trim: { start: 1, end: 20 } }));
  assert.equal(useEditor.getState().future.length, 0);
  assert.equal(useEditor.getState().project.edits.cuts.length, 1);
});
test('editor history is bounded and opening a project resets history', () => {
  useEditor.getState().open(project);
  for (let i = 0; i < 150; i++)
    useEditor
      .getState()
      .edit((e) => ({ ...e, trim: { start: 0, end: 20 + i / 10 } }));
  assert.equal(useEditor.getState().past.length, 100);
  useEditor.getState().open(project);
  assert.equal(useEditor.getState().past.length, 0);
  assert.equal(useEditor.getState().future.length, 0);
});
